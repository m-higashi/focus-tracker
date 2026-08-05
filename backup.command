#!/bin/bash
# バックアップスクリプト(macOS / Linux 用)
# アプリ内の「💾 バックアップ作成」ボタンとまったく同じ処理を、ダブルクリックで行うためのものです。
# 作られる控えは backups/focus-日時.db の1ファイルで、アプリの「復元」からそのまま戻せます。
# ※このファイルは改行コード LF 必須。

cd "$(dirname "$0")" || exit 1

# GUI からダブルクリック起動した場合、Homebrew などのパスが通っていないことがある
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js が見つかりません。"
  echo "Node.js 22.13 以降をインストールしてください: https://nodejs.org/"
  echo
  read -r -p "Enter キーで閉じます..." _
  exit 1
fi

node backup.mjs

echo
read -r -p "Enter キーで閉じます..." _
