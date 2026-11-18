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

  await t('中文不丢：GET(percent-encoded) / POST body / PUT markdown 三种都原样入队', async () => {
    // 前置用例可能已占队列（NOTIFY_MAX_EVENTS=5）；先取空并 ack，避免撞上限。
    const pre = await api(`/pull/${client}`);
    for (const e of pre.body.events) await api(`/ack/${client}/${e.id}`);
    const zh = '构建完成：中文标题 ✅';
    const md = '**加粗** 与 `code`\n- 列表项';
    const g = await api(`/publish/${send}?text=${encodeURIComponent(zh)}&title=${encodeURIComponent('中文标题')}`);
    assert.equal(g.status, 200, JSON.stringify(g.body));
    const p1 = await api(`/publish/${send}`, {
      method: 'POST',
      headers: { 'content-type': 'text/plain; charset=utf-8' },
      body: zh,
    });
    assert.equal(p1.status, 200, JSON.stringify(p1.body));
    const p2 = await api(`/publish/${send}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ text: md, title: '富文本', format: 'markdown' }),
    });
    assert.equal(p2.status, 200, JSON.stringify(p2.body));

    const list = await api(`/pull/${client}`);
    const texts = list.body.events.map((e) => e.text);
    assert.ok(texts.includes(zh), `GET/POST 的中文丢了：${JSON.stringify(texts)}`);
    assert.ok(texts.includes(md), `markdown 正文丢了：${JSON.stringify(texts)}`);
    const mdEvent = list.body.events.find((e) => e.text === md);
    assert.equal(mdEvent.format, 'markdown', 'format 没有落库 ⇒ 前端无法按富文本渲染');
    for (const e of list.body.events) await api(`/ack/${client}/${e.id}`);
  });

  await t('URL 里放原始中文 ⇒ 400 + 可照做的提示（不是静默失败）', async () => {
    const net = await import('node:net');
    const raw = await new Promise((resolve) => {
      const sock = net.connect(PORT, '127.0.0.1', () => {
        sock.write(`GET /publish/${send}?text=中文未编码 HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n`);
      });
      let buf = '';
      sock.on('data', (d) => { buf += d; });
      sock.on('error', () => {});
      sock.on('close', () => resolve(buf));
    });
    assert.match(raw, /400 Bad Request/, '原始中文 URL 应返回 400');
    assert.match(raw, /data-urlencode/, '400 响应应给出可照做的写法提示');
  });

  await t('TTL 到期后事件被清理（不膨胀）', async () => {
    await sleep(2200);
    const r = await api(`/pull/${client}`);
    assert.equal(r.body.events.length, 0, `TTL 后应清空，实际 ${r.body.events.length}`);
  });

  await t('撤销可用 client_token（客户端不存 send_token，旧记录也能删）', async () => {
    const reg2 = await api('/v1/bots', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: '撤销自测', scope: 'personal' }),
    });
    assert.equal(reg2.status, 201);
    const ct = reg2.body.client_token;
    // 先入队一条，撤销应连未取走的消息一起清掉。
    assert.equal((await api(`/publish/${reg2.body.send_token}?text=pending`)).status, 200);
    assert.equal((await api(`/pull/${ct}`)).body.events.length, 1);
    const del = await api(`/v1/bots/${ct}`, { method: 'DELETE' });
    assert.equal(del.status, 200, `client_token 撤销应成功：${JSON.stringify(del.body)}`);
    assert.equal((await api(`/pull/${ct}`)).status, 401, '撤销后 client_token 应失效');
    assert.equal((await api(`/publish/${reg2.body.send_token}?text=after`)).status, 401, '旧 hook 应失效');
  });

  await t('长轮询：新消息立即唤醒（不等满 wait）', async () => {
    const start = Date.now();
    const pullP = api(`/pull/${client}?wait=15`);
    await sleep(300);
    const pub = await api(`/publish/${send}?text=${encodeURIComponent('长轮询唤醒')}`);
    assert.equal(pub.status, 200);
    const r = await pullP;
    const elapsed = Date.now() - start;
    assert.ok(elapsed < 3000, `新消息应在 <3s 唤醒长轮询，实际 ${elapsed}ms`);
    assert.ok(r.body.events.some((e) => e.text.includes('长轮询唤醒')), '唤醒后应拿到新消息');
    const eid = r.body.events.find((e) => e.text.includes('长轮询唤醒')).id;
    await api(`/ack/${client}/${eid}`);
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

  await t('limit 边界：0 / 负数 / 非数字都回落默认，不再取到奇怪子集', async () => {
    // 先清空（前面队列上限用例填满了）。
    const pre = await api(`/pull/${client}`);
    for (const e of pre.body.events) await api(`/ack/${client}/${e.id}`);
    // 连发 3 条，默认上限 50 ⇒ 三条都该回来。
    for (let i = 0; i < 3; i += 1) assert.equal((await api(`/publish/${send}?text=lim${i}`)).status, 200);
    for (const q of ['0', '-5', 'abc']) {
      const r = await api(`/pull/${client}?limit=${q}`);
      assert.equal(r.status, 200);
      assert.equal(r.body.events.length, 3, `limit=${q} 应回落默认取 3 条，实际 ${r.body.events.length}`);
    }
    // 正常正整数仍生效：limit=1 只取 1 条。
    const one = await api(`/pull/${client}?limit=1`);
    assert.equal(one.body.events.length, 1, 'limit=1 应只取 1 条');
    for (const e of (await api(`/pull/${client}`)).body.events) await api(`/ack/${client}/${e.id}`);
  });

  await t('撤销机器人会立即唤醒挂在它上面的长轮询（不等满 15s）', async () => {
    const reg3 = await api('/v1/bots', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: '唤醒撤销自测', scope: 'personal' }),
    });
    const ct = reg3.body.client_token;
    const start = Date.now();
    const pullP = api(`/pull/${ct}?wait=15`);
    await sleep(300);
    assert.equal((await api(`/v1/bots/${ct}`, { method: 'DELETE' })).status, 200);
    const r = await pullP;
    const elapsed = Date.now() - start;
    assert.equal(r.status, 401, '撤销后挂起的 pull 应重新鉴权拿 401');
    assert.ok(elapsed < 3000, `撤销应立即唤醒长轮询，实际等了 ${elapsed}ms`);
  });

  await t('长轮询客户端中途断开：不留残留 waiter，也不污染后续收发', async () => {
    const net = await import('node:net');
    const sock = net.connect(PORT, '127.0.0.1', () => {
      sock.write(`GET /pull/${client}?wait=15 HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n`);
    });
    await sleep(200);
    sock.destroy(); // 客户端在 15s 窗口内断开
    await sleep(400);
    // 断开后发消息应正常入队、取件能拿到（证明 waiter 被摘、状态没被搞坏）。
    const r = await api(`/publish/${send}?text=${encodeURIComponent('断连后')}`);
    assert.equal(r.status, 200);
    const pulled = await api(`/pull/${client}`);
    assert.ok(pulled.body.events.some((e) => e.text.includes('断连后')), '断连后消息应仍能取到');
    for (const e of pulled.body.events) await api(`/ack/${client}/${e.id}`);
  });

  await t('通知请求处理完不二次写响应（日志无 Cannot write headers）', async () => {
    await sleep(300); // 让服务端异步的 .then(serveHealth) 有机会暴露
    assert.ok(!stderr.includes('Cannot write headers'),
      `handleNotify 返回 undefined 会触发 serveHealth 二次写：\n${stderr}`);
  });

  console.log(`\n✓ v7 通知器自测通过：${passed} 条`);
} catch (e) {
  console.error('\n✗ v7 通知器自测失败：', e?.stack ?? e);
  if (stderr) console.error('服务端日志：\n' + stderr);
  process.exitCode = 1;
} finally {
  child.kill('SIGTERM');
}
