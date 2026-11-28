param([switch]$Prepare)
$ErrorActionPreference = 'Stop'
if ($env:RUNNER_ENVIRONMENT -ne 'github-hosted' -and $Prepare) { throw 'Path changes require a disposable hosted runner.' }
$tools = @('node.exe', 'nodejs.exe', 'npm.cmd', 'npm.exe', 'npx.cmd', 'brew.exe', 'choco.exe', 'winget.exe', 'cotal.exe', 'cotal.cmd')
function Get-CleanPath([string]$Value) {
  @($Value -split ';' | Where-Object {
    if (-not $_) { return $false }
    $dir = [Environment]::ExpandEnvironmentVariables($_)
    [IO.Path]::IsPathRooted($dir) -and -not ($dir -match '(?i)nodejs|nvm|npm|chocolatey|WinGet|WindowsApps|homebrew|\\node\\') -and
      -not (@($tools | Where-Object { Test-Path (Join-Path $dir $_) }).Count)
  }) -join ';'
}
if ($Prepare) {
  foreach ($scope in @('Machine', 'User')) {
    $path = [Environment]::GetEnvironmentVariable('Path', $scope)
    [Environment]::SetEnvironmentVariable('Path', (Get-CleanPath $path), $scope)
  }
  $env:Path = Get-CleanPath $env:Path
  foreach ($dir in @("$env:ProgramFiles\nodejs", "$env:ProgramData\chocolatey", "$env:APPDATA\npm", "$env:LOCALAPPDATA\Microsoft\WinGet")) {
    if (!(Test-Path -LiteralPath $dir)) { continue }
    $label = Split-Path $dir -Leaf
    try { Rename-Item -LiteralPath $dir -NewName "$label.disabled-for-cotal-test"; Write-Host "Disabled $label directory." }
    catch { Write-Host "Could not rename $label directory. It must be absent from PATH." }
  }
}
foreach ($scope in @('Machine', 'User', 'Process')) {
  $path = [Environment]::GetEnvironmentVariable('Path', $scope)
  if ((Get-CleanPath $path) -ne [string]$path) { throw "The $scope PATH still has a tool directory." }
}
foreach ($tool in $tools) {
  if (Get-Command $tool -ErrorAction SilentlyContinue) { throw "$tool still resolves." }
}
