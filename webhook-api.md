# Webhook 通知服务：外部系统 → Gosslan

> 这份是**接口契约**，给两类人看：
> ① **外部系统**（要往 Gosslan 发通知的人）—— 看 §3、§4；
> ② **客户端实现者**（Gosslan 那一侧）—— 看 §2、§5、§6。
>
> 设计依据见主仓 `docs/notes/webhook-notification-bot-design-2026-11-16.md`。

## 0. 一句话

外部系统用 **HTTP POST** 把文字/图片投给某个**机器人**；服务**持久排队**；
**一个**在线的 Gosslan 设备（网关）来取件，先落本地持久 outbox 再 ACK；
群消息随后由既有群 Mesh/Gossip 扩散给其他成员 —— **其他成员不必连接本服务**。

## 1. 信任模型（先读这段）

| | 盲中继（`server.mjs`） | Webhook 通知服务（`webhook.mjs`） |
|---|---|---|
| 看得到内容吗 | **看不到**（只拼字节管道） | **看得到**（明文） |
| 落盘吗 | **不落**（断开即丢） | **落**（队列 + 图片暂存，直到 TTL） |
| 适合放公网裸奔吗 | 可以（读不到内容） | **不行**（必须 HTTPS 反代后面） |

- 本服务是**自托管**的：运营者能读队列内容 —— 这是已知取舍，**不是端到端加密**。
- 外部发送者只拿到 **bot 级发送密钥**：只能「向这个 bot 提交新消息」+「查这次提交的状态」。
  不能拉取、不能改目标、不能枚举 bot、不能读聊天记录。
- 客户端取件用**另一个密钥**（client secret）—— 外部发送密钥**不能**用来取件。
- 密钥只存 **HMAC-SHA256 摘要**（带服务端 pepper）；日志、诊断与错误响应里都没有它与正文。

## 2. 部署

```bash
# 1) 生成两个必填密钥
openssl rand -hex 16   # → WEBHOOK_CLIENT_TOKEN（客户端注册/取件）
openssl rand -hex 32   # → WEBHOOK_PEPPER（密钥摘要 pepper）

# 2) 起服务（独立进程 · 独立端口；TCP 中继那个进程不用管）
WEBHOOK_CLIENT_TOKEN=… WEBHOOK_PEPPER=… WEBHOOK_PORT=59995 node webhook.mjs
```

生产上建议放在 **HTTPS 反向代理**后面（代理终结 TLS 并**屏蔽/脱敏 `Authorization` 头**）：

```nginx
location /v1/ {
  proxy_pass http://127.0.0.1:59995;
  proxy_set_header Authorization "";   # 脱敏
  client_max_body_size 24m;
}
```

PM2 / systemd 的条目照抄 `ecosystem.config.cjs` 与 `gosslan-relay.service` 的形状，
**加一条独立进程**即可（不要和 TCP 中继混在一个进程里）。

## 3. 外部发送方怎么发

**正文格式**：请求可带 `format`：`text`（默认，纯文本直接显示）或 `markdown`
（客户端按 Markdown 渲染：标题、列表、表格、代码块、引用、链接……）。
其他值一律按 `text` 处理（不猜、不报错）。图片**始终**走 `image[]` 附件，
Markdown 里的远程图片链接**不会**被自动加载。


```bash
# 纯文字
curl -X POST https://your-host/v1/hooks/$BOT_ID/messages \
  -H "Authorization: Bearer $BOT_SECRET" \
  -H "Idempotency-Key: $(uuidgen)" \
  -H "Content-Type: application/json" \
  -d '{"text":"构建 #42 完成 ✅","source":"CI"}'
```

```bash
# 带图片（multipart；可重复 image[]）
curl -X POST https://your-host/v1/hooks/$BOT_ID/messages \
  -H "Authorization: Bearer $BOT_SECRET" \
  -H "Idempotency-Key: $(uuidgen)" \
  -F "text=看图" -F "source=CI" -F "image[]=@shot.png"
```

**响应 `202`**：

```json
{
  "event_id": "evt_…",
  "status": "queued",
  "accepted_at": "2026-11-16T00:00:00Z",
  "status_url": "/v1/hooks/bot_…/messages/evt_…"
}
```

⚠️ **`202` 只代表「已持久入队」**，不代表已到达设备、更不代表已发进群。

**状态码**：`202` 已入队 · `400` 字段错 · `401` 密钥无效/已撤销 · `403` 已暂停 · `413` 超限 ·
`415` 图片类型不支持 · `429` 限流 · `503` 队列/存储不可用。

**查这次提交的状态**：

```bash
curl -H "Authorization: Bearer $BOT_SECRET" \
  https://your-host/v1/hooks/$BOT_ID/messages/$EVENT_ID
# → {"event_id":"evt_…","status":"queued|accepted_by_gateway|expired|failed", …}
```

（只返回状态与时间戳，**不含正文**，也不含群成员、客户端 IP 或别的 bot 的任何信息。）

## 4. 幂等与重试

- 同一个 `Idempotency-Key`（同一 bot 内）重复提交 ⇒ **只入队一条**，
  重复请求返回**第一次的 `event_id`**（带 `duplicate: true`）。
- 网关取件走**租约**：拉走的事件在 `WEBHOOK_LEASE_MS` 内不重复投递；租约到期未 ACK ⇒ **自动重投**。
- 网关 ACK 之后不再投 ⇒ 外部重试不会在 Gosslan 里出现两条。
- 服务重启不丢队列（落盘）；进程崩溃在「写盘前」⇒ 外部收到的是**明确失败**而不是假 202。

## 5. 客户端（网关）接口

鉴权用 **client secret**（`Authorization: Bearer <client_secret>`），
或服务器级 `WEBHOOK_CLIENT_TOKEN`（仅用于注册/管理）。

| 端点 | 用途 |
|---|---|
| `POST /v1/client/bots` | 注册机器人 ⇒ 返回 `bot_id` + **一次性** `send_secret` / `client_secret` |
| `GET  /v1/client/bots` | 列出机器人（不含密钥） |
| `POST /v1/client/bots/{id}/pull` | 取件（最多 N 条 + 租约） |
| `POST /v1/client/bots/{id}/ack` | ACK：`{event_id, durable_receipt}` |
| `POST /v1/client/bots/{id}/nack` | NACK：`{event_id, permanent}`（永久失败或可重试） |
| `POST /v1/client/bots/{id}/heartbeat` | 心跳（活跃状态 + 服务时间） |

**取件顺序（客户端必须照做）**：
1. 收到事件；
2. **先在本地 DB 事务里**写入「事件 ID 唯一记录 + 收件/发送 outbox + 附件引用」；
3. **提交成功后**才 ACK；
4. 提交失败 ⇒ NACK（可重试）⇒ 服务会在租约到期后重投。

⇒ 客户端**必须按 `event_id` 幂等**：重复收到同一事件时返回已有 receipt 并再次 ACK，
不重复显示、不重复入队。

**事件信封**（`schema: gosslan.webhook-message.v1`）：

```json
{
  "schema": "gosslan.webhook-message.v1",
  "event_id": "evt_…",
  "bot_id": "bot_…",
  "created_at": "2026-11-16T00:00:00Z",
  "text": "…",
  "source": "CI",
  "images": [{"attachment_id":"att_…","name":"shot.png","media_type":"image/png","size":1234,"sha256":"…"}]
}
```

调用方**不能**指定 `sender_id` / `device_id` / `conversation_id` / `group_id` / 消息时间顺序
—— 目标由机器人注册配置唯一决定。

## 6. 群投递的语义（客户端要照做）

- 群消息由**网关设备自己**发出（发送者仍是那台 Gosslan 设备），额外带一个
  `source=webhook_bot` + `bot_id` 的来源标记 ⇒ 界面显示「机器人名 · 由某设备代投递」，
  **不得**显示成外部发件人账号。
- 走既有群密钥加密与 Gossip ⇒ 其他成员**不需要**知道 Webhook 地址或密钥。
- 外部服务 ACK 的含义只是「**网关已安全接管**」；**不等于**所有群成员已收到。
  客户端本机另显示 `queued_for_mesh` / `published_to_mesh`。
- 群被删、所有者离群、目标失效 ⇒ **停止投递**，队列保留到期并在界面显示失败，
  **不悄悄改投另一个会话**。

## 7. 限额与状态

| 项 | 默认 | 环境变量 |
|---|---|---|
| 文本上限 | 8 KiB | `WEBHOOK_MAX_TEXT_BYTES` |
| 图片张数 / 单张 | 4 张 / 5 MiB | `WEBHOOK_MAX_IMAGES` / `WEBHOOK_MAX_IMAGE_BYTES` |
| 请求体上限 | 24 MiB | `WEBHOOK_MAX_REQUEST_BYTES` |
| 每 bot 队列深度 | 500 | `WEBHOOK_QUEUE_DEPTH_PER_BOT` |
| 事件保留 | 7 天 | `WEBHOOK_QUEUE_TTL_MS` |
| 租约 | 60s | `WEBHOOK_LEASE_MS` |
| 每 bot 速率 | 60/分钟 | `WEBHOOK_RATE_PER_MIN` |

**状态机**：`queued → leased → accepted_by_gateway`；异常走 `retry → failed / expired`。

## 8. 健康与运维

```bash
curl http://127.0.0.1:59995/healthz
# {"ok":true,"bots":1,"queued":3,"leased":0,"oldest_queued_ms":12000,"storage_writable":true}
```

`storage_writable=false` ⇒ 服务会**拒绝接收**（不返回假 202）。指标不含正文与密钥。

## 9. 自测

```bash
node webhook-selftest.mjs   # 14 条：幂等、租约重投、越权、限流、图片 sniffing、撤销失效、日志无密钥…
```

`server.mjs`（TCP 盲中继）的 fixture 与行为**没有改动** ⇒
`node selftest.mjs` 与 `node protocol_conformance.mjs` 仍按原样跑。
