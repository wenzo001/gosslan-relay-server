# legacy/ —— v6 Webhook 服务的留档（**不要部署**）

这里的东西**都不在现役链路上**。它们被移进来是为了两件事：
① 保留历史实现与它的接口文档，方便对照 v7 少了什么；
② 让「服务端有哪几套自测」这件事不再含糊 —— 现役的自测都在仓库根，
这两个在 `legacy/` 里，跑出来的绿**不算现役证据**。

## 为什么归档（2026-11-18）

v7（2026-11-17 用户拍板）把通知服务压成「一个进程、一条 curl」：

| | v6（本目录） | v7（现役） |
|---|---|---|
| 入口 | 独立进程 `webhook.mjs` / 端口 59995 | 复用 `server.mjs` 的 HTTP 端点 / 59994 |
| 发送 | `POST /v1/bots/<id>/events` + header + HMAC | `GET/POST/PUT /publish/<send_token>` |
| 取件 | 带签名头的长轮询 | `GET /pull/<client_token>` |
| 可靠性 | 幂等键 + 租约重投 | 落盘 7 天 + ack 删除（**明确去掉**幂等与租约） |
| 图片 | 下载 / 校验 / 渲染 | 服务端仍收元数据，客户端明说不支持 |

`server.mjs` 的注释与 `README-v7-notify.md` 都写着「不再单独起 webhook.mjs」。
归档前它在仓库根还有 `npm run start:webhook` / `selftest:webhook` 两个入口，
而**它的两套自测（17 + 2 条）会跑绿** —— 谁跑到都会以为「服务端测试全过」，
实际上测的是一个不部署的模块。这是 2026-11-18 测试体系审查抓到的过时漂移，
处理方式就是移到本目录、从 `package.json` 摘掉入口。

## 现役的在哪里

| 现役自测 | 说明 |
|---|---|
| `../selftest.mjs` | 盲 TCP 中继自身行为（配对 / 回收 / 上限 / 闸门） |
| `../notify-selftest.mjs` | **v7 通知服务**（三方法 / 离线留存 / ack / TTL / 上限 / 长轮询 / limit 边界 / 断连 / 撤销唤醒 / 无二次写） |
| `../notify-persist-selftest.mjs` | 写盘失败必须回滚且不假装成功 |
| `../protocol_conformance.mjs` | 协议 fixture 对照（漂移即红） |

后三套都在 `.github/workflows/ci.yml` 里；本目录这两套**故意不在**。

## 如果只是想跑一次看看（历史对照，不进任何门禁）

```bash
node legacy/webhook-selftest.mjs
node legacy/webhook-memory-selftest.mjs
```

两者都会 `spawn` 本目录的 `webhook.mjs`，用 59995 端口与自己的临时数据目录。
它们绿了**不能**用来证明现役通知服务没问题 —— 那是 `notify-selftest.mjs` 的事。
