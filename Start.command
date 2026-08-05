#!/bin/bash
# 集中トラッカー 起動スクリプト(macOS / Linux 用)
# Windows の Start.bat と同じ役割。ダブルクリックで起動し、ウィンドウを閉じると停止します。
# ※このファイルは改行コード LF 必須(.gitattributes で固定)。CRLF だと起動に失敗します。

# スクリプトのある場所へ移動(どこから実行してもアプリのフォルダを基準にする)
cd "$(dirname "$0")" || exit 1

# Homebrew などで入れた Node が PATH に無いGUI起動でも見つかるように、よくある場所を足す
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js が見つかりません。"
  echo "Node.js 22.13 以降をインストールしてください: https://nodejs.org/"
  echo "(Homebrew を使う場合: brew install node)"
  echo
  read -r -p "Enter キーで閉じます..." _
  exit 1
fi

# node:sqlite を使うため 22.13 以降が必要。古い場合は起動前に知らせる
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
NODE_MINOR="$(node -p 'process.versions.node.split(".")[1]')"
if [ "$NODE_MAJOR" -lt 22 ] || { [ "$NODE_MAJOR" -eq 22 ] && [ "$NODE_MINOR" -lt 13 ]; }; then
  echo "Node.js のバージョンが古すぎます(現在: $(node -v))。"
  echo "22.13 以降にアップデートしてください: https://nodejs.org/"
  echo
  read -r -p "Enter キーで閉じます..." _
  exit 1
fi

node server.js

echo
echo "サーバーを停止しました。"
read -r -p "Enter キーで閉じます..." _
