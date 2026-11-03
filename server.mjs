#!/usr/bin/env node
/**
 * Gosslan 公网中转（哑管道 / blind circuit relay）。
 *
 * ## 它只做一件事
 * 把两条「登记了同一个通道哈希」的 TCP 连接拼成一个双向字节管道，然后**再也不看内容**。
 * 不解析 Gosslan 帧、不解析 JSON、不落盘、不缓存消息：断开即丢，重启即清空
 * （全部状态就是下面一个 Map 加一个 Set，都在内存里）。
 *
 * ## 它为什么读不到消息
 * Gosslan 正文本来就是端到端加密的（X25519 + ChaCha20-Poly1305）。本服务器只搬字节，
 * 连"一条消息"的边界都不需要知道。电路建立后两端客户端之间还有一层记录层封装
 * （`src-tauri/src/transport/relay_seal.rs`，用好友已绑定的 Ed25519 公钥验签），
 * 所以本服务器**既读不到正文与元数据，也注入不进任何一帧**。
 *
 * ## 它仍然能看到什么（诚实边界，README 里同样写了）
 * 有连接进来、什么时候、持续多久、双向各搬了多少字节。通道哈希是 32 字节摘要，
 * 不知道两端公钥就还原不出设备 ID；但"同一串哈希再次出现"本身是可关联的。
 *
 * ## 协议（客户端发出的第一行，只有这一行）
 * ```text
 * GSRL1 <token> <64 位十六进制通道哈希>\n        （整行 ≤ 256 字节）
 * ```
 * 首行之后的字节一律原样转发，不做任何解析。
 *
 * 零依赖：只用 node:net + node:crypto，Node ≥ 18。
 */

import net from 'node:net';
import http from 'node:http';
import { readFileSync } from 'node:fs';
import { createHash, timingSafeEqual } from 'node:crypto';

const PORT = Number(envInt('PORT', 59993, 65535));
const HOST = process.env.HOST ?? '0.0.0.0';
const TOKEN = process.env.TOKEN ?? '';
/** 同时存活的客户端连接上限（含等待配对的）。30 人规模留了 4 倍余量。 */
const MAX_CLIENTS = Number(envInt('MAX_CLIENTS', 128));
/** 首行超时：连上却不说话的连接一律掐掉，不给它占坑的机会。 */
const HELLO_TIMEOUT_MS = Number(envInt('HELLO_TIMEOUT_MS', 10_000));
/**
 * 等对端来配对的上限时间；超时放弃。
 * ⚠️ 别把这个值往客户端的协商看门狗之下压（现在主仓是 10s）：有效会合窗口是
 * min(客户端 socket 存活期, 本值)，调小只会降低配对成功率，不会提高。
 * 它同时是"首行已被接受"这个信号的长度（服务器不发消息，关闭时机就是回复，见 README 协议规格）。
 */
const WAIT_TIMEOUT_MS = Number(envInt('WAIT_TIMEOUT_MS', 30_000));
/**
 * 已配对电路的空闲阈值：客户端心跳 5s、Presence 10s，超过阈值即判死。
 * 实际回收发生在 IDLE ~ IDLE + min(30s, IDLE)：判断在周期性清扫里做，不是每电路独立定时器。
 */
const IDLE_TIMEOUT_MS = Number(envInt('IDLE_TIMEOUT_MS', 180_000));
/**
 * 等待阶段替对端暂存的字节上限（每连接）。它和 MAX_CLIENTS 是相乘的 —— 这台进程的
 * 应用层缓冲上界就是两者之积：早期给 8MiB（×128 ≈ 1GiB）能被一个连上就不停写字节、
 * 永远不配对的人打爆。现在 1MiB×128 = 128MiB，加运行时约 174MiB：systemd 的
 * MemoryMax=192M 装得下，PM2 的 160M 会先重启一次（两种都兜住整机）。
 * 诚实客户端在等待期只发一条 ≤512 字节的协商线，1MiB 仍是两千倍余量。
 */
const PENDING_MAX = Number(envInt('PENDING_MAX', 1024 * 1024));
/** 是否打印事件行（不含任何载荷）。 */
const LOG_EVENTS = process.env.LOG !== '0';
/**
 * 可选健康检查端点（HTTP GET /healthz 返回运行指标 JSON）。不设 = 不启用，
 * 中继主协议不受零影响。默认只绑回环；要对外暴露请先想清楚（指标虽无载荷，
 * 但"谁在何时连了多少"的形状信息会多一个读取者）。
 */
const HEALTHZ_PORT = (() => {
  const raw = process.env.HEALTHZ_PORT;
  if (raw === undefined || raw === '') return 0; // 不设 = 不启用
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0 || n > 65535) {
    console.error(`[gosslan-relay] HEALTHZ_PORT=${raw} 不是合法端口（0–65535），健康端点不启用`);
    return 0;
  }
  return n;
})();
const HEALTHZ_HOST = process.env.HEALTHZ_HOST ?? '127.0.0.1';

const MAX_LINE = 256;
const MAGIC = 'GSRL1';
const LF = 0x0a;

if (!TOKEN) {
  // 没有 token 的中继就是一个开放代理：任何人都能拿它转发任意字节。
  // 这不该是"配置宽松一点"的事，所以拒绝启动而不是警告（公网机器上后果很实在）。
  console.error('[gosslan-relay] 必须设置 TOKEN 环境变量，否则不启动。');
  console.error('  例：TOKEN=$(openssl rand -hex 16) node server.mjs');
  process.exit(2);
}

// 弱口令 + 对外监听 = 邀请全网来爆破。`openssl rand -hex 16` 是文档里的标准生成方式
// （32 字符），这里卡 16 字符下限：比它短的口令在公网上撑不住离线字典。回环绑定
// （本机联调，见 INTEGRATION §7）放行但警告 —— bench/本地 nc 联调用的都是短口令。
const MIN_TOKEN_LEN = 16;
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1']);
if (TOKEN.length < MIN_TOKEN_LEN) {
  if (LOOPBACK_HOSTS.has(HOST)) {
    console.warn(
      `[gosslan-relay] TOKEN 短于 ${MIN_TOKEN_LEN} 字符；因监听回环地址 ${HOST} 放行，仅限本机联调。`,
    );
  } else {
    console.error(
      `[gosslan-relay] TOKEN 短于 ${MIN_TOKEN_LEN} 字符且监听 ${HOST}（非回环）：拒绝启动。`,
    );
    console.error('  弱口令在公网上等于没有口令。生成强口令：openssl rand -hex 16');
    process.exit(2);
  }
}

/** channel hex → 正在等对端的连接（每个通道最多一个等待者）。 */
const waiting = new Map();
/** 已配对电路。 */
const circuits = new Set();
const stats = { accepted: 0, paired: 0, rejected: 0, bytes: 0, clients: 0 };
/** 连接序号：仅用于把日志行对到同一条连接（并发时通道前缀会撞），无协议含义。 */
let connSeq = 0;

const log = (...a) => LOG_EVENTS && console.log(new Date().toISOString(), ...a);

function envInt(name, dflt, max = Infinity) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return String(dflt);
  const n = Number(raw);
  // 必须真是整数且在合法区间：`PORT=1.5` 过去能通过（只查 finite>0），然后在
  // listen 里以 Node 内部栈崩掉；`PORT=999999` 是正整数但越界，同样会裸栈
  // （ERR_SOCKET_BAD_PORT，2026-11-03 实测复现）。配置错误应当一行说清，不该留栈。
  if (!Number.isInteger(n) || n <= 0 || n > max) {
    console.error(`[gosslan-relay] ${name}=${raw} 不是合法正整数${max < Infinity ? `（≤${max}）` : ''}，改用 ${dflt}`);
    return String(dflt);
  }
  return raw;
}

/** token 比较走定长时间，不按字节早退。 */
function tokenOk(given) {
  const a = createHash('sha256').update(given, 'utf8').digest();
  const b = createHash('sha256').update(TOKEN, 'utf8').digest();
  // timingSafeEqual 要求等长；两边都是 sha256 摘要（32B），既不按字节早退也不会因口令长度不同而抛错。
  return timingSafeEqual(a, b);
}

function clearTimer(which, c) {
  if (c[which]) {
    clearTimeout(c[which]);
    c[which] = null;
  }
}

/** 首行非法或超限：留一行原因、断开。载荷一个字节都不碰。
 *  `code` 是稳定错误码（对照表见 README「日志错误码」）：监控按码 grep，
 *  中文说明给人读。错误码只进服务器日志，**不发给客户端** —— 对客户端的
 *  契约不变，仍然只有关闭时机（见 README 协议规格）。 */
function reject(c, code, why) {
  stats.rejected++;
  log(`[reject] #${c.id} ${code} ${why}`);
  clearTimer('helloTimer', c);
  if (c.ch && waiting.get(c.ch) === c) waiting.delete(c.ch);
  if (!c.sock.destroyed) c.sock.destroy();
}

/** 把两条连接拼成电路；先把等待期暂存的字节按序冲出，再切到转发态。 */
function pair(a, b) {
  clearTimer('waitTimer', a);
  waiting.delete(a.ch);
  const circuit = { a, b, up: 0, down: 0, last: Date.now() };
  circuits.add(circuit);
  stats.paired++;
  for (const [x, y] of [[a, b], [b, a]]) {
    x.phase = 'paired';
    x.other = y;
    x.circuit = circuit;
  }
  log(`[circuit] 配对 #${a.id}+#${b.id} ch=${a.ch.slice(0, 8)}… 电路数=${circuits.size}`);
  for (const [from, to] of [[a, b], [b, a]]) {
    if (from.pending.length) {
      const buf = Buffer.concat(from.pending);
      from.pending = [];
      forward(from, to, buf);
    }
  }
}

function forward(from, to, buf) {
  const circuit = from.circuit;
  if (to.sock.destroyed || !to.sock.writable) {
    closeCircuit(circuit, 'peer-gone');
    return;
  }
  if (circuit) {
    circuit.last = Date.now();
    if (circuit.a === from) circuit.up += buf.length;
    else circuit.down += buf.length;
  }
  stats.bytes += buf.length;
  if (!to.sock.write(buf)) {
    // 对端写不动 ⇒ 暂停真正的源头，等 drain 再恢复。不排队、不丢弃，
    // 所以内存上限就是两端各自的 TCP 缓冲，与文件大小无关。
    from.sock.pause();
    to.sock.once('drain', () => {
      if (!from.sock.destroyed) from.sock.resume();
    });
  }
}

function closeCircuit(circuit, why) {
  if (!circuit || circuit.dead) return;
  circuit.dead = true;
  circuits.delete(circuit);
  log(
    `[circuit] 结束 #${circuit.a.id}+#${circuit.b.id} ch=${circuit.a.ch.slice(0, 8)}… ` +
      `上行=${circuit.up}B 下行=${circuit.down}B 原因=${why}`,
  );
  for (const c of [circuit.a, circuit.b]) dropConn(c);
}

/** 单条连接的退出：摘等待槽、断 socket。计数只减一次。 */
function dropConn(c) {
  clearTimer('waitTimer', c);
  clearTimer('helloTimer', c);
  if (c.ch && waiting.get(c.ch) === c) waiting.delete(c.ch);
  c.circuit = null;
  if (!c.countedDown) {
    c.countedDown = true;
    stats.clients--;
  }
  if (!c.sock.destroyed) c.sock.destroy();
}

const server = net.createServer((sock) => {
  stats.accepted++;
  const id = ++connSeq;
  if (stats.clients >= MAX_CLIENTS) {
    stats.rejected++;
    log(`[reject] #${id} E_MAX_CLIENTS 连接数已达上限`);
    sock.destroy();
    return;
  }
  stats.clients++;
  sock.setNoDelay(true); // 长度前缀的小帧撞上 Nagle + 延迟确认 = 聊天发涩
  sock.setKeepAlive(true, 30_000);

  const c = {
    id,
    sock,
    phase: 'hello',
    head: [],
    headLen: 0,
    pending: [],
    pendingLen: 0,
    ch: null,
    other: null,
    circuit: null,
    waitTimer: null,
    countedDown: false,
    helloTimer: setTimeout(() => {
      if (c.phase === 'hello') reject(c, 'E_HELLO_TIMEOUT', '首行超时');
    }, HELLO_TIMEOUT_MS),
  };

  // 一个监听器负责三个阶段，靠 phase 分支 —— 避免「摘了首行的监听器、忘了装转发的」
  // 这类配对竞态：首行、等待期字节、转发期字节可能挤在同一个 tick 里到达。
  sock.on('data', (chunk) => {
    if (c.phase === 'hello') return onHello(c, chunk);
    if (c.phase === 'waiting') {
      c.pending.push(chunk);
      c.pendingLen += chunk.length;
      if (c.pendingLen > PENDING_MAX) reject(c, 'E_PENDING_OVERFLOW', '等待期暂存超限');
      return;
    }
    forward(c, c.other, chunk);
  });
  const gone = (why) => (c.circuit ? closeCircuit(c.circuit, why) : dropConn(c));
  sock.on('end', () => gone('eof'));
  sock.on('close', () => gone('closed'));
  sock.on('error', () => gone('io-error'));
});

/** 首行阶段：按 Buffer 累积，找到 \n 才解码头部（按字符串切会把多字节字符切断）。 */
function onHello(c, chunk) {
  const nl = chunk.indexOf(LF);
  if (nl < 0) {
    c.head.push(chunk);
    c.headLen += chunk.length;
    if (c.headLen > MAX_LINE) reject(c, 'E_LINE_TOO_LONG', '首行超长');
    return;
  }
  c.head.push(chunk.subarray(0, nl));
  const headBuf = Buffer.concat(c.head);
  c.head = [];
  clearTimer('helloTimer', c);
  // 换行落在后续 chunk 时，上面那条"无换行才检查"的路径没覆盖到，这里补上：
  // 承诺是整行 ≤256 字节，就不能只在其中一半路径上生效。
  if (headBuf.length > MAX_LINE) return reject(c, 'E_LINE_TOO_LONG', '首行超长');
  const head = headBuf.toString('utf8').replace(/\r$/, '');
  // 同一 chunk 里首行之后的字节属于电路载荷，必须留到配对后按序写出。
  const rest = chunk.subarray(nl + 1);
  if (rest.length) {
    c.pending.push(rest);
    c.pendingLen += rest.length;
    // 首行和第一批载荷挤在同一个包里是常态（客户端拿到"能发了"就乐观开讲），
    // 不在这里查一次的话，PENDING_MAX 就不是硬上界。
    if (c.pendingLen > PENDING_MAX) return reject(c, 'E_PENDING_OVERFLOW', '等待期暂存超限');
  }
  acceptHello(c, head);
}

function acceptHello(c, head) {
  const parts = head.split(' ');
  const [magic, token, ch] = parts;
  const ok =
    parts.length === 3 &&
    magic === MAGIC &&
    /^[0-9a-f]{64}$/.test(ch ?? '') &&
    tokenOk(token ?? '');
  if (!ok) {
    reject(c, 'E_BAD_HELLO', '首行非法（协议版本 / token / 通道哈希格式）');
    return;
  }
  c.ch = ch;
  const peer = waiting.get(ch);
  if (peer && peer !== c && !peer.sock.destroyed && peer.sock.writable) {
    pair(peer, c);
    return;
  }
  if (peer && peer !== c) {
    // 旧等待者已不健康：让位给本连接，旧的由自己的超时清理。
    clearTimer('waitTimer', peer);
    waiting.delete(ch);
  }
  c.phase = 'waiting';
  c.waitedSince = Date.now();
  waiting.set(ch, c);
  c.waitTimer = setTimeout(() => {
    if (waiting.get(c.ch) === c) {
      waiting.delete(c.ch);
      log(`[wait] #${c.id} E_WAIT_TIMEOUT 对端未出现，放弃 ch=${c.ch.slice(0, 8)}…`);
      dropConn(c);
    }
  }, WAIT_TIMEOUT_MS);
}

// 空闲清理：半开电路、卡死的等待槽。
setInterval(() => {
  const now = Date.now();
  for (const circuit of [...circuits]) {
    if (now - circuit.last > IDLE_TIMEOUT_MS) closeCircuit(circuit, 'idle');
  }
  for (const [ch, c] of [...waiting]) {
    if (now - (c.waitedSince ?? now) > WAIT_TIMEOUT_MS) {
      waiting.delete(ch);
      // 兜底路径：正常由 waitTimer 先触发；走到这里说明定时器没按时跑，留个码好查。
      log(`[wait] #${c.id} E_WAIT_TIMEOUT 等待槽超时（清扫）ch=${ch.slice(0, 8)}…`);
      dropConn(c);
    }
  }
}, Math.min(30_000, IDLE_TIMEOUT_MS)).unref();

if (process.env.STATS !== '0') {
  setInterval(() => {
    log(
      `[stats] 客户端=${stats.clients} 电路=${circuits.size} 等待槽=${waiting.size}｜` +
        `累计 接入=${stats.accepted} 配对=${stats.paired} 拒绝=${stats.rejected} ` +
        `搬运=${Math.round(stats.bytes / 1024)}KiB`,
    );
  }, 60_000).unref();
}

// 监听失败（端口被占 / 越界 / 权限不足）过去是未捕获的 'error' 事件 ⇒ Node 裸栈，
// 在 PM2 下变成难读的崩溃循环。这里给一行能照着修的话。
server.on('error', (err) => {
  console.error(`[gosslan-relay] 监听 ${HOST}:${PORT} 失败：${err.code ?? err.message}`);
  console.error('  端口被占用、超出 0–65535，或当前用户无权绑定。改 PORT 或腾出端口。');
  process.exit(3);
});

server.listen(PORT, HOST, () => {
  log(
    `[gosslan-relay] 监听 ${HOST}:${PORT}｜上限 ${MAX_CLIENTS} 连接｜` +
      `首行 ${HELLO_TIMEOUT_MS}ms｜等待 ${WAIT_TIMEOUT_MS}ms｜空闲 ${IDLE_TIMEOUT_MS}ms`,
  );
  log('[gosslan-relay] 不解析载荷、不写任何文件；进程退出即清空全部状态。');
});

// ── 可选健康检查端点（HEALTHZ_PORT 不设 = 不启用） ─────────────────────────
// 比 `nc -z` 多证明一件事：进程的事件循环还活着、配对表还在工作内存里。
// 只回聚合计数（与 [stats] 行同源），不回任何通道哈希/载荷；默认只绑回环。
const VERSION = (() => {
  try {
    return JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')).version;
  } catch {
    return 'unknown'; // Docker 镜像若没带 package.json，版本号缺不了大局
  }
})();
let healthServer = null;
if (HEALTHZ_PORT > 0) {
  healthServer = http.createServer((req, res) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { allow: 'GET, HEAD' }).end();
      return;
    }
    // 按 pathname 匹配：/healthz 可带查询串；/ 与其它路径一律 404（未文档化的路径不开口子）。
    let path = '';
    try {
      path = new URL(req.url, 'http://127.0.0.1').pathname;
    } catch {
      // 非法 URL 当未知路径处理
    }
    if (path !== '/healthz') {
      res.writeHead(404).end();
      return;
    }
    const body = JSON.stringify({
      ok: true,
      name: 'gosslan-relay',
      version: VERSION,
      protocol: MAGIC,
      uptime_s: Math.round(process.uptime()),
      clients: stats.clients,
      circuits: circuits.size,
      waiting: waiting.size,
      totals: {
        accepted: stats.accepted,
        paired: stats.paired,
        rejected: stats.rejected,
        bytes: stats.bytes,
      },
    });
    res.writeHead(200, { 'content-type': 'application/json' }).end(req.method === 'HEAD' ? undefined : body);
  });
  healthServer.on('error', (err) => {
    // 健康端点起不来不该拖死中继本体：留一行能查的话，继续跑。
    console.error(
      `[gosslan-relay] 健康端点监听 ${HEALTHZ_HOST}:${HEALTHZ_PORT} 失败：${err.code ?? err.message}（中继功能不受影响）`,
    );
    healthServer = null;
  });
  healthServer.listen(HEALTHZ_PORT, HEALTHZ_HOST, () => {
    log(`[gosslan-relay] 健康检查 http://${HEALTHZ_HOST}:${HEALTHZ_PORT}/healthz`);
  });
}

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    log(`[gosslan-relay] ${sig}，清理后退出`);
    for (const circuit of [...circuits]) closeCircuit(circuit, 'shutdown');
    for (const c of [...waiting.values()]) dropConn(c);
    if (healthServer) healthServer.close();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 2_000).unref();
  });
}
