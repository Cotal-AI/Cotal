param([string]$Candidate, [string]$Old, [string]$Broker)
$ErrorActionPreference = 'Stop'
if ($env:RUNNER_ENVIRONMENT -ne 'github-hosted') { throw 'This test changes only a disposable hosted runner.' }
$work = Join-Path $env:RUNNER_TEMP ([guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $work | Out-Null
try {
  Copy-Item (Get-Command node.exe).Source (Join-Path $work 'test-driver.exe')
  Get-ChildItem Env:COTAL_* | Remove-Item
  Remove-Item Env:GH_TOKEN -ErrorAction SilentlyContinue
  $env:TEMP = $work
  $env:TMP = $work
  $env:DO_NOT_TRACK = '1'
  $env:DESKTOP_DISPOSABLE = '1'
  & (Join-Path $PSScriptRoot 'clean-install-windows-path.ps1') -Prepare
  if (!$Old) { $Old = '-' }
  & (Join-Path $work 'test-driver.exe') '--import' 'tsx' (Join-Path $PSScriptRoot 'clean-install.mjs') $Candidate $Old $Broker
  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
} finally {
  Remove-Item -LiteralPath $work -Recurse -Force
}
