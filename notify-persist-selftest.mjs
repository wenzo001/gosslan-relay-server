#!/usr/bin/env node
/**
 * v7 通知器「写盘失败回滚」自测（2026-11-18）。
 *
 * 为什么单独一个脚本：主 selftest 用固定 DATA_DIR 跑完全部用例，中途 chmod 只读会污染
 * 其它用例的落盘。这里用独立进程 + 独立临时目录，专门验证 publish 写盘失败时：
 *   ① 返回 503（不报 200 假装成功）；② 内存事件回滚（随后的 pull 取不到）；
 *   ③ 目录恢复可写后，新消息能正常落盘（证明回滚没有把状态搞坏）。
 *
 * 跑法：node notify-persist-selftest.mjs （退出码 0 = 全过）
 */
import { spawn } from 'node:child_process';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TOKEN = 'persist-selftest-token';
const PORT = 28994 + (process.pid % 300);
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'gosslan-notify-persist-'));
const base = `http://127.0.0.1:${PORT}`;

const child = spawn(process.execPath, [new URL('./server.mjs', import.meta.url).pathname], {
  env: {
    ...process.env,
    TOKEN,
    PORT: String(PORT - 1),
    HOST: '127.0.0.1',
    HEALTHZ_PORT: String(PORT),
    HEALTHZ_HOST: '127.0.0.1',
    WEBHOOK_DATA_DIR: DATA_DIR,
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
  const reg = await api('/v1/bots', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: '写盘自测', scope: 'personal' }),
  });
  assert.equal(reg.status, 201, JSON.stringify(reg.body));
  const send = reg.body.send_token;
  const client = reg.body.client_token;

  await t('数据目录只读时 publish 返回 503 persist_failed（不假装成功）', async () => {
    fs.chmodSync(DATA_DIR, 0o500); // 非 root 用户不可写（见脚本顶部说明）
    const r = await api(`/publish/${send}?text=${encodeURIComponent('写盘失败')}`);
    assert.equal(r.status, 503, `应 503，实际 ${r.status}：${JSON.stringify(r.body)}`);
    assert.equal(r.body.error, 'persist_failed');
  });

  await t('写盘失败后内存已回滚：pull 取不到那条事件', async () => {
    fs.chmodSync(DATA_DIR, 0o700); // 先恢复，pull 自身也要 sweep/可能落盘
    const r = await api(`/pull/${client}`);
    assert.equal(r.status, 200);
    assert.ok(!r.body.events.some((e) => e.text.includes('写盘失败')),
      '写盘失败的事件不该留在内存里被取到（半持久化）');
  });

  await t('目录恢复可写后新消息能正常落盘（回滚没搞坏状态）', async () => {
    const r = await api(`/publish/${send}?text=${encodeURIComponent('恢复后正常')}`);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const pulled = await api(`/pull/${client}`);
    assert.ok(pulled.body.events.some((e) => e.text.includes('恢复后正常')), '恢复后消息应能取到');
    for (const e of pulled.body.events) await api(`/ack/${client}/${e.id}`);
  });

  console.log(`\n✓ 写盘失败回滚自测通过：${passed} 条`);
} catch (e) {
  console.error('\n✗ 写盘失败回滚自测失败：', e?.stack ?? e);
  if (stderr) console.error('服务端日志：\n' + stderr);
  process.exitCode = 1;
} finally {
  try { fs.chmodSync(DATA_DIR, 0o700); } catch {}
  child.kill('SIGTERM');
}
