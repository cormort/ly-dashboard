#!/usr/bin/env bash
#
# 立委觀測站 API 伺服器（給 macOS launchd 監管用）。
#
# 離開碼：
#   0 = 連接埠已經有伺服器在跑（可能是手動啟動的）→ 不搶、**不當成失敗**，
#       否則 launchd 會 crash-loop（KeepAlive 遇到非 0 離開碼會一直重啟）。
#   node 的離開碼 = 伺服器自己當掉時的碼 → launchd 會依 KeepAlive 重新拉起來。
#
# 為什麼要有這支：伺服器原本是手動 `node server/index.mjs` 跑著，一當掉（或那個終端機被關掉）
# 網站就整片掛掉，只能等人發現再手動重開 —— 使用者看到的「偶爾無法取得新聞」就是這種空窗。
set -uo pipefail

# launchd 只給 /usr/bin:/bin:/usr/sbin:/sbin，沒有 shell rc，所以 PATH 要自己來（Homebrew 的 node 在這）
export PATH="/opt/homebrew/bin:/usr/local/bin:${HOME}/.local/bin:${PATH}"

PORT="${LY_PORT:-8787}"
# 一定要 export：server 讀的是 PORT，只設 LY_PORT 的話「檢查的埠」跟「實際監聽的埠」會是兩個
# （2026-10-07 真的踩到：LY_PORT=8788 開起來卻佔用 8787）
export PORT
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

if lsof -nP -iTCP:"${PORT}" -sTCP:LISTEN >/dev/null 2>&1; then
  echo "$(date '+%F %T') 連接埠 ${PORT} 已經有伺服器在跑，結束（不搶，等它自己掛掉再說）"
  exit 0
fi

echo "$(date '+%F %T') 啟動立委觀測站 API 伺服器：${LY_HOST:-127.0.0.1}:${PORT}"
exec node server/index.mjs
