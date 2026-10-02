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

# 沒裝過、或 lockfile 比上次安裝新（git pull 帶進新套件）就重裝；
# 用 npm ci 照 lockfile 安裝、不會改寫 package-lock.json（否則下次 git pull 會被本機變更擋住）
if [ ! -f web/node_modules/.package-lock.json ] || [ web/package-lock.json -nt web/node_modules/.package-lock.json ]; then
  npm --prefix web ci
fi
# 前端原始碼比 dist 新（例如 git pull 之後）就重 build，避免一直開到舊版
if [ ! -f web/dist/index.html ] || [ -n "$(find web/src web/index.html web/package.json web/package-lock.json web/vite.config.ts web/tsconfig.json -newer web/dist/index.html -print -quit 2>/dev/null)" ]; then
  # 不用 npm run build：Termux:Widget 捷徑環境下 npm 不會把 node_modules/.bin 放進 PATH（tsc: not found），
  # 直接用 node 呼叫在任何環境都可靠
  (cd web && node node_modules/typescript/bin/tsc -b && node node_modules/vite/bin/vite.js build)
fi

echo "啟動中… 請在瀏覽器開 http://127.0.0.1:${PORT}"
# 啟動時若資料不存在或超過 24 小時，伺服器會自動先同步一次
exec node server/index.mjs
