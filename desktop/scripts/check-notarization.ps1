$ErrorActionPreference = 'Stop'
$workflow = Get-Content -LiteralPath (Join-Path $PSScriptRoot '../../.github/workflows/desktop.yml')
$guard = @($workflow | Where-Object { $_.Contains("throw 'Configure one complete notarization credential set.'") })
if ($guard.Count -ne 1) { throw 'Expected one notarization credential guard in the release workflow.' }
# Execute the workflow's actual count guard without reading or creating credentials.
$validate = [scriptblock]::Create($guard[0].Trim())
foreach ($idCount in 0..3) {
  foreach ($apiCount in 0..3) {
    $refused = $false
    try { & $validate } catch { $refused = $true }
    $expected = -not (($idCount -eq 3 -and $apiCount -eq 0) -or ($idCount -eq 0 -and $apiCount -eq 3))
    if ($refused -ne $expected) { throw "Wrong notarization outcome: Apple ID count $idCount, API count $apiCount, refused $refused, expected $expected" }
  }
}
Write-Output 'Notarization guard: all 16 empty, partial, complete and dual-set cases passed.'
