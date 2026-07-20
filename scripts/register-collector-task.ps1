# 让常驻采集器开机（登录）自动启动。
# 首选 schtasks 计划任务；普通权限被拒时退回"启动文件夹"方案（免管理员，效果相同）。
# 用法：powershell -ExecutionPolicy Bypass -File scripts\register-collector-task.ps1
# 取消自启：删除启动文件夹里的 cs2-skin-advisor-collector.cmd，
#           或 schtasks /delete /tn "cs2-skin-advisor-collector" /f
$taskName = "cs2-skin-advisor-collector"
$cmdPath = Join-Path $PSScriptRoot "start-collector.cmd"

schtasks /create /tn $taskName /tr "`"$cmdPath`"" /sc onlogon /rl limited /f 2>$null
if ($LASTEXITCODE -eq 0) {
  Write-Output "已注册计划任务 $taskName（登录自动启动，端口 3210）"
} else {
  $startup = [Environment]::GetFolderPath("Startup")
  $launcher = Join-Path $startup "cs2-skin-advisor-collector.cmd"
  # /min 最小化窗口启动，不挡桌面
  Set-Content -Path $launcher -Value "start `"cs2-collector`" /min `"$cmdPath`"" -Encoding ascii
  Write-Output "计划任务需要管理员权限，已改用启动文件夹方案：$launcher"
}
