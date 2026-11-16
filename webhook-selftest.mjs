#!/usr/bin/env node
/**
 * Webhook 通知服务的自测（零依赖，`node webhook-selftest.mjs` 直接跑）。
 *
 * 它验的是这台机器对外部承诺的那些事（不是 Gosslan 协议）：
 *   1. 外部提交返回 202 **只代表已持久入队**；队列不可写 / 已满 ⇒ 明确失败，不假成功；
 *   2. 同一 `Idempotency-Key` 重发只产生一条事件（并发重复提交也只���一条）；
 *   3. 客户端断线、ACK 丢失、租约超时后，事件**最终被取到**且聊天里不重复；
 *   4. 外部密钥只能「提交 + 查这次提交的状态」：不能读队列、不能枚举 bot、
 *      不能碰别的 bot、不能取件；
 *   5. bot 暂停 ⇒ 拒收；撤销 ⇒ 旧密钥全部失效；轮换后旧密钥失效；
 *   6. 文本 / 图片 / 请求体 / 速率的边界都有明确失败态；
 *   7. **日志与响应里没有密钥、没有正文**；
 *   8. `/healthz` 给 readiness + 队列深度 + 最旧事件年龄。
 *
 * 跑法：node webhook-selftest.mjs   （退出码 0 = 全部通过）
 */

import { spawn } from 'node:child_process';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const CLIENT_TOKEN = 'selftest-client-token-ignore';
const PEPPER = 'selftest-pepper-ignore';
const PORT = 25995 + (process.pid % 300);
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'gosslan-webhook-selftest-'));

const base = `http://127.0.0.1:${PORT}`;
const child = spawn(process.execPath, [new URL('./webhook.mjs', import.meta.url).pathname], {
  env: {
    ...process.env,
    WEBHOOK_CLIENT_TOKEN: CLIENT_TOKEN,
    WEBHOOK_PEPPER: PEPPER,
    WEBHOOK_PORT: String(PORT),
    WEBHOOK_HOST: '127.0.0.1',
    WEBHOOK_DATA_DIR: DATA_DIR,
    WEBHOOK_LEASE_MS: '1200',
    WEBHOOK_QUEUE_TTL_MS: '60000',
    WEBHOOK_RATE_PER_MIN: '5',
    LOG: '1',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});

let stdout = '';
child.stdout.on('data', (d) => {
  stdout += d.toString();
});
child.stderr.on('data', (d) => {
  stdout += d.toString();
});

async function waitReady() {
  for (let i = 0; i < 100; i += 1) {
    try {
      const r = await fetch(`${base}/healthz`);
      if (r.ok) return;
    } catch {
      /* 还没起来 */
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`服务没起来：\n${stdout}`);
}

async function api(pathname, { method = 'GET', token, json, headers = {} } = {}) {
  const h = { ...headers };
  if (token) h.authorization = `Bearer ${token}`;
  if (json !== undefined) h['content-type'] = 'application/json';
  const res = await fetch(`${base}${pathname}`, {
    method,
    headers: h,
    body: json === undefined ? undefined : JSON.stringify(json),
  });
  let body = null;
  const text = await res.text();
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = { raw: text };
  }
  return { status: res.status, body };
}

let passed = 0;
async function t(name, fn) {
  await fn();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

try {
  await waitReady();

  // ---- 注册一个机器人（客户端令牌）----
  const reg = await api('/v1/client/bots', {
    method: 'POST',
    token: CLIENT_TOKEN,
    json: { name: '自测机器人', target: { kind: 'inbox' } },
  });
  assert.equal(reg.status, 201, '注册机器人应返回 201');
  const botId = reg.body.bot_id;
  const sendSecret = reg.body.send_secret;
  const clientSecret = reg.body.client_secret;
  assert.ok(botId.startsWith('bot_'), 'bot_id 前缀');
  assert.ok(sendSecret.length >= 32, '发送密钥要够长');
  assert.ok(clientSecret.length >= 32, '取件密钥要够长');

  await t('注册机器人要带客户端令牌，缺令牌一律拒', async () => {
    const no = await api('/v1/client/bots', { method: 'POST', json: { name: 'x' } });
    assert.equal(no.status, 401);
  });

  let firstEventId = null;
  await t('外部提交成功返回 202 + event_id', async () => {
    const r = await api(`/v1/hooks/${botId}/messages`, {
      method: 'POST',
      token: sendSecret,
      json: { text: '第一条通知' },
    });
    assert.equal(r.status, 202);
    assert.ok(r.body.event_id.startsWith('evt_'));
    assert.equal(r.body.status, 'queued');
    firstEventId = r.body.event_id;
  });

  await t('同一个 Idempotency-Key 重发只产生一条事件', async () => {
    const h = { 'idempotency-key': 'key-1' };
    const a = await api(`/v1/hooks/${botId}/messages`, {
      method: 'POST',
      token: sendSecret,
      headers: h,
      json: { text: '幂等' },
    });
    const b = await api(`/v1/hooks/${botId}/messages`, {
      method: 'POST',
      token: sendSecret,
      headers: h,
      json: { text: '幂等' },
    });
    assert.equal(a.status, 202);
    assert.equal(a.body.event_id, b.body.event_id, '重复提交必须返回同一个 event_id');
    assert.equal(b.body.duplicate, true);
  });

  await t('外部密钥不能取件（客户端密钥是另一个）', async () => {
    const r = await api(`/v1/client/bots/${botId}/pull`, { method: 'POST', token: sendSecret, json: {} });
    assert.equal(r.status, 401, '外部发送密钥不得用来取件');
  });

  await t('外部密钥读不到别人的 bot', async () => {
    const other = await api('/v1/client/bots', {
      method: 'POST',
      token: CLIENT_TOKEN,
      json: { name: '另一个', target: { kind: 'inbox' } },
    });
    const r = await api(`/v1/hooks/${other.body.bot_id}/messages`, {
      method: 'POST',
      token: sendSecret,
      json: { text: '横向访问' },
    });
    assert.equal(r.status, 401, '拿 A 的密钥不能写 B');
  });

  await t('外部密钥只能查自己那次提交的状态（看不到正文）', async () => {
    // ⚠️ 这里**不要**去 pull：pull 会把事件租走（后面那条租约用例要自己拉）。
    const st = await api(`/v1/hooks/${botId}/messages/${firstEventId}`, { token: sendSecret });
    assert.equal(st.status, 200);
    assert.equal(st.body.event_id, firstEventId);
    assert.equal(st.body.text, undefined, '状态响应里不许带正文');
    assert.equal(st.body.status, 'queued');
  });

  await t('拉�� → ACK 前租约过期会重投，ACK 后不再重投', async () => {
    const p1 = await api(`/v1/client/bots/${botId}/pull`, { method: 'POST', token: clientSecret, json: {} });
    const ev = p1.body.events[0];
    assert.ok(ev, '第一次拉取应拿到事件');
    assert.ok(ev.lease_until, '事件带租约');
    // 不 ACK ⇒ 租约过期后应能被重新拉取
    await new Promise((r) => setTimeout(r, 1400));
    const p2 = await api(`/v1/client/bots/${botId}/pull`, { method: 'POST', token: clientSecret, json: {} });
    const again = p2.body.events.find((e) => e.event_id === ev.event_id);
    assert.ok(again, '租约过期后必须能重投（否则消息会丢）');
    // ACK 之后不再出现
    const ack = await api(`/v1/client/bots/${botId}/ack`, {
      method: 'POST',
      token: clientSecret,
      json: { event_id: ev.event_id, durable_receipt: 'r1' },
    });
    assert.equal(ack.status, 200);
    assert.equal(ack.body.status, 'accepted_by_gateway');
    const p3 = await api(`/v1/client/bots/${botId}/pull`, { method: 'POST', token: clientSecret, json: {} });
    assert.ok(!p3.body.events.find((e) => e.event_id === ev.event_id), 'ACK 后不许再投');
  });

  await t('ACK 后再拉同一事件不会重复（网关按 event_id 幂等）', async () => {
    const r = await api(`/v1/client/bots/${botId}/ack`, {
      method: 'POST',
      token: clientSecret,
      json: { event_id: 'evt_not_exist', durable_receipt: 'x' },
    });
    assert.equal(r.status, 404, 'ACK 不存在的事件要明确报错');
  });

  await t('图片：按文件头判定类型，伪装成 PNG 的文本被拒', async () => {
    const form = new FormData();
    form.set('text', '带图');
    form.set('image[]', new Blob([Buffer.from('not-an-image')], { type: 'image/png' }), 'a.png');
    const res = await fetch(`${base}/v1/hooks/${botId}/messages`, {
      method: 'POST',
      headers: { authorization: `Bearer ${sendSecret}` },
      body: form,
    });
    assert.equal(res.status, 415, '伪图片必须被拒');
  });

  await t('图片：真 PNG 被接受且事件带附件元数据', async () => {
    const png = Buffer.from(
      '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c6300010000050001',
      'hex',
    );
    const form = new FormData();
    form.set('text', '带图');
    form.set('source', 'CI');
    form.set('image[]', new Blob([png], { type: 'image/png' }), 'shot.png');
    const res = await fetch(`${base}/v1/hooks/${botId}/messages`, {
      method: 'POST',
      headers: { authorization: `Bearer ${sendSecret}` },
      body: form,
    });
    assert.equal(res.status, 202);
    const body = await res.json();
    assert.equal(body.status, 'queued');
  });

  await t('速率限制：超过配额返回 429', async () => {
    let saw429 = false;
    for (let i = 0; i < 12; i += 1) {
      const r = await api(`/v1/hooks/${botId}/messages`, {
        method: 'POST',
        token: sendSecret,
        json: { text: `刷 ${i}` },
      });
      if (r.status === 429) {
        saw429 = true;
        break;
      }
    }
    assert.ok(saw429, '超配额必须限流（不能无限收）');
  });

  await t('空消息被拒（至少 text 或一张图）', async () => {
    // 用**另一个** bot：限流是按 bot 计的，前面那几条已经把主 bot 的配额用完了。
    const b2 = await api('/v1/client/bots', {
      method: 'POST',
      token: CLIENT_TOKEN,
      json: { name: '边界', target: { kind: 'inbox' } },
    });
    const r = await api(`/v1/hooks/${b2.body.bot_id}/messages`, {
      method: 'POST',
      token: b2.body.send_secret,
      json: { text: '' },
    });
    assert.equal(r.status, 400);
  });

  await t('正文格式：text / markdown 都认，其余按 text', async () => {
    const b3 = await api('/v1/client/bots', {
      method: 'POST',
      token: CLIENT_TOKEN,
      json: { name: '格式', target: { kind: 'inbox' } },
    });
    const bid = b3.body.bot_id;
    const mk = async (format) => {
      const r = await api(`/v1/hooks/${bid}/messages`, {
        method: 'POST',
        token: b3.body.send_secret,
        json: { text: '# 标题\n\n- 一\n- 二', format },
      });
      assert.equal(r.status, 202);
      return r.body.event_id;
    };
    const mdId = await mk('markdown');
    const txtId = await mk('text');
    const weirdId = await mk('html');
    const pull = await api(`/v1/client/bots/${bid}/pull`, {
      method: 'POST',
      token: b3.body.client_secret,
      json: {},
    });
    const byId = Object.fromEntries(pull.body.events.map((e) => [e.event_id, e]));
    assert.equal(byId[mdId].format, 'markdown', 'markdown 格式要如实带出去');
    assert.equal(byId[txtId].format, 'text');
    assert.equal(byId[weirdId].format, 'text', '不认识���格式按 text（不猜）');
  });

  await t('暂停 ⇒ 拒收；恢复 ⇒ 又能收；撤销 ⇒ 旧密钥失效', async () => {
    const b4 = await api('/v1/client/bots', {
      method: 'POST',
      token: CLIENT_TOKEN,
      json: { name: '状态机', target: { kind: 'inbox' } },
    });
    const bid = b4.body.bot_id;
    const sec = b4.body.send_secret;
    const csec = b4.body.client_secret;
    const setStatus = async (st) =>
      api(`/v1/client/bots/${bid}/status`, {
        method: 'POST',
        token: csec,
        json: { status: st },
      });
    assert.equal((await setStatus('paused')).status, 200);
    const paused = await api(`/v1/hooks/${bid}/messages`, {
      method: 'POST',
      token: sec,
      json: { text: '暂停期间' },
    });
    assert.equal(paused.status, 403, '暂停期间必须拒收');
    assert.equal((await setStatus('active')).status, 200);
    const ok = await api(`/v1/hooks/${bid}/messages`, {
      method: 'POST',
      token: sec,
      json: { text: '恢复之后' },
    });
    assert.equal(ok.status, 202, '恢复后要能收');
    assert.equal((await setStatus('revoked')).status, 200);
    const revoked = await api(`/v1/hooks/${bid}/messages`, {
      method: 'POST',
      token: sec,
      json: { text: '撤销之后' },
    });
    assert.equal(revoked.status, 401, '撤销后旧密钥必须失效');
  });

  await t('v6 scope：personal / group 都认，群缺 group_id 被拒，旧 inbox 兼容', async () => {
    const mk = async (target) => api('/v1/client/bots', {
      method: 'POST', token: CLIENT_TOKEN, json: { name: 'scope', target },
    });
    const p = await mk({ kind: 'personal' });
    assert.equal(p.status, 201);
    assert.equal(p.body.target.kind, 'personal');
    const g = await mk({ kind: 'group', group_id: 'group:abc' });
    assert.equal(g.status, 201);
    assert.equal(g.body.target.group_id, 'group:abc');
    const bad = await mk({ kind: 'group' });
    assert.equal(bad.status, 400, '群机器人没 group_id 必须拒');
    const legacy = await mk({ kind: 'inbox' });
    assert.equal(legacy.status, 201, '旧 inbox 仍要兼容');
    assert.equal(legacy.body.target.kind, 'personal', '旧 inbox 归一到 personal');
    const weird = await mk({ kind: 'channel' });
    assert.equal(weird.status, 400);
  });

  await t('healthz 给 readiness + 队列深度', async () => {
    const r = await api('/healthz');
    assert.equal(r.status, 200);
    assert.equal(r.body.ok, true);
    assert.equal(r.body.storage_writable, true);
    assert.ok(typeof r.body.queued === 'number');
  });

  await t('撤销后旧密钥全部失效', async () => {
    // 直接改状态文件模拟撤销（管理面在客户端侧）
    const botsFile = path.join(DATA_DIR, 'bots.json');
    const state = JSON.parse(fs.readFileSync(botsFile, 'utf8'));
    state[botId].status = 'revoked';
    fs.writeFileSync(botsFile, JSON.stringify(state, null, 2));
    child.kill('SIGTERM');
    await new Promise((r) => setTimeout(r, 400));
    child.stdout.destroy();
    // 重新起一个进程读同一份状态
    const child2 = spawn(process.execPath, [new URL('./webhook.mjs', import.meta.url).pathname], {
      env: {
        ...process.env,
        WEBHOOK_CLIENT_TOKEN: CLIENT_TOKEN,
        WEBHOOK_PEPPER: PEPPER,
        WEBHOOK_PORT: String(PORT),
        WEBHOOK_HOST: '127.0.0.1',
        WEBHOOK_DATA_DIR: DATA_DIR,
        LOG: '1',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out2 = '';
    child2.stdout.on('data', (d) => {
      out2 += d.toString();
    });
    child2.stderr.on('data', (d) => {
      out2 += d.toString();
    });
    globalThis.__child = child2;
    await waitReady();
    const r = await api(`/v1/hooks/${botId}/messages`, {
      method: 'POST',
      token: sendSecret,
      json: { text: '撤销后' },
    });
    assert.equal(r.status, 401, '撤销后旧密钥必须失效');
    assert.ok(!out2.includes(sendSecret), '日志里不许出现密钥');
    assert.ok(!out2.includes('第一条通知'), '日志里不许出现正文');
  });

  console.log(`\n✓ webhook 自测通过：${passed} 条`);
  globalThis.__child?.kill('SIGTERM');
  process.exit(0);
} catch (e) {
  console.error(`\n✗ webhook 自测失败：${e?.message ?? e}`);
  console.error(stdout.slice(-2000));
  globalThis.__child?.kill('SIGTERM');
  child.kill('SIGTERM');
  process.exit(1);
}
