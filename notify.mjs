/**
 * 极简通知器（v7，2026-11-17）
 *
 * 像 ntfy / Bark 一样：**认证与路由全在 URL**，GET / POST / PUT 都能发。
 *
 *   GET  /publish/<send_token>?text=构建完成&title=CI
 *   POST /publish/<send_token>        body: 纯文本 或 {"text":"…"}
 *   PUT  /publish/<send_token>        同上
 *   GET  /pull/<client_token>?limit=20
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

  // DELETE /v1/bots/<send_token> → 撤销（删记录 ⇒ 旧 hook 立即 401）
  if (req.method === 'DELETE' && parts.length === 3 && parts[0] === 'v1' && parts[1] === 'bots') {
    const token = parts[2];
    if (!bots[token]) return json(res, 404, { error: 'not_found' });
    delete bots[token];
    // 同时清掉该 bot 未取走的事件（不再可达 ⇒ 留着只是膨胀）。
    for (const [id, ev] of Object.entries(events)) if (ev.bot === token) delete events[id];
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
    saveEvents();
    return json(res, 200, { ok: true, id });
  }

  // GET /pull/<client_token> → 取件（不删，等 ack）
  if (req.method === 'GET' && parts[0] === 'pull' && parts.length === 2) {
    const bot = Object.values(bots).find((b) => b.client_token === parts[1]);
    if (!bot) return json(res, 401, { error: 'bad_token' });
    sweepNotify();
    const limit = Math.min(MAX_PULL, Number(url.searchParams.get('limit')) || MAX_PULL);
    const list = Object.values(events).filter((e) => e.bot === bot.token).slice(0, limit);
    return json(res, 200, { events: list });
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
