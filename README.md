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
| 無異動紀錄、無原始快照、無測試 | `change_log` + `raw_snapshots`(gzip) + 37 項測試 |

## 快速開始

```bash
# 1) 抓資料進 SQLite（打真實立法院 API，約 7 秒）
node server/ingest.mjs

# 2) 跑測試（37 項，不需要網路，用 test/fixtures 的真實 API 回應）
npm test

# 3) 建置前端
npm --prefix web install
npm --prefix web run build

# 4) 啟動 API + 前端（http://127.0.0.1:8787）
node server/index.mjs
```

- `--no-scheduler`：只開 API，不在啟動時自動同步（開發用）。
- 環境變數：`PORT`、`LY_DB`、`LY_UA`、`LY_STALE_HOURS`、`LY_SYNC_INTERVAL_MS`、`LY_FETCH_TIMEOUT_MS`、`LY_FETCH_RETRIES`。

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
| `web/src/components/` | Header、SyncStatusBanner、SessionSelector、FilterBar、StatCards、CommitteeChart、LegislatorGrid、LegislatorDetail、ChangesPanel |
| `web/scripts/smoke.ts`、`render-smoke.ts` | 前端口語煙霧測試（25 + 27 項），**只存在於 dev，不進 bundle** |

## 資料模型重點

- `legislators`：身分（123 位追蹤對象，含已離職者）。
- `sessions` / `memberships`：**會期是查詢單位**。立法院固定 113 席，因此每個會期名錄都是 113 人，但組成人員會因辭職／遞補而變動（第 1 與第 5 會期有 8 人不同）。
- `committee_seats`：事實表，`is_convener` 綁在會期上；跨會期去重後才是「曾任召委」。
- `change_log`：每次同步與前一版比對，記錄 `is_convener`、黨籍、選區、離職狀態的變化。
- `raw_snapshots`：原始 JSON gzip 保存（sha256 去重），可回溯、可重跑。
- 2 位在本屆委員會欄位中無任何會期紀錄者（游錫堃、李貞秀）**不編造會期**，以屆次層級保留並發出警告（見 `/api/v1/health` 的 `warnings`）。

## 驗證（可重跑）

```bash
bash scripts/verify.sh                      # 一鍵：測試 → 真實 ingest → 起 API → 打端點
npm test                                    # 後端 18 passed（含 fail-closed、交易回滾、change_log）
npm --prefix web test                       # 前端 tsc -b + 煙霧測試 25 + 渲染測試 27，全過
node server/ingest.mjs                      # 123 位委員 / 783 席次 / 5 會期 / 113 本會期名錄
node server/ingest.mjs                      # 第二次：status=skipped（sha256 未變）
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

畫面截圖：`docs/screenshot.png`。

## 部署（尚未執行，待決定）

1. **排程宿主**：Cloudflare Worker + D1 + Cron，或小 VPS + SQLite + cron。兩者都必須先做 30 分鐘 spike：從目標 runtime 打一次 `data.ly.gov.tw`（帶具名 UA），確認 TLS 與 WAF 都過。
2. **前端**：`web/dist` 是純靜態檔，放 Pages/Vercel/任何空間。
3. 破壞性／需帳號的動作（例如建立 Worker、push、對外發布）尚未執行，記錄於 `DECISIONS.md`。

## Code Review（2026-09-30）

後端 22 項、前端 27 項煙霧測試全數通過；`scripts/verify.sh` 對真實 API 端到端通過。

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

## 授權與資料來源

資料來源：立法院開放資料（`https://data.ly.gov.tw/`），依「政府資料開放授權條款第 1 版」。
API 回應的 `meta.source` 會帶出處與授權，前端每一頁都顯示「資料截至 …」。
