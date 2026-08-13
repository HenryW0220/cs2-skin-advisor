# 把 Windows 计划任务 CS2-CloudBackupPull 的执行路径对回当前仓库位置。
#
# 为什么需要这个脚本：任务的动作里写的是**绝对路径**，仓库一旦挪窝（2026-08 从
# d:\cs2-skin-advisor 挪到 d:\AI Solution\cs2-skin-advisor）任务就指向一个不存在的
# 文件，PowerShell 直接返回 -196608，而计划任务只把这个码记在 Last Result 里，
# 没有任何人会主动去看——异地备份因此断了 8 天（2026-08-05~08-13）没被发现。
#
# **必须在管理员 PowerShell 里跑**：这个任务是 S4U（不管用户是否登录都运行），
# 改它要么提权、要么提供账户密码，普通会话会直接 Access denied。
#
# 用法（管理员 PowerShell）：
#   powershell -ExecutionPolicy Bypass -File "<仓库>\scripts\fix-backup-task.ps1"
$ErrorActionPreference = "Stop"

$taskName = "CS2-CloudBackupPull"
$repoRoot = Split-Path -Parent $PSScriptRoot
$scriptPath = Join-Path $repoRoot "scripts\pull-cloud-backup.ps1"

if (-not (Test-Path $scriptPath)) {
    throw "找不到 $scriptPath——这个脚本要放在仓库的 scripts\ 下面跑"
}

$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole(
    [Security.Principal.WindowsBuiltInRole]::Administrator
)
if (-not $isAdmin) {
    throw "需要管理员权限（S4U 任务不提权改不了）。右键 PowerShell → 以管理员身份运行，再跑一次。"
}

$task = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
if (-not $task) {
    throw "计划任务 $taskName 不存在。它是 2026-07-22 手工建的，要重建的话见 HANDOFF 的运行架构一节。"
}

$before = ($task.Actions | ForEach-Object { $_.Arguments }) -join " | "
$action = New-ScheduledTaskAction -Execute "powershell.exe" `
    -Argument "-ExecutionPolicy Bypass -WindowStyle Hidden -File `"$scriptPath`"" `
    -WorkingDirectory $repoRoot

# 顺带改三个设置（在原有 Settings 上改，不整个替换，免得把 MultipleInstances/Idle 那些覆盖掉）：
#   StartWhenAvailable —— 最要紧的一条。21:00 触发时机器关着的话，这一天**整个跳过**，
#     而且同样不留痕；打开之后开机会尽快补跑。
#   DisallowStartIfOnBatteries / StopIfGoingOnBatteries —— 台式机上无害，但没理由留个坑。
$settings = $task.Settings
$settings.StartWhenAvailable = $true
$settings.DisallowStartIfOnBatteries = $false
$settings.StopIfGoingOnBatteries = $false

Set-ScheduledTask -TaskName $taskName -Action $action -Settings $settings | Out-Null

$updated = Get-ScheduledTask -TaskName $taskName
$after = ($updated.Actions | ForEach-Object { $_.Arguments }) -join " | "
Write-Output "改前：$before"
Write-Output "改后：$after"
Write-Output ("设置：StartWhenAvailable={0} DisallowStartIfOnBatteries={1}" -f `
    $updated.Settings.StartWhenAvailable, $updated.Settings.DisallowStartIfOnBatteries)

# 改完立刻跑一次，别等到明天 21:00 才知道对不对。
Start-ScheduledTask -TaskName $taskName
Start-Sleep -Seconds 20
$info = Get-ScheduledTaskInfo -TaskName $taskName
Write-Output "试跑结果：LastTaskResult=$($info.LastTaskResult)（0 = 成功；-196608 = 脚本路径还是不对）"
Write-Output "日志：$repoRoot\data\backups\pull-cloud-backup.log"
