#!/usr/bin/env bash
#
# 立委臉書粉專每日抓取的 macOS 入口（launchd 的 plist 指著這支；使用者手動跑也一樣）。
#
#   scripts/fb-daily.sh                        # 排程用的正常路徑
#   scripts/fb-daily.sh --ids 1,18 --limit 5   # 手動試跑（參數直接轉給 fb-daily.mjs → fetch-fb-posts.mjs）
#
# 為什麼只剩這幾行：真正的邏輯已經搬到 scripts/fb-daily.mjs（跨平台，Windows 版共用同一份），
# 否則搬到 Windows 時會變成同一套邏輯的第二份實作，之後修一邊忘一邊。
#
# 這支仍然存在的兩個理由：
#   1. plist 與 test/shell-scripts.test.mjs 都指著它，換入口要同時動三處。
#   2. launchd 只給 /usr/bin:/bin:/usr/sbin:/sbin，沒有 shell rc —— PATH 要在這裡自己補，
#      否則 exec 出去找不到 Homebrew 的 node。
set -uo pipefail

export PATH="/opt/homebrew/bin:/usr/local/bin:${HOME}/.local/bin:${PATH}"

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
if ! command -v node >/dev/null; then
  echo "找不到 node（PATH=${PATH}）" >&2
  exit 1
fi

exec node "$ROOT/scripts/fb-daily.mjs" "$@"
