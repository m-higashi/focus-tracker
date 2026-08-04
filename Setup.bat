@echo off
title Setup - Focus Tracker
setlocal
cd /d "%~dp0"
echo ================================================
echo  集中トラッカー セットアップ確認
echo ================================================
echo.
where node >nul 2>nul
rem 注意: cmdはブロック内のechoに半角の丸括弧があると誤動作するため、文中は全角括弧を使う
if errorlevel 1 (
  echo [NG] Node.js が見つかりません。
  echo.
  echo   1. いま開いたページから「LTS」版をダウンロードして
  echo      インストールしてください（設定はそのまま「次へ」でOK）
  echo   2. インストールが終わったら、この Setup.bat を
  echo      もう一度ダブルクリックしてください
  echo.
  start https://nodejs.org/ja
  pause
  exit /b 1
)
for /f %%v in ('node -v') do set NODEVER=%%v
node -e "const[a,b]=process.versions.node.split('.').map(Number);process.exit(a>22||(a==22&&b>=13)?0:1)"
if errorlevel 1 (
  echo [NG] Node.js %NODEVER% は古いバージョンです（22.13以上が必要）。
  echo      いま開いたページから最新のLTS版を入れ直してください。
  start https://nodejs.org/ja
  pause
  exit /b 1
)
echo [OK] Node.js %NODEVER% が入っています。
echo.
echo セットアップは完了です!
echo.
echo   ・起動する ................. Start.bat をダブルクリック
echo   ・PC起動時に自動で開始 ..... RegisterAutostart.cmd をダブルクリック
echo   ・使い方 ................... 説明書.txt を開く
echo.
pause
endlocal
