#!/usr/bin/env bash
#
# 把 Mac Mini 上的立委觀測站對外公開（Tailscale Funnel），前面加帳號密碼（Caddy）。
#
#   bash scripts/mac-funnel.sh            # 問帳密 → 裝／設定 Caddy → 開 Funnel → 驗收（可重複執行，改帳密也是重跑）
#   bash scripts/mac-funnel.sh --off      # 關掉對外：Funnel 關閉、回到只有 tailnet 內看得到（tailscale serve → 8787）
#
# 路徑：網路 →（Funnel：HTTPS、公開網址 https://<機器>.<tailnet>.ts.net）→ Caddy 127.0.0.1:8788（帳密、壓縮）→ node 127.0.0.1:8787
# - 伺服器本身照舊只聽 127.0.0.1；HTTPS 憑證由 Tailscale 處理，Caddy 不碰憑證（auto_https off）。
# - PWA 安裝要的 manifest、sw.js、圖示不擋帳密（瀏覽器抓 manifest 不帶憑證，擋住就裝不了 App；見 deploy/linux/bootstrap-no-fb.sh）。
# - 需要 Homebrew 與已登入的 Tailscale；第一次開 Funnel，Tailscale 可能要你到管理頁面按同意（指令會印出網址）。
set -euo pipefail

CADDY_PORT=8788
APP_PORT=8787

step() { printf '\n== %s\n' "$*"; }
die()  { printf '✗  %s\n' "$*" >&2; exit 1; }

[ "$(uname -s)" = "Darwin" ] || die "這支是給 macOS 用的（Linux 主機請用 deploy/linux/bootstrap-no-fb.sh --public）"
command -v tailscale >/dev/null || die "找不到 tailscale 指令（Tailscale App：選單列圖示 → Settings → 安裝 CLI）"
command -v brew >/dev/null || die "找不到 Homebrew（https://brew.sh）"

if [ "${1:-}" = "--off" ]; then
  step "關掉對外公開"
  tailscale funnel --bg off "$CADDY_PORT" 2>/dev/null || tailscale funnel reset || true
  tailscale serve --bg "$APP_PORT"
  tailscale serve status
  echo "已回到只有 tailnet 內看得到。Caddy 還在跑但沒有人連得到它；要停：brew services stop caddy"
  exit 0
fi
[ $# -eq 0 ] || die "不認識的參數：$1（只有 --off）"

step "1/4 網站本身有在跑嗎（127.0.0.1:${APP_PORT}）"
curl -fs -o /dev/null -m 10 "http://127.0.0.1:$APP_PORT/api/v1/health" || die "連不到 127.0.0.1:$APP_PORT —— 先讓伺服器跑起來（scripts/launchd/install.sh server）"
echo "✓ 有在跑"

step "2/4 帳號密碼"
read -rp "網站登入帳號：" auth_user
read -rsp "網站登入密碼（至少 8 字，不會顯示）：" auth_pass; echo
[ -n "$auth_user" ] && [ "${#auth_pass}" -ge 8 ] || die "帳號不能空、密碼至少 8 個字"

step "3/4 Caddy（帳密＋壓縮，只聽 127.0.0.1:${CADDY_PORT}）"
brew list caddy >/dev/null 2>&1 || brew install caddy
caddyfile="$(brew --prefix)/etc/Caddyfile"
hash=$(caddy hash-password --plaintext "$auth_pass")
[ -f "$caddyfile" ] && [ ! -f "$caddyfile.orig" ] && cp "$caddyfile" "$caddyfile.orig"
# basicauth（不是 basic_auth）：新舊版 Caddy 都認得這個寫法
printf '{\n\tauto_https off\n}\n\n:%s {\n\tbind 127.0.0.1\n\t@locked not path /manifest.webmanifest /sw.js /icon-*.png /icon-maskable-*.png /apple-touch-icon-*.png\n\tbasicauth @locked {\n\t\t%s %s\n\t}\n\tencode zstd gzip\n\treverse_proxy 127.0.0.1:%s\n}\n' \
  "$CADDY_PORT" "$auth_user" "$hash" "$APP_PORT" > "$caddyfile"
chmod 600 "$caddyfile"
caddy validate --config "$caddyfile" --adapter caddyfile >/dev/null
brew services restart caddy >/dev/null
for _ in $(seq 1 15); do
  code=$(curl -s -o /dev/null -w '%{http_code}' -m 2 "http://127.0.0.1:$CADDY_PORT/" || true)
  [ "$code" = "401" ] && break
  sleep 1
done
[ "$code" = "401" ] || die "Caddy 沒有起來（拿到 ${code}）；看 $(brew --prefix)/var/log/caddy.log 或 brew services info caddy"
echo "✓ Caddy 已擋帳密（未登入 401）"

step "4/4 Tailscale Funnel（公開 HTTPS）"
# 原本的 tailscale serve（443 → 8787，只有 tailnet）會被這一條取代成 443 → Caddy，自己的裝置也一樣要登入
tailscale funnel --bg "$CADDY_PORT"
tailscale funnel status
url=$(tailscale funnel status 2>/dev/null | grep -oE 'https://[^ ]+\.ts\.net' | head -1 || true)

cat <<EOF

完成。公開網址：${url:-（看上面 funnel status 的 https://…ts.net）}   帳號：$auth_user
- 用手機的行動網路（關掉 Wi-Fi 與 Tailscale）打開，跳出帳密框就是對外成功。
- 改帳密：重跑這支。關掉對外：bash scripts/mac-funnel.sh --off
- Mac 關機、睡眠或斷網時網站就停；系統設定 → 能源 → 「防止自動進入睡眠」建議打開。
EOF
