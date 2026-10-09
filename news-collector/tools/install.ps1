<#
  註冊「每小時收集一次新聞」的工作排程器項目，並立刻跑一輪驗證。

    powershell -File tools\install.ps1                 # 安裝（或更新）
    powershell -File tools\install.ps1 -Action status  # 看狀態與最近的 log
    powershell -File tools\install.ps1 -Action uninstall

  工作是「只在使用者登入時執行」、不需要系統管理員；勾了「錯過開始時間後盡快執行」，
  睡眠或關機錯過就會在開機後補跑一輪。公司電腦不允許建立排程時，會告訴你改用 run-loop.cmd。
#>
[CmdletBinding()]
param(
  [ValidateSet('install', 'status', 'uninstall')][string]$Action = 'install',
  [switch]$SkipFirstRun
)

$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot
$TaskName = 'ly-news-collector'
$Script = Join-Path $PSScriptRoot 'collect.ps1'
$Argument = "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$Script`""

function Remove-Task {
  if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
    return $true
  }
  return $false
}

function Install-WithCmdlet {
  $action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument $Argument -WorkingDirectory $Root
  $start = (Get-Date).Date.AddMinutes(17)  # 每小時的第 17 分（避開整點最擁擠）
  $trigger = New-ScheduledTaskTrigger -Once -At $start -RepetitionInterval (New-TimeSpan -Hours 1) -RepetitionDuration (New-TimeSpan -Days 3650)
  $settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
    -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Minutes 20)
  $principal = New-ScheduledTaskPrincipal -UserId ([Security.Principal.WindowsIdentity]::GetCurrent().Name) -LogonType Interactive -RunLevel Limited
  Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Force | Out-Null
}

function Install-WithSchtasks {
  & schtasks.exe /Create /TN $TaskName /SC HOURLY /MO 1 /ST 00:17 /IT /F /TR "powershell.exe $Argument" | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "schtasks 失敗（exit $LASTEXITCODE）" }
}

switch ($Action) {
  'uninstall' {
    if (Remove-Task) { Write-Host "已移除 $TaskName（logs 與 data 都保留）" -ForegroundColor Green }
    else { Write-Host "$TaskName 本來就沒有註冊" }
    exit 0
  }
  'status' {
    $task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    if (-not $task) { Write-Host '排程：沒有註冊（用 install.cmd 安裝，或用 run-loop.cmd）' }
    else {
      $info = Get-ScheduledTaskInfo -TaskName $TaskName
      Write-Host "排程：$($task.State) / 上次執行：$($info.LastRunTime) / 離開碼：$($info.LastTaskResult) / 下次：$($info.NextRunTime)"
    }
    $logPath = Join-Path $Root 'logs\collect.log'
    if (Test-Path $logPath) { Write-Host '最近的 log：'; Get-Content $logPath -Tail 12 -Encoding UTF8 | ForEach-Object { Write-Host "  $_" } }
    else { Write-Host '還沒有 log（還沒跑過）' }
    $newest = Get-ChildItem (Join-Path $Root 'data\news') -Filter *.ndjson -ErrorAction SilentlyContinue | Sort-Object LastWriteTime -Descending | Select-Object -First 1
    if ($newest) { Write-Host "資料：data\news\（最新更新 $($newest.LastWriteTime)，$($newest.Name)）" }
    exit 0
  }
}

# ---- install ----
$installed = $false
try {
  Install-WithCmdlet
  $installed = $true
  Write-Host "已註冊：$TaskName（每小時一次，錯過會在開機後補跑）" -ForegroundColor Green
} catch {
  Write-Host "Register-ScheduledTask 失敗：$($_.Exception.Message)；改用 schtasks 再試" -ForegroundColor Yellow
  try {
    Install-WithSchtasks
    $installed = $true
    Write-Host "已註冊：$TaskName（每小時一次；schtasks 版沒有「錯過補跑」）" -ForegroundColor Green
  } catch {
    Write-Host ''
    Write-Host '這台電腦不允許建立排程（常見於公司管理的電腦）。' -ForegroundColor Yellow
    Write-Host '改用 run-loop.cmd：雙擊後保持視窗開著，它會每小時自己收集一次。'
  }
}

if (-not $SkipFirstRun) {
  Write-Host ''
  Write-Host '立刻跑一輪驗證…'
  & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $Script
  if ($LASTEXITCODE -eq 0) {
    $files = @(Get-ChildItem (Join-Path $Root 'data\news') -Filter *.ndjson -ErrorAction SilentlyContinue)
    Write-Host ''
    Write-Host "成功。資料在 $(Join-Path $Root 'data\news')（目前 $($files.Count) 個檔）；log 在 $(Join-Path $Root 'logs\collect.log')" -ForegroundColor Green
  } else {
    Write-Host '第一輪失敗：請確認這台電腦連得上網路，詳情見 logs\collect.log' -ForegroundColor Red
    exit 1
  }
}
if (-not $installed) { exit 2 }
exit 0
