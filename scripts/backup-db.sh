#!/usr/bin/env bash
set -euo pipefail

# 云端 SQLite 数据库每日自动备份（2026-07-22 加，此前云端数据库没有任何冗余，
# 实例一旦出问题四个月的价格时序+人工标注全丢，标注数据不可再生）。
# 用 better-sqlite3 的 backup() API 做在线备份（SQLite Online Backup，
# 不用停容器/不阻塞写入），备份文件落在 bind mount 出来的 data/backups/，
# 宿主机和容器都能看到同一份文件。
# crontab 里跑：0 3 * * * /home/ubuntu/cs2-skin-advisor/scripts/backup-db.sh >> /home/ubuntu/backup.log 2>&1

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BACKUP_DIR="$REPO_DIR/data/backups"
DATE="$(date -u +%Y-%m-%d)"
FILE_NAME="db-$DATE.sqlite"

mkdir -p "$BACKUP_DIR"
cd "$REPO_DIR"

docker compose exec -T app node -e "
require('better-sqlite3')('/app/data/db.sqlite', { readonly: true }).backup('/app/data/backups/$FILE_NAME');
"

gzip -f "$BACKUP_DIR/$FILE_NAME"

# 保留策略：7 天内每天一份；超过 7 天只留每周日那份，留够 8 周（约 2 个月）；
# 再老的删掉。表按天涨（HANDOFF 第四节第7条），备份不加保留上限会持续吃盘。
find "$BACKUP_DIR" -name 'db-*.sqlite.gz' -mtime +7 -print0 | while IFS= read -r -d '' f; do
  fdate="$(basename "$f")"; fdate="${fdate#db-}"; fdate="${fdate%.sqlite.gz}"
  dow="$(date -u -d "$fdate" +%u 2>/dev/null || echo 0)"
  [ "$dow" = "7" ] || rm -f "$f"
done
find "$BACKUP_DIR" -name 'db-*.sqlite.gz' -mtime +56 -delete

echo "[backup] $DATE 完成，大小 $(du -h "$BACKUP_DIR/$FILE_NAME.gz" | cut -f1)"
