@echo off
title Autostart - Focus Tracker
powershell -NoProfile -Command "Remove-Item ([Environment]::GetFolderPath('Startup')+'\FocusTracker.lnk') -ErrorAction SilentlyContinue"
echo 自動起動を解除しました（もともと登録されていなかった場合もこのままでOKです）。
pause
