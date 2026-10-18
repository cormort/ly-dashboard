#!/usr/bin/env bash
#
# 一鍵安裝：不抓 FB 粉專的立委觀測站（Debian／Ubuntu，例如 GCE 免費方案的 e2-micro）。
# 步驟與理由見 docs/DEPLOY-NO-FB.md；這支只是把那份文件串起來。
#
#   bash deploy/linux/bootstrap-no-fb.sh            # 用一般帳號跑（要有 sudo），不要用 root
#   bash deploy/linux/bootstrap-no-fb.sh --public   # 另外用 Caddy 開 https://<外部IP>.sslip.io（HTTPS＋帳號密碼）
#
# --public 的前提：GCE 執行個體要勾「允許 HTTP 流量」與「允許 HTTPS 流量」（防火牆在 VPC 層，VM 裡面改不到），
# 外部 IP 建議改成靜態（不然關機再開可能換 IP、網址就變了）。
#
# 可重複執行：已有的 swap、Node、clone、server.env 設定都會沿用，不會重複加。
# 第一次全同步要 8–15 分鐘（e2-micro 可能更久），中途別關 SSH 視窗。
set -euo pipefail

ROOT="${LY_ROOT:-/opt/ly-dashboard}"
REPO="${LY_REPO:-https://github.com/cormort/ly-dashboard.git}"
ENV_FILE="$HOME/.ly-dashboard/server.env"
PUBLIC=0
case "${1:-}" in
  --public) PUBLIC=1 ;;
  "") ;;
  *) echo "不認識的參數：$1（只有 --public）" >&2; exit 2 ;;
esac

step() { printf '\n== %s\n' "$*"; }
die()  { printf '✗  %s\n' "$*" >&2; exit 1; }

[ "$(id -u)" -ne 0 ] || die "請用一般帳號執行（腳本會在需要時自己 sudo）"
command -v apt-get >/dev/null || die "這支只支援 Debian／Ubuntu（apt）"

# 帳密先問完，後面十幾分鐘的同步就不用守在螢幕前
if [ "$PUBLIC" = "1" ]; then
  # 外部 IP：先問 GCE metadata（不靠第三方），不是 GCE 就請使用者自己給
  ip=$(curl -fs -m 3 -H 'Metadata-Flavor: Google' \
    http://metadata.google.internal/computeMetadata/v1/instance/network-interfaces/0/access-configs/0/external-ip || true)
  if [ -z "$ip" ]; then read -rp "這台的外部 IP：" ip; fi
  [[ "$ip" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]] || die "外部 IP 格式不對：$ip（執行個體要有外部 IP）"
  host="${ip//./-}.sslip.io"
  echo "網址會是 https://$host/"
  read -rp "網站登入帳號：" auth_user
  read -rsp "網站登入密碼（至少 8 字，不會顯示）：" auth_pass; echo
  [ -n "$auth_user" ] && [ "${#auth_pass}" -ge 8 ] || die "帳號不能空、密碼至少 8 個字"
fi

step "1/7 記憶體：不到 1.5 GB 又沒有 swap 就加 2 GB（e2-micro 只有 1 GB，全同步會被 OOM）"
mem_kb=$(awk '/MemTotal/ {print $2}' /proc/meminfo)
if [ "$mem_kb" -lt 1500000 ] && ! swapon --show | grep -q .; then
  sudo fallocate -l 2G /swapfile && sudo chmod 600 /swapfile
  sudo mkswap /swapfile >/dev/null && sudo swapon /swapfile
  grep -q '^/swapfile ' /etc/fstab || echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab >/dev/null
  echo "已加 2 GB swap"
else
  echo "不需要（記憶體 $((mem_kb / 1024)) MB，或已有 swap）"
fi

step "2/7 時區與基本工具"
sudo timedatectl set-timezone Asia/Taipei
sudo apt-get update -qq
sudo apt-get install -y -qq git curl ca-certificates >/dev/null

step "3/7 Node（要 22.13 以上；沒有或太舊就裝 24）"
node_ok() { command -v node >/dev/null && node -e 'const [a,b]=process.versions.node.split(".").map(Number);process.exit(a>22||(a===22&&b>=13)?0:1)'; }
if ! node_ok; then
  curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash - >/dev/null
  sudo apt-get install -y -qq nodejs >/dev/null
fi
node -e 'require("node:sqlite")' && echo "node $(node -v)，node:sqlite OK"

step "4/7 程式碼與前端建置（$ROOT）"
if [ -d "$ROOT/.git" ]; then
  git -C "$ROOT" pull -q --ff-only
else
  sudo mkdir -p "$ROOT" && sudo chown "$(id -un)":"$(id -gn)" "$ROOT"
  git clone -q "$REPO" "$ROOT"
fi
cd "$ROOT"
npm ci --no-audit --no-fund --loglevel=error
npm --prefix web ci --no-audit --no-fund --loglevel=error
npm --prefix web run build >/dev/null
echo "前端建置完成"

step "5/7 伺服器設定：這台不抓粉專（LY_FB_SCRAPE=0，D288）"
mkdir -p "$(dirname "$ENV_FILE")" && chmod 700 "$(dirname "$ENV_FILE")"
touch "$ENV_FILE" && chmod 600 "$ENV_FILE"
grep -q '^LY_FB_SCRAPE=' "$ENV_FILE" || echo 'LY_FB_SCRAPE=0' >> "$ENV_FILE"
cat "$ENV_FILE"

step "6/7 第一次全同步（打真實來源，8–15 分鐘以上）"
LY_FB_SCRAPE=0 node server/ingest.mjs

step "7/7 交給 systemd 並驗收"
sudo bash deploy/linux/install.sh
sudo systemctl restart ly-dashboard-server   # 讓剛寫的 server.env 一定生效
sleep 3
bash deploy/linux/verify-vm.sh --live || echo "⚠️  驗收有項目沒過：看上面的 ✗，處置見 docs/DEPLOY-VM.md §4"

if [ "$PUBLIC" != "1" ]; then
  cat <<'EOF'

完成。網站目前只在這台機器的 127.0.0.1:8787。要從自己的手機／電腦看：重跑時加 --public（Caddy＋HTTPS＋帳密），或裝 Tailscale：
  curl -fsSL https://tailscale.com/install.sh | sh
  sudo tailscale up
  sudo tailscale serve --bg 8787
  tailscale serve status          # 會給 https://<機器名>.<tailnet>.ts.net/

每月人口更新的排程見 docs/DEPLOY-NO-FB.md §7。
EOF
  exit 0
fi

step "8/8 對外：Caddy 反向代理＋HTTPS＋帳號密碼（$host）"
sudo apt-get install -y -qq caddy >/dev/null
hash=$(caddy hash-password --plaintext "$auth_pass")
[ -f /etc/caddy/Caddyfile.orig ] || sudo cp /etc/caddy/Caddyfile /etc/caddy/Caddyfile.orig
# basicauth（不是 basic_auth）：Debian 12 的 Caddy 是 2.6，basic_auth 這個寫法要 2.8 才有；新版仍接受 basicauth
printf '%s {\n\tbasicauth {\n\t\t%s %s\n\t}\n\treverse_proxy 127.0.0.1:8787\n}\n' "$host" "$auth_user" "$hash" |
  sudo tee /etc/caddy/Caddyfile >/dev/null
sudo caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile >/dev/null
sudo systemctl reload caddy || sudo systemctl restart caddy

echo "等 Caddy 申請 HTTPS 憑證（最多 60 秒）…"
ok=0
for _ in $(seq 1 12); do
  code=$(curl -s -o /dev/null -w '%{http_code}' -m 5 "https://$host/" || true)
  if [ "$code" = "401" ]; then ok=1; break; fi
  sleep 5
done
if [ "$ok" = "1" ]; then
  echo "✓ https://$host/ 已上線（未登入回 401＝帳密有擋）"
else
  echo "⚠️  https://$host/ 還連不上。最常見：GCE 沒勾「允許 HTTP／HTTPS 流量」→ 執行個體「編輯」勾起來後"
  echo "    sudo systemctl restart caddy；憑證狀況看 journalctl -u caddy -n 50"
fi

cat <<EOF

完成。網址：https://$host/   帳號：$auth_user
外部 IP 記得在「VPC 網路 → IP 位址」改成靜態，否則關機再開可能換 IP（網址跟著變，要重跑 --public）。
每月人口更新的排程見 docs/DEPLOY-NO-FB.md §7。
EOF
