# 极简通知服务（v7）：一个进程、一条 curl

> 用户 2026-11-17 决定：中转服务器**一个进程、一个 PM2 条目、复用现有端口**；
> 协议像 ntfy / Bark 一样简单；认证放 URL；GET/POST/PUT 都兼容；重点是**稳定可达**。

## 一句话

```bash
pm2 start ecosystem.config.cjs     # 只有一个进程：server.mjs
curl "http://你的服务器:59994/publish/<send_token>?text=构建完成"
```

就这两步。外部系统只要一条 curl，不需要任何请求头、不需要 SDK。

## 端口与进程

| 端口 | 协议 | 用途 |
|---|---|---|
| 59993 | 裸 TCP（GSRL1） | **盲中继**，好友/群通信用；v7 一字未动 |
| 59994 | HTTP | **通知 API + /healthz**（复用原健康端口，现在对外） |

一个 `server.mjs` 同时开这两个端口 ⇒ PM2 只有 `gosslan-relay` 一个条目。

## 三种发送方式（都一样）

```bash
# GET：参数放 URL
curl "http://host:59994/publish/<token>?text=构建完成&title=CI"

# POST：纯文本 body
curl -X POST "http://host:59994/publish/<token>" -d "构建完成"

# PUT：JSON body
curl -X PUT "http://host:59994/publish/<token>" \
  -H 'Content-Type: application/json' \
  -d '{"text":"## 构建完成","format":"markdown"}'
```

成功返回 `{"ok":true,"id":"..."}`（200）。

## 客户端取件

```bash
curl "http://host:59994/pull/<client_token>?limit=20"
curl "http://host:59994/ack/<client_token>/<event_id>"   # 确认后服务端删除
```

**长轮询（快速送达，2026-11-17）**：取件可带 `?wait=15`——队列空时服务端把请求挂起，
新消息一到**立即唤醒返回**（最多挂 15 秒），不用等下一个轮询周期。
Gosslan 客户端后台取件就带这个参数，所以外部发一条 curl 后通常是**秒级**收到；
手动点「立即取件」不带 wait，仍是即时返回。

```bash
curl "http://host:59994/pull/<client_token>?wait=15"
```

## 机器人管理

```bash
# 创建（两把 token 由服务端生成）
curl -X POST "http://host:59994/v1/bots" \
  -H 'Content-Type: application/json' \
  -d '{"name":"CI 通知","scope":"personal"}'
# → {"send_token":"…","client_token":"…","publish_url":"/publish/…"}

# 撤销（hook 立即失效，未取走的消息一起清掉）
curl -X DELETE "http://host:59994/v1/bots/<send_token>"
# 也接受 client_token —— 客户端不存 send_token，删除机器人时用它在服务端撤销
```

## 可靠性与边界（诚实）

- **离线可达**：未取走的通知存 `webhook-data/notify-queue.json`，默认保留 **7 天**
  （`NOTIFY_TTL_MS`）。人不在线没关系，上线打开应用自动轮询取到；
  客户端用长轮询（`wait=15`），在线时新通知**秒级**送达（不是等 60 秒轮询）。
- **不膨胀**：全服上限 `NOTIFY_MAX_EVENTS`（默认 10000），满了返回 503（不静默丢）；
  过期事件每 60 秒物理删除。
- **群机器人**：通知以**真群消息**发进群（带 `【机器人名】` 前缀），
  当时不在线的成员之后通过**群历史同步**拿到 ⇒ 服务端不为每个成员存副本。
- **简化代价（用户明确接受）**：token 在 URL（会进访问日志），无幂等键、无租约重投、
  token 明文存配置 ⇒ **安全性低，适合可信网络/内网**。公网请放 HTTPS 反代并给
  `Authorization`/查询串脱敏，或限制来源 IP。
- 旧 v6 协议（`/v1/hooks/...` + header + HMAC）**已删除，不兼容**；v6 机器人需重建。
- `webhook.mjs` / `WEBHOOK_PORT=59995` 不再使用（源码保留作历史，不部署）。

## 环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `PORT` | 59993 | 盲中继 TCP 端口（不变） |
| `HEALTHZ_PORT` | 59994 | **HTTP 通知 API + 健康端点** |
| `HEALTHZ_HOST` | 0.0.0.0 | HTTP 绑定地址 |
| `NOTIFY_TTL_MS` | 604800000 | 未送达消息保留期（7 天） |
| `NOTIFY_MAX_EVENTS` | 10000 | 全服队列硬上限 |
| `NOTIFY_PULL_MAX` | 50 | 单次取件上限 |
| `WEBHOOK_DATA_DIR` | ./webhook-data | 队列落盘目录 |

## 自测

```bash
node notify-selftest.mjs    # 8 条：三方法/离线留存/ack/TTL/上限/错误 token
```
