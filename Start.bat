@echo off
title Focus Tracker
cd /d "%~dp0"
rem Switch console to UTF-8 so Japanese folder names display correctly
chcp 65001 >nul
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js not found. Install Node.js 22.13 or later.
  pause
  exit /b 1
)
node server.js
echo.
echo Server stopped.
pause
