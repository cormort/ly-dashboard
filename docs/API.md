# API 契約 v1（凍結）

Base URL（開發）：`http://127.0.0.1:8787`
前端開發時由 Vite proxy `/api` → `http://127.0.0.1:8787`（同源，無 CORS 問題）。

所有回應皆為 JSON，結構固定為 `{ meta, ... }`。
`meta` 一律包含：

```jsonc
{
  "generated_at": "2026-09-30T09:20:00.000Z",  // 本回應產生時間
  "fetched_at":   "2026-09-30T08:59:55.000Z",  // 資料最後成功同步時間（可能為 null）
  "stale":        false,                        // 距離上次成功同步超過 36 小時
  "source":       { "name": "立法院開放資料", "url": "https://data.ly.gov.tw/", "license": "政府資料開放授權條款第 1 版" },
  "term":         11,                            // 僅在有屆次語意的端點出現
  "session":      "11-5"                         // 僅在有會期語意的端點出現（可為 null）
}
```

錯誤回應：HTTP 4xx/5xx，body `{ "error": { "code": "bad_request", "message": "..." } }`。

---

## GET /api/v1/health

```json
{
  "meta": { "generated_at": "...", "fetched_at": "...", "stale": false, "source": { "...": "..." } },
  "ok": true,
  "db": { "legislators": 123, "memberships": 567, "committee_seats": 783, "sessions": 5, "committees": 11,
          "changes": 37, "snapshots": 6, "bills": 7402, "news": 3261, "social_accounts": 113 },
  "datasets": {
    "id9":    { "fetched_at": "2026-09-30T08:59:55.000Z", "count": 123 },
    "id14":   { "fetched_at": "2026-09-30T08:59:55.000Z", "count": 783 },
    "bills":  { "fetched_at": "2026-09-30T09:02:10.000Z", "count": 7402 },
    "news":   { "fetched_at": "2026-09-30T09:06:40.000Z", "count": 3261, "status": "complete:113/113" },
    "social": { "fetched_at": "2026-09-30T09:02:35.000Z", "count": 113 }
  },
  "last_runs": [
    { "dataset": "id9", "status": "success", "finished_at": "2026-09-30T08:59:55.000Z", "records": 113, "attempt": 1, "error": null }
  ],
  "warnings": ["游錫堃 在本屆無任何會期委員會紀錄（辭職），僅出現於全屆次檢視"]
}
```

`datasets[].status` 只有新聞會出現：`complete:113/113` 或 `partial:40/113`（時間預算用盡）。
`warnings` 除了名錄警告，也會帶入「新聞同步未跑完」這類非致命提醒。

## GET /api/v1/meta

提供屆次／會期清單、目前預設屆期、以及來源標示。

```json
{
  "meta": { "...": "..." },
  "terms": [
    { "no": 11, "sessions": [ { "id": "11-1", "seq": 1, "label": "第 11 屆第 1 會期" }, { "id": "11-5", "seq": 5, "label": "第 11 屆第 5 會期" } ] }
  ],
  "current": { "term": 11, "session": "11-5" },
  "counts": { "terms": 1, "sessions": 5 }
}
```

`current.session`：取該屆「有委員資料的最新會期」；若無法判定則為 `null`（前端要能處理 null）。

## GET /api/v1/committees?term=11&session=11-5

```json
{
  "meta": { "...": "...", "term": 11, "session": "11-5" },
  "count": 11,
  "items": [
    { "id": "內政委員會", "kind": "standing", "count": 14,
      "parties": { "中國國民黨": 7, "民主進步黨": 6, "台灣民眾黨": 1 },
      "conveners": [ { "id": "00024", "name": "牛煦庭" } ] }
  ]
}
```

`kind`: `standing` | `special` | `ad_hoc`。`count` 為該會期該委員會的席次數，`parties` 為該委員會的黨籍組成（給委員會組成圖用）。
委員會清單**只包含該會期真實存在的委員會**（非全歷史）。

## GET /api/v1/legislators

Query 參數（全部可選）：

| 參數 | 說明 |
| --- | --- |
| `term` | 屆次，預設 `current.term` |
| `session` | 會期 id（如 `11-5`），預設 `current.session`；`all` 表示該屆全部會期。**無效的會期 id 會回退到該屆最新會期**（回應的 `meta.session` 會是實際使用的會期） |
| `q` | 關鍵字，比對姓名／選區／委員會／黨籍 |
| `id` | 精確比對委員 id（開啟單一委員檔案用） |
| `party` | 精確比對黨籍 |
| `region` | 精確比對選區的縣市層級（`雲林縣`、`全國不分區`、`山地原住民`…，共 25 種） |
| `committee` | 精確比對委員會 id |
| `convener` | `1` 只回傳本會期召委 |
| `limit` / `offset` | 分頁（預設 500 / 0） |

```json
{
  "meta": { "...": "...", "term": 11, "session": "11-5" },
  "count": 113,
  "total": 113,
  "items": [
    {
      "id": "LY-00024",
      "name": "牛煦庭",
      "ename": "NIU Hsu-Ting",
      "party": "中國國民黨",
      "caucus": "中國國民黨",
      "area_name": "桃園市第1選舉區",
      "region": "桃園市",
      "sex": "男",
      "onboard_date": "2024/02/01",
      "contacts": [ { "label": "國會研究室", "tel": "02-2358-0000", "fax": "02-2358-0001", "addr": "台北市中正區濟南路1段3之1號" } ],
      "social": [ { "platform": "facebook", "name": "吳思瑤", "url": "https://www.facebook.com/taipeineedyou", "latest_post_date": "2026-09-27", "latest_post_summary": "…", "source": "sheet" } ],
      "photo_url": "http://www.ly.gov.tw//Images/Legislators/110001.jpg",
      "degree": "…",
      "experience": "…",
      "term": 11,
      "sessions": ["11-1", "11-2", "11-5"],
      "committees": [ { "id": "內政委員會", "kind": "standing", "is_convener": true } ],
      "is_convener": true,
      "source_url": "https://data.ly.gov.tw/odw/ID9Action.action"
    }
  ]
}
```

注意：
- `id` 為穩定識別（立院 `lgno`，退而 `ename`，最後 `name`），**不是陣列索引**。
- 委員會 `id` 一律是乾淨名稱（`內政委員會`），**不含**「第11屆第3會期：」前綴。
- `region` 由後端從 `area_name` 歸併（去掉「第N選舉區」），前端不得自行推算。
- `contacts` 依處所合併立院 `tel`／`fax`／`addr` 三個字串欄位；沒有資料時為 `[]`。
- `social` 來自人工整理的 Google 試算表（`LY_SOCIAL_CSV` 可覆寫），每次同步整批覆寫；`latest_post_*` 是整理表記錄的最新貼文，不是即時抓取。
- `social[].source`：`sheet`＝整理表、`override`＝人工更正表（`server/social-overrides.json`）。
  更正過的帳號會清空 `latest_post_*`，因為原本的貼文摘要屬於舊（錯誤）網址；等整理表補上資料後才會再出現。
- `is_convener` 是**該會期**的召委，不是「曾經當過」。
- 無資料時回 `items: []`、`count: 0`，**不得**回傳任何示範／假資料。

## GET /api/v1/bills

委員提案（本屆、提案來源＝委員提案）。資料來自 g0v 立法院 API（`ly.govapi.tw`，非官方），每次同步整批覆寫。

| 參數 | 說明 |
| --- | --- |
| `legislator` | 委員 id；指定時只回該委員的提案（主提案或共同提案） |
| `q` | 關鍵字，比對議案名稱或涉及的法律 |
| `law` | 精確比對涉及的法律名稱 |
| `status` | 精確比對議案狀態（如 `三讀`） |
| `session` | 會期序號（屆內，如 `5`） |
| `from` / `to` | 最新進度日期區間（`YYYY-MM-DD`，含端點）；格式不符視為未指定 |
| `limit` / `offset` | 分頁，limit 1–200，預設 20 / 0 |
| `format=csv` | 回傳**全部**符合結果的 CSV（UTF-8 含 BOM，`content-disposition: attachment`），忽略 limit/offset |

```json
{
  "meta": { "...": "...", "bills_fetched_at": "2026-09-30T03:10:00.000Z", "bills_source": { "name": "g0v 立法院 API", "url": "https://ly.govapi.tw/" } },
  "total": 46,
  "count": 10,
  "laws": [ { "name": "老年農民福利津貼暫行條例", "count": 8 } ],
  "items": [
    {
      "id": "202110204560000",
      "name": "「衛生福利部中央健康保險署組織法第二條條文修正草案」，請審議案。",
      "status": "三讀",
      "category": "法律案",
      "session": 5,
      "laws": ["衛生福利部中央健康保險署組織法"],
      "latest_date": "2026-08-27",
      "is_lead": true,
      "url": "https://ppg.ly.gov.tw/ppg/bills/202110204560000/details"
    }
  ]
}
```

注意：
- `term`：資料所屬屆次；`sessions`：`[{ seq, count }]` 各會期件數（在會期條件**之前**算）；每筆 `items[]` 附 `term`、`session`。
- `parties`：符合結果的主提案人黨籍 → 件數（黨團提案記為 `黨團／其他`，加總＝`total`）；`first_date`：符合結果中最早的進度日期。
- `laws` 是「主題」：**全部符合結果**涉及的法律，依件數排序取前 8；`statuses` 是符合結果的狀態分布。前端不得重算。
- 每筆 `items[].sponsors`：`[{ id, name, party, is_lead }]`，主提案在前。
- `is_lead`：提案人陣列第一位＝主提案人。提案人是黨團時不對應到任何委員。
- 議案同步與名錄同步各自 fail closed；名錄同步失敗時不跑議案。

## GET /api/v1/topics

熱門議題：依**受控詞彙**分組，支援時間區間與兩種檢視所需的資料。

| 參數 | 說明 |
| --- | --- |
| `days` | `7`／`30`／`90`，或 `all`（本屆累計）。預設 30 |
| `vocab` | `law`（法律名稱，預設）／`category`（議案類別，含預算案）／`committee`（委員會會議紀錄） |
| `limit` | 取前 N 名（預設 12，最大 50） |

```json
{
  "meta": { "...": "..." },
  "vocab": "law",
  "vocabularies": [
    { "id": "law", "label": "法律名稱", "unit": "件", "note": "議案涉及的法律" },
    { "id": "category", "label": "議案類別", "unit": "件", "note": "議案的類別（含預算案）" },
    { "id": "committee", "label": "委員會", "unit": "場", "note": "委員會會議紀錄場次" }
  ],
  "window": { "days": 90, "from": "2026-07-15", "to": "2026-10-13",
              "recent_from": "2026-10-06", "previous_from": "2026-04-16" },
  "comparable": true,
  "data_from": "2024-02-20",
  "data_to": "2026-10-13",
  "distinct": 244,
  "count": 20,
  "items": [
    {
      "name": "性別平等工作法",
      "count": 130,
      "recent_count": 0,
      "previous_count": 0,
      "delta": 130,
      "passed": 12,
      "latest_date": "2026-08-26",
      "latest_status": "交付審查",
      "latest_name": "性別平等工作法部分條文修正草案",
      "latest_url": "https://ppg.ly.gov.tw/…",
      "parties": { "中國國民黨": 82, "民主進步黨": 46, "台灣民眾黨": 1, "黨團／其他": 5 }
    }
  ]
}
```

- `count` 是期間內件數（`committee` 詞彙為場次）；`recent_count` 固定是**近 7 天**，不受 `days` 影響。
- `previous_count` 是前一個**等長**區間的件數；`delta = count − previous_count`。
- **`comparable`**：`days=all`（本屆累計）或前期區間早於資料起點時為 `false`，此時 `delta` 一律為 `0`
  ——寧可顯示「不顯示增減」，也不要報一個假的成長數字。
- `parties` 是**主提案人黨籍**分布；對不到委員的提案歸為 `黨團／其他`，所以分布總和恆等於 `count`。
  `committee` 詞彙沒有提案人，`parties` 為空物件。
- 每個詞彙 anchored 在**自己的**資料截止日（`data_to`）：議案到 2026-10-13、公報紀錄只到 2026-08-26；
  用同一個基準會讓委員會詞彙在 7 天區間永遠是空的。
- `distinct` 是期間內出現過的詞彙總數（前端用來提示「這個詞彙只有 8 種」）。

## GET /api/v1/activity

最近有動態的在職委員（首頁用）：各委員最新一則臉書貼文（整理表）、新聞、提案進度，取最新者排序；同日以近 7 天新聞量多者在前。參數 `limit`（1–113，預設 12）、`ids`（逗號分隔的委員 id，只列這些人；首頁「追蹤中」用）。

```json
{ "count": 12, "items": [ { "legislator": { "id": "…", "name": "蘇巧慧", "party": "民主進步黨", "region": "新北市", "is_convener": false, "…": "…" },
  "activity_date": "2026-09-30", "news_7d": 12, "post": { "date": "2026-09-28", "summary": "…", "url": "…" }, "news": { "title": "…", "…": "…" }, "bill": { "name": "…", "status": "排入院會", "…": "…" } } ] }
```

## GET /api/v1/budget

預算審議（g0v 立法院 API，本屆 `議案類別` ∈ 中央政府總預算案、法人預(決)算案、預(決) 算決議案、定期報告；依會期分批抓，因為翻頁超過約 1 萬筆會 HTTP 413）。

| 參數 | 說明 |
| --- | --- |
| `category` | 精確比對類別；空白＝全部 |
| `type` | 預算類型 `general`（總預算）／`subsidiary`（附屬單位預算）／`special`（特別預算）／`supplementary`（追加預算）；由名稱「決議／檢送」之前的主旨判斷，可複選，對不到任何類型的項目只在未指定時出現 |
| `q` | 比對名稱或提案單位 |
| `year` | 預算年度（民國，從名稱「115年度」抽出） |
| `proposer` | 精確比對提案單位（機關或委員會） |
| `state` | `pending`（審議中）／`done`（已結案）／`returned`（退回） |
| `limit` / `offset` | 分頁，limit 1–200，預設 30 |
| `format=csv` | 全部符合結果的 CSV |

回應：`total`、`categories`（全部資料的類別件數）、`types`（四種預算類型件數，在類型條件前算）、`items[].types`、`years`、`proposers`（前 15）、`states`（三類件數）、`items[]`（含後端分好的 `state`）。
統計依序在套用各自條件**之前**計算：選了某機關，機關清單仍列出其他機關。
定期報告多半「交付查照」即結案、不經審查，所以不套委員提案的五階段流程。

## GET /api/v1/budget/reports

立法院預算中心評估報告（官方 WebAPI `BudgetCenterResearch.aspx`，類型：預算案評估、決算案評估；本屆起迄今）。參數 `type`、`q`、`limit`（1–100）、`offset`。
`items[]`：`{ no, type, title, author, completed, url }`，`url` 可能為 null（未附檔）。

## GET /api/v1/budget/meetings

議程（會議事由）含「預算」的委員會會議（官方 ID223 委員會登記發言名單，本屆一次抓）。參數 `limit`（1–100，預設 15）。
回應：`total`（全部預算會議）、`with_speakers`、`committees`、`speakers`（在職委員登記發言場次前 20）、`items`（最近**有發言名單**的會議）。
發言名單姓名比對時忽略空白與「‧」「·」（族語名分隔符號各系統不一）。

## GET /api/v1/regions?per=3

各區域（縣市，另有全國不分區、平地／山地原住民）最新動態，總覽頁用。依縣市由北到南排序。
每區：`legislators`（在職委員 `{ id, name, party }`）、`news_7d`（該區委員近 7 天新聞合計）、
`latest`（委員們最近的貼文／新聞／提案合併後取最新 `per` 則，1–10，預設 3；`{ kind, date, text, url, legislator }`）。
動態來源與 `/activity` 相同。
縣市另有 `stats`：`{ population, elderly_ratio, president_2024, mayor_2022 }`，後兩者為勝選者 `{ name, party, pct, margin_pct }`；不分區與原住民為 null。

## GET /api/v1/counties

縣市分頁用。22 縣市（北到南、離島）的靜態人口與選舉資料（`server/county-stats.json`，由 `scripts/build-county-stats.mjs` 產生，更新方式見該檔開頭），加上該縣市在職區域立委。
回應：`population_month`（人口統計年月）、`elections`（各場選舉的 `{ label, date }`）、`sources`、`items[]`：
`{ county, households, population, voting_age（20 歲以上）, elderly（65 歲以上）, elections, path（地圖 SVG path）, legislators[] }`。
`elections` 有 `president_2024`、`president_2020`、`mayor_2022`、`mayor_2018`，各為 `{ electorate, turnout, valid, candidates[{ name, party, votes, pct }], margin, margin_pct }`，
候選人依票數排序，`margin`／`margin_pct` 為第一名與第二名的票數差與得票率差（百分點）。2018 起改用中選會原始檔，四場皆有選舉人數與投票率；嘉義市 2022 為 12/18 延期選舉。

每縣市另有 `trends`：`{ president（2012–2024）, mayor（2009 縣市長與 2010 五都合為一輪記 2010、`label` 為「2009／10」，至 2022）, party_list（不分區政黨票 2012–2024） }`，各為依年份排序的 `[{ year, label, valid, turnout, votes: { 政黨: 票數 } }]`（無黨籍候選人合併為「無黨籍」）；`trend_types` 為各類型名稱。

## GET /api/v1/legislator-votes

立委得票追蹤：在職委員 2012、2016、2020、2024 歷次參選區域／平地原住民／山地原住民立委的得票，含 2015 與 2019 起的補選（`server/legislator-votes.json`，與縣市資料同一支腳本產生）。`id` 參數查單一委員（含已離職）。
姓名比對時去掉空白與「‧」「·」等分隔符號。`items[]`：`{ legislator: { id, name, party, area_name, region }, history[] }`，
`history`：`{ year, kind, district, by_election, party, votes, pct, rank, elected, seats, candidates, rival, margin, margin_pct, change, president, party_list }`；
`rival` 為當選者對照的最高票落選者、或落選者對照的最低票當選者，`margin` 為與其票數差（落選為負），`change` 為與本人前一次參選的得票差。
`president`／`party_list`：同一天、同選區同黨的總統票與不分區政黨票（以投開票所對應選區加總；只有大選的區域立委有，無黨籍為 null），`{ votes, pct, over, over_pct }`，`over_pct` 為個人得票率減政黨得票率（百分點）。2020 有 2 個投開票所對不到選區，該年選區加總比縣市少 474 票。

`/api/v1/legislators` 與 `/api/v1/compare` 的每位委員另有 `election`：該屆（含屆內補選）當選選舉的摘要 `{ year, district, by_election, votes, pct, margin, margin_pct, rival, change, party_list_over_pct, president_over_pct }`，不分區為 null。

`/api/v1/rankings` 另有 `close`（險勝：最近一次當選的領先幅度）與 `drop`（得票流失：同選區與本人前次相比）兩榜，不受 `days` 影響。

## GET /api/v1/split-ticket?year=2024

分裂投票：某年大選（2012、2016、2020、2024；不合法時用最新一年）73 個區域立委選區的候選人得票（`candidates[{ name, party, votes, pct, elected }]`），
以及同選區的總統票與不分區政黨票 `president`／`party_list`：`{ valid, votes: { 政黨: 票數 } }`（投開票所加總）。前端依政黨算三種得票率與差距。

## GET /api/v1/committee-activity?committee=&limit=20

委員會頁與總覽用。`meetings`：委員會會議（官方 ID223，議程與登記發言委員 `{ id, name, party }`，對不到本屆委員者 `id` 為 null）；
`records`：公報的委員會紀錄（g0v `gazette_agendas` 類別代碼 3，含部會首長答詢全文），連結 `html_url`（處理後全文）、`pdf_url`、`gazette_url`。
兩者皆依日期新→舊，各附 `total` 與 `period`（全部資料的起訖日）。委員會由會議名稱開頭解析，聯席會議算在每個參與的委員會；
`replies`：機關回覆（g0v `meets` 議事網附件中種類為「機關回覆」者：部會對委員質詢的書面答復），`{ date, committees, meeting, title, url, legislators }`，
`legislators` 由標題中的委員姓名（含「邱委員慧洳」寫法）對出。`meetings` 每場另附 `attachments`（通知單、議事日程、書面報告…）與 `video_url`，依會議名稱對上 g0v 的會議。
`committee` 為委員會全名。`committees` 為各委員會件數，常設委員會依官網順序在前。

## GET /api/v1/funds?type=fund&fund=&kind=&limit=30&offset=0

基金（`type=fund`，預設）、機關（`agency`）、財團法人（`foundation`）、行政法人（`administrative`）四頁，以及主計總處專頁（`dgbas`：預算類議案提案機關為主計總處者標「主計總處提送」，標題提到「主計總處／主計長」者標「提及主計總處」）用；每個名稱只歸一類（行政法人 > 財團法人 > 基金 > 機關）：新聞、臉書最新貼文、委員提案、預算審議、預算中心報告中，標題提到特種基金、國營事業或財團法人的項目，依日期新→舊（新聞同一網址只留一則）。
關鍵字在 `server/fund-config.json`（取自 excel_merge 的 fund-config：全名＋不會誤判的簡稱，簡稱歸到正式名稱）與政府機關代碼表（data.gov.tw 7307）中未裁撤的層級 2–3 中央機關（已在基金清單的國營事業只算基金）；
行政法人另有 `administrative` 清單；財團法人／行政法人也從標題「財團法人○○」「行政法人○○」自動取出名稱（之後不帶前綴出現也算）。清單外凡含「基金」者歸「其他基金」，清單外的「基金會」歸「其他基金會」。
`fund` 精確篩選（上述名稱）、`kind`（`news|post|bill|budget|report`）。回傳 `kinds`（套用 `fund` 後各來源件數）、`periods`（各來源全部資料的期間 `{ from, to }`，YYYY-MM-DD）、
`funds`（套用 `kind` 後最常出現的前 40 個）、`items`（`{ kind, date, title, url, source?, status?, legislator, funds }`）。

## GET /api/v1/cosponsors

共同提案網絡（本屆議案的提案人對應）。

- 帶 `legislator=<id>`（可加 `limit` 1–50，預設 10）：最常一起列名的委員，以及跨黨合作比例。
  ```json
  { "legislator": "00084", "total_bills": 229, "cross_party_bills": 1,
    "items": [ { "id": "00015", "name": "吳春城", "party": "台灣民眾黨", "count": 145 } ] }
  ```
  `cross_party_bills`：該委員的議案中，有他黨委員一起列名的件數。
- 不帶參數：黨籍矩陣，`matrix[主提案人黨籍][連署人黨籍] = 人次`（不含主提案人本人）。

## GET /api/v1/compare?ids=a,b

委員並排比較（最多 4 位，去重、略過不存在的 id；已離職者也可比）。

```json
{ "count": 2, "items": [ { "legislator": { "id": "…", "name": "…", "former": false, "…": "…" },
    "bills": 46, "lead_bills": 17, "passed_bills": 8, "news_30d": 5,
    "committees": [ { "id": "內政委員會", "is_convener": false } ], "top_laws": [ { "name": "…", "count": 3 } ] } ],
  "shared": { "bills": 3, "committees": [] } }
```

`passed_bills` 以狀態 `三讀`、`審查完畢(三讀)`、`照案通過` 計；`shared.bills` 是所有人都列名的議案數。

## GET /api/v1/news

委員近期新聞。來源為 Google 新聞 RSS，每位在職委員以「`"漢名" 立委`」搜尋近 30 天，**只收標題含姓名者**；資料累積保存 180 天。

| 參數 | 說明 |
| --- | --- |
| `legislator` | 委員 id；不指定時回傳全部委員的最新新聞 |
| `limit` | 1–100，預設 10 |

```json
{
  "meta": { "...": "...", "news_fetched_at": "2026-09-30T03:30:00.000Z", "news_source": { "name": "Google 新聞", "url": "https://news.google.com/" } },
  "total": 86,
  "count": 8,
  "items": [
    { "legislator_id": "LY-…", "title": "麥寮拱範宮廟口開講爆滿 游顥、丁學忠站台力薦張嘉郡", "source": "匯流新聞網", "url": "https://news.google.com/rss/articles/…", "published_at": "2026-09-20T14:57:35.000Z" }
  ]
}
```

注意：
- 只存標題、媒體、連結、時間，不轉載內文；`url` 是 Google 新聞的轉址連結。
- 登記名含族語名時只用漢名搜尋（`伍麗華Saidhai‧Tahovecahe` → `伍麗華`），異體字換成媒體常用字（`寳` → `寶`）。
- 單一委員抓取失敗不影響其他人；超過半數失敗才把該次同步標為 `failed`，既有新聞保留。

## GET /api/v1/rankings

三種排行榜：新聞曝光、臉書發文、法案提案。**只列入在職委員**（離職者仍有歷史提案，放進排行榜會誤導）。
後端同時回傳 `intensity`（0–1，相對第一名的長條長度），前端不自行換算。

| 參數 | 說明 |
| --- | --- |
| `type` | `news` \| `facebook` \| `bills` \| `all`（預設 `all`） |
| `days` | 新聞榜的統計區間天數（預設 30，夾在 1–365） |
| `limit` | 每榜取前 N 名（預設 10，最大 50） |

```json
{
  "meta": { "...": "...", "bills_fetched_at": "2026-09-30T09:02:10.000Z", "news_fetched_at": "2026-09-30T09:06:40.000Z" },
  "days": 30,
  "limit": 10,
  "boards": {
    "news": {
      "type": "news",
      "title": "新聞曝光排行",
      "note": "近 30 天標題含委員姓名的報導數（Google 新聞，只計在職委員）",
      "unit": "則",
      "items": [
        { "rank": 1, "intensity": 1, "value": 87, "value_display": "87 則",
          "legislator": { "id": "00084", "name": "…", "party": "…", "area_name": "…", "region": "…", "photo_url": "…" },
          "detail": { "label": "來源媒體", "text": "最新一則標題", "url": "https://…" } }
      ]
    },
    "facebook": { "type": "facebook", "title": "臉書發文排行", "unit": "天前",
      "items": [ { "rank": 1, "intensity": 1, "value": 60, "value_display": "今天", "raw_days": 0,
                   "legislator": { "…": "…" },
                   "detail": { "label": "專頁名稱", "text": "最新貼文摘要", "url": "https://www.facebook.com/…" } } ] },
    "bills": { "type": "bills", "title": "法案提案排行", "unit": "件",
      "items": [ { "rank": 1, "intensity": 1, "value": 229, "value_display": "229 件", "lead_count": 61,
                   "legislator": { "…": "…" },
                   "detail": { "label": "主提案 61 件 · 最近 2026-08-28", "text": "最新議案名稱", "url": "…" } } ] }
  }
}
```

- 新聞榜的 `value` 是區間內則數；臉書榜的 `value` 是「新鮮度」（`60 − 天數`，越高越新），`raw_days` 才是天數；
  法案榜的 `value` 是本屆提案總數（含共同提案），`lead_count` 是主提案件數。
- 某一榜沒有資料時該 key 不會出現（或缺 `items`），前端要顯示空狀態。

## GET /api/v1/changes?since=2026-09-01&limit=100

```json
{
  "meta": { "...": "..." },
  "count": 3,
  "items": [
    { "id": 12, "at": "2026-09-30T08:59:55.000Z", "entity": "committee_seat", "entity_id": "11-5|內政委員會|LY-00024",
      "field": "is_convener", "old_value": "0", "new_value": "1" }
  ]
}
```

## GET /api/v1/sync-runs?limit=50

```json
{
  "meta": { "...": "..." },
  "count": 2,
  "items": [
    { "id": 2, "dataset": "id9", "status": "success", "started_at": "…", "finished_at": "…",
      "records": 113, "attempt": 1, "http_status": 200, "error": null, "duration_ms": 1840, "ua": "ly-dashboard/1.0 (+…)" }
  ]
}
```

`status`: `success` | `failed` | `skipped`（`skipped` = 內容未變更）。

---

## POST /api/v1/sync

手動觸發同步。**不會等同步跑完**（完整同步含議案／新聞約 4 分鐘），立即回 `202`，
進度請看 `/api/v1/sync-runs` 與 `/api/v1/health` 的 `last_runs`。

| 參數 | 說明 |
| --- | --- |
| `scope` | `all`（預設，名錄→議案→社群→新聞）或 `roster`（只同步名錄，約 7 秒） |

```json
{ "accepted": true, "started": true, "scope": "roster", "inflight_scope": "roster",
  "message": "同步已在背景執行", "poll": "/api/v1/sync-runs" }
```

同時只允許一個同步在跑（single-flight）；已有同步進行時 `started` 為 `false`，該請求會被合併。

## 前端使用規則

1. **不要**直接呼叫 `data.ly.gov.tw`（會被 CORS 擋、也會被 WAF 403）。一律呼叫 `/api/v1/*`。
2. 空資料要顯示明確空狀態（「此會期尚無資料」），不可顯示示範委員。
3. `meta.stale === true` 時，畫面必須顯示「資料截至 …（可能非最新）」的提示。
4. 篩選狀態放 URL query string：`?term=11&session=11-5&q=&party=&region=&committee=&convener=1`。
5. 圖表資料由 `/api/v1/committees` 的 `count` 直接算，不要在前端做全量清洗。
6. 排行榜的排序與 `intensity` 一律用 `/api/v1/rankings` 的回傳值，前端不得自行重算名次。
7. 查單一委員一律帶 `session=all`（前端封裝為 `legislatorDetailUrl()`）：名錄預設只回本會期在職者，
   而法案提案人與排行榜會出現已離職委員。
