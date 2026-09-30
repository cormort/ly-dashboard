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
  "db": { "legislators": 113, "memberships": 481, "committee_seats": 402, "changes": 37 },
  "last_runs": [
    { "dataset": "id9", "status": "success", "finished_at": "2026-09-30T08:59:55.000Z", "records": 113, "attempt": 1, "error": null }
  ]
}
```

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
      "conveners": [ { "id": "LY-00024", "name": "牛煦庭" } ] }
  ]
}
```

`kind`: `standing` | `special` | `ad_hoc`。`count` 為該會期該委員會的席次數。
委員會清單**只包含該會期真實存在的委員會**（非全歷史）。

## GET /api/v1/legislators

Query 參數（全部可選）：

| 參數 | 說明 |
| --- | --- |
| `term` | 屆次，預設 `current.term` |
| `session` | 會期 id（如 `11-5`），預設 `current.session`；`all` 表示該屆全部會期。**無效的會期 id 會回退到該屆最新會期**（回應的 `meta.session` 會是實際使用的會期） |
| `q` | 關鍵字，比對姓名／選區／委員會／黨籍 |
| `party` | 精確比對黨籍 |
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
- `is_convener` 是**該會期**的召委，不是「曾經當過」。
- 無資料時回 `items: []`、`count: 0`，**不得**回傳任何示範／假資料。

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

## 前端使用規則

1. **不要**直接呼叫 `data.ly.gov.tw`（會被 CORS 擋、也會被 WAF 403）。一律呼叫 `/api/v1/*`。
2. 空資料要顯示明確空狀態（「此會期尚無資料」），不可顯示示範委員。
3. `meta.stale === true` 時，畫面必須顯示「資料截至 …（可能非最新）」的提示。
4. 篩選狀態放 URL query string：`?term=11&session=11-5&q=&party=&committee=&convener=1`。
5. 圖表資料由 `/api/v1/committees` 的 `count` 直接算，不要在前端做全量清洗。
