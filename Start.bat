@echo off
title Focus Tracker
cd /d "%~dp0"
rem Switch console to UTF-8 so Japanese folder names display correctly
chcp 65001 >nul
rem Prefer bundled Node runtime if present (release zip). Fallback: installed Node.
if exist "%~dp0runtime\node.exe" (
  "%~dp0runtime\node.exe" server.js
  goto stopped
)
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js not found. Install Node.js 22.13 or later.
  echo Or download the "Node included" zip from the Releases page.
  pause
  exit /b 1
)
node server.js
:stopped
echo.
echo Server stopped.
pause
