# 立委觀測站（重寫版）

依 `../lid-feasibility/PLAN.md` 實作：**伺服器端 ingestion → SQLite → 自有 API → TypeScript 前端**。
前端不再直接面對 `data.ly.gov.tw`。

## 為什麼要重寫（都是實測結論）

| 舊版問題 | 這一版怎麼解 |
| --- | --- |
| 瀏覽器直連政府 API，被 CORS 全擋，只顯示 2 筆假立委 | 抓取搬到伺服器（`server/fetch-ly.mjs`），前端只讀同源 `/api/v1/*` |
| Node/OpenSSL 連不上（`unsafe legacy renegotiation disabled`） | `https.Agent({ secureOptions: SSL_OP_LEGACY_SERVER_CONNECT })` |
| WAF 對預設函式庫 UA 回 403 | 具名可聯絡 UA（`LY_UA` 可覆寫），並記錄在 `sync_runs.ua` |
| 委員會字串含「第11屆第3會期：」前綴 → 70 種分類 | `parseSeatLabel()` 剝前綴，測試強制所有委員會 id 不含「會期」 |
| id14 涵蓋第 4–11 屆，只按姓名 join → 122/123 人被污染、召委 84 人 | 只取本屆（term 11），召委綁 `(session, committee, legislator)`，去重後 **68 人／本會期 23 人** |
| 委員 id 用陣列索引 → 追蹤會錯人 | 用立院 `lgno`（退回 `ename`）當穩定 id |
| 同步失敗就端出假資料 | **fail closed**：驗證不過就保留舊資料、記錄失敗、標記 stale，前端顯示「資料截至 …」 |
| 無異動紀錄、無原始快照、無測試 | `change_log` + `raw_snapshots`(gzip) + 98 項後端測試＋58 項前端測試 |

## 快速開始

```bash
# 1) 抓資料進 SQLite（打真實立法院 API，約 7 秒）
node server/ingest.mjs

# 2) 跑測試（98 項，不需要網路，用 test/fixtures 的真實 API 回應）
npm test

# 3) 建置前端
npm --prefix web install
npm --prefix web run build

# 4) 啟動 API + 前端（http://127.0.0.1:8787）
node server/index.mjs
```

- `--no-scheduler`：只開 API，不在啟動時自動同步（開發用）。
- 環境變數：`PORT`、`LY_HOST`、`LY_SYNC_TOKEN`、`LY_DB`、`LY_UA`、`LY_STALE_HOURS`、`LY_SYNC_INTERVAL_MS`、`LY_FETCH_TIMEOUT_MS`、`LY_FETCH_RETRIES`、`LY_RETRY_AFTER_CAP_MS`、`LY_SHRINK_MIN_RATIO`、`LY_ALLOW_SHRINK`、`LY_STATIC_STALE_MONTHS`、`LY_SKIP_BUDGET`（跳過預算三個來源）。

## 架構

```
cron/啟動排程 (24h)                      server/ingest.mjs
   └─▶ fetch-ly.mjs ──▶ normalize.mjs ──▶ db.mjs (SQLite)
       具名UA/TLS修補     純函式/可測      交易寫入 + change_log + raw_snapshots
                                                  │
                          queries.mjs ◀───────────┘
                                │
                    http://127.0.0.1:8787/api/v1/*  ──▶ web/ (React+TS，只讀自家 API)
```

| 檔案 | 職責 |
| --- | --- |
| `server/config.mjs` | 端點、UA、排程與逾時設定 |
| `server/fetch-ly.mjs` | HTTPS 抓取：TLS legacy 修補、逾時、指數退避＋抖動重試 |
| `server/normalize.mjs` | **純函式**：前綴剝除、屆次隔離、穩定 id、席次／召委建模、fail-closed 驗證 |
| `server/db.mjs` | schema、交易式覆寫、change_log、raw snapshot(gzip) |
| `server/ingest.mjs` | 管線：FETCH → VALIDATE → NORMALIZE → PERSIST → sync_runs |
| `server/queries.mjs` | API 視圖（本會期名錄、委員會、異動、健康狀態） |
| `server/index.mjs` | HTTP API + 靜態檔 + SPA fallback + 每日排程 |
| `scripts/fetch-cec-council.mjs` | 抓中選會「直轄市議員選舉」原始檔（60 個 CSV）到 `.cache/cec-council`，不做整庫 clone |
| `scripts/build-council-stats.mjs` | 解析上述原始檔 → `server/council-stats.json`（議員選舉結果，四年一次，手動重跑） |
| `scripts/fetch-cec-recalls.mjs` | 抓中選會官方罷免清單 → `server/recalls.json`（35 案） |
| `scripts/fetch-recall-results.mjs` | 解析 6 份官方文件的同意／不同意票數（PDF／ODS，5 種格式）→ 補進 `server/recalls.json`（需要 `pdftotext` 與 `unzip`；`--check` 只比對不寫檔） |
| `docs/API.md` | 凍結的 API 契約（前端依此實作） |
| `test/*.test.mjs` | 用真實 API 回應當 fixture 的回歸測試 |
| `web/src/api/` | 型別化 API client（唯一出口，前端不碰政府端點） |
| `web/src/lib/urlState.ts` | 篩選條件的 URL 序列化（可分享、可上一頁） |
| `web/src/hooks/useApi.ts` | `loading / ready / empty / error` 四態資源 hook |
| `web/src/pages/` | `DashboardPage`（總覽，預設首頁 `/`）、`HomePage`（最近動態 `/activity`）、`RankingsPage`、`LegislatorsPage`（議場席次圖＋名錄）、`BillsPage`（法案查詢）、`BudgetPage`（預算審議）、`FundsPage`（基金 `/funds`、機關 `/agencies`、財團法人 `/foundations`、行政法人 `/administrative`、主計總處 `/dgbas`）、`ComparePage`（委員比較）、`CommitteesPage`（委員會 `/committees`：最新會議附件與影片、機關回覆、公報會議紀錄）、`CouncilPage`（議員 `/council`：直轄市議員選舉結果） |
| `web/src/components/` | Header（導覽＋同步狀態）、Hemicycle（議場席次圖）、LegislatorGrid／LegislatorTable、LegislatorDetail、CommitteeChart（委員會黨籍組成）、SyncStatusBanner、FilterBar、ChangesPanel |
| `web/src/lib/parties.ts` | 黨籍顏色與順序：介面中「顏色只代表黨籍」的唯一定義處 |
| `web/scripts/smoke.ts`、`render-smoke.ts` | 前端煙霧測試（26 + 35 項），**只存在於 dev，不進 bundle** |

## 資料模型重點

- `legislators`：身分（123 位追蹤對象，含已離職者）。
- `sessions` / `memberships`：**會期是查詢單位**。立法院固定 113 席，因此每個會期名錄都是 113 人，但組成人員會因辭職／遞補而變動（第 1 與第 5 會期有 8 人不同）。
- `committee_seats`：事實表，`is_convener` 綁在會期上；跨會期去重後才是「曾任召委」。
- `change_log`：每次同步與前一版比對，記錄 `is_convener`、黨籍、選區、離職狀態的變化。
- `raw_snapshots`：原始 JSON gzip 保存（sha256 去重），可回溯、可重跑。
- 2 位在本屆委員會欄位中無任何會期紀錄者（游錫堃、李貞秀）**不編造會期**，以屆次層級保留並發出警告（見 `/api/v1/health` 的 `warnings`）。

## 驗證（可重跑）

```bash
bash scripts/verify.sh                      # 一鍵（快速：跳過外部來源，約 15 秒）
bash scripts/verify.sh --full               # 一鍵（完整：含 g0v／Google 新聞／試算表，約 4 分鐘）
npm test                                    # 後端 135 passed（fail-closed、交易回滾、change_log、排行榜、M1–M5 與第三輪回歸）
node scripts/verify-news-rss.mjs            # 媒體官方 RSS 打真網路逐家驗（抓得到／解析得出來／真的對得上委員）；只讀，不動 data/
node scripts/verify-news-rss.mjs <url>      # 試別的 feed（例如比較 udn 的分類 id，見 DECISIONS D101）
node scripts/backfill-news.mjs              # 一次性回補近 180 天的委員／首長／主計／機關新聞（Google 日期區間查詢）；預設跑 30 分鐘、可中斷接續（--minutes、--delay-ms、--reset、--status）
npm --prefix web test                       # 前端 tsc -b＋煙霧／渲染煙霧，58 項全過
node server/ingest.mjs                      # 123 位委員 / 783 席次 / 5 會期 / 113 本會期名錄 + 議案／社群／新聞
node server/ingest.mjs                      # 第二次：名錄 status=skipped（sha256 + 正規化版本未變）
LY_SKIP_NEWS=1 LY_SKIP_BILLS=1 node server/ingest.mjs   # 只同步名錄（秒級，不打第三方）
curl -s localhost:8787/api/v1/health
curl -s "localhost:8787/api/v1/committees"  # 11 個委員會（含召委名單）
curl -s "localhost:8787/api/v1/legislators?convener=1" | jq .total   # 23
```

實際輸出（2026-09-30 實跑）：

```
stats: {"legislators":123,"memberships":567,"seats":783,"committees":11,"sessions":5,
        "current_session":"11-5","current_roster":113,
        "conveners_current_session":23,"conveners_any_session":68}
warnings: ['游錫堃 在本屆無任何會期委員會紀錄（辭職）', '李貞秀 在本屆無任何會期委員會紀錄（開除黨籍）']
```

前端瀏覽器實測（`http://127.0.0.1:8787/`，真實資料、無網路 mock）：

| 操作 | 結果 |
| --- | --- |
| 載入首頁 | 113 張委員卡、11 個委員會分類、「資料截至 2026/09/30 09:16」、無任何示範資料 |
| `?session=11-1` | 113 位（含當時仍在任、後來辭職的黃國昌） |
| `?convener=1` | 23 位本會期召委 |
| `?committee=內政委員會` | 13 位 |
| UI 切換會期 | 網址同步為 `?term=11&session=11-1` |
| 搜尋「雲林」＋只看召委 | 2 位 → 0 位 |
| 詳情側欄 | 顯示學經歷／會期清單／來源連結，`Esc` 可關閉 |

畫面截圖（2026-09-30 改版後）：`docs/shot-home.png`（最近動態）、`docs/shot-rankings.png`（排行榜）、`docs/shot-legislators.png`（委員查詢）。

## Android 平板（Termux）

需求：Termux（F-Droid 版）、`pkg install nodejs git`（Node ≥ 22.5）；要桌面捷徑再裝 **Termux:Widget**。

```bash
git clone https://github.com/cormort/ly-dashboard.git && cd ly-dashboard
bash start-termux.sh                 # 直接啟動；瀏覽器開 http://127.0.0.1:8787
bash termux/install-shortcuts.sh     # 建立兩個桌面捷徑（只需一次）
```

| 檔案 | 作用 |
| --- | --- |
| `start-termux.sh` | 套件變動時 `npm ci`、前端有改時重 build、啟動伺服器 |
| `termux/launch.sh` | 結束舊伺服器 → 啟動 → 就緒後自動開瀏覽器（伺服器留在視窗前景，關視窗即停止） |
| `termux/update.sh` | `git pull` 後執行 `launch.sh` |
| `termux/install-shortcuts.sh` | 在 `~/.shortcuts` 建立「立委觀測站」「更新立委觀測站」兩個捷徑（只轉呼叫上面的腳本，更新腳本不必重裝捷徑） |

注意：伺服器要保持執行，每日排程才會跑；`git pull` 需要 GitHub Token（私有儲存庫），可用 `git config --global credential.helper store` 記住。
捷徑視窗可能帶 `NODE_ENV=production`，`launch.sh` 已明確覆寫，否則 npm 會略過 `tsc`/`vite` 導致 build 失敗。

## 部署（尚未執行，待決定）

1. **排程宿主**：Cloudflare Worker + D1 + Cron，或小 VPS + SQLite + cron。兩者都必須先做 30 分鐘 spike：從目標 runtime 打一次 `data.ly.gov.tw`（帶具名 UA），確認 TLS 與 WAF 都過。
2. **前端**：`web/dist` 是純靜態檔，放 Pages/Vercel/任何空間。
3. **程式已推上 GitHub**（`main` → `0f96ff7`，2026-10-02；前一次是 `bce854c`）。**部署本身還沒做**：
   建立 Worker／VPS／Pages、對外發布 API 都還沒執行，記錄於 `DECISIONS.md`（D9）。

部署到非 loopback 時的**必要設定**（CR-7 已實作，2026-10-02）：

```bash
LY_HOST=0.0.0.0 LY_SYNC_TOKEN=<隨機字串> node server/index.mjs   # 沒有 token 時 POST /api/v1/sync 直接回 403（停用）
curl -X POST -H "x-sync-token: <隨機字串>" localhost:8787/api/v1/sync?scope=roster
```

## 維運與限制

執行時**不需要 AI**：只有 Node + SQLite + 靜態前端，程式裡沒有呼叫任何 AI 服務。
伺服器啟動後每 24 小時自動同步；所有分類（預算類型、審議狀態、立法流程）都是固定規則。
任何來源抓取失敗或格式不符都 **fail closed**：保留舊資料、記錄在 `sync_runs`，頁首顯示「資料截至…」與同步狀態。

但它不是完全免維護，以下情況需要人工介入：

| 情況 | 會發生什麼 | 怎麼處理 |
| --- | --- | --- |
| **伺服器沒在跑** | 排程在伺服器程式內（不是系統 cron），關機或程式停止就不會更新 | 放在常開的機器上；或改用系統 cron 定時跑 `node server/ingest.mjs` |
| **外部來源改版** | 該資料集持續同步失敗，畫面標示資料過期。g0v 立法院 API 是社群維護的非官方 API，改版機率高於官方 | 看 `/api/v1/sync-runs` 的錯誤訊息，改 `server/normalize.mjs` 或 `server/config.mjs` |
| **社群帳號整理表** | 人工維護的 Google 試算表；委員換帳號、遞補時不會自動更新 | 有人定期更新表格（網址可用 `LY_SOCIAL_CSV` 覆寫）。已知錯誤的網址放在版本控管的更正表 `server/social-overrides.json`（17 筆：15 筆 facebook 覆蓋＋1 筆 threads＋1 筆 deny） |
| **分類規則遇到新寫法** | 新的議案狀態或名稱寫法對不到規則：落到「其他」、不顯示流程條或預算類型，不會壞掉 | 偶爾檢查，補 `web/src/lib/billStage.ts`、`server/normalize.mjs` 的 `budgetTypes()`、`server/queries.mjs` 的 `BUDGET_PENDING` |
| **換屆（第 12 屆）** | 會依名錄切換屆次；合成測試已涵蓋（屆次／會期／席次整組切換、舊屆次查不到、`?session=舊會期` 退回最新會期），但**真實換屆當下仍然沒有跑過** | 換屆後手動同步一次並檢查各頁 |
| **來源回應被截斷**（回了一半、分頁壞掉） | 整批覆寫的表（名錄／席次／公報紀錄／會議附件／ID223）會比對上次成功的筆數，掉超過 20% 就 **fail closed** 保留舊資料，並寫入 `sync_runs` 的 failed | 看 `/api/v1/sync-runs` 的錯誤；若確認是來源合法縮減，用 `LY_ALLOW_SHRINK=1 node server/ingest.mjs` 強制覆寫一次 |
| **更正表的委員離職／改名** | 更正表對不到在職委員時**整個社群階段 fail closed**（不再只是警告後靜默丟棄，見 D44） | 錯誤訊息會指出是哪一筆；把該筆從 `server/social-overrides.json` 移除或改成現任委員 |

另外幾個已知的資料性質（不是故障）：

- **「預算會議」以關鍵字判斷**（會議事由含「預算」），順帶處理預算書面報告的會議也會算入，發言場次是上限值。
- **沒有預算金額**：目前來源只有預算案的審議狀態與報告，不含各機關歲出金額；要金額需另接主計總處資料。
- **委員會頁尚未涵蓋的區塊**：立法院全球資訊網各委員會「業務成果」頁（例：[財政委員會](https://www.ly.gov.tw/Pages/List.aspx?nodeid=378)）的**會議概況、考察活動、審竣議案、會務報告、待審議案**只以網頁文章形式存在於 ly.gov.tw，沒有開放資料或 g0v API，要納入需逐委員會爬網頁。其餘區塊已涵蓋：會議情形的附件（含書面報告、機關回覆）與影片、議事錄（公報委員會紀錄）。

### 前端看到的東西，哪些存在本地資料庫、哪些沒有

使用者問過「前端顯示的那些訊息會不會被留在本地 database」。完整清單如下（**資料庫在 `.gitignore`，不會進 GitHub**）：

| 前端顯示的東西 | 存在哪 | 保留多久 |
| --- | --- | --- |
| 委員名錄／席次／委員會／聯絡方式 | **SQLite**（`legislators`、`memberships`、`committee_seats`） | 每次同步整批覆寫（只保留最新一版） |
| 議案、預算案、預算報告、委員會會議與紀錄 | **SQLite** | 每次同步整批覆寫 |
| 新聞標題與連結（`news`） | **SQLite** | **累積**保存 180 天（`LY_NEWS_*`），過期自動刪 |
| 原始新聞庫（`articles`：媒體 RSS 每一則＋摘要、Google 新聞結果） | **SQLite** | **累積**保存 180 天；媒體 RSS 每小時輪詢（`LY_NEWS_OUTLET_INTERVAL_MS`，預設 1 小時，0＝停用），每日同步時對全庫重新分派 |
| 媒體 RSS 收集檔（`news/YYYY-MM-DD.ndjson`） | **git：`news-data` 分支** | GitHub Actions（`.github/workflows/collect-news.yml`）每小時收集、只增不刪；伺服器每小時與每日同步時匯入（`LY_NEWS_FEED_URL`，空字串＝不匯入；repo 目前公開，不需要 token；若改回私人，要設 `LY_GITHUB_TOKEN`＝只有此 repo Contents 唯讀權限的 fine-grained token），補伺服器沒開時漏掉的 |
| 臉書專頁與最新貼文摘要（`social_accounts`） | **SQLite** | 每次同步整批覆寫；人工更正過的帳號會清空貼文摘要 |
| 「最近異動」面板（`change_log`） | **SQLite** | **預設全部保留**；可設 `LY_CHANGE_LOG_KEEP=500` 只留最近 500 筆 |
| 「同步紀錄」面板（`sync_runs`） | **SQLite** | **預設全部保留**；可設 `LY_SYNC_RUNS_KEEP=200` 只留最近 200 筆 |
| 原始 API 回應快照（`raw_snapshots`，gzip） | **SQLite** | 內容有變才存一份，目前 5 筆；用來回溯「上一版長什麼樣」 |
| 篩選條件（`?term=&session=&q=…`） | **網址**（可分享、重整後還在） | 不落地 |
| ⭐ 追蹤名單、卡片／列表偏好、上次造訪 | **瀏覽器 localStorage** | 只在使用者自己的瀏覽器，伺服器看不到 |
| 「找不到這位委員的資料」等提示 | **前端記憶體** | 重新整理就消失 |

預設**不刪任何紀錄**（使用者確認要落地）。若要限制成長，再給上限：

```bash
LY_SYNC_RUNS_KEEP=200 LY_CHANGE_LOG_KEEP=500 node server/ingest.mjs   # 只留最近 N 筆；0 = 不刪
curl -s localhost:8787/api/v1/health | jq .retention                   # 目前筆數與上限
```

實測成長量：一輪完整同步約產生 9 筆同步紀錄；異動紀錄只在欄位真的變動時才寫入
（本次 113 位委員的粉專更正產生 16 筆，之後每次同步 0 筆；2026-10-02 再追加 1 筆 deny）。以每天同步一次估算，
一年約 3,300 筆同步紀錄，對 SQLite 是無感的量。

## Code Review（2026-09-30）

（第一輪自我 review，保留為歷史紀錄）後端測試全數通過；`scripts/verify.sh` 對真實 API 端到端通過。

### 🟡 已修正（Medium）

| # | 問題 | 修正 |
|---|---|---|
| CR-1 | `applyDataset` 的 `setMeta` 呼叫在 `COMMIT` 之後，metadata 可能與資料不一致 | 移入交易內 |
| CR-2 | `Legislator` 型別缺 `former` / `leave_date` / `leave_reason` | 補齊 |
| CR-3 | `HealthDbCounts` 缺 `sessions` / `committees` / `snapshots` | 補齊 |
| CR-4 | `HealthResponse` 缺 `warnings` | 補齊 |
| CR-5 | `applyDataset` 與 `buildDataset` 中 O(n²) 線性掃描 | 改用 `Map` |
| CR-6 | `ALL_SESSIONS` 在 `types.ts` 與 `urlState.ts` 重複定義 | 唯一定義處在 `web/src/lib/urlState.ts`，其他模組由它 import（原本這格把方向寫反了，2026-10-02 更正） |

### 🔴 第二輪已修正（Bug）

| # | 問題 | 修正 | 測試 |
|---|---|---|---|
| A1 | 內容未變更（`skipped`）時不更新 `last_success_at` → 36 小時後 `/health` 誤報 stale、每次重啟都重抓 | skipped 分支也寫入 `last_success_at` | `A1: Unchanged data updates last_success_at…` |
| A2 | `fetch-ly` 的 response stream 無 `error` listener，下載中斷線會讓 process 崩潰 | `res.on('error', reject)` | — |
| A3 | `POST /api/v1/sync` 與排程可同時打政府 API | `syncOnce()` single-flight | `A3: Concurrent syncs are single-flighted…` |
| A4 | `/health` 的 `last_runs` 欄位少於 `SyncRun` 型別，前端顯示「undefined ms」 | 與 `/sync-runs` 共用 `toSyncRun()` | `A4: getHealth().last_runs items…` |
| A5 | `limit`／`offset` 未夾限（SQLite 負 LIMIT = 無上限） | 夾到 1..1000、offset ≥ 0 | `A5: Paging parameters…` |
| B1 | `SyncRun.attempt` 實際可能為 `null` | 型別改 `number \| null`，`RunRow` 做 null 防護 | `tsc -b` |

### 🟠 已知但保留（需帳號或部署後才有意義）

| # | 問題 | 現況 |
|---|---|---|
| CR-7 | `POST /api/v1/sync` 無驗證 | **已修正（2026-10-02）**：`LY_SYNC_TOKEN` 常數時間比對，沒設 token 時僅 loopback 可用、對外直接 403（見 D51） |
| CR-8 | `timer.unref()` | 無實際影響：HTTP server 本身會維持 process 存活；若日後排程與 server 拆開執行才需移除 |
| CR-9 | `getHealth` 中 `count(table)` 使用字串插值（非參數化） | **已修正（2026-10-02）**：改成由常數清單 `HEALTH_TABLES` 產生，呼叫端再也傳不進字串 |
| CR-10 | `queries.mjs` 動態 `IN` 子句 | 參數化正確但依賴 `resolveScope` 驗證，加了 invariant 註解 |
| CR-11 | 根目錄無 `package-lock.json` | server 端目前零 npm 依賴，不需要 lockfile |

## 第二輪 Review 修正與新功能（2026-09-30）

獨立複審報告：`docs/review-2026-09-30-round2.md`。以下為已套用的修正，每一項都有測試或瀏覽器實測。

### 🔴 高（使用者可見，已用真實瀏覽器重現後修正）

| # | 問題 | 修正 | 驗證 |
| --- | --- | --- | --- |
| H1 | 法案頁點「已離職委員」的提案人完全沒反應（`DetailById` 沒帶 session，查到空結果就靜默關閉） | 新增 `legislatorDetailUrl()`，一律帶 `session=all`；查不到時顯示「找不到這位委員的資料」 | 瀏覽器實測：點吳春城（00015）→ 檔案正常開啟（修正前：無反應）；`smoke.ts` 斷言 URL 必含 `session=all` |
| H2 | 換會期不清委員會條件 → 篩選列顯示「全部委員會」卻 0 筆 | `resetForSessionChange()` 清掉 committee；再加第二道防線：committee 不在該會期清單時視為未指定 | 瀏覽器實測：11-5＋修憲委員會（39 人）→ 切 11-4 → URL 已無 committee、名錄 113 人（修正前 0 人） |

### 🟡 中

| # | 問題 | 修正 | 驗證 |
| --- | --- | --- | --- |
| M1 | `verify.sh` 過期：會對 Google 發 226 次請求、約 8 分鐘，且沒驗新端點 | 改寫成快速（預設，跳過外部來源）／`--full` 兩模式；新增 `LY_SKIP_BILLS`／`LY_SKIP_NEWS`／`LY_SKIP_SOCIAL` 開關；補驗排行榜等新端點 | `docs/verification.txt`、`docs/verification-full.txt` |
| M2 | 新資料集沒有原始快照與異動紀錄 | 議案與社群都存 gzip 快照；議案狀態變更、社群帳號新增／移除寫入 `change_log` | 測試 `M2: 議案狀態變更會寫入 change_log` |
| M3 | `POST /api/v1/sync` 要等約 4 分鐘 | 改回 `202` 背景執行、支援 `?scope=roster`（約 7 秒）、single-flight 合併重複請求 | 測試 `M3`；`/api/v1/sync` 實測回 202 |
| M4 | 社群來源是單一試算表，掉資料只能整批失敗且沒有預警 | 除了絕對門檻，再與上次筆數比較（掉超過 20% → fail closed）；`/health` 回報各資料集狀態與 notices | 測試 `M4: 社群帳號數掉超過 20% 時 fail closed` |
| M5 | 新聞階段沒有總時間上限（113 位依序抓） | 新增 `LY_NEWS_BUDGET_MS`（預設 5 分鐘），用完停止剩餘委員、標記 `partial` 並在 health 提示 | 測試 `M5: 新聞同步有時間預算…` |

### 🟢 低

| # | 問題 | 修正 |
| --- | --- | --- |
| L1 | README 測試數字三個版本並存 | 統一（本檔所述數字由 `npm test`／`npm --prefix web test` 產生） |
| L2 | `docs/API.md` 缺 `committees.parties`、`legislators.former`、`health.datasets` | 已補齊，並新增 `/api/v1/rankings` 與 `POST /sync` 的 202 語意 |
| L3 | `listNews` 用 `where.replace(...)` 字串手術 | 改成兩個明確查詢 |
| L4 | `upsertNews` 每筆先 SELECT | 改 `INSERT OR IGNORE` + 已存在才 UPDATE |
| L5 | Hemicycle 席次可點但不可鍵盤操作 | 文案改為引導鍵盤使用者到名錄／列表 |
| L6 | `aria-controls="sync-panel"` 指向條件式 render 的元素 | 只有面板存在時才設定 |
| L7 | 人像沒有 `onError` 後備，且 `photo_url` 是 `http://` | 新增共用 `Portrait` 元件；後端升級為 https（實測圖床支援，200 image/jpeg） |
| L8 | 選了議案狀態後，狀態下拉只剩一個選項 | 統計改在「套用 status 篩選前」計算 |
| L9 | 死碼 `committeeAxisLabel`／`deriveParties`，且委員會短名重寫三次 | 共用 `shortCommittee()`，移除死碼（2026-10-02 補完：`deriveParties` 與兩處 inline `replace(/委員會$/)` 都已清掉） |

### 實作中新發現

`applied_sha` 原本只看來源內容 → 改了 `normalize.mjs`（把 `photo_url` 升成 https）卻因為「內容未變更」而不重寫資料庫，新規則等於沒生效。
已改為 `正規化版本:來源 sha`（`NORMALIZER_VERSION`），並新增測試 `正規化版本改變時…`；這是實測踩到才發現的。

### 新功能：排行榜

`GET /api/v1/rankings` + 前端「排行榜」頁（`/rankings`）：

- **新聞曝光排行**：近 7／30／90 天標題含委員姓名的報導數（可切換區間，寫回 URL `?days=`）。
- **臉書發文排行**：依整理表記錄的最新貼文時間排序（`0 天 = 今天`）。整理表只有最新一則貼文，因此沒有「發文則數」可用。
- **法案提案排行**：本屆提案總數（含共同提案）與主提案件數。

名次與長條長度（`intensity`）一律由後端算好，前端不做二次統計；只列入在職委員。
實測（2026-09-30）：新聞第一名 沈伯洋 107 則（近 30 天）、法案第一名 林沛祥 1011 件（主提案 3 件）。

### 視覺改版

淺色 canvas + 白卡、14–16px 圓角、兩層柔和陰影、accent `#2563eb`、標題去襯線、導覽改 pill、表格商務化、`:focus-visible` 為 accent 外框。
**黨籍顏色的語意沒有改變**：顏色仍只代表黨籍（唯一定義處 `web/src/lib/parties.ts`），召委仍用形狀表示，警示色只用在同步問題。
對比度全部 ≥ 4.5:1（CSS 註解內有實測值）。
卡片（`.panel`、`.stat-tile`）用立體外框：深一階的灰邊＋底部 3px 實心深灰底座（`--card-base`），可點的統計方塊滑過會浮起；只用中性色，不佔用黨籍色。

### 導覽：維持上方 tab，不改左側可收合工具欄（2026-09-30 評估）

頁首依主題排 9 個入口：總覽｜最近動態｜排行榜｜委員查詢｜委員比較｜委員會｜法案查詢｜預算審議｜機關／基金。
基金、機關、財團法人、行政法人四類收在「機關／基金」頁內的子分頁（網址仍各自獨立：`/funds`、`/agencies`、`/foundations`、`/administrative`）。

不改左側欄的理由：

- **項目少**：9 個入口，約 720px 以上寬度放得下（更窄時橫向捲動）；只有兩層，用不到側邊欄的層級能力。
- **右側已有委員檔案面板**：再加左欄會變成「左欄＋內容＋右欄」三欄，擠壓法案列表、席次圖、縣市卡片等寬內容。
- **手機沒差**：左欄在手機仍得收成漢堡選單，多一次點擊；上方 tab 在窄螢幕只是橫向捲動，選項一眼可見。
- **使用情境**：公開資料閱覽網站，使用者多半「看一看就走」；可收合側欄較適合項目多、需頻繁切換的後台工具。

**何時改成左側欄**：頂層入口超過約 10 個、出現第三層（例如機關再依部會細分），或需要常駐的篩選／追蹤清單時。

## 資訊架構與密度（2026-09-30）

使用者回報「資訊有點多、雜亂沒有重點」後的量測與優化，完整紀錄見 `docs/ux-optimization-2026-09-30.md`。

| 指標 | 改前 | 改後 |
| --- | --- | --- |
| 上層導覽項目 | 9 | **5**（委員／議事／機關基金 各有次級導覽） |
| 總覽 panels | 33 | **9** |
| 總覽 h3 | 28 | **3** |
| 總覽捲動頁數 | 4.3 | **1.5** |
| 全站字級種類 | 15 種散落 px | **9 級 token** |

原則：**先給重點，細節按需展開**——不刪功能，只調整順序與出現時機。
補充區塊（各縣市動態、委員會組成、最近異動）改為預設收合的 `<details>`；收合時不渲染 DOM。

另外修掉一個後端問題：`fetch-ly.mjs` 原本把所有 4xx 當成不可重試，導致同步時
`budget`／`records` 兩階段整批 **HTTP 429** 失敗。現在 429／408／425／5xx 可重試並尊重 `Retry-After`，
同 host 也加了最小間隔（`LY_MIN_INTERVAL_MS`，預設 400ms）。修好後重跑全部成功
（預算議案 11,290 筆、公報紀錄 1,503 筆、會議 1,270 筆）。

## 縣市統計地圖與選舉資料：尚未優化／待辦（2026-10-02）

已完成：「縣市」分頁（依 tw_statistic_map 重做：互動地圖、雙指標對比、時間差異、排行榜、原始資料）、
得票趨勢與轉折（總統、不分區 2012 起，縣市長 2009／10 起）、立委得票追蹤（含補選）、委員側欄歷次得票、
排行榜險勝／得票流失兩榜、個人票對照政黨票、委員名冊與比較頁的選舉欄位（得票率、領先、比政黨票，可排序、含 CSV）、總覽各縣市卡片的人口與勝選者、分裂投票分析（各立委選區同黨區域立委／總統／政黨票得票率與差距，2012–2024）、人口結構與得票關聯（368 鄉鎮市區：年齡結構對 2020／2024 總統、政黨票得票率的散佈圖、相關係數與迴歸）、人口趨勢（2016 起每月縣市人口、每年年齡結構、超高齡年份、鄉鎮增減）、鄉鎮地圖（368 鄉鎮市區面量圖：人口、密度、增減、年齡結構、各黨得票率，可放大到單一縣市）。資料由 `scripts/build-county-stats.mjs` 產生（用法見檔頭）。

## 議員分頁（直轄市議員選舉＋桃園升格前，2026-10-03）

「議員」分頁（`/council`，`GET /api/v1/council?county=`）建置**六都**（臺北市、新北市、桃園市、臺中市、臺南市、高雄市），
涵蓋 2010、2014、2018、2022 四屆直轄市議員選舉，**外加桃園升格前的 2009 年桃園縣議員**（見下）。
資料來源是**中選會選舉資料庫**（`kiang/db.cec.gov.tw` 轉存），也就是縣市分頁本來就在用的同一份資料。

**屆次編號各縣市不同**（新北市 2010 升格後是第 1 屆、臺北市同一年是第 11 屆、桃園縣 2009 是第 17 屆），
**屆數也不同**（桃園 2014 才升格：2010–2014 那一任是桃園縣議會第 17 屆，所以桃園的屆次是 2009／2014／2018／2022 四筆）。

第一次建立資料（會下載 75 個 CSV、約 65 MB 到 `.cache/cec-council`，已 gitignore）：

```bash
node scripts/fetch-cec-council.mjs                     # 抓 2009／2010／2014／2018／2022 的區域、平地原住民、山地原住民議員
node scripts/build-council-stats.mjs                    # → server/council-stats.json（預設建置 COUNTY_META 裡的所有縣市）
node scripts/build-council-stats.mjs --county 桃園市     # 只重建某一個縣市（可重複給多個）
node scripts/build-council-facebook.mjs                 # → server/council-facebook.json（議員粉專對照）
```

**要換縣市**：`--county 臺中市` 只重建某一個；要新增**其他**縣市議員（非直轄市）則要另外處理來源目錄
（2009 那一屆只有桃園用到，做法見下面的「桃園升格前的那一屆」）。

各縣市各屆的席次結構（「區域＋平地原住民＋山地原住民」；括號是屆次）：

| 縣市 | 2009 | 2010 | 2014 | 2018 | 2022 |
| --- | --- | --- | --- | --- | --- |
| 新北市（1–4） | —（還是臺北縣，2009 沒改選） | 62＋3＋1＝66 | 62＋3＋1＝66 | 62＋3＋1＝66 | 62＋3＋1＝66 |
| 臺北市（11–14） | —（2009 沒改選） | 60＋1＋1＝62 | 61＋1＋1＝63 | 61＋1＋1＝63 | 59＋1＋1＝61 |
| 桃園市（縣 17／市 1–3） | **56＋3＋1＝60**（桃園縣第 17 屆） | —（2009 已選過，任期到 2014） | 55＋3＋2＝60 | 56＋4＋3＝63 | 56＋4＋3＝63 |
| 臺中市（1–4） | —（2009 沒改選） | 61＋1＋1＝63 | 61＋1＋1＝63 | 62＋1＋2＝65 | 62＋1＋2＝65 |
| 臺南市（1–4） | —（2009 沒改選） | 55＋1＋1＝57 | 55＋1＋1＝57 | 55＋1＋1＝57 | 55＋1＋1＝57 |
| 高雄市（1–4） | —（2009 沒改選） | 62＋1＋3＝66 | 62＋1＋3＝66 | 62＋1＋3＝66 | 61＋1＋3＝65 |

這些數字逐屆對過外部來源（維基百科各市議會／議員列表、高雄市議會官網、2022 年報導），
並且**每一屆、每一個選舉區**都再對一次中選會 `elprof.csv` 的官方當選人數與候選人數（見下）。
桃園 2009 那一屆另外對過維基百科「第17屆桃園縣議員列表」的席次與政黨席次（60 席；
國民黨 30、民進黨 17、無黨籍 13，與 build 出來的一致）。

頁面內容：縣市與屆次切換（狀態寫在網址上，可分享）、各屆席次結構、政黨席次與得票率
（含「超額代表＝席次率−得票率」）、與上一屆的政黨席次消長、連任／新任／現任落選／上屆當選但本屆未列名候選人、
每個選舉區的完整得票表（應選名額、選舉人數、投票率、當選與落選、最低當選票、落選頭）。
新北市 13 個選舉區（11 區域＋2 原住民），臺北市 8 個（6 區域＋2 原住民）。

`elprof.csv` 的欄位是這個功能的骨幹：`6` 有效票、`7` 無效票、`8` 投票數、`9` 選舉人數、`10` 人口數、
`18` 投票率（四屆都一樣），但**候選／當選人數的欄位換過一次**（2010–2018 是「候選總、當選總、男候選、
女候選、男當選、女當選」，2022 換成「男候選、女候選、候選總、男當選、女當選、當選總」）。
build 腳本會用「候選人數對不對」確認自己抓對欄位，對不上就整支失敗。
**區域議員的選舉人數不含原住民選舉人**（原住民另有選舉區），所以畫面上不把三個選舉種類的選舉人數加起來。

### build 時的 fail-closed 驗證
除了檔尾的席次期望值，`buildKind()` 對**每一個選舉區**都驗：當選人數＝`elprof` 官方當選人數、
候選人數＝官方候選人數、得票合計＝官方有效票、`elcand` 與 `elctks` 的當選註記一致，
選舉種類的合計也對 `elprof` 的縣市合計列。這一層才是抓得到「某個選舉區少算一個人」的防線 ——
硬編的席次期望值擋不住（見 `DECISIONS.md` D78）。

### 議員資料的已知限制
- **縣市議員只納入桃園升格前的那一屆（2009 桃園縣議員）**：其他縣市的縣市議員在 `db.cec.gov.tw` 的另一組目錄
  （`20091205-縣市長縣市議員及鄉鎮長/區域議員` 等；2009 那一屆只有 18 個縣市，臺北縣／臺中縣市／臺南縣市／
  高雄縣市 因為 2010 升格、任期延長而沒有改選），尚未納入；要再加縣市得先補 `COUNTY_META` 的屆次與席次表。
  那一組檔案的每列前面**多一層「省市別」**（`03` 臺灣省／`04` 福建省），所以縣市代碼是前兩個欄位
  （`ELECTIONS[].countyFields = 2`）—— 只取第一欄會篩出整個「臺灣省」的 16 個縣市加在一起。
- **桃園的屆次跨了升格**：2009 是桃園縣議會第 17 屆（60 席），2014 起才是桃園市議會第 1–3 屆。
  資料都掛在「桃園市」底下，每一屆帶一個 `body`（`桃園縣議會`／`桃園市議會`）讓頁面講清楚，
  屆次標籤也照實寫「桃園縣第17屆」。
- **「現任」欄位整欄都是 N 的屆次**（2010 那一屆五都、桃園市 2014 升格後第一屆）**不可以當成連任依據**：
  照欄位讀會得到「連任 0 人、新任 60 人」，但桃園 2014 的當選人裡有一大半是 2009 的桃園縣議員。
  這種情形一律退回「上一屆當選名單」比對，並在 `compare.incumbent_source` 標成 `name_match`。
  兩者不一致時（有可用的中選會欄位時）採用中選會欄位，並把不一致的人數記在 `compare.incumbent_mismatch`
  （實測 2022 有 1 人：遞補或換選區造成）。
- **姓名寫法在不同屆的檔案裡不一致**，會讓「上屆當選但這屆未列名候選人」誤判。實際遇到四種：
  字形不同（2018「戴瑋姍」／2022「戴瑋姗」、2010「林慶鎮」／2014「林慶鎭」、
  **2009「𨶒中傑」／2014「閻中傑」**）、
  族語名羅馬拼音不同（高雄市「柯路加 Istanba Ciban」／「Istanda Ciban」）、
  **來源檔的私用區字元**（2014 高雄市「周鍾㴴」被寫成「周鍾」＋U+E003，2022 新北市也有人用到同一個字元）。
  前三者用一張只放已觀察到差異的 `NAME_ALIASES` 對照表處理；私用區字元**不猜原字**
  （同一個 U+E003 在不同人身上代表不同字），改用「萬用字元」比對（其餘字元必須完全相同），
  輸出時以「□」表示（`陳□吉`、`周鍾□`）並寫進資料檔的 `warnings`。
  `𨶒`（U+28D92）是基本平面以外的異體字，多數字型沒有這個字、瀏覽器只會畫空白框，
  所以另外用 `DISPLAY_ALIASES` 在**輸出時**換成標準字形「閻」（同一人已用同選舉區、同黨籍、
  同得票 10,608 三項證據確認）。
  另外對「與上屆當選者只差一個字」的姓名輸出 `name_variant_suspects` 供人工確認（實測多數是不同人）。
  **這一項的比對要依字碼點切**（`[...name]`）而不是用 UTF-16 索引，否則代理對的字會因為長度不同而永遠對不上
  （「𨶒中傑」就是這樣躲過字形差異檢查的）。
- **婦女保障名額**：中選會的當選註記有 4 種（`*` 當選、空白 未當選、`!` 婦女保障當選、
  `-` 因婦女保障被排擠未當選）。`!` 是當選，四屆六都共 4 人（羅永珍、洪秀錦、李雨庭、沈家鳳），
  他們的得票可能比落選者少 —— 畫面會標示「當選（婦女保障）」並在該選舉區加一行說明。
- **選舉區與席次會隨人口重劃**：新北市 2022 起區域選舉區由 10 個分為 11 個（第 10 選舉區拆為瑞芳等 4 區 1 席
  與汐止等 3 區 4 席），原住民選舉區編號由 11／12 變成 12／13；臺北市 2022 起由 63 席減為 61 席。
  跨屆比較因此以席次與政黨為準，不直接比選舉區編號（頁面上也會把重劃寫出來）。

- **各縣市的屆次編號不同**：新北市 2010 升格後是第 1 屆，臺北市同一年是第 11 屆。屆次寫在 `COUNTY_META`，
  不是用「第幾次選舉」推算。
- **這裡只有選舉結果，沒有議員的議事資料**。立法院有開放 API（議案、表決、委員會），
  直轄市議會沒有對應的開放資料，所以「議員」分頁做的是選舉分析（誰選上、票從哪裡來、政黨消長），
  不是立委頁那種質詢／提案追蹤。

### 尚未做的功能
- ~~**【待處理】桃園補上升格前的 2009 年桃園縣議員選舉**~~
  → **2026-10-04 已做**：`fetch-cec-council.mjs` 的 `ELECTIONS` 加了 2009 那一組目錄（`countyFields: 2`），
  `build-council-stats.mjs` 的 `COUNTY_META` 桃園那筆多了 `2009: { no: 17, source: '桃園縣', label: '桃園縣第17屆', body: '桃園縣議會' }`
  與席次 `56＋3＋1＝60`。桃園歷屆變成 2009／2014／2018／2022 四筆，頁面在標題下多一行說明
  「2009 年投票時還沒有桃園市議會，那一屆是桃園縣議會（桃園縣第17屆）」。
  跨屆比較改成「清單裡的下一筆」而不是「同一年減 4」—— 2009 的任期是 2010–2014，用年份減 4 會讓 2014 那一屆比不到。
  另修掉兩個會出錯的地方（見 `DECISIONS.md` D122–D125）：縣市篩選要取兩欄、以及「現任」欄位整欄都是 N 時不可當連任依據。
- ~~**議員加 Facebook 粉專連結**~~
  → **2026-10-04 已做**：`scripts/council-facebook.csv`（對照表）經 `node scripts/build-council-facebook.mjs` 對到 2022 當選人，產生 `server/council-facebook.json`；`/api/v1/council` 的最新一屆當選人多 `facebook`、`facebook_status`，頁面上姓名變成連結。只涵蓋最新一屆，歷屆沒有粉專。
  比對會統一異體字（杰／傑、姗／姍、啓／啟、釆／采、椿／樁、黄／黃）並去掉原住民姓名的羅馬拼音。
  **2026-10-04 複查（見 `DECISIONS.md` D126）**：逐選區把對照表與中選會當選名單對齊後發現兩個掛錯選區的列 ——
  桃園第 3 選區（八德）原寫「張桂綿」、第 1 選區（桃園）原寫「朱珍瑤」，兩列的名字對調錯了
  （朱珍瑤是八德議員、張桂綿是蘆竹議員），已改成第 1 選區「黃瓊慧」（`facebook.com/hi54qn/`，維基百科與 2023 年 PTT 轉錄文的連結一致）、
  第 3 選區「朱珍瑤」。對到的當選人從 371 位變成 **373 位**；剩下 **4 位**沒連結
  （新北 黃俊哲、臺中 黃仁、臺南 邱昭勝、高雄 黃紹庭），都是**原當選人已離職、對照表列的是遞補者**
  （石一佑、吳建德、王錦德、吳益政），粉專不屬於當選人本人所以不顯示；這 4 筆的對照關係現在寫在
  `server/council-facebook.json` 的 `unmatched`／`extra`，build log 也會逐筆印出來。
  build 腳本另外加了兩條 fail-closed 規則（同一個人在同縣市出現於兩個選區、非當選人卻寫「現任」），
  上面那個錯在現在的版本會被擋下來。
  **2026-10-04 逐條存活驗證做完了（373 條全跑，見 `DECISIONS.md` D133–D137）**：在**已登入 Facebook 的
  Ego Lite** 裡一條一條開，每條都要確認網址列真的停在目標代稱（或 Facebook 補的 `.7` 後綴）才算數，再讀頁面名稱比對姓名。
  結果並不好：
  - **147 條打不開**（佔 39%）—— 瀏覽器只顯示「目前無法查看此內容」，crawler 也讀不到任何頁面
  - **226 條拿得到頁面**，但**只有 128 條的中文姓名對得上**：**42 條開到的是別人的檔案**
    （例：`yichung.chung` 是「黃先美」、`ingay.tali` 是「蔡孟傑」、`piyu.chen` 是「李品臻」、`wuchikang` 是「吳季剛」），
    18 條是同音或用字不同的名字（鄭孟洳→鄭盟儒、邱于軒→邱羽旋、賴義鍠→賴誼遑），38 條只看到英文名無從比對
  - 52 條 Facebook 會自動轉到新的網址（`shuchuntsai` → `shuchun.tsai`），轉址後仍是本人
  - 4 條個人檔案存在但內容受限（許家睿、許清順、蘇偉恩、蔡淑惠）：瀏覽器看得到名字、看不到貼文
  抽 19 條重測（含 12 條判打不開的）**0 條翻盤**，所以這不是隨機或限流造成的。
  另外 147 條「打不開」不等於「粉專被刪」—— 已刪除、已改名、只給朋友看，對非朋友的登入者都是同一個畫面。
  看起來對照表有很大一部分網址是照姓名羅馬拼音猜的，不是本人的頁面（例：陳偉杰的真實頁面是
  `facebook.com/chenweichieh`，不是表裡的 `weijie.tw`）。
  **2026-10-04 換掉 149 條（見 `DECISIONS.md` D137）**：在 Facebook 用「粉絲專頁」搜尋逐條找人，
  只有**候選頁面打得開、網址列停在該頁、而且頁面上出現本人姓名**才算數（寧缺勿濫，分數不夠就留著不改）。
  189 條壞連結裡找到 155 條，再排除 6 條不是本人的（支持者後援會／粉絲頁，以及一條**反應曉薇**的批評頁），
  **實際改了 149 條**（來源是 `scripts/council-facebook.csv`，改完重跑 `build-council-facebook.mjs` 通過）。
  改完把 149 條全部重新開一次：**149 條都打得開、147 條頁面上有本人姓名**
  （另 2 條是異體字，頁面寫「陳偉杰」「許至椿」，比對用的正規化字是「傑」「樁」）。
  **還沒做**：剩下 40 條還是壞的（34 條搜尋找不到可確認的頁面、6 條只找到非官方頁面）。
- **鄉鎮層級的得票趨勢與轉折**：鄉鎮地圖已有（2020／2024 得票），尚未納入 2012／2016 與縣市長的鄉鎮得票，轉折分析仍在縣市層級。
- **2026 地方選舉（11 月）**：**2026-10-04 查過 `kiang/db.cec.gov.tw` 的 `data/elections/2026` 了 —— 那個目錄只有「選舉區界圖」，沒有候選人也沒有得票**
  （898 個 GeoJSON ＋ `list.csv`，內容是議員與鄉鎮市民代表的選舉區村里界：`議員(區域)` 161、`議員(山地原住民)` 34、
  `議員(平地原住民)` 22、`鄉鎮市民代表(區域)` 638、`鄉鎮市民代表(平原原住民)` 27、`直轄市原住民區民代表` 16）。
  所以「做候選人一覽」還**缺來源**，不是改個目錄就能撈；要等中選會公告候選人名單之後再找來源。
- ~~**罷免案的票數**：中選會的罷免表不提供票數…~~
  → 已由公告／結果文件補齊（35 案）。
- **陳柏惟那筆的票數是人工判讀的**：官方公告的結果表是圖片、沒有文字層，環境也沒有 OCR；數字已通過四道算術驗證（含門檻重算），但仍不是機器解析，所以在資料裡標了 `read_from`。
- **`clarify.cec.gov.tw` 從這台機器連不上**（2026-10-04 複測仍是 DNS 失敗），`web.cec.gov.tw/upload/file/*` 會被 WAF 回 HTML 而不是檔案；可用的路徑是 `web.cec.gov.tw/api/file/*` 與行政院公報 `gazette.nat.gov.tw`。
- **data.gov.tw 資料集 13119（2026-10-04 結案）**：**「環境網路政策擋住 data.gov.tw」已經不成立**（實測 HTTP 200）。
  讀過內容了：標題是「選舉資料庫(含選舉區資料)」、機關是中選會、更新頻率「每年定期更新」，
  但**整個資料集只有一列**，唯一的資源是一張 CSV（`https://data.cec.gov.tw/選舉資料庫/voteData.csv`），
  而它本身也只是「檔案名稱,下載連結網址,更新日期」再指向 `https://data.cec.gov.tw/選舉資料庫/votedata.zip`（更新日期 20250124）。
  也就是說它是中選會官方原始打包，內容就是 `kiang/db.cec.gov.tw` 轉存的那一份（kiang 就是轉存它），
  **沒有額外可用的資料**，所以不另外接。要用官方原始檔的話就是抓那個 zip。
- **tw_statistic_map 未移植的功能**：檔案上傳、手動填寫、GIF 動畫、多時間點趨勢分析（以「時間差異」與「得票趨勢」取代）。地圖用 SVG 自繪，未用 Plotly。

### 資料限制
- ~~**2025 罷免投票**：kiang/db.cec.gov.tw 沒有，需另找來源（中選會網站目前被網路政策擋住）。~~
  → **2026-10-02 已補上**：改用中選會官方選舉資料庫（`https://db.cec.gov.tw/ElecTable/Recall?type=Legislator`），
  由 `scripts/fetch-cec-recalls.mjs` 抓成 `server/recalls.json`（35 案：第 8–11 屆，含 2025 兩波 31 案）。
  「中選會被網路政策擋住」的說法**不成立**（實測 HTTP 200）。當時一併記下的「data.gov.tw 被擋」在 2026-10-04 複測也**不成立**（HTTP 200，內容已讀，見下面「資料限制」）。
  「中選會的罷免表」只有案件清單與結果（Y／N），**沒有**票數 —— 這件事寫在 `recalls.json` 的 `source.note` 與畫面上。
  **票數改由 6 份官方文件取得**（`scripts/fetch-recall-results.mjs`，用 `pdftotext`／`unzip` 解析）：
  **35 案全部都有**同意／不同意票數、投票率、無效票與官方文件出處，每一筆都通過算術驗證。
  文件格式各異，所以腳本裡有 5 種解析器：2025 兩波用公告的固定欄位表（2 份）、
  黃國昌用「投開票結果表」的總計列、蔡正元用「罷免實錄」的內文、林昶佐用「各投開票所得票數一覽表」ODS 的總計列；
  **陳柏惟是唯一例外** —— 他的公告結果表在 PDF 裡是**圖片**（實測 `pdfimages`：747×221 JPEG，沒有文字層）、
  環境也沒有 OCR，因此由人工判讀填入，並以 `read_from` 標示（同樣通過算術驗證）。

  **為什麼「同意票比較多」不等於通過**：2016 年底修法前的門檻是「投票人數須達選舉人總數 1/2」，
  修法後改成「同意票須達選舉人總數 1/4」（且同意 > 不同意）。所以蔡正元 2015 拿到 **97% 同意卻沒過**
  （投票率只有 24.98%）、黃國昌與林昶佐也都是同意多於不同意但沒過四分之一門檻；
  35 案裡只有陳柏惟（2021）通過。測試會用票數**重算門檻**並要求與中選會記載的結果一致。
- **人口與選舉為靜態檔**（`server/county-stats.json`、`server/legislator-votes.json`），不在同步流程內，需手動重跑 build 腳本；人口目前為 2026-08。
  它們**不在 `/health` 的 `datasets`**（沒有 `fetched_at`，不是抓來的），改列在 `static_data`：只有「資料截止 `as_of`」與筆數。人口月報超過 `LY_STATIC_STALE_MONTHS`（預設 3）個月沒更新、或任一個檔讀不到／是空的，都會出現在 `/health` 的 `warnings`。
- **人口與選舉資料取自 GitHub 轉存**（kiang/data.moi.gov.tw、kiang/db.cec.gov.tw），非直接取自政府網站；縣市界為 ronnywang/twgeojson（2010 版，以縣市名對應）。
  **例外：罷免案直接取自中選會官方**（`db.cec.gov.tw`，見上一條）。兩者的差別在可回溯性：GitHub 轉存可以被改寫歷史，官方端點則是原始來源。
- **選區重劃**：2024 部分選區（如新竹縣拆成兩區）與前屆範圍不同；得票流失榜只比同名選區，個人歷次得票表仍列出跨重劃的比較。
- **個人票對照政黨票**：2020 嘉義市有投開票所對不到立委選區，該年選區加總比縣市少 **472 票（總統）／468 票（政黨票）**（原本這裡寫 474，與實測不符，2026-10-02 更正）。這個差額目前只出現在 build log 的 `console.warn`，**沒有進輸出檔也沒有進 `/health`**；補選與原住民選區沒有此對照；2024 總統三強，對照總統票時差距偏大，預設以政黨票為準。
- **委員對應以姓名比對**（去掉族語名分隔符號）。變體字與族語名沒問題（`陳秀寳`、`謝衣鳯`、`鄭天財 Sra．Kacaw` 三種分隔符都對得上），但**同名不同人會被合併**：資料裡有 2 組同一年同名不同人 —— 2020 `許淑華`（民進黨．臺北市第7）與 `許淑華`（國民黨．南投縣第2）、2020 `李中`（勞動黨．桃園市第4）與 `李中`（國民黨．臺中市第6）。
  影響：`raceHistory()` 會把兩人串成一條，`change`（與本人前次參選的得票差）引用到別人的票數（實測差 1,010 票）。**目前 113 位在職委員沒有同名者**，所以名冊的選舉欄位與險勝／流失兩榜都碰不到；但這是「資料巧合」而不是防護，名冊一出現同名者就會靜默污染（測試已 assert 在職委員不可同名）。要徹底修需要 build 端輸出中選會候選人 id，或 join key 加上縣市。
- **原住民選區的「領先」語意**：資料檔 `margin` 是「第一名對第二名」，但三席選區的前兩名都當選，所以那一欄對原住民選區沒有意義；API 的 `raceHistory()` 另外用「當選者對最高票落選者」重算。險勝榜的排序因此仍然正確（最後一席的差距最小），但單一原住民委員顯示的「領先」是對落選頭的差距。
- 2015 以前的立委補選（2009–2013）未收錄。
- **縣市長 2009／10**：2009 縣市長（17 縣市）與 2010 五都合為同一輪，年份記 2010。
- 2022 嘉義市長為 12/18 延期選舉（只有投開票所明細，另行加總）。
- **人口月報缺 2023-09**：來源 JSON 為空、原始檔是下載錯誤訊息，記為 null，圖上斷線。
- **人口與得票關聯**：人口為 2026-08，晚於 2020／2024 選舉；屬區域層級相關（生態謬誤），不代表個人行為或因果。

### 開發環境注意
- `npm test`（`node --test test/`）在 Node 22.22 會找不到 `test` 模組而失敗；本機 Node 26.10 正常（99 項全過）。
- ~~端對端截圖中 CSV 匯出的檔名在 headless Chromium 顯示為 `download`（`downloadCsv` 立即 revoke object URL）~~
  → 2026-10-02 已修：`downloadCsv` 改為下載後延遲 1 秒才 `revokeObjectURL`（同一個 tick revoke，Firefox／Safari 有機會取消下載）。
## 第三輪 Code Review（2026-10-02）

第二輪之後又累積了一批修正，這一輪分成三個角度獨立複審（API 查詢層／前端／ingestion 管線），
**每一條都先寫出可重現的失敗、修好、再補一個會紅的回歸測試**。後端 84 → 98 項（第三輪）、107 項（第四輪）；前端 58 → 84 項。

### 🔴 先講最重要的：整批覆寫前的相對筆數門檻（B1／B2）

原本所有「整批覆寫」的表只有**絕對下限**（例如 `length < 100`）。真實席次是 783 筆，
來源回了一半（367 筆）照樣通過驗證、`status = success`，而 `applyDataset` / `replaceAll`
是 `DELETE` + `INSERT` —— 一覆寫，完整的舊資料就沒了，唯一的訊號是 `meta.warnings` 裡一行字。

現在 `guardShrink()` 拿**上一次成功套用的筆數**當基準（記在 `meta`），掉超過 20% 就中止並記 `failed`：
名錄／席次、公報委員會紀錄、會議附件／機關回覆、ID223 登記發言都適用。
合法縮減時用 `LY_ALLOW_SHRINK=1` 強制覆寫一次。**測試**：把 fixture 的 committee 欄位清空一半 → `status = 'failed'`、`committee_seats` 仍是 783。

### 🔴 高（會回錯資料或服務 500）

| # | 問題 | 修正 | 測試 |
| --- | --- | --- | --- |
| F1 | `?vocab=category` 的熱門議題**靜默漏掉所有預算案**：SQL 把 `category` 別名成 `laws`，取鍵卻讀 `row.category` → `keys` 恆為空陣列 | SQL 取回真正的 `category`；`anchor`／`earliest` 也一併納入 `budget_bills`（否則 bills 一空整頁回空） | `F1: vocab=category 要把預算案一起算進來` |
| B1 | 名錄部分回應被判 success 並整批覆寫（見上） | `guardShrink` | `B1: 名錄部分回應（席次掉一半）要 fail closed` |
| B2 | 公報紀錄／會議附件／ID223 只有「非空」驗證 → 截斷的回應靜默蓋掉完整資料 | 同上 | `B2: records 被截斷時要 fail closed` |
| B4 | 新聞**全部失敗**時 `news_status` 仍寫 `complete:113/113`，前端看起來像成功 | 寫 `failed:…`，並讓 `/health` 的 `warnings` 顯示它（以前只有 `partial` 會被顯示） | `B4: 新聞全部失敗時 news_status 要寫 failed` |
| B3 | 社群更正表對不到在職委員時只警告、靜默丟棄（與 D44 寫的 fail closed 不符） | 改為 `DataValidationError`（整個社群階段 fail closed） | 涵蓋於 `社群更正表：補上整理表沒有的委員` 等測試 |

### 🟠 中

| # | 問題 | 修正 | 測試 |
| --- | --- | --- | --- |
| F2 | `/news` 的 `total` 用 `COUNT(*) FROM news`，items 用 `JOIN legislators` → 孤兒新聞讓 `total` 比實際可回傳的還大 | total 改用同一組 JOIN | `F2: /news 的 total 要跟 items 用同一組 JOIN` |
| F3 | 名錄為空時 `/committee-activity` 的姓名 regex 變成空樣式 → `byHan.get('')` 是 undefined → **TypeError 500** | 空清單時直接回 `[]`；並對 `byHan.get()` 加防護 | `F3: 名錄為空時不可以 500` |
| F4 | 排行榜**先 `LIMIT` 才過濾在職委員**：離職者佔走名額時榜單靜默短少（實測 `limit=1` 回空榜） | 在職條件下推進入 SQL | `F4: 排行榜先在 SQL 過濾在職委員` |
| B5 | 「429 多給幾次機會」是**死碼**：迴圈上限寫 `attempt <= retries`，`maxAttempts = 5` 永遠到不了（D41 的意圖沒生效） | 迴圈結束條件交給 `attempt >= maxAttempts` | `B5: 429 會多給幾次機會（上限 5 次）` |
| B6 | `Retry-After` 無上限：一個 `Retry-After: 3600` 就讓階段卡一小時，`LY_NEWS_BUDGET_MS` 攔不住 | 等待時間夾在 `LY_RETRY_AFTER_CAP_MS`（預設 60 秒） | `B6: Retry-After 再長也只在 cap 之內等待` |
| F5 | `upsertTopicNews` 多列寫入沒有交易（同檔其他整批寫入都有） | 包 BEGIN／COMMIT／ROLLBACK | — |
| F11 | `pruneLogs`／`pruneNews` 各刪兩張表但沒有交易 | 同上 | — |

### 🟡 低（確定的小 bug）

| # | 問題 | 修正 |
| --- | --- | --- |
| F6 | `?q=%`／`?q=_` 被當成 LIKE 萬用字元 → `q=%` 回傳全部議案 | `ESCAPE '\'` + 跳脫 `% _ \` |
| F7 | 所有符合列 `latest_date` 為空時 `first_date` 會外洩字串 `"9999"` | 改成從 `null` 起算 |
| F9 | `/bills` 的 `statuses` 會出現 `{name: null}`（`listBudget` 早有 `filter`，bills 漏了） | 空狀態不進統計 |
| B9 | 同一位委員、同一平台可以有兩筆（不同網址），更正表的 `findIndex` 只換掉第一筆 | 重複檢查改成 `legislator_id\|platform` |
| B10 | `rocDate('113/13/45')` 會產生 `2024-13-45` 寫進資料庫 | 驗證月日與每月天數 |
| F8 | `change_log` 漏記「（無）→ 有值」的異動 | 允許 `old_value` 為空 |
| M4 | `SyncStatusBanner` 的 `aria-controls` 指向收合時不存在的元素（L6 只在 Header 修了） | 有面板時才設 |
| M5 | 在頁首搜尋框按 Esc 會冒泡到 window，**同時關掉**委員側欄 | Escape 分支加 `stopPropagation()` |
| M1 | `Portrait` 的 `broken` 狀態會沿用給下一位委員（元件被重用）→ 一次 404 之後所有大頭照都變文字頭像 | `<Portrait key={legislator.id}>` |
| M6 | 總覽的 `Card` 少了 `empty` 分支 → 空清單 render 出一張什麼都沒寫的卡 | 補 `EmptyState` |
| H1 | URL 的 `?term=99`／`?session=99-9` 不在清單裡時，下拉顯示的是別的值、且使用者無法從 UI 切回去 | 清單外的值補一個「（無資料）」選項 |
| L3 | `downloadCsv` 在 `a.click()` 同一個 tick 就 `revokeObjectURL`（Firefox／Safari 可能取消下載） | 延後 1 秒 revoke |
| L4 | `ComparePage` 是唯一沒攔截的站內連結 → 整頁重載、掉 SPA 狀態 | 傳入 `onNavigate` 並 `preventDefault` |
| L2 | README 宣稱「單一真相來源」但實際有兩處 inline 重寫委員會短名、`deriveParties` 是死碼、三讀狀態集合兩頁各一份 | 全部改用 `shortCommittee()`／`PASSED_STATUSES`，刪掉死碼 |

### 已在這一輪補上的測試（把「沒測過」變成測過）

- **換屆（第 12 屆）**：合成第 12 屆名錄 → 驗證屆次／會期／席次整組切換、舊屆次查不到、
  以及 `?session=11-5` 這種換屆後的舊連結會**退回該屆最新會期**（`meta.session` 會明講），而不是回空清單或回上一屆的人。
- **`/health` 的 stale 判斷**：資料用固定時間戳寫入，卻用「執行當下」判斷 stale —— 原測試在 2026-10-02 之後就會**自己變紅**（已經紅了）。
  改成 `getHealth(db, { now })` 可注入時鐘，並補上「超過 `LY_STALE_HOURS` 必須 stale 且 `ok=false`」這條以前完全沒覆蓋的路徑。
- **CR-7 的同步端點授權**：純函式 `authorizeSync()` 單元測試 + `verify.sh` 端到端（沒帶／錯 token → 401、對的 → 202、GET 不受影響）。

### 刻意沒做（附理由）

| 項目 | 為什麼不做 |
| --- | --- |
| `web/scripts` 沒有進 `tsconfig` 的型別檢查（32 個 TS 錯誤） | 要一次補 `@types/node`、`allowImportingTsExtensions` 與 32 處 fixture 型別；會動到測試骨架，留成獨立一件事 |
| `fetch-ly` 的重導向跨 host／`http://` 目標、response body 無大小上限 | 目前來源固定且可信；上線後若改成打任意網址才需要 |
| `raw_snapshots` 無上限、`gzipSync` 同步壓縮 | 一天一輪、內容有變才存，成長量無感；量大到有感時再換非同步 gzip＋保留上限 |
| CLI 與 server 兩個 writer 會 `database is locked` | 目前維運方式就是單一行程；要雙寫得先換 WAL＋busy timeout |
| `LY_UA` 還是 placeholder | 需要使用者提供真實可聯絡的網址／信箱 |
| 委員會頁的「業務成果」區塊（會議概況、考察活動、審竣議案…） | 只存在於 ly.gov.tw 的網頁文章，沒有開放資料；要逐委員會爬網頁，是獨立功能不是 review 修正 |
| 部署（Worker／VPS／Pages） | 需要帳號與費用，屬不可逆的對外動作 |
## 第四輪 Code Review：縣市／人口／選舉資料（2026-10-02）

第二輪 19 個 commit（縣市統計地圖、人口、選舉得票）在第三輪之後才進 main，這一輪專門複審那 4,400 行
新程式與五個靜態資料檔（`county-stats`／`demographics`／`population-trend`／`town-map`／`legislator-votes`）。
**方法不變：每一條都先重現、修好、再補一個會紅的回歸測試。** 後端 107 項、前端 84 項全過。

上游這包其實做得不差：12 條新測試含不變量（「368 鄉鎮人口與各黨得票加總等於縣市加總」、「各選區總統與政黨票有效票等於各黨加總」），
`build-county-stats.mjs` 也有多處 fail-closed。所以這一輪刻意**不重推他們已經測過的不變量**，
專打測試抓不到的四類：**已出貨的錯數字、靜態檔的可觀測性、測試完全沒碰的新頁面、以及跨檔案的 join**。

### 🔴 已出貨資料裡的錯數字（最嚴重，因為圖表照樣畫得出來）

| # | 問題 | 修正 | 驗證 |
| --- | --- | --- | --- |
| D-1 | **2012 總統宋楚瑜的 369,588 票被標成「無黨籍」**：`party()` 對查不到的政黨代碼回 `無黨籍`，把一個錯的政黨標籤變成看起來很合理的數字 | 資料檔 22 個縣市的 2012 總統 `無黨籍` → `親民黨`；build 腳本的 `party()` 改成遇到未知代碼就**整支 build fail closed**（訊息會指出是哪個代碼），不再靜默歸類 | 全國加總＝馬英九 6,891,139／蔡英文 6,093,578／宋楚瑜 369,588，且 2012 完全沒有「無黨籍」 |
| D-2 | **`margin_pct` 二次四捨五入**：先用已四捨五入到小數 2 位的 `pct` 相減，88 筆縣市場次有 28 筆、314 場立委有 79 場與真值差 0.01 個百分點 | 改成用原始票數算 `margin/valid`；資料檔同步重算（28＋79 筆）；build 腳本公式一併修 | 全檔 `margin_pct === round(margin/valid*100, 2)`，不一致 0 筆 |
| D-3 | 險勝榜的長條長度**取決於 `?limit=`**（span 用 slice 後的資料算）：廖偉翔 2.46 個百分點在 limit=5/10/20/50 下是 0.06/0.28/0.66/0.85 | span 改用**全部合格列**計算；第一名一律滿格 1（與其他四榜一致） | 同一人在 limit=5 與 limit=50 下 intensity 相同 |

### 🟠 靜態檔的可觀測性（這條一開始是我自己改出來的 regression）

第三輪我加了 `/health` 的 `static_data`，但**沒有逐檔容錯**：任一檔案 ENOENT／JSON 壞掉，
`/health` 就 500（`/regions` 也一起被拖垮），而 `/health` 正是發現檔案壞掉的唯一線索。
反過來，`{"counties": []}` 這種空檔又回 `ok: true` 且沒有任何警告。現在：

- 逐檔 try/catch，壞掉的檔回 `error`、空檔回 `count` 0，**都不會讓 `/health` 500**；
- 兩者都變成 `warnings`，且錯誤訊息不帶伺服器絕對路徑；
- 五個檔**各自**檢查「資料截止」是否超過 `LY_STATIC_STALE_MONTHS`（原本只看 `counties`，一旦它有值就再也不看其他檔）。

順帶修掉兩個「取決於前端先打哪支 API」的 500：`listLegislatorVotes`／排行榜在空名冊（全新安裝、首次同步還沒跑完）
時會讀到還沒初始化的 `legislatorVotes`。

### 🟠 前端：兩個 High（都在新頁面上）

| # | 問題 | 修正 | 測試 |
| --- | --- | --- | --- |
| F-1 | **高雄市／宜蘭縣／基隆市／金門縣的鄉鎮地圖預設縮放整張壞掉**：`bbox` 取該縣市所有鄉鎮的聯集，但旗津區含東沙／南沙、頭城鎮含釣魚台、烈嶼鄉、中正區含離島 → 框被撐到畫布外（實測高雄市 1543×2938，正確應為 188×227，放大 8.2 倍） | 縮放框改用**縣市輪廓**路徑（`countyViewBoxFor()`，抽成純函式才好測）；`bbox([])` 回 `undefined` 而不是 `Infinity` 的無效 viewBox | 用真實資料斷言「輪廓框遠小於鄉鎮框」＋`bbox([])`／不合法路徑 |
| F-2 | **原住民委員的「在縣市頁看完整得票表 →」連到錯的縣市**：`region` 是「山地原住民」不是縣市名，`?county=` 未驗證就 `?? items[0]` → 點高金素梅看到基隆市的表，自己的紀錄一列都沒有，網址還寫 `county=山地原住民` | 非縣市的 region 不產生連結；`resolveCounty()` 查不到就顯示「找不到縣市」而不是靜默換第一筆 | `resolveCounty` 對「山地原住民」回 null |

另外修掉會讓整頁被 ErrorBoundary 蓋掉的：`?scale=` 未知色階（`colorAt` 落回預設）、
`items: []` 時 `items[0].county`、`pairs` 為空時的 `pair.older.value`（不只「時間差異」分頁）、
以及面量圖 `values` 混到 `undefined`／`NaN` 時整張圖沒有顏色（`Math.min(...[])` → `NaN` → 無效 CSS `fill`，而且不會有錯誤訊息）。

### 刻意沒做（附理由）

| 項目 | 為什麼 |
| --- | --- |
| `build-county-stats.mjs` 的單元測試 | 需要 CEC／MOI 的原始 CSV fixture（目前完全沒有測試）；D-1/D-2 都是「有 fixture 就會紅」的類型，值得單獨做 |
| `useParam` 不聽 popstate（`C3`） | 網址與畫面會在「點頁首同一個連結」時分岔；修法要用 `useQueryState` 改寫 7 個參數，屬獨立工作 |
| NewsPage 的分頁不在網址（`C6`） | 同上；且 `change()` 用 `replaceState` 與 `useQueryState` 的 push 慣例不一致 |
| 互動地圖 368 個 tab stop（`C9`） | 要做 roving tabindex；目前旁邊已有排行榜與表格當替代操作路徑 |
| 前端手寫的 key union 與後端回傳清單分岔（`C8`） | 應改成從 API 型別推導；目前 4 個 key 一致，屬潛在風險 |
| 同名不同人的 join（`D-4`） | 需要 build 端輸出中選會候選人 id 才能正確解；已在「資料限制」寫明並用測試鎖住「在職委員不可同名」 |
| 2025 罷免、tw_statistic_map 未移植的功能、鄉鎮層級的得票趨勢 | 需要新資料來源或較大的改寫，見上面「尚未做的功能」 |
| 議員粉專連結的存活驗證與修正 | **2026-10-04 已做**：373 條驗完（147 條打不開、42 條開到別人），並換掉 149 條壞連結（改完全部重開確認過）。**剩 40 條還是壞的**（34 條搜尋找不到、6 條只找到非官方頁面），見 `DECISIONS.md` D133–D137 |

## 授權與資料來源

資料來源：立法院開放資料（`https://data.ly.gov.tw/`），依「政府資料開放授權條款第 1 版」。
API 回應的 `meta.source` 會帶出處與授權，前端每一頁都顯示「資料截至 …」。
