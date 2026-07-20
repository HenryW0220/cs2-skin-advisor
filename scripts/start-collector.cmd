@echo off
rem 常驻数据采集器：生产模式跑整个应用（内置每小时价格同步+异常扫描），
rem 由 Windows 计划任务在开机/登录时拉起（注册命令见 scripts/register-collector-task.ps1）。
rem 端口 3210，避开开发用的 3000；日志追加到 data\collector.log。
cd /d "%~dp0.."
call npm run start -- -p 3210 >> data\collector.log 2>&1
