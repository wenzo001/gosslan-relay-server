#!/usr/bin/env node
/**
 * 协议对照测试：本仓对中继线格式的理解 vs 共享真值向量（protocol.fixtures.json）。
 *
 * 向量由主仓实现（relay_seal.rs / relay.rs）的同版本 crate 生成（见
 * fixtures/generator/）。本测试用 Node 内置加密**独立重算**全部向量，并拿
 * fixture 的首行真打一遍 server.mjs —— 任何一侧漂移都会在这里变红：
 *
 *   1. epoch_day：UTC 天序号与负值钳零（客户端侧规则）；
 *   2. 通道哈希：域前缀 / 0x00 分隔 / 公钥按 b64 字符串字节入哈希 / day 大端 /
 *      device_id 字典序（两端对称）；
 *   3. 协商签名材料：serde_json 元组形态 —— 域前缀 &[u8] 序列化为**数字数组**，
 *      这是文档里没写、最容易漂移的一处；
 *   4. GSRW1 签名：Ed25519 确定性签名，Node 验签通过 = Rust 签名与材料一致；
 *   5. X25519 DH 与双向记录密钥（KDF 域前缀 / 通道哈希hex / 0x00 / a2b|b2a）；
 *   6. 记录层封装：nonce = 4B 零 ‖ 计数器，明文 = 计数器 ‖ 内层帧，
 *      ChaCha20-Poly1305 密文与标签逐字节相等；
 *   7. 服务器行为：fixture 的正例首行必须被接受（保持连接），全部负例必须被拒。
 *
 * 跑法：node protocol_conformance.mjs   （退出码 0 = 全部一致）
 * 主仓侧的对照测试应读取同一份 fixture（消费方式见 INTEGRATION.md「协议 fixture」）。
 */

import { spawn } from 'node:child_process';
import net from 'node:net';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  createHash,
  createPrivateKey,
  createPublicKey,
  diffieHellman,
  sign as edSign,
  verify as edVerify,
  createCipheriv,
} from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';

const fx = JSON.parse(
  readFileSync(new URL('./protocol.fixtures.json', import.meta.url), 'utf8'),
);

const toHex = (b) => Buffer.from(b).toString('hex');
const b64url = (b64) => b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const ctrBe64 = (n) => {
  const b = Buffer.alloc(8);
  b.writeBigUInt64BE(BigInt(n));
  return b;
};

const results = [];
async function test(name, fn) {
  try {
    await fn();
    results.push(['PASS', name]);
    console.log(`  ✓ ${name}`);
  } catch (e) {
    results.push(['FAIL', name]);
    console.log(`  ✗ ${name}\n    ${e.message}`);
  }
}

// ── 1：epoch_day ─────────────────────────────────────────────────────────
function epochDay(nowMs) {
  return nowMs < 0 ? 0 : Math.floor(nowMs / 86_400_000);
}

await test('epoch_day 向量（含负值钳零）', () => {
  for (const v of fx.epoch_day.vectors) {
    assert.equal(epochDay(v.now_ms), v.day, `now_ms=${v.now_ms}`);
  }
});

// ── 2：通道哈希 ──────────────────────────────────────────────────────────
function channelHash(idA, pkA, idB, pkB, day) {
  const [i1, p1, i2, p2] =
    idA <= idB ? [idA, pkA, idB, pkB] : [idB, pkB, idA, pkA];
  const h = createHash('sha256');
  h.update('gosslan-relay-ch-v1', 'utf8');
  for (const f of [i1, p1, i2, p2]) {
    h.update(f, 'utf8');
    h.update(Buffer.alloc(1)); // 0x00 分隔
  }
  h.update(ctrBe64(day));
  return h.digest('hex');
}

await test('通道哈希：Node 重算 == fixture，且两端对称', () => {
  const inp = fx.channel_hash.inputs;
  const ab = channelHash(
    inp.device_id_a, inp.ed25519_pub_a_b64,
    inp.device_id_b, inp.ed25519_pub_b_b64,
    inp.epoch_day,
  );
  const ba = channelHash(
    inp.device_id_b, inp.ed25519_pub_b_b64,
    inp.device_id_a, inp.ed25519_pub_a_b64,
    inp.epoch_day,
  );
  assert.equal(ab, fx.channel_hash.expected_hex, '正序');
  assert.equal(ba, fx.channel_hash.expected_hex, '换边必须同值');
});

// ── 3：协商签名材料（serde_json 元组，前缀是数字数组） ───────────────────
function wrapSigningBytes(myId, peerId, ch, role, ephPubB64) {
  return Buffer.from(
    JSON.stringify([
      Array.from(Buffer.from('gosslan-relay-wrap-v1', 'utf8')),
      myId, peerId, ch, role, ephPubB64,
    ]),
    'utf8',
  );
}

await test('协商签名材料：字节级复现（含 &[u8] → 数字数组的序列化形态）', () => {
  const inp = fx.channel_hash.inputs;
  const ch = fx.channel_hash.expected_hex;
  const sbA = wrapSigningBytes(
    inp.device_id_a, inp.device_id_b, ch, 'A', fx.wrap.offers.A.eph_pub_b64,
  );
  const sbB = wrapSigningBytes(
    inp.device_id_b, inp.device_id_a, ch, 'B', fx.wrap.offers.B.eph_pub_b64,
  );
  assert.equal(toHex(sbA), fx.wrap.signing_bytes_hex.A, 'A 的签名材料');
  assert.equal(toHex(sbB), fx.wrap.signing_bytes_hex.B, 'B 的签名材料');
});

// ── 4：GSRW1 的 Ed25519 签名（确定性） ───────────────────────────────────
function edPrivFromFixture(side) {
  const { seed_b64, public_b64 } = fx.wrap.ed25519[side];
  return createPrivateKey({
    key: { kty: 'OKP', crv: 'Ed25519', d: b64url(seed_b64), x: b64url(public_b64) },
    format: 'jwk',
  });
}
function edPubFromFixture(side) {
  return createPublicKey({
    key: { kty: 'OKP', crv: 'Ed25519', x: b64url(fx.wrap.ed25519[side].public_b64) },
    format: 'jwk',
  });
}

await test('GSRW1 签名：Node 重签逐字节相等，且互验通过', () => {
  const inp = fx.channel_hash.inputs;
  const ch = fx.channel_hash.expected_hex;
  for (const [side, myId, peerId] of [
    ['A', inp.device_id_a, inp.device_id_b],
    ['B', inp.device_id_b, inp.device_id_a],
  ]) {
    const data = wrapSigningBytes(myId, peerId, ch, side, fx.wrap.offers[side].eph_pub_b64);
    const sig = edSign(null, data, edPrivFromFixture(side));
    assert.equal(
      sig.toString('base64'), fx.wrap.offers[side].sig_b64,
      `${side} 重签必须与 fixture 逐字节相等（Ed25519 是确定性的）`,
    );
    assert.ok(
      edVerify(null, data, edPubFromFixture(side), Buffer.from(fx.wrap.offers[side].sig_b64, 'base64')),
      `${side} 的 fixture 签名必须能被其绑定公钥验证`,
    );
  }
  // 协商线形态：4 字段、以 \n 结尾、不含 device_id / 长期公钥（隐私判据）
  for (const side of ['A', 'B']) {
    const line = fx.wrap.offers[side].line;
    assert.ok(line.startsWith('GSRW1 '), `${side} magic`);
    assert.ok(line.endsWith('\n'), `${side} 换行结尾`);
    assert.equal(line.trimEnd().split(' ').length, 4, `${side} 恰好 4 字段`);
    assert.ok(!line.includes(inp.device_id_a) && !line.includes(inp.device_id_b), '线上不得出现 device_id');
    assert.ok(
      !line.includes(fx.wrap.ed25519.A.public_b64) && !line.includes(fx.wrap.ed25519.B.public_b64),
      '线上不得出现长期公钥',
    );
  }
});

// ── 5：X25519 DH 与记录密钥 ──────────────────────────────────────────────
function xPrivFromFixture(side) {
  const { secret_b64, public_b64 } = fx.wrap.x25519_ephemeral[side];
  return createPrivateKey({
    key: { kty: 'OKP', crv: 'X25519', d: b64url(secret_b64), x: b64url(public_b64) },
    format: 'jwk',
  });
}
function xPubFromFixture(side) {
  return createPublicKey({
    key: { kty: 'OKP', crv: 'X25519', x: b64url(fx.wrap.x25519_ephemeral[side].public_b64) },
    format: 'jwk',
  });
}
function recordKey(dhHex, chHex, dir) {
  const h = createHash('sha256');
  h.update('gosslan-relay-record-v1', 'utf8');
  h.update(Buffer.from(dhHex, 'hex'));
  h.update(chHex, 'utf8');
  h.update(Buffer.alloc(1));
  h.update(dir, 'utf8');
  return h.digest('hex');
}

await test('X25519 DH 两侧同值，且记录密钥 KDF 复现', () => {
  const dhAB = diffieHellman({ privateKey: xPrivFromFixture('A'), publicKey: xPubFromFixture('B') });
  const dhBA = diffieHellman({ privateKey: xPrivFromFixture('B'), publicKey: xPubFromFixture('A') });
  assert.equal(toHex(dhAB), fx.wrap.dh_shared_secret_hex, 'A×B');
  assert.equal(toHex(dhBA), fx.wrap.dh_shared_secret_hex, 'B×A 必须同值');
  const ch = fx.channel_hash.expected_hex;
  assert.equal(recordKey(fx.wrap.dh_shared_secret_hex, ch, 'a2b'), fx.wrap.record_keys.a2b_hex);
  assert.equal(recordKey(fx.wrap.dh_shared_secret_hex, ch, 'b2a'), fx.wrap.record_keys.b2a_hex);
  assert.notEqual(fx.wrap.record_keys.a2b_hex, fx.wrap.record_keys.b2a_hex, '双向密钥不得相同');
});

// ── 6：记录层封装（逐字节） ──────────────────────────────────────────────
function sealRecord(keyHex, ctr, frameHex) {
  const nonce = Buffer.concat([Buffer.alloc(4), ctrBe64(ctr)]);
  const pt = Buffer.concat([ctrBe64(ctr), Buffer.from(frameHex, 'hex')]);
  const cipher = createCipheriv('chacha20-poly1305', Buffer.from(keyHex, 'hex'), nonce, {
    authTagLength: 16,
  });
  const ct = Buffer.concat([cipher.update(pt), cipher.final()]);
  return Buffer.concat([nonce, ct, cipher.getAuthTag()]);
}

await test('记录层：nonce/计数器/密文/标签逐字节复现', () => {
  assert.equal(fx.record.direction, 'a2b');
  assert.equal(fx.record.key_hex, fx.wrap.record_keys.a2b_hex, '记录密钥必须与 KDF 向量一致');
  for (const v of fx.record.vectors) {
    assert.equal(
      toHex(sealRecord(fx.record.key_hex, v.ctr, v.inner_frame_hex)),
      v.record_hex,
      `ctr=${v.ctr} 的记录`,
    );
    // 内层帧 = 4B 大端长度 ‖ JSON，长度字段必须与 JSON 字节数一致
    const frame = Buffer.from(v.inner_frame_hex, 'hex');
    assert.equal(frame.readUInt32BE(0), frame.length - 4, `ctr=${v.ctr} 内层长度前缀`);
    assert.equal(frame.subarray(4).toString('utf8'), v.inner_json);
  }
});

// ── 7：服务器行为 —— fixture 首行真打 server.mjs ─────────────────────────
const PORT = 28493 + (process.pid % 500);
const child = spawn(process.execPath, [new URL('./server.mjs', import.meta.url).pathname], {
  env: {
    ...process.env,
    TOKEN: fx.hello_line.token,
    PORT: String(PORT),
    HOST: '127.0.0.1',
    HELLO_TIMEOUT_MS: '1500',
    WAIT_TIMEOUT_MS: '4000',
    STATS: '0',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let srvOut = '';
child.stdout.on('data', (b) => (srvOut += b.toString()));
child.stderr.on('data', (b) => (srvOut += b.toString()));
await new Promise((r) => child.stdout.once('data', r));

const connect = () =>
  new Promise((resolve, reject) => {
    const s = net.connect(PORT, '127.0.0.1', () => resolve(s));
    s.on('error', reject);
  });
const closedWithin = (sock, ms) =>
  new Promise((resolve) => {
    const t = setTimeout(() => resolve(false), ms);
    sock.once('close', () => { clearTimeout(t); resolve(true); });
    sock.once('error', () => { clearTimeout(t); resolve(true); });
  });

await test('fixture 正例首行被服务器接受（连接被保持）', async () => {
  const s = await connect();
  s.write(fx.hello_line.line);
  await sleep(300);
  assert.ok(!s.destroyed, '正例首行之后连接必须仍然开着（进入等待表）');
  s.destroy();
});

for (const neg of fx.hello_line.negatives.filter((n) => n.expect === 'reject')) {
  await test(`负例 ${neg.name} 被服务器拒绝`, async () => {
    const s = await connect();
    s.write(neg.line);
    assert.ok(await closedWithin(s, 1500), `${neg.name} 必须被关闭`);
  });
}

await test('负例 no-newline：缺 \\n 的首行不立刻拒，按首行超时处理', async () => {
  const neg = fx.hello_line.negatives.find((n) => n.expect === 'hold-then-hello-timeout');
  const s = await connect();
  s.write(neg.line);
  await sleep(300);
  assert.ok(!s.destroyed, '没有 \\n 时服务器还在等，不能立刻拒');
  assert.ok(await closedWithin(s, 3000), '最终应由首行超时关掉（HELLO_TIMEOUT_MS=1.5s）');
});

child.kill('SIGTERM');
await sleep(200);
if (child.exitCode === null) child.kill('SIGKILL');

assert.ok(!srvOut.includes(fx.hello_line.token), '服务器日志不得出现口令');

const failed = results.filter(([r]) => r === 'FAIL');
console.log(`\n${results.length - failed.length}/${results.length} 一致`);
if (failed.length) {
  console.log('漂移：', failed.map(([, n]) => n).join(' | '));
  process.exit(1);
}
