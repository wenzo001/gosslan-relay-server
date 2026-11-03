# Gosslan 公网中转（哑管道）
#
# 零依赖 ⇒ 镜像里只有 Node 运行时本身，没有 npm install、没有 node_modules。
# 构建：docker build -t gosslan-relay .
# 运行：docker run -d --name gosslan-relay -p 59993:59993 \
#          -e TOKEN="$(openssl rand -hex 16)" --restart unless-stopped gosslan-relay
# （健康端点只在容器内使用，默认绑 127.0.0.1，不需要对外发布 59994。）
FROM node:22-alpine

WORKDIR /app
COPY server.mjs ./
# /healthz 要报版本号；缺了它只会报 unknown，不影响运行。
COPY package.json ./
# 非 root 运行：这个进程不需要也不应该有任何写权限。
USER node

EXPOSE 59993
# 容器形态默认启用健康端点（仅容器内回环）。
ENV HEALTHZ_PORT=59994
# busybox 的 wget 做真探测：比 `nc -z` 多证明事件循环与配对表还活着。
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s \
  CMD wget -qO- "http://127.0.0.1:${HEALTHZ_PORT}/healthz" || exit 1

# TOKEN 缺失时 server.mjs 会直接以退出码 2 拒绝启动（开放代理不是可接受的默认值）。
CMD ["node", "server.mjs"]
