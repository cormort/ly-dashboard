#!/usr/bin/env bash
#
# 把立委觀測站的 macOS launchd 工作裝進 ~/Library/LaunchAgents。
#
#   scripts/launchd/install.sh              # 安裝全部（API 伺服器 + 每日抓立委粉專）
#   scripts/launchd/install.sh server       # 只裝 API 伺服器的監管
#   scripts/launchd/install.sh fb-daily     # 只裝每日抓取
#   scripts/launchd/install.sh --status     # 看狀態與最近一次執行
#   scripts/launchd/install.sh --uninstall  # 移除（log 與抓到的資料保留）
#
# 為什麼要有安裝腳本：plist 裡的 __REPO_ROOT__ 要換成本專案的實際路徑，
# 而且 launchd 的載入指令（bootstrap/bootout）只有在「先 bootout 再 bootstrap」時才會吃到新設定。
#
# 注意：`launchctl bootstrap` **不能在 Hermes 的 gateway 裡面執行**（會被擋），
# 所以這支腳本要由使用者自己在 Terminal 跑。
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
DOMAIN="gui/$(id -u)"
SERVER_LABEL="com.hermes.ly-dashboard-server"
FB_LABEL="com.hermes.ly-dashboard-fb-daily"
ALL_LABELS=("$SERVER_LABEL" "$FB_LABEL")

usage() { sed -n '2,16p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; }

log_for() {
  case "$1" in
    "$SERVER_LABEL") echo "$ROOT/.cache/server.log" ;;
    "$FB_LABEL") echo "$ROOT/.cache/fb-daily.log" ;;
    *) echo "$ROOT/.cache/$1.log" ;;
  esac
}

# 參數：工作名稱（server／fb-daily）；沒給就是全部
SELECTED=()
MODE="install"
for arg in "$@"; do
  case "$arg" in
    -h|--help) usage; exit 0 ;;
    --status) MODE="status" ;;
    --uninstall) MODE="uninstall" ;;
    server) SELECTED+=("$SERVER_LABEL") ;;
    fb-daily) SELECTED+=("$FB_LABEL") ;;
    *) echo "不認識的參數：$arg"; usage; exit 2 ;;
  esac
done
[ ${#SELECTED[@]} -eq 0 ] && SELECTED=("${ALL_LABELS[@]}")

if [ "$MODE" = "status" ]; then
  for label in "${SELECTED[@]}"; do
    echo "== $label =="
    launchctl list | grep -F "$label" || echo "（沒有載入）"
    [ -f "$HOME/Library/LaunchAgents/$label.plist" ] && echo "plist：已安裝" || echo "plist：尚未安裝"
    echo "log（最後 10 行）：$(log_for "$label")"
    tail -10 "$(log_for "$label")" 2>/dev/null || echo "（還沒有 log；代表還沒跑過）"
    echo
  done
  exit 0
fi

if [ "$MODE" = "uninstall" ]; then
  for label in "${SELECTED[@]}"; do
    launchctl bootout "$DOMAIN/$label" 2>/dev/null || true
    rm -f "$HOME/Library/LaunchAgents/$label.plist"
    echo "已移除 ${label}（log 與抓到的資料都保留）"
  done
  exit 0
fi

mkdir -p "$HOME/Library/LaunchAgents" "$ROOT/.cache"
FAILED=0
for label in "${SELECTED[@]}"; do
  TEMPLATE="$HERE/$label.plist"
  TARGET="$HOME/Library/LaunchAgents/$label.plist"
  if [ ! -f "$TEMPLATE" ]; then
    echo "找不到樣板：$TEMPLATE"
    FAILED=1
    continue
  fi
  # __REPO_ROOT__ 用 | 當分隔字元，避免路徑裡的 / 被 sed 當成語法
  sed "s|__REPO_ROOT__|$ROOT|g" "$TEMPLATE" >"$TARGET"
  plutil -lint "$TARGET" >/dev/null || { echo "產生的 plist 不合法，中止：$TARGET"; FAILED=1; continue; }
  # 先 bootout 再 bootstrap：已經載入時直接 bootstrap 會回 EEXIST，舊設定也不會被換掉
  launchctl bootout "$DOMAIN/$label" 2>/dev/null || true
  if ! launchctl bootstrap "$DOMAIN" "$TARGET" 2>&1; then
    echo "launchctl bootstrap 失敗：$label"
    FAILED=1
    continue
  fi
  echo "已安裝並載入：$TARGET"
done
[ "$FAILED" -eq 0 ] || exit 1

echo
echo "接下來："
echo "  API 伺服器：已交給 launchd 監管（當掉會自動重啟）。"
echo "  如果先前有一個手動啟動的伺服器在跑，launchd 這一份會先跳過（不搶）；要交棒就把它停掉再："
echo "    launchctl kickstart -k $DOMAIN/$SERVER_LABEL"
echo "  每日抓取：先確認抓得到東西（需要已登入的 Chrome 設定檔）"
echo "    node scripts/fetch-fb-posts.mjs --login"
echo "  立刻試跑每日抓取（不用等到 08:00）"
echo "    launchctl kickstart -k $DOMAIN/$FB_LABEL"
echo "  看狀態"
echo "    scripts/launchd/install.sh --status"
