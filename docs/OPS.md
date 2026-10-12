# 立委觀測站 維運手冊

> 這份給「站掛掉要有人處理」的人看：跑在哪、什麼時候在做事、壞掉時先看什麼、怎麼修、怎麼確認修好了。
> 開發面的規格（模組職責、資料規則、API 契約）在 `docs/SPEC.md`；**每個語意決定的理由**在 `DECISIONS.md`
> （D 編號，用 `grep -n "D282：" DECISIONS.md` 找）。
> 要搬到 Linux VM／雲端主機：`docs/DEPLOY-VM.md`（這份的指令換成 `systemctl`／`journalctl` 即可，其他都一樣）。
> 相關：`docs/fb-daily-update.md`（粉專抓取的實戰細節）、`docs/local-server-schedule.md`（排程與對外連線的設計背景）、
> `docs/social-sheet-spec.md`（整理表格式）、`windows/README-zh-TW.md`（Windows 版）。

---

## 0. 先建立心智模型

**站台形狀**

| 項目 | 實際情況 |
| --- | --- |
| 跑在哪 | Mac Mini（`~/ly-dashboard`），API 綁 `127.0.0.1:8787` |
| 對外 | 只有 `tailscale serve` 的 `https://mac-mini.tail1ac930.ts.net`（**tailnet 內**，不是公網） |
| 資料庫 | `data/ly.db`（SQLite，約 160 MB）；**不進版控** |
| 抓取產物與 log | `.cache/`（約 152 MB）；**不進版控** |
| 前端 | `web/dist`（build 產物，`data/ly.db` 之外也在 `.gitignore`） |
| 憑證 | `~/.ly-dashboard/`（repo 外、權限 600） |

**誰在什麼時候做事**（四層，互相獨立）

1. **launchd（macOS，2 顆）**：API 伺服器常駐監管、每天 08:00 抓粉專。
2. **伺服器內的排程器**（`server/index.mjs` 的 `startScheduler`）：檢查資料是否過期、24 小時全同步、媒體 RSS 每小時、新聞階段每 6 小時。
3. **GitHub Actions（3 支 workflow）**：CI（三個平台跑測試）、每小時收媒體 RSS 進 `news-data`、推 `v*` 標籤時打包 Windows 版。
4. **Hermes cron（1 顆）**：每月 12 日 09:30 檢查戶政司人口月報有沒有新月份並更新縣市頁。

**「資料每天更新」的兩條路不要把他們搞混**

- **名錄／議事／預算／新聞**：伺服器自己抓（上游立法院開放資料、Google 新聞），每 24 小時一輪；資料庫整批覆寫。
- **粉專貼文**：由 **launchd 08:00 的抓取腳本**主動寫進資料庫（`fb-daily.mjs` → `ingestLocally()`），不靠伺服器的同步。
  2026-10-10 起是這條路（D 見 `docs/fb-daily-update.md` 第二節）。

---

## 1. 服務與排程清單

### 1.1 API 伺服器（launchd）

> **在 Linux（VM／雲端主機）上**：同一個服務換成 systemd —— `deploy/linux/ly-dashboard-server.service`
> ＋`deploy/linux/install.sh`，指令從 `launchctl` 換成 `systemctl`／`journalctl`。完整對照表在 `docs/DEPLOY-VM.md`。

- Label：`com.hermes.ly-dashboard-server`（樣板 `scripts/launchd/com.hermes.ly-dashboard-server.plist`）
- 實際跑的：`/bin/bash scripts/ly-dashboard-server.sh` → `exec node server/index.mjs`
- Log：`.cache/server.log`（stdout 與 stderr 同一個檔）
- `RunAtLoad=true`（登入就拉）、`KeepAlive{SuccessfulExit=false}`（node 非 0 離開才重啟）
- **`ProcessType` 必須是 `Standard`**：改成 `Background` 會被 macOS 降級，`/api/v1/funds` 這種 CPU 密集端點
  實測從 2 秒膨脹到 21 秒（前端 15 秒逾時 →「無法取得機關連線逾時」）。驗證：`ps -o pid,pri -p <pid>`（要 20，不是 4）。
- 包裝腳本的行為：連接埠已有別人在聽 → **exit 0（不搶）**，所以不會 crash-loop。

```bash
launchctl list | grep ly-dashboard                                  # 看有沒有在跑
launchctl kickstart -k gui/$(id -u)/com.hermes.ly-dashboard-server  # 重啟（改完 server/*.mjs 一定要做）
tail -50 ~/ly-dashboard/.cache/server.log                           # 看 log
```

> `launchctl bootstrap`／`bootout` 在受監督的 Hermes gateway 裡會被擋；安裝／移除要在使用者自己的 Terminal 跑。

### 1.2 每日粉專抓取（launchd）

- Label：`com.hermes.ly-dashboard-fb-daily`；08:00 執行 `scripts/fb-daily.sh`（薄殼 → `scripts/fb-daily.mjs`）
- 一輪 **25–35 分鐘**（113 位委員，每位間隔隨機 4–9 秒）；`KeepAlive=false`（不重試）、`RunAtLoad=false`（登入不補跑）
- Log：`.cache/fb-daily.log`（launchd 自己的 out/err 在 `.cache/fb-daily.launchd.{out,err}.log`，通常空的）
- 離開碼：**0** 正常；**2** ＝一列都沒抓到（最常見是 Chrome 設定檔沒登入 Facebook）；其他非 0 是腳本自己炸
- 成功失敗**都會**發 Telegram（見 §3）
- 電腦睡著錯過 → 喚醒後補跑一次（`StartCalendarInterval` 的特性，這是刻意選 launchd 的原因）

```bash
launchctl kickstart -k gui/$(id -u)/com.hermes.ly-dashboard-fb-daily   # 不等時間到，立刻跑一次
cd ~/ly-dashboard && npm run fb-daily                                  # 手動補跑（會寫回試算表、推 fb-data、寫本機 DB）
node scripts/fetch-fb-posts.mjs --ids 1 --limit 1 --no-detail           # 只驗管線、不寫任何地方
```

### 1.3 伺服器內建排程器

| 行為 | 間隔 | 環境變數（預設） |
| --- | --- | --- |
| 檢查「資料是否過期」 | 1 小時 | `LY_SCHEDULER_CHECK_MS`（3600000） |
| 超過 24 小時未成功 → 全同步 | 24 小時 | `LY_SYNC_INTERVAL_MS` |
| 媒體 RSS 輪詢（中央社／自由／聯合／公視） | 1 小時 | `LY_NEWS_OUTLET_INTERVAL_MS`（0＝只隨全同步） |
| 新聞階段（Google 新聞）自動重跑 | 6 小時 | `LY_NEWS_REFRESH_MS`（0＝停用） |
| 本機新聞推回 `news-data` | 跟著同步 | `LY_NEWS_PUSH=1`、`LY_NEWS_PUSH_DAYS`（7） |

> `docs/local-server-schedule.md` 的附錄還把 `LY_NEWS_REFRESH_MS` 記成「尚未存在」——**它已經實作了**（選項 A6）。

**成本（實測）**：新聞階段一輪 4–14 分鐘、對 Google 敲約 550 次；這就是「不要每小時跑」的原因。

### 1.4 GitHub Actions

| Workflow | 觸發 | 做什麼 |
| --- | --- | --- |
| `ci.yml` | push/PR 到 `main` | 三個平台（ubuntu/macos/windows）跑 `npm ci`、`web build`、`npm test` |
| `collect-news.yml` | 每小時 `:17`（避開整點） | 收媒體 RSS → `news-data` 分支（`news/YYYY-MM-DD.ndjson`）；有變動才 commit |
| `release-windows.yml` | 推 `v*` 標籤或手動 | 產出兩個 Windows zip（完整版／純新聞收集版）掛到 Release |

### 1.5 Hermes cron（agent 排程）

| Job | 時間 | 內容 | 狀態 |
| --- | --- | --- | --- |
| `af4040c7645f`「每月人口更新（ly-dashboard 縣市頁）」 | 每月 12 日 09:30 | 檢查戶政司人口月報有沒有新月份 → 有就更新縣市人口靜態資料並回報 | 現役 |
| `f8e238969101`「ly-dashboard 每日抓取結果檢查」 | 2026-10-06 一次性 | 當時用來盯抓取有沒有跑成功 | **已完成**，不是現役（每日的成功失敗由腳本自己發 Telegram） |

---

## 2. 每天五分鐘的晨檢（全部唯讀）

```bash
# ① 兩個 launchd 工作在哪、最後離開碼是什麼（粉專那個 0 才對）
launchctl list | grep ly-dashboard

# ② 抓取有沒有跑完（要看到「完成：N 列有日期」與「已觸發」或「已直接寫入本機資料庫」）
tail -20 ~/ly-dashboard/.cache/fb-daily.log

# ③ 站上看到的社群最新日期是不是今天
cd ~/ly-dashboard && node -e "
const {DatabaseSync}=require('node:sqlite');
const db=new DatabaseSync('data/ly.db');
console.log(db.prepare('SELECT MAX(post_date) AS m, COUNT(*) AS n FROM social_posts').get());"

# ④ 伺服器健康與同步狀態（端點欄位以 docs/API.md 為準）
curl -s http://127.0.0.1:8787/api/v1/health \
  | jq '{ok, stale: .meta.stale, fetched_at: .meta.fetched_at, social: .social, db: .db}'
curl -s 'http://127.0.0.1:8787/api/v1/social/wall?limit=1' | jq '.total'   # 大約 112
curl -s http://127.0.0.1:8787/api/v1/sync-runs | jq '.items[0:5] | map({dataset,status,records,error})'
```

> 形狀提醒：`/api/v1/health` 的「資料截至」在 **`meta.fetched_at`／`meta.stale`**（不是最外層）；
> `/api/v1/sync-runs` 是 **`{count, items, meta}`**（不是陣列）。`health` 的 `last_runs` 一次就給你每個來源最近一輪的結果，最快看出哪個來源壞。

**怎麼讀 log**

| 看到 | 意思 |
| --- | --- |
| `完成：N 列有日期`（N 和平常差不多） | 抓取成功 |
| `完成：0 列有日期` + 離開碼 2 | Chrome 設定檔沒登入 Facebook → §4.3 |
| `整理表連線檢查失敗`／「90 秒內失敗且沒有產出」 | 連線層的暫時性失敗，腳本自己會重試／重跑 |
| `本機伺服器（:8787）沒有回應，略過觸發同步` | 通常是 409 排隊（同一時間伺服器在跑別的同步）→ §4.4 |

---

## 3. 憑證與機密

| 檔案 | 內容 | 誰在用 | 失效／外洩時 |
| --- | --- | --- | --- |
| `~/.ly-dashboard/notify.env` | `LY_TELEGRAM_BOT_TOKEN`、`LY_TELEGRAM_CHAT_ID`（600） | `scripts/notify-telegram.sh` / `.mjs` | token 外洩 → 跟 @BotFather `/revoke` 換一顆，改這個檔 |
| `~/.ly-dashboard/sheet.env` | `LY_SHEET_WEBAPP_URL`、`LY_SHEET_TOKEN`（600） | `scripts/push-posts-to-sheet.mjs`（Apps Script Web App） | 換 token → 同步改 `apps-script/Code.js` 裡的共享密鑰，重新 `clasp deploy` |
| `~/.ly-dashboard/fb-profile/` | 已登入 Facebook 的 Chrome 設定檔 | `scripts/fetch-fb-posts.mjs` | 登入失效 → §4.3（等同帳號憑證，不要複製給別人） |
| `~/.ly-dashboard/fb-sheet-webapp.json`（600） | 早期服務帳號那條路留下的設定 | 已不走的舊路 | 可留可刪，確認沒有在用即可 |
| `apps-script/Code.js` | Apps Script 本體（含 token），**不進版控** | 寫回試算表 | 從 `Code.js.example` 重建 |

原則：

- 這些檔一律在 **repo 外**；`git status` 不該出現它們。要備份就自己存到密碼管理器，**不要**放進 repo 或共用的雲端資料夾。
- 通知送不出去**不會**讓每日排程失敗（只印 log）；`LY_NOTIFY=0` 可以整段關掉通知。

---

## 4. 狀況排除

### 4.1 網站整片連不上／前端說逾時

1. `launchctl list | grep ly-dashboard-server`，`lsof -nP -iTCP:8787 -sTCP:LISTEN`
2. 沒有在跑 → `launchctl kickstart -k gui/$(id -u)/com.hermes.ly-dashboard-server`
3. 有在跑但前端仍逾時 → 看 `.cache/server.log`；`/api/v1/funds` 慢通常是 CPU 被降級（§1.1 的 `ProcessType`）
4. 驗收：`curl -s http://127.0.0.1:8787/api/v1/health`，以及手機開 `https://mac-mini.tail1ac930.ts.net`
5. 手機連不上但電腦可以 → 那是 **Tailscale 沒開**，是預期行為（§4.8），不是服務壞了

### 4.2 沒收到每日通知

1. `ls -l ~/.ly-dashboard/notify.env`（沒有這個檔時通知只印不送、exit 0 → 看起來像沒發生）
2. 手動測：`cd ~/ly-dashboard && bash scripts/notify-telegram.sh --dry-run "測試"` 再看真的送一次
3. 排程本身有沒有跑是另一回事：`launchctl list | grep fb-daily` 與 `.cache/fb-daily.log`

### 4.3 抓到 0 列／log 出現「登入失效」（離開碼 2）

Facebook 只有「已登入的瀏覽器」看得到內容，設定檔過期就整輪抓不到。

```bash
# 有畫面的終端機（或本機 Terminal.app）
node scripts/fetch-fb-posts.mjs --login
# 無螢幕時：從已登入的瀏覽器匯出 cookies 再匯入（詳見 docs/fb-daily-update.md 第二節）
node scripts/import-fb-cookies.mjs --from /tmp/fb-cookies.json
# 驗收（這行要出現「已登入 Facebook（設定檔：…）」）
node scripts/fetch-fb-posts.mjs --ids 1 --min-delay 0 --max-delay 0
```

匯入完把 `/tmp/fb-cookies.json` 刪掉（等同帳號憑證）。

### 4.4 抓取成功、站上日期卻沒動

先分辨是哪一種，**不要**直接重跑整個抓取：

1. `grep -E "沒有回應|sync_in_progress|直接寫入本機資料庫" .cache/fb-daily.log`
2. **409 `sync_in_progress` 是排隊不是壞掉**：同一時間伺服器正在跑別的同步（例如新聞），`triggerSync()` 會自己重試
   （每 60 秒、最多 10 次）。等它跑完即可。
3. 本機寫入那一步若失敗才會走「觸發同步」的舊路；確認方式：`social_posts` 的 `MAX(post_date)`、`sync_runs` 最新幾列
4. 要立刻補資料（不重跑抓取）：

```bash
cd ~/ly-dashboard && node --input-type=module -e "
const { ingestLocally } = await import('./scripts/fb-daily.mjs');
console.log(await ingestLocally({ accountsCsv: '.cache/posts-2026-10-12.csv',
                                  postsCsv: '.cache/posts-detail-2026-10-12.csv' }));"
```

### 4.5 「某個機關／某類的件數看起來不對」

這裡有兩種病，**先分辨再動手**（細節與逐層 debug 見 `docs/SPEC.md` 的資料規則一節、`DECISIONS.md` D279–D282）：

- **歸屬規則**（同一件事在「我的機關」與「機關」頁件數不一致）→ 程式的語意 bug，要改 `server/queries.mjs`。
- **抓取範圍**（上游有、資料庫根本沒有）→ 是「要不要收這一類」的範圍決定，不是 bug。

順序：先在 DB 算一次（資料在不在）→ 再看畫面是被哪一層規則吃掉 → 真的不在才比對上游。

```bash
cd ~/ly-dashboard && node -e "
const {DatabaseSync}=require('node:sqlite');
const db=new DatabaseSync('data/ly.db');
console.log(db.prepare(\"SELECT COUNT(*) n FROM budget_bills WHERE proposer LIKE '%主計總處%'\").get());"
curl -s 'http://127.0.0.1:8787/api/v1/funds?type=agency&kind=submitted&fund=行政院主計總處' | jq '.total'
```

### 4.6 縣市人口看起來舊了

- 每月 12 日 09:30 的 Hermes cron 會自己處理並回報；沒收到回報就先手動跑：
  `~/ly-dashboard/scripts/refresh-county-stats.sh`
- **更新後一定要重啟伺服器**：`queries.mjs` 把 `county-stats.json` 快取在記憶體
- 驗收：22 縣市、面積合計約 3.6 萬、密度最高是臺北市；`npm test` 的資料不變量會紅就代表建置壞了
- 教訓：不要手改 `server/*.json`（重跑建置就復發），要改就改建置腳本

### 4.7 改了程式碼卻「沒生效」

- 改 `server/*.mjs`（`queries.mjs`、`normalize.mjs`…）→ **一定先重啟伺服器**再觸發同步。
  **同步是在伺服器行程裡跑的**：只改檔案、沒重啟就 `POST /api/v1/sync`，那一輪會用舊模組跑完並回報 success，看起來像「改了沒用」。
- 改前端 → `npm --prefix web run build`（伺服器服務的是 `web/dist`）。若動到 **app shell 資源（尤其圖示）**，
  記得把 `web/public/sw.js` 的 `CACHE` 版本 +1，否則既有安裝會一直吃舊快取。
- 改 plist → 重跑 `scripts/launchd/install.sh <server|fb-daily>`（不要手改 `~/Library/LaunchAgents/*.plist` 就期待生效）。

### 4.8 手機連不上

`*.ts.net` 是 tailnet 內部名稱：**手機沒開 Tailscale 就是連不上**（預期行為）。前端會顯示「這個站只在 Tailscale 網路內…」
並自己退避重試（2 秒→60 秒），連上後自動恢復，不必手動重整。伺服器端確認：`tailscale serve status`。

### 4.9 磁碟成長

目前 `data/` 約 160 MB、`.cache/` 約 152 MB。會長大的東西與控制方式：

| 什麼 | 控制方式 |
| --- | --- |
| `sync_runs`、`change_log` | 預設**全部保留**；要限制就 `LY_SYNC_RUNS_KEEP=200`、`LY_CHANGE_LOG_KEEP=500` |
| `raw_snapshots`（gzip 原始回應） | 內容有變才存一份（目前 5 筆），不需要手動清 |
| 新聞（`news`、`articles`、`topic_news`） | 累積保存 180 天，過期自動刪 |
| 粉專貼文（`social_posts`） | 有日期的留 90 天、沒日期的只留「這輪還抓得到」的 |
| `.cache/` 的 CSV、`fb-data`／`news-data` 工作目錄 | 是歷史紀錄；要清就自己刪，**但那是跨機器重建的備援** |

**不要**直接刪除資料表來省空間（刪了下次同步也補不回來的那部分就真沒了）；用上面的 env 讓程式自己淘汰。

### 4.10 SQLite 的兩條硬規則

- **`data/ly.db` 不要放在雲端同步資料夾**（iCloud／Google Drive／Dropbox），同步機制會弄壞 SQLite 檔案。
- 同一時間**只讓一台機器**當伺服器寫入這個 DB（兩台會各抓各的，資料以網址去重不會重複，但沒有必要）。

---

## 5. 例行維護

| 頻率 | 做什麼 |
| --- | --- |
| 每天 | §2 的晨檢（5 分鐘） |
| 每週 | 掃一次 `.cache/fb-daily.log` 有沒有重複出現連線失敗；`docs/fb-verification-<日期>.csv` 有沒有大量「拿不到頁面名稱」（＝被限流） |
| 每月 | 人口更新（cron 自動；沒回報就手動跑 `refresh-county-stats.sh` ＋重啟） |
| 每季 | `npm audit`／`npm --prefix web audit`；確認 Chrome 設定檔還登入著；確認 Tailscale 憑證沒過期 |
| 換屆（第 12 屆） | 換屆後手動同步一次並逐頁檢查；名錄切換屆次是合成測試涵蓋、**真實換屆還沒跑過** |
| 改任何東西後 | §7 的驗收命令 |

---

## 6. 備份與還原

**現況（誠實版）**

- **程式**：GitHub `main`（含 CI）。
- **抓取結果**：`fb-data`（粉專）、`news-data`（新聞）兩個分支就是資料備份，跨機器重建時會回補。
- **累積型資料（`social_posts` 貼文層級）**：靠 `fb-data` 分支的 `posts-detail/latest.csv` 回補。
- **`data/ly.db` 本身沒有自動備份**：它是「可重建」的（重跑 `node server/ingest.mjs` 就能還原名錄／議事／預算／新聞），
  但**人工累積**的部分（例如 `sync_runs` 歷史、`change_log`）重建不回來。
- **憑證**：`~/.ly-dashboard/*` 要自己備（密碼管理器），**不要**放 repo。

**還原步驟（換機／重灌）**

```bash
git clone https://github.com/cormort/ly-dashboard.git ~/ly-dashboard && cd ~/ly-dashboard
npm ci && npm --prefix web ci && npm --prefix web run build
node server/ingest.mjs                    # 重建 SQLite（打真實來源）
# 憑證：把 notify.env / sheet.env / fb-profile 放回 ~/.ly-dashboard/
scripts/launchd/install.sh                # 裝回兩顆 launchd（在 Terminal 跑，Hermes 內會被擋）
curl -s http://127.0.0.1:8787/api/v1/health
```

**要關掉磁碟上的 DB 快照**：先停伺服器（避免 WAL 寫入中複製）再 `cp data/ly.db*`，或用 `sqlite3 data/ly.db ".backup /path/ly-YYYYMMDD.db"`。

---

## 7. 改動的交付流程（維運視角）

```bash
# 1) 後端或抓取規則改動
npm test                                  # 目前 373 項（含 fail-closed、交易回滾、change_log）
npm --prefix web test                     # 前端 211 項（tsc -b ＋ smoke ＋ render-smoke）
npm --prefix web run build                # 有動前端才要
launchctl kickstart -k gui/$(id -u)/com.hermes.ly-dashboard-server
curl -s -X POST 'http://127.0.0.1:8787/api/v1/sync?force=1' | jq   # 需要時才全同步
```

- **要留三樣東西**（這個 repo 的慣例）：測試斷言（依規則所在挑 `test/api.test.mjs`／`test/ingest.test.mjs`／`test/normalize.test.mjs`）、
  `DECISIONS.md` 一條 D 編號、`docs/API.md` 的對應描述。
- 完整驗證（會打外部來源）：`bash scripts/verify.sh`（快速，約 8.5 分）／`bash scripts/verify.sh --full`（約 20 分）。
- PWA／RWD 有改：`npm run verify:pwa`（走 Tailscale HTTPS）、`npm run check:rwd`（需本機伺服器＋Chrome）。
- push 後看 GitHub Actions 三個平台是否都綠（`ci.yml`）。

---

## 8. 事故處理三原則

1. **fail closed 是設計，不是故障**：來源回應異常時系統刻意保留舊資料並記在 `sync_runs`。
   先看 `/api/v1/sync-runs` 的錯誤訊息，再決定要不要 `LY_ALLOW_SHRINK=1` 強制覆寫。
2. **不要手改資料檔或資料庫**：很多欄位是重跑建置時算出來的，手改會在下次同步／建置時復發（`DECISIONS.md` 有具體案例）。
3. **先分辨「抓取壞掉」還是「畫面規則不對」**：件數怪的時候，多半是歸屬／年度／合併鍵的規則問題，不是資料沒抓到。

---

## 附錄 A：檔案與 log 位置速查

| 位置 | 內容 |
| --- | --- |
| `~/ly-dashboard/.cache/server.log` | API 伺服器 stdout+stderr |
| `~/ly-dashboard/.cache/fb-daily.log` | 每日粉專抓取（主要看這個） |
| `~/ly-dashboard/.cache/fb-daily.launchd.{out,err}.log` | launchd 自己的輸出（通常空的） |
| `~/ly-dashboard/.cache/posts-<日期>.csv` | 抓取結果（整理表欄位格式） |
| `~/ly-dashboard/.cache/posts-detail-<日期>.csv` | 貼文層級（摘要 400 字，寫進 `social_posts`） |
| `~/ly-dashboard/.cache/fb-verification-<日期>.csv` | 逐筆驗證（頁面名稱／追蹤者／比對結果） |
| `~/ly-dashboard/.cache/fb-data/`、`.cache/news-data/` | 遠端資料分支的工作目錄 |
| `~/ly-dashboard/.cache/cec-council/` | 中選會議員選舉原始檔（60 個 CSV） |
| `~/ly-dashboard/data/ly.db` | SQLite（**唯一**的資料庫；不進版控） |
| `~/Library/LaunchAgents/com.hermes.ly-dashboard-*.plist` | 已安裝的 launchd 定義（樣板在 `scripts/launchd/`） |
| `~/.ly-dashboard/` | 憑證與 Chrome 設定檔（repo 外） |

## 附錄 B：環境變數（維運常調的）

| 變數 | 預設 | 作用 |
| --- | --- | --- |
| `LY_HOST` / `LY_PORT`（`PORT`） | `127.0.0.1` / `8787` | 綁定位址與埠；非 loopback 且沒設 token → 網頁的同步按鈕停用 |
| `LY_SYNC_TOKEN` | 空 | 非 loopback 時要開放 `POST /api/v1/sync` 用的權杖（沒設＝403 停用） |
| `LY_DB` | `data/ly.db` | 資料庫路徑 |
| `LY_SYNC_INTERVAL_MS` | 24 小時 | 超過這麼久沒成功就全同步 |
| `LY_SCHEDULER_CHECK_MS` | 1 小時 | 多久檢查一次該不該同步 |
| `LY_NEWS_REFRESH_MS` | 6 小時 | 新聞階段自動重跑間隔（0＝停用） |
| `LY_NEWS_OUTLET_INTERVAL_MS` | 1 小時 | 媒體 RSS 輪詢間隔（0＝只隨全同步） |
| `LY_NEWS_BUDGET_MS` / `LY_NEWS_ENTITY_BUDGET_MS` / `LY_NEWS_COUNCIL_BUDGET_MS` | 5／4／8 分 | 新聞各段的時間預算（上限，用完下輪接續） |
| `LY_NEWS_PUSH` / `LY_NEWS_PUSH_DAYS` | 關 / 7 天 | 本機抓到的新聞推回 `news-data` |
| `LY_STALE_HOURS` | 36 | 超過這麼久沒同步，畫面標示資料過期 |
| `LY_SHRINK_MIN_RATIO` / `LY_ALLOW_SHRINK` | 0.8 / 關 | 整批覆寫前的筆數守門；合法縮減時用 `LY_ALLOW_SHRINK=1` 放行一次 |
| `LY_SYNC_RUNS_KEEP` / `LY_CHANGE_LOG_KEEP` | 0（全部保留） | 只留最近 N 筆 |
| `LY_MOJ_LAWS_INTERVAL_HOURS` | 12 | 全國法規資料庫檢查間隔（0＝每次都抓） |
| `LY_FB_PROFILE` | `~/.ly-dashboard/fb-profile` | 抓粉專用的 Chrome 設定檔 |
| `LY_FB_LOCAL_INGEST` | 開 | `0` ＝回到「觸發伺服器重讀整理表」的舊路 |
| `LY_FB_DATA_PUSH` / `LY_FB_DATA_BRANCH` | 開 / `fb-data` | 抓取結果推遠端分支 |
| `LY_NOTIFY` / `LY_NOTIFY_ENV` | 開 / `~/.ly-dashboard/notify.env` | Telegram 通知開關與憑證檔 |
| `LY_SKIP_BILLS` / `LY_SKIP_BUDGET` / `LY_SKIP_NEWS` / `LY_SKIP_SOCIAL` | 空 | `=1` 跳過該來源（驗證用） |

（完整清單：`grep -rhoE "process\.env\.[A-Z_]+" server scripts | sort -u`）

## 附錄 C：指令速查

```bash
# 服務
launchctl list | grep ly-dashboard
launchctl kickstart -k gui/$(id -u)/com.hermes.ly-dashboard-server
launchctl kickstart -k gui/$(id -u)/com.hermes.ly-dashboard-fb-daily
scripts/launchd/install.sh --status           # 兩顆的狀態與最近 log

# 資料
curl -s http://127.0.0.1:8787/api/v1/health | jq '{ok, stale: .meta.stale, syncing}'
curl -s http://127.0.0.1:8787/api/v1/sync-runs | jq '.items[0:5] | map({dataset,status,records,error})'
curl -s -X POST 'http://127.0.0.1:8787/api/v1/sync?scope=social&force=1' | jq
cd ~/ly-dashboard && node server/ingest.mjs   # 手動全同步（打真實來源）
LY_SKIP_NEWS=1 LY_SKIP_BILLS=1 node server/ingest.mjs   # 只同步名錄（秒級）

# 抓取
cd ~/ly-dashboard && npm run fb-daily         # 補跑（25–35 分）
node scripts/fetch-fb-posts.mjs --verify      # 抓＋逐筆驗證

# 驗收
npm test && npm --prefix web test
bash scripts/verify.sh                        # 端到端（快速）
npm run check:rwd                             # RWD 守門（需 Chrome）
npm run verify:pwa                            # PWA（走 Tailscale HTTPS）
```
