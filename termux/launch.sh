#!/data/data/com.termux/files/usr/bin/bash
# 啟動立委觀測站並在伺服器就緒後開瀏覽器。伺服器留在這個視窗的前景執行
# （放背景會被 Android 在視窗關閉時一起結束）。停止：Ctrl+C 或關閉視窗。
# Termux:Widget 的捷徑視窗環境可能帶 NODE_ENV=production，會讓 npm 略過 tsc/vite，所以明確指定。
export NODE_ENV=development npm_config_include=dev
PORT="${PORT:-8787}"
cd "$(dirname "$0")/.." || exit 1

pkill -f "server/index.mjs" 2>/dev/null || true

(
  for _ in $(seq 1 300); do
    if curl -sf "http://127.0.0.1:${PORT}/api/v1/health" >/dev/null; then
      termux-open-url "http://127.0.0.1:${PORT}/"
      exit 0
    fi
    sleep 1
  done
) &

# 套件安裝與前端 build 由 start-termux.sh 依需要處理
bash start-termux.sh || { echo "啟動失敗，按 Enter 關閉"; read -r; }
