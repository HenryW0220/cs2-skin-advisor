# 把云端每日备份（scripts/backup-db.sh，云端 03:00 UTC 跑）镜像一份到本机，
# 做异地冗余——云端 VM 是唯一数据源，云端自己的备份和数据库同机，VM 整个丢了
# 备份也跟着丢，这里在本机再留一份最近的快照。
# 通过 Windows 计划任务触发（登录时 + 每天固定时间兜底）。

$ErrorActionPreference = "Stop"
$repoRoot = Split-Path -Parent $PSScriptRoot
$localDir = Join-Path $repoRoot "data\backups"
New-Item -ItemType Directory -Force -Path $localDir | Out-Null

$today = Get-Date -Format "yyyy-MM-dd"
$remoteFile = "db-$today.sqlite.gz"
$localFile = Join-Path $localDir "cloud-db-$today.sqlite.gz"

if (Test-Path $localFile) {
    Write-Output "[pull-cloud-backup] $today 的备份已存在，跳过"
} else {
    & scp -o BatchMode=yes -o ConnectTimeout=15 "cs2-cloud:~/cs2-skin-advisor/data/backups/$remoteFile" $localFile
    if ($LASTEXITCODE -ne 0) {
        Write-Output "[pull-cloud-backup] scp 失败（退出码 $LASTEXITCODE），可能云端当天备份还没跑或网络不通，下次触发再试"
        if (Test-Path $localFile) { Remove-Item -Force $localFile }
        exit 1
    }
    Write-Output "[pull-cloud-backup] 已拉取 $remoteFile"
}

# 本机只留最近 14 天的云端备份镜像，更老的删掉，避免无限增长。
Get-ChildItem -Path $localDir -Filter "cloud-db-*.sqlite.gz" |
    Where-Object { $_.LastWriteTime -lt (Get-Date).AddDays(-14) } |
    Remove-Item -Force
