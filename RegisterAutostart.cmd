@echo off
title Autostart - Focus Tracker
cd /d "%~dp0"
rem スタートアップフォルダに Start.bat へのショートカットを作る(管理者権限不要)
powershell -NoProfile -Command "$ws=New-Object -ComObject WScript.Shell; $s=$ws.CreateShortcut([Environment]::GetFolderPath('Startup')+'\FocusTracker.lnk'); $s.TargetPath='%~dp0Start.bat'; $s.WorkingDirectory='%~dp0'; $s.Save()"
if errorlevel 1 (
  echo 登録に失敗しました。
) else (
  echo PCにサインインしたとき、自動でアプリが起動するようになりました。
  echo 解除したいときは UnregisterAutostart.cmd をダブルクリックしてください。
)
pause
