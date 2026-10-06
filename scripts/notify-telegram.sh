#!/usr/bin/env bash
#
# 送一則訊息到 Telegram（每日排程的成敗通知用）。
#
#   scripts/notify-telegram.sh "訊息內容"
#   scripts/notify-telegram.sh --dry-run "訊息內容"    # 只印出來，不送出
#
# 憑證放 ~/.ly-dashboard/notify.env（LY_TELEGRAM_BOT_TOKEN、LY_TELEGRAM_CHAT_ID，權限 600）。
# 沒設定或送不出去都只印訊息、以 exit 0 結束 —— 通知本來就不該讓每日排程失敗。
# 用 LY_NOTIFY_ENV 可以換憑證檔位置。
set -uo pipefail

ENV_FILE="${LY_NOTIFY_ENV:-$HOME/.ly-dashboard/notify.env}"
if [ -f "$ENV_FILE" ]; then
  set -a
  # shellcheck disable=SC1090
  . "$ENV_FILE"
  set +a
fi

DRY=0
if [ "${1:-}" = "--dry-run" ]; then
  DRY=1
  shift
fi
MSG="${1:-}"
if [ -z "$MSG" ]; then
  echo "用法: notify-telegram.sh [--dry-run] 訊息" >&2
  exit 2
fi

if [ "$DRY" -eq 1 ] || [ -z "${LY_TELEGRAM_BOT_TOKEN:-}" ] || [ -z "${LY_TELEGRAM_CHAT_ID:-}" ]; then
  if [ "$DRY" -eq 0 ]; then
    echo "[通知] 沒有憑證（${ENV_FILE}）→ 只印不送"
  fi
  printf '[通知]%s\n%s\n' "$([ "$DRY" -eq 1 ] && echo "（預演）")" "$MSG"
  exit 0
fi

RESP="$(curl -sf -m 20 -X POST "https://api.telegram.org/bot${LY_TELEGRAM_BOT_TOKEN}/sendMessage" \
  --data-urlencode "chat_id=${LY_TELEGRAM_CHAT_ID}" \
  --data-urlencode "text=${MSG}" 2>&1)" || true

case "$RESP" in
  *'"ok":true'*)
    echo "[通知] 已送出"
    ;;
  *)
    # 不要把 token 印出來
    echo "[通知] 送出失敗：$(printf '%s' "$RESP" | sed 's/bot[0-9A-Za-z:_-]*/bot<略>/g' | head -c 200)"
    exit 1
    ;;
esac
