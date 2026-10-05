#!/usr/bin/env bash
#
# 每日自動抓取立委臉書粉專的「最新一則貼文」（macOS launchd 用；見 scripts/launchd/）。
#
#   scripts/fb-daily.sh                 # 排程用的正常路徑：抓 113 位、寫 .cache/posts-<今天>.csv
#   scripts/fb-daily.sh --ids 1,18 --limit 5   # 手動試跑（參數直接轉給 fetch-fb-posts.mjs）
#
# 為什麼要有這層 wrapper（而不是讓 launchd 直接跑 fetch-fb-posts.mjs）：
#   1. launchd 的 PATH 只有 /usr/bin:/bin:/usr/sbin:/sbin，找不到 Homebrew 的 node。
#   2. 抓 113 位要 25–35 分鐘，跑完要有人看結果：這裡把輸出接到固定的 log，
#      並在「一列都沒抓到」時用非零 exit 明確失敗（最常見的原因是設定檔沒登入 Facebook）。
#   3. 寫回試算表成功時，順手叫本機伺服器重新同步一次，畫面不用等下一次 24 小時排程。
#
# 退出碼：0 成功／1 環境或執行失敗／2 一列都沒抓到（幾乎一定是沒登入 Facebook）／3 找不到必要檔案
#
# 前置（各一次就好）：
#   npm i -D playwright-core
#   node scripts/fetch-fb-posts.mjs --login          # 開有畫面的瀏覽器登入一次 Facebook
#
# 環境變數：
#   LY_FB_PROFILE           Chrome 設定檔（預設 ~/.ly-dashboard/fb-profile）
#   LY_FB_SERVICE_ACCOUNT   服務帳號金鑰；檔案存在才會 --write-sheet 寫回試算表
#   LY_SYNC_TOKEN           本機伺服器有設 token 時，觸發同步要帶同一組
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT" || exit 1

# launchd 不會載入使用者的 shell 設定，把常見的 node 位置補進 PATH
export PATH="/opt/homebrew/bin:/usr/local/bin:$HOME/.local/bin:$PATH"

LOG_DIR="$ROOT/.cache"
mkdir -p "$LOG_DIR"
LOG="$LOG_DIR/fb-daily.log"

PROFILE="${LY_FB_PROFILE:-$HOME/.ly-dashboard/fb-profile}"
KEY="${LY_FB_SERVICE_ACCOUNT:-$ROOT/service_account.json}"
STAMP="$(date '+%Y-%m-%d')"
OUT_DATED="$LOG_DIR/posts-$STAMP.csv"
OUT_LATEST="$LOG_DIR/posts-latest.csv"

log() { printf '%s %s\n' "$(date '+%Y-%m-%dT%H:%M:%S%z')" "$*" >>"$LOG"; }

log "=== 開始（profile=$PROFILE）==="

NODE="$(command -v node || true)"
if [ -z "$NODE" ]; then
  log "找不到 node（PATH=$PATH）；中止"
  exit 1
fi

# 先檢查 playwright-core，省下「跑了半小時才發現沒裝」這種事
if ! "$NODE" -e "import('playwright-core').then(()=>{},()=>process.exit(1))" >/dev/null 2>&1; then
  log "找不到 playwright-core：請先在 $ROOT 執行 npm i -D playwright-core；中止"
  exit 1
fi

# 驗證報告預設會寫進版控的 docs/fb-verification-<日期>.csv；排程每天跑的話會一直長新檔案，
# 所以這裡改寫到 .cache/（已 gitignore）。要留哪一天的證據再自己搬進 docs/。
ARGS=(--verify --verify-out "$LOG_DIR/fb-verification-$STAMP.csv" --profile "$PROFILE" --out "$OUT_DATED")
WRITE_SHEET=0
if [ -f "$KEY" ]; then
  ARGS+=(--write-sheet --key "$KEY")
  WRITE_SHEET=1
else
  log "沒有服務帳號金鑰（$KEY）→ 只產生本機 CSV，不寫回試算表"
fi

# 呼叫端給的參數（例如手動試跑的 --ids）一律優先，方便縮小範圍
if [ "$#" -gt 0 ]; then
  ARGS+=("$@")
  log "額外參數：$*"
fi

OUTPUT="$("$NODE" scripts/fetch-fb-posts.mjs "${ARGS[@]}" 2>&1)"
STATUS=$?
printf '%s\n' "$OUTPUT" >>"$LOG"

if [ "$STATUS" -ne 0 ]; then
  log "抓取失敗（exit $STATUS）；中止"
  exit 1
fi

# fetch-fb-posts.mjs 收尾會印「完成：N 列有日期、M 列留空」，用那一行當作成功與否的判準。
# 不直接數 CSV 的原因：CSV 欄位可能有引號包住的逗號，naive 切欄會數錯。
FILLED="$(printf '%s\n' "$OUTPUT" | sed -n 's/.*完成：\([0-9][0-9]*\) 列有日期.*/\1/p' | tail -1)"
if [ -z "$FILLED" ]; then
  log "抓不到「完成：…列有日期」的統計，無法確認結果；視為失敗"
  exit 1
fi

cp -f "$OUT_DATED" "$OUT_LATEST"
log "完成：$FILLED 列有日期（$OUT_DATED，另存一份 $OUT_LATEST）"

if [ "$FILLED" -eq 0 ]; then
  # 抓不到任何日期最常見的原因就是設定檔沒登入：Facebook 對未登入的請求只回登入頁。
  # 這裡一定要留下可照著做的指令，否則排程只會安靜地每天產生一份空檔。
  log "0 列有日期 → 幾乎一定是這個設定檔沒登入 Facebook。請在有畫面的終端機跑一次："
  log "    node scripts/fetch-fb-posts.mjs --login --profile \"$PROFILE\""
  exit 2
fi

# 只有真的把新資料寫回試算表時才觸發同步：沒寫回的話，伺服器重讀試算表也不會有新東西。
if [ "$WRITE_SHEET" -eq 1 ]; then
  PORT="${PORT:-8787}"
  CURL_ARGS=(-sf -m 10 -X POST "http://127.0.0.1:$PORT/api/v1/sync")
  if [ -n "${LY_SYNC_TOKEN:-}" ]; then
    CURL_ARGS+=(-H "x-sync-token: $LY_SYNC_TOKEN")
  fi
  if curl "${CURL_ARGS[@]}" >/dev/null 2>&1; then
    log "已觸發本機伺服器（:$PORT）重新同步，畫面會拿到剛寫回試算表的貼文"
  else
    log "本機伺服器（:$PORT）沒有回應，略過觸發同步；它下次同步時會讀到同一份試算表"
  fi
fi

log "=== 結束 ==="
exit 0
