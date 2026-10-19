#!/usr/bin/env bash
# 換掉公開網站（app 層 cookie 登入）的密碼。原本要自己算 scrypt 雜湊再手動貼進 server.env，
# 這支腳本把「算雜湊 → 寫回 server.env（單引號）→ 同步 admin-cred.txt → 重啟服務 → 真的登入一次確認」
# 一次做完，避免手動貼錯（雜湊含 $，貼到 shell 會壞）。
#
# 用法：
#   scripts/ly-set-password.sh                  # 亂數產生一組 8 碼（好按、避開 0O1lI）
#   scripts/ly-set-password.sh 'MyPass1234'     # 指定密碼（至少 8 碼）
#   scripts/ly-set-password.sh --rotate-sessions 'MyPass1234'
#                                               # 順便換 LY_SESSION_SECRET → 所有裝置現有的 cookie 立刻失效
#                                                 （換密碼本身不會踢掉已登入的裝置，要踢就得換 secret）
#
# 環境變數：
#   LY_ENV_FILE   憑證檔（預設 ~/.ly-dashboard/server.env）
#   LY_CRED_FILE  帳密備忘檔（預設 ~/.local/etc/caddy/admin-cred.txt；不存在就不動）
#   LY_SERVICE    launchd 標籤（預設 com.hermes.ly-dashboard-server）
#   LY_BASE_URL   驗證用的位址（預設 http://127.0.0.1:8787）
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/.." && pwd)"
ENV_FILE="${LY_ENV_FILE:-$HOME/.ly-dashboard/server.env}"
CRED_FILE="${LY_CRED_FILE:-$HOME/.local/etc/caddy/admin-cred.txt}"
SERVICE="${LY_SERVICE:-com.hermes.ly-dashboard-server}"
BASE_URL="${LY_BASE_URL:-http://127.0.0.1:8787}"

die() { echo "✗ $*" >&2; exit 1; }

rotate_sessions=0
if [ "${1:-}" = "--rotate-sessions" ]; then
  rotate_sessions=1
  shift
fi
new_pass="${1:-}"

[ -f "$ENV_FILE" ] || die "找不到憑證檔：$ENV_FILE"

# 沒給密碼就產生一組：8 碼，去掉容易看錯的字元（0O1lI）
if [ -z "$new_pass" ]; then
  # 用 node:crypto 產生（不要用 `tr < /dev/urandom | head`：head 關掉管線會讓 tr 吃 SIGPIPE，
  # 在 pipefail 下整個腳本會 141 結束，看起來像沒執行）
  new_pass="$(node --input-type=module -e "
import { randomInt } from 'node:crypto';
const alphabet = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
let out = '';
for (let i = 0; i < 8; i += 1) out += alphabet[randomInt(alphabet.length)];
console.log(out);
")"
  generated=1
else
  generated=0
fi
[ "${#new_pass}" -ge 8 ] || die "密碼至少要 8 碼（現在 ${#new_pass} 碼）"

# 現在在用的帳號（沿用，不換帳號）
user="$(grep '^LY_LOGIN_USER=' "$ENV_FILE" | head -1 | cut -d= -f2- | tr -d '"'"'"'')"
[ -n "$user" ] || die "$ENV_FILE 裡沒有 LY_LOGIN_USER"

# 1) 算 scrypt 雜湊（用專案自己的 hashPassword，格式才跟伺服器驗的一致）
hash="$(PASS="$new_pass" node --input-type=module -e "
import { hashPassword } from '$REPO/server/auth.mjs';
console.log(await hashPassword(process.env.PASS));
")"
[ -n "$hash" ] || die "算不出雜湊"

# 2) 寫回 server.env：其他行原樣保留，這一行換掉（一定要單引號，雜湊含 $）
tmp="$(mktemp)"
grep -v '^LY_LOGIN_PASSWORD_HASH=' "$ENV_FILE" > "$tmp" || true
printf "LY_LOGIN_PASSWORD_HASH='%s'\n" "$hash" >> "$tmp"
if [ "$rotate_sessions" = 1 ]; then
  # 換一把新的 session secret（HMAC 簽章用），舊 cookie 就驗不過了
  secret="$(node --input-type=module -e "
import { randomBytes } from 'node:crypto';
console.log(randomBytes(48).toString('base64url').replace(/[^A-Za-z0-9]/g, '').slice(0, 48).padEnd(48, 'x'));
")"
  grep -v '^LY_SESSION_SECRET=' "$tmp" > "$tmp.2" || true
  printf "LY_SESSION_SECRET='%s'\n" "$secret" >> "$tmp.2"
  mv "$tmp.2" "$tmp"
fi
chmod 600 "$tmp"
mv "$tmp" "$ENV_FILE"

# 3) 帳密備忘檔（兩行：帳號、密碼）
if [ -f "$CRED_FILE" ]; then
  printf '%s\n%s\n' "$user" "$new_pass" > "$CRED_FILE"
  chmod 600 "$CRED_FILE"
fi

# 4) 重啟服務，讓新的雜湊生效
launchctl kickstart -k "gui/$(id -u)/$SERVICE" >/dev/null 2>&1 || echo "⚠ launchctl kickstart 失敗，請手動重啟 $SERVICE" >&2

# 5) 真的登入一次確認（成功＝303；失敗會回 401）
code=0
for _ in 1 2 3 4 5 6; do
  code="$(curl -s -o /dev/null -w '%{http_code}' -X POST \
    --data-urlencode "username=$user" --data-urlencode "password=$new_pass" \
    -H 'content-type: application/x-www-form-urlencoded' \
    "$BASE_URL/api/v1/login" 2>/dev/null || echo 000)"
  [ "$code" = "303" ] && break
  sleep 1
done

echo "帳號：$user"
if [ "$generated" = 1 ]; then
  echo "新密碼（亂數產生）：$new_pass"
else
  echo "新密碼：$new_pass"
fi
[ "$rotate_sessions" = 1 ] && echo "已同時換掉 session secret：所有裝置的登入狀態失效，要重新登入一次。"
if [ "$code" = "303" ]; then
  echo "✓ 已用新密碼登入測試成功（HTTP 303）"
else
  echo "✗ 登入測試回 $code —— 新雜湊已寫入，但驗證沒過，請看服務日誌：~/Library/Logs/ly-dashboard-server.err.log" >&2
  exit 1
fi
if [ "$rotate_sessions" != 1 ]; then
  # 換密碼不會踢掉已登入的裝置：cookie 是用 LY_SESSION_SECRET 簽的，跟密碼無關
  echo "（既有裝置的 cookie 仍有效；要全部踢掉再跑一次加 --rotate-sessions）"
fi
