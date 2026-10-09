# PSScriptAnalyzer 的設定（給 windows\*.ps1 用）
#
#   powershell -File windows\lint.ps1        # 直接跑（會自己裝模組到 CurrentUser）
#   或手動：
#     Install-Module PSScriptAnalyzer -Scope CurrentUser
#     Invoke-ScriptAnalyzer -Path windows -Recurse -Settings windows\PSScriptAnalyzerSettings.psd1
#
# 為什麼要排除這幾條：
#   PSAvoidUsingWriteHost —— 這幾支是「使用者雙擊、看訊息、看 log」的互動腳本。
#     Write-Host 的替代品（Write-Information／Write-Output）在 PowerShell 5.1 的主控台上
#     預設不會顯示，等於訊息直接消失；這裡刻意用 Write-Host。
#   PSUseSingularNouns —— 函式名稱已經改成單數（Get-TaskName、Show-TaskLog…），這條留著是為了
#     其他規則的一致性，不需要它來管命名。
#   PSReviewUnusedParameter —— 誤判：`$Target`／`$NoOpen` 是在函式內以動態範圍讀取，
#     規則只看腳本範圍就判定「沒用到」。現在已改成明確傳參，但仍留著排除避免又踩到。
@{
    Severity           = @('Error', 'Warning')
    ExcludeRules       = @(
        'PSAvoidUsingWriteHost',
        'PSUseSingularNouns',
        'PSReviewUnusedParameter',
        'PSUseBOMForUnicodeEncodedFile'   # 這一條由 test/windows-port.test.mjs 直接驗（BOM 一定要有）
    )
    Rules              = @{
        # Windows PowerShell 5.1 沒有 `??`、三元運算子、`-Parallel` 這些新語法；
        # 這條規則會把「在 5.1 上會直接解析失敗」的寫法抓出來。
        PSUseCompatibleSyntax = @{
            Enable         = $true
            TargetVersions = @('5.1')
        }
    }
}
