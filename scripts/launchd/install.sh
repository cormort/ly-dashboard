#!/usr/bin/env bash
#
# 把每日抓取立委臉書貼文的排程裝進 macOS launchd。
#
#   scripts/launchd/install.sh            # 安裝並載入（已存在就重新載入）
#   scripts/launchd/install.sh --uninstall
#   scripts/launchd/install.sh --status   # 看目前狀態與最近一次執行
#
# 為什麼要有安裝腳本：plist 裡的 __REPO_ROOT__ 要換成本專案的實際路徑，
# 而且 launchd 的載入指令（bootstrap/bootout）只有在「先 bootout 再 bootstrap」時才會吃到新設定。
set -uo pipefail

LABEL="com.hermes.ly-dashboard-fb-daily"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
TEMPLATE="$HERE/$LABEL.plist"
TARGET="$HOME/Library/LaunchAgents/$LABEL.plist"
DOMAIN="gui/$(id -u)"

usage() { sed -n '2,10p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; }

case "${1:-}" in
  -h|--help) usage; exit 0 ;;
  --status)
    echo "== launchctl 清單 =="
    launchctl list | grep -F "$LABEL" || echo "（沒有載入）"
    echo
    echo "== 排程檔 =="
    [ -f "$TARGET" ] && echo "$TARGET" || echo "（尚未安裝）"
    echo
    echo "== 最近一次執行的 log（最後 20 行）=="
    tail -20 "$ROOT/.cache/fb-daily.log" 2>/dev/null || echo "（還沒有 log；代表還沒跑過）"
    exit 0
    ;;
  --uninstall)
    launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
    rm -f "$TARGET"
    echo "已移除 $LABEL（log 與 .cache/posts-*.csv 保留，沒有刪任何抓到的資料）"
    exit 0
    ;;
  "") ;;
  *) echo "不認識的參數：$1"; usage; exit 2 ;;
esac

[ -f "$TEMPLATE" ] || { echo "找不到樣板：$TEMPLATE"; exit 1; }
mkdir -p "$HOME/Library/LaunchAgents" "$ROOT/.cache"

# __REPO_ROOT__ 用 | 當分隔字元，避免路徑裡的 / 被 sed 當成語法
sed "s|__REPO_ROOT__|$ROOT|g" "$TEMPLATE" >"$TARGET"
plutil -lint "$TARGET" >/dev/null || { echo "產生的 plist 不合法，中止：$TARGET"; exit 1; }

# 先 bootout 再 bootstrap：已經載入時直接 bootstrap 會回 EEXIST，舊設定也不會被換掉
launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
if ! launchctl bootstrap "$DOMAIN" "$TARGET" 2>&1; then
  echo "launchctl bootstrap 失敗；中止"
  exit 1
fi

echo "已安裝並載入：$TARGET"
echo "排程：每天 08:00（機器睡著時，喚醒後補跑一次）"
echo
echo "接下來："
echo "  1) 先確認 script 抓得到東西（需要已登入的 Chrome 設定檔）："
echo "     node scripts/fetch-fb-posts.mjs --login"
echo "  2) 立刻試跑一次排程（不用等到明天 08:00）："
echo "     launchctl kickstart -k $DOMAIN/$LABEL"
echo "  3) 看結果："
echo "     scripts/launchd/install.sh --status"
