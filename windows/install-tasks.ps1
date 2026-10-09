<#
  把立委觀測站的兩個工作裝進 Windows 工作排程器。等同 macOS 的 scripts/launchd/install.sh。

    powershell -File windows\install-tasks.ps1                  # 安裝全部（API 伺服器 + 每日抓粉專）
    powershell -File windows\install-tasks.ps1 -Target server   # 只裝 API 伺服器的常駐監管
    powershell -File windows\install-tasks.ps1 -Target fb-daily # 只裝每日抓取
    powershell -File windows\install-tasks.ps1 -Action status   # 看狀態與最近一次執行
    powershell -File windows\install-tasks.ps1 -Action uninstall
    powershell -File windows\install-tasks.ps1 -Time 08:05      # 換每日抓取的時間

  兩個工作：
    ly-dashboard-server    登入時啟動 windows\server-supervisor.ps1（當掉自動重啟，等於 launchd KeepAlive）
    ly-dashboard-fb-daily  每天 08:05 跑 windows\fb-daily.ps1，勾「錯過開始時間後盡快執行」＝開機後補跑

  兩個都是 **只在使用者登入時執行**（LogonType Interactive）：抓粉專要讀已登入的 Chrome，
  伺服器也要在同一個使用者工作階段裡（跟 macOS 的 LaunchAgent 一樣是 per-user 的）。

  為什麼可能失敗：受管（公司）電腦或沒有權限的帳號，`Register-ScheduledTask` 會回 Access denied。
  這時腳本會把等價的 `schtasks /Create` 指令印出來讓你（或 IT）自己執行。
#>
[CmdletBinding()]
param(
  [ValidateSet('install', 'status', 'uninstall')][string]$Action = 'install',
  [ValidateSet('server', 'fb-daily', 'all')][string]$Target = 'all',
  [string]$Time = '08:05',
  [switch]$UseSchtasks
)

$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot

$ServerTask = 'ly-dashboard-server'
$FbTask = 'ly-dashboard-fb-daily'
$ServerScript = Join-Path $PSScriptRoot 'server-supervisor.ps1'
$FbScript = Join-Path $PSScriptRoot 'fb-daily.ps1'

function Get-TaskName([string]$Target) {
  if ($Target -eq 'all') { return @($ServerTask, $FbTask) }
  if ($Target -eq 'server') { return @($ServerTask) }
  return @($FbTask)
}

function Get-PowerShellArgument([string]$ScriptPath) {
  return "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$ScriptPath`""
}

function Show-SchtasksFallback {
  Write-Host ''
  Write-Host '建立工作失敗（常見原因：這台電腦是受管環境，或帳號沒有建立排程的權限）。' -ForegroundColor Yellow
  Write-Host '請把下面兩行複製到「以系統管理員身分執行」的命令提示字元手動執行：'
  Write-Host ''
  Write-Host ('schtasks /Create /TN "{0}" /SC ONLOGON /IT /RL LIMITED /F /TR "powershell.exe {1}"' -f $ServerTask, (Get-PowerShellArgument $ServerScript))
  Write-Host ('schtasks /Create /TN "{0}" /SC DAILY /ST {1} /IT /F /TR "powershell.exe {2}"' -f $FbTask, $Time, (Get-PowerShellArgument $FbScript))
  Write-Host ''
  Write-Host '（schtasks 沒有「錯過開始時間後盡快執行」的對應參數；要那個行為請在「工作排程器」圖形介面裡勾選，或改用上面的 Register-ScheduledTask 路徑。）'
}

function Install-ServerTask {
  $action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument (Get-PowerShellArgument $ServerScript) -WorkingDirectory $Root
  $trigger = New-ScheduledTaskTrigger -AtLogOn
  $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
    -MultipleInstances IgnoreNew -ExecutionTimeLimit ([TimeSpan]::Zero)
  $principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive -RunLevel Limited
  Register-ScheduledTask -TaskName $ServerTask -Action $action -Trigger $trigger -Settings $settings -Principal $principal `
    -Description '立委觀測站 API 伺服器：登入時啟動，當掉自動重啟（windows\server-supervisor.ps1）' -Force | Out-Null
  Write-Host "已註冊：$ServerTask（登入時啟動；node 當掉會自動重啟）" -ForegroundColor Green
}

function Install-FbTask {
  $action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument (Get-PowerShellArgument $FbScript) -WorkingDirectory $Root
  $trigger = New-ScheduledTaskTrigger -Daily -At $Time
  # -StartWhenAvailable ＝ 工作排程器介面上的「錯過開始時間後盡快執行」（開機後補跑）
  $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable `
    -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Hours 2)
  $principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive -RunLevel Limited
  Register-ScheduledTask -TaskName $FbTask -Action $action -Trigger $trigger -Settings $settings -Principal $principal `
    -Description '立委觀測站：每日抓取立委臉書粉專（windows\fb-daily.ps1 → scripts\fb-daily.mjs）' -Force | Out-Null
  Write-Host "已註冊：$FbTask（每天 $Time，錯過會在開機後補跑）" -ForegroundColor Green
}

function Show-TaskLog([string[]]$Paths, [int]$Tail = 10) {
  foreach ($path in $Paths) {
    Write-Host ("  log：{0}" -f $path)
    if (Test-Path $path) {
      Get-Content -Path $path -Tail $Tail | ForEach-Object { Write-Host "    $_" }
    } else {
      Write-Host '    （還沒有 log；代表還沒跑過）'
    }
  }
}

function Show-Status {
  foreach ($name in (Get-TaskName $Target)) {
    Write-Host "== $name ==" -ForegroundColor Cyan
    $task = Get-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue
    if (-not $task) {
      Write-Host '  （沒有註冊）'
    } else {
      $info = $task | Get-ScheduledTaskInfo
      Write-Host ("  狀態：{0} / 上次執行：{1} / 離開碼：{2} / 下次執行：{3}" -f $task.State, $info.LastRunTime, $info.LastTaskResult, $info.NextRunTime)
    }
    if ($name -eq $ServerTask) {
      Show-TaskLog @((Join-Path $Root '.cache\server-supervisor.log'), (Join-Path $Root '.cache\server.err.log'))
      Write-Host '  伺服器健康檢查：Invoke-WebRequest http://127.0.0.1:8787/api/v1/health'
    } else {
      Show-TaskLog @((Join-Path $Root '.cache\fb-daily.log'))
    }
    Write-Host ''
  }
}

function Remove-Task {
  # 會改變系統狀態（移除排程工作），所以支援 -WhatIf／-Confirm
  [CmdletBinding(SupportsShouldProcess = $true)]
  param()
  foreach ($name in (Get-TaskName $Target)) {
    $task = Get-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue
    if (-not $task) { Write-Host "$name：（本來就沒有註冊）"; continue }
    if (-not $PSCmdlet.ShouldProcess($name, 'Unregister-ScheduledTask')) { continue }
    Unregister-ScheduledTask -TaskName $name -Confirm:$false
    Write-Host "已移除 $name（log 與抓到的資料都保留）" -ForegroundColor Green
  }
}

if ($Action -eq 'status') { Show-Status; exit 0 }
if ($Action -eq 'uninstall') { Remove-Task; exit 0 }

# ---- 安裝 -------------------------------------------------------------------------------
if ($UseSchtasks) {
  & schtasks /Create /TN $ServerTask /SC ONLOGON /IT /RL LIMITED /F /TR ("powershell.exe " + (Get-PowerShellArgument $ServerScript))
  & schtasks /Create /TN $FbTask /SC DAILY /ST $Time /IT /F /TR ("powershell.exe " + (Get-PowerShellArgument $FbScript))
} else {
  try {
    if ((Get-TaskName $Target) -contains $ServerTask) { Install-ServerTask }
    if ((Get-TaskName $Target) -contains $FbTask) { Install-FbTask }
  } catch {
    Write-Host "建立工作失敗：$($_.Exception.Message)" -ForegroundColor Red
    Show-SchtasksFallback
    exit 1
  }
}

Write-Host ''
Write-Host '接下來：'
Write-Host '  1) 立刻試跑一次 API 伺服器的工作（不用等重新登入）：'
Write-Host "     Start-ScheduledTask -TaskName $ServerTask"
Write-Host '  2) 每日抓取要先登入過一次 Facebook（有畫面的 Chrome）：'
Write-Host '     node scripts\fetch-fb-posts.mjs --login'
Write-Host '  3) 立刻試跑一次每日抓取：'
Write-Host "     Start-ScheduledTask -TaskName $FbTask    # 或直接 powershell -File windows\fb-daily.ps1 --ids 1 --limit 5"
Write-Host '  4) 要讓同一個區網的人連線：用 windows\start-lan.cmd，並在「以系統管理員身分執行」的視窗放行防火牆：'
Write-Host '     New-NetFirewallRule -DisplayName "ly-dashboard 8787" -Direction Inbound -LocalPort 8787 -Protocol TCP -Action Allow'
Write-Host '  5) 看狀態：'
Write-Host '     powershell -File windows\install-tasks.ps1 -Action status'
