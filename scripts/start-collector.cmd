@echo off
rem Resident collector: production build, port 3210. Purpose/architecture documented in HANDOFF.md.
rem Kept ASCII-only in this file on purpose - cmd.exe misreads non-BOM UTF-8 comments under the
rem system GBK codepage, which corrupts the whole script (stray "'m' is not recognized" errors).
cd /d "%~dp0.."
call npm run start -- -p 3210 >> data\collector.log 2>&1
