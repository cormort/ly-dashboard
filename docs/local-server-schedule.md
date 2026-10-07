# 主機當 server 的三件事：自動啟動、定時更新新聞、對外連線

> 2026-10-07 寫。使用者當時的處境：**用筆電測試當 server**（也可能是 Mac Mini），
> 希望主機開著的時候新聞會自己更新、掛掉會自己回來、出門也連得到。
> 這份只寫「要做什麼、怎麼做、怎麼驗收」，**尚未動任何程式** —— 先不要實作，回家再處理。

---

## 0. 這份要解決什麼

| # | 問題 | 現在的狀況 | 這份的建議 |
| --- | --- | --- | --- |
| 1 | 伺服器掛掉沒人重啟 | **有風險**：目前跑的是手動啟的那顆 `node server/index.mjs`，terminal 關掉、行程當掉、或重開機就整片不見 | 交給 launchd 監管（`scripts/launchd/install.sh`，**已經寫好了**，只要執行） |
| 2 | 新聞多久更新一次 | **已經有兩條**（見 §1）；Google 那一路是 24 小時一輪 | 選項 A：加一顆「新聞」timer（建議 6 小時一輪） |
| 3 | 出門（不在同一個 Wi-Fi）連不到 | 綁 `127.0.0.1` 只有本機連得到；區網模式（`LY_HOST=0.0.0.0`）只在家裡有用，而且沒有 HTTPS → PWA 也不能做 | Tailscale（這台 Mac Mini 目前**還沒裝**）＋ `tailscale serve` |

---

## 1. 現況實測（2026-10-07）

**誰在跑**

- 伺服器：手動啟的 `node server/index.mjs`（`LY_HOST=0.0.0.0` 區網模式，`*:8787`），log 在 `.cache/server.log`。
- launchd：**只有每日抓粉專**（`com.hermes.ly-dashboard-fb-daily`）。`scripts/launchd/com.hermes.ly-dashboard-server.plist` 這個樣板存在，但**沒有安裝**（`~/Library/LaunchAgents/` 裡沒有）。
- GitHub Actions：`collect-news.yml` 每小時（`:17`）收媒體 RSS 進 `news-data` 分支，補「伺服器沒開時也不漏收」。

**伺服器內建排程**（`server/index.mjs` 的 `startScheduler`，本來就有）

| 行為 | 間隔 | 環境變數 |
| --- | --- | --- |
| 檢查「資料是否過期」 | 每小時 | `LY_SCHEDULER_CHECK_MS`（預設 1 小時） |
| 資料超過 N 小時就**全同步** | 24 小時 | `LY_SYNC_INTERVAL_MS`（預設 24 小時） |
| **媒體 RSS 輪詢**（中央社／自由／聯合／公視） | 每小時 | `LY_NEWS_OUTLET_INTERVAL_MS`（預設 1 小時，`0`＝停用） |
| 本機抓到的新聞推回 `news-data` | 跟著上面兩個時機 | `LY_NEWS_PUSH=1`、`LY_NEWS_PUSH_DAYS`（預設 7） |

筆電／Mac Mini 各自抓的新聞會互相看到，就是靠最後這一條（決策 D228–D231）。

**成本（實測）**

- 「新聞」階段一輪 **237–241 秒（約 4 分）** 到 **754–870 秒（12–14.5 分）**（`sync_runs`，2026-10-06 那天 7 輪）。
- 一輪要對 Google 新聞敲約 **550 次**（113 位委員 ＋ 約 80 組機關／基金 ＋ 約 360 位議員；同一 host 400ms 節流）。
- 各階段的時間預算是上限，不是每次都跑滿：委員 5 分（`LY_NEWS_BUDGET_MS`）、機關 4 分（`LY_NEWS_ENTITY_BUDGET_MS`）、議員 8 分（`LY_NEWS_COUNCIL_BUDGET_MS`）。

---

## 2. 第一步：交給 launchd 監管（最重要，一次就好）

**為什麼**：現在這顆是我手動啟的，我這邊一重啟或行程當掉，網站就整片不見（前端會顯示「無法取得新聞…連線逾時」）。launchd 會「登入就拉起 ＋ 當掉自動重啟」。

**順序**（`launchctl bootstrap` **不能在 Hermes 裡執行**，所以下面要在 Terminal 自己跑）

```bash
# 1) 先停掉手動啟的那顆（還有人在跑時，launchd 那份會「不搶」而直接退出）
pkill -f 'node server/index.mjs'          # 或 kill <pid>
lsof -nP -iTCP:8787 -sTCP:LISTEN          # 應該沒有輸出

# 2) 安裝並載入（只裝伺服器；要連每日抓粉專一起就 ./scripts/launchd/install.sh）
cd ~/ly-dashboard && ./scripts/launchd/install.sh server

# 3) 驗收
./scripts/launchd/install.sh --status      # 看得到 label、plist、最近 log
curl -sS http://127.0.0.1:8787/api/v1/health | head -c 120
```

**怎麽確認「當掉會自己回來」**：`kill` 掉那顆 node，等 10 秒再 `lsof -nP -iTCP:8787 -sTCP:LISTEN` —— 應該出現新的 pid。

**包裝腳本的行為**（`scripts/ly-dashboard-server.sh`，已修）

- 連接埠已經有別人在聽 → **exit 0**（不搶），所以 launchd 不會 crash-loop。
- node 自己當掉（非 0 離開）→ `KeepAlive SuccessfulExit=false` 把它拉起來。
- `LY_PORT` 會被 export 成 `PORT`（2026-10-07 修：之前只設 `LY_PORT` 會變成「檢查的埠」跟「實際監聽的埠」不一樣）。

**要一起想清楚的**

- **要不要讓 launchd 這份跑區網模式？** 預設是 loopback（`LY_HOST` 沒設）。要區網分享就在 plist 加 `EnvironmentVariables → LY_HOST=0.0.0.0`；但**區網模式下網頁的同步按鈕會被停用**（`authorizeSync`：非 loopback 且沒設 `LY_SYNC_TOKEN` → 403）。建議用 §4 的 Tailscale（伺服器留在 loopback），區網模式只在臨時測試時用。
- **筆電還是 Mac Mini？** 兩台的指令一樣；但「每日抓粉專」（`install.sh` 不帶參數時會一起裝）需要已登入的 Chrome 設定檔（`node scripts/fetch-fb-posts.mjs --login`），所以筆電只裝 `server` 比較合理。

---

## 3. 第二步：定時更新新聞

### 現在的實際行為

- 媒體 RSS（輕量、每輪只抓各家最新幾十則）：**每小時**自動跑，匯入收集檔，也會把本機的收穫推回 `news-data`。
- Google 那一路（逐委員／逐機關／議員）：屬於「新聞」階段，只在①資料超過 24 小時 ②有人按「更新資料」時跑。

### 選項

| 選項 | 做法 | 成本／代價 | 評價 |
| --- | --- | --- | --- |
| **A（建議）** | 伺服器自己多一顆 timer：每 N 小時跑一次 `stages: ['news']` | 改 1 個檔案＋1 條決策函式（下節有規格）；不用憑證、不用 launchd、重啟自動生效、共用既有的 single-flight 與進度回報 | **推薦**。一輪 4–14 分鐘，N=6 就是一天 4 輪 |
| B | launchd 定時打 `POST /api/v1/sync {"scope":"news"}` | 需要 `LY_SYNC_TOKEN`（區網模式）或伺服器留在 loopback；多一套排程要維護 | 只在「不想改程式」時選 |
| C | 把 `LY_SYNC_INTERVAL_MS` 從 24h 調小（例 6h） | 那是**全部**同步：名錄／議事／預算都跟著重跑，一天多好幾輪十幾分鐘 | 不建議 |

**頻率建議 6 小時**（一天 4 輪）。理由：Google 那一路一輪約 550 次請求、實測 4–14 分鐘，每小時跑等於整天持續敲同一個來源，容易被限流；而輕量的媒體 RSS 已經每小時了，即時性不缺。想要更即時隨時改 `LY_NEWS_REFRESH_MS`（3 小時＝`10800000`）。

### A 的實作規格（回家照這個做）

1. `server/config.mjs` 加：

   ```js
   // 新聞階段自動重跑的間隔（0＝停用，只跟著 24 小時的全同步）
   newsRefreshMs: Number(process.env.LY_NEWS_REFRESH_MS ?? 6 * 60 * 60 * 1000),
   ```

2. `server/index.mjs` 的 `startScheduler` 再加一顆 timer（形狀照現有的媒體 RSS timer）：

   ```js
   if (CONFIG.newsRefreshMs > 0) {
     const newsTimer = setInterval(() => {
       if (getInflightScope()) return;                       // 有同步在跑就跳過（單一同步）
       const last = db.prepare("SELECT MAX(finished_at) AS at FROM sync_runs WHERE dataset = 'news' AND status = 'success'").get()?.at;
       if (last && Date.now() - Date.parse(last) < CONFIG.newsRefreshMs) return;
       syncOnce(db, { logger, scope: 'news' }).catch((error) => logger.error('[scheduler] 新聞同步失敗', error));
     }, Math.min(CONFIG.newsRefreshMs, 60 * 60 * 1000));      // 最多每小時醒一次
     newsTimer.unref();
   }
   ```

   注意兩點：**判斷要用「新聞階段自己的最後成功時間」**（`sync_runs` 有逐 dataset 的紀錄），不是全域的 `last_success_at`——否則別的階段剛跑完會讓新聞永遠排不到。

3. 決策抽成純函式（`shouldRefreshNews(db, { now, intervalMs })`）並寫測試：
   - 從沒成功過 → 要跑；最後一次成功在 interval 內 → 不跑；interval=0 → 不跑；有同步在跑 → 不跑。
4. 驗收：把 `LY_NEWS_REFRESH_MS` 設成很小（例 60 秒）跑一次，看 log 出現 `[scheduler] …新聞…` 與 `sync_runs` 多一列 `news`，然後改回 6 小時。

---

## 4. 第三步：出門也連得到（Tailscale）

**現況**：2026-10-07 查過這台 Mac Mini —— **Tailscale 還沒裝**（`/Applications`、`brew list`、`~/.local/bin`、`mdfind`、launchd 都沒有；只有一般的 utun 介面）。手機或另一台裝好了不代表伺服器這台在 tailnet 裡。

```bash
# 1) 裝（App Store 版或 https://tailscale.com/download/mac ），登入同一個 tailnet
# 2) 確認自己在 tailnet 裡
tailscale status
# 3) 把本機的 8787 開成 HTTPS（伺服器留在 loopback，不必開區網、不必設 token）
sudo tailscale set --operator=$(whoami)   # 之後就不用每次 sudo
tailscale serve --bg 8787
tailscale serve status                     # 會給 https://<機器名>.<tailnet>.ts.net/
```

**為什麼選它**：只有自己的裝置進得來、原生 HTTPS（**PWA 的必要條件**）、不用開區網、`serve` 是從 loopback 轉發，所以 `LY_HOST` 可以維持不開放 → 網頁的同步按鈕仍然可用（不必設 `LY_SYNC_TOKEN`）。

**PWA（T11）前置**：Service Worker 只在安全來源註冊 → 有這個 HTTPS 才做得起來。`docs/rwd-plan.md` 的 T11 就卡在這裡。

---

## 5. 風險與取捨

- **Google 限流**：見 §3 的頻率建議。真的要更頻繁，先只加密媒體 RSS（`LY_NEWS_OUTLET_INTERVAL_MS`），別把 550 次請求的階段塞進每小時。
- **兩個寫手寫同一個資料分支**：本機推回（`LY_NEWS_PUSH`）與 GitHub Actions 都寫 `news-data`。已經處理：本機每輪先 `reset` 到遠端再重新合併、push 失敗重試 3 次；Actions 那一步也加了「重抓遠端＋重新收集再推」（D230）。
- **憑證**：本機推回要靠該台 repo 的 git 憑證（跟推 `fb-data` 同一套）；`tailscale serve` 要一次管理者權限。
- **兩台同時當 server**：兩邊都會抓、都會推，資料以網址去重，不會重複；但同一個 `ly.db` 不要放在雲端同步資料夾（SQLite 檔案會被同步機制弄壞）。建議只讓一台跑伺服器，另一台純看。

---

## 6. 待決定清單

1. 新聞自動重跑：**A6（6 小時）**／A3（3 小時）／先不做？
2. launchd 要裝哪些：`server` only（筆電）還是 `server` ＋ `fb-daily`（Mac Mini）？
3. 要不要做 §4 的 Tailscale ＋ `tailscale serve`（連帶解鎖 PWA）？
4. 筆電要不要開 `LY_NEWS_PUSH=1`？（第一次建議先 `npm run push:news -- --days 2 --dry-run` 看量）

---

## 7. 附錄：環境變數一覽

| 變數 | 預設 | 作用 |
| --- | --- | --- |
| `LY_HOST` | `127.0.0.1` | 綁定位址；非 loopback 且沒設 token → 網頁的同步按鈕停用 |
| `LY_PORT` / `PORT` | `8787` | 連接埠（`LY_PORT` 會被啟動腳本 export 成 `PORT`） |
| `LY_SYNC_TOKEN` | 無 | 區網模式下要開放 `POST /api/v1/sync` 時用的權杖 |
| `LY_SYNC_INTERVAL_MS` | 24 小時 | 資料超過這麼久就全同步 |
| `LY_SCHEDULER_CHECK_MS` | 1 小時 | 多久檢查一次「該不該同步」 |
| `LY_NEWS_OUTLET_INTERVAL_MS` | 1 小時 | 媒體 RSS 輪詢間隔（`0`＝只隨全同步抓） |
| `LY_NEWS_PUSH` / `LY_NEWS_PUSH_DAYS` | 關／7 天 | 本機抓到的新聞推回 `news-data` |
| `LY_NEWS_REFRESH_MS` | **尚未存在** | §3 選項 A 要新增：新聞階段自動重跑的間隔 |
| `LY_NEWS_BUDGET_MS` / `LY_NEWS_ENTITY_BUDGET_MS` / `LY_NEWS_COUNCIL_BUDGET_MS` | 5／4／8 分 | 新聞各段的時間預算 |
| `LY_NEWS_FEED_STALE_HOURS` | 6 小時 | 收集端超過這麼久沒動就在備註提醒 |
