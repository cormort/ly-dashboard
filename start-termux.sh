#!/data/data/com.termux/files/usr/bin/bash
# 一鍵啟動立委觀測站（Termux / Android）：bash start-termux.sh
# 關閉：Ctrl+C。瀏覽器開 http://127.0.0.1:8787
set -euo pipefail
cd "$(dirname "$0")"
PORT="${PORT:-8787}"
export PORT

command -v node >/dev/null || { echo "找不到 node，請先執行：pkg install -y nodejs git"; exit 1; }

# 防止平板休眠時 Termux 被系統殺掉
command -v termux-wake-lock >/dev/null && termux-wake-lock || true

[ -d web/node_modules ] || npm --prefix web install
[ -f web/dist/index.html ] || npm --prefix web run build

echo "啟動中… 請在瀏覽器開 http://127.0.0.1:${PORT}"
# 啟動時若資料不存在或超過 24 小時，伺服器會自動先同步一次
exec node server/index.mjs
