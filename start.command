#!/usr/bin/env bash
# 一鍵啟動立委觀測站：在 Finder 雙擊即可。關閉視窗或按 Ctrl+C 停止。
set -euo pipefail
cd "$(dirname "$0")"
PORT="${PORT:-8787}"
export PORT

# 加 --lan 開放同 Wifi 的人連線（同步 API 仍會自動停用）
if [ "${1:-}" = "--lan" ]; then
  export LY_HOST=0.0.0.0
  IP="$(ipconfig getifaddr en0 2>/dev/null || ipconfig getifaddr en1 2>/dev/null || true)"
  echo "區網網址：http://${IP:-<你的IP>}:${PORT}/"
fi

command -v node >/dev/null || { echo "找不到 node，請先安裝 Node.js 22.5 以上"; read -r; exit 1; }

# 先跟 GitHub 同步；離線或本機有衝突就跳過，用現有版本照常啟動
git pull --ff-only || echo "（同步失敗，沿用本機版本）"

[ -d web/node_modules ] || npm --prefix web install
# 前端原始碼比 dist 新（例如剛 pull 下來）就重 build，避免開到舊版
if [ ! -f web/dist/index.html ] || [ -n "$(find web/src web/index.html web/package.json web/package-lock.json -newer web/dist/index.html -print -quit)" ]; then
  npm --prefix web install
  npm --prefix web run build
fi

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
