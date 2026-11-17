#!/usr/bin/env node
/**
 * 极简通知器（v7）自测：一个进程 / 复用 59994 / GET+POST+PUT / token 在 URL。
 *
 * 跑法：node notify-selftest.mjs  （退出码 0 = 全过）
 */
import { spawn } from 'node:child_process';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TOKEN = 'selftest-relay-token';
const PORT = 27994 + (process.pid % 300);
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'gosslan-notify-v7-'));
const base = `http://127.0.0.1:${PORT}`;

const child = spawn(process.execPath, [new URL('./server.mjs', import.meta.url).pathname], {
  env: {
    ...process.env,
    TOKEN,
    PORT: String(PORT - 1), // TCP 盲中继端口（本测试不用）
    HOST: '127.0.0.1',
    HEALTHZ_PORT: String(PORT),
    HEALTHZ_HOST: '127.0.0.1',
    WEBHOOK_DATA_DIR: DATA_DIR,
    NOTIFY_TTL_MS: '2000', // 2 秒后可清理，便于测 TTL
    NOTIFY_MAX_EVENTS: '5',
    LOG: '',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let stderr = '';
child.stderr.on('data', (d) => { stderr += String(d); });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function api(p, opts = {}) {
  const r = await fetch(base + p, opts);
  const text = await r.text();
  let body;
  try { body = JSON.parse(text); } catch { body = text; }
  return { status: r.status, body };
}

let passed = 0;
async function t(name, fn) { await fn(); passed += 1; console.log(`  ✓ ${name}`); }

try {
  for (let i = 0; i < 60; i += 1) {
    try { const r = await fetch(base + '/healthz'); if (r.ok) break; } catch {}
    await sleep(100);
  }

  // 建机器人（新协议）
  const reg = await api('/v1/bots', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'v7 自测', scope: 'personal' }),
  });
  assert.equal(reg.status, 201, JSON.stringify(reg.body));
  const send = reg.body.send_token;
  const client = reg.body.client_token;

  await t('一条 curl 就能发：GET 带 query', async () => {
    const r = await api(`/publish/${send}?text=${encodeURIComponent('构建完成')}`);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.ok(r.body.id);
  });

  await t('POST 纯文本 body 也能发', async () => {
    const r = await api(`/publish/${send}`, { method: 'POST', body: 'hello post' });
    assert.equal(r.status, 200);
  });

  await t('PUT JSON body 也能发', async () => {
    const r = await api(`/publish/${send}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'hello put', format: 'markdown' }),
    });
    assert.equal(r.status, 200);
  });

  await t('离线留存：取件能看到之前发的三条', async () => {
    const r = await api(`/pull/${client}`);
    assert.equal(r.status, 200);
    assert.equal(r.body.events.length, 3, `应有 3 条，实际 ${r.body.events.length}`);
  });

  await t('ack 后该条不再返回', async () => {
    const pulled = (await api(`/pull/${client}`)).body.events;
    const id = pulled[0].id;
    const a = await api(`/ack/${client}/${id}`);
    assert.equal(a.status, 200);
    const after = (await api(`/pull/${client}`)).body.events;
    assert.ok(!after.some((e) => e.id === id), 'ack 后不该再返回');
  });

  await t('TTL 到期后事件被清理（不膨胀）', async () => {
    await sleep(2200);
    const r = await api(`/pull/${client}`);
    assert.equal(r.body.events.length, 0, `TTL 后应清空，实际 ${r.body.events.length}`);
  });

  await t('队列上限 503（背压，不静默丢）', async () => {
    for (let i = 0; i < 5; i += 1) {
      const r = await api(`/publish/${send}?text=fill${i}`);
      assert.equal(r.status, 200);
    }
    const r = await api(`/publish/${send}?text=overflow`);
    assert.equal(r.status, 503, `应 503，实际 ${r.status}`);
    assert.equal(r.body.error, 'queue_full');
  });

  await t('错误 token 401', async () => {
    assert.equal((await api('/pull/wrong-token')).status, 401);
    assert.equal((await api('/publish/wrong-token?text=x')).status, 401);
  });

  console.log(`\n✓ v7 通知器自测通过：${passed} 条`);
} catch (e) {
  console.error('\n✗ v7 通知器自测失败：', e?.stack ?? e);
  if (stderr) console.error('服务端日志：\n' + stderr);
  process.exitCode = 1;
} finally {
  child.kill('SIGTERM');
}
