#!/usr/bin/env bash
#
# 更新「縣市」分頁的靜態資料（人口、選舉、地圖輪廓）＝ news / 選舉一年才動一次，人口每個月動。
#
# 做三件事：
#   1. 把兩個轉存 repo（中選會、內政部戶政司）與縣市輪廓抓／更新到 ~/.cache/ly-county
#   2. 用**最新一個月**的人口月報重跑 scripts/build-county-stats.mjs
#   3. 體檢產出（22 縣市、面積合計、人口總數、人口密度前五名）——不合格就不要 commit
#
#   scripts/refresh-county-stats.sh                  # 自動挑轉存裡最新的一個月
#   scripts/refresh-county-stats.sh 2026/09          # 指定年月（轉存裡要有）
#   CACHE=/tmp/ly-county scripts/refresh-county-stats.sh
#
set -euo pipefail
cd "$(dirname "$0")/.."

CACHE="${CACHE:-$HOME/.cache/ly-county}"
CEC_URL="https://github.com/kiang/db.cec.gov.tw.git"
MOI_URL="https://github.com/kiang/data.moi.gov.tw.git"
GEO_URL="https://raw.githubusercontent.com/ronnywang/twgeojson/master/twcounty2010.json"
WANT="${1:-}"

log() { printf '\n== %s\n' "$*"; }

sync_repo() { # $1=目錄 $2=url
  if [ -d "$1/.git" ]; then
    log "更新 $1"
    git -C "$1" fetch -q --depth 1 origin && git -C "$1" reset -q --hard FETCH_HEAD
  else
    log "取得 $1（第一次會慢一點）"
    rm -rf "$1"
    git clone -q --depth 1 --filter=blob:none "$2" "$1"
  fi
}

mkdir -p "$CACHE"
sync_repo "$CACHE/cec" "$CEC_URL"
sync_repo "$CACHE/moi" "$MOI_URL"
if [ ! -s "$CACHE/twcounty2010.json" ]; then
  log "取得縣市輪廓"
  curl -sL -o "$CACHE/twcounty2010.json" "$GEO_URL"
fi

# 最新一個月：轉存裡的 raw/population/<年>/<月>/data.csv
if [ -n "$WANT" ]; then
  MONTH="$WANT"
else
  MONTH="$(find "$CACHE/moi/raw/population" -mindepth 3 -maxdepth 3 -name data.csv \
    | sed -E 's#.*/population/([0-9]+)/([0-9]+)/data\.csv#\1/\2#' | sort -t/ -k1,1n -k2,2n | tail -1)"
fi
MOI_CSV="$CACHE/moi/raw/population/$MONTH/data.csv"
[ -s "$MOI_CSV" ] || { echo "轉存裡沒有 ${MONTH} 的人口月報（${MOI_CSV}）；轉存現有年份：$(ls "$CACHE/moi/raw/population" | tr '\n' ' ')"; exit 1; }

log "重跑 build-county-stats.mjs（${MONTH}）"
node scripts/build-county-stats.mjs \
  --cec "$CACHE/cec" \
  --moi "$MOI_CSV" \
  --geo "$CACHE/twcounty2010.json"

log "體檢"
node -e '
const cs = JSON.parse(require("node:fs").readFileSync("server/county-stats.json", "utf8"));
const bad = [];
if (cs.counties.length !== 22) bad.push(`縣市數 ${cs.counties.length}（預期 22）`);
for (const c of cs.counties) {
  if (!(c.area_km2 > 0)) bad.push(`${c.county} 沒有面積`);
  if (!(c.population > 0)) bad.push(`${c.county} 沒有人口`);
}
const total = cs.counties.reduce((s, c) => s + c.area_km2, 0);
if (total < 36000 || total > 36500) bad.push(`面積合計 ${total}（預期 3.6 萬上下）`);
const pop = cs.counties.reduce((s, c) => s + c.population, 0);
const top = [...cs.counties].sort((a, b) => b.population / b.area_km2 - a.population / a.area_km2).slice(0, 5);
console.log(`  人口統計月：${cs.population_month}`);
console.log(`  全國人口：${pop.toLocaleString("en-US")} 人（${cs.counties.length} 縣市）`);
console.log(`  面積合計：${total.toLocaleString("en-US")} km²・全國密度：${Math.round(pop / total)} 人/km²`);
console.log(`  密度前五：${top.map((c) => `${c.county} ${Math.round(c.population / c.area_km2)}`).join("、")}`);
if (bad.length) { console.error("  ✗ " + bad.join("\n  ✗ ")); process.exit(1); }
console.log("  ✓ 體檢通過");
'

cat <<'EOF'

下一步：
  1. npm test && npm --prefix web test        （資料檔不變量＋render smoke）
  2. 重啟本機伺服器（queries.mjs 會把 county-stats.json 快取在記憶體，不重啟不會生效）
  3. git add server/*.json && git commit      （五個產出檔一起進版控）
EOF
