#!/usr/bin/env bash
#
# 立委觀測站「這台 VM 準備好了沒」檢查（Linux）。可重複執行，只讀不寫（除了 --live 會打來源）。
#
#   deploy/linux/verify-vm.sh                 # 環境＋服務＋站台（不打外部來源）
#   deploy/linux/verify-vm.sh --live          # 另外真的打一次立法院／g0v／Google 新聞（TLS 與 WAF 實測）
#   deploy/linux/verify-vm.sh --root /opt/ly-dashboard --port 8787 --with-fb
#
# 為什麼要有 --live：程式碼的 TLS legacy 修補與具名 UA 是 Node/OpenSSL 層的事，
# 「理論上跨平台一致」不等於「這台 VM 連得到」——雲端／機房的出口 IP 也可能被 WAF 或來源擋。
# 這一段就是第一天要跑的那一次實測。
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
HOST="127.0.0.1"
PORT="8787"
WITH_FB=0
LIVE=0

while [ $# -gt 0 ]; do
  case "$1" in
    --root) ROOT="$2"; shift 2 ;;
    --host) HOST="$2"; shift 2 ;;
    --port) PORT="$2"; shift 2 ;;
    --with-fb) WITH_FB=1; shift ;;
    --live) LIVE=1; shift ;;
    -h|--help) sed -n '2,14p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "不認識的參數：$1" >&2; exit 2 ;;
  esac
done

PASS=0; FAIL=0; WARN=0
ok()   { printf '✅ %s\n' "$*"; PASS=$((PASS+1)); }
bad()  { printf '❌ %s\n' "$*"; FAIL=$((FAIL+1)); }
warn() { printf '🔶 %s\n' "$*"; WARN=$((WARN+1)); }

say() { printf '\n── %s ──\n' "$*"; }

# ---------------------------------------------------------------- 1. 作業環境
say "作業環境"
ok "系統：$(uname -srm)"
if command -v systemctl >/dev/null; then
  ok "systemd：$(systemctl --version | head -1)"
  [ -d /run/systemd/system ] || warn "systemd 不是 PID 1（容器？）→ 服務管理要用其他方式（見 docs/DEPLOY-VM.md 附錄）"
else
  bad "沒有 systemctl（這台不會是 systemd 系統）"
fi

NODE="$(command -v node || echo "")"
if [ -z "$NODE" ]; then
  bad "找不到 node"
else
  ver="$($NODE -v)"
  if $NODE -e 'const [a,b]=process.versions.node.split(".").map(Number); process.exit(a>22||(a===22&&b>=13)?0:1)'; then
    ok "node ${ver}（≥22.13，node:sqlite 免旗標）"
  elif $NODE -e 'const [a,b]=process.versions.node.split(".").map(Number); process.exit(a>22||(a===22&&b>=5)?0:1)'; then
    warn "node ${ver}：22.5–22.12 需要 --experimental-sqlite（install.sh 會自動加 NODE_OPTIONS）"
  else
    bad "node $ver 太舊（要 ≥22.5，建議 ≥22.13）"
  fi
  if $NODE -e 'const {DatabaseSync}=require("node:sqlite"); const d=new DatabaseSync(":memory:"); d.prepare("select 1").get()' 2>/dev/null; then
    ok "node:sqlite 可用（不用編原生模組）"
  else
    bad "node:sqlite 載入失敗（版本不足或需要 --experimental-sqlite）"
  fi
fi

for tool in git curl tar unzip; do
  command -v "$tool" >/dev/null && ok "${tool}：$(command -v "$tool")" || warn "沒有 ${tool}（跑 ingest／更新程式或解壓縮時會用到）"
done

# 磁碟與記憶體（DB 現在 160 MB 上下、news 累積 180 天、.cache 也有 150 MB）
avail_kb=$(df -Pk "$ROOT" | awk 'NR==2{print $4}')
avail_gb=$((avail_kb / 1024 / 1024))
if [ "$avail_gb" -ge 10 ]; then ok "磁碟可用 ${avail_gb} GB（${ROOT}）"; elif [ "$avail_gb" -ge 3 ]; then warn "磁碟只剩 ${avail_gb} GB，建議 ≥10 GB"; else bad "磁碟只剩 ${avail_gb} GB"; fi
mem_mb=$(awk '/MemTotal/{printf "%d", $2/1024}' /proc/meminfo 2>/dev/null || echo 0)
if [ "$mem_mb" -ge 1800 ]; then ok "記憶體 ${mem_mb} MB"; elif [ "$mem_mb" -ge 900 ]; then warn "記憶體 ${mem_mb} MB：可用，但 /api/v1/funds 這種 CPU／記憶體一起吃的工作會慢"; else bad "記憶體只有 ${mem_mb} MB"; fi
ncpu=$(nproc 2>/dev/null || echo "?")
[ "$ncpu" != "?" ] && [ "$ncpu" -ge 2 ] && ok "vCPU ${ncpu} 顆" || warn "vCPU ${ncpu} 顆：1 顆可跑，但 /api/v1/funds 是單執行緒 CPU 密集（實測每個請求要掃約 7.8 萬列），超賣的 vCPU 會讓它超過前端 15 秒逾時"

# 時間（排程與資料日期都靠它）
if command -v timedatectl >/dev/null; then
  tz="$(timedatectl show -p Timezone --value 2>/dev/null || echo '?')"
  synced="$(timedatectl show -p NTPSynchronized --value 2>/dev/null || echo '?')"
  case "$tz" in Asia/Taipei) ok "時區 $tz";; *) warn "時區是 ${tz}（建議 Asia/Taipei；日期判斷與 log 對時會比較好讀）";; esac
  [ "$synced" = "yes" ] && ok "NTP 已同步" || warn "NTP 未同步（NTPSynchronized=${synced}）：抓取排程與 sync_runs 時間會飄"
fi

# ---------------------------------------------------------------- 2. 專案與資料
say "專案與資料"
[ -f "$ROOT/server/index.mjs" ] && ok "專案目錄 $ROOT" || bad "$ROOT 不是 ly-dashboard（找不到 server/index.mjs）"
[ -f "$ROOT/web/dist/index.html" ] && ok "前端建置產物存在（web/dist）" || bad "沒有 web/dist → 先 npm --prefix web run build"
if [ -f "$ROOT/data/ly.db" ]; then
  size_mb=$(( $(stat -c%s "$ROOT/data/ly.db") / 1024 / 1024 ))
  ok "資料庫 data/ly.db（${size_mb} MB）"
  "$NODE" -e '
    const {DatabaseSync}=require("node:sqlite");
    const db=new DatabaseSync(process.argv[1]);
    const t=db.prepare("SELECT COUNT(*) n FROM sqlite_master WHERE type='"'"'table'"'"'").get().n;
    const runs=db.prepare("SELECT COUNT(*) n FROM sync_runs").get().n;
    const posts=db.prepare("SELECT MAX(post_date) m FROM social_posts").get().m;
    console.log(`   資料表 ${t} 張、sync_runs ${runs} 筆、social_posts 最新 ${posts ?? "（無，粉專還沒抓過）"}`);
    console.log(`   journal_mode=${db.prepare("PRAGMA journal_mode").get().journal_mode}`);
  ' "$ROOT/data/ly.db" 2>&1 | sed 's/^/   /'
else
  warn "沒有 data/ly.db（伺服器可以空庫啟動，但要 node server/ingest.mjs 才有內容）"
fi
[ -d "$ROOT/.cache" ] && ok ".cache 存在（log 與抓取產物）" || warn "沒有 .cache（install.sh 會建）"

# 憑證（repo 外）
for f in "$HOME/.ly-dashboard/notify.env" "$HOME/.ly-dashboard/sheet.env"; do
  [ -f "$f" ] && ok "憑證檔 $(basename "$f")（權限 $(stat -c%a "$f")）" || warn "沒有 $f"
done
[ -d "$HOME/.ly-dashboard/fb-profile" ] && ok "Chrome 設定檔 fb-profile" || warn "沒有 ~/.ly-dashboard/fb-profile"

# ---------------------------------------------------------------- 3. 服務
say "systemd 服務"
for label in ly-dashboard-server ly-dashboard-fb-daily; do
  if systemctl list-unit-files "${label}.service" >/dev/null 2>&1 && systemctl cat "${label}.service" >/dev/null 2>&1; then
    state="$(systemctl is-active "${label}.service" 2>/dev/null || true)"
    en="$(systemctl is-enabled "${label}.service" 2>/dev/null || true)"
    [ "$state" = "active" ] && ok "${label}：active（enabled=${en}）" || { [ "$label" = "ly-dashboard-server" ] && bad "${label}：${state}（enabled=${en}）" || warn "${label}：${state}（oneshot，平常 inactive 是正常的）"; }
  else
    [ "$label" = "ly-dashboard-server" ] && bad "$label 未安裝" || warn "$label 未安裝（沒有抓粉專的需求就正常）"
  fi
done
systemctl list-timers ly-dashboard-fb-daily.timer --no-pager 2>/dev/null | sed -n '1,2p' | sed 's/^/   /'
journalctl -u ly-dashboard-server -n 5 --no-pager 2>/dev/null | tail -5 | sed 's/^/   /'

# 實際聽的埠（systemd 說在跑 ≠ 聽得到）
say "連接埠 $PORT"
if ss -ltn 2>/dev/null | grep -q ":$PORT "; then
  ok "有行程在聽 ${PORT}（$(ss -ltnp 2>/dev/null | grep ":$PORT " | head -1 | awk '{print $NF}' || echo '？')）"
else
  bad "沒有行程在聽 $PORT"
fi

# ---------------------------------------------------------------- 4. 站台
say "站台（HTTP）"
health="$(curl -sS --max-time 20 "http://$HOST:$PORT/api/v1/health" || true)"
if [ -z "$health" ]; then
  bad "/api/v1/health 沒有回應"
else
  echo "$health" | "$NODE" -e '
    let s=""; process.stdin.on("data",d=>s+=d).on("end",()=>{
      const h=JSON.parse(s);
      const line=(t,v)=>console.log(`   ${t}：${v}`);
      line("ok", h.ok); line("資料截止", h.meta?.fetched_at ?? "（尚未同步）"); line("stale", h.meta?.stale);
      line("名錄", h.db?.legislators ?? 0); line("貼文累計", h.db?.social_posts ?? 0); line("新聞", h.db?.news ?? 0);
      line("社群最新", h.social?.as_of ?? "（無）"); line("最後同步", (h.last_runs?.[0]?.dataset ?? "—") + " / " + (h.last_runs?.[0]?.status ?? ""));
      if (h.warnings?.length) line("警告", h.warnings.join("；"));
    });' 2>/dev/null || warn "health 回來的內容不是預期 JSON"
fi
for path in / /icon-192-v2.png /manifest.webmanifest; do
  code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 15 "http://$HOST:$PORT$path")"
  [ "$code" = "200" ] && ok "$path → 200" || bad "$path → $code"
done
code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 30 "http://$HOST:$PORT/api/v1/legislators")"
[ "$code" = "200" ] && ok "/api/v1/legislators → 200" || bad "/api/v1/legislators → $code"

# 同步 API 的保護（非 loopback 卻沒 token ＝ 任何人都能叫它抓資料）
if [ "$HOST" != "127.0.0.1" ] && [ "$HOST" != "localhost" ]; then
  code="$(curl -s -o /dev/null -w '%{http_code}' -X POST --max-time 15 "http://$HOST:$PORT/api/v1/sync")"
  case "$code" in
    403) ok "非 loopback 的 POST /sync 被擋（403，沒有 LY_SYNC_TOKEN）" ;;
    202) warn "非 loopback 且 POST /sync 回 202 → 任何人都能觸發同步；請設 LY_SYNC_TOKEN（見 docs/OPS.md）" ;;
    *)   warn "POST /sync 回 ${code}（預期 403 或 202）" ;;
  esac
fi

# 對外／HTTPS（PWA 需要安全來源）
if command -v tailscale >/dev/null; then
  ts="$(tailscale status 2>&1 | head -2 | tr '\n' ' ')"
  ok "tailscale：${ts:0:100}"
  tailscale serve status 2>&1 | head -3 | sed 's/^/   /'
else
  warn "沒裝 tailscale：手機／外部要連就得靠反向代理（Caddy／nginx）＋憑證，見 docs/DEPLOY-VM.md 第 5 節"
fi

# ---------------------------------------------------------------- 5. 粉專抓取的前置
if [ "$WITH_FB" = "1" ]; then
  say "粉專抓取前置"
  chrome=""
  for c in google-chrome google-chrome-stable chromium chromium-browser; do
    command -v "$c" >/dev/null && { chrome="$c"; break; }
  done
  [ -n "$chrome" ] && ok "Chrome：$("$chrome" --version 2>/dev/null || echo "$chrome")" || bad "找不到 Chrome／Chromium（playwright 用 channel: 'chrome'，一定要系統安裝的）"
  [ -d "$HOME/.ly-dashboard/fb-profile" ] && ok "fb-profile 存在（$(du -sh "$HOME/.ly-dashboard/fb-profile" 2>/dev/null | cut -f1)）" || bad "沒有 fb-profile → 抓取會 exit 2"
  if [ -n "$chrome" ]; then
    out="$("$NODE" -e '
      const {CONFIG}=await import(process.argv[1]+"/server/config.mjs");
      console.log(CONFIG.social.url);
    ' "$ROOT" 2>/dev/null)"
    [ -n "$out" ] && ok "整理表來源設定：${out:0:60}…" || warn "讀不到整理表來源設定"
  fi
  warn "機房 IP 抓 Facebook 比家用 IP 更容易被風控（驗證碼／登入失效）；第一週請每天看 .cache/fb-daily.log"
fi

# ---------------------------------------------------------------- 6. 實打來源（--live）
if [ "$LIVE" = "1" ]; then
  say "實打來源（--live；會真的連外，每個來源各一次）"
  "$NODE" --input-type=module -e '
    const ROOT = process.argv[1];
    const { CONFIG } = await import(ROOT + "/server/config.mjs");
    const { fetchJson } = await import(ROOT + "/server/fetch-ly.mjs");
    const probe = async (label, url, pick) => {
      const t0 = Date.now();
      try {
        const r = await fetchJson(url, { timeoutMs: 30000 });
        const n = pick(r.json);
        console.log(`   ✅ ${label}：HTTP ${r.status}、${n} 筆、${((Date.now()-t0)/1000).toFixed(1)} 秒`);
      } catch (e) {
        console.log(`   ❌ ${label}：${e.message}${e.cause?.code ? "（" + e.cause.code + "）" : ""}`);
      }
    };
    // 立法院開放資料（TLS legacy 修補走這條）
    await probe("data.ly.gov.tw id9（名錄）", CONFIG.endpoints.id9, (j) => j?.dataList?.length ?? 0);
    // g0v 立法院 API
    await probe("g0v ly.govapi.tw（議案）", CONFIG.bills.url + "&limit=1", (j) => j?.bills?.length ?? j?.total ?? 0);
    // 法務部全國法規資料庫（ZIP）
    await probe("law.moj.gov.tw（法規 ZIP）", CONFIG.mojLaw?.url ?? "https://law.moj.gov.tw/api/ch/law/json", () => "OK");
    // 媒體 RSS（新聞階段的輕量來源）
    await probe("媒體 RSS（中央社）", CONFIG.news.outlets?.[0]?.url ?? "https://feeds.feedburner.com/rsscna/politics", () => "OK");
  ' "$ROOT" || warn "實打來源那段跑不起來"
fi

say "結果"
printf '✅ %d 項通過　🔶 %d 項提醒　❌ %d 項失敗\n' "$PASS" "$WARN" "$FAIL"
[ "$FAIL" -eq 0 ] || { echo "有失敗項，先修完再看 docs/OPS.md 的對應 runbook"; exit 1; }
echo "沒有失敗項。若還沒跑過 node server/ingest.mjs，資料庫會是空的（health 的 ok=false 是正常的）。"
