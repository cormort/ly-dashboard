<#
  一鍵啟動立委觀測站（Windows）。等同 macOS 的 start.command。

    windows\start.cmd                  # 只綁 127.0.0.1：只有這台電腦看得到
    windows\start.cmd -Lan             # 綁 0.0.0.0：同一個區網的人用印出的網址連（同步 API 會自動停用）
    windows\start.cmd -NoBuild         # 跳過前端建置（確定 web\dist 是最新的時候）
    windows\start.cmd -NoPull          # 不先 git pull

  這支只做「一次性啟動」：當掉不會自動重啟。要常駐請用 windows\install-tasks.ps1
  （工作排程器 + windows\server-supervisor.ps1）。

  為什麼是 PowerShell 而不是純批次檔：這支要做的事情（比 mtime 決定要不要 npm ci／build、
  檢查埠、抓區網 IP）在 cmd 裡要寫成一大串脆弱的字串比對；PowerShell 5.1 是 Windows 10/11 內建的，
  windows\start.cmd 只是雙擊用的薄殼。
#>
[CmdletBinding()]
param(
  [switch]$Lan,
  [switch]$NoBuild,
  [switch]$NoPull,
  [switch]$NoOpen
)

$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot
Set-Location $Root

# 伺服器讀的是 PORT（見 server/config.mjs）。一定要寫進環境變數給子行程，
# 只改本檔的檢查值的話，「檢查的埠」跟「實際監聽的埠」會是兩個（2026-10-07 真的踩到）。
if ($env:PORT) { $Port = [int]$env:PORT } else { $Port = 8787 }
$env:PORT = "$Port"

function Write-Step([string]$Message) { Write-Host "» $Message" -ForegroundColor Cyan }
function Write-Warn([string]$Message) { Write-Host "! $Message" -ForegroundColor Yellow }

function Get-NodePath {
  $command = Get-Command node -ErrorAction SilentlyContinue
  if (-not $command) { return $null }
  return $command.Source
}

function Test-PortListening([int]$ProbePort) {
  # netstat 一定有（Get-NetTCPConnection 在 Windows Server 2012 之後才有，但 netstat 更保險）
  $pattern = ":$ProbePort\s"
  $lines = & netstat -ano -p TCP | Select-String -Pattern $pattern | Select-String -Pattern 'LISTENING'
  return [bool]$lines
}

function Test-ServerHealth([int]$ProbePort) {
  try {
    $response = Invoke-WebRequest -UseBasicParsing -Uri "http://127.0.0.1:$ProbePort/api/v1/health" -TimeoutSec 3
    return ($response.StatusCode -eq 200)
  } catch {
    return $false
  }
}

function Test-LoopbackOnly([int]$ProbePort) {
  $lines = & netstat -ano -p TCP | Select-String -Pattern "(127\.0\.0\.1|\[::1\]):$ProbePort\s" | Select-String -Pattern 'LISTENING'
  return [bool]$lines
}

function Open-Browser([string]$Url) {
  Start-Process $Url | Out-Null
}

function Show-LanUrl([int]$ProbePort) {
  $addresses = @()
  try {
    $addresses = Get-NetIPAddress -AddressFamily IPv4 |
      Where-Object { $_.IPAddress -ne '127.0.0.1' -and $_.AddressState -eq 'Preferred' } |
      Select-Object -ExpandProperty IPAddress
  } catch {
    # Get-NetIPAddress 在某些環境（舊版 PowerShell／受管環境）不能用，退回解析 ipconfig
    $addresses = (& ipconfig) | Select-String -Pattern 'IPv4' |
      ForEach-Object { ($_ -split ':')[-1].Trim() } |
      Where-Object { $_ -match '^\d+\.\d+\.\d+\.\d+$' -and $_ -ne '127.0.0.1' }
  }
  foreach ($address in $addresses) {
    if ($address -like '100.*') {
      Write-Host ("Tailscale 網址：http://{0}:{1}/" -f $address, $ProbePort)
    } else {
      Write-Host ("區網網址：http://{0}:{1}/" -f $address, $ProbePort)
    }
  }
  Write-Host "（第一次用這個網址時，Windows 防火牆可能會問要不要允許 Node.js 連線；要讓別人連必須允許）"
}

# ---- 前置：node 在不在、版本夠不夠 ------------------------------------------------------
$nodePath = Get-NodePath
if (-not $nodePath) {
  Write-Warn '找不到 node。請先安裝 Node.js 22.13 以上（建議 24 LTS）：https://nodejs.org/'
  Write-Host '  安裝後把這個視窗關掉再重新執行一次。'
  Read-Host '按 Enter 結束'
  exit 1
}
$nodeVersion = (& node -p "process.versions.node") 2>$null
if ([version]$nodeVersion -lt [version]'22.13.0') {
  # 22.5–22.12 的 node:sqlite 要加 --experimental-sqlite；22.13 之後免旗標
  Write-Warn "Node 版本是 $nodeVersion，低於 22.13：node:sqlite 會需要 --experimental-sqlite。建議升級到 Node 24 LTS。"
}
Write-Step "Node $nodeVersion（$nodePath）"

# ---- 已經有伺服器在跑就不重複啟動 ---------------------------------------------------------
if ((Test-PortListening $Port) -or (Test-ServerHealth $Port)) {
  if ($Lan -and (Test-LoopbackOnly $Port)) {
    Write-Warn "目前跑的是僅限本機模式（只聽 127.0.0.1），別人連不到。"
    Write-Host '  請先關掉原本那個視窗（或工作排程器的 ly-dashboard-server），再用 -Lan 開一次。'
    Read-Host '按 Enter 結束'
    exit 1
  }
  Write-Host "已經有伺服器在跑（port $Port），直接開啟網頁；要重啟請先關掉原本那個視窗"
  if (-not $NoOpen) { Open-Browser "http://127.0.0.1:$Port/" }
  exit 0
}

# ---- 先跟 GitHub 同步；離線或本機有衝突就跳過，用現有版本照常啟動 -------------------------
if (-not $NoPull) {
  if (Get-Command git -ErrorAction SilentlyContinue) {
    Write-Step 'git pull --ff-only'
    & git pull --ff-only
    if ($LASTEXITCODE -ne 0) { Write-Host '（同步失敗，沿用本機版本）' }
  } else {
    Write-Warn '沒有 git，跳過同步（只影響「自動更新」）'
  }
}

# ---- 前端相依與建置：沒裝過、或 lockfile／原始碼比產物新就重做 -----------------------------
$webModulesStamp = Join-Path $Root 'web\node_modules\.package-lock.json'
$webLock = Join-Path $Root 'web\package-lock.json'
$webIndex = Join-Path $Root 'web\dist\index.html'

$needsInstall = (-not (Test-Path $webModulesStamp)) -or
  ((Test-Path $webLock) -and ((Get-Item $webLock).LastWriteTime -gt (Get-Item $webModulesStamp).LastWriteTime))
if ($needsInstall) {
  Write-Step 'npm --prefix web ci'
  & npm --prefix web ci
  if ($LASTEXITCODE -ne 0) { Write-Warn 'npm ci 失敗（見上面錯誤）；如果只是相依沒變，可以忽略' }
}

if (-not $NoBuild) {
  $needsBuild = -not (Test-Path $webIndex)
  if (-not $needsBuild) {
    $distTime = (Get-Item $webIndex).LastWriteTime
    $sources = @(
      (Join-Path $Root 'web\src'),
      (Join-Path $Root 'web\index.html'),
      (Join-Path $Root 'web\vite.config.ts'),
      (Join-Path $Root 'web\package.json')
    )
    foreach ($source in $sources) {
      if (-not (Test-Path $source)) { continue }
      $newest = Get-ChildItem -Path $source -Recurse -File -ErrorAction SilentlyContinue |
        Sort-Object LastWriteTime -Descending | Select-Object -First 1
      if ($newest -and $newest.LastWriteTime -gt $distTime) { $needsBuild = $true; break }
    }
  }
  if ($needsBuild) {
    Write-Step 'npm --prefix web run build'
    & npm --prefix web run build
    if ($LASTEXITCODE -ne 0) { Write-Warn '前端建置失敗：網頁會是舊版或打不開' }
  }
}

# ---- 啟動 ------------------------------------------------------------------------------
if ($Lan) {
  $env:LY_HOST = '0.0.0.0'
  Write-Host ''
  Write-Host '開放區網連線模式（同步 API 自動停用，只有本機能把新資料寫進資料庫）'
  Show-LanUrl $Port
  Write-Host ''
} else {
  Write-Host "啟動中… 網址 http://127.0.0.1:$Port/（只在這台電腦看得到；要分享請用 start-lan.cmd）"
}
Write-Host '關閉這個視窗或按 Ctrl+C 就會停止伺服器。'
Write-Host ''

# 啟動時若資料不存在或超過 24 小時，伺服器會自動先同步一次（第一次跑要幾分鐘，畫面會先顯示「資料截至…」）
$process = Start-Process -FilePath 'node' -ArgumentList 'server/index.mjs' -WorkingDirectory $Root -NoNewWindow -PassThru
try {
  for ($i = 0; $i -lt 100; $i++) {
    if (Test-ServerHealth $Port) { break }
    if ($process.HasExited) { break }
    Start-Sleep -Milliseconds 300
  }
  if ((-not $process.HasExited) -and (-not $NoOpen)) { Open-Browser "http://127.0.0.1:$Port/" }
  $process.WaitForExit()
  exit $process.ExitCode
} finally {
  if (-not $process.HasExited) { Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue }
}
