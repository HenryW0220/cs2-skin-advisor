# 部署用镜像（PLAN.md D3 第 2 步：部署成常驻服务，手机可访问）。
# 本机 Windows 上日常采集用的是原生方案（scripts/start-collector.cmd + 登录自启），
# 不要在同一台机器上同时跑容器和原生采集器——SQLite 经 Windows bind mount 的
# 多进程写入锁不可靠，容器方案留给部署到 Linux 服务器/NAS 时用。
FROM node:22-bookworm-slim AS builder
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:22-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production
COPY --from=builder /app ./
EXPOSE 3000
# 数据库落在 /app/data，用 volume 挂出来持久化（见 docker-compose.yml）
CMD ["npm", "run", "start"]
