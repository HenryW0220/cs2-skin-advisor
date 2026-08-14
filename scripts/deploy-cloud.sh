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
# **附带后果（不是 bug）**：函数定义在 git pull 之前就已经加载完了，所以**改动这个脚本
# 本身要下一次部署才生效**。第一次上线预热功能时就遇到了：那一轮跑的还是旧逻辑、没预热，
# 再跑一次才出来。改完这个文件后如果想立刻生效，先 git pull 再执行。

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

  # 先等服务真的开始监听。`docker compose up -d` 一返回容器就算"起来了"，但 Node 还要
  # 几秒才 listen——不等的话前几个预热请求会立刻拿到连接拒绝（curl 写 000、耗时 0.000s），
  # 看起来像超时，实际一行数据库都没读到，等于没预热。第一版就是这么错的。
  echo "[deploy] 等待服务开始响应"
  local ready=""
  for _ in $(seq 1 30); do
    if curl -s -o /dev/null -m 5 "${auth[@]}" "http://localhost:3210/ledger"; then
      ready=yes
      break
    fi
    sleep 2
  done
  if [ -z "$ready" ]; then
    echo "[deploy] ⚠️  60 秒内没等到服务响应，跳过预热（容器状态见下方，自己确认一下）"
    return 0
  fi

  # 预热的职责**只有暖缓存**，不是当健康检查——"服务活没活"上面那个就绪循环已经答过了。
  # 原来这两个职责混在一起，后果是 curl 用同一个 `000` 同时表达"慢到超时"和"连接被拒"，
  # 而这两件事要做的处理完全相反。2026-08-14 就撞上了：`/paper` 冷缓存实测 284 秒
  # （记录里"首次 136 秒"已经翻倍），超时上限 300 秒只剩 16 秒余量——**再涨一点，预热就会
  # 稳定失败，而失败的样子跟"服务没起来"一模一样，偏偏是在部署这个最需要相信监控的时刻**。
  # 所以：① 超时放宽到 600 秒，慢就让它慢完，别把慢报成死；② 用 curl 的退出码把两种
  # 失败区分开（28 = 超时，7 = 连接被拒），分别打不同的话；③ 预热失败一律不影响部署结果。
  echo "[deploy] 预热页面（重启后系统页缓存是冷的；这一段只暖缓存，不作健康判据）"
  for path in /positions /watchlist /paper /anomalies /ledger; do
    local out rc
    out=$(curl -s -o /dev/null -m 600 -w '%{http_code}|%{time_starttransfer}s' \
      "${auth[@]}" "http://localhost:3210$path")
    rc=$?
    case "$rc" in
      0) echo "[deploy]   $path -> $out" ;;
      28) echo "[deploy]   $path -> ⏱ 600 秒还没返回（是**慢**不是死，页面本身可能有 N+1，见 HANDOFF /paper 那条）" ;;
      7) echo "[deploy]   $path -> ✗ 连接被拒（这才是服务的问题，去看容器日志）" ;;
      *) echo "[deploy]   $path -> ✗ curl 退出码 $rc" ;;
    esac
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
