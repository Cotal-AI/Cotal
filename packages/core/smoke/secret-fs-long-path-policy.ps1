$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $false
if ($env:RUNNER_ENVIRONMENT -ne 'github-hosted') { throw 'Policy proof requires a disposable GitHub-hosted Windows runner.' }
if ($env:SUITE -ne 'packages/core/smoke/secret-fs-long-path.smoke.ts') { throw 'Policy proof accepts only the secret ACL long-path suite.' }
$key = 'HKLM:\SYSTEM\CurrentControlSet\Control\FileSystem'
$name = 'LongPathsEnabled'
$original = Get-ItemPropertyValue -LiteralPath $key -Name $name
if ($original -notin @(0, 1)) { throw "Unexpected LongPathsEnabled value: $original" }
Write-Output "Image=$env:ImageOS LongPathsEnabled=$original"
$failed = $false
try {
    $env:COTAL_SECRET_LONG_PATH_POLICY = [string]$original
    # pnpm launches a fresh Node test process after the policy read or change.
    pnpm exec tsx $env:SUITE
    $imageExit = $LASTEXITCODE
    Write-Output "Image-policy=$original SuiteExit=$imageExit"
    if ($imageExit -ne 0) { $failed = $true }
    if ($original -eq 1) {
        Set-ItemProperty -LiteralPath $key -Name $name -Value 0
        if ((Get-ItemPropertyValue -LiteralPath $key -Name $name) -ne 0) { throw 'Default-policy write did not persist.' }
        $env:COTAL_SECRET_LONG_PATH_POLICY = '0'
        pnpm exec tsx $env:SUITE
        $defaultExit = $LASTEXITCODE
        Write-Output "Default-policy=0 SuiteExit=$defaultExit"
        if ($defaultExit -ne 0) { $failed = $true }
    }
} finally {
    Set-ItemProperty -LiteralPath $key -Name $name -Value $original
    Remove-Item Env:\COTAL_SECRET_LONG_PATH_POLICY -ErrorAction SilentlyContinue
    $restored = Get-ItemPropertyValue -LiteralPath $key -Name $name
    Write-Output "Restored LongPathsEnabled=$restored"
    if ($restored -ne $original) { throw 'Original long-path policy was not restored.' }
}
if ($failed) { throw 'Native secret ACL path proof failed. Inspect each policy result.' }
