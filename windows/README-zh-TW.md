# 立委觀測站在 Windows 上跑（部署說明）

這一頁是給「在 Windows 上跑整套（ingestion + API + 前端）」用的。
如果你只是要「在 Windows 看得到網站」，其實不必部署 —— 用瀏覽器連 macOS 那台就好了（見最下面）。

程式碼本身**不需要改**：後端是零 runtime 相依的純 Node（SQLite 用內建 `node:sqlite`、ZIP 用內建 `zlib`），
前端是 Vite 產出的靜態檔；要處理的只有「排程」與「啟動腳本」這兩層作業系統的東西。
macOS 專屬的部分（launchd 的 plist、bash 腳本）在 Windows 由這個資料夾取代，兩邊共用同一份 Node 程式。

## 免安裝版（最省事：到 GitHub Release 下載 zip）

不想裝 Node、Git、npm 的話，到 [Releases](https://github.com/cormort/ly-dashboard/releases) 下載
`ly-dashboard-windows-x64-<日期>.zip`（約 35 MB，內附官方 Node，`runtime\node.exe`）。

1. 解壓縮到固定的資料夾（例如 `C:\ly-dashboard`；**不要**放在會被清掉的暫存或下載資料夾）。
2. 雙擊 `windows\install.cmd`：註冊工作排程器（登入時啟動伺服器、每天 08:05 抓粉專）並立刻啟動、開瀏覽器。
   只想試用、不想常駐就雙擊 `windows\start.cmd`。
3. 受管電腦註冊排程可能 `Access denied`：照畫面印出的 `schtasks` 指令請 IT 執行即可，伺服器仍會啟動。

打包版不會 `git pull`、`npm ci`、重新建置，所以**更新 = 下載新版 zip 覆蓋**（`data\` 與 `.cache\` 不在 zip 內，資料與 log 會留著）。
每日抓粉專需要 Chrome 與 playwright-core，不在免安裝版內；要用請改走下面的 clone 流程。

維護者出新版：推標籤即可，GitHub Actions（`.github/workflows/release-windows.yml`）會打包並建立 Release：

```bash
git tag v1.0.0 && git push origin v1.0.0
node scripts/pack-windows.mjs     # 想在本機先試打包時（macOS／Windows 都行），產物在 dist/
```

## 0. 前置需求（各一次）

| 項目 | 要求 | 備註 |
| --- | --- | --- |
| Windows | 10 / 11（x64） | 需要 PowerShell 5.1（系統內建）與 `netstat`、`curl.exe`（1803 之後都有） |
| Node.js | **22.13 以上**，建議 24 LTS | `node:sqlite` 在 22.5–22.12 要 `--experimental-sqlite`，22.13 之後免旗標 |
| Git | 任何近期版本 | 只有「自動 `git pull`」與「推資料分支」需要；沒有也能跑 |
| Google Chrome | 任何近期版本 | 只有「每日抓粉專」需要（要一個已登入的設定檔） |

```powershell
git clone https://github.com/cormort/ly-dashboard.git C:\ly-dashboard
cd C:\ly-dashboard
npm --prefix web install
```

## 1. 一次性啟動（等同 macOS 的 start.command）

```powershell
windows\start.cmd            # 只綁 127.0.0.1：只有這台電腦看得到
windows\start-lan.cmd        # 綁 0.0.0.0：同一個區網的人用印出的網址連
```

雙擊也可以。腳本會依序：檢查 node 版本 → 檢查埠是否已經有伺服器 → `git pull --ff-only`（失敗就用現有版本）
→ 需要時 `npm ci`／`npm run build` → 啟動伺服器 → 開瀏覽器。關掉視窗或 Ctrl+C 就停止。

> 伺服器啟動時若資料不存在或超過 24 小時，會先自己同步一次（第一次要幾分鐘；畫面會先顯示「資料截至…」）。

## 2. 常駐（等同 macOS 的 launchd）

```powershell
powershell -File windows\install-tasks.ps1                 # 安裝兩個工作（建議）
powershell -File windows\install-tasks.ps1 -Action status  # 看狀態與最近的 log
powershell -File windows\install-tasks.ps1 -Action uninstall
powershell -File windows\install-tasks.ps1 -Time 08:05      # 換每日抓取時間
```

會建立兩個工作排程器項目（都是「只在使用者登入時執行」，跟 macOS 的 LaunchAgent 語意相同）：

- **ly-dashboard-server**：登入時啟動 `windows\server-supervisor.ps1`。node 當掉（非 0 離開碼）會自動重啟
  （指數退避，最多 60 秒）；連接埠已經有伺服器在跑就 `exit 0` 不搶 —— 這一條讓它不會變成無限重啟迴圈。
- **ly-dashboard-fb-daily**：每天 08:05 跑 `windows\fb-daily.ps1`，並勾了
  **「錯過開始時間後盡快執行」**（`-StartWhenAvailable`）：關機或睡眠錯過之後，開機就會補跑一次。

受管（公司）電腦上 `Register-ScheduledTask` 可能回 Access denied；腳本會把等價的 `schtasks /Create`
指令印出來讓你或 IT 執行。

## 3. 每日抓委員粉專（各一次前置 + 每天自動）

```powershell
npm i -D playwright-core
node scripts\fetch-fb-posts.mjs --login        # 開有畫面的 Chrome，登入一次 Facebook（設定檔會存下來）
powershell -File windows\fb-daily.ps1 --ids 1 --limit 5   # 手動試跑一位，確認抓得到
```

- 設定檔預設放在 `%USERPROFILE%\.ly-dashboard\fb-profile`（用 `LY_FB_PROFILE` 可換）。
- 抓一輪 113 位要 25–35 分鐘；跑完會送 Telegram 成敗通知（設定見下一節）。
- 抓取鎖、log、寫回 Google 試算表、推送 `fb-data` 資料分支、觸發本機同步，全部在
  `scripts/fb-daily.mjs` 裡（跟 macOS 同一份），log 在 `.cache\fb-daily.log`。

## 4. 環境變數與憑證

常駐環境（工作排程器）建議用 `setx` 設定，設定完要重新登入才會生效：

```powershell
setx LY_UA            "ly-dashboard/1.0 (+https://github.com/cormort/ly-dashboard; contact: 你的email)"
setx LY_HOST          "0.0.0.0"        # 要給別人連才需要（同步 API 會要求 token）
setx LY_SYNC_TOKEN    "換成一串隨機字串" # 對外時的同步保護（沒設＝只有 loopback 能用同步）
setx LY_NOTIFY        "1"
setx LY_FB_DATA_PUSH  "1"
```

憑證檔（**不要放進 repo**）：

- `%USERPROFILE%\.ly-dashboard\notify.env`：`LY_TELEGRAM_BOT_TOKEN=…`、`LY_TELEGRAM_CHAT_ID=…`
- `%USERPROFILE%\.ly-dashboard\sheet.env`：`LY_SHEET_WEBAPP_URL=…`、`LY_SHEET_TOKEN=…`（寫回試算表用）

兩個檔案都只認 `KEY=VALUE`（`export KEY=VALUE` 也吃、`#` 開頭是註解），不會被當成程式執行 ——
這跟原本的 `.sh` 版不同（`.sh` 是 `source` 整個檔案）。

## 5. 區網分享（給同事看）

```powershell
windows\start-lan.cmd
```

- 綁 `0.0.0.0`，所以 `POST /api/v1/sync` 會自動要求 `LY_SYNC_TOKEN`（沒設 token 時對外直接 403）。
- 防火牆要放行 8787（**需系統管理員**）：

```powershell
New-NetFirewallRule -DisplayName "ly-dashboard 8787" -Direction Inbound -LocalPort 8787 -Protocol TCP -Action Allow
```

- 有裝 Tailscale 的話，印出的 `100.x` 網址可以跨地點連（跟 macOS 那份一樣的用法）。

## 6. 上線前該實測的事（照順序）

1. **打得到政府來源**（最該先做的一步）：`node server\ingest.mjs`。抓 `data.ly.gov.tw` 靠「具名 UA + TLS legacy 修補」
   過 WAF，理論上 Node 的 OpenSSL 在 Windows 行為一致，但**這台機器沒實測過**。看到 `sync_runs` 有資料就代表過了。
2. `npm test`：應該全綠（沒有 bash／plutil 的機器會自動跳過那幾條 shell 檢查，見
   `test/shell-scripts.test.mjs` 與 `test/windows-port.test.mjs`）。
3. `Invoke-WebRequest http://127.0.0.1:8787/api/v1/health` 回 200。
4. 前端每一頁（總覽／我的機關／議事／委員／議員）都出得來，而且不是「資料截至很久以前」。
5. 每日抓取手動跑一次（上面第 3 節），確認 Telegram 收到通知。
6. （在 Windows 上跑，選用）`powershell -File windows\lint.ps1`：PSScriptAnalyzer 應該回 0 問題 ——
   包含「PowerShell 5.1 相容語法」規則（開發時用 PowerShell 7，但使用者機器內建的是 5.1）。
   第一次跑會用 `Install-Module -Scope CurrentUser` 裝模組，需要網路、不需要系統管理員。

## 7. 與 macOS 版的對照

| 功能 | macOS | Windows |
| --- | --- | --- |
| 一鍵啟動 | `start.command`（bash） | `windows\start.cmd` → `start.ps1`（PowerShell） |
| 區網分享 | `start-lan.command` | `windows\start-lan.cmd` |
| 伺服器常駐 | launchd `KeepAlive` + `scripts/ly-dashboard-server.sh` | 工作排程器 + `windows\server-supervisor.ps1` |
| 每日抓取 | launchd 08:00 → `scripts/fb-daily.sh` | 工作排程器 08:05 → `windows\fb-daily.ps1` |
| 抓取邏輯 | `scripts/fb-daily.mjs`（薄殼 `fb-daily.sh` exec 它） | 同上，**同一份** |
| Telegram 通知 | `scripts/notify-telegram.sh`（bash + curl） | `scripts/notify-telegram.mjs`（Node 內建 fetch） |
| log | `.cache/server.log`、`.cache/fb-daily.log` | `.cache/server-supervisor.log`＋`server.out.log`／`server.err.log`、`.cache/fb-daily.log` |
| 啟動腳本的 PATH 補救 | `/opt/homebrew/bin`（launchd 不載 shell rc） | 不需要（Node 安裝時就在系統 PATH） |

`scripts/notify-telegram.sh` 留著沒刪（dsh 的每日排程還可能呼叫它），但 `fb-daily.mjs` 一律用 `.mjs` 版 ——
兩者行為一致（`--dry-run`、沒有憑證就只印不送、離不開 0/1/2 三種離開碼）。

## 8. 疑難排解

| 症狀 | 原因與處理 |
| --- | --- |
| 前端顯示「無法取得同步狀態（/api/v1/health）」「網路錯誤」 | API 伺服器沒在跑。用 `install-tasks.ps1 -Action status` 看 `ly-dashboard-server`；或直接 `windows\start.cmd` 看它的訊息。 |
| 網頁打得開但每一頁都空白／「資料截至…」 | 前端有、資料沒有：跑 `node server\ingest.mjs`，再看 `GET /api/v1/sync-runs` 的錯誤。 |
| `node:sqlite` 相關錯誤 | Node 版本太舊（< 22.13）。升級 Node 或暫時用 `node --experimental-sqlite server\index.mjs` 頂著。 |
| 每日抓取回「0 列有日期」 | 設定檔沒登入 Facebook。在**有畫面**的視窗跑 `node scripts\fetch-fb-posts.mjs --login`。 |
| 排程時間到了卻沒跑 | 兩個工作都設成「只在使用者登入時執行」：登出／鎖定時不會跑，開機後會補跑一次（`-StartWhenAvailable`）。 |
| 別人連不到區網網址 | 防火牆沒放行（見上方 `New-NetFirewallRule`），或伺服器是以非 `-Lan` 模式啟動的（只聽 127.0.0.1）。 |
| `npm test` 紅在 shell 相關的測試 | 那幾條需要 bash／plutil。裝 Git Bash 就會跑；不裝也會自動跳過。 |

## 9. 已驗證 / 還沒驗證的事

**已經量過的（在 macOS 上就能做，不必有 Windows 機器）：**

- `npm test` 全綠（332+ 項）：`test/windows-port.test.mjs` 守住平台假設 ——
  `.ps1` 不可寫死機器路徑、必須有 UTF-8 BOM、`.cmd` 必須純 ASCII、每日抓取只有一份實作
  （`fb-daily.ps1` → `scripts/fb-daily.mjs`）、排程要 `-StartWhenAvailable` 與 `Interactive`、
  抓取鎖三態、通知的離開碼與 token 遮蔽、Chrome 路徑各平台都有候選。
- 四支 `.ps1` 都通過 PSScriptAnalyzer（0 問題），含 **PSUseCompatibleSyntax 對 PowerShell 5.1**
  的相容語法檢查（5.1 沒有 `??`、三元運算子等）。
- **沒有 Windows 機器的部分**：`.github/workflows/ci.yml` 會在 GitHub 的 `windows-latest` 上跑
  `npm test`（推上去就會執行；這是唯一能在真的 Windows 上跑一次的路徑）。

**還沒在真的 Windows 上跑過的部分**（照 macOS 版行為逐項對照寫的，最可能出問題的地方）：

1. `Start-Process -NoNewWindow` 與輸出入重導在 PowerShell 5.1 的細節（log 會少行或位置不同）。
2. `netstat` 輸出格式在不同語系 Windows 上的比對（`Test-PortListening`）。
3. 工作排程器的權限：受管電腦上 `Register-ScheduledTask` 會回 Access denied，要改用印出來的
   `schtasks /Create` 指令。
4. `data.ly.gov.tw` 的 TLS／WAF 在 Windows 的 Node 上是否照樣過（第 6 節第 1 步會驗）。
