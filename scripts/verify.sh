#!/usr/bin/env bash
# 一鍵驗證：測試 → ingestion → API 端點 → 前端靜態檔
#
# 用法：
#   bash scripts/verify.sh           # 預設：跳過外部來源（bills/news/social），約 15 秒
#   bash scripts/verify.sh --full    # 完整同步（含 g0v／Google 新聞／試算表），約 4 分鐘
#
# 外部來源預設跳過的原因（M1）：新聞階段會對 Google 發 113 次請求，
# 每跑一次驗證就打一次第三方並不禮貌；需要端到端時再明確加 --full。
set -euo pipefail
cd "$(dirname "$0")/.."

PORT="${PORT:-8799}"
export PORT
export LY_DB="$(mktemp -d)/verify.db"

MODE="fast"
[ "${1:-}" = "--full" ] && MODE="full"
export LY_SKIP_BILLS=1 LY_SKIP_NEWS=1 LY_SKIP_SOCIAL=1
if [ "$MODE" = "full" ]; then
  unset LY_SKIP_BILLS LY_SKIP_NEWS LY_SKIP_SOCIAL
  echo "模式：完整同步（會呼叫 g0v、Google 新聞 113 次、Google 試算表）"
else
  echo "模式：快速（跳過外部來源；要完整請加 --full）"
fi

echo
echo "=== 1) 後端測試（真實 API fixture，不打網路）"
node --test test/ | grep -E "^ℹ (tests|pass|fail)"

echo
echo "=== 1b) 前端型別檢查 + 煙霧測試"
if [ -d web/node_modules ]; then
  (cd web && npm test 2>&1 | grep -E "全部通過|通過 [0-9]+ 項|失敗")
else
  echo "  web/node_modules 不存在，略過（先在 web/ 執行 npm install）"
fi

echo
echo "=== 2) ingestion（獨立臨時 DB）"
node server/ingest.mjs | python3 -c '
import sys, json
d = json.load(sys.stdin)
print("status:", d["status"], "| 耗時:", round(d.get("duration_ms", 0) / 1000, 1), "秒")
print("名錄:", json.dumps(d["stats"], ensure_ascii=False))
for stage in ("bills", "social", "news"):
    block = d.get(stage, {})
    detail = block.get("bills") or block.get("accounts") or block.get("added") or block.get("reason") or ""
    print("%s: %s %s" % (stage, block.get("status"), detail))
'
echo
echo "=== 3) 第二次 ingestion（名錄內容未變應為 skipped）"
node server/ingest.mjs | python3 -c 'import sys,json;print("status:",json.load(sys.stdin)["status"])'

echo
echo "=== 4) API 端點"
node server/index.mjs --no-scheduler &
API_PID=$!
trap 'kill $API_PID 2>/dev/null || true' EXIT
for _ in $(seq 1 40); do curl -sf "http://127.0.0.1:${PORT}/api/v1/health" >/dev/null && break; sleep 0.3; done

curl -s "http://127.0.0.1:${PORT}/api/v1/health" | python3 -c 'import sys,json;d=json.load(sys.stdin);print("health:",d["ok"],"| stale:",d["meta"]["stale"],"| db:",json.dumps(d["db"],ensure_ascii=False));print("datasets:",json.dumps({k:v.get("count") for k,v in d["datasets"].items()},ensure_ascii=False))'
curl -s "http://127.0.0.1:${PORT}/api/v1/meta" | python3 -c 'import sys,json;d=json.load(sys.stdin);print("current:",json.dumps(d["current"],ensure_ascii=False),"| sessions:",[s["id"] for s in d["terms"][0]["sessions"]])'
curl -s "http://127.0.0.1:${PORT}/api/v1/committees" | python3 -c 'import sys,json;d=json.load(sys.stdin);print("committees:",d["count"],"| 第一個:",d["items"][0]["id"],d["items"][0]["count"],"席")'

print_legislators() { python3 -c 'import sys,json;d=json.load(sys.stdin);print("total:",d["total"],"session:",d["meta"]["session"])'; }
printf "legislators?(預設)                    "; curl -s "http://127.0.0.1:${PORT}/api/v1/legislators" | print_legislators
for qs in "convener=1" "session=11-1" "session=all" "committee=內政委員會" "q=雲林"; do
  printf "legislators?%-25s " "$qs"
  curl -s -G --data-urlencode "$qs" "http://127.0.0.1:${PORT}/api/v1/legislators" | print_legislators
done

# H1 的回歸檢查：離職委員一定要用 session=all 才查得到（前端 legislatorDetailUrl 就是這樣送）
FORMER=$(curl -s "http://127.0.0.1:${PORT}/api/v1/legislators?session=all" | python3 -c 'import sys,json;d=json.load(sys.stdin);print(next((i["id"] for i in d["items"] if i["former"]), ""))')
if [ -n "$FORMER" ]; then
  printf "legislators?id=%s(離職,無 session)  " "$FORMER"
  curl -s "http://127.0.0.1:${PORT}/api/v1/legislators?id=${FORMER}" | python3 -c 'import sys,json;print(json.load(sys.stdin)["count"],"筆（預期 0：不帶 session 查不到）")'
  printf "legislators?id=%s&session=all     " "$FORMER"
  curl -s "http://127.0.0.1:${PORT}/api/v1/legislators?id=${FORMER}&session=all" | python3 -c 'import sys,json;d=json.load(sys.stdin);print(d["count"],"筆",[i["name"] for i in d["items"]])'
else
  echo "（本次資料沒有離職委員可測）"
fi

echo
echo "--- 排行榜（新功能）"
curl -s "http://127.0.0.1:${PORT}/api/v1/rankings?limit=5" | python3 -c '
import sys, json
d = json.load(sys.stdin)
for key in ("news", "facebook", "bills"):
    board = d["boards"].get(key)
    if not board or not board.get("items"):
        print("  %s: （無資料；快速模式會跳過外部來源，完整資料請用 --full）" % key)
        continue
    top = board["items"][:3]
    names = "、".join("%d.%s %s" % (i["rank"], i["legislator"]["name"], i["value_display"]) for i in top)
    print("  %s: %d 筆｜%s" % (key, len(board["items"]), names))
'

echo
echo "--- 其他端點"
for p in "bills?limit=3" "topics" "activity?limit=3" "news?limit=3" "changes?limit=3" "sync-runs?limit=3"; do
  printf "  /api/v1/%-16s → " "${p%%\?*}"
  curl -s "http://127.0.0.1:${PORT}/api/v1/$p" | python3 -c 'import sys,json;d=json.load(sys.stdin);print(d.get("total", d.get("count")), "筆")'
done
printf "  POST /api/v1/sync?scope=roster → "
curl -s -o /tmp/verify-sync.json -w "HTTP %{http_code} " -X POST "http://127.0.0.1:${PORT}/api/v1/sync?scope=roster"
python3 -c 'import json;d=json.load(open("/tmp/verify-sync.json"));print(d["message"],"| scope:",d["scope"])'

echo
echo "=== 5) 前端靜態檔與 SPA fallback"
for path in "/" "/legislators" "/bills" "/rankings"; do
  printf "  GET %-14s → " "$path"
  curl -s -o /dev/null -w "HTTP %{http_code} %{content_type}\n" "http://127.0.0.1:${PORT}${path}"
done

echo
echo "全部驗證完成（模式：${MODE}）。"
