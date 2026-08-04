@echo off
rem Backup script: copies data\focus.db (and WAL files) to backups\YYYYMMDD\
rem Same as the in-app backup button; this is a double-click alternative.
setlocal
cd /d "%~dp0"
for /f %%i in ('powershell -NoProfile -Command "Get-Date -Format yyyyMMdd"') do set TODAY=%%i
set DST=backups\%TODAY%
if not exist "%DST%" mkdir "%DST%"
copy /Y "data\focus.db*" "%DST%\" >nul
echo Backup done: %DST%
endlocal
