#!/usr/bin/env bash
set -euo pipefail

# 云端更新（2026-08-02 起）。**这台机器不再构建镜像**——1 核 1GB 上就地
# `docker compose up -d --build` 会让站点在整个构建期不可访问（HANDOFF 踩坑 40）。
# 镜像由 GitHub Actions 构建推到 GHCR，这里只做拉取 + 换容器，停机窗口是秒级。
#
# 用法（在云端 VM 上）：cd ~/cs2-skin-advisor && ./scripts/deploy-cloud.sh
#
# 整个脚本包在函数里、最后一行才调用，是因为下面第一步会 git pull 改到脚本自己：
# bash 是边读边执行的，文件在执行途中被换掉会从错误的字节偏移继续读。

# 换容器丢掉的不只是进程内缓存，还有 240MB 数据库在系统页缓存里的那份，
# 所以重启后第一个访问的人要等很久（实测首次 /paper 136 秒，warm 之后 0.3~2 秒）。
# 与其让这个成本落在"下一个打开页面的人"头上，不如在这里自己先跑一遍——
# 部署脚本多花两三分钟没人在等，真实访问慢两分钟是要骂人的。
warm_up() {
  local code
  local -a auth=()
  # 页面挂在 Basic Auth 后面（proxy.ts），预热请求得带上凭证，
  # 否则拿到的是 401，一行数据库都没读到，等于没预热
  set -a; . ./.env.local; set +a
  if [ -n "${BASIC_AUTH_USER:-}" ]; then
    auth=(-u "${BASIC_AUTH_USER}:${BASIC_AUTH_PASSWORD:-}")
  fi

  echo "[deploy] 预热页面（重启后系统页缓存是冷的）"
  for path in /positions /watchlist /paper /anomalies /ledger; do
    code=$(curl -s -o /dev/null -m 300 -w '%{http_code}|%{time_starttransfer}s' \
      "${auth[@]}" "http://localhost:3210$path" || echo "超时")
    echo "[deploy]   $path -> $code"
  done
}

main() {
  local repo_dir image_rev git_rev
  repo_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
  cd "$repo_dir"

  echo "[deploy] 拉取仓库（compose 文件、迁移、脚本）"
  git pull --ff-only origin main

  echo "[deploy] 拉取镜像"
  sudo docker compose pull

  # 代码推上去到镜像构建完有几分钟，这期间部署只会换上上一版镜像，
  # 而表面上看起来一切正常——所以这里把两个版本号摆出来对一下
  image_rev="$(sudo docker image inspect ghcr.io/henryw0220/cs2-skin-advisor:latest \
    --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' 2>/dev/null || echo "")"
  git_rev="$(git rev-parse HEAD)"
  if [ -n "$image_rev" ] && [ "$image_rev" != "$git_rev" ]; then
    echo "[deploy] ⚠️  镜像对应提交 ${image_rev:0:7}，仓库当前是 ${git_rev:0:7}"
    echo "[deploy] ⚠️  GitHub Actions 可能还在构建，等它跑完再重跑本脚本"
    read -r -p "[deploy] 仍然继续？(y/N) " answer
    [ "$answer" = "y" ] || { echo "[deploy] 已放弃"; return 1; }
  fi

  echo "[deploy] 重建容器"
  sudo docker compose up -d

  # 旧镜像不清会一直堆着；build cache 那次把磁盘吃到 80%（踩坑 31）就是这么来的
  sudo docker image prune -f >/dev/null

  warm_up

  echo "[deploy] 完成，当前状态："
  sudo docker compose ps
  sudo docker compose logs --tail 20 app
}

main "$@"
