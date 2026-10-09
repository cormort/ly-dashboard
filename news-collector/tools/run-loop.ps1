<#
  不用工作排程器的備用方式：保持這個視窗開著，每小時收集一次。關掉視窗就停止。
  （受管電腦不能建立排程時用這個；也可以放進「啟動」資料夾的捷徑讓它登入後自動跑。）
#>
[CmdletBinding()]
param(
  [int]$IntervalMinutes = 60
)

$ErrorActionPreference = 'Continue'
$script = Join-Path $PSScriptRoot 'collect.ps1'
Write-Host "新聞收集（每 $IntervalMinutes 分鐘一次）。關掉這個視窗就會停止。" -ForegroundColor Cyan
while ($true) {
  & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $script
  $next = (Get-Date).AddMinutes($IntervalMinutes)
  Write-Host "下一輪：$($next.ToString('HH:mm'))" -ForegroundColor DarkGray
  Start-Sleep -Seconds ($IntervalMinutes * 60)
}
