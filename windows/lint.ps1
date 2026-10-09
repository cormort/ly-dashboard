<#
  檢查 windows\ 底下的 PowerShell 腳本。等同其他語言的 lint。

    powershell -File windows\lint.ps1

  會做兩件事：
    1. PSScriptAnalyzer 的標準規則（排除三條已在 PSScriptAnalyzerSettings.psd1 說明理由的）
    2. **PowerShell 5.1 相容語法檢查**：Windows 10/11 內建的是 5.1，沒有 `??`、三元運算子、
       `-Parallel` 這些新語法 —— 在開發機（PowerShell 7）跑得動不代表在使用者機器跑得動。

  順帶一提，這個檔案本身是 UTF-8 **with BOM**：PowerShell 5.1 讀 .ps1 時若沒有 BOM，
  會用系統的 ANSI 字碼頁（zh-TW 是 Big5）解讀，中文與 emoji 會變亂碼。
  test/windows-port.test.mjs 有一條測試專門守這件事。
#>
[CmdletBinding()]
param([string]$Path = $PSScriptRoot)

$ErrorActionPreference = 'Stop'

if (-not (Get-Module -ListAvailable -Name PSScriptAnalyzer)) {
  Write-Host '安裝 PSScriptAnalyzer（CurrentUser，不需要系統管理員）…'
  Install-Module PSScriptAnalyzer -Scope CurrentUser -Force
}
Import-Module PSScriptAnalyzer

$settings = Join-Path $PSScriptRoot 'PSScriptAnalyzerSettings.psd1'
$issues = Invoke-ScriptAnalyzer -Path $Path -Recurse -Settings $settings
if ($issues) {
  $issues | Format-Table -AutoSize RuleName, Severity, ScriptName, Line, Message | Out-String -Width 200 | Write-Host
  Write-Host ("發現 {0} 個問題" -f $issues.Count) -ForegroundColor Red
  exit 1
}
Write-Host '沒有問題（含 PowerShell 5.1 相容語法檢查）' -ForegroundColor Green
