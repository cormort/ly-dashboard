<#
  每日抓取立委臉書粉專（Windows）。等同 macOS 的 scripts/fb-daily.sh。

    powershell -File windows\fb-daily.ps1                    # 正常路徑（抓 113 位，25–35 分鐘）
    powershell -File windows\fb-daily.ps1 --ids 1 --limit 5  # 手動試跑（參數原樣轉給 fb-daily.mjs）

  這支刻意只有十幾行：真正的邏輯在 scripts/fb-daily.mjs（跨平台、與 macOS 共用同一份），
  包含抓取鎖、log、Telegram 成敗通知、寫回試算表、推送資料分支與觸發本機同步。
  這裡只負責「在 Windows 的排程環境裡找到 node 並把參數與離開碼帶過去」。

  前置（各一次就好）：
    npm i -D playwright-core
    node scripts\fetch-fb-posts.mjs --login      # 開有畫面的 Chrome 登入一次 Facebook（設定檔會存下來）
#>
[CmdletBinding()]
param(
  [Parameter(ValueFromRemainingArguments = $true)][string[]]$PassThruArgs
)

$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot
Set-Location $Root

# 打包版（scripts/pack-windows.mjs）內附 node：runtime\node.exe 優先，對方不必另外安裝 Node。
$bundledNode = Join-Path $Root 'runtime\node.exe'
if (Test-Path $bundledNode) { $env:PATH = (Split-Path $bundledNode) + ';' + $env:PATH }
$Packaged = Test-Path (Join-Path $Root 'PACKAGED')

$logDir = Join-Path $Root '.cache'
if (-not (Test-Path $logDir)) { New-Item -ItemType Directory -Path $logDir -Force | Out-Null }
$logPath = Join-Path $logDir 'fb-daily.log'

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  Add-Content -Path $logPath -Value "$((Get-Date).ToString('yyyy-MM-ddTHH:mm:sszzz')) 找不到 node；中止（請安裝 Node.js 22.13 以上）" -Encoding UTF8
  Write-Error '找不到 node。請安裝 Node.js 22.13 以上（建議 24 LTS）：https://nodejs.org/'
  exit 1
}

& node (Join-Path $Root 'scripts\fb-daily.mjs') @PassThruArgs
$code = $LASTEXITCODE
Write-Host "fb-daily.mjs 結束（exit $code）"
exit $code
