$ErrorActionPreference = 'Stop'
$target = 'D:\GICS_Projects\WMS-by-Gics\.git'
$resultPath = 'D:\GICS_Projects\WMS-by-Gics\output\git-owner-repair-result.json'
$backupPath = 'D:\GICS_Projects\WMS-by-Gics\output\git-owner-before.json'
try {
    $item = Get-Item -LiteralPath $target -Force
    if (!$item.PSIsContainer -or $item.FullName -ne $target -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'Unexpected target; no changes made.' }
    $before = Get-Acl -LiteralPath $target
    $expectedOwner = 'DESKTOP-U43OMAF\CodexSandboxOffline'
    $newOwner = 'DESKTOP-U43OMAF\YCS'
    if ($before.Owner -ne $expectedOwner) { throw "Owner changed since inspection: $($before.Owner); no changes made." }
    $accessSection = [Security.AccessControl.AccessControlSections]::Access
    $beforeAccess = $before.GetSecurityDescriptorSddlForm($accessSection)
    if (Test-Path -LiteralPath $backupPath) { throw 'Backup already exists; no changes made.' }
    @{ Path=$target; Owner=$before.Owner; Sddl=$before.Sddl; RecordedAt=[DateTime]::UtcNow.ToString('o') } | ConvertTo-Json | Set-Content -LiteralPath $backupPath -Encoding UTF8
    $output = & "$env:SystemRoot\System32\icacls.exe" $target /setowner $newOwner 2>&1
    if ($LASTEXITCODE -ne 0) { throw ($output -join "`n") }
    $after = Get-Acl -LiteralPath $target
    if ($after.Owner -ne $newOwner -or $after.GetSecurityDescriptorSddlForm($accessSection) -ne $beforeAccess) { throw 'Post-change verification failed; inspect the saved permission backup.' }
    @{ Success=$true; Path=$target; PreviousOwner=$before.Owner; Owner=$after.Owner; AccessRulesUnchanged=$true } | ConvertTo-Json | Set-Content -LiteralPath $resultPath -Encoding UTF8
} catch {
    @{ Success=$false; Error=$_.Exception.Message } | ConvertTo-Json | Set-Content -LiteralPath $resultPath -Encoding UTF8
    exit 1
}
