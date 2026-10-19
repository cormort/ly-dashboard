# 立委觀測站 開發規格書

> **讀者是誰**：要改這個 repo 的人（未來的自己、Windows／Termux 的維護者、外部貢獻者）。
> **其他文件的分工**：`docs/OPS.md`＝維運（排程、log、憑證、故障排除、備份還原）；
> `docs/API.md`＝**凍結的 API 契約**（前端依它實作，改動要同步）；
> `DECISIONS.md`＝每個語意決定的「岔路／選擇／理由」（D 編號，用 `grep -n "D283" DECISIONS.md` 找）；
> `README.md`＝專案的對外說明（含歷史 review 紀錄）。
> 這份規格書只寫「系統現在長什麼樣、為什麼」，**不重複**維運步驟。

---

## 1. 系統概觀

- **一句話**：把立法院開放資料（加上新聞、粉專貼文、人口／選舉統計）整理成一個可查的儀表板。伺服器與前端都跑在同一台機器上，前端只讀自家的 `/api/v1/*`。
- **執行期不需要 AI**：程式裡沒有任何 AI 服務呼叫；分類、流程、年度判定都是固定規則。
- **後端零 runtime 相依**：只用 Node 內建（`node:sqlite`、`fetch`、`node:test`）；`devDependencies` 只有 `playwright-core`（抓粉專／驗收要用真 Chrome）。
- **Node 版本**：`engines` 寫 ≥ 22.5，實務上要 **≥ 22.13**（`node:sqlite` 在 22.5–22.12 要 `--experimental-sqlite`）；CI 用 Node 24。
- **跑在哪**：主要宿主是 macOS（launchd 監管），另有 Windows（PowerShell，**程式在 repo 但未啟用**）與 Android／Termux 兩套啟動方式。
- **對外**：只有 `tailscale serve` 的 `https://mac-mini.tail1ac930.ts.net`（tailnet 內，非公網）。這也是 PWA（Service Worker 需要安全來源）成立的前提。

---

## 2. 架構與資料流

```
     〔來源〕                    〔抓取〕                 〔正規化：純函式〕        〔儲存〕
  data.ly.gov.tw (id9/id14) ┐
  ly.govapi.tw/v2 (g0v)     ├─▶ server/fetch-ly.mjs ─▶ server/normalize.mjs ─▶ server/db.mjs（SQLite）
  ppg.ly.gov.tw             │    具名 UA／逾時／節流      前綴剝除、屆次隔離、      交易覆寫 + change_log
  law.moj.gov.tw            │    退避＋抖動重試           穩定 id、席次建模、      + raw_snapshots(gzip)
  立法院預算中心 WebAPI     │                             fail-closed 驗證
  Google 新聞 RSS           ┘        ▲
  Google 整理表（粉專／議員）── scripts/fb-daily.mjs ─── 直接寫入 social_accounts／social_posts
  media RSS ── GitHub Actions(news-data) ─┐
  中選會／內政部戶政司 ── scripts/build-*.mjs ─▶ server/*.json（靜態資料，不走同步）

                              server/queries.mjs ◀── 讀 DB 與靜態 JSON（含記憶體快取）
                                     │
                        http://127.0.0.1:8787/api/v1/*  ──▶  web/（React+TS，只讀自家 API）
```

三條**路徑性質不同**，改動前先分清楚自己動的是哪條：

| 路徑 | 誰驅動 | 寫入方式 | 什麼時候生效 |
| --- | --- | --- | --- |
| 政府開放資料／g0v／新聞 | 伺服器內建排程或 `POST /api/v1/sync` | **整批覆寫**（單一交易 DELETE+INSERT）或累積 upsert | 同步跑完即生效（查詢無快取） |
| 粉專貼文 | **launchd 每日 08:00** 的 `scripts/fb-daily.mjs` | 先產 CSV → 寫回 Google 試算表 → 推 `fb-data` → **直接匯入本機 DB** | 匯入完成即生效（失敗才回頭叫伺服器重讀試算表） |
| 縣市人口／選舉／地圖 | 人工或 Hermes cron 跑 `scripts/build-*.mjs` | 產生 `server/*.json` | **改完要重啟伺服器**（`queries.mjs` 把這些檔快取在記憶體） |

---

## 3. 目錄結構與模組職責

### 3.1 後端（`server/`）

| 檔案 | 職責 |
| --- | --- |
| `config.mjs` | 端點、UA、類別與樣式（regex）、排程與逾時間隔、預算抓取範圍。**環境變數集中在這裡**（`LY_*`） |
| `fetch-ly.mjs` | HTTPS 抓取：TLS legacy 修補、逾時、同 host 節流、指數退避＋抖動重試、`describeError` |
| `normalize.mjs` | **純函式**：前綴剝除、屆次隔離、穩定 id、席次／召委建模、預算四層規則、`NORMALIZER_VERSION`、`DataValidationError`、`parseNewsRss` |
| `db.mjs` | schema（28 張表）、`migrate()`、交易式覆寫／累積 upsert、`change_log`、`raw_snapshots` |
| `ingest.mjs` | 管線：FETCH → VALIDATE → NORMALIZE → PERSIST → `sync_runs`；`runAll`／`runStage`；各階段的 fail-closed 守門 |
| `queries.mjs` | 所有 API 視圖（唯一讀取出口）；靜態 JSON 的記憶體快取；預算的一案一列合併（`mergeBudgetUnits`） |
| `index.mjs` | HTTP 伺服器：路由、靜態檔 + SPA fallback、`POST /api/v1/sync`、`startScheduler` |
| `sync-scopes.mjs` | 12 個同步階段與 5 個「範圍」的定義（含冷卻分鐘、`cadence` 文案） |
| `sync-guard.mjs` | 冷卻防呆（`sync_in_progress`／`sync_too_soon`）；上次有失敗來源時不擋 |
| `sync-progress.mjs` | 同步進度（**純記憶體**，不落地），由 `/health` 的 `progress` 讀出 |
| `agency-names.mjs` | 機關名稱正規化（簡稱 → 現行全名）與機關清單 |
| `budget-committees.mjs` | 從 g0v 的逐案委員會紀錄補 `budget_committees` |
| `committee-overrides.mjs` | 委員會席次的**人工確認補充表**邏輯（上游殘缺時才生效） |
| `moj-law.mjs` | 全國法規資料庫（ZIP → `ChLaw.json`）→ 法規 → 主管機關 |
| `ppg-progress.mjs` | 立法院議事系統的議案「審議進度」→ `progress_overrides` |
| `news-feed.mjs`／`news-push.mjs` | `news-data` 分支的收集檔讀寫格式與推送 |
| `zip.mjs` | 讀 ZIP（法務部那份）用 |
| `*.json` | 靜態資料：`committee-seats.json`（人工補充）、`council-stats.json`、`county-stats.json`、`demographics.json`、`population-trend.json`、`legislator-votes.json`、`town-map.json`、`recalls.json`、`council-facebook.json`、`fund-config.json`、`officials.json`、`law-agencies.json`、`social-overrides.json` |

### 3.2 前端（`web/`）

`src/App.tsx`（路由分派、卡片／側欄狀態）、`src/hooks/`（`useRoute`／`useApi`／`useReconnectRefresh`）、
`src/api/`（`client.ts` 唯一出口、`types.ts` 型別）、`src/pages/`（15 個頁面）、`src/components/`（42 個元件）、
`src/lib/`（`parties.ts` 黨籍顏色唯一定義、`urlState.ts`、`nav.ts`、`fontScale.ts`、`scroll.ts`、`billStage.ts`、`connectionHint.ts`）、
`src/styles.css`（設計系統＋RWD）、`public/`（manifest、sw.js、四張圖示）。

### 3.3 其他

| 目錄 | 內容 |
| --- | --- |
| `scripts/` | 抓取與建置腳本（見 §6.3）、launchd 樣板（`scripts/launchd/`）、驗收腳本（`verify.sh`／`verify-pwa.mjs`／`check-rwd.mjs`）、shell 入口（`fb-daily.sh`／`ly-dashboard-server.sh`／`notify-telegram.sh`） |
| `test/` | `node --test` 的回歸測試，fixture 是**真實 API 回應** |
| `windows/` | PowerShell 版（啟動、工作排程、supervisor、lint）；`README-zh-TW.md` 是完整說明 |
| `deploy/linux/` | Linux VM 的 systemd unit（伺服器／每日抓取＋timer）、`install.sh`（環境檢查＋安裝）、`verify-vm.sh`（裝機前後一次檢查，`--live` 會實打來源）；說明在 `docs/DEPLOY-VM.md` |
| `termux/` | Android 捷徑腳本（啟動／更新／回補新聞） |
| `news-collector/` | 獨立的「只收媒體 RSS」Windows 版（給別人單獨部署） |
| `apps-script/` | 寫回 Google 試算表的 Apps Script（`Code.js` 含密鑰，**不進版控**） |
| `.github/workflows/` | `ci.yml`／`collect-news.yml`／`release-windows.yml` |

---

## 4. 同步引擎

### 4.1 階段與範圍

`SYNC_STAGES`（canonical 順序，12 項）：
`roster, bills, budget, budget_reports, meetings, records, social, social_posts, council_social, news, progress, committees`
—— 每個階段的 `sync_runs.dataset` 代號定義在 `STAGE_DATASETS`（例如 `roster` → `id9`／`id14`、`progress` → `ppg_progress`、`committees` → `bill_committees`）；**兩邊要一一對應，測試會檢查**。

| scope | 階段 | 冷卻 | 什麼時候用 |
| --- | --- | --- | --- |
| `all`（預設） | 全部 12 個 | 30 分 | 一般更新；政府開放資料一天一輪 |
| `roster` | `roster` | 30 分 | 只更新名錄／席次 |
| `legislative` | `bills, budget, budget_reports, meetings, records, progress, committees` | 30 分 | 議事與預算 |
| `news` | `news` | 10 分 | 只跑新聞階段（一輪 4–14 分鐘、對 Google 約 550 次請求） |
| `social` | `social, social_posts, council_social` | 5 分 | 粉專牆資料（跟政府開放資料無關） |

認不得的 `scope` 一律退回 `all`（舊版前端沒帶參數時走這條）。

### 4.2 執行語意

- **single-flight**：`syncOnce` 同時只跑一個同步；重複呼叫拿到同一個 Promise。
- `POST /api/v1/sync` 成功受理回 **202** `{accepted, started, scope, inflight_scope, forced, message, poll}`；`poll` 指向 `/api/v1/sync-runs`。
- **409 `sync_in_progress` 是排隊不是失敗**：呼叫端（`fb-daily.mjs` 的 `triggerSync()`）會每 60 秒重試、最多 10 次。
- **`sync_too_soon`**：同一範圍在冷卻時間內重按；回應帶 `minutes_ago`／`retry_after_minutes`／`last_run_at` 供畫面說明。
- **`force=1`**：跳過冷卻（剛寫回試算表就必須重讀時用）。
- 非 loopback 且沒設 `LY_SYNC_TOKEN` → `POST /api/v1/sync` 回 **403**（停用）。

### 4.3 每個階段的邊界與狀態

- 每個階段是獨立的 fail-closed 單元：失敗只寫 `sync_runs`（`status='failed'`＋`error`），**保留舊資料**，其他階段照跑。
- `status` 有 `success`／`skipped`／`failed`。`skipped` 最常見的原因是**內容指紋沒變**：
  覆寫前比對 `combinedSha = NORMALIZER_VERSION : 席次補充表指紋 : 來源 sha256`，相同就只更新 `last_success_at`。
- `sync_runs` 欄位：`id, dataset, status, started_at, finished_at, records, attempt, http_status, duration_ms, ua, error`；
  時間是 **ISO 8601（UTC）字串**（不是 unix 秒），`duration_ms` 是毫秒。
- 本機檔案來源（`fb-daily` 的直接匯入）`http_status` 是 `null`。
- 進度（`sync-progress.mjs`）只在記憶體，重啟就沒了；`/api/v1/health` 的 `progress`／`syncing` 反映它。

---

## 5. 資料模型（`data/ly.db`）

**PRAGMA**：`journal_mode=WAL`、`foreign_keys=ON`、`busy_timeout=5000`。

**schema 管理**：**沒有版本表**。`migrate()` 每次啟動跑 `CREATE TABLE IF NOT EXISTS`，新欄位用「檢查 `PRAGMA table_info` 後 `ALTER TABLE ADD COLUMN`」的方式加（例如 `legislators.contacts`、`social_accounts.source`、`news.title_key`）。**新增欄位就走這條，不要動既有欄位型別。**

**28 張表**（分組）：

| 分組 | 表 |
| --- | --- |
| 身分與會期 | `terms`、`sessions`、`legislators`、`memberships`、`committees`、`committee_seats` |
| 議事／預算 | `bills`、`bill_sponsors`、`bill_cosigners`、`budget_bills`、`budget_reports`、`budget_committees`、`progress_overrides`、`committee_meetings`、`committee_records`、`committee_meets` |
| 法規對照 | `law_agencies`、`moj_law_agencies` |
| 新聞 | `news`、`topic_news`、`articles` |
| 社群 | `social_accounts`、`social_posts`、`council_social` |
| 系統 | `raw_snapshots`、`change_log`、`sync_runs`、`meta` |

**寫入策略**（決定「這筆資料會不會被覆蓋」）：

- **整批覆寫**（單一交易 DELETE+INSERT，失敗 rollback）：名錄（`legislators`／`memberships`／`sessions`／`committees`／`committee_seats`）、`bills`、`budget_bills`、`budget_reports`、`committee_meetings`、`committee_records`、`committee_meets`、`law_agencies`、`moj_law_agencies`、`social_accounts`、`council_social`。
- **累積 upsert**：`news`（180 天）、`topic_news`（180 天）、`articles`（180 天）、`social_posts`（**有日期的留 90 天**、沒日期的只留「這輪還抓得到」的）、`budget_committees`、`progress_overrides`。
- **只增不覆寫**：`raw_snapshots`（原始 JSON gzip，以 `(dataset, sha256)` 去重）、`change_log`。

**複合主鍵**：`committee_seats(session_id, committee_id, legislator_id)`、`raw_snapshots(dataset, sha256)`、`bill_sponsors/bill_cosigners(bill_id, legislator_id)`、`news(legislator_id, url)`、`topic_news(topic, url)`、`social_accounts(legislator_id, platform, url)`、`social_posts(legislator_id, platform, fingerprint)`（`fingerprint`＝摘要 sha256 前 16 碼）、`progress_overrides(dataset, id)`。

**保留與清理**：`sync_runs`／`change_log` 預設全部保留（`LY_SYNC_RUNS_KEEP`／`LY_CHANGE_LOG_KEEP` 可設上限）；新聞類 180 天；貼文 90 天。**要省空間就調 env，不要手刪資料表**。

---

## 6. 資料來源與抓取管線

### 6.1 來源清單

| 來源 | 抓什麼 | 寫入 | 頻率 |
| --- | --- | --- | --- |
| 立法院開放資料 id9／id14 | 委員名錄、委員會席次 | `legislators`／`memberships`／`committee_seats` 等 | 每輪全同步（24h） |
| g0v `ly.govapi.tw/v2`（非官方） | 議案、法案、預算、公報議程、會議、逐案委員會 | `bills`／`bill_sponsors`／`bill_cosigners`／`budget_bills`／`committee_records`／`committee_meets`／`budget_committees` | 24h（委員會逐案 30 天內不重查） |
| 立法院預算中心 WebAPI | 預算報告 | `budget_reports` | 24h |
| 立法院開放資料 ID223 | 委員會登記發言 | `committee_meetings` | 24h |
| 立法院開放資料 ID370／ID373 | 院會表決、三讀通過條文與附帶決議 | `rollcall_votes`＋`vote_ballots`／`bill_resolutions` | 24h |
| `ppg.ly.gov.tw` | 議案審議進度 | `progress_overrides`（再套回議案） | 同議案 20h 內不重查 |
| 法務部全國法規資料庫 | 法規 → 主管機關 | `moj_law_agencies` | 距上次 12h 內完全不抓 |
| 委員 Facebook 粉專 | 最新貼文／貼文層級 | CSV → Google 試算表 → `fb-data` → `social_posts` | 每日 08:00（launchd） |
| Google 整理表（委員／議員） | 粉專網址與最新一則摘要 | `social_accounts`／`council_social` | 每輪 social（每日一次） |
| Google 新聞 RSS | 委員／機關／首長／主計／議員新聞 | `news`／`topic_news`／`articles` | 新聞階段（含每 6h 自動重跑） |
| 媒體官方 RSS（中央社／自由／聯合／公視） | 新聞全文摘要 | `articles` + 分派 | 每小時 |
| GitHub Actions `news-data` | 伺服器沒開時漏收的新聞 | `articles`／`news`／`topic_news` | 每小時收集、每輪匯入 |
| 中選會／內政部戶政司（轉存） | 議員選舉、人口月報、地圖 | `server/*.json`（**不走同步**） | 人工／每月 cron |

原始回應一律另存 `raw_snapshots`（可回溯、可重跑）。

### 6.2 管線四段與 fail closed

`FETCH → VALIDATE → NORMALIZE → PERSIST`：

- **FETCH**：具名 UA、逾時 30 秒、同 host 400ms 節流、429/5xx 指數退避＋抖動重試（`LY_FETCH_RETRIES=3`、`Retry-After` 上限 60 秒）。
- **VALIDATE／NORMALIZE**：集中在 `normalize.mjs`，違反就拋 `DataValidationError`（整階段 fail closed）。

| 守門 | 門檻 | 位置 |
| --- | --- | --- |
| 相對上游 total | 取得筆數 < `total × 0.95` → 失敗 | `bills`／`budget` |
| 絕對下限 | id9 < 100、id14 < 1000、單屆 id14 < 100、本屆席次 < 100、議員整理表 < 200、社群整理表 < 100、貼文層級可用貼文 < 10 | `normalize.mjs` |
| 相對上次成功（防暴跌） | 預設 0.8（名錄、社群帳號 0.8；**貼文層級 0.5**）；基準記在 `meta.<key>_count`，只在套用成功後更新 | `ingest.mjs` 的 `guardShrink` |
| 結構 | 缺 `dataList`／缺分頁／分頁數 > 50／名錄未同步就拒跑 bills、budget／法務部解析 0 筆／名字對不到本屆委員 | `ingest.mjs`／`normalize.mjs`／`moj-law.mjs` |
| 新聞 | `legislators.length === 0` 或失敗數 > 處理數的一半 → 失敗 | `ingest.mjs` |

- 合法縮減（上游真的變少）→ `LY_ALLOW_SHRINK=1` 強制覆寫一次。
- **`LY_SKIP_BILLS`／`LY_SKIP_BUDGET`／`LY_SKIP_NEWS`／`LY_SKIP_SOCIAL` 只給驗證腳本用**（`scripts/verify.sh` 只對那一次指令 export，不要在測試或伺服器環境裡長期設定）。

### 6.3 腳本與觸發者

| 腳本 | 用途 | 誰觸發 |
| --- | --- | --- |
| `fb-daily.mjs`（`.sh` 是薄殼） | 每日粉專抓取主流程（鎖、探測、抓取、寫回試算表、推分支、直接匯入 DB、通知） | launchd 08:00；手動 `npm run fb-daily` |
| `fetch-fb-posts.mjs` | Playwright 抓粉專貼文（`--login`／`--verify`／`--ids`／`--limit`） | `fb-daily.mjs` spawn；手動 |
| `import-fb-cookies.mjs` | 匯入已登入瀏覽器的 cookies 到設定檔 | 手動 |
| `push-posts-to-sheet.mjs` | 寫回 Google 整理表（Apps Script Web App） | `fb-daily.mjs`；手動 |
| `push-fb-data.mjs`／`push-news-data.mjs` | 推 `fb-data`／`news-data` 分支 | `fb-daily.mjs`／`news-push.mjs`；手動 |
| `collect-news-rss.mjs` | 媒體 RSS → `news/YYYY-MM-DD.ndjson` | GitHub Actions 每小時 |
| `backfill-news.mjs`／`import-news-csv.mjs` | 回補近 180 天新聞／併入歷史 CSV | 手動 |
| `refresh-county-stats.sh` → `build-county-stats.mjs` | 人口／選舉／地圖靜態資料建置＋體檢 | 手動；Hermes cron 每月 12 日 |
| `fetch-cec-council.mjs`／`build-council-stats.mjs`／`fetch-cec-recalls.mjs`／`fetch-recall-results.mjs`／`build-council-facebook.mjs` | 中選會與議員資料 | 手動（選舉年） |
| `check-rwd.mjs`／`verify-pwa.mjs`／`verify-news-rss.mjs`／`verify.sh` | 驗收 | 手動 |
| `gen-pwa-icons.mjs`／`pack-windows.mjs`／`find-chrome.mjs` | 產圖示／打包 Windows／找 Chrome | 手動／Actions |
| `notify-telegram.sh`／`.mjs` | Telegram 通知（沒憑證只印不送、exit 0） | `fb-daily.mjs`；手動 |

---

## 7. 語意規則（最常改、也最容易改壞的地方）

改這一節的規則時，**交付物固定三樣**：測試斷言（依規則所在挑 `test/api.test.mjs`／`test/ingest.test.mjs`／`test/normalize.test.mjs`／`test/agency.test.mjs`）、`DECISIONS.md` 一條 D 編號、`docs/API.md` 的對應描述。

### 7.1 抓取類別（預算）

- `CONFIG.budget.categories`：`中央政府總預算案`、`法人預(決)算案`、`預(決) 算決議案、定期報告`、`行政命令(層級)`。
- `billCategories`（議案本身）／`scopeCategories`（統計範圍）與上表不同，動之前先確認在改哪一層。
- `行政命令(層級)` 這一類**只留像報告／表的查照案**：`categoryNameFilters` 用 keep／drop 兩組 regex（keep：報告、表、情形、總表、結算…；drop：辦法、規程、標準、細則、要點、編制表…）。理由是同一類別絕大多數是法規命令，全收會把預算頁灌進兩千多筆非預算函件（D281）。
- **只收一部分時，筆數驗證要用「濾除前」的筆數**（上游 `total` 含被排除的那些），否則每一輪同步都會 fail closed。

### 7.2 機關檢送報告 vs 預算審議

- `agencyReportPattern`＝`檢送[^。]*(?:報告|表)|^函送[^，。]*(?:報告|表)`：名稱是機關自己函送的報告或「…執行情形表／…總表」→ 來源分類為 `submitted`（機關檢送報告），不留在 `budget`（預算審議）。
- **不變量**：同一機關「預算審議 ＋ 機關檢送報告」的件數**相加不變**（改這條只是把案件從一類搬到另一類，不是新增資料），測試有釘。

### 7.3 機關歸屬

- g0v 的提案單位先經 `canonicalAgency()`（簡稱 → 現行全名；機關清單在 `agency-names.mjs`）。
- 只寫法規名稱的提案（例：「『氣候變遷因應法』部分條文修正草案」）→ 用 `law_agencies` 對照，三個來源依序：g0v 上游（有填就用）→ 法務部全國法規資料庫（`moj_law_agencies`）→ `server/law-agencies.json` 手工補。

### 7.4 兩個「機關」頁的歸屬規則不同（刻意）

| 頁面 | 函式 | 規則 |
| --- | --- | --- |
| 我的機關 `/my` | `getAgencyHome` | 預算類來源用「**標題或提案單位**」命中 |
| 機關頁 `/agencies` | `listFunds`（`type=agency`） | **標題優先；標題認不出機關時才退回看提案單位**（只限 `budget`／`submitted`） |

為什麼要有後備：機關自己檢送的報告名稱通常不提自己的機關（「函送『115年度中央政府預算截至第1季執行情形書面報告』，請查照案。」），只比標題時這些案件一件都掛不到機關，畫面就變成「這個機關沒在動」。委員會的提案單位（「本院…委員會」）與「行政院」不在機關清單裡，所以不會被誤掛。

**不變量**：同一項（例如「機關檢送報告」）在兩頁的件數**必須一樣**；不一樣就是規則 bug，不是資料沒更新。

### 7.5 年度判定與一案一列

- `budgetFiscalYear()` 三條規則，**順序有意義**：
  1. `(\d{2,3})\s*(?:至|[-~～])\s*\d{2,3}\s*年度` → 取**起始年**（跨年度案）；
  2. `(\d{2,3})\s*年度`；
  3. `(?<![\d自])(\d{2,3})\s*年\s*(?:\d{1,2}\s*月|第\s*\d{1,2}\s*季)` → 名稱只有「年」的定期報告（例「函送115年第2季媒體政策及業務宣導執行情形表」）；前面是「自」的不算（那講生效日）。
- `mergeBudgetUnits()`（`queries.mjs`）：一案一列的**合併鍵是「類別 ＋ 提案單位 ＋ 名稱」**。提案單位進 key 是必要的 —— 各部會每年送**同名**的定期報告，只比名稱會把它們併成一列（代表紀錄只留一家，另一家的件數就「消失」）。代表紀錄取最有進展的狀態（`BUDGET_STATE_RANK`），日期取全部紀錄最新。

### 7.6 改壞時的逐層 debug 順序

1. **資料在不在**：直接 import `server/queries.mjs` 的函式跑 `data/ly.db`（比翻畫面快）。
2. 在的話，**逐層找是被哪一層吃掉的**：① 來源分類（`agencyReportPattern`）② 機關歸屬 ③ 年度判定 ④ 一案一列合併鍵。
3. 不在就比對上游（g0v `ly.govapi.tw/v2`）：0 缺 0 多 → 是我們沒漏抓，往上一層規則找；上游有、DB 沒有 → 檢查**抓取類別**（那一類根本不在 `categories` 裡，整類都不會進資料庫）。

---

## 8. HTTP API

### 8.1 通則

- `/api/*` **只允許 GET**，唯一例外是 `POST /api/v1/sync`；其他方法回 **405 `method_not_allowed`**。
- 錯誤格式固定：`{ "error": { "code": "...", "message": "..." } }`；未攔截的例外回 500 `internal_error`（細節只留伺服器 log）。未知路徑回 404 `not_found`。
- 回應標頭：`x-content-type-options: nosniff` 一律帶；JSON 預設 `cache-control: public, max-age=300`，
  錯誤回應、`/sync`、`/sync-sources` 改 `no-store`；CSV 帶 UTF-8 BOM 且 `no-store`。
- 靜態檔只從 `web/dist` 讀（有防路徑穿越）：`/assets/*` 用 `immutable, max-age=31536000`；`sw.js` 一律 `no-cache, no-store, must-revalidate`；其餘 `no-cache`；找不到就 **SPA fallback 到 `index.html`**；前端還沒 build 時回 404。
- CSV 匯出：`/api/v1/bills?format=csv`、`/budget?format=csv`、`/news/articles?format=csv`。

### 8.2 端點總表（欄位以 `docs/API.md` 為準）

| 端點 | 主要參數 | 什麼頁面在用 |
| --- | --- | --- |
| `/api/v1/health` | —（含 `meta`／`db`／`datasets`／`social`／`retention`／`static_data`／`last_runs`／`warnings`／`syncing`／`progress`／`sync_enabled`） | 頁首狀態、離線判定 |
| `/api/v1/meta` | — | 資料來源與授權 |
| `/api/v1/legislators` | `term, session` | 委員查詢 |
| `/api/v1/committees` | — | 委員會頁、委員頁 |
| `/api/v1/bills` | `legislator, q, law, status, session, from, to, limit, offset, format=csv` | 法案查詢 |
| `/api/v1/budget` | `category, type, q, year, proposer, state, group_by, per_group, scope, merge, include_attachments, format=csv` | 預算審議 |
| `/api/v1/budget/reports`、`/budget/meetings` | `type, q, limit, offset`／`limit` | 預算頁 |
| `/api/v1/regions`、`/counties`、`/town-map`、`/population-trend`、`/demographics`、`/split-ticket`、`/legislator-votes` | `per`／`year`／`id` | 縣市頁、委員檔案 |
| `/api/v1/agency` | `name, per, watch` | 我的機關 |
| `/api/v1/funds` | `type, fund, kind, limit, offset` | 機關／基金／財團法人／行政法人 |
| `/api/v1/council`、`/council/activity` | `county`／`county, councilor, q, source, limit, offset` | 議員頁、議員動態 |
| `/api/v1/social/wall` | `party, region, committee, limit（5）, offset` | 委員粉專牆 |
| `/api/v1/cosponsors`、`/compare`、`/topics`、`/activity`、`/news`、`/news/articles`、`/rankings`、`/changes` | `legislator, limit`／`ids`／`days, limit, vocab`／`since, limit`／`type` | 排行榜、比較、議題、最近動態、新聞 |
| `/api/v1/committee-activity` | `committee, q, limit` | 委員會頁 |
| `/api/v1/recalls` | — | 罷免 |
| `/api/v1/sync-runs` | `limit`（預設 50，夾 1–1000） | 同步紀錄面板（形狀 `{count, items, meta}`） |
| `/api/v1/sync-sources` | —（`no-store`） | 同步範圍下拉 |
| `POST /api/v1/sync` | `scope, force` | 更新鈕（202／403／409／429 語意見 §4.2） |

### 8.3 前端與 API 的約定

- `web/src/api/client.ts` 是**唯一出口**（元件不得自己 `fetch`）；型別全部放 `api/types.ts`。
- 逾時 15 秒；**GET 自動重試一次**（延遲 700ms × 次數），POST 不重試；錯誤統一轉成 `ApiError`（`status`／`code`／`isAbort`）。
- 新聞頁的逾時放寬到 30 秒（伺服器重啟的空窗不該讓使用者看到錯誤畫面）。

---

## 9. 前端

### 9.1 路由

**自製 SPA 路由**（沒有 react-router）：`web/src/hooks/useRoute.ts` 的 `PATHS` 是唯一定義，
`routeOf()` 用前綴比對（**長路徑要排前面**：`/news/all`、`/legislators/wall`、`/council/activity`）、
`legacyRedirect()` 把舊網址換成新的、`pathFor()` 產生帶 query 的網址、`useRoute` 用 pushState 並補發 `popstate`。

| 路徑 | 頁面 |
| --- | --- |
| `/`（舊 `/dashboard`） | `DashboardPage`（總覽，預設首頁） |
| `/activity` | `HomePage`（最近動態＋熱門議題） |
| `/legislators` | `LegislatorsPage`（席次圖＋名錄） |
| `/bills`、`/budget`、`/committees`、`/rankings`、`/compare` | `BillsPage`／`BudgetPage`／`CommitteesPage`／`RankingsPage`／`ComparePage` |
| `/funds`、`/agencies`、`/foundations`、`/administrative`、`/dgbas` | 同一個 `FundsPage`（`FUND_TYPE` 對照 `type`） |
| `/counties`、`/council`、`/my` | `CountiesPage`／`CouncilPage`／`MyAgencyPage` |
| `/news`、`/news/agencies`、`/news/all`、`/officials` | 同一個 `NewsPage`（`scope`） |
| `/facebook/wall`、`/facebook/council` | `SocialWallPage`／`CouncilActivityPage` |

### 9.2 資料層與狀態

- `useApi.ts` 是極簡資料層（**刻意不用 react-query**，理由寫在檔案開頭）：四態 `loading / ready / empty / error`，
  **保留上一份成功資料**避免閃爍，離元件時 AbortController 取消。
- UI 由 `DataStates.tsx` 提供 `LoadingState`／`EmptyState`／`ErrorState`（含重試與 `ConnectionHint`）。
- 連不上時的原因判定在 `lib/connectionHint.ts`、退避重試在 `hooks/useReconnectRefresh.ts`（Tailscale 一連上就自動恢復）。

### 9.3 設計系統與 RWD

- **CSS 變數是唯一色票來源**：`--paper #f5f7fa`、`--ink #101828`、`--accent #2563eb`、`--warn`／`--error` 與其背景色；間距 `--space-1..8`；`--fs-2xs..--fs-3xl`（11–27px）；動畫 `--t-fast/base/slow`。
- **字級縮放**：`--fs-scale` × 各型級；`FontSizeControl` 的倍率表 `[0.9, 1, 1.15, 1.3, 1.5]`，存 localStorage（`font-scale`），`main.tsx` 在 render 前套用避免閃動。
- **斷點**：`1100px`（平板／手機：頁首改 static、次級導覽改 sticky）、`761–1100px`（平板頁首兩列、觸控高度 40px）、`900px`（多欄改單欄）、`760px`（手機主斷點：主導覽變可橫向捲動的頁籤列＋`.nav-icon`）。
- **觸控目標**：手機主要控制項與席次圖圖例鈕 `min-height: 44px`（由 `npm run check:rwd` 守門）。
- **手機第二層頁籤**：≤760px 開右側卡片（`PageCard`），決策是純函式 `lib/nav.ts`（`CARD_MAX_WIDTH=760`，與 CSS 同一條線）；真實寬度判斷在 Header 點擊時做。
- **黨籍顏色**只在 `web/src/lib/parties.ts` 定義（介面上除了黨籍不該有第二種顏色語意）。

### 9.4 PWA

- `web/public/manifest.webmanifest`：`name`／`short_name` 立委觀測站、`start_url: '/'`、`display: standalone`、`theme_color #2563eb`、`background_color #f5f7fa`、三顆圖示（192 any／512 any／512 maskable）。
- `web/public/sw.js`：`CACHE='ly-shell-v3'`；install 用 `Promise.allSettled` 逐筆 precache app shell（容忍個別失敗）；activate 清掉舊 cache 並 `clients.claim`；
  **`/api/` 一律不進快取**（本站數字每天更新）；導覽請求一律對到 `/`；策略是 stale-while-revalidate。
- **改了 app shell 資源（尤其圖示）要 `CACHE` +1**，否則既有安裝會一直吃舊快取。
- **圖示檔名帶版本（`ICON_VERSION`）**：`icon-192-v2.png`、`icon-512-v2.png`、`icon-maskable-512-v2.png`、`apple-touch-icon-v2.png`。
  改圖示時的固定動作：`ICON_VERSION` +1、刪掉舊版檔案、同步改 `manifest.webmanifest`／`web/index.html`／`sw.js` 的 SHELL 與 `CACHE`。
  為什麼要版本化：Android 的 Chrome **只在 manifest 有變動時**才重建 WebAPK（只換 PNG 內容、檔名不變的話主畫面圖示會一直是舊的）；
  iOS 更是「加入主畫面」當下就寫死，一定要移除再重新加入。這四處的一致性由 `test/pwa-icons.test.mjs` 釘住。
- 圖示由 `scripts/gen-pwa-icons.mjs` 用 Chromium 畫同一份 SVG（議事殿堂）：192／512 同構圖（不印站名）、maskable／apple 滿版藍底且 mark 縮到安全圓內；產生器會驗 PNG 實際尺寸與「mark 左右對稱（質量中心）」。
- `web/index.html` 的 iOS meta（`apple-mobile-web-app-capable` 等）不能拿掉，否則「加到主畫面」不會全螢幕。

---

## 10. 測試與驗收（四層）

| 層 | 指令 | 驗什麼 | 需要什麼 |
| --- | --- | --- | --- |
| 後端單元／回歸 | `npm test` | `test/*.test.mjs`：fail-closed、交易回滾、`change_log`、排行榜、主管機關對照、同步範圍路由、預算四層規則、PWA 圖示幾何…（fixture 是真實 API 回應，不打網路） | Node |
| 前端煙霧（邏輯） | `npm --prefix web test`（含 `tsc -b`） | `smoke.ts`：URL 篩選來回一致、屆次語意、client 的錯誤映射、格式化函式 | Node |
| 前端渲染煙霧 | 同上 | `render-smoke.ts`：用 `react-dom/server` 的 `renderToStaticMarkup` **在無瀏覽器環境驗 DOM**（導覽兩層、卡片、粉專牆 chips、面量圖不得 NaN、色階未知值）、四態替身 | Node |
| 瀏覽器實測 | `npm run check:rwd`／`npm run verify:pwa` | 逐路由橫向溢出（容 1px）、頁籤文字置中（≤2px）、圖例觸控 ≥44px；PWA：SW 註冊、`/api/` 不進快取、離線外框與提示 | 系統 Chrome（`find-chrome.mjs`）＋本機伺服器／HTTPS 來源 |
| 端到端 | `bash scripts/verify.sh`（快速，約 8.5 分）／`--full`（約 20 分） | 測試 → ingestion → API 端點 → 前端靜態檔；`--full` 才打外部來源 | 網路 |

**邊界要知道**：render smoke 是 server render，**不執行 `useEffect`** —— 依賴效果的行為（捲動、真實抓取）只能用無頭瀏覽器量；`check-rwd` 的 `ROUTES` 要跟 `useRoute.ts` 的 `PATHS` 對齊。

**CI**（`.github/workflows/ci.yml`）：`main` 的 push／PR 在 **ubuntu／macos／windows** 三個平台跑
`npm ci` → `web ci` → `web build` → `npm test`（`windows-port.test.mjs` 就是靠這個在真的 Windows 上跑一次）。Node 24。

---

## 11. 開發慣例

1. **每個語意決定留一條 D**（`DECISIONS.md`），規則改動要三樣：測試斷言、D 編號、`docs/API.md` 對應描述。
2. **使用者指名要釘住的東西，就照那個粒度寫測試**（例：「主計總處的三張優先順序總表要進得來」→ 三個真實名稱都要在、被排除的反例不得進）。
   只斷言「共幾筆」等於沒釘住。
3. **不要手改資料檔或資料庫**：很多欄位是重跑建置算出來的，手改會在下次同步／建置復發（要改就改建置腳本或規則）。
4. **零 runtime 相依**：後端不要引入 npm 套件（`node:sqlite`／`node:test`／`fetch` 都有內建）；新增 `devDependencies` 要能跨三平台安裝。
5. **跨平台**：會用到 Chrome 的腳本走 `scripts/find-chrome.mjs`；不要把某台機器的絕對路徑寫死；shell 只用在 macOS 專屬的入口，核心邏輯放 `.mjs`（Windows／Termux 才能共用）。
6. **機密一律在 repo 外**（`~/.ly-dashboard/*`，權限 600）；`apps-script/Code.js` 不進版控。
7. **commit 訊息**：`type(scope): 中文說明（量測到的效果）`，例：`fix(agencies): 機關頁的預算類來源改看提案單位（主計總處 5→90／1→18）`。
8. **畫面上的數字要對得上**：同一個語意（例如件數）在不同頁面必須一致，不一致就是 bug（審計背景的使用者會立刻抓到）。

---

## 12. 變更流程 SOP

```bash
# 1) 改程式
npm test                       # 後端（含新規則的斷言）
npm --prefix web test          # 前端（有動前端才需要，但很快）
npm --prefix web run build     # 有動前端才要（伺服器服務的是 web/dist）

# 2) 生效
launchctl kickstart -k gui/$(id -u)/com.hermes.ly-dashboard-server
#   改的是抓取規則（normalize／ingest）→ 重啟後再觸發一次同步，舊資料才會回溯套用
curl -s -X POST 'http://127.0.0.1:8787/api/v1/sync?force=1' | jq

# 3) 驗收（至少看 API 與畫面各一次）
curl -s 'http://127.0.0.1:8787/api/v1/funds?type=agency&kind=submitted&fund=<機關>' | jq '.total'
npm run verify:pwa             # 有動 PWA／前端外框時
```

**四個常見陷阱**（都在 `DECISIONS.md` 有案例）：

1. **同步是在伺服器行程裡跑的**：只改檔案、沒重啟就觸發同步 → 那一輪會用舊模組跑完並回報 success，看起來像「改了沒用」。
2. **Service Worker 快取版本**：改了 app shell／圖示，`sw.js` 的 `CACHE` 要 +1。
3. **`NORMALIZER_VERSION`**：改了 `normalize.mjs` 的行為要 +1，否則內容指紋沒變會被判定「未變更」而跳過重寫（來源沒變時尤其明顯）。
4. **靜態 JSON 快取**：`queries.mjs` 把 `server/*.json` 快取在記憶體，改檔或重跑建置後**一定要重啟**（只有「全部新聞」用 WeakMap 依資料版本自動失效）。

---

## 附錄 A：環境變數

完整表格見 `docs/OPS.md` 附錄 B（維運會調的那些）；要全部列出：

```bash
grep -rhoE "process\.env\.[A-Z_]+" server scripts windows | sort -u
```

重點：`LY_HOST`／`PORT`／`LY_DB`／`LY_SYNC_TOKEN`／`LY_STALE_HOURS`／`LY_SYNC_INTERVAL_MS`／`LY_SCHEDULER_CHECK_MS`／
`LY_NEWS_REFRESH_MS`／`LY_NEWS_OUTLET_INTERVAL_MS`／`LY_FB_LOCAL_INGEST`／`LY_ALLOW_SHRINK`／`LY_SKIP_*`。

> `LY_FB_LOCAL_INGEST` **不在 `config.mjs`**，定義在 `scripts/fb-daily.mjs`（預設 `'1'`）。

## 附錄 B：一眼看出「要改哪裡」

| 想做的事 | 改哪裡 | 交付物 |
| --- | --- | --- |
| 新增一種抓取類別／來源 | `server/config.mjs`（`categories`／端點）＋`server/ingest.mjs`（runner）＋`sync-scopes.mjs`（若成新階段） | 測試＋D＋`docs/API.md` |
| 改機關歸屬／年度／合併鍵 | `server/normalize.mjs`（`budgetFiscalYear`）／`server/queries.mjs`（`mergeBudgetUnits`、`listFunds`） | 同上（`NORMALIZER_VERSION` 視情況 +1） |
| 改某頁面的呈現 | `web/src/pages/*`＋`web/src/components/*`＋`styles.css` | `npm --prefix web test`＋`npm run check:rwd` |
| 新增 API 端點 | `server/index.mjs`（路由）＋`server/queries.mjs`（視圖）＋`web/src/api/` | 測試＋`docs/API.md` |
| 改前端資料流／狀態 | `web/src/hooks/useApi.ts`、`web/src/api/client.ts` | smoke／render-smoke |
| 改排程／服務 | `scripts/launchd/*`（樣板）→ `scripts/launchd/install.sh`（重新載入） | `docs/OPS.md` §1 |
