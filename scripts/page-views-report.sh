#!/usr/bin/env bash
# 每日使用狀況日報的薄殼：載入 server.env（要 LY_DB 之類的設定）後交給 Node。
# 邏輯全在 scripts/page-views-report.mjs —— 兩平台共用，Windows 直接呼叫 .mjs。
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
ENV_FILE="${LY_ENV_FILE:-$HOME/.ly-dashboard/server.env}"
[ -f "$ENV_FILE" ] && { set -a; . "$ENV_FILE"; set +a; }
cd "$ROOT"
exec node "$ROOT/scripts/page-views-report.mjs" "$@"
