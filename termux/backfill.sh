#!/data/data/com.termux/files/usr/bin/bash
# 回補近半年新聞（scripts/backfill-news.mjs）：跑 60 分鐘，時間到就停；再點一次捷徑會從停下的地方接續。
# 伺服器可以同時開著（另一個捷徑「立委觀測站」），不要同時開兩個回補。
cd "$(dirname "$0")/.." || exit 1

# 防止手機休眠時 Termux 被系統殺掉；結束時放開
command -v termux-wake-lock >/dev/null && termux-wake-lock
trap 'command -v termux-wake-unlock >/dev/null && termux-wake-unlock' EXIT

node scripts/backfill-news.mjs --status
echo
node scripts/backfill-news.mjs --minutes "${BACKFILL_MINUTES:-60}"
echo
node scripts/backfill-news.mjs --status
echo
echo "按 Enter 關閉（沒跑完的話，再點一次「回補新聞」捷徑就會接續）"
read -r
