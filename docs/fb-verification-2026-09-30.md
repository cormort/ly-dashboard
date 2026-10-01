# 委員臉書專頁正確性驗證（2026-09-30）

用**已登入的瀏覽器**逐頁開啟 113 位在職委員的粉專網址，讀取頁面實際顯示的名稱、追蹤者數與內容狀態，
再與立法院委員姓名比對。這一份是「資料本身」的驗證，不是程式測試。

## 結果總覽

| 結果 | 筆數 | 說明 |
| --- | --- | --- |
| ✅ 名稱相符 | 96 | 頁面顯示名稱與委員姓名一致（含族語名與異體字） |
| ❌ 指向其他實體 | 8 | 網址連到政黨／媒體／醫院／他人的頁面 |
| ⚠️ 目前無法查看 | 7 | FB 回「目前無法查看此內容」；www／m／about／photos 四種網址結果相同 |
| ⚠️ 個人檔案／名稱待確認 | 2 | 連到個人檔案而非粉專，或名稱不符 |

覆蓋率：113／113 位在職委員都有對應列（無缺漏）；**重複網址 0 筆**、全部為 https 且為 facebook.com 網域、
沒有 profile.php 形式的個人檔案網址。

## ✅ 已修正（2026-09-30，使用者提供正確網址）

以下 9 筆已用使用者提供的網址更正，並寫入版本控管的更正表 `server/social-overrides.json`
（同步時覆蓋整理表；`social_accounts.source = 'override'` 可辨識）。每一筆都用已登入的瀏覽器開過、
確認頁面顯示名稱與委員相符：

| 委員 | 更正後網址 | 頁面顯示 | 追蹤者 |
| --- | --- | --- | --- |
| 蔡其昌 | `facebook.com/tsaimimi0416/` | 蔡其昌 | 35 萬 |
| 陳秀寳 | `facebook.com/showpowerchen/` | 陳秀寶（異體字） | 2.2 萬 |
| 許忠信 | `facebook.com/hsuchunghsin/` | 許忠信 | 1.9 萬 |
| 劉書彬 | `facebook.com/p/劉書彬-61570373315266/` | 劉書彬 | 5,447 |
| 牛煦庭 | `facebook.com/18NIUstart/` | 牛煦庭 | 5.4 萬 |
| 張嘉郡 | `facebook.com/Sweet.Yunlin/` | 張嘉郡 | 10 萬 |
| 蘇清泉 | `facebook.com/ptdrsu/` | 蘇清泉 | 5.8 萬 |
| 林宜瑾 | `facebook.com/ichin0825/` | 林宜瑾 | 4.7 萬 |
| 陳雪生 | `facebook.com/p/陳雪生-100002730369711/` | 陳雪生 | — |

更正時會**清空 `latest_post_date`／`latest_post_summary`**：那筆貼文摘要屬於舊（錯誤）網址，
留著等於顯示別人粉專的貼文。等整理表更新這 9 筆的貼文欄位後會自動補回。

### 第二批修正（7 筆「目前無法查看」）

| 委員 | 更正後 | 頁面顯示 | 追蹤者 |
| --- | --- | --- | --- |
| 吳思瑤 | **Threads** `threads.com/@wusuyao541` | 吳思瑤（@wusuyao541） | 13 萬 |
| 翁曉玲 | `facebook.com/p/翁曉玲-Hsiao-Ling-Weng-61555223878555/` | 翁曉玲 Hsiao-Ling Weng | 2.8 萬 |
| 莊瑞雄 | `facebook.com/dpp.ptbear/` | 莊瑞雄 | 7.3 萬 |
| 邱若華 | `facebook.com/Tai.Chill2022/` | 邱若華 | 3 萬 |
| 顏寬恒 | `facebook.com/kuanheng99/` | 顏寬恒 | 16 萬 |
| 馬文君 | `facebook.com/mawenchun/` | 馬文君 | 1.6 萬 |
| 黃秀芳 | `facebook.com/smilefangfang/` | 黃秀芳 | 4 萬 |

吳思瑤是 **Threads**（不是臉書）：更正表新增 `platform` 與 `action` 兩個欄位，
`action: "add"` 表示「新增一個平台」而不是覆蓋既有列，所以她的臉書列（`taipeineedyou`，目前無法查看）**保留不動**，
委員檔案會同時顯示「臉書：…」與「Threads：…」。要不要移除那條無法查看的臉書連結，等你決定。

### 尚未處理

- **陳永康**：原網址是中國國民黨 KMT 粉專，兩批都沒有提供替代網址。

### 更正表現況

`server/social-overrides.json` 共 **16 筆**（15 筆 facebook ＋ 1 筆 threads），
每筆都有 `reason` 與 `verified_at`；同步時套用，`social_accounts.source = 'override'` 可辨識。
帳號總數 113 → **114**（113 位 facebook ＋ 吳思瑤的 threads）。

## ❌ 原始判定：指向其他實體（已於上表修正）

| 委員 | 表單頁名 | 頁面實際顯示 | 網址 |
| --- | --- | --- | --- |
| 劉書彬 | 劉書彬 | 台灣民眾黨（政黨粉專，27 萬追蹤） | `https://www.facebook.com/TPPfanpage/` |
| 張嘉郡 | 張嘉郡 | 雲林新聞網（媒體粉專，9 萬追蹤） | `https://www.facebook.com/YunLinynn20ch/` |
| 林宜瑾 | 林宜瑾 | 「林時」個人檔案（222 追蹤，數位創作者） | `https://www.facebook.com/100070964465267/` |
| 牛煦庭 | 牛煦庭 | 國民黨青年團（政治組織專頁，6.2 萬追蹤） | `https://www.facebook.com/kyoung.tw/` |
| 蘇清泉 | 蘇清泉 | 安泰醫療社團法人安泰醫院（醫院專頁，5,446 追蹤；他是創辦人但非委員粉專） | `https://www.facebook.com/tsmh.antai/` |
| 許忠信 | 許忠信 | 民視新聞（媒體粉專，159 萬追蹤） | `https://www.facebook.com/FTVNews53/` |
| 陳永康 | 陳永康 | 中國國民黨 KMT（政黨粉專，64 萬追蹤） | `https://www.facebook.com/mykmt/` |
| 陳雪生 | 陳雪生 | Balaram Harijan 個人檔案（頁面 ID 已指向他人） | `https://www.facebook.com/p/%E9%99%B3%E9%9B%AA%E7%94%9F-100063745266187/` |

## ⚠️ 目前無法查看（需人工確認粉專是否還在）

- **吳思瑤**：`https://www.facebook.com/taipeineedyou`（表單頁名「吳思瑤」）
- **翁曉玲**：`https://www.facebook.com/HsiaoLingWeng.tw/`（表單頁名「翁曉玲」）
- **莊瑞雄**：`https://www.facebook.com/chuang500/`（表單頁名「莊瑞雄」）
- **邱若華**：`https://www.facebook.com/chiujohua/`（表單頁名「邱若華」）
- **顏寬恒**：`https://www.facebook.com/yenkuanheng/`（表單頁名「顏寬恒」）
- **馬文君**：`https://www.facebook.com/nantou.go/`（表單頁名「馬文君」）
- **黃秀芳**：`https://www.facebook.com/HuangShiouFang/`（表單頁名「黃秀芳」）

## ⚠️ 個人檔案／名稱待確認

- **蔡其昌**：`https://www.facebook.com/tsaichihchang/` → 個人檔案顯示「蔡璋」（slug tsaichihchang 為其羅馬拼音，但非粉專、名稱不符）
- **陳秀寳**：`https://www.facebook.com/hsiupao.chen/` → 個人檔案顯示「陳秀寶」（寳／寶 異體字，同一人；但這是個人檔案不是粉專）

## 驗證方法（可重現）

1. 從資料庫取出 113 筆社群帳號（來源：委員社群帳號整理表 CSV → `social_accounts`）。
2. 用 ego-browser（使用者已登入的瀏覽器）逐一開啟每個網址，等待標題由 `Facebook` 變成實際頁面名稱（最多 12 秒），
   讀取 `document.title`、`og:title`、`h1`、追蹤者數與內容狀態。
3. 以「頁面顯示名稱是否包含委員漢名（或表單頁名）」判定相符；不符者再逐頁人工複核第二次（含 m.facebook.com、
   /about、/photos 三種變體）。
4. 純 curl 不可行：Facebook 對非瀏覽器請求一律回 **HTTP 400**（實測三個網址皆 400），必須用真實瀏覽器。

## 對產品的影響

委員檔案的「社群」區塊與排行榜的「臉書發文排行」都直接連到這些網址，
因此 ❌ 的 8 筆等於**使用者點進去會到錯的粉專**（例如點「陳永康」會到中國國民黨粉專）。
修正方式有兩種：

1. **修資料**：更新整理表的網址欄（來源修正，最乾淨）。
2. **加防線**：在 `normalizeSocial` 增加「網址不可與其他委員重複」與「頁面名稱需在事後抽查」的檢查，
   並在 `social_accounts` 加上 `reviewed_at`／`review_note` 欄位，讓這份驗證結果能留在系統裡。

完整逐筆結果：`docs/fb-verification-2026-09-30.csv`
