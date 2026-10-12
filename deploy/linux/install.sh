#!/usr/bin/env bash
#
# 立委觀測站在 Linux VM 上的安裝（systemd version）。
#
#   sudo deploy/linux/install.sh                       # 只裝 API 伺服器
#   sudo deploy/linux/install.sh --with-fb             # 連每日粉專抓取一起裝（timer）
#   sudo deploy/linux/install.sh --port 8787 --host 127.0.0.1
#   sudo deploy/linux/install.sh --dry-run             # 只印出替換後的 unit，不寫任何檔案（不用 root）
#   deploy/linux/install.sh --render-dir /tmp/units    # 只把替換後的 unit 寫到某個目錄（給 CI／人工檢視用）
#   sudo deploy/linux/install.sh --status
#   sudo deploy/linux/install.sh --uninstall
#
# 這支只做「環境檢查 → 寫 unit → daemon-reload → enable --now」，不碰資料：
# 抓資料是 `node server/ingest.mjs`（見 docs/DEPLOY-VM.md 第 3 步）。
# 為什麼是 systemd 而不是照抄 macOS 的 launchd：這是兩個平台各自的正解 ——
#   launchd KeepAlive SuccessfulExit=false ↔ systemd Restart=on-failure
#   launchd StartCalendarInterval（睡著會補跑）↔ systemd timer Persistent=true
# 對照表與 VM 才有的坑（公網 IP、CPU 壓縮、Facebook 從機房 IP 抓）見 docs/DEPLOY-VM.md。
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SERVER_LABEL="ly-dashboard-server"
FB_LABEL="ly-dashboard-fb-daily"
UNIT_DIR="/etc/systemd/system"

ROOT="$(cd "$HERE/../.." && pwd)"
RUN_USER="${SUDO_USER:-$(id -un)}"
PORT="8787"
HOST="127.0.0.1"
NODE_BIN=""
WITH_FB=0
START=1
DRY=0
RENDER_DIR=""
ACTION="install"

usage() { sed -n '2,22p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; }

while [ $# -gt 0 ]; do
  case "$1" in
    --root) ROOT="$2"; shift 2 ;;
    --user) RUN_USER="$2"; shift 2 ;;
    --port) PORT="$2"; shift 2 ;;
    --host) HOST="$2"; shift 2 ;;
    --node) NODE_BIN="$2"; shift 2 ;;
    --with-fb) WITH_FB=1; shift ;;
    --no-start) START=0; shift ;;
    --dry-run) DRY=1; shift ;;
    --render-dir) RENDER_DIR="$2"; shift 2 ;;
    --status) ACTION="status"; shift ;;
    --uninstall) ACTION="uninstall"; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "不認識的參數：$1" >&2; usage; exit 2 ;;
  esac
done

ROOT="$(cd "$ROOT" && pwd)"
# 家目錄：Linux 用 getent（macOS 沒有這個指令，所以要有退路 —— 這支腳本要在 Linux 上跑，
# 但 --dry-run 常常是在開發機（macOS）上先看一遍）
HOME_DIR=""
if command -v getent >/dev/null 2>&1; then
  HOME_DIR="$(getent passwd "$RUN_USER" 2>/dev/null | cut -d: -f6 || true)"
fi
[ -n "$HOME_DIR" ] || HOME_DIR="$(eval echo "~$RUN_USER")"
[ -n "$HOME_DIR" ] || die "查不到 $RUN_USER 的家目錄（用 --user 指定使用者）"

say()  { printf '%s\n' "$*"; }
warn() { printf '⚠  %s\n' "$*" >&2; }
die()  { printf '✗  %s\n' "$*" >&2; exit 1; }

# ---------------------------------------------------------------- 環境檢查

# node：優先 --node，其次 PATH，最後常見位置（nvm／NodeSource 都可能不在 sudo 的 PATH 裡）
find_node() {
  if [ -n "$NODE_BIN" ]; then echo "$NODE_BIN"; return; fi
  local c
  for c in "$(command -v node || true)" /usr/bin/node /usr/local/bin/node; do
    [ -n "$c" ] && [ -x "$c" ] && { echo "$c"; return; }
  done
  # nvm 裝在使用者家目錄的情況（sudo 進來的 PATH 看不到）
  local nvm_node
  nvm_node="$(ls -1 "$HOME_DIR"/.nvm/versions/node/*/bin/node 2>/dev/null | sort -V | tail -1 || true)"
  [ -n "$nvm_node" ] && { echo "$nvm_node"; return; }
  echo ""
}

version_ok() { # 0 = ≥22.13（node:sqlite 免旗標）
  "$1" -e 'const [a,b]=process.versions.node.split(".").map(Number); process.exit(a>22||(a===22&&b>=13)?0:1)' 2>/dev/null
}
version_any() { # 0 = ≥22.5（可跑但可能要 --experimental-sqlite）
  "$1" -e 'const [a,b]=process.versions.node.split(".").map(Number); process.exit(a>22||(a===22&&b>=5)?0:1)' 2>/dev/null
}

preflight() {
  [ -d /run/systemd/system ] || warn "這台看起來不是 systemd 開機（容器？）。systemd 相關步驟會失敗，請改用手動方式啟動（見 docs/DEPLOY-VM.md 附錄）。"
  [ "$(uname -s)" = "Linux" ] || warn "不是 Linux（$(uname -s)）——這支腳本寫給 Linux VM，macOS 請用 scripts/launchd/install.sh。"

  NODE="$(find_node)"
  [ -n "$NODE" ] || die "找不到 node。裝 Node 22.13 以上（建議 24 LTS），或用 --node /path/to/node 指定。"
  if version_ok "$NODE"; then
    say "✓ node：$("$NODE" -v)（${NODE}）"
  elif version_any "$NODE"; then
    warn "node $("$NODE" -v)：22.5–22.12 的 node:sqlite 要 --experimental-sqlite，安裝時會自動加 NODE_OPTIONS。建議升到 22.13 以上。"
  else
    die "node 版本太舊：$("$NODE" -v)。要 ≥22.5（建議 ≥22.13）。"
  fi
  "$NODE" -e 'require("node:sqlite")' 2>/dev/null || say "（node:sqlite 需要 Node 內建支援，若上面版本夠就沒問題）"

  [ -f "$ROOT/server/index.mjs" ] || die "$ROOT 看起來不是 ly-dashboard 的目錄（找不到 server/index.mjs）。用 --root 指定。"
  [ -f "$ROOT/web/dist/index.html" ] || warn "$ROOT/web/dist 還沒有前端建置產物 → 先跑：npm ci && npm --prefix web ci && npm --prefix web run build"
  [ -f "$ROOT/data/ly.db" ] || warn "$ROOT/data/ly.db 還不存在 → 伺服器可以空資料庫啟動，但要跑 node server/ingest.mjs 才有資料"
  [ -f "$HOME_DIR/.ly-dashboard/notify.env" ] || warn "沒有 $HOME_DIR/.ly-dashboard/notify.env → 每日抓取的 Telegram 通知只會印在 log 裡（不會送出去）"
  if [ "$WITH_FB" = "1" ]; then
    if [ -d "$HOME_DIR/.ly-dashboard/fb-profile" ]; then
      say "✓ 找到 Chrome 設定檔：$HOME_DIR/.ly-dashboard/fb-profile"
    else
      warn "沒有 $HOME_DIR/.ly-dashboard/fb-profile → 粉專抓取會抓到 0 列（exit 2）。VM 上沒有畫面時，用 docs/fb-daily-update.md 的 cookies 匯入法。"
    fi
  fi
  command -v curl >/dev/null || warn "沒有 curl（fb-daily 的通知與驗收腳本會用到）"
}

render() { # render <樣板檔> → stdout（把 __X__ 換掉）
  sed -e "s|__NODE__|$NODE|g" \
      -e "s|__USER__|$RUN_USER|g" \
      -e "s|__HOME__|$HOME_DIR|g" \
      -e "s|__ROOT__|$ROOT|g" \
      -e "s|__PORT__|$PORT|g" \
      -e "s|__HOST__|$HOST|g" "$1"
}

# ---------------------------------------------------------------- 各動作

do_status() {
  for label in "$SERVER_LABEL" "$FB_LABEL"; do
    printf '\n=== %s ===\n' "$label"
    if systemctl list-unit-files "${label}.service" >/dev/null 2>&1; then
      systemctl status "$label" --no-pager -n 12 2>&1 | head -25 || true
    else
      say "（未安裝）"
    fi
  done
  printf '\n=== timer ===\n'
  systemctl list-timers "${FB_LABEL}.timer" --no-pager 2>&1 | head -5 || true
  printf '\n=== 最近 log（伺服器）===\n'
  journalctl -u "$SERVER_LABEL" -n 15 --no-pager 2>&1 | tail -15 || true
}

do_uninstall() {
  for unit in "$SERVER_LABEL.service" "$FB_LABEL.timer" "$FB_LABEL.service"; do
    systemctl disable --now "$unit" >/dev/null 2>&1 || true
  done
  rm -f "$UNIT_DIR/$SERVER_LABEL.service" "$UNIT_DIR/$FB_LABEL.service" "$UNIT_DIR/$FB_LABEL.timer" \
        "$UNIT_DIR/$SERVER_LABEL.service.d/node-options.conf"
  rmdir "$UNIT_DIR/$SERVER_LABEL.service.d" 2>/dev/null || true
  systemctl daemon-reload
  say "✓ 已移除（資料與 .cache 都保留；要一起刪請自己處理 $ROOT/data 與 $HOME_DIR/.ly-dashboard）"
}

preflight
NODE="${NODE:-$(find_node)}"

if [ "$ACTION" = "status" ]; then do_status; exit 0; fi
if [ "$ACTION" = "uninstall" ]; then
  [ "$(id -u)" = "0" ] || die "--uninstall 需要 root（sudo）"
  do_uninstall; exit 0
fi

if [ -n "$RENDER_DIR" ]; then
  mkdir -p "$RENDER_DIR"
  render "$HERE/$SERVER_LABEL.service" > "$RENDER_DIR/$SERVER_LABEL.service"
  say "✓ $RENDER_DIR/$SERVER_LABEL.service"
  if version_ok "$NODE"; then
    say "（node ≥22.13：不需要 NODE_OPTIONS drop-in）"
  else
    mkdir -p "$RENDER_DIR/$SERVER_LABEL.service.d"
    printf '[Service]\nEnvironment=NODE_OPTIONS=--experimental-sqlite\n' > "$RENDER_DIR/$SERVER_LABEL.service.d/node-options.conf"
    say "✓ $RENDER_DIR/$SERVER_LABEL.service.d/node-options.conf"
  fi
  if [ "$WITH_FB" = "1" ]; then
    render "$HERE/$FB_LABEL.service" > "$RENDER_DIR/$FB_LABEL.service"
    render "$HERE/$FB_LABEL.timer" > "$RENDER_DIR/$FB_LABEL.timer"
    say "✓ $RENDER_DIR/$FB_LABEL.{service,timer}"
  fi
  say "（只寫檔、沒有安裝。要驗語法：systemd-analyze verify $RENDER_DIR/*.service $RENDER_DIR/*.timer）"
  exit 0
fi

if [ "$DRY" = "1" ]; then
  say "── 以下是要寫進 $UNIT_DIR 的內容（--dry-run，沒有寫檔）──"
  say "root=$ROOT  user=$RUN_USER  home=$HOME_DIR  node=$NODE  port=$PORT  host=$HOST  with_fb=$WITH_FB"
  say ""
  render "$HERE/$SERVER_LABEL.service"
  say ""
  if version_ok "$NODE"; then
    say "（node ≥22.13：不需要 NODE_OPTIONS）"
  else
    say "── drop-in：$SERVER_LABEL.service.d/node-options.conf ──"
    printf '[Service]\nEnvironment=NODE_OPTIONS=--experimental-sqlite\n'
  fi
  if [ "$WITH_FB" = "1" ]; then
    say ""
    render "$HERE/$FB_LABEL.service"
    say ""
    render "$HERE/$FB_LABEL.timer"
  fi
  exit 0
fi

[ "$(id -u)" = "0" ] || die "安裝需要 root：sudo $0 $*"
[ -n "$NODE" ] || die "找不到 node"

mkdir -p "$UNIT_DIR"
render "$HERE/$SERVER_LABEL.service" > "$UNIT_DIR/$SERVER_LABEL.service"
say "✓ 寫入 $UNIT_DIR/$SERVER_LABEL.service"

if ! version_ok "$NODE"; then
  mkdir -p "$UNIT_DIR/$SERVER_LABEL.service.d"
  printf '[Service]\nEnvironment=NODE_OPTIONS=--experimental-sqlite\n' > "$UNIT_DIR/$SERVER_LABEL.service.d/node-options.conf"
  say "✓ 寫入 drop-in（node 22.5–22.12 需要 --experimental-sqlite）"
fi

if [ "$WITH_FB" = "1" ]; then
  render "$HERE/$FB_LABEL.service" > "$UNIT_DIR/$FB_LABEL.service"
  render "$HERE/$FB_LABEL.timer" > "$UNIT_DIR/$FB_LABEL.timer"
  say "✓ 寫入 $UNIT_DIR/$FB_LABEL.{service,timer}"
fi

# .cache 是抓取腳本的輸出與 log 目錄；systemd 不會幫忙建（User= 不是 root）
install -d -o "$RUN_USER" -g "$(id -gn "$RUN_USER")" "$ROOT/.cache" 2>/dev/null || mkdir -p "$ROOT/.cache"

systemctl daemon-reload
say "✓ systemctl daemon-reload"

if [ "$START" = "1" ]; then
  systemctl enable --now "$SERVER_LABEL"
  say "✓ 已啟用並啟動 $SERVER_LABEL"
  if [ "$WITH_FB" = "1" ]; then
    systemctl enable --now "$FB_LABEL.timer"
    say "✓ 已啟用 $FB_LABEL.timer（下次：$(systemctl show -p NextElapseUSecRealtime --value "$FB_LABEL.timer" 2>/dev/null || echo '見 systemctl list-timers')）"
  fi
else
  systemctl enable "$SERVER_LABEL" >/dev/null
  [ "$WITH_FB" = "1" ] && systemctl enable "$FB_LABEL.timer" >/dev/null
  say "✓ 已啟用（--no-start：沒有立刻啟動）"
fi

cat <<EOF

── 接下來這樣驗 ──
systemctl status $SERVER_LABEL --no-pager          # active (running)
curl -s http://$HOST:$PORT/api/v1/health | head -c 200
journalctl -u $SERVER_LABEL -n 20 --no-pager       # 啟動訊息與錯誤
$( [ "$WITH_FB" = "1" ] && echo "systemctl list-timers $FB_LABEL.timer        # 下次抓取時間
sudo systemctl start $FB_LABEL                   # 不等時間到，立刻跑一次（25–35 分鐘）" )
$HERE/verify-vm.sh --root $ROOT $( [ "$WITH_FB" = "1" ] && echo "--with-fb" )   # 一次檢查完（加 --live 會真的打來源）

要覆寫環境變數（例如 LY_HOST=0.0.0.0、LY_ALLOW_SHRINK）：寫在 $HOME_DIR/.ly-dashboard/server.env，例如
  PORT=8787
  LY_SYNC_TOKEN=請換成一串隨機字
然後 systemctl restart $SERVER_LABEL
EOF
