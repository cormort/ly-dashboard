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
| 無異動紀錄、無原始快照、無測試 | `change_log` + `raw_snapshots`(gzip) + 56 項後端測試＋68 項前端測試 |

## 快速開始

```bash
# 1) 抓資料進 SQLite（打真實立法院 API，約 7 秒）
node server/ingest.mjs

# 2) 跑測試（56 項，不需要網路，用 test/fixtures 的真實 API 回應）
npm test

# 3) 建置前端
npm --prefix web install
npm --prefix web run build

# 4) 啟動 API + 前端（http://127.0.0.1:8787）
node server/index.mjs
```

- `--no-scheduler`：只開 API，不在啟動時自動同步（開發用）。
- 環境變數：`PORT`、`LY_DB`、`LY_UA`、`LY_STALE_HOURS`、`LY_SYNC_INTERVAL_MS`、`LY_FETCH_TIMEOUT_MS`、`LY_FETCH_RETRIES`、`LY_SKIP_BUDGET`（跳過預算三個來源）。

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
| `docs/API.md` | 凍結的 API 契約（前端依此實作） |
| `test/*.test.mjs` | 用真實 API 回應當 fixture 的回歸測試 |
| `web/src/api/` | 型別化 API client（唯一出口，前端不碰政府端點） |
| `web/src/lib/urlState.ts` | 篩選條件的 URL 序列化（可分享、可上一頁） |
| `web/src/hooks/useApi.ts` | `loading / ready / empty / error` 四態資源 hook |
| `web/src/pages/` | `DashboardPage`（總覽，預設首頁 `/`）、`HomePage`（最近動態 `/activity`）、`RankingsPage`、`LegislatorsPage`（議場席次圖＋名錄）、`BillsPage`（法案查詢）、`BudgetPage`（預算審議）、`FundsPage`（基金／機關 `/funds`）、`ComparePage`（委員比較） |
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
npm test                                    # 後端 56 passed（fail-closed、交易回滾、change_log、排行榜、M1–M5 回歸）
npm --prefix web test                       # 前端 tsc -b + 煙霧 27 + 渲染 41，全過
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

## 部署（尚未執行，待決定）

1. **排程宿主**：Cloudflare Worker + D1 + Cron，或小 VPS + SQLite + cron。兩者都必須先做 30 分鐘 spike：從目標 runtime 打一次 `data.ly.gov.tw`（帶具名 UA），確認 TLS 與 WAF 都過。
2. **前端**：`web/dist` 是純靜態檔，放 Pages/Vercel/任何空間。
3. 破壞性／需帳號的動作（例如建立 Worker、push、對外發布）尚未執行，記錄於 `DECISIONS.md`。

## 維運與限制

執行時**不需要 AI**：只有 Node + SQLite + 靜態前端，程式裡沒有呼叫任何 AI 服務。
伺服器啟動後每 24 小時自動同步；所有分類（預算類型、審議狀態、立法流程）都是固定規則。
任何來源抓取失敗或格式不符都 **fail closed**：保留舊資料、記錄在 `sync_runs`，頁首顯示「資料截至…」與同步狀態。

但它不是完全免維護，以下情況需要人工介入：

| 情況 | 會發生什麼 | 怎麼處理 |
| --- | --- | --- |
| **伺服器沒在跑** | 排程在伺服器程式內（不是系統 cron），關機或程式停止就不會更新 | 放在常開的機器上；或改用系統 cron 定時跑 `node server/ingest.mjs` |
| **外部來源改版** | 該資料集持續同步失敗，畫面標示資料過期。g0v 立法院 API 是社群維護的非官方 API，改版機率高於官方 | 看 `/api/v1/sync-runs` 的錯誤訊息，改 `server/normalize.mjs` 或 `server/config.mjs` |
| **社群帳號整理表** | 人工維護的 Google 試算表；委員換帳號、遞補時不會自動更新 | 有人定期更新表格（網址可用 `LY_SOCIAL_CSV` 覆寫） |
| **分類規則遇到新寫法** | 新的議案狀態或名稱寫法對不到規則：落到「其他」、不顯示流程條或預算類型，不會壞掉 | 偶爾檢查，補 `web/src/lib/billStage.ts`、`server/normalize.mjs` 的 `budgetTypes()`、`server/queries.mjs` 的 `BUDGET_PENDING` |
| **換屆（第 12 屆）** | 程式會依名錄切換屆次，但沒有實際測過換屆當下 | 換屆後手動同步一次並檢查各頁 |

另外兩個已知的資料性質（不是故障）：

- **「預算會議」以關鍵字判斷**（會議事由含「預算」），順帶處理預算書面報告的會議也會算入，發言場次是上限值。
- **沒有預算金額**：目前來源只有預算案的審議狀態與報告，不含各機關歲出金額；要金額需另接主計總處資料。

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
| CR-6 | `ALL_SESSIONS` 在 `types.ts` 與 `urlState.ts` 重複定義 | `types.ts` 匯出，`urlState.ts` 改為 re-export |

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
| CR-7 | `POST /api/v1/sync` 無驗證 | 綁 `127.0.0.1`，部署前需加保護（見 `DECISIONS.md` D8） |
| CR-8 | `timer.unref()` | 無實際影響：HTTP server 本身會維持 process 存活；若日後排程與 server 拆開執行才需移除 |
| CR-9 | `getHealth` 中 `count(table)` 使用字串插值（非參數化） | 所有呼叫者皆為字串常量，安全但不理想 |
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
| L9 | 死碼 `committeeAxisLabel`／`deriveParties`，且委員會短名重寫三次 | 共用 `shortCommittee()`，移除死碼 |

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

## 授權與資料來源

資料來源：立法院開放資料（`https://data.ly.gov.tw/`），依「政府資料開放授權條款第 1 版」。
API 回應的 `meta.source` 會帶出處與授權，前端每一頁都顯示「資料截至 …」。
