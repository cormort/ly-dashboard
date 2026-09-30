# 重新規劃：立委觀測站（legislator-intelligence-dashboard）

日期：2026-09-30 · 作者：DSH agent
前置文件：`REPORT.md`（現況可行性評估）、`poc.patch`（已驗證的止血修補）
本文件回答的是：**如果從零開始，我會怎麼做。**

---

## 0. 一句話的架構主張

> **把「抓政府資料」從瀏覽器搬到伺服器，並且把「會期（term + session）」當成資料模型的第一公民。**
> 前端不該、也不能直接面對 `data.ly.gov.tw`；而這個專案真正的難點不是 UI，是資料的正確性與可追溯性。

現況版本的問題不是程式寫得差，而是**層級放錯了**：所有 CORS、TLS、WAF、1.4 MB 全量、屆次過濾、欄位猜測，
都壓在瀏覽器的 18 行 `normalize()` 裡。重規劃的核心動作就是把這一坨搬到它該在的地方。

---

## 1. 架構：反轉資料流

```
┌──────────────────────────────────────────────────────────────┐
│ 排程層（每日 1 次，非即時）                                    │
│  cron ──▶ Fetcher ──▶ Validator ──▶ Normalizer ──▶ Upsert     │
│             │             │              │            │       │
│             ▼             ▼              ▼            ▼       │
│        raw_snapshot   異常即中止    純函式+fixture   SQLite/D1 │
│        (gzip, 永久)   (fail closed)  單元測試        + change_log│
└───────────────────────────────┬──────────────────────────────┘
                                ▼
                    自有 API  GET /api/v1/...（含 meta.fetched_at）
                                ▼
              前端（靜態檔）— 只讀自家 API，不再知道立法院的存在
```

### 為什麼一定要這樣（每一條都是實測結論，不是理論）

| 實測事實 | 架構含意 |
| --- | --- |
| 政府端點無 `Access-Control-Allow-Origin`，OPTIONS 405；瀏覽器 fetch 直接 `Failed to fetch` | 前端直連在架構上就是死路，不是「部署時再處理」 |
| Node/OpenSSL 需 `SSL_OP_LEGACY_SERVER_CONNECT` 才連得上；Python(OpenSSL 3) 同樣失敗；Deno 直接成功 | 抓取層的宿主 runtime 必須先驗證，不能先選平台再踩雷 |
| WAF 會擋預設函式庫 UA：`python-requests`→403、`Go-http-client`→403、`Python-urllib`→403；自訂具名 UA→200 | 抓取器必須帶**具名、可聯絡**的 User-Agent（也符合開放資料的禮貌原則） |
| 宣稱 `term`/`sessionPeriod` 參數無效，ID14 一律回 11,702 筆（1.4 MB，第 4–11 屆） | 過濾、去重、屆次切割是**伺服器端**工作；也代表「抓一次、用很久」，不該每 6 小時重抓 |
| 政府端點無 SLA、欄位命名不一致（`lgno` 只在 ID14、`isCoChairman` 是 Y/N） | 需要 schema 契約檢查 + 原始快照，端點改版時可 diff、可回溯 |
| 現況把 11 屆所有會期混在一起 → 委員會分類 70 種、召委 84 人（正解 64） | 「會期」必須是資料模型維度，不是顯示層的裝飾 |

---

## 2. 資料模型（以屆／會期為第一公民）

```sql
-- 人：跨屆不變的身分
CREATE TABLE legislators (
  id          TEXT PRIMARY KEY,        -- 優先用立院 lgno，退回 ename，最後才是 name+屆
  name        TEXT NOT NULL,
  ename       TEXT,
  sex         TEXT,
  degree      TEXT,
  experience  TEXT,
  photo_url   TEXT
);

CREATE TABLE terms (                    -- 屆
  no INTEGER PRIMARY KEY,               -- 11
  start_date TEXT, end_date TEXT
);

CREATE TABLE sessions (                 -- 會期：查詢與事實歸屬的單位
  id           TEXT PRIMARY KEY,        -- '11-5'
  term_no      INTEGER NOT NULL REFERENCES terms(no),
  seq          INTEGER NOT NULL,        -- 第 5 會期
  start_date   TEXT, end_date TEXT,
  UNIQUE(term_no, seq)
);

-- 任期區間：正確處理 leaveFlag / 遞補 / 中途離職
CREATE TABLE memberships (
  id            INTEGER PRIMARY KEY,
  legislator_id TEXT NOT NULL REFERENCES legislators(id),
  session_id    TEXT NOT NULL REFERENCES sessions(id),
  party         TEXT,
  caucus        TEXT,                   -- partyGroup（黨團，與黨籍不同！）
  area_name     TEXT,                   -- '雲林縣第1選舉區' / '全國不分區'
  onboard_date  TEXT, leave_date TEXT, leave_flag INTEGER DEFAULT 0,
  UNIQUE(legislator_id, session_id)
);

CREATE TABLE committees (
  id   TEXT PRIMARY KEY,                -- '內政委員會'
  kind TEXT                             -- 常設 / 特種（程序、紀律、修憲、經費稽核）
);

CREATE TABLE committee_seats (          -- 事實表：某人某會期在某委員會
  session_id    TEXT NOT NULL REFERENCES sessions(id),
  committee_id  TEXT NOT NULL REFERENCES committees(id),
  legislator_id TEXT NOT NULL REFERENCES legislators(id),
  is_convener   INTEGER NOT NULL DEFAULT 0,   -- 只在本會期為真
  PRIMARY KEY (session_id, committee_id, legislator_id)
);

-- 可追溯性：原始快照 + 變更日誌 + 執行紀錄
CREATE TABLE raw_snapshots (dataset TEXT, fetched_at TEXT, sha256 TEXT,
                            bytes INTEGER, gzip BLOB, PRIMARY KEY(dataset, fetched_at));
CREATE TABLE change_log (id INTEGER PRIMARY KEY, at TEXT, entity TEXT, entity_id TEXT,
                         field TEXT, old_value TEXT, new_value TEXT);
CREATE TABLE sync_runs (id INTEGER PRIMARY KEY, started_at TEXT, finished_at TEXT,
                        dataset TEXT, status TEXT, records INTEGER, attempt INTEGER,
                        http_status INTEGER, error TEXT, ua TEXT);
```

**三個關鍵設計決定**

1. **`legislator.id` 用立院的 `lgno`/`ename`，不用陣列索引。** 現況用 `` `LY-${i}` ``，排序一變追蹤就對錯人。
2. **`is_convener` 綁在 `session_id` 上。** 「召委」本質是「本會期召委」；跨屆 OR 起來就是現況 84 vs 64 的錯誤來源。
3. **`change_log` + `raw_snapshots` 是產品功能，不是維運副產品。** 政治資料的價值有很大一塊在「什麼時候改了什麼」，這是現況完全沒有、卻最容易做出差異的地方。

---

## 3. Ingestion：四段式管線（每段都可單獨測試）

```ts
// 1) FETCH —— 執行環境已驗證可通（Deno 直接 OK；Node 需 https.Agent + SSL_OP_LEGACY_SERVER_CONNECT）
const UA = "ly-dashboard/1.0 (+https://<你的網域>; 國會資料同步; contact@<你的信箱>)";
const res = await fetch(url, { headers: { "user-agent": UA, "accept": "application/json" },
                               signal: AbortSignal.timeout(30_000) });
// 2) VALIDATE —— 失敗就不寫入（fail closed），並告警
assertShape(json, { minRecords: 100, hasTerm: true, expectedKeys: ["name","party"] });
// 3) NORMALIZE —— 純函式，零網路，吃真實 fixture
const rows = normalizeId9(json, { term: "11" });   // 前綴剝除、欄位別名、leaveFlag → 區間
// 4) PERSIST —— upsert + 只寫變更
await db.tx(async t => { await upsertAll(t, rows); await diffIntoChangeLog(t, rows); });
```

- **重試**：指數退避 + 抖動，最多 3 次，只重試 5xx/逾時（4xx 重試沒意義）。
- **排程**：**每天 1 次**（政府資料本來就不是即時；現況每 6 小時抓 1.4 MB 是浪費，也是被 WAF 盯上的理由）。
- **條件式抓取**：帶 `If-Modified-Since`/`ETag`，未變更就不做後續。
- **失敗策略**：新資料驗證不過 → **保留舊資料 + 標記 stale + 告警**，絕不讓空資料覆蓋好資料，也絕不顯示假資料。
- **快照**：每次抓取存 gzip 原文（1.4 MB → 約 100–200 KB），保留即可回溯整段歷史。

---

## 4. API 與前端

**API（薄薄一層，只讀 DB）**

```
GET /api/v1/legislators?term=11&session=5&party=&committee=&q=&tracked=
GET /api/v1/committees?term=11&session=5
GET /api/v1/changes?since=2026-09-01
GET /api/v1/health            → { last_sync_at, stale, datasets: [...] }
```

回應一律附 `meta: { term, session, fetched_at, source_url, license }`；`Cache-Control: public, max-age=900`。

**前端**

- **Vite + React + TypeScript**，按功能拆檔（`api/`, `hooks/`, `components/`, `lib/normalize.ts`）。
  現在的「18 行 × 每行 300 字元」是 B3/B4 兩個 bug 能存活的原因。
- **TanStack Query** 管理抓取/快取/重試；UI 狀態機 `idle | loading | ready | stale | error`。
- **空狀態取代 demo 陣列**：demo 資料只能存在於 `import.meta.env.DEV` 或 Storybook。現況把兩個假立委當預設 state，任何同步失敗都會端出假資料。
- **URL 即狀態**：篩選條件放 query string（可分享、可回上一頁）。
- **不把 1.4 MB 帶進瀏覽器**：前端只拿「已過濾、已聚合」的結果；委員會人數圖表由 API 直接回 `[{name, count}]`。
- **每個數字都給出處**：卡片與詳情頁顯示「資料截至 2026-09-30 08:59（立法院開放資料）」。

---

## 5. 技術棧與部署（含必做的 30 分鐘 spike）

| 選項 | 優點 | 風險 | 我的取捨 |
| --- | --- | --- | --- |
| **Cloudflare Worker + D1 + Cron + Pages** | 免維運、免費額度足、全球快取 | Worker 的 TLS 堆疊是否能連上這個 TLS 老舊的政府主機**未驗證**（Deno/rustls 可通是好徵兆，但不能當保證） | **先 spike**：Worker 能 200 才選它 |
| **小 VPS（Fly.io / Hetzner）+ SQLite + cron** | 完全可控、`SSL_OP_LEGACY_SERVER_CONNECT` 明確可用（已驗證） | 要自己顧機器 | **保底方案**，確定可行 |
| 前端放哪 | — | — | Pages / Vercel / 任意靜態空間（前端已無祕密） |

**Spike 驗收條件**（30 分鐘）：從目標 runtime 對兩個端點各發一次請求，帶具名 UA，取得 200 且筆數符合（ID9 ≥ 120、ID14 ≥ 11,000）；否則換 VPS 方案，不硬撐。

---

## 6. 分階段路線圖（每階段都有可驗證的驗收條件）

### P0 止血（0.5–1 人日）— 讓它「真的顯示真資料」
1. 代理層（`poc.patch` 已驗證：Vite proxy + `https.Agent{SSL_OP_LEGACY_SERVER_CONNECT}`）。
2. 修 `normalize()`：剝「第N屆第M會期：」前綴、ID14 只取當屆、穩定 id、過濾 `leaveFlag=是`。
3. 移除預設 demo 資料。
- **驗收**：瀏覽器顯示 113 位委員、委員會下拉 11 類、召委 64、無 console error。
  （我在 PoC 已經跑出這組數字，等於驗收條件已被證明可達。）

### P1 正確性基礎（2–3 人日）— 讓它「不會說錯話」
4. Ingestion 管線 + SQLite + schema 驗證 + raw snapshot。
5. 解析層抽成純函式 + fixture 回歸測試（用今天抓到的真實 JSON 當測資）。
6. `/api/v1/*` + 前端改讀自家 API + 型別化。
- **驗收**：斷網時前端顯示「資料截至 X（stale）」而不是錯誤或假資料；`npm test` 覆蓋 normalize 的所有分支；連續兩次同步第二次為 0 變更。

### P2 會期與信任（3–5 人日）— 讓它「比別人準」
7. 會期選擇器、本會期召委、委員會席次以會期為準。
8. `change_log` → 「本週異動」頁；資料來源／授權／更新時間標示。
9. 追蹤（⭐）改存後端或穩定的 localStorage schema + 匯出。
- **驗收**：切換會期時所有數字一致變動且可人工核對 3 位委員；異動頁能正確反映一次模擬的 API 變更。

### P3 Intelligence 擴充（1–2 週）
10. 接法案／表決／質詢等開放資料集（同樣免金鑰），以同一套 ingestion 樣板新增 dataset。
11. 委員個人頁：提案數、表決缺席率、質詢主題；全文搜尋。
12. 通知（每週 email/RSS 異動摘要）。
- **驗收**：新增一個 dataset 不需要改前端框架，只需加 adapter + 測試。

---

## 7. 我會明確「不做」的事

- ❌ **不用第三方 CORS proxy**（`cors-anywhere` 之類）：把資料流交給不明第三方，政治資料尤其不可接受。
- ❌ **不做即時**：資料源本來就每日更新，假裝即時只是製造錯誤期待。
- ❌ **不偽裝瀏覽器 UA 繞 WAF**：用可辨識、可聯絡的具名 UA（實測可通）。
- ❌ **不在前端做資料清洗**：清洗邏輯必須可測試、可回溯、可重跑。
- ❌ **不保留 demo 假資料在 production bundle**。
- ❌ **不在 P0 階段就重寫 UI**：先讓資料對，再談好看。

## 8. 我會保留的現況優點

- 3 次指數退避重試 + 同步紀錄 UI（`sync_runs` 直接沿用這個概念，只是搬到後端）。
- 本機快取降級的想法（升級成 raw snapshot + stale 標記）。
- `fld(o, ...aliases)` 的防禦性欄位別名：政府資料欄位會改名，這個直覺是對的，只是要住進有測試的 adapter。
- 對「立法院資料可能格式不一」的預備心態。

## 9. 需要你拍板的岔路（我先給預設，不阻塞）

| 岔路 | 我的預設 | 影響 |
| --- | --- | --- |
| 目標受眾 | 國會助理／記者／公民監督者 | 決定 P2/P3 優先序（記者的話，異動通知 > 圖表） |
| 部署平台 | 先 spike Worker，不通就 VPS | 影響維運成本與 TLS 風險 |
| 歷史深度 | 只做第 11 屆 + 保留後續屆次擴充點 | 全面歷史（第 4 屆起）要多花約 2 人日做屆次對照 |
| 是否要帳號系統 | 不要，追蹤存本機 | 有帳號就要處理個資與維運 |

---

## 10. 與現況的差異總表

| 面向 | 現況 | 重規劃 |
| --- | --- | --- |
| 資料取得 | 瀏覽器直連政府 API（被 CORS 擋死） | 伺服器排程抓取 + 原始快照 |
| 屆次／會期 | 全部混在一起，靠姓名 join | 顯式 `terms`/`sessions`，事實綁會期 |
| 身分識別 | 陣列索引 | `lgno`/`ename` 穩定 id |
| 失敗行為 | 顯示 2 筆假立委 | 保留舊資料 + stale 標示 + 告警 |
| 資料清洗 | 塞在瀏覽器一行裡 | 純函式 + fixture 測試 |
| API 流量 | 每 6 小時 1.4 MB（`no-store`） | 每日 1 次 + 條件式抓取 + 快取 |
| 可追溯性 | 無 | raw snapshot + change_log + 異動頁 |
| 型別／測試 | 無 TS、無測試 | TS + 解析層測試 + contract 檢查 |
| 上線風險 | 假資料、WAF 403、TLS EPROTO | 全部在 P0/P1 前置解決 |
