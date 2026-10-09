<#
  立委觀測站 API 伺服器的常駐監管（Windows）。等同 macOS 的 launchd KeepAlive。

  為什麼需要：`node server/index.mjs` 一當掉（或那個視窗被關掉），網站就整片掛掉，
  使用者看到的只是「無法取得新聞（/api/v1/news/articles）連線逾時」—— 沒人會發現要重開。

  行為（刻意與 scripts/ly-dashboard-server.sh 一致）：
    · 連接埠已經有伺服器在跑（可能是手動啟動的）→ 記一行 log 後 **exit 0**，不搶、不當失敗。
      這一條很重要：工作排程器若設了「失敗就重試」，非 0 離開會變成無限重啟迴圈。
    · node 當掉（非 0 離開碼）→ 等幾秒後重啟（指數退避，最多 60 秒）。
    · node 以 0 離開 → 視為「被正常停掉」，監管也跟著結束。

  啟動：windows\install-tasks.ps1 會把這支註冊成登入時自動執行的工作；
        也可以手動 `powershell -File windows\server-supervisor.ps1` 跑（前景、Ctrl+C 停止）。
#>
[CmdletBinding()]
param(
  [int]$Port = 0,
  [int]$MaxRestarts = 0,          # 0 = 不限次數（跟 launchd KeepAlive 一樣）
  [int]$BackoffSeconds = 5,
  [int]$MaxBackoffSeconds = 60,
  [switch]$NoRestart              # 只跑一次，當掉就結束（除錯用）
)

$ErrorActionPreference = 'Continue'
$Root = Split-Path -Parent $PSScriptRoot
Set-Location $Root

# 打包版（scripts/pack-windows.mjs）內附 node：runtime\node.exe 優先，對方不必另外安裝 Node。
$bundledNode = Join-Path $Root 'runtime\node.exe'
if (Test-Path $bundledNode) { $env:PATH = (Split-Path $bundledNode) + ';' + $env:PATH }
$Packaged = Test-Path (Join-Path $Root 'PACKAGED')

if ($Port -le 0) {
  if ($env:PORT) { $Port = [int]$env:PORT } else { $Port = 8787 }
}
$env:PORT = "$Port"

$logDir = Join-Path $Root '.cache'
if (-not (Test-Path $logDir)) { New-Item -ItemType Directory -Path $logDir -Force | Out-Null }
# 監管自己的 log 用附加的（server-supervisor.log）；node 的 stdout/stderr 各一個檔。
# 為什麼分開：Start-Process 的 -RedirectStandardOutput 會「重寫」目標檔（每次重啟都清空），
# 也不能把 stdout 與 stderr 導到同一個檔案 —— 所以 node 的輸出放 server.out.log／server.err.log，
# 監管的紀錄放 server-supervisor.log，兩邊都保留。
$logPath = Join-Path $logDir 'server-supervisor.log'
$outPath = Join-Path $logDir 'server.out.log'
$errPath = Join-Path $logDir 'server.err.log'

function Write-SupervisorLog([string]$Message) {
  $stamp = (Get-Date).ToString('yyyy-MM-ddTHH:mm:sszzz')
  Add-Content -Path $logPath -Value "$stamp $Message" -Encoding UTF8
  Write-Host "$stamp $Message"
}

function Test-PortListening([int]$ProbePort) {
  $lines = & netstat -ano -p TCP | Select-String -Pattern ":$ProbePort\s" | Select-String -Pattern 'LISTENING'
  return [bool]$lines
}

if (Test-PortListening $Port) {
  Write-SupervisorLog "連接埠 $Port 已經有伺服器在跑，結束（不搶，等它自己掛掉再說）"
  exit 0
}

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  Write-SupervisorLog '找不到 node；請安裝 Node.js 22.13 以上。'
  exit 1
}

Write-SupervisorLog "啟動立委觀測站 API 伺服器：$(if ($env:LY_HOST) { $env:LY_HOST } else { '127.0.0.1' }):$Port"

$restarts = 0
$backoff = $BackoffSeconds
while ($true) {
  $process = Start-Process -FilePath 'node' -ArgumentList 'server/index.mjs' -WorkingDirectory $Root `
    -NoNewWindow -PassThru -RedirectStandardOutput $outPath -RedirectStandardError $errPath
  # PowerShell 5.1：-PassThru 的行程若沒先取得 Handle，結束後 ExitCode 會是空的（$null -eq 0 為 false，
  # 於是「exit 0 = 正常停掉」永遠不成立）。先碰一下 Handle 讓 .NET 持有它。
  $null = $process.Handle
  $process.WaitForExit()
  $code = $process.ExitCode
  Write-SupervisorLog "node 結束（exit $code）"

  if ($code -eq 0) { exit 0 }
  if ($NoRestart) { exit $code }

  $restarts++
  if ($MaxRestarts -gt 0 -and $restarts -ge $MaxRestarts) {
    Write-SupervisorLog "已重啟 $restarts 次（上限 $MaxRestarts），不再重啟。請看 $errPath 找原因。"
    exit $code
  }
  Start-Sleep -Seconds $backoff
  Write-SupervisorLog "重新啟動（第 $restarts 次，等了 $backoff 秒）"
  if ($backoff -lt $MaxBackoffSeconds) { $backoff = [Math]::Min($backoff * 2, $MaxBackoffSeconds) }
}
