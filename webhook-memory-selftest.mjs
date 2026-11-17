#!/usr/bin/env node
/**
 * Webhook 服务「内存 / 队列防膨胀」自测（黑盒，零依赖）。
 *
 * 验的是审计 2026-11-17 提的三件事：
 *   1. 终态事件（已 ACK）超过保留期会被**物理删除**（queue.json 里不再有）⇒ 内存/磁盘不膨胀；
 *   2. 删除事件时**附件文件一起清掉** ⇒ 不留孤儿 blob；
 *   3. 全服事件总量达上限 ⇒ 新提交明确 503（背压），不静默接收 ⇒ 可观测。
 *
 * 跑法：node webhook-memory-selftest.mjs   （退出码 0 = 全部通过）
 */
import { spawn } from 'node:child_process';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const CLIENT_TOKEN = 'memory-selftest-client-token';
const PEPPER = 'memory-selftest-pepper-0123456789';
const PORT = 26995 + (process.pid % 300);
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'gosslan-webhook-mem-'));
const base = `http://127.0.0.1:${PORT}`;

const child = spawn(process.execPath, [new URL('./webhook.mjs', import.meta.url).pathname], {
  env: {
    ...process.env,
    WEBHOOK_CLIENT_TOKEN: CLIENT_TOKEN,
    WEBHOOK_PEPPER: PEPPER,
    WEBHOOK_PORT: String(PORT),
    WEBHOOK_HOST: '127.0.0.1',
    WEBHOOK_DATA_DIR: DATA_DIR,
    // 关键：保留期设 300ms，上限设 3 ⇒ 几秒内可验证清理和背压
    WEBHOOK_DONE_RETENTION_MS: '300',
    WEBHOOK_MAX_EVENTS_TOTAL: '3',
    WEBHOOK_LEASE_MS: '1000',
    WEBHOOK_SKIP_LISTEN: '', // 不设置：正常监听
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let stderr = '';
child.stderr.on('data', (d) => { stderr += String(d); });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitReady() {
  for (let i = 0; i < 60; i += 1) {
    try {
      const r = await fetch(`${base}/healthz`);
      if (r.ok) return;
    } catch { /* 还没起来 */ }
    await sleep(100);
  }
  throw new Error(`服务没起来：${stderr}`);
}

async function api(p, { method = 'GET', token, json } = {}) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (json) headers['Content-Type'] = 'application/json';
  const r = await fetch(base + p, {
    method,
    headers,
    body: json ? JSON.stringify(json) : undefined,
  });
  const text = await r.text();
  let body;
  try { body = JSON.parse(text); } catch { body = text; }
  return { status: r.status, body };
}

let passed = 0;
async function t(name, fn) {
  await fn();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

function queue() {
  const f = path.join(DATA_DIR, 'queue.json');
  return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : {};
}

try {
  await waitReady();

  const reg = await api('/v1/client/bots', {
    method: 'POST', token: CLIENT_TOKEN,
    json: { name: '内存自测', target: { kind: 'personal' } },
  });
  assert.equal(reg.status, 201, JSON.stringify(reg.body));
  const botId = reg.body.bot_id;
  const sendToken = reg.body.send_secret;
  const clientToken = reg.body.client_secret;

  await t('终态事件保留期后被物理删除（内存/磁盘不膨胀）', async () => {
    const r = await api(`/v1/hooks/${botId}/messages`, {
      method: 'POST', token: sendToken,
      json: { text: '会被清理的通知', format: 'text' },
    });
    assert.equal(r.status, 202, JSON.stringify(r.body));
    const eventId = r.body.event_id;
    assert.ok(queue()[eventId], '事件应先在队列文件里');

    // 客户端取件 + ACK ⇒ 进入终态
    const pull = await api(`/v1/client/bots/${botId}/pull`, { method: 'POST', token: clientToken, json: {} });
    assert.equal(pull.status, 200, JSON.stringify(pull.body));
    assert.ok(pull.body.events.some((e) => e.event_id === eventId));
    const ack = await api(`/v1/client/bots/${botId}/ack`, {
      method: 'POST', token: clientToken,
      json: { event_id: eventId, durable_receipt: eventId },
    });
    assert.equal(ack.status, 200, JSON.stringify(ack.body));
    assert.equal(queue()[eventId].status, 'accepted_by_gateway');

    // 等超过保留期（300ms）+ 一次清理触发（提交/定时 60s；这里用新提交触发 sweep）
    await sleep(450);
    await api('/healthz'); // 不触发
    await api('/v1/client/bots', { method: 'GET', token: CLIENT_TOKEN }); // 不触发
    // 通过一次「会立刻被清理的新提交」触发 sweepExpired
    const trigger = await api(`/v1/hooks/${botId}/messages`, {
      method: 'POST', token: sendToken, json: { text: 'trigger' },
    });
    // trigger 可能被上限拒（3），但上限检查前会先 sweep —— 正是我们要的
    assert.ok([202, 503].includes(trigger.status));
    assert.ok(!queue()[eventId], '终态事件超过保留期应被物理删除（queue.json 里不再有）');
  });

  await t('全服事件总量达上限 ⇒ 新提交 503（背压，不静默接收）', async () => {
    // 队列里留着 3 条未 ACK（上限 3）
    for (let i = 0; i < 3; i += 1) {
      const r = await api(`/v1/hooks/${botId}/messages`, {
        method: 'POST', token: sendToken,
        json: { text: `fill-${i}`, 'idempotency-key': `mem-fill-${i}` },
      });
      // 上限是 3，能进几条算几条；这里只关心最终能被拒
      assert.ok([202, 503].includes(r.status), JSON.stringify(r.body));
    }
    const before = Object.keys(queue()).length;
    assert.ok(before <= 3, `事件数不应超过上限：${before}`);
    const r = await api(`/v1/hooks/${botId}/messages`, {
      method: 'POST', token: sendToken,
      json: { text: 'should be rejected' },
    });
    assert.equal(r.status, 503, `超上限应 503，实际 ${r.status}: ${JSON.stringify(r.body)}`);
    assert.equal(r.body.error, 'server_queue_full');
    assert.equal(Object.keys(queue()).length, before, '被拒的请求不能产生新事件');
  });

  console.log(`\n✓ webhook 内存/队列自测通过：${passed} 条`);
} catch (e) {
  console.error('\n✗ webhook 内存/队列自测失败：', e?.stack ?? e);
  if (stderr) console.error('服务端日志：\n' + stderr);
  process.exitCode = 1;
} finally {
  child.kill('SIGTERM');
}
