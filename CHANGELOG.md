# Changelog

本仓库所有值得记录的变更。版本号遵循 semver：
`feat` → minor，`fix`（含安全加固）→ patch，`docs`/`test` → patch。
一 issue 一 commit 一版本。

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
