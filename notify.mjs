/**
 * 极简通知器（v7，2026-11-17）
 *
 * 像 ntfy / Bark 一样：**认证与路由全在 URL**，GET / POST / PUT 都能发。
 *
 *   GET  /publish/<send_token>?text=构建完成&title=CI
 *   POST /publish/<send_token>        body: 纯文本 或 {"text":"…"}
 *   PUT  /publish/<send_token>        同上
 *   GET  /pull/<client_token>?limit=20&wait=15  （wait = 长轮询，新消息立即返回）
 *   GET  /ack/<client_token>/<event_id>
 *   GET  /healthz                     （保留原健康端点）
 *
 * ## 设计取舍（用户 2026-11-17 明确要求）
 * - **一个进程**：本模块不 listen，由 server.mjs 把请求转进来 ⇒ 一个 PM2 条目。
 * - **复用端口**：沿用 server.mjs 的 HEALTHZ_PORT（默认 59994），不再开 59995。
 * - **简单**：token 在 URL、明文存配置、无 Authorization 头、无幂等键、无租约重投。
 *   ⚠️ 安全性因此下降（token 会进访问日志）——这是用户明确的产品取舍。
 *
 * ## 仍然保留的可靠性（用户的重点）
 * - **离线留存**：事件落盘 queue.json，默认保留 7 天；上线取件后 ack 删除。
 * - **不膨胀**：队列硬上限（默认 10000），满了明确 503；到期事件定期物理删除。
 * - 群机器人消息以**真群消息**发进群 ⇒ 后来者从群历史同步拿到（服务端不为每人存副本）。
 */

import fs from 'node:fs';
import path from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';

const DATA_DIR = process.env.WEBHOOK_DATA_DIR ?? path.join(process.cwd(), 'webhook-data');
const QUEUE_FILE = path.join(DATA_DIR, 'notify-queue.json');
const BOTS_FILE = path.join(DATA_DIR, 'notify-bots.json');
/** 未送达事件留存期（用户离线可达窗口）：默认 7 天。 */
const TTL_MS = envInt('NOTIFY_TTL_MS', 7 * 24 * 3600 * 1000);
/** 全服事件硬上限：满了 503 背压，不静默丢。 */
const MAX_EVENTS = envInt('NOTIFY_MAX_EVENTS', 10000);
/** 单次 pull 最多给多少条。 */
const MAX_PULL = envInt('NOTIFY_PULL_MAX', 50);

function envInt(name, dflt, max = Infinity) {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 && n <= max ? Math.floor(n) : dflt;
}

function atomicWrite(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2));
  fs.renameSync(tmp, file);
}
function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

/**
 * 长轮询等待者（2026-11-17）：客户端 pull 可带 `?wait=15`，队列空时挂起，
 * 第三方一发消息就**立即唤醒返回**（近实时），不必等满 60s 轮询间隔。
 * 不新建连接、不动 TCP 盲中继（Frozen），只是让已有 HTTP 请求多等一会儿。
 */
const waiters = new Set();

function wakeWaiters(sendToken) {
  for (const w of [...waiters]) {
    if (w.sendToken !== sendToken) continue;
    // 统一走 waiter 自带的清理：摘 Set / 清 timer / 摘 res 的 close 监听。
    w.cleanup();
    w.resolve();
  }
}

/** bots: token -> { token, client_token, name, scope, group_id?, created_at } */
let bots = readJson(BOTS_FILE, {});
/** queue: event_id -> { id, bot, text, title, format, ts } */
let events = readJson(QUEUE_FILE, {});

function saveBots() { atomicWrite(BOTS_FILE, bots); }
function saveEvents() { atomicWrite(QUEUE_FILE, events); }

/** 清理过期事件（定期 + 每次 pull 触发）。 */
export function sweepNotify() {
  const now = Date.now();
  let changed = false;
  for (const [id, ev] of Object.entries(events)) {
    if (now - ev.ts > TTL_MS) {
      delete events[id];
      changed = true;
    }
  }
  if (changed) saveEvents();
  return changed;
}

/** 定期清理定时器（由 server.mjs 调用；unref 不吊住进程）。 */
export function startNotifySweeper() {
  const t = setInterval(() => { try { sweepNotify(); } catch { /* 清理失败不影响主路 */ } }, 60_000);
  if (typeof t.unref === 'function') t.unref();
  return t;
}

function json(res, code, body) {
  const text = JSON.stringify(body);
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' }).end(text);
}

/** 从 URL / body 里取通知正文。 */
async function readText(req, url) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const raw = Buffer.concat(chunks).toString('utf8').trim();
  if (raw) {
    try {
      const o = JSON.parse(raw);
      if (o && typeof o.text === 'string') {
        return {
          text: o.text,
          title: typeof o.title === 'string' ? o.title : '',
          format: o.format === 'markdown' ? 'markdown' : 'text',
          // 群机器人管理指令（2026-11-17）：服务端只**透传**，白名单校验在客户端。
          // 限制为纯 JSON 对象 + 小尺寸，避免外部塞超大树占内存。
          action: o.action && typeof o.action === 'object' && !Array.isArray(o.action)
            && JSON.stringify(o.action).length <= 2048 ? o.action : null,
        };
      }
    } catch { /* 纯文本 body */ }
    return { text: raw, title: url.searchParams.get('title') ?? '', format: url.searchParams.get('format') === 'markdown' ? 'markdown' : 'text', action: null };
  }
  return {
    text: url.searchParams.get('text') ?? '',
    title: url.searchParams.get('title') ?? '',
    format: url.searchParams.get('format') === 'markdown' ? 'markdown' : 'text',
    action: null,
  };
}

/**
 * 处理通知 HTTP 请求。返回 true = 本模块已处理；false = 不是通知路径，交给 healthz/404。
 */
export async function handleNotify(req, res) {
  let url;
  try { url = new URL(req.url, 'http://127.0.0.1'); } catch { return false; }
  const parts = url.pathname.split('/').filter(Boolean);

  // POST /v1/bots → 建机器人（服务端生成两把 token，明文存）
  if (req.method === 'POST' && parts.length === 2 && parts[0] === 'v1' && parts[1] === 'bots') {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    let body = {};
    try { body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); } catch { return json(res, 400, { error: 'bad_json' }); }
    const sendToken = randomBytes(24).toString('base64url');
    const clientToken = randomBytes(24).toString('base64url');
    const scope = body.scope === 'group' ? 'group' : 'personal';
    if (scope === 'group' && !String(body.group_id ?? '').trim()) {
      return json(res, 400, { error: 'group_id_required' });
    }
    bots[sendToken] = {
      token: sendToken,
      client_token: clientToken,
      name: String(body.name ?? '机器人').slice(0, 60),
      scope,
      group_id: scope === 'group' ? String(body.group_id).trim().slice(0, 120) : '',
      created_at: Date.now(),
    };
    saveBots();
    return json(res, 201, {
      send_token: sendToken,
      client_token: clientToken,
      publish_url: `/publish/${sendToken}`,
    });
  }

  // DELETE /v1/bots/<send_token | client_token> → 撤销（删记录 ⇒ 旧 hook 立即 401）
  //
  // 2026-11-17 修「删除机器人失败」：客户端的 BotRecord **不存 send_token**（创建时只回显
  // 一次，之后没有落库），此前客户端误传 bot_id ⇒ 这里按 bots[bot_id] 查不到、恒 404。
  // 现在同时接受 client_token —— 它是客户端一直持有的取件凭证，旧机器人记录也能撤销。
  if (req.method === 'DELETE' && parts.length === 3 && parts[0] === 'v1' && parts[1] === 'bots') {
    const token = parts[2];
    const key = bots[token]
      ? token
      : Object.keys(bots).find((k) => bots[k].client_token === token);
    if (!key) return json(res, 404, { error: 'not_found' });
    const sendToken = bots[key].token; // 事件按 send_token 归属（见 publish 入队）
    delete bots[key];
    // 同时清掉该 bot 未取走的事件（不再可达 ⇒ 留着只是膨胀）。
    for (const [id, ev] of Object.entries(events)) if (ev.bot === sendToken) delete events[id];
    // 撤销即唤醒：挂在这个 hook 上的长轮询立刻重新鉴权拿 401，不空等满 15s。
    wakeWaiters(sendToken);
    saveBots(); saveEvents();
    return json(res, 200, { ok: true });
  }

  // GET/POST/PUT /publish/<send_token> → 入队
  if (['GET', 'POST', 'PUT'].includes(req.method) && parts[0] === 'publish' && parts.length === 2) {
    const bot = bots[parts[1]];
    if (!bot) return json(res, 401, { error: 'bad_token' });
    const { text, title, format, action } = await readText(req, url);
    if (!text) return json(res, 400, { error: 'text_required' });
    sweepNotify();
    if (Object.keys(events).length >= MAX_EVENTS) {
      return json(res, 503, { error: 'queue_full' });
    }
    const id = randomUUID();
    events[id] = { id, bot: bot.token, text: text.slice(0, 8192), title, format, action, ts: Date.now() };
    // 先落盘再对外报成功：写盘失败要回滚内存，否则「内存有、盘上没有」= 进程重启即丢，
    // 且等待者被叫醒后 pull 到的是一条重启就没的事件（半持久化）。失败不发 200、不唤醒。
    try {
      saveEvents();
    } catch (e) {
      delete events[id];
      return json(res, 503, { error: 'persist_failed' });
    }
    wakeWaiters(bot.token); // 挂起的 pull 立即拿到这条 ⇒ 远小于轮询间隔
    return json(res, 200, { ok: true, id });
  }

  // GET /v1/bot/<client_token> → 取回发送链接（兼容旧客户端：早期 BotRecord 没存 publish_url）
  if (req.method === 'GET' && parts.length === 3 && parts[0] === 'v1' && parts[1] === 'bot') {
    const bot = Object.values(bots).find((b) => b.client_token === parts[2]);
    if (!bot) return json(res, 404, { error: 'not_found' });
    return json(res, 200, { send_token: bot.token, publish_url: `/publish/${bot.token}` });
  }

  // GET /pull/<client_token>?wait=<秒> → 取件（不删，等 ack）
  // `wait` = 长轮询：队列空时挂起，新消息入队立即返回（上限 15s，须小于客户端 HTTP 超时）。
  if (req.method === 'GET' && parts[0] === 'pull' && parts.length === 2) {
    const bot = Object.values(bots).find((b) => b.client_token === parts[1]);
    if (!bot) return json(res, 401, { error: 'bad_token' });
    sweepNotify();
    // 显式的正整数校验：`|| MAX_PULL` 会让 limit=0 变成 50、limit=-5 变成 slice(0,-5)（取「除末 5 条外」）。
    // 非法/缺省一律回落默认上限；合法值再夹到 MAX_PULL。
    const rawLimit = Number(url.searchParams.get('limit'));
    const limit = Number.isFinite(rawLimit) && rawLimit > 0
      ? Math.min(MAX_PULL, Math.floor(rawLimit))
      : MAX_PULL;
    const collect = () => Object.values(events).filter((e) => e.bot === bot.token).slice(0, limit);
    const waitSec = Math.min(15, Math.max(0, Number(url.searchParams.get('wait')) || 0));
    if (waitSec > 0 && collect().length === 0) {
      const w = { sendToken: bot.token, resolve: null, timer: null, closed: false, aborted: false };
      await new Promise((resolve) => {
        w.resolve = resolve;
        // 统一清理：从等待集合摘除 + 停表 + 摘掉 res 监听，避免断连后 waiter 滞留到超时。
        w.cleanup = () => {
          if (w.closed) return;
          w.closed = true;
          waiters.delete(w);
          clearTimeout(w.timer);
          res.off('close', onClose);
        };
        const onClose = () => { w.aborted = true; w.cleanup(); resolve(); }; // 客户端断开 ⇒ 立即结束等待，别空挂满 15s
        w.timer = setTimeout(() => { w.cleanup(); resolve(); }, waitSec * 1000);
        res.once('close', onClose);
        waiters.add(w);
      });
      // 客户端断开 ⇒ 不再写响应（close 事件里已置 aborted）：此时 Socket 已走，再 writeHead 会抛
      // 「Cannot write headers after they are sent」。直接认领掉这条请求即可。
      if (w.aborted || res.destroyed || res.writableEnded) return true;
      // 等待期间机器人可能被撤销 ⇒ 重新鉴权，别拿旧快照回包。
      if (!Object.values(bots).find((b) => b.client_token === parts[1])) {
        return json(res, 401, { error: 'bad_token' });
      }
    }
    return json(res, 200, { events: collect() });
  }

  // GET /ack/<client_token>/<event_id> → 确认后删除
  if (req.method === 'GET' && parts[0] === 'ack' && parts.length === 3) {
    const bot = Object.values(bots).find((b) => b.client_token === parts[1]);
    if (!bot) return json(res, 401, { error: 'bad_token' });
    const ev = events[parts[2]];
    if (ev && ev.bot === bot.token) {
      delete events[parts[2]];
      saveEvents();
    }
    return json(res, 200, { ok: true });
  }

  return false;
}

/** 给 healthz 用：队列状态摘要。 */
export function notifyStats() {
  return { bots: Object.keys(bots).length, queued: Object.keys(events).length };
}

/** 仅供自测清理。 */
export function resetNotifyForTest() {
  bots = {};
  events = {};
  saveBots();
  saveEvents();
}
