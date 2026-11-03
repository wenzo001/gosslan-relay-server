/**
 * PM2 配置（单台服务器长期运行的推荐形态）。
 *
 * 为什么是 `.cjs`：本目录的 `package.json` 声明了 `"type": "module"`（`server.mjs` 是 ESM），
 * 而 PM2 的配置文件走 `require()`。用 `.cjs` 后缀可以显式压过 `"type": "module"`，
 * 否则 PM2 会报 `require is not defined in ES module scope`。
 *
 * 启动：
 *   npm i -g pm2          # PM2 是部署工具，不是本程序的运行依赖（程序本身零依赖）
 *   pm2 start ecosystem.config.cjs
 *   pm2 save
 *   pm2 startup systemd -u <运行用户> --hp /home/<运行用户>   # 开机自启
 *   pm2 logs gosslan-relay
 * 细节（升级、回滚、日志切割、故障排查）见 README「用 PM2 长期运行」。
 *
 * ## ⚠️ instances 必须是 1，且不得开 cluster 模式
 * 配对用的「通道哈希 → 等待中的连接」这张表是**进程内内存**。cluster 会 fork 出多个
 * worker，各自一张表，而两条客户端连接会被内核算法分到不同 worker ⇒ **永远配不上对**。
 * 故障形态最难查：两端都显示"已连上服务器"，日志也没有任何错误，就是连不成。
 *
 * 单进程够用吗？实测（见 README 实测段）15 条电路搬运 202MiB/s、p50 0.16ms，
 * RSS 55MiB —— 瓶颈在公网 RTT，不在这台进程。真要扩规模，正确做法是**多开几台服务器、
 * 客户端多配一台**，而不是在一台机器上开 cluster。
 */

const fs = require('node:fs');
const path = require('node:path');

/**
 * 口令来源，按优先级：环境变量 TOKEN → /etc/gosslan-relay.env → 同目录 .env。
 * 文件格式就是一行 `TOKEN=xxxx`。
 *
 * ⚠️ 可见性取舍：读到的口令会被放进下面的 env.TOKEN，于是 PM2 会把它保存在进程表里 ——
 * `pm2 describe` 的 env、`pm2 save` 的 dump、进程 environ 都能看到。这是 PM2 部署形态
 * 的既定代价：口令只防"不知道口令的客户端"，不防"能操作 PM2 的本机账号"。收紧措施
 * （限制 pm2 账号、~/.pm2 权限、dump 按密钥对待）见 README「日常运维」。
 */
function readToken() {
  if (process.env.TOKEN) return process.env.TOKEN;
  const candidates = ['/etc/gosslan-relay.env', path.join(__dirname, '.env')];
  for (const file of candidates) {
    if (!fs.existsSync(file)) continue;
    try {
      const line = fs
        .readFileSync(file, 'utf8')
        .split('\n')
        .map((l) => l.trim())
        .find((l) => l.startsWith('TOKEN='));
      if (line) return line.slice('TOKEN='.length).replace(/^["']|["']$/g, '');
    } catch (e) {
      // 典型情况：文件按 README chmod 600 归 root，而 PM2 跑在普通用户下 ⇒ EACCES。
      // 让它成为一句能照着修的话，而不是 PM2 加载配置时一段没人看得懂的抛栈。
      console.error(`[gosslan-relay] 读不到 ${file}（${e.code ?? e.message}）：口令文件须对 PM2 的运行用户可读`);
    }
  }
  // 返回空串 ⇒ server.mjs 以退出码 2 拒绝启动，不会退化成开放代理。
  return '';
}

module.exports = {
  apps: [
    {
      name: 'gosslan-relay',
      script: './server.mjs',
      cwd: __dirname,

      // 单进程 fork：见文件头，这是功能正确性问题，不是性能偏好。
      exec_mode: 'fork',
      instances: 1,

      // 崩溃自动拉起；退避 3s 避免配置错时刷屏重启。
      autorestart: true,
      restart_delay: 3000,
      max_restarts: 20,
      min_uptime: '10s',
      // 内存兜底：正常 RSS 几十 MiB，超阈值即视为泄漏 —— 重启比拖垮整机好。
      max_memory_restart: '160M',
      kill_timeout: 5000, // 留时间给 SIGTERM 处理器把两端电路干净关掉

      env: {
        NODE_ENV: 'production',
        TOKEN: readToken(),
        PORT: '59993',
        HOST: '0.0.0.0',
        MAX_CLIENTS: '128',
        LOG: '1',
        STATS: '1',
        // 健康检查端点（默认只绑回环，供本机探针/监控抓取 /healthz）。
        HEALTHZ_PORT: '59994',
      },

      // 日志只有事件行（接入/配对/拒绝/统计），不含任何载荷。
      out_file: './logs/out.log',
      error_file: './logs/error.log',
      merge_logs: true,
      time: true, // 每行前加时间戳，不依赖 journald 也能看时序
    },
  ],
};
