# 手機可用性（RWD）規劃

> **給 Hermes**：這份計畫可以逐任務實作（每個任務獨立、可個別驗收）。**目前只規劃、尚未動任何程式。**
>
> 2026-10-07。使用者要求：「可以規劃 rwd 嗎？」→「**先要在手機上也可以使用**」。
> 下面的每一項都有**實測數字**或**可重跑的指令**，不是憑印象寫的。

**Goal：** 360–430px 寬的手機上，全部 21 條路由都能正常使用（不需要左右拖拉、主要控制項好按、內文可讀），
而且 1280px 的桌機版畫面不會變差。

**Architecture：** 只在既有的 `web/src/styles.css`（全域樣式）與少數元件的結構上做調整，
不引入 CSS 框架、不改資料層、不改 API。必要時把「一個元素撐壞 20 條路由」這類問題變成可重跑的自動檢查。

**Tech Stack：** React 19 ＋ Vite 8 ＋ 手寫 CSS（CSS 變數、media query 目前有 12 條）；
檢查腳本用 repo 已經有的 `playwright-core`（跟每日粉專抓取同一套、用系統 Chrome，**不新增依賴**）。

---

## 0. 執行進度（2026-10-07 第一輪，已完成 T1／T4／T8 與 T2、T5 的一部分）

先做「不犧牲功能」的那一半：把手機上真正會壞掉的東西修掉，UI 結構不動。

| 項目 | 狀態 | 實測 |
| --- | --- | --- |
| **T1 頁首控制列溢出** | ✅ 已修 | 390px：19 條路由溢出 231px → **0**；768px：**0** |
| **T4 長字串撐寬** | ✅ 已修 | `/legislators` 的 830px SHA 區塊：`.log > div{min-width:0}` ＋ `overflow-wrap:anywhere` → 0 |
| **T3 表格撐寬** | ✅ 查清後發現**本來就已經是捲動容器** | 實測 `/council`、`/counties` 的表格父層 `.table-wrap`／`.table-scroll` 寬度正確（324／290px）。真正撐寬整頁的是 `.segmented` 分段選單與包住它的 `.council-switches`（實測 512px）→ 已修 |
| **T2 手機頁首高度** | ✅ 完成 | 手機 390px：**區網模式 103px**（同步控制依 `f3f6240` 隱藏）、**本機 149px**（看得到同步控制）。做法：狀態列與品牌同列、狀態鈕改相對時間、同步範圍選單縮到 15ch、字級控制隱藏、**搜尋框收成一顆圖示（點開才出現、自動聚焦）** |
| **T12 平板頁首** | ✅ 完成（頁首部分） | 761–1100px 只留兩列：搜尋框不再獨占一列、頁首間距 20→12px、導覽連結左右各收 3px。768px：**191 → 109–111px**；1024px：146 → 100–109px |
| **T10 表格／卡片切換** | ✅ 查證後發現**本來就有了** | 委員頁的「卡片／列表」切換（`LegislatorGrid` ＋ localStorage preference `directory-mode`，預設卡片）——使用者在 390px 看到的正是它。所以規劃時提的「URL 參數 `view=cards`」不必做 |
| **T6 圖表／地圖** | 🔶 只是「能看」 | 390px 實測：地圖會畫、不溢出，但整個台灣地圖縮到約 330px 寬，縣市標籤偏小；沒動它（要更好的話得做縮放或表格替代） |
| **T11 PWA** | ✅ 已做 | Service Worker 只在安全來源註冊；Tailscale 裝好、`tailscale serve` 起來後就有 HTTPS（`https://mac-mini.tail1ac930.ts.net/`，**tailnet only**：手機的 Tailscale 沒開就連不上，這是預期行為）。驗收用 `npm run verify:pwa` |
| **T5 觸控目標** | ✅ 主要控制項已補 | 手機的主要控制項（chips／分段鈕／圖示鈕／導覽）加 `min-height: 40px`，表格列內連結不在此限；**2026-10-09 再補**：席次圖圖例鈕 38 → 44px，並把「圖例 ≥44px」變成 `check:rwd` 的失敗條件（見 D274） |
| **T8 自動檢查** | ✅ 已做 | `scripts/check-rwd.mjs`、`npm run check:rwd`、`test/check-rwd.test.mjs`（純函式 5 條）；**現在 390／768 全綠**，量測項：橫向溢出、選取頁籤文字垂直置中、席次圖圖例觸控高度 ≥44px |

**已改的檔案：** `web/src/styles.css`（新增一個 ≤760 的區塊）、`web/src/components/Header.tsx`（狀態鈕的長／短日期）、
`web/scripts/render-smoke.ts`（狀態鈕的斷言改成驗兩種寫法）、新增 `scripts/check-rwd.mjs`、`test/check-rwd.test.mjs`、`package.json`（`check:rwd`）。

**五個寬度的完整量測（2026-10-07，`npm run check:rwd -- --widths 360,390,768,1024,1280`）：**

| 寬度 | 橫向溢出 | 頁首（區網模式：手機實況） | 頁首（本機：看得到同步控制） |
| --- | --- | --- | --- |
| 360（最小手機） | 0（21 條路由全部） | 103px | 149px |
| 390（主流手機） | 0 | 103px | 149px |
| 768（平板） | 0 | 109–111px | 154px |
| 1024（平板／小筆電） | 0 | 100–109px | 109px |
| 1280（桌機） | 0 | 100–106px | 100–106px |

（區網模式＝`LY_HOST=0.0.0.0`，依 `f3f6240` 會隱藏同步範圍與更新鈕 —— 手機就是走這條。本機＝`127.0.0.1`。）

**105 個「寬度 × 路由」組合全部沒有橫向捲動。** 手機端的卡片、圖表、粉專牆與 Facebook 嵌入框另外用截圖看過：
粉專牆在 390px 是單欄、嵌入框 323px 塞得進 358px 的卡片（沒有破版）。
768／1024 的頁首偏高（147–197px）是 T12 要處理的：那兩個寬度目前還套著手機的規則（例如搜尋框自己占一列）。

**驗收：** `npm --prefix web run test` 181 項全過、`npm run check:rwd` 全綠、`npm --prefix web run build` 成功。

---

## 0.5 前置條件：手機要**連得到**這台 Mac Mini（不做這步，RWD 做完也看不到）

實測現況：伺服器是 `node server/index.mjs` **綁在 `127.0.0.1:8787`**（`LY_HOST` 沒有設，預設 loopback），
所以**同一台 Wi-Fi 上的手機也連不進來**，而且這台機器沒有裝 Tailscale／cloudflared／caddy／nginx（今天查過）。
區網位址是 `192.168.0.197`。

| 做法 | 需要什麼 | 手機體驗 | 能不能做 PWA |
| --- | --- | --- | --- |
| **Tailscale Serve（建議）** | Mac Mini 與手機都裝 Tailscale（裝 App 要使用者輸入管理者密碼）＋管理後台開 MagicDNS 與 HTTPS 憑證 | 任何網路都連得到，`https://<機器>.<tailnet>.ts.net` | **可以**（有 HTTPS） |
| Cloudflare Tunnel ＋ Access | Cloudflare 帳號 ＋ **一個網域**；`brew install cloudflared` 不用 sudo | 任何瀏覽器，email OTP | 可以（有 HTTPS） |
| 只開區網（`LY_HOST=0.0.0.0`） | 什麼都不用裝 | **只在家裡 Wi-Fi**，`http://192.168.0.197:8787` | **不行**（Service Worker 需要安全來源；iOS 也一樣） |
| GitHub Pages | 不用，但這是伺服器端應用（SQLite＋API），靜態託管跑不起來 | — | — |

**建議：Tailscale Serve。** 理由是隱私（不對外開放）、有 HTTPS（PWA 才能用）、而且出門在外也連得到。
只開區網那條可以當「今天先試看看」的臨時做法，但要知道 PWA 的部分在沒有 HTTPS 時不會生效。

**驗收：** 手機瀏覽器打開那個網址看得到總覽頁；`lsof -nP -iTCP:8787 -sTCP:LISTEN` 仍顯示綁在 127.0.0.1（服務本身不對外）。

---

## 1. 驗收標準（可量測，不是形容詞）

**目標裝置（2026-10-07 使用者決定）：**

- **手機 360–430px：必須可用**（主要目標）。
- **320px：不爆版即可**（best effort，不列為驗收門檻）——**見 §7 的建議**。
- **平板 768–1024：另做一版**（現在多半被 760/900/860 的規則壓成單欄，看起來鬆散）。
- **桌機 ≥1024：維持現在的樣子**。

在 headless Chrome、DPR 3、`mobile=true` 下量：

1. **390px 與 768px：每一條路由 `document.documentElement.scrollWidth === clientWidth`**（＝沒有橫向捲動）。
2. **390px：頁首高度 ≤ 128px**（現在多數路由 220px）。
3. **主要控制項觸控高度 ≥ 40px**（導覽、chips、select、icon button、字級控制）。
4. 表格在 390px **不再撐寬整個頁面**：改成容器內橫向捲動（或卡片化）。
5. **1280px 的畫面與現在一致**（截圖比對，不能為了手機把桌機弄差）。
6. 既有測試維持全綠：`npm test`、`npm --prefix web run test`、`npm --prefix web run build`。

---

## 2. 現況實測（2026-10-07，390×844、DPR 3、`clientWidth=390`）

| 路由 | 橫向溢出 | 主要兇手 |
| --- | --- | --- |
| `/`、`/my`、`/activity`、`/budget`、`/committees`、`/bills`、`/rankings`、`/compare`、`/facebook/wall`、`/facebook/council`、`/officials`、`/news`、`/news/all`、`/news/agencies`、`/funds`、`/foundations`、`/administrative` | **231px** | 同一個：`div.header-status`（605px、`white-space: nowrap`） |
| `/legislators` | **231px** | 上面的 header ＋ 一個 **830px** 寬的 `<code>`/`<small>` 區塊（變更紀錄 `.log-list`，外層 290px、內容 848px） |
| `/council` | **231px** | header ＋ `table.roster` 642px |
| `/counties` | **231px** | header ＋ `thead/tr` 501px（縣市頁的表） |
| `/agencies` | 0px（該次量測） | 只有一顆 116px `nowrap` 按鈕（影響小） |

其他量測值：

- **頁首高度**：多數路由 **220px**（844px 高的螢幕被吃掉 26%）、`/budget` 與 `/committees` 170px。
  結構是：品牌列 ＋ 兩列主導覽 ＋ 搜尋框 ＋ 狀態列（`.sync-pill`、字級控制、同步進度、同步範圍 `<select>` 210px、更新鈕）。
- **觸控目標 <32px 高的元素**：`/` 有 48 個（`A−`、`100%`、`A+`、chips、品牌連結、狀態 pill）、`/legislators` 237 個（多為表格列連結與 chips）。
- **已經做對的**：`<meta name="viewport" content="width=device-width, initial-scale=1.0">`；
  12 條 media query（1100／900／860／760）已把 `.home`／`.board-grid`／`.dash-grid`／`.region-grid`／`.hemicycle`／`.party-legend`／
  `.compare`（容器捲動）／`.county-table`（容器捲動）／`.town-layout` 等收成單欄；
  `header nav` 在 ≤760 已可橫向捲動、`.subnav` 也是。

**結論：這不是「完全沒做 RWD」，而是「差最後一哩」——但那一哩（`div.header-status`）同時弄壞了 20 條路由。**

### 重跑這段量測

```bash
# 需要本機伺服器已在 :8787（scripts/ly-dashboard-server.sh）
# 這支腳本會在 T8 正式寫成 scripts/check-rwd.mjs；先手動跑的話放在 .cache/tmp/ 即可
node .cache/tmp/rwd-audit.mjs   # 逐路由印出 scrollWidth-clientWidth 與前三大溢出元素
```

（T8 會把它變成 `npm run check:rwd`，任何一條路由溢出就 exit 1。）

---

## 3. 分階段任務

### T1（最高槓桿，約半天）修 `.header-status` 的溢出 —— 一次解掉 20 條路由

**檔案：** `web/src/styles.css`（`@media (max-width: 760px)` 區塊內）

**做法：**

```css
@media (max-width: 760px) {
  /* 控制列在手機要能換行；nowrap 是為了桌機的單列排版 */
  .header-status { flex-wrap: wrap; white-space: normal; row-gap: 6px; }
  .header-status .sync-pill { font-size: var(--fs-sm); }
  .sync-scope select { max-width: 11ch; }
  .sync-progress:empty { display: none; }
  .sync-progress { flex-basis: 100%; min-width: 0; }
}
```

**驗收：** `/`、`/legislators`、`/council` 在 390px 的溢出自 231px → **0**。
**風險：** `.header-status` 的 `nowrap` 是桌機控制列不換行用的 → 只能在 media query 裡改，改完在 1280px 看一次。

### T2（約半天）手機版頁首：220px → ≤128px

**檔案：** `web/src/components/Header.tsx`（結構）、`web/src/styles.css`

**做法：** 手機版頁首只留四件事：品牌 ＋ **一列可橫向捲動的主導覽**（已支援）＋ 搜尋框（收合成一行）＋ 狀態 pill。
把「同步進度／同步範圍」的內容收進既有的同步面板（`#sync-panel`，點狀態 pill 展開）——
手機上不需要在頁首同時攤開這些控制項。

**驗收：** 390px 頁首高度 ≤128px；10 個導覽群組都點得到；狀態 pill 仍能展開同步面板與範圍選單。
**風險：** `web/scripts/render-smoke.ts` 有「上層導覽順序」「單頁群組不顯示次級導覽」等斷言 → **先讀斷言再改結構**，改完要跟著更新。

### T3（約半天）表格不再撐寬

**檔案：** `web/src/pages/CouncilPage.tsx`、`web/src/pages/CountiesPage.tsx`（或對應元件）、`web/src/styles.css`

**做法（先做便宜版）：** 把表格包進 `.table-scroll { overflow-x: auto; -webkit-overflow-scrolling: touch; max-width: 100% }`，
並在表格上方加一行「← 左右滑動看全部欄位」的提示（僅手機顯示）。
**（較好讀、較貴的版本）：** ≤760 把 `table.roster` 改成一列一張卡片（政黨／席次／席次率／得票數各一列）。

**驗收：** 390px 溢出 0；表格內容仍看得到（容器內捲動或卡片）。
**風險：** 動 DOM 結構會弄紅既有斷言（`.roster` 相關）→ 一起更新；卡片化會增加 CSS 複雜度，先用捲動版。

### T4（約 1 小時）長字串不撐寬

**檔案：** `web/src/styles.css`

**做法：**

```css
.log-list, .log-list code, .news-item, .summary { overflow-wrap: anywhere; word-break: break-word; }
.log-list { overflow-x: auto; max-width: 100%; }
```

**驗收：** `/legislators` 溢出 0（那個 830px 的 `<code>` 區塊）。

### T5（約半天）觸控目標與最小字級

**檔案：** `web/src/styles.css`

**做法：** ≤760 時 `.chip`、`.filters button`、`.icon-button`、`.subnav a`、字級控制鈕 → `min-height: 40px`；
`--fs-2xs` 在手機提到 ≥11px（現在有些標籤是 10px 級）。表格列內的連結不必逐一放大。

**驗收：** T8 的腳本列出「主要控制項中高度 <40px」的數量 = 0。

### T6（約半天）圖表與地圖的手機版

**檔案：** `web/src/styles.css`（必要時 `ChoroplethMap.tsx`／`TownMap.tsx` 的屬性）

**做法：** ≤760 給 `svg` 類圖表 `width: 100%; max-height: 60vh`；`.stat-map svg` 已有 `52vh`；
檢查 390px 下 hemicycle（113 席）與縣市圖上的文字是否還讀得到，讀不到就手機版只顯示縣市層級、鄉鎮層級先不畫。

**驗收：** 截圖檢查 `/`、`/legislators`、`/counties`、`/compare` 的圖表沒有被裁切、沒有橫向溢出。

### T7（約半天）粉專牆與 Facebook 嵌入框

**檔案：** `web/src/components/FacebookEmbed.tsx`、`web/src/styles.css`

**做法：** 嵌入框的 `width` 由固定 `500` 改成 `100%`（Facebook plugin 允許 180–500，超過會被截）；
≤760 時牆面 1 欄（現在 `columns: 3 300px` 在 390px 應為 1 欄，**要實測確認**）；
`.fb-embed-slot` 的預留高度 520px 在手機偏長 → 手機 420px（仍要預留，瀑布流才不會跳）。

**驗收：** 390px 牆面 1 欄、嵌入框不溢出、仍然是「捲進畫面才載入」（既有斷言要留）。

### T8（約半天，**強烈建議**）把「手機不溢出」變成可重跑的自動檢查

**檔案：** 新增 `scripts/check-rwd.mjs`、`package.json`（`"check:rwd"`）、`README.md`

**做法：** 用 `playwright-core` ＋ 系統 Chrome 開本機 `:8787`，對全部路由在 **390／768** 量
`document.documentElement.scrollWidth - clientWidth`，列出溢出元素、把截圖寫到 `.cache/rwd-shots/`（已 gitignore），
任一溢出即 `exit 1`。核心量測（今天就是用這段驗的）：

```js
const audit = `(() => { const cw = document.documentElement.clientWidth;
  const over = [...document.querySelectorAll('body *')]
    .filter((el) => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el);
      return r.width > 0 && r.right > cw + 2 && s.position !== 'fixed'; })
    .map((el) => ({ sel: el.tagName + '.' + (el.className || '').toString().trim().split(/\\s+/).slice(0,2).join('.'),
      w: Math.round(el.getBoundingClientRect().width) }))
    .sort((a, b) => b.w - a.w).slice(0, 3);
  return JSON.stringify({ overflowPx: document.documentElement.scrollWidth - cw, top: over }); })()`;
```

**驗收：** 現在跑會紅（20 條路由溢出 231px）；T1–T4 做完要全綠。
**為什麼值得：** 「一個元素把 20 條路由全部弄壞」這種問題，沒有自動檢查一定會再發生 —— 今天就是這樣。

### T10（約半天～1 天，使用者要求）表格雙模式：卡片／表格可以切換

**使用者原話：**「兩個都要，然後切換」。

**檔案：** `web/src/pages/CouncilPage.tsx`、`CountiesPage.tsx`（及對應表格元件）、`web/src/styles.css`、`web/scripts/render-smoke.ts`

**做法：**
- 用專案既有的 URL 參數模式（`useParam`）加一個 `view=cards|table`（先例：粉專牆的 `view=all`、預算頁的合併／範圍開關）。
- **預設值依寬度決定、不寫死在 CSS**：`≤760` 預設 `cards`、`>760` 預設 `table`；
  使用者切過就以網址上的值為準（可分享、可加書籤、重整不會跳回預設）。
- 兩個模式共用同一份資料與同一組欄位定義（**不要各寫一份**，否則欄位會走鐘）；
  切換器用既有的 `.segmented` 樣式，並顯示「卡片／表格」而不是隻有意義不明的圖示。
- 卡片模式＝一列一張卡（欄名在前、值在後，手機可讀）；表格模式＝`.table-scroll` 容器內橫向捲動。

**驗收：** 390px 兩種模式都不溢出；768px 以上預設是表格；切換後重整仍停在同一個模式；
`render-smoke` 補三條斷言（預設模式、切換後標記正確、兩種模式都畫得出同一批資料）。
**成本／代價：** ＋0.5～1 天；那兩張表的 CSS 與測試面積會變成兩倍（要一起維護兩個模式）。

### T11（約 1 天，使用者要求）PWA：加到主畫面

**檔案：** 新增 `web/public/manifest.webmanifest`（或 `web/public/` 既有目錄）、`web/src/sw.ts`（或 `web/public/sw.js`）、
`web/index.html`（`<link rel="manifest">`、`theme-color`）、圖示檔、`server/index.mjs`（靜態檔與 `sw.js` 的 MIME／快取標頭）

**做法：**
- manifest：`name`／`short_name`／`start_url: '/'`／`display: 'standalone'`／`theme_color`／`background_color`／
  `icons`（192、512、maskable 各一份；用現有的 🐴 與站名做一組）。
- Service Worker：**只快取靜態資源（app shell：HTML／JS／CSS／字型／圖示）**，採 stale-while-revalidate。
  **絕對不快取 `/api/v1/*`** —— 這個站的內容是每天更新的資料，快取 API 回應會讓人看到過期的數字而不自知；
  離線時顯示「目前離線，資料需連線取得」而不是拿舊資料假裝是最新。
- iOS 需要在 `<head>` 補 `apple-mobile-web-app-capable`／`apple-touch-icon`，否則「加到主畫面」不會全螢幕。

**前置：** **必須有 HTTPS**（見 §0.5）——Service Worker 只在安全來源下註冊；
用 `http://192.168.0.197:8787` 直接開的話，這一項等於沒做（圖示可以加，但離線快取不會生效）。
**驗收：** 手機加到主畫面後以 standalone 開啟；關掉網路仍看得到介面外框與「離線」提示；
`/api/` 請求不會被快取（重新整理後數字會更新）。

### T12（約 0.5～1 天，使用者要求）平板 768–1024 另做一版

**檔案：** `web/src/styles.css`

**做法：** 把「手機」與「平板」分開，不要讓 760 的規則一路管到 1024：

- `≤760`（手機，最多 430）：單欄、頁首收合、表格預設卡片。
- `761–1023`（平板）：**回到兩欄**（`.dash-grid`／`.region-grid`／`.wall` 兩欄、`.budget-layout` 與 `.county-layout` 兩欄），
  主導覽維持單列（768 塞得下 10 個群組，但要實測；塞不下就讓它橫向捲動）。
- `≥1024`：維持現在的樣子。

**驗收：** 768 與 1024 各截一輪圖，確認沒有「一大片空白＋全部擠成一欄」；兩個斷點都無橫向溢出。

### T9（約半天）四種寬度驗收與收尾

**做法：** 360／390／768／1280 四種寬度逐頁截圖檢查；三個測試指令全過；
`DECISIONS.md` 加一列（決策／做法／理由）；若有結構改動，`web/scripts/render-smoke.ts` 的斷言一起更新。

---

## 4. 檔案清單

| 檔案 | 動什麼 |
| --- | --- |
| `web/src/styles.css` | 主要戰場：media query 內的頁首、表格、長字串、觸控目標、圖表 |
| `web/src/components/Header.tsx` | T2：手機版頁首收合（把同步控制收進面板） |
| `web/src/pages/CouncilPage.tsx`、`CountiesPage.tsx` | T3：表格捲動容器或卡片化 |
| `web/src/components/FacebookEmbed.tsx` | T7：嵌入框寬度 |
| `scripts/check-rwd.mjs`（新）、`package.json`、`README.md` | T8：自動檢查 |
| `web/scripts/render-smoke.ts` | T2／T3 若動結構，斷言要跟著改 |
| `DECISIONS.md` | T9：決策記錄 |

**不會動：** 資料層（`server/`）、API、排程、抓取腳本、資料庫。

---

## 5. 成本

| 階段 | 內容 | 估計 |
| --- | --- | --- |
| §0.5 | **手機連線前置**（Tailscale Serve 設定；裝 App 是使用者的動作） | **0.5 天** |
| T1–T4 | 讓 21 條路由在手機上「可用」（不橫向捲動、頁首不占掉 1/4 螢幕、表格不撐寬） | **1 天** |
| T5–T7 | 好按、圖表可讀、粉專牆與嵌入框 | **1 天** |
| T8–T9 | 自動檢查 ＋ 四種寬度驗收與收尾 | **1 天** |
| T10 | 表格雙模式（卡片／表格可切換） | **0.5–1 天** |
| T11 | PWA（**必須先有 HTTPS**，見 §0.5） | **1 天** |
| T12 | 平板 768–1024 另做一版 | **0.5–1 天** |
| 合計 | | **約 5–6.5 天** |

**最小可用範圍**：§0.5 ＋ T1–T4 ＋ T8（約 **2 天**）＝ 手機上真的能開、能讀委員資料、不橫向拖拉。
T10／T11／T12 是使用者額外要求的加值項，可以之後再排。

---

## 6. 風險與取捨

- **全域 CSS 會影響桌機**：每個任務改完都要在 1280px 看一次（截圖比對），不能只驗手機。
- **既有前端測試有結構斷言**（`web/scripts/render-smoke.ts` 共 180 條）：動 `Header.tsx` 或表格 DOM 前先讀斷言，
  改完要紅轉綠，或明講「為什麼這個斷言要改」（不要為了讓測試過而退回舊行為）。
- **卡片化 vs 容器內捲動**：捲動版快、桌機不變；卡片版好讀但要動 DOM 與測試。建議先捲動版。
- **觸控目標變大讓頁面變長**：手機捲動成本要跟誤觸成本取捨（先只放大主要控制項）。
- **手機上的功能取捨**：有些桌機才合理的頁面（例如 113 席半圓圖、鄉鎮層級地圖）在手機上可能不值得完整呈現，
  這時「手機只給摘要＋連結」比硬塞好。

---

## 7. 已決定（2026-10-07，使用者回答）與剩下的問題

| # | 問題 | 決定 |
| --- | --- | --- |
| 1 | 手機上最常做什麼 | **委員**（委員查詢／委員檔案為主）→ 手機版優先照顧委員名錄與檔案頁；首頁可以之後再談 |
| 2 | 表格要捲動還是卡片 | **兩個都要，可以切換**（→ T10；預設值依寬度、選擇記在網址） |
| 3 | 最小寬度 360 還是 320 | **建議 360 為門檻，320 只要「不爆版」**（見下面說明） |
| 4 | 要不要 PWA | **要**（→ T11；前置是 HTTPS，見 §0.5） |
| 5 | 平板 768–1024 | **要另做一版**（→ T12） |

### 關於第 3 題（最小寬度）的建議：**360 當門檻，320 只求不爆版**

- **360** 涵蓋現在幾乎所有在用的 Android 與 iPhone（iPhone SE 2/3 是 375、iPhone 12 以後是 390、Android 主流 360–412）。
- **320** 只剩少數 2016 年前後的小手機（iPhone SE 第 1 代、舊 Android）。要為它硬撐，代價是
  主導覽、粉專牆、表格都要再讓一步（例如強制縮字或砍欄位），而**換來的使用者數幾乎是零**。
- 所以建議：設計與驗收以 360 為準；320 的驗收標準只要求「不橫向溢出、不出現重疊破版」，
  不要求好按好看。這樣可以不犧牲 360–430 的體驗。

### 還剩下的問題

1. **Tailscale 要裝嗎？**（§0.5 的建議做法）沒裝的話手機只能用「只在家裡 Wi-Fi」那條，而且 PWA 不會生效。
2. 圖示要用什麼？（PWA 需要 192／512／maskable 各一份；可以沿用 🐴 與站名做一組）
3. 平板 768–1024 的粉專牆要兩欄還是三欄？（現在 `<600` 是一欄；平板兩欄通常最好讀）

