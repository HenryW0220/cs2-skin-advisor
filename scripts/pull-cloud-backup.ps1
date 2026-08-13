# 把云端每日备份（scripts/backup-db.sh，云端 03:00 UTC 跑）镜像一份到本机，
# 做异地冗余——云端 VM 是唯一数据源，云端自己的备份和数据库同机，VM 整个丢了
# 备份也跟着丢，这里在本机再留一份最近的快照。
# 通过 Windows 计划任务触发（每天 21:00）。
#
# **这个脚本的输出必须落地，不能只 Write-Output**：计划任务跑在非交互会话里，
# 控制台输出没有任何人看得到。2026-08-05~08-13 这 8 天连续失败没被发现，就是因为
# 唯一的信号是 schtasks 的 Last Result，而没人会主动去查它（根因是仓库从
# d:\cs2-skin-advisor 挪到了 d:\AI Solution\cs2-skin-advisor，计划任务里的 -File
# 路径还指着旧位置，PowerShell 直接返回 -196608）。所以这里留两处可见信号：
#   ① 本机日志 data/backups/pull-cloud-backup.log（成功和失败都写）；
#   ② 成功后往云端写一个心跳文件，由 /settings 页显示"异地备份最近成功于何时"——
#      本机的状态云端看不见，只有本机主动上报这一条路。
$ErrorActionPreference = "Stop"
$repoRoot = Split-Path -Parent $PSScriptRoot
$localDir = Join-Path $repoRoot "data\backups"
New-Item -ItemType Directory -Force -Path $localDir | Out-Null

$logFile = Join-Path $localDir "pull-cloud-backup.log"
function Write-Log([string]$message) {
    $line = "[{0}] {1}" -f (Get-Date -Format "yyyy-MM-dd HH:mm:ss"), $message
    Write-Output $line
    Add-Content -Path $logFile -Value $line -Encoding utf8
}

$today = Get-Date -Format "yyyy-MM-dd"
$remoteFile = "db-$today.sqlite.gz"
$localFile = Join-Path $localDir "cloud-db-$today.sqlite.gz"

# 成功后把心跳写回云端，data/ 是 bind mount，容器里的 /settings 直接读得到。
function Send-Heartbeat([string]$backupDate, [long]$sizeBytes) {
    $payload = @{
        pulledAt = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ")
        backupDate = $backupDate
        sizeBytes = $sizeBytes
        host = $env:COMPUTERNAME
    } | ConvertTo-Json -Compress
    # 先落成本地临时文件再 scp，绕开两个坑：① PowerShell 5.1 往原生命令 stdin 写会带
    # UTF-8 BOM，那三个字节会让容器侧 JSON.parse 直接抛错；② 传给原生命令的字符串里的
    # 双引号会被参数解析吃掉，JSON 会变成 {host:DESKTOP,...} 这种不合法的东西。
    $tmp = Join-Path $env:TEMP "cs2-offsite-heartbeat.json"
    [System.IO.File]::WriteAllText($tmp, $payload, (New-Object System.Text.UTF8Encoding($false)))
    & scp -o BatchMode=yes -o ConnectTimeout=15 $tmp "cs2-cloud:~/cs2-skin-advisor/data/offsite-backup-heartbeat.json" | Out-Null
    Remove-Item -Force $tmp -ErrorAction SilentlyContinue
    if ($LASTEXITCODE -ne 0) {
        Write-Log "心跳写入失败（退出码 $LASTEXITCODE）——备份本身已拉到本机，只是云端看不到这次成功"
    }
}

if (Test-Path $localFile) {
    Write-Log "$today 的备份已存在，跳过下载"
    Send-Heartbeat $today (Get-Item $localFile).Length
} else {
    & scp -o BatchMode=yes -o ConnectTimeout=15 "cs2-cloud:~/cs2-skin-advisor/data/backups/$remoteFile" $localFile
    if ($LASTEXITCODE -ne 0) {
        Write-Log "scp 失败（退出码 $LASTEXITCODE），可能云端当天备份还没跑或网络不通，下次触发再试"
        if (Test-Path $localFile) { Remove-Item -Force $localFile }
        exit 1
    }
    Write-Log "已拉取 $remoteFile（$([math]::Round((Get-Item $localFile).Length / 1MB, 1)) MB）"
    Send-Heartbeat $today (Get-Item $localFile).Length
}

# 本机只留最近 14 天的云端备份镜像，更老的删掉，避免无限增长。
Get-ChildItem -Path $localDir -Filter "cloud-db-*.sqlite.gz" |
    Where-Object { $_.LastWriteTime -lt (Get-Date).AddDays(-14) } |
    Remove-Item -Force

# 日志同样不能无限长，只留最近 200 行。
if ((Get-Content $logFile).Count -gt 200) {
    Get-Content $logFile -Tail 200 | Set-Content $logFile -Encoding utf8
}



