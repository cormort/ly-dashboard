# 部署到虛擬機（Linux VM）

> 這份回答「我要把立委觀測站搬到 VM 上，怎麼處理」。
> 前置閱讀：`docs/OPS.md`（維運手冊，排程與故障排除）、`docs/SPEC.md`（開發規格書）。
> 這份**只管 VM 這件事**：拓撲選擇、規格、安裝步驟、VM 才有的坑、驗收。

---

## 0. 先講結論

**可以搬，而且程式碼不用改。** 這個專案是純 Node ＋ `node:sqlite`，後端零 runtime 相依，本來就有三套宿主
（macOS／Windows／Termux）；Linux 是它 CI 每天都在測的平台（`.github/workflows/ci.yml` 的 ubuntu-latest）。

**要換的只有「生命週期機制與啟動腳本」那一層**，也就是：

| macOS（現在的正式環境） | Linux VM | 對照檔 |
| --- | --- | --- |
| launchd `KeepAlive SuccessfulExit=false` | systemd `Restart=on-failure` | `deploy/linux/ly-dashboard-server.service` |
| launchd `StartCalendarInterval`（睡著會補跑） | systemd timer `Persistent=true` | `deploy/linux/ly-dashboard-fb-daily.timer` |
| `scripts/ly-dashboard-server.sh`（補 PATH＋埠檢查） | 不需要（systemd 自己管，`Environment=` 直接給） | — |
| `scripts/launchd/install.sh` | `deploy/linux/install.sh` | — |
| `launchctl kickstart -k …` | `systemctl restart ly-dashboard-server` | — |

**兩件 VM 才有的風險，第一週一定要盯**：

1. **機房出口 IP 打政府來源**：`data.ly.gov.tw` 需要 TLS legacy 修補、WAF 對 UA 敏感（程式已處理），
   但「同一套 OpenSSL 行為能在你的家用網路過關」不等於「雲端／機房 IP 也過關」。裝完當天跑一次
   `deploy/linux/verify-vm.sh --live`（會真的打 id9／g0v／法務部／RSS 各一次）。
2. **Facebook 粉專抓取**：需要「已登入的 Chrome 設定檔」。機房 IP 被 FB 風控的機率比家用高，
   而且 VM 通常沒有桌面可以跑 `--login`。**建議 VM 不要接這一項**（見下面拓撲 B）。

---

## 1. 先選拓撲（這一步決定你要不要搬那些憑證）

| 拓撲 | VM 做什麼 | Mac Mini 做什麼 | 適用 |
| --- | --- | --- | --- |
| **A：全搬** | 伺服器＋政府資料抓取＋新聞＋**每日粉專抓取** | 退役（或只當瀏覽器） | 你想要「一台機器搞定、Mac Mini 可以關機」 |
| **B：混合（推薦）** | 伺服器＋政府資料＋新聞（`news-data`） | 繼續每天 08:00 抓粉專 → 寫回試算表 → 推 `fb-data` | 不想在機房 IP 上跟 Facebook 打交道；兩台各做擅長的事 |
| **C：只放前端** | 靜態 `web/dist`（nginx／Caddy） | 繼續當 API 伺服器 | 只想讓別人看得到畫面，API 不搬 |

**B 為什麼可行**：這個 repo 的社群資料本来就有「跨機器」設計 —— 貼文會推上 `fb-data` 分支
（`posts/latest.csv`、`posts-detail/latest.csv`），VM 的同步會自己去讀；新聞同理走 `news-data`。
換句話說：**A 的資料路徑 B 全都有，只是少了「在 VM 上開 Chrome 登入 Facebook」這一項。**

> 注意：**同一個 `ly.db` 只能有一台在寫**。A 拓撲要把 DB 一起搬過去（或重跑 ingest 重建）；
> B 拓撲是兩台各自有 DB，但共用 `fb-data`／`news-data` 兩個資料分支 —— 這也是它們存在的理由。

---

## 2. VM 規格建議（實測數字換算）

| 項目 | 建議 | 為什麼 |
| --- | --- | --- |
| vCPU | **2 顆（1 顆可跑，但別超賣）** | `/api/v1/funds` 是**單執行緒 CPU 密集**：每個請求要掃約 7.8 萬列＋一輪正規式標記。macOS 上踩過一次同類陷阱（服務被降級 → 同請求 2 秒變 21 秒 → 前端 15 秒逾時顯示錯誤）。VM 上的等價陷阱是超賣的 vCPU 或 CPU 被壓縮的 cgroup |
| 記憶體 | **2 GB**（1 GB 可跑） | Node 常駐約 100–300 MB；抓取／匯入時峰值較高。`/api/v1/funds` 與新聞匯入是尖峰來源 |
| 磁碟 | **20 GB**（最低 10 GB） | 現在 `data/` 約 160 MB、`.cache/` 約 150 MB，新聞累積 180 天與貼文 90 天會慢慢長；還要放 Node、Chrome（如果要抓粉專） |
| 磁碟類型 | 一般區塊儲存 | **不要放在 NFS／共享／雲端同步資料夾**（SQLite WAL 會壞） |
| 網路 | 對外要能到 `data.ly.gov.tw`、`ly.govapi.tw`、`law.moj.gov.tw`、媒體 RSS、Google 新聞 | 公司／校園網路常有 TLS 中間人或封鎖，請先跑 `--live` 那一段 |
| 時間 | `Asia/Taipei` ＋ NTP 同步 | 排程、log、`sync_runs` 時間都靠它；`verify-vm.sh` 會檢查 |

---

## 3. 安裝步驟（Ubuntu／Debian 為主，RHEL 系只差套件指令）

### Step 0：準備

```bash
sudo apt update && sudo apt install -y git curl ca-certificates   # 基本工具
# Node 22.13 以上（建議 24 LTS）：
curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash - && sudo apt install -y nodejs
node -v && node -e 'require("node:sqlite"); console.log("node:sqlite OK")'
```

> `node:sqlite` 在 22.5–22.12 要 `--experimental-sqlite`；`install.sh` 偵測到會自動寫一個 drop-in 幫你加上，
> 但建議直接裝 22.13 以上（`engines` 寫 22.5，CI 用 24）。

### Step 1：放程式

```bash
sudo mkdir -p /opt && cd /opt
sudo git clone https://github.com/cormort/ly-dashboard.git ly-dashboard
sudo chown -R "$USER":"$USER" /opt/ly-dashboard      # 之後要用自己的帳號跑
cd /opt/ly-dashboard
npm ci && npm --prefix web ci && npm --prefix web run build
```

### Step 2：抓一次資料（第一次要幾分鐘）

```bash
cd /opt/ly-dashboard
node server/ingest.mjs          # 名錄／議事／預算／新聞（打真實來源，約 8–15 分鐘）
# 只想先確認程式能跑：LY_SKIP_NEWS=1 LY_SKIP_BILLS=1 node server/ingest.mjs   # 秒級
tail -20 .cache/server.log 2>/dev/null || true
```

> 抓粉專（拓撲 A）另外要：裝 Chrome、匯入登入態、`node scripts/fetch-fb-posts.mjs --ids 1 --limit 1` 先試一位。
> 步驟見 `docs/fb-daily-update.md` 第二節（含沒有桌面時用 cookies 匯入的方法）。

### Step 3：交給 systemd

```bash
cd /opt/ly-dashboard
bash deploy/linux/install.sh --dry-run            # 先看它要寫什麼（不用 root）
sudo bash deploy/linux/install.sh                 # 只裝 API 伺服器
sudo bash deploy/linux/install.sh --with-fb       # 拓撲 A：連每日粉專抓取一起（timer）
```

它做的事：環境檢查（node 版本、web/dist、DB）→ 把 `deploy/linux/*.service|timer` 的
`__NODE__／__USER__／__HOME__／__ROOT__` 換成實際值寫進 `/etc/systemd/system/` → `daemon-reload`
→ `enable --now`（`--with-fb` 時連 timer 一起）。

```bash
systemctl status ly-dashboard-server --no-pager
journalctl -u ly-dashboard-server -f              # Tail 啟動訊息（取代 macOS 的 .cache/server.log）
systemctl list-timers ly-dashboard-fb-daily.timer # 拓撲 A：下次抓取時間
```

**要覆寫環境變數**（例如對外、強制覆寫、憑證路徑）寫在 `~/.ly-dashboard/server.env`（每行 `KEY=value`），
不要在 unit 裡改 —— 那支檔案是 `EnvironmentFile=-~/.ly-dashboard/server.env`，重啟就生效：

```bash
mkdir -p ~/.ly-dashboard && chmod 700 ~/.ly-dashboard
cat > ~/.ly-dashboard/server.env <<'EOF'
PORT=8787
LY_HOST=127.0.0.1
TZ=Asia/Taipei
EOF
sudo systemctl restart ly-dashboard-server
```

### Step 4：驗收（一次全檢查）

```bash
cd /opt/ly-dashboard
bash deploy/linux/verify-vm.sh                                  # 環境＋服務＋站台
bash deploy/linux/verify-vm.sh --live --with-fb                 # 再實打來源（第一天一定要跑）
curl -s http://127.0.0.1:8787/api/v1/health | jq '{ok, fetched: .meta.fetched_at, legislators: .db.legislators}'
```

### Step 5：對外（要 HTTPS 才能裝 PWA）

**做法 1：Tailscale（與現在的 Mac Mini 相同，建議）**

```bash
curl -fsSL https://tailscale.com/install.sh | sh
sudo tailscale up                       # 登入同一個 tailnet
sudo tailscale set --operator="$USER"
tailscale serve --bg 8787               # 伺服器留在 loopback，只有自己的裝置進得來
tailscale serve status                  # 會給 https://<機器名>.<tailnet>.ts.net/
```

**做法 2：VM 有公網 IP，用 Caddy 反向代理＋HTTPS＋帳密**（`tailscale serve` 之外唯一的正解）

```bash
sudo apt install -y caddy
sudo tee /etc/caddy/Caddyfile >/dev/null <<'EOF'
ly.example.com {
    basicauth {   # Debian 12 的 Caddy 是 2.6，不認得 2.8 才有的 basic_auth
        minchieh <bcrypt 雜湊，用 caddy hash-password 產生>
    }
    reverse_proxy 127.0.0.1:8787
}
EOF
sudo systemctl reload caddy
```

> ⚠️ **讀取端點沒有驗證**：`/api/v1/*` 的 GET 任何人都讀得到（資料本身是公開的政府開放資料），
> 但 `/api/v1/sync` 在非 loopback 且沒設 `LY_SYNC_TOKEN` 時是 **403 停用**的。
> 也就是說「放到公網」的實質風險是「別人也能看你的儀表板」而不是「別人能叫它去抓資料」。
> 要不要公開是隱私與便利的取捨，預設建議做法 1（tailnet 內）。
> 若一定要公網又不想被隨便看：Caddy 的 `basic_auth`（上面那段）或 Cloudflare Access 之類的身分閘。

### Step 6：搬憑證（只搬你需要的）

| 檔案 | 拓撲 A | 拓撲 B | 說明 |
| --- | --- | --- | --- |
| `~/.ly-dashboard/notify.env` | ✅ | ✅（兩台各自有） | Telegram 通知；沒有它通知只印 log |
| `~/.ly-dashboard/server.env` | 選用 | 選用 | VM 專屬的環境變數 |
| `~/.ly-dashboard/sheet.env` | ✅ | ✅（抓粉專那台才用） | 寫回 Google 整理表的 token |
| `~/.ly-dashboard/fb-profile/` | ✅（或改走 cookies 匯入） | ❌ 留在 Mac Mini | 等同 Facebook 帳號憑證，不要複製給別人 |
| `apps-script/Code.js` | 已在 repo 外，需要的話重新 `clasp push` | 同 | 含共享密鑰 |

權限一律 `chmod 600`（目錄 `700`）；**這些檔案不要進 git**。

---

## 4. VM 才有的五個坑

1. **來源封鎖／限流（機房 IP）**
   立法院系網站與 Google 對資料中心 IP 的容忍度比家用 IP 低。症狀：`sync_runs` 一直 `failed`、
   錯誤是 403／429／`ECONNRESET`。處置：先 `--live` 確認是哪一家被擋 → 加大 `LY_MIN_INTERVAL_MS`（預設 400ms）、
   降低新聞頻率（`LY_NEWS_REFRESH_MS`）→ 必要時改用家用網路的機器跑抓取（回到拓撲 B）。

2. **CPU 被壓縮／vCPU 超賣**
   「`systemctl status` 綠燈、前端卻說逾時」幾乎都是這件事。驗證：
   `time curl -s -o /dev/null "http://127.0.0.1:8787/api/v1/funds?type=agency"`（正常幾百毫秒～2 秒）。
   unit 已給 `CPUWeight=200`；虛擬化層若有 CPU 上限／cgroup 限制（例如某些容器平台）要放寬。

3. **時間與時區**
   `TZ=Asia/Taipei` 已在 unit 裡；`verify-vm.sh` 會檢查 NTP。時間不對會讓「今天有沒有跑」的判斷失真
   （貼文日期、`sync_runs` 對不上）。

4. **關機／休眠與補跑**
   systemd timer 的 `Persistent=true` 會在開機後補跑一次（＝launchd `StartCalendarInterval` 的行為）。
   伺服器內建的排程器（每 24 小時全同步等）**不會**補跑 —— 這是刻意的設計，別把它當備援。
   雲端 VM 若有「自動關機省錢」政策，記得避開 08:00 那一輪（或改成 Persistent 補跑並確認 Chrome 還在）。

5. **無桌面環境（headless）**
   只有「抓粉專」需要真 Chrome；`playwright-core` 用 `channel: 'chrome'` 抓系統安裝的 Chrome，
   不需要下載瀏覽器。沒有桌面時：
   - 日常抓取沒問題（headless 是預設）；
   - `--login` 需要畫面 → 走 cookies 匯入（`scripts/import-fb-cookies.mjs`）；
   - Chrome 在容器裡要加 `--no-sandbox` 之類的旗標（本專案沒做這件事；建議直接用 VM 而不是容器跑抓取）。

---

## 5. 備份與還原（VM 版）

- **資料可重建、但要留一份**：`data/ly.db` 是「重跑 ingest 就能還原」的（名錄／議事／預算／新聞），
  但 `sync_runs` 歷史與 `change_log` 重建不回來；`social_posts` 靠 `fb-data` 分支回補。
- **一致快照**：先 `sudo systemctl stop ly-dashboard-server`，再 `sqlite3 data/ly.db ".backup /path/ly-$(date +%F).db"`，
  之後啟回來；或直接用 VM 的磁碟快照（停服務再拍最保險）。
- **異地一份**：把 `.cache/posts-*.csv`、`data/*.db` 用 `rclone`／scp 丟到自己信任的位置；
  憑證（`~/.ly-dashboard/*`）另外保管，不要跟資料放一起。
- **還原**：新 VM 照 §3 Step 0–3 走，再把 DB 放回 `data/ly.db`（或重跑 ingest）；憑證放回 `~/.ly-dashboard/`。

---

## 6. 更新流程（VM）

```bash
cd /opt/ly-dashboard
sudo systemctl stop ly-dashboard-server          # 先停（避免 SQLite 有寫入中）
git pull
npm ci && npm --prefix web ci && npm --prefix web run build
npm test                                          # 373 項左右；有動前端再加 npm --prefix web test
sudo systemctl start ly-dashboard-server
bash deploy/linux/verify-vm.sh
```

改了 `server/*.mjs`（`queries.mjs`、`normalize.mjs`…）→ **重啟後**再觸發同步；改了 app shell／圖示 →
`web/public/sw.js` 的 `CACHE` 要 +1（見 `docs/SPEC.md` §12 的四個陷阱）。

---

## 7. 🔶 未實測與已驗證（誠實版）

**已驗證（可重跑）**

- ✅ Linux 上冷啟動：空 `LY_DB` 直接跑 `node server/index.mjs --no-scheduler` → 建出 29 張表（`journal_mode=wal`）、
  `/api/v1/health`、`/`、`/icon-192-v2.png`、`/api/v1/{legislators,bills,budget,committees,rankings,counties,news/articles}` 全部 200。
- ✅ `npm test`（373 項）在 ubuntu／macos／windows 三個平台都跑（`.github/workflows/ci.yml`）。
- ✅ 來源可達性：以本專案的 `fetch-ly.mjs` 實打 `id9`（HTTP 200、123 筆、0.1 秒）。
- ✅ `deploy/linux/*.service|timer` 的語法與 `install.sh --dry-run` 的替換結果（CI 用 `systemd-analyze verify` 檢查）。

**🔶 還沒在真的 VM 上跑過的（第一次部署時請自己確認）**

- 🔶 從 VM 的機房 IP 打 `data.ly.gov.tw`／`ly.govapi.tw`／`law.moj.gov.tw` 是否都通（跑 `verify-vm.sh --live`）。
- 🔶 systemd 的單元在目標發行版上的實際行為（我沒有可用來實測的 VM；`Persistent=true` 的補跑、`CPUWeight` 是否支援）。
- 🔶 從機房 IP 抓 Facebook 的風控強度（拓撲 B 就是為了繞開它）。
- 🔶 Caddy／憑證那一段（做法 2）沒有實作過，只寫了標準做法。

---

## 8. 疑難排解（VM 常見）

| 症狀 | 先看 | 常見原因 |
| --- | --- | --- |
| `systemctl status` 綠燈但連不上 | `ss -ltnp \| grep 8787`、`journalctl -u ly-dashboard-server -n 50` | 服務綁在別的埠（`server.env` 的 `PORT`）、或綁了 `127.0.0.1` 而你在別台連 |
| 啟動就 exit | `journalctl` 的錯誤行 | web/dist 沒建、DB 路徑不可寫（`data/` 權限）、node 版本太舊 |
| 首頁 404、`/api` 正常 | `ls web/dist/index.html` | 前端沒 build（伺服器服務的是 `web/dist`） |
| 前端說「無法取得機關…逾時」 | `time curl …/api/v1/funds` | CPU 被壓縮／vCPU 超賣（§4.2） |
| timer 時間到沒跑 | `systemctl list-timers`、`journalctl -u ly-dashboard-fb-daily` | VM 當時關機（`Persistent=true` 開機後會補）、或 timer 沒 enable |
| 每天的通知沒來 | `journalctl -u ly-dashboard-fb-daily \| tail`、`~/.ly-dashboard/notify.env` | 憑證檔沒搬過來（沒憑證時只印不送、exit 0，看起來像沒發生） |

其餘症狀與處置（件數不對、人口沒更新、409 排隊…）在 `docs/OPS.md` 第 4 節 —— 那些與宿主平台無關。
