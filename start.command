#!/usr/bin/env bash
# 一鍵啟動立委觀測站：在 Finder 雙擊即可。關閉視窗或按 Ctrl+C 停止。
set -euo pipefail
cd "$(dirname "$0")"
PORT="${PORT:-8787}"
export PORT

command -v node >/dev/null || { echo "找不到 node，請先安裝 Node.js 22.5 以上"; read -r; exit 1; }

# ponytail: dist 存在就不重建；改了前端要手動刪 web/dist 或跑 npm run build:web
[ -d web/node_modules ] || npm --prefix web install
[ -f web/dist/index.html ] || npm --prefix web run build

# 啟動時若資料不存在或超過 24 小時，伺服器會自動先同步一次
node server/index.mjs &
SERVER_PID=$!
trap 'kill $SERVER_PID 2>/dev/null || true' EXIT INT TERM

for _ in $(seq 1 50); do
  curl -sf "http://127.0.0.1:${PORT}/api/v1/health" >/dev/null && break
  sleep 0.2
done
open "http://127.0.0.1:${PORT}/"

wait $SERVER_PID
