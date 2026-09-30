# Code Review（第二輪，獨立審查）

- 專案：`/Users/hermes/ly-dashboard`
- 受審版本：`49ca770`（`git merge --ff-only origin/main`，本地已同步）
- 範圍：`e3da907..49ca770`（46 檔、+3610/−1309）與受影響的既有程式
- 方式：**實際跑起來驗證**（真實 ingestion + 真實瀏覽器），不是只讀碼
- 本檔案由審查者撰寫，**未修改任何程式碼**、未 commit

---

## 0. 結論

**可以繼續往上蓋，但有兩個必修的使用者可見缺陷。**

這次改版把資料層做得很紮實：三個新資料集都真的抓得到、都有 fail closed、都有測試，三條資料正確性防線完好。
問題集中在**前端互動的沉默失敗**：點擊沒反應、篩選列說謊，使用者的感受會是「網站壞了」。
另外有一個維運面的回歸：一鍵驗證腳本沒跟上改版。

| 嚴重度 | 數量 | 一句話 |
| --- | --- | --- |
| 🔴 高（已用真實瀏覽器重現） | 2 | 法案頁點離職委員提案人沒反應；換會期後隱形篩選造成 0 筆 |
| 🟡 中 | 5 | 驗證腳本過期、新資料集無稽核軌跡、手動同步要 4 分鐘、社群來源單點、新聞階段無總時間上限 |
| 🟢 低／nit | 9 | 文件不一致、a11y、http 圖片、死碼、脆弱字串手術 |

---

## 1. 實跑驗證（這次審查的實際輸出）

```
$ node --test test/              → ℹ tests 46 / pass 46 / fail 0
$ node server/ingest.mjs         → status: success（總計約 4 分鐘）
  roster : 123 委員 / 783 席次 / 5 會期 / 本會期名錄 113 / 本會期召委 23（跨會期 68）
  bills  : 7402 筆議案 / 18635 筆提案人對應 / warnings []
  social : 113 筆社群帳號 / warnings []
  news   : 新增 3261 則 / 失敗 0 位（113 位）
$ npm --prefix web run build     → ✓ built（js 280.71 kB → gzip 86.69 kB，比上一版 620 kB 小一半）
$ npm --prefix web test          → smoke 26 項通過 / render-smoke 35 項通過
```

外部來源獨立探測（不是只信程式裡的註解）：

| 來源 | 結果 |
| --- | --- |
| g0v `ly.govapi.tw/v2/bills` | HTTP 200；`limit=1000` 可用、`total 7402 / total_page 8`、第 8 頁 402 筆、每頁 <1 秒 |
| Google News RSS | HTTP 200；`"黃國昌" 立委 when:30d` → 100 則，標題含姓名者 95 則 |
| Google 試算表 CSV | HTTP 200、`text/csv`、112 資料列、欄位名稱與 `SOCIAL_COLUMNS` 完全一致 |

瀏覽器實測（真實資料、無 mock）：

| 頁面 | 結果 |
| --- | --- |
| `/`（最近動態） | 「委員動態／熱門議題／最新新聞」三區塊都渲染，無任何示範資料 |
| `/legislators` | 半圓席次 **113 席**，aria-label 顯示 `民主進步黨 51／台灣民眾黨 8／無黨籍 2／中國國民黨 52`（與本屆實況一致），名錄 113 張卡 |
| `/bills` | 法案查詢可用，`?q=公民投票法` 有結果 |
| `/legislators` SPA fallback | `GET /legislators → 200 text/html` |

---

## 2. 🔴 高：必修

### H1. 法案頁點「已離職委員」的提案人 → 完全沒反應（已重現）

**位置**：`web/src/App.tsx:19-28`（`DetailById`）、`web/src/pages/BillsPage.tsx`（`onOpenId(s.id)`）

**原因**：`DetailById` 只送 `?id=X`，後端 `resolveScope` 會套用 `current.session`（11-5），
而名錄 `items` 只由「該會期有 membership 的人」組成 → 離職者回空陣列 → `phase === 'empty'` → 程式呼叫 `onClose()`，
**沒有 drawer、沒有錯誤、沒有任何訊息**。

**證據（我在真實瀏覽器重現，同一頁同一操作，只換人）**：

```
A) 點「黃國昌」（已離職，id 00084，本屆 229 件提案）
   → {"aside":false, "asideText":null, "anyMessage":null}      ← 完全沒反應
B) 點「傅崐萁」（在職，對照組）
   → {"aside":true, "asideText":"傅崐萁 | 中國國民黨 | FU KUN-CHI | 花蓮縣選舉區・第 11 屆 | 加入追蹤 | 社群 | 臉書…"}
```

API 層根因：

```
$ curl -s "/api/v1/legislators?id=00084"                → count 0 total 0 []
$ curl -s "/api/v1/legislators?id=00084&session=all"    → count 1 total 1 ['黃國昌']
```

可達性：7402 件議案中，只取第 1 頁 200 筆就有 **8 個**離職委員的提案人按鈕（黃國昌、吳春城、麥玉珍、林憶君、張啓楷…，共 10 位已離職）。

**建議**：`DetailById` 的請求改帶 `session=all`（或新增 `scope=auto` 語意），並在 `empty/error` 時顯示「找不到這位委員的資料」而不是靜默 `onClose()`。

### H2. 換會期不清委員會／選區條件 → 篩選列顯示「全部委員會」但結果 0 筆（已重現）

**位置**：`web/src/pages/LegislatorsPage.tsx`（`onSessionChange` 只 `update({session})`；`resetForTermChange` 只在換屆次時呼叫）

**證據（真實瀏覽器，逐步操作）**：

```
切換前 (11-5 + 修憲委員會): cards 39，select 顯示「修憲委員會（39 席）」
切成「第 11 屆第 4 會期」後:
  url    : …?term=11&session=11-4&committee=修憲委員會     ← 條件沒清掉
  cards  : 0
  select : 「全部委員會」（因為 11-4 沒有這個選項）
  空狀態 : 「沒有符合條件的委員」
```

也就是使用者看到「全部委員會」卻 0 筆，無法理解原因。11-1/11-2/11-4 沒有修憲委員會、11-3/11-5 有，所以這是天天會踩到的路徑。

**建議**：換會期時清掉（或至少在渲染前剔除）不屬於新會期的 `committee` 與 `region` 條件，並補一條 smoke 測試（目前只有「換屆次會清條件」的測試）。

---

## 3. 🟡 中

### M1. `scripts/verify.sh` 沒跟上改版（回歸）

`node server/ingest.mjs` 現在是 `runAll`，所以一鍵驗證會：

- 對 Google News 發 **113 × 2 = 226 次**請求（腳本會跑兩次同步來驗 idempotency），整體約 8 分鐘；
- 仍然**只驗名錄與委員會**，沒有驗 `bills / topics / activity / news` 與新的 health 計數；
- 第一輪結束後第二輪的 `status` 不會是 `skipped`（新聞是累積寫入），輸出會與 README 的描述不符。

**建議**：新增 `LY_SKIP_NEWS=1`／`LY_SKIP_BILLS=1` 之類開關給測試用，`verify.sh` 預設跳過外部來源或改用 fixture；並補上新端點的檢查。

### M2. 新資料集沒有原始快照，也沒有異動紀錄

`raw_snapshots` 只有 `id9`(0.03 MB gz) 與 `id14`(0.08 MB gz)；`change_log` 目前 0 筆且只由 `applyDataset` 產生。
bills（約 8 MB 原始 JSON）、社群 CSV、新聞 RSS **都沒有存快照**，g0v 或試算表改版時無法 diff「上一版長什麼樣」。
這正是原設計把 `raw_snapshots` + `change_log` 當產品功能的核心（PLAN.md §2），新資料集沒有繼承。

**建議**：`runBillsIngest`／`runSocialIngest` 至少存一份 gzip 快照（bills 可只存 sha256 + 筆數摘要），並在 `applyBills` 產生 `change_log`（例如議案狀態由「排入院會」→「三讀」）。

### M3. `POST /api/v1/sync` 從 7 秒變成約 4 分鐘

`runAll` 串起四個階段。任何有 client timeout 的呼叫端（curl 預設不會，但瀏覽器 fetch、反向代理會）都會失敗，而後端其實還在跑。

**建議**：改成 `202 Accepted` + 既有 `/sync-runs` 輪詢，或提供 `?scope=roster` 只跑名錄。

### M4. 社群來源是單一硬編的 Google 試算表，且門檻幾乎沒有餘裕

目前 112 列、門檻 `rows.length < 100` → 只要有人刪 13 列，`social` 就整批 fail closed（保留舊資料，可接受，但沒有預警）。
試算表擁有者也能隨時改欄名、刪欄、收回連結。

**建議**：把抓到的 CSV 存成 `raw_snapshots` 的一份（同時解 M2），門檻改成「不比上一版少 20%」而非絕對 100；並在 `/health` 顯示 social 的最後成功時間。

### M5. 新聞階段沒有總時間上限，且失敗判準寬鬆

113 位依序抓、每位 ≥1 秒，單階段約 3 分鐘；`runAll` 要等它全部跑完才返回。
判準是「失敗數 > 半數」才算 failed，所以「30 位失敗」會被記成 success（`error` 欄位仍會寫，前端可看得到，但狀態燈是綠的）。

**建議**：加整體時間預算（例如超過 5 分鐘就中止剩餘委員，記為 partial），並把「有任何失敗」反映到 health 的 warning。

---

## 4. 🟢 低／nit

| # | 位置 | 問題 |
| --- | --- | --- |
| L1 | `README.md:17,83,123` | 測試數字三個版本並存：46 項 / 「後端 18 passed」/「後端 22 項、前端 27 項」。實際是後端 46、前端 smoke 26 + render 35。 |
| L2 | `docs/API.md` | 缺 `committees.parties`、`legislators.former/leave_date/leave_reason`、`health.db` 新增的 bills/news/social_accounts 計數（實跑後端確實會回）。 |
| L3 | `server/queries.mjs` `listNews` | 用 `where.replace('legislator_id','n.legislator_id')` 做字串手術；改欄名或 where 條件就會產生壞 SQL，建議直接寫兩個查詢。 |
| L4 | `server/db.mjs` `upsertNews` | 每筆先 `SELECT 1 …` 再 INSERT（約 3k 查詢/輪）。可用 `INSERT … ON CONFLICT` 的回傳值或 `db.changes` 判斷。 |
| L5 | `web/src/components/Hemicycle.tsx:86-96,128` | 席次 `<circle onClick>` 不可聚焦／不可鍵盤操作，但文案寫「點席次可開啟委員檔案」；`svg role="img"` 也會讓子節點離開 a11y tree。 |
| L6 | `web/src/components/Header.tsx:92` | `aria-controls="sync-panel"` 指向只在 `syncOpen \|\| failed \|\| stale` 才存在的元素。 |
| L7 | `LegislatorDetail.tsx:79`、`HomePage.tsx:25` | 人像沒有 `onError` 後備（只有 `LegislatorGrid` 的 Avatar 有）；且 `photo_url` 是 `http://www.ly.gov.tw//Images/...`，HTTPS 部署會 mixed content。 |
| L8 | `BillsPage.tsx:72-85` | 選了狀態之後，狀態下拉只剩一個選項（後端 `statusCounts` 由已過濾列計算）。`laws` 有 chip 可清，status 沒有。 |
| L9 | `lib/format.ts:63`、`lib/legislators.ts:9` | `committeeAxisLabel`、`deriveParties` 只剩測試在用；同時 `id.replace('委員會','')` 在三個元件各寫一次（沒有 `$` 錨點）。 |

---

## 5. 做對的地方（值得留住）

1. **三條資料正確性防線完好**（我獨立複驗）：
   - 委員會一律用 API 的乾淨 `committee.id`，`src/` 全域沒有會期前綴解析；
   - 追蹤以穩定 `Legislator.id` 為 key，`grep "key={i}|key={index}"` 零命中；
   - `grep 甲黨|示範資料|林怡安 dist/` 零命中，空狀態明確。
2. **fail closed 是每個資料集的一致行為**，而且有測試（抓取失敗、筆數暴跌、交易回滾、single-flight）。
3. **真實資料全綠**：7402 議案 / 18635 提案人對應 / 113 社群帳號 / 3261 新聞（0 失敗）/ 半圓圖席次與黨籍分布與本屆實況一致。
4. **前一次自我 review 的修正（A1–A5、CR-1…）我抽查都正確**：`setMeta` 進交易、`syncOnce` single-flight、`limit/offset` 夾限、`skipped` 仍更新 `last_success_at`、`fetch` 串流 error 監聽。
5. **Bundle 從 620 kB 降到 280 kB（gzip 187→87 kB）**：移除 recharts 換成自繪 SVG 是明顯的改善。

---

## 6. 建議修復順序

1. **H1**（沉默的點擊失敗）— 使用者會直接認為壞掉。
2. **H2**（隱形篩選）— 每次切會期都可能踩到。
3. **M1**（`verify.sh`）— 這是這個專案唯一的端到端驗證入口，它過期就等於沒有回歸防線。
4. **M2 / M3**（稽核軌跡、同步 API 語意）— 影響長期維運。
5. 其餘 L 項可批次處理。

> 我沒有動任何檔案。本地 repo 已同步到 `49ca770`，`git status` 乾淨；本報告是唯一新增的檔案（未 commit）。
