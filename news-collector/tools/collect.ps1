<#
  跑一輪新聞收集（給工作排程器、collect-now.cmd、run-loop.cmd 共用）。

    powershell -File tools\collect.ps1            # 抓一輪，失敗最多重試 3 次
    powershell -File tools\collect.ps1 -Retries 1

  做的事：優先使用 runtime\node.exe → 呼叫 scripts\collect-news-rss.mjs --out data →
  把輸出寫進 logs\collect.log。收集腳本本身是「併進當天的檔」，所以重跑、重疊都不會丟資料或重複。
  離開碼 0＝至少有一家媒體抓到；非 0＝全部失敗（通常是沒有網路），會等一下重試。
#>
[CmdletBinding()]
param(
  [int]$Retries = 3
)

$ErrorActionPreference = 'Continue'
$Root = Split-Path -Parent $PSScriptRoot
Set-Location $Root

$bundledNode = Join-Path $Root 'runtime\node.exe'
if (Test-Path $bundledNode) { $env:PATH = (Split-Path $bundledNode) + ';' + $env:PATH }

$logDir = Join-Path $Root 'logs'
if (-not (Test-Path $logDir)) { New-Item -ItemType Directory -Path $logDir -Force | Out-Null }
$logPath = Join-Path $logDir 'collect.log'
if ((Test-Path $logPath) -and ((Get-Item $logPath).Length -gt 1MB)) {
  Move-Item -Path $logPath -Destination "$logPath.1" -Force
}

function Write-Log([string]$Message) {
  $stamp = (Get-Date).ToString('yyyy-MM-ddTHH:mm:sszzz')
  Add-Content -Path $logPath -Value "$stamp $Message" -Encoding UTF8
  Write-Host $Message
}

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  Write-Log '找不到 node（runtime\node.exe 不見了？）；請重新解壓縮完整的 zip。'
  exit 1
}

$script = Join-Path $Root 'scripts\collect-news-rss.mjs'
$outPath = Join-Path $logDir 'last-run.out.txt'
$errPath = Join-Path $logDir 'last-run.err.txt'
$code = 1
for ($attempt = 1; $attempt -le [Math]::Max(1, $Retries); $attempt++) {
  $process = Start-Process -FilePath 'node' -ArgumentList "`"$script`"", '--out', 'data' -WorkingDirectory $Root `
    -NoNewWindow -PassThru -RedirectStandardOutput $outPath -RedirectStandardError $errPath
  # PowerShell 5.1：沒先取得 Handle，結束後 ExitCode 會是空的
  $null = $process.Handle
  $process.WaitForExit()
  $code = $process.ExitCode

  foreach ($line in (Get-Content -Path $outPath -Encoding UTF8 -ErrorAction SilentlyContinue)) { Write-Log $line }
  foreach ($line in (Get-Content -Path $errPath -Encoding UTF8 -ErrorAction SilentlyContinue)) { Write-Log "[stderr] $line" }

  if ($code -eq 0) { break }
  if ($attempt -lt $Retries) {
    $wait = 30 * $attempt
    Write-Log "第 $attempt 次失敗（exit $code），$wait 秒後重試"
    Start-Sleep -Seconds $wait
  }
}

if ($code -eq 0) { Write-Log '本輪完成' } else { Write-Log "本輪失敗（exit $code）：所有媒體都抓不到，請檢查網路；下一輪排程會再試" }
exit $code
