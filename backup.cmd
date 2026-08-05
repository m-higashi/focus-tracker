@echo off
rem Backup script: same as the in-app backup button (checkpoint WAL, then copy
rem data\focus.db to backups\focus-YYYYMMDD-HHMMSS.db). The result can be
rem restored from the app's "restore" screen. Double-click alternative.
setlocal
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
    echo Node.js not found. Please install Node.js 22.13 or later.
    echo https://nodejs.org/
    pause
    exit /b 1
)

node backup.mjs

echo.
pause
endlocal
