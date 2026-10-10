# 臉書每日貼文更新：運維說明與實戰經驗

這份文件講「每天抓 113 位在職立委粉專最新貼文，填進整理表（或直接寫回 Google 試算表）」這件事怎麼跑、
排程的真實行為、以及這次做完踩到的坑。**範圍只含立委分頁**；議員分頁（`LY_COUNCIL_SOCIAL_CSV`）2026-10-06 起先不執行，
原因見最後一節。

相關文件：`docs/social-sheet-spec.md`（試算表格式與填寫規則，最重要）、
`docs/fb-verification-2026-10-06.md`（113 筆連結的第二輪驗證）、`scripts/fetch-fb-posts.mjs`（程式本體）。

---

## 一、一輪更新做了什麼

```
Google 試算表（立委分頁，gid 1325033898）
        │  ①  讀 CSV（LY_SOCIAL_CSV，沒設就用內建試算表網址）
        ▼
scripts/fetch-fb-posts.mjs
        │  ②  用「已登入的 Chrome 設定檔」逐頁開粉專，抓最新一則貼文
        │      → .cache/posts-YYYY-MM-DD.csv（整理表欄位格式，可直接貼回）
        │      → docs/fb-verification-YYYY-MM-DD.csv（--verify：頁面顯示名稱／追蹤者／比對結果）
        ▼
       ③  寫回試算表（兩種路徑，有設定就自動做）
              · Apps Script Web App（目前用這條）：node scripts/push-posts-to-sheet.mjs
                → POST 到 apps-script/ 部署的 Web App，只更新 F／G 兩欄
              · 服務帳號（有 service_account.json 時）：--write-sheet --key
              → 寫回成功後叫本機伺服器重新同步（只帶 scope=social：改的是整理表，
                跑「全部」要等 13 分鐘；`LY_SYNC_SCOPE=all` 可改回全部）
       ④  推一份到遠端資料分支（fb-data，見第六節）：node scripts/push-fb-data.mjs
              → posts/YYYY-MM-DD.csv ＋ posts/latest.csv（沒有變動就不 commit）
```

- 一次跑 113 位，每位間隔隨機 4–9 秒，約 **25–35 分鐘**。
- 只讀「最新一則」：取日期最大的那一則，所以置頂的舊貼文不會被當成最新。
- 抓到什麼寫什麼，**抓不到就留空**。這一條是硬規則，理由見 `docs/social-sheet-spec.md`：
  網站用「所有人最新貼文日期中最新的那一天」判斷整理表有沒有在更新，填今天會讓警示失效。

## 二、怎麼執行

```bash
# 第一次（或 FB 登入失效）時：開有畫面的瀏覽器登入一次，狀態存在設定檔裡
node scripts/fetch-fb-posts.mjs --login
#   預設設定檔：~/.ly-dashboard/fb-profile（可用 --profile 或 LY_FB_PROFILE 改）

# 每天這樣跑
node scripts/fetch-fb-posts.mjs                 # → .cache/posts-YYYY-MM-DD.csv
node scripts/fetch-fb-posts.mjs --verify        # 另外輸出 docs/fb-verification-YYYY-MM-DD.csv
node scripts/fetch-fb-posts.mjs --limit 5       # 試跑前 5 位
node scripts/fetch-fb-posts.mjs --ids 1,18,91   # 只跑指定編號
node scripts/fetch-fb-posts.mjs --headful       # 開畫面跑（被 FB 擋自動化時比較不容易失敗）

# 寫回試算表：預設走 Apps Script Web App（見第五節；url/token 在 ~/.ly-dashboard/sheet.env）
node scripts/push-posts-to-sheet.mjs .cache/posts-2026-10-06.csv
# 另一條路：服務帳號（需對試算表有「編輯者」權限）
node scripts/fetch-fb-posts.mjs --write-sheet --key service_account.json
```

前置需求：`npm i -D playwright-core`（用系統安裝的 Chrome，不會下載瀏覽器）。
需要 `playwright` 而不是 `playwright-core` 只有一個情況：你想用 Playwright 自己下載的 Chromium。

### 沒有畫面時怎麼登入：從已登入的瀏覽器匯入 cookies

`--login` 要開**有畫面**的瀏覽器，在只能遠端／無螢幕的機器上跑不到。替代做法是把任何一個
**已經登入 Facebook 的瀏覽器**的 cookies 匯進排程用的設定檔：

```bash
# 1) 從已登入 facebook.com 的瀏覽器匯出 cookies 成 JSON（ego-browser 之類有 CDP 的瀏覽器）：
#      const ck = await page.cdp('Network.getCookies', { urls: ['https://www.facebook.com'] });
#      fs.writeFileSync('/tmp/fb-cookies.json', JSON.stringify(ck.cookies));
#    瀏覽器擴充套件（Cookie-Editor／EditThisCookie）的 JSON 匯出也可以。
# 2) 匯入設定檔（會當場開一次 facebook.com 驗「腳本會不會判定為已登入」，只印筆數與名稱、不印值）
node scripts/import-fb-cookies.mjs --from /tmp/fb-cookies.json
# 3) 驗收：這一行要出現「已登入 Facebook（設定檔：…）」
node scripts/fetch-fb-posts.mjs --ids 1 --min-delay 0 --max-delay 0
```

匯入的 cookies **會留在設定檔裡**（實測：重新開一次瀏覽器仍判定已登入），所以排程照樣用得到；
登入失效時（`rec._status` 出現「登入失效」）再匯一次即可。
用完請刪掉那份 dump（等同帳號憑證）：`rm /tmp/fb-cookies.json`。

## 三、排程：現在掛在 macOS launchd

2026-10-06 起，排程改掛 **macOS LaunchAgent**（`~/Library/LaunchAgents/com.hermes.ly-dashboard-fb-daily.plist`，
每天 08:00 執行 `scripts/fb-daily.sh`；安裝腳本 `scripts/launchd/install.sh`，決策見 `DECISIONS.md` D172–D173）。
比 DSH 內建排程好在：launchd 由系統帶起，**dsh 沒開、電腦重開機後照跑**，而且不必每次都要一次
`danger-full-access` 審批。缺點是 plist 要用一次 `launchctl bootstrap` 載入（那一步得在受監督的
gateway 之外的終端做）。

```bash
scripts/launchd/install.sh            # 安裝並載入（先 bootout 再 bootstrap，才會吃到新設定）
scripts/launchd/install.sh --status   # 目前狀態與最近一次執行
scripts/launchd/install.sh --uninstall
launchctl kickstart -k "gui/$(id -u)/com.hermes.ly-dashboard-fb-daily"   # 不等時間到、立刻試跑一次
```

wrapper（`scripts/fb-daily.sh`）自己補 PATH（launchd 的 PATH 只有 `/usr/bin:/bin:/usr/sbin:/sbin`，
找不到 Homebrew 的 node）、把輸出收進 `.cache/`，並在「一列都沒抓到」時以 **exit 2** 明確失敗
（最常見原因是設定檔沒登入 Facebook）。log 在 `.cache/fb-daily.log`。

> ⚠️ **舊的 DSH 內建排程要確認有沒有還在**：先前記在 D171 與本文的「立委粉專每日更新」
> （`task-d69bbc90-60df-45bd-8cae-17353e439b26`，也是 08:00）。**本機 grep 不到這個 task 的定義**
> （`grep -rl d69bbc90 ~/.dsh` 沒有命中，可能當初是建在 Windows 那台或別的 profile），
> 所以不確定它還在不在。若在 dsh 的排程清單還看得到它，**請二選一**（刪掉或錯開時間），
> 否則 08:00 會對 Facebook 抓兩輪。下面的段落保留給還沒刪掉時參考。

### 成敗通知（Telegram）

排程跑完會送一則訊息（成功失敗都送），內容是「有日期幾列／寫回結果／資料分支／同步狀態」；
失敗那則會帶原因與可以照著做的修復指令（例如「請在有畫面的終端機跑一次 --login」）。

- 送訊息：`scripts/notify-telegram.sh "訊息"`（`--dry-run` 只印不送）。
- 憑證：`~/.ly-dashboard/notify.env`（`LY_TELEGRAM_BOT_TOKEN`、`LY_TELEGRAM_CHAT_ID`，權限 600、repo 外）。
  用的是跟 Hermes 同一個 bot，訊息會出現在你原本跟它對話的聊天室。
- 通知送不出去只記 log，**不會讓每日排程失敗**；`LY_NOTIFY=0` 可以關掉。

### DSH 內建排程的真實行為（歷史紀錄）

先前設在 **DSH 應用程式內的排程**，內容是
「每天 08:00 執行 `scripts/fetch-fb-posts.mjs --verify`，若服務帳號金鑰存在就再寫回試算表」。
（DSH 排程清單裡的任務名稱：**立委粉專每日更新**、`task-d69bbc90-60df-45bd-8cae-17353e439b26`，權限 `danger-full-access`。）

| 情境 | 會不會跑 | 說明 |
| --- | --- | --- |
| 08:00 時電腦開著、DSH 也開著 | ✅ 會 | 正常執行 |
| 08:00 時電腦關機／休眠，之後才開機並啟動 DSH | ⚠️ **會補跑一次** | DSH 下次啟動時，以「最近一次到期」的決策時間補跑 |
| 關機好幾天（DSH 都沒開） | ⚠️ 只補跑**最近一次** | 中間漏掉的那幾天**不會**逐日補 |
| 電腦開著但 DSH 沒開 | ❌ 不會 | 排程在 DSH 行程內，DSH 沒跑就沒有排程 |

補跑行為來自排程模組的設計（`@deepseek-ai/dsh-schedule` 的型別註解）：
daily 是「Resolve a daily decision near the decision's local date, **not across its missed history**」、
fixed-rate 是「advances directly past missed occurrences」——也就是**追上最近一次**，不是把漏掉的都補一遍。
（這一項是讀原始碼與型別註解得到的結論，沒有做「關機三天」的實測。）

### 如果不希望「關機就不跑」，有三個選擇

1. **維持 DSH 排程**：適合電腦早上通常開著、DSH 常駐。關機的日子會在下次開 DSH 時補跑一次。
2. **改用 Windows 工作排程器**：不管 DSH 有沒有開都會跑（只要電腦是開的），
   勾「**錯過開始時間後盡快執行**」＝開機後自動補跑。限制：
   - Chrome 要讀你已登入的設定檔，所以工作要設成「只在使用者登入時執行」（`/IT`）；
   - 電腦要醒著（睡眠要允許喚醒計時器，或用 `powercfg` 開）；
   - 指令（輸出檔名不要用 `%DATE%`，那是地區格式、會產生含 `/` 的非法檔名；用固定名稱即可）：

     ```bat
     schtasks /Create /TN "ly-dashboard-fb-daily" /SC DAILY /ST 08:05 /IT /F ^
       /TR "node C:\path\to\ly-dashboard\scripts\fetch-fb-posts.mjs --profile C:\Users\<你>\.ly-dashboard\fb-profile --verify --out C:\path\to\ly-dashboard\.cache\posts-latest.csv"
     ```
     （`--verify-out` 不給就用預設的 `docs/fb-verification-<今天>.csv`，日期由腳本自己算。）
3. **兩者並存**：Windows 排程負責「時間到一定跑」，DSH 排程負責「跑完回報／寫回試算表」。
   但同一天會抓兩次，除非把時間錯開，或改成只由其中一個驅動。

### 其他排程注意事項

- 排程執行時需要較高權限（Chromium 的具名管道在某些沙箱模式下會被擋），所以目前設成 `danger-full-access`。
- 一次跑 25–35 分鐘，**不要排在上線或備份的同一時段**；期間會持續打 Facebook（這是被限流的主因）。
- 排程跑完的結果會記在 `.cache/node_run_log.txt` 與 `docs/fb-verification-*.csv`。

### 連線層的暫時性失敗不會吃掉一整天（2026-10-10）

**症狀**：08:00 的排程 6 秒就結束，Telegram 收到「抓取腳本失敗（exit 1）」，
`fb-daily.log` 裡只有一行 `fetch failed`，當天完全沒有新資料（前一天也一樣）。

**原因**：抓取腳本的第一步是讀整理表 CSV，那一次 `fetch` 碰到
`UND_ERR_CONNECT_TIMEOUT`（Google 那一端連不上，隔幾分鐘再試就正常）。
原本一失敗就 `abort`，而 Node 的 `fetch` 失敗時 `message` 一律是 `fetch failed`，
真正的原因在 `err.cause`（`code: UND_ERR_CONNECT_TIMEOUT`）—— log 看不到，所以像無頭案。

**現在的處理（三層，都在同一次執行內完成）**：

| 位置 | 行為 | 調整用的環境變數 |
|---|---|---|
| `fb-daily.mjs` 開跑前 | 先確認整理表連得到才開始抓（連不上就一直等到連上） | `LY_FB_PROBE_ATTEMPTS`（5）、`LY_FB_PROBE_DELAY_MS`（30000） |
| `fetch-fb-posts.mjs` 讀來源 | 讀 CSV 失敗會重試，不會一次就放棄 | `LY_FB_FETCH_ATTEMPTS`（3）、`LY_FB_FETCH_DELAY_MS`（10000） |
| `fb-daily.mjs` 抓取結束 | 跑不到 90 秒就失敗且沒有產出 → 90 秒後自動重跑一次 | — |

連不上整理表時的通知會直接寫出網址與修復指令，不再誤導成「Chrome 設定檔被佔用」。

- 這三層都寫在 `scripts/social-source.mjs`（單一來源：整理表網址、`describeError`、`waitForCsv`），
  測試在 `test/social-source.test.mjs`（連線恢復／試滿失敗／回傳不是 CSV 三種情境）。
- 診斷用的一行：`grep -E "連線檢查失敗|重跑|抓取失敗" .cache/fb-daily.log`。
- 手動補跑當天：`cd ~/ly-dashboard && npm run fb-daily`（會寫回試算表、推 fb-data、觸發 social 同步）。

### 抓取成功、站上卻沒更新：觸發同步被 409 擋掉（2026-10-10）

補跑那一輪（08:21–08:55）抓取、寫回試算表、推 `fb-data` 全部成功，但 log 出現

```
本機伺服器（:8787）沒有回應，略過觸發同步；它下次同步時會讀到同一份試算表
```

而 `social_posts` 的最新日期還是兩天前 —— 站上真的沒更新。原因是**同一個時間點伺服器正在跑新聞同步**
（`[scheduler] 新聞已超過 6 小時未成功更新，開始新聞同步`），`POST /api/v1/sync` 依
「同時只允許一個同步」的原則回了 **409 `sync_in_progress`**；舊程式把任何失敗都寫成「沒有回應」就放棄，
所以看起來像伺服器掛了，其實只是排隊。

現在的 `triggerSync()`：

- 一律帶 **`force=1`**：剛寫回試算表就必須重讀，不能因為冷卻防呆（social 範圍 `cooldownMinutes: 5`）被擋。
- 把 **409 `sync_in_progress` 當成「排隊」**而不是失敗：預設每 60 秒試一次、最多 10 次
  （`LY_SYNC_TRIGGER_ATTEMPTS`／`LY_SYNC_TRIGGER_DELAY_MS`），等前面那個同步跑完就輪到它。
- HTTP 202 才算觸發成功；其他狀態碼連同回應內容寫進 log，最後仍失敗才照實回報
  （資料已經在試算表與 `fb-data`，不會不見）。
- 驗收方式：`node -e` 直接呼叫 `triggerSync` 看回傳，並確認 `social_posts` 的 `MAX(post_date)`
  是今天（本機 DB 在 `data/ly.db`）。

## 四、立委這一輪的實戰經驗（踩到的坑）

### 1. Facebook 只有「已登入的瀏覽器」看得到內容

- `curl`／`fetch`：HTTP 400，或只回登入頁；連續請求後連 400 都會一直出現（限流）。
- 未登入的瀏覽器：**多數**粉專的 `<title>` 還是會回人名，可以當第一層粗略篩選
  （失效代稱只回泛用「Facebook」）。113 筆裡 111 筆可用這招判斷。
- 但**未登入不是結論**：吳思瑤的 `taipeineedyou` 未登入時就是泛用標題，登入後才看得到
  （頁面有效、最新貼文 2026-10-05）。第一輪驗證文件把它記成「目前無法查看」就是這個原因。
- 登入之後 `document.title` 會變成「(3) Facebook」（通知數），**不能用來判斷頁面是誰的**；
  驗證模式的頁面名稱改用「未登入的 HTTP `<title>`／`og:title`」為主。

### 2. 「最新貼文日期」要用三個來源互補，並且要設防呆

| 來源 | 什麼時候用 | 陷阱 |
| --- | --- | --- |
| 頁面上帶 `aria-label` 的貼文日期 | 首選 | 留言也有日期；留言時間戳會讓舊貼文看起來像今天 |
| 貼文永久連結頁 | 首頁只給相對時間（「3天」）時 | 多一次開啟，速度慢 |
| 頁面內嵌 JSON 的 `creation_time` | 版面改到抓不到日期時的最後防線 | 可能包含置頂／分享來源的時間 |

實作上的三個決定（`scripts/fetch-fb-posts.mjs`）：

1. **排除帶 `comment_id` 的連結**：那是留言時間，不是貼文時間。這是實際踩到的坑。
2. **取兩個來源中較新的那一個**：只取 DOM 會漏（FB 有時只先渲染舊貼文），
   只取 `creation_time` 會被置頂影響。
3. **`saneDate()` 防呆**：貼文日期不可能早於 2000 年、也不可能在今天之後。
   實測就抓到過「1966年12月6日」「1956年12月16日」這種內文提到的年份被當成貼文日期。

另外：抓到頁面後**先往下捲一下再回到頂端**，FB 才會把最上面的新貼文補進 DOM。

### 3. 粉專網址的三種「看起來對、其實不對」

| 類型 | 例子 | 怎麼判斷 |
| --- | --- | --- |
| 服務處／辦公室頁 | 吳琪銘的「吳琪銘 委員服務處」（追蹤數約 1,300） | 追蹤數明顯偏少、頁面名稱帶「服務處」 |
| 競選臨時頁 | 王義川的「搶救王義川大兵」（選後就沒更新） | 名稱是競選口號、貼文停在選舉期間 |
| 後援會／粉絲頁 | 「王義川後援會」（`ChuanFans`） | 規格明寫不要用（不是本人或團隊經營） |

代稱（slug）**可以隨時改**，數值 ID 不變；維基百科／Wikidata 常常還記著舊代稱，
點進去會自動導向，**這種不算錯誤**（例如陳秀寳的 `陳秀寳-2213635748884193` 會導向 `showpowerchen`）。

### 4. 異體字與姓名

- 立法院登記姓名與粉專自用字可能不同：陳秀**寳**（官方）／陳秀**寶**（粉專顯示）——同一人，不要當成錯誤改掉。
- 族語名：粉專顯示「伍麗華｜Saidai / Reseres」、「黃仁-kin cyang」等，比對要用「包含漢名」而不是完全相等。

### 5. 填表的格式細節（會決定整份資料有沒有被讀進去）

- 日期一定要 `YYYY-MM-DD`；`2026年10月5日`、`昨天` 這種寫法**會被當成空白**，而且不會有錯誤訊息。
- 摘要**單行、60 字內**，不要換行、不要寫成新聞稿。
- 不要改姓名／選區／表頭、不要增刪列；真的要改網址，走 `server/social-overrides.json`（可逆、有 `reason` 與 `verified_at`）。

### 6. 環境本身也會咬人

- Playwright 會在系統 Temp 建 `playwright-artifacts-*`；受管環境（例如 DSH 的檔案沙箱）只允許寫專案目錄時會 EPERM。
  腳本因此把這個行程的 `TEMP`／`TMP` 指到 `.cache/tmp`（已 gitignore）。
- `git`／`curl` 走 Windows 憑證存放區時，某些沙箱模式會回 `schannel: SEC_E_NO_CREDENTIALS`；
  但 Python `requests`、Node `fetch` 不受影響（這也是驗證腳本用 HTTP 標題可行的原因之一）。
- 連續 HTTP 請求太快時，Facebook 會回 HTTP 400（頁面標題就一個「Error」）。腳本把它當限流處理：等 5 秒重試一次。

### 7. 順手查到的事實錯誤（改了程式不會修的那種）

- **許忠信**的註記「原任張啓楷」應是「**遞補李貞秀**」：張啓楷 2026-02-01 辭職 → 李貞秀遞補 →
  李貞秀 2026-04-13 被開除黨籍 → 許忠信 2026-04-22 遞補（中選會 115-04-15 公告）。
- **陳超明**黨籍：2025-09-15 已恢復中國國民黨（2024 年是以無政黨推薦身分參選當選）。
- **陳永康**：查無官方粉專（2024 年報導指他與陳雪生是全院唯二沒有粉絲團的立委；陳雪生後來有）。
  整理表的錯誤連結已在 `server/social-overrides.json` 用 `action: "deny"` 移除。

## 五、寫回試算表：Apps Script Web App

抓完之後要有人把 F／G 欄填上去。2026-10-06 前只能人工貼（另有一條服務帳號路線 `--write-sheet --key`，但要 GCP 金鑰），
之後改用 **Apps Script Web App**：不需要 GCP、不需要金鑰檔，只有一組共享 token。

- 程式在 `apps-script/`：`Code.js`（真的內容，**不進版控**，內含 token）、`Code.js.example`（範本）、`appsscript.json`（宣告 `webapp` 區塊）。
- 部署（一次就好，用 clasp）：`cd apps-script && npx @google/clasp create --type standalone --title "…" && npx @google/clasp push && npx @google/clasp deploy`。
  前置：Google 帳號要先到 <https://script.google.com/home/usersettings> 開啟 Apps Script API。
- 授權（一次就好）：**Web App 第一次被呼叫前，必須先在 Apps Script 編輯器按一次「執行」完成授權**，
  否則 `/exec` 一律回 403「存取遭拒」——`executeAs: USER_DEPLOYING` 需要使用者先同意這個指令碼的權限。
- 網址與密鑰放 `~/.ly-dashboard/sheet.env`（權限 600、repo 外）：`LY_SHEET_WEBAPP_URL=…/exec`、`LY_SHEET_TOKEN=…`
  （跟 `Code.js` 裡那組一致）。`scripts/fb-daily.sh` 會自動載入這個檔。
- 手動寫回：`node scripts/push-posts-to-sheet.mjs .cache/posts-2026-10-06.csv`（加 `--dry-run` 只預演不送出）。
  這支只送「有日期」的列；Web App 那一端也只動本來就有對應編號的列，沒抓到的列留空、不覆蓋舊值。
- Web App 會先把日期欄設成純文字格式，免得 Sheets 把 `2026-10-05` 轉成日期、匯出變成 `2026/10/5`。

**為什麼不走服務帳號**：要 GCP 專案＋金鑰檔＋把試算表分享給那個帳號，對「一個人維運的儀表板」太重；
Web App 的權限邊界反而更清楚（一組 token、只能寫那一張表的 F／G 欄、寫入端在對方帳號下執行）。

## 六、遠端資料分支：fb-data

`main` 只放程式；抓取結果（每天一份 CSV）推到 **`fb-data` 分支**，比照 `news-data` 的做法：

- `posts/YYYY-MM-DD.csv`：當天抓取的整理表格式 CSV；`posts/latest.csv`：同一份內容（遠端讀最新的抓這個就好）。
- 推的動作在 `scripts/fb-daily.sh` 收尾（`node scripts/push-fb-data.mjs "$OUT_DATED"`），
  **沒有變動就不 commit**（比對 staged 差異），所以每天跑不會長出一堆空 commit。
- 工作目錄在 `.cache/fb-data`（gitignore，不會混進主 repo）；第一次執行時若分支不存在會自己建一個。
- 失敗只記 log、不讓每日排程失敗（本機 CSV 還在）；`LY_FB_DATA_PUSH=0` 可整段關掉。
- 手動補推：`node scripts/push-fb-data.mjs .cache/posts-2026-10-06.csv`（加 `--dry-run` 只在本機預演）。

**為什麼要這一份**：遠端（GitHub）讀得到、也多一份備份；試算表那條線是給人看的、這條是給程式與備份用的。

## 七、每天／每次同步的檢查清單

- [ ] `--verify` 的 CSV 有沒有出現大量「⚠️ 拿不到頁面名稱」→ 可能是被限流，拉長 `--min-delay`
- [ ] 執行紀錄有沒有「登入失效」→ 跑一次 `--login` 重新登入
- [ ] 有日期的列數是不是和平常差不多（驟降通常是 FB 版面變動或限流）
- [ ] 有沒有明顯不合理的日期（腳本已用 `saneDate` 擋，但換版後要重新確認）
- [ ] `fb-daily.log` 有沒有「整理表連線檢查失敗」或「秒內失敗且沒有產出」→ 那是連線層的暫時性失敗，
      腳本已自動重試／重跑過；同一週出現很多次才需要查網路（見第三節的 2026-10-10 說明）
- [ ] 新抓到的網址與更正表有沒有衝突（更正表優先，且會清掉舊網址的貼文摘要）

## 八、為什麼議員分頁先不做（2026-10-06 決定）

- 議員分頁約 360 位，是立委的 3 倍多：一輪 25–35 分鐘會變成 1.5 小時以上，限流風險也跟著放大。
- 議員的粉專對照表（`scripts/council-facebook.csv`）本身還有 40 條連結是壞的（D133–D137），
  先修連結再談每日貼文比較合理。
- 立委這一輪先把「腳本、驗證方法、排程與防呆」定下來；議員分頁之後直接沿用同一支腳本，
  只要把來源 CSV 換成議員分頁（`--csv`）並確認欄位對應（`Facebook 粉專網址` 而不是 `貼文或粉專連結`）。

要恢復議員分頁的步驟：把議員分頁的 CSV 匯出網址設成 `LY_COUNCIL_SOCIAL_CSV`，
確認腳本支援議員分頁的欄位名稱後再開排程。
