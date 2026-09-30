#!/usr/bin/env bash
# 一鍵驗證：測試 → 真實 ingest → 起 API → 打端點 → 收工
# 用法：bash scripts/verify.sh
set -euo pipefail
cd "$(dirname "$0")/.."
PORT="${PORT:-8799}"
export PORT
TMP_DB="$(mktemp -d)/verify.db"
export LY_DB="$TMP_DB"

echo "=== 1) 後端單元 + 整合測試（用真實 API fixture，不打網路）"
node --test test/ | tail -8

echo
echo "=== 1b) 前端型別檢查 + 煙霧測試（四態、URL 狀態、錯誤處理）"
if [ -d web/node_modules ]; then
  (cd web && npm test 2>&1 | tail -4)
else
  echo "  web/node_modules 不存在，略過（先在 web/ 執行 npm install）"
fi

echo
echo "=== 2) 對真實立法院 API 做一次 ingestion（獨立臨時 DB）"
node server/ingest.mjs | python3 -c 'import sys,json;d=json.load(sys.stdin);print("status:",d["status"]);print("stats:",json.dumps(d["stats"],ensure_ascii=False));print("warnings:",d["warnings"])'

echo
echo "=== 3) 第二次 ingestion（應為 skipped，sha256 未變）"
node server/ingest.mjs | python3 -c 'import sys,json;d=json.load(sys.stdin);print("status:",d["status"])'

echo
echo "=== 4) 起 API 並驗證端點"
node server/index.mjs --no-scheduler &
API_PID=$!
trap 'kill $API_PID 2>/dev/null || true' EXIT
for _ in $(seq 1 30); do curl -sf "http://127.0.0.1:${PORT}/api/v1/health" >/dev/null && break; sleep 0.3; done

curl -s "http://127.0.0.1:${PORT}/api/v1/health" | python3 -c 'import sys,json;d=json.load(sys.stdin);print("health.ok:",d["ok"],"| stale:",d["meta"]["stale"],"| db:",json.dumps(d["db"],ensure_ascii=False))'
curl -s "http://127.0.0.1:${PORT}/api/v1/meta" | python3 -c 'import sys,json;d=json.load(sys.stdin);print("current:",json.dumps(d["current"],ensure_ascii=False),"| sessions:",[s["id"] for s in d["terms"][0]["sessions"]])'
curl -s "http://127.0.0.1:${PORT}/api/v1/committees" | python3 -c 'import sys,json;d=json.load(sys.stdin);print("committees:",d["count"],"| 第一個:",d["items"][0]["id"],d["items"][0]["count"],"席")'
for qs in "convener=1" "session=11-1" "session=all" "committee=內政委員會" "q=雲林"; do
  printf "legislators?%-26s " "$qs"
  curl -s -G --data-urlencode "$qs" "http://127.0.0.1:${PORT}/api/v1/legislators" | python3 -c 'import sys,json;d=json.load(sys.stdin);print("total:",d["total"],"session:",d["meta"]["session"])'
done

echo
echo "=== 5) 前端靜態檔"
if [ -f web/dist/index.html ]; then
  curl -s -o /dev/null -w "GET / → HTTP %{http_code}\n" "http://127.0.0.1:${PORT}/"
else
  echo "web/dist 尚未建置（在 web/ 執行 npm run build）"
fi

echo
echo "全部驗證完成。"
