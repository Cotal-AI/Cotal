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

# The build step must leave an unused credential set absent: Tauri picks the Apple ID login whenever its three
# variables exist, even blank. Run the workflow's actual removal line in a child that inherits blank Apple ID
# variables beside an API set, as GitHub passes them, and list what a process it starts (Tauri's place) still sees.
if ($IsWindows) { Write-Output 'Empty Apple variables: notarization runs only on macOS; not checked on Windows.'; exit 0 }
$drop = @($workflow | Where-Object { $_.Contains('Get-ChildItem Env:APPLE_* | Where-Object { -not $_.Value } | Remove-Item') })
if ($drop.Count -ne 1) { throw 'Expected one removal of empty Apple variables in the release workflow.' }
$pwsh = (Get-Process -Id $PID).Path
function ConvertTo-Encoded([string]$command) { [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($command)) }
$probe = ConvertTo-Encoded "[Environment]::GetEnvironmentVariables().Keys | Where-Object { `$_ -like 'APPLE_*' } | Sort-Object"
function Get-SeenNames([string]$before) {
  $psi = [Diagnostics.ProcessStartInfo]::new($pwsh)
  $psi.ArgumentList.Add('-NoProfile'); $psi.ArgumentList.Add('-EncodedCommand')
  $psi.ArgumentList.Add((ConvertTo-Encoded "$before; & '$pwsh' -NoProfile -EncodedCommand $probe"))
  foreach ($name in @(Get-ChildItem Env:APPLE_* | ForEach-Object Name)) { $null = $psi.Environment.Remove($name) }
  foreach ($name in 'APPLE_ID', 'APPLE_PASSWORD', 'APPLE_TEAM_ID') { $psi.Environment[$name] = '' }
  foreach ($name in 'APPLE_API_ISSUER', 'APPLE_API_KEY') { $psi.Environment[$name] = 'set' }
  $psi.RedirectStandardOutput = $true
  $child = [Diagnostics.Process]::Start($psi)
  $seen = $child.StandardOutput.ReadToEnd(); $child.WaitForExit()
  if ($child.ExitCode -ne 0) { throw "The probe process exited with $($child.ExitCode)." }
  (@($seen -split '\r?\n' | Where-Object { $_ }) -join ',')
}
$baseline = Get-SeenNames '$null'
if ($baseline -ne 'APPLE_API_ISSUER,APPLE_API_KEY,APPLE_ID,APPLE_PASSWORD,APPLE_TEAM_ID') { throw "Blank Apple variables did not reach the probe: $baseline" }
$after = Get-SeenNames $drop[0].Trim()
if ($after -ne 'APPLE_API_ISSUER,APPLE_API_KEY') { throw "Blank Apple variables survived the build step's removal: $after" }
Write-Output "Empty Apple variables: 3 blank removed, 2 set kept ($after)."
