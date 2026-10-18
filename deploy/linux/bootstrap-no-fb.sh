#!/usr/bin/env bash
#
# 一鍵安裝：不抓 FB 粉專的立委觀測站（Debian／Ubuntu，例如 GCE 免費方案的 e2-micro）。
# 步驟與理由見 docs/DEPLOY-NO-FB.md；這支只是把那份文件的 §1–§5 串起來。
#
#   bash deploy/linux/bootstrap-no-fb.sh          # 用一般帳號跑（要有 sudo），不要用 root
#
# 可重複執行：已有的 swap、Node、clone、server.env 設定都會沿用，不會重複加。
# 第一次全同步要 8–15 分鐘（e2-micro 可能更久），中途別關 SSH 視窗。
set -euo pipefail

ROOT="${LY_ROOT:-/opt/ly-dashboard}"
REPO="${LY_REPO:-https://github.com/cormort/ly-dashboard.git}"
ENV_FILE="$HOME/.ly-dashboard/server.env"

step() { printf '\n== %s\n' "$*"; }
die()  { printf '✗  %s\n' "$*" >&2; exit 1; }

[ "$(id -u)" -ne 0 ] || die "請用一般帳號執行（腳本會在需要時自己 sudo）"
command -v apt-get >/dev/null || die "這支只支援 Debian／Ubuntu（apt）"

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

cat <<'EOF'

完成。網站目前只在這台機器的 127.0.0.1:8787。要從自己的手機／電腦看，裝 Tailscale（建議）：
  curl -fsSL https://tailscale.com/install.sh | sh
  sudo tailscale up
  sudo tailscale serve --bg 8787
  tailscale serve status          # 會給 https://<機器名>.<tailnet>.ts.net/

每月人口更新的排程見 docs/DEPLOY-NO-FB.md §7。
EOF
