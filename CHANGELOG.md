# Changelog

本仓库所有值得记录的变更。版本号遵循 semver：
`feat` → minor，`fix`（含安全加固）→ patch，`docs`/`test` → patch。
一 issue 一 commit 一版本。

## [1.2.1] - 2026-11-03

### Added

- 协议共享 fixture 与对照测试（对治 ADR-0020 自述的"漂移了不会有测试提醒"）：
  - `protocol.fixtures.json`：字节级真值向量（epoch_day / 通道哈希 / 协商签名
    材料 / GSRW1 Ed25519 签名 / X25519 DH / 双向记录密钥 / 记录层密文 / 首行
    正例与 8 个负例）。由主仓实现（`relay_seal.rs` / `relay.rs`，commit
    973b4df3）的同版本 crate 生成；生成器源码在 `fixtures/generator/`，
    重新生成与已提交向量逐字节一致（确定性已验证）。
  - `protocol_conformance.mjs`（`npm run conformance`）：用 Node 内置加密独立
    重算全部向量并比对，再拿 fixture 首行真打 `server.mjs`（15/15 通过）。
    首次把"签名材料是 serde_json 元组、域前缀按数字数组序列化"这一文档未写的
    字节形态钉成向量。
  - 不改任何运行时行为；主仓侧消费方式与 Rust 测试骨架写入 INTEGRATION §10。

## [1.2.0] - 2026-11-03

### Added

- 可选健康检查端点：`HEALTHZ_PORT` 设置后，`GET /healthz` 返回运行指标 JSON
  （ok/version/protocol/uptime_s/clients/circuits/waiting/totals，与 `[stats]`
  行同源的聚合计数，不含通道哈希与载荷）。`HEALTHZ_HOST` 默认 `127.0.0.1`。
  比 `nc -z` 多证明事件循环与配对表还活着。不设 = 不启用，中继主协议零影响。
  PM2 配置与 Docker 镜像默认启用（容器内回环 59994），Dockerfile HEALTHCHECK
  由 `nc -z` 升级为 wget 真探测；systemd 单元给出可选注释行。
- `selftest.mjs` 新增健康端点用例（200/指标/404，11/11 通过）。

### Fixed

- `PORT=999999`（正整数但越界）此前会以未捕获的 `ERR_SOCKET_BAD_PORT` 裸栈崩掉
  —— `envInt` 注释声称已修，实测没有。现在 `envInt` 支持上界，`PORT` 按 ≤65535
  校验，越界回落默认值并打一行能照着修的话（2026-11-03 实测复现并验证修复）。

## [1.1.0] - 2026-11-03

### Added

- 日志稳定错误码与连接序号：`[reject]` / `[wait]` 行带 `E_*` 码
  （`E_MAX_CLIENTS` / `E_HELLO_TIMEOUT` / `E_LINE_TOO_LONG` / `E_BAD_HELLO` /
  `E_PENDING_OVERFLOW` / `E_WAIT_TIMEOUT`），所有事件行带连接序号 `#N`，
  配对/结束行以 `#a+#b` 关联电路两端。监控可按码 grep，并发下可把行对到同一连接。
  README 新增「日志错误码」对照表。
- 不改变对客户端的契约：错误码只进服务器日志，客户端可见行为仍只有关闭时机。
  `selftest.mjs` 为四类拒绝/超时场景补了"必须出现对应错误码"的断言（10/10 通过）。

## [1.0.1] - 2026-11-03

### Security

- 非回环弱口令拒绝启动：`TOKEN` 短于 16 字符且 `HOST` 不是回环地址时以退出码 2 拒绝启动；
  回环绑定（`127.0.0.1` / `localhost` / `::1`）放行但打警告，仅供本机联调。
  背景：弱口令在公网上撑不住离线字典，而中继此前只查口令非空、不查强度。
  不改变任何客户端可见行为；**已在公网用弱口令的部署升级后将无法启动**，
  先换 `openssl rand -hex 16` 生成的强口令再升级。
  `selftest.mjs` 新增对应闸门用例（10/10 通过）。
