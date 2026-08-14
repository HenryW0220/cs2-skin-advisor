# 部署用镜像。**构建不在生产机器上做**——云端那台是 1 核 1GB 的 Oracle Always Free VM，
# `docker compose up -d --build` 期间 CPU 被吃满，站点整个构建期不可访问（HANDOFF 踩坑 40）。
# 现在由 .github/workflows/build-image.yml 在 GitHub Actions 上构建并推到 GHCR，
# 云端只做 `docker compose pull && docker compose up -d`（scripts/deploy-cloud.sh）。
#
# 本机 Windows 上不要用容器跑采集：SQLite 经 Windows bind mount 的多进程写入锁不可靠。
FROM node:22-bookworm-slim AS builder
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:22-bookworm-slim AS runner
WORKDIR /app
ENV NODE_ENV=production
# standalone 的 server.js 从环境变量读监听地址，不设的话默认只听 localhost，
# 容器外（Caddy 反代过来）就连不上
ENV PORT=3000
ENV HOSTNAME=0.0.0.0

# 构建这个镜像的 commit。容器里没有 .git，脚本自己查不到，只能构建时带进来
# （.github/workflows/build-image.yml 传 github.sha）。
# 用处：scripts/market-baseline-store.mjs 把它连同口径一起写进 market_baseline_meta——
# 大盘基准是长期复用的中间产物，"这批基准是哪版代码算的"必须留痕（迁移 024）。
ARG GIT_COMMIT=unknown
ENV GIT_COMMIT=${GIT_COMMIT}

# output: "standalone" 产出的最小运行时集合（server.js + 追踪到的那部分 node_modules）
COPY --from=builder /app/.next/standalone ./
# 以下四样 standalone 按约定不会自动带上，但这个项目运行时真的要读：
COPY --from=builder /app/.next/static ./.next/static
COPY --from=builder /app/public ./public
# 迁移在进程启动时按 process.cwd()/db/migrations 读（lib/db/client.ts），不带就起不来
COPY --from=builder /app/db ./db
# 一次性分析脚本靠 `docker compose exec app node scripts/xxx.mjs` 在容器里跑，
# 因为本机那份 data/db.sqlite 只是旧快照，真实数据只在云端（HANDOFF 运行架构一节）
COPY --from=builder /app/scripts ./scripts

# 文件追踪会顺着 lib/db/client.ts 里的 path.join(process.cwd(), "data", "db.sqlite")
# 把构建机上那份数据库也拷进 standalone（本机实测 240MB）。这里的 .dockerignore 已经
# 挡住了源文件，再删一次是为了让"镜像里不含数据库"是确定的，而不是依赖追踪器的行为。
# 运行时这个目录由 bind mount 提供（见 docker-compose.yml）。
RUN rm -rf ./data

# 仍然以 root 运行：宿主机上已有的 data/ 属主是 root，换成非 root 用户会写不进去。
EXPOSE 3000
CMD ["node", "server.js"]
