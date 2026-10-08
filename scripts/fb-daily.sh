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
#   LY_SHEET_WEBAPP_URL     Apps Script Web App 的 /exec 網址（寫回試算表用；見 apps-script/）
#   LY_SHEET_TOKEN          同一個 Web App 的共享密鑰（兩者都有才會寫回）
#   LY_FB_SERVICE_ACCOUNT   服務帳號金鑰；沒有 Web App 設定時才用這條（檔案存在才會 --write-sheet）
#   LY_FB_DATA_PUSH         要不要把抓取結果推上遠端資料分支（預設 1；設 0 關掉）
#   LY_FB_DATA_BRANCH       資料分支名稱（預設 fb-data）
#   LY_NOTIFY               要不要送 Telegram 成敗通知（預設 1；設 0 關掉）
#   LY_NOTIFY_ENV           通知憑證檔（預設 ~/.ly-dashboard/notify.env）
#   LY_SYNC_SCOPE           寫回表之後要觸發哪一種同步（預設 social：只重讀整理表）
#   LY_SYNC_TOKEN           本機伺服器有設 token 時，觸發同步要帶同一組
#   LY_FB_LOG_DIR           輸出目錄（log／CSV／鎖；預設 <repo>/.cache）。測試要用免洗目錄，見下面 LOG_DIR
#
# 寫回用的網址與密鑰放在 ~/.ly-dashboard/sheet.env（repo 外、權限 600），下面會自動載入。
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT" || exit 1

# 寫回試算表的密鑰檔（不在版控裡；沒有這個檔就只產生本機 CSV）
if [ -f "$HOME/.ly-dashboard/sheet.env" ]; then
  set -a
  # shellcheck disable=SC1090
  . "$HOME/.ly-dashboard/sheet.env"
  set +a
fi

# launchd 不會載入使用者的 shell 設定，把常見的 node 位置補進 PATH
export PATH="/opt/homebrew/bin:/usr/local/bin:$HOME/.local/bin:$PATH"

# 輸出目錄：預設 .cache，但可以用 LY_FB_LOG_DIR 換掉 —— 測試要用免洗目錄放「自己的鎖」，
# 否則測試在 finally 刪掉 .cache/fb-daily.lock 時，會把正在跑的那一輪的鎖一起偷走
# （2026-10-07 實際發生：08:00 的每日抓取跑到一半，測試把它的鎖刪了，之後就沒有東西擋第二輪）。
LOG_DIR="${LY_FB_LOG_DIR:-$ROOT/.cache}"
mkdir -p "$LOG_DIR"
LOG="$LOG_DIR/fb-daily.log"

PROFILE="${LY_FB_PROFILE:-$HOME/.ly-dashboard/fb-profile}"
KEY="${LY_FB_SERVICE_ACCOUNT:-$ROOT/service_account.json}"
STAMP="$(date '+%Y-%m-%d')"
OUT_DATED="$LOG_DIR/posts-$STAMP.csv"
OUT_LATEST="$LOG_DIR/posts-latest.csv"
# 貼文層級（一列一則貼文）：整理表只收最新一則，這一份把同一頁的其他貼文也留下來，
# 讓「機關」頁能把委員貼文歸到機關（只比對 60 字摘要幾乎比對不到）。
OUT_DETAIL="$LOG_DIR/posts-detail-$STAMP.csv"
OUT_DETAIL_LATEST="$LOG_DIR/posts-detail-latest.csv"

log() { printf '%s %s\n' "$(date '+%Y-%m-%dT%H:%M:%S%z')" "$*" >>"$LOG"; }

# 成敗通知（Telegram）：成功、失敗都送一則，設定見 scripts/notify-telegram.sh。
# 通知失敗只記 log —— 通知不該讓每日排程失敗。LY_NOTIFY=0 可整段關掉。
STARTED_AT="$(date '+%Y-%m-%d %H:%M')"
notify() {
  [ "${LY_NOTIFY:-1}" = "1" ] || { log "（LY_NOTIFY=0，不送通知）"; return 0; }
  "$ROOT/scripts/notify-telegram.sh" "$1" >>"$LOG" 2>&1 || log "（通知送出失敗，不影響本輪）"
}
notify_fail() {
  notify "❌ 立委粉專每日更新失敗（${STARTED_AT}）
原因：$1
修復：$2
log：${LOG}"
}

log "=== 開始（profile=${PROFILE}）==="

# ---- 抓取鎖：同時只允許一輪 ------------------------------------------------------------
# 每輪 25–35 分鐘且獨佔 Chrome 設定檔（profile）。兩輪同時跑會互相搶，後啟動的那一輪會在幾秒內
# 失敗（2026-10-06 08:00 的每日排程就是這樣被 07:58 的另一輪擠掉，2 秒內 exit 1）。
# 所以：搶不到鎖就跳過並通知，不要失敗；超過 LY_FB_LOCK_STALE_MIN 分鐘的鎖視為殘留（上次被中斷）直接接手。
# LY_FB_LOCK=0 可以關掉這個鎖（測試或刻意並行時用）。
LOCK_DIR="$LOG_DIR/fb-daily.lock"
LOCK_STALE_MIN="${LY_FB_LOCK_STALE_MIN:-90}"
if [ "${LY_FB_LOCK:-1}" = "1" ]; then
  acquired=0
  if mkdir "$LOCK_DIR" 2>/dev/null; then
    acquired=1
  elif [ -n "$(find "$LOCK_DIR" -maxdepth 0 -mmin "+${LOCK_STALE_MIN}" 2>/dev/null)" ]; then
    log "發現殘留的抓取鎖（超過 ${LOCK_STALE_MIN} 分鐘）→ 接手"
    rm -rf "$LOCK_DIR"
    mkdir "$LOCK_DIR" 2>/dev/null && acquired=1
  fi
  if [ "$acquired" -ne 1 ]; then
    log "已有另一輪抓取在跑（鎖：${LOCK_DIR}）→ 本輪跳過"
    notify "⏭ 立委粉專每日更新跳過（${STARTED_AT}）
原因：已經有另一輪在抓（同時只能有一輪，否則兩輪會搶 Chrome 設定檔而失敗）
強制重跑：把 ${LOCK_DIR} 刪掉再跑一次，或設 LY_FB_LOCK=0"
    exit 0
  fi
  printf '%s\n' "${STARTED_AT}" >"$LOCK_DIR/started_at"
  trap 'rm -rf "$LOCK_DIR"' EXIT
fi

NODE="$(command -v node || true)"
if [ -z "$NODE" ]; then
  log "找不到 node（PATH=${PATH}）；中止"
  notify_fail "找不到 node（PATH=${PATH}）" "在 launchd 的 wrapper 裡補 PATH（見本檔第 30 行附近）"
  exit 1
fi

# 先檢查 playwright-core，省下「跑了半小時才發現沒裝」這種事
if ! "$NODE" -e "import('playwright-core').then(()=>{},()=>process.exit(1))" >/dev/null 2>&1; then
  log "找不到 playwright-core：請先在 $ROOT 執行 npm i -D playwright-core；中止"
  notify_fail "找不到 playwright-core" "cd $ROOT && npm i -D playwright-core"
  exit 1
fi

# 驗證報告預設會寫進版控的 docs/fb-verification-<日期>.csv；排程每天跑的話會一直長新檔案，
# 所以這裡改寫到 .cache/（已 gitignore）。要留哪一天的證據再自己搬進 docs/。
ARGS=(--verify --verify-out "$LOG_DIR/fb-verification-$STAMP.csv" --profile "$PROFILE" --out "$OUT_DATED" --detail-out "$OUT_DETAIL")
WRITE_SHEET=0
if [ -f "$KEY" ]; then
  ARGS+=(--write-sheet --key "$KEY")
  WRITE_SHEET=1
else
  log "沒有服務帳號金鑰（${KEY}）→ 只產生本機 CSV，不寫回試算表"
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
  log "抓取失敗（exit ${STATUS}）；中止"
  notify_fail "抓取腳本失敗（exit ${STATUS}）" "看 ${LOG} 最後幾行；常見原因是 Chrome 設定檔被另一輪佔用"
  exit 1
fi

# fetch-fb-posts.mjs 收尾會印「完成：N 列有日期、M 列留空」，用那一行當作成功與否的判準。
# 不直接數 CSV 的原因：CSV 欄位可能有引號包住的逗號，naive 切欄會數錯。
FILLED="$(printf '%s\n' "$OUTPUT" | sed -n 's/.*完成：\([0-9][0-9]*\) 列有日期.*/\1/p' | tail -1)"
if [ -z "$FILLED" ]; then
  log "抓不到「完成：…列有日期」的統計，無法確認結果；視為失敗"
  notify_fail "抓不到「完成：…列有日期」的統計" "看 ${LOG} 最後幾行"
  exit 1
fi

cp -f "$OUT_DATED" "$OUT_LATEST"
[ -f "$OUT_DETAIL" ] && cp -f "$OUT_DETAIL" "$OUT_DETAIL_LATEST"
DETAIL_LINE=""
if [ -f "$OUT_DETAIL" ]; then
  DETAIL_ROWS=$(( $(wc -l <"$OUT_DETAIL") - 1 ))
  DETAIL_LINE="；貼文層級 ${DETAIL_ROWS} 則（${OUT_DETAIL}）"
fi
log "完成：$FILLED 列有日期（${OUT_DATED}，另存一份 ${OUT_LATEST}）${DETAIL_LINE}"

if [ "$FILLED" -eq 0 ]; then
  # 抓不到任何日期最常見的原因就是設定檔沒登入：Facebook 對未登入的請求只回登入頁。
  # 這裡一定要留下可照著做的指令，否則排程只會安靜地每天產生一份空檔。
  log "0 列有日期 → 幾乎一定是這個設定檔沒登入 Facebook。請在有畫面的終端機跑一次："
  log "    node scripts/fetch-fb-posts.mjs --login --profile \"$PROFILE\""
  notify_fail "0 列有日期 → 幾乎一定是這個設定檔沒登入 Facebook" "node scripts/fetch-fb-posts.mjs --login --profile \"$PROFILE\"（要在有畫面的終端機跑）"
  exit 2
fi

# 寫回試算表：優先用 Apps Script Web App（LY_SHEET_WEBAPP_URL＋LY_SHEET_TOKEN），
# 其次是抓取腳本自己的服務帳號模式（--write-sheet --key，需要有金鑰檔）。
WRITTEN=0
if [ -n "${LY_SHEET_WEBAPP_URL:-}" ] && [ -n "${LY_SHEET_TOKEN:-}" ]; then
  if PUSH_OUT="$("$NODE" scripts/push-posts-to-sheet.mjs "$OUT_DATED" 2>&1)"; then
    printf '%s\n' "$PUSH_OUT" >>"$LOG"
    WRITTEN=1
  else
    printf '%s\n' "$PUSH_OUT" >>"$LOG"
    log "Web App 寫回失敗（見上面幾行）；本機 CSV 仍在 ${OUT_DATED}，可手動重跑：node scripts/push-posts-to-sheet.mjs \"$OUT_DATED\""
  fi
elif [ "$WRITE_SHEET" -eq 1 ]; then
  WRITTEN=1
fi

# 資料也推一份到遠端資料分支（預設 fb-data，比照 news-data）：遠端讀得到、也多一份備份。
# 失敗只記 log，不讓每日排程整個失敗（本機 CSV 還在）。設 LY_FB_DATA_PUSH=0 可關掉。
if [ "${LY_FB_DATA_PUSH:-1}" = "1" ]; then
  if DATA_OUT="$("$NODE" scripts/push-fb-data.mjs "$OUT_DATED" --detail "$OUT_DETAIL" 2>&1)"; then
    printf '%s\n' "$DATA_OUT" >>"$LOG"
  else
    printf '%s\n' "$DATA_OUT" >>"$LOG"
    log "推 ${LY_FB_DATA_BRANCH:-fb-data} 分支失敗（見上面幾行）；本機 CSV 仍在 ${OUT_DATED}"
  fi
fi

# 只有真的把新資料寫回試算表時才觸發同步：沒寫回的話，伺服器重讀試算表也不會有新東西。
SYNC_LINE="未觸發（沒有寫回試算表）"
if [ "$WRITTEN" -eq 1 ]; then
  PORT="${PORT:-8787}"
  # 只觸發 social 範圍：這一輪改動的是 Google 整理表，跑「全部」等於白等 13 分鐘
  # （新聞一個階段就 763 秒）。完整同步交給伺服器自己的 24 小時排程。
  SCOPE="${LY_SYNC_SCOPE:-social}"
  CURL_ARGS=(-sf -m 10 -X POST "http://127.0.0.1:$PORT/api/v1/sync?scope=${SCOPE}")
  if [ -n "${LY_SYNC_TOKEN:-}" ]; then
    CURL_ARGS+=(-H "x-sync-token: $LY_SYNC_TOKEN")
  fi
  if curl "${CURL_ARGS[@]}" >/dev/null 2>&1; then
    log "已觸發本機伺服器（:${PORT}，範圍 ${SCOPE}）重新同步，畫面會拿到剛寫回試算表的貼文"
    SYNC_LINE="已觸發（${SCOPE}）"
  else
    log "本機伺服器（:${PORT}）沒有回應，略過觸發同步；它下次同步時會讀到同一份試算表"
    SYNC_LINE="伺服器沒回應（:${PORT}），下次同步會讀到"
  fi
fi

# 收尾通知：把「抓到幾列／寫回結果／資料分支／同步」一次講完，成功失敗都送。
WRITE_LINE="$(printf '%s\n' "${PUSH_OUT:-}" | sed -n 's/^\[寫回\] 工作表[^：]*：//p' | tail -1)"
if [ -z "$WRITE_LINE" ]; then
  if [ -n "${LY_SHEET_WEBAPP_URL:-}" ] && [ -n "${LY_SHEET_TOKEN:-}" ]; then
    WRITE_LINE="❌ 寫回失敗（看 log）"
  else
    WRITE_LINE="（沒設定 Web App，只產生本機 CSV）"
  fi
fi
DATA_LINE="$(printf '%s\n' "${DATA_OUT:-}" | sed -n 's/^\[fb-data\] //p' | tail -1 | sed -E 's/^(已推上 )?[A-Za-z0-9._-]+：//')"
if [ -z "$DATA_LINE" ]; then
  if [ "${LY_FB_DATA_PUSH:-1}" = "1" ]; then
    DATA_LINE="❌ 推送失敗（看 log）"
  else
    DATA_LINE="（已用 LY_FB_DATA_PUSH=0 關掉）"
  fi
fi
TOTAL_ROWS="$(awk 'END { print NR - 1 }' "$OUT_DATED" 2>/dev/null)"
MINUTES=$(( SECONDS / 60 ))
notify "✅ 立委粉專每日更新完成（${STARTED_AT}，約 ${MINUTES} 分）
· 有日期 ${FILLED}${TOTAL_ROWS:+ / ${TOTAL_ROWS}} 列
· 寫回整理表：${WRITE_LINE:-（未設定 Web App，只產生本機 CSV）}
· 資料分支 ${LY_FB_DATA_BRANCH:-fb-data}：${DATA_LINE:-（未推，設定 LY_FB_DATA_PUSH=0？）}
· 本機同步：${SYNC_LINE}"

log "=== 結束 ==="
exit 0
