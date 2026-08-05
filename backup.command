#!/bin/bash
# バックアップスクリプト(macOS / Linux 用)
# data/focus.db(と WAL ファイル)を backups/YYYYMMDD/ にコピーします。
# アプリ内のバックアップボタンと同じ内容を、ダブルクリックで行うためのものです。
# ※このファイルは改行コード LF 必須。

cd "$(dirname "$0")" || exit 1

TODAY="$(date +%Y%m%d)"
DST="backups/$TODAY"
mkdir -p "$DST"

if ! ls data/focus.db >/dev/null 2>&1; then
  echo "data/focus.db が見つかりません。先にアプリを一度起動してください。"
  read -r -p "Enter キーで閉じます..." _
  exit 1
fi

cp -f data/focus.db* "$DST"/
echo "バックアップしました: $DST"
read -r -p "Enter キーで閉じます..." _
