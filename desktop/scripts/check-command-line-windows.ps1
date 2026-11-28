# Checks the cotal command the Cotal Windows installers set up, as a person meets it: install, a new
# terminal, an update, uninstall, and a cotal that was on PATH first still winning.
# It installs and uninstalls Cotal for the current user, so it runs only on a throwaway machine with
# no Cotal installed. It saves the user PATH first and always puts it back.
#
#   check-command-line-windows.ps1 -Setup <setup.exe> [-UpdateSetup <setup.exe>] [-Baseline <setup.exe>] [-Msi <.msi>] [-Expect present|absent] [-Disposable]
#
# -UpdateSetup runs in update mode (/UPDATE, as the app's updater does); by default -Setup runs again.
# -Baseline is an earlier release installed first and then updated, which must not have the command.
# -Expect absent checks a release from before the command existed.
param(
  [Parameter(Mandatory = $true)][string]$Setup,
  [string]$UpdateSetup,
  [string]$Baseline,
  [string]$Msi,
  [ValidateSet('present', 'absent')][string]$Expect = 'present',
  [switch]$Disposable,
  [string]$Out = $(if ($env:RUNNER_TEMP) { Join-Path $env:RUNNER_TEMP 'desktop-command-line' } else { Join-Path $PWD 'desktop-command-line' })
)
$ErrorActionPreference = 'Stop'
if (!$Disposable -and $env:RUNNER_ENVIRONMENT -ne 'github-hosted') { throw 'This installs and uninstalls Cotal for this user. Pass -Disposable, and only on a throwaway machine.' }
$Setup = (Resolve-Path -LiteralPath $Setup).Path
$UpdateSetup = if ($UpdateSetup) { (Resolve-Path -LiteralPath $UpdateSetup).Path } else { $Setup }
$root = Join-Path $env:LOCALAPPDATA 'Cotal'
$uninstallKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\Cotal'
if ((Test-Path -LiteralPath $uninstallKey) -or (Test-Path -LiteralPath (Join-Path $root 'cotal-desktop.exe'))) { throw "Cotal is already installed for this user in $root. Use a machine without it." }
New-Item -ItemType Directory -Force -Path $Out | Out-Null

function Read-UserPath {
  $key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Environment')
  try {
    if ($key -and ($key.GetValueNames() -contains 'Path')) { return @{ value = [string]$key.GetValue('Path', '', 'DoNotExpandEnvironmentNames'); kind = $key.GetValueKind('Path') } }
    return @{ value = $null; kind = $null }
  } finally { if ($key) { $key.Close() } }
}
function Write-UserPath($saved) {
  $key = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey('Environment')
  try { if ($null -eq $saved.value) { $key.DeleteValue('Path', $false) } else { $key.SetValue('Path', $saved.value, $saved.kind) } } finally { $key.Close() }
}
$original = Read-UserPath
$script:checks = 0
$script:failures = @()
function Check([string]$name, $actual, $expected) {
  $script:checks++
  if ("$actual" -ceq "$expected") { Write-Output "ok   $name" } else { $script:failures += $name; Write-Output "FAIL $name`n     expected [$expected]`n     got      [$actual]" }
}
# A new terminal gets PATH from the registry: the machine PATH, then the user PATH. This session's
# PATH is from before the install, so each check starts its shell with the registry's.
function Fresh([string]$shell, [string]$command) {
  $info = New-Object System.Diagnostics.ProcessStartInfo
  if ($shell -eq 'cmd') { $info.FileName = "$env:SystemRoot\System32\cmd.exe"; $info.Arguments = "/d /c $command" }
  else { $info.FileName = "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe"; $info.Arguments = "-NoLogo -NoProfile -NonInteractive -Command $command" }
  $info.UseShellExecute = $false; $info.RedirectStandardOutput = $true; $info.RedirectStandardError = $true; $info.CreateNoWindow = $true
  $info.EnvironmentVariables['Path'] = (@([Environment]::GetEnvironmentVariable('Path', 'Machine'), [Environment]::GetEnvironmentVariable('Path', 'User')) | Where-Object { $_ }) -join ';'
  $process = [System.Diagnostics.Process]::Start($info)
  $stdout = $process.StandardOutput.ReadToEndAsync(); $stderr = $process.StandardError.ReadToEndAsync()
  if (!$process.WaitForExit(120000)) { $process.Kill(); throw "$shell '$command' did not finish within 120 s" }
  return @{ code = $process.ExitCode; text = ($stdout.Result + $stderr.Result).Trim() }
}
function Entries([string]$dir) { @(([Environment]::GetEnvironmentVariable('Path', 'User') -split ';') | Where-Object { $_ -and $_.TrimEnd('\') -ieq $dir.TrimEnd('\') }).Count }
function Run-Installer([string]$file, [string[]]$arguments) {
  $process = Start-Process -FilePath $file -ArgumentList $arguments -Wait -PassThru
  if ($process.ExitCode -notin @(0, 3010)) { throw "$file $($arguments -join ' ') exited $($process.ExitCode)" }
}
function Uninstall-Nsis {
  $uninstaller = Join-Path $root 'uninstall.exe'
  Run-Installer $uninstaller @('/S', "_?=$root")
  Remove-Item -LiteralPath $root -Recurse -Force -ErrorAction SilentlyContinue
}
function Installed([string]$when, [string]$directory, [string]$firstCotal) {
  $bin = Join-Path $directory 'bin'
  $version = (Get-Content -Raw -LiteralPath (Join-Path $directory 'runtime\package.json') | ConvertFrom-Json).version
  Check "the user PATH names $bin once after $when" (Entries $bin) 1
  $userPath = @([Environment]::GetEnvironmentVariable('Path', 'User') -split ';' | Where-Object { $_ })
  Check "the app's bin folder is the last user PATH entry after $when" $userPath[-1].TrimEnd('\') $bin
  Check "the bin folder holds only cotal.cmd after $when" ((Get-ChildItem -LiteralPath $bin -Force | ForEach-Object Name) -join ',') 'cotal.cmd'
  $where = Fresh 'cmd' 'where cotal'
  $found = @($where.text -split "`r?`n" | ForEach-Object { $_.ToLowerInvariant() })
  Check "where.exe in a new Command Prompt lists cotal first from $firstCotal after $when" $found[0] $firstCotal.ToLowerInvariant()
  Check "where.exe in a new Command Prompt lists the app's cotal.cmd after $when" ($found -contains (Join-Path $bin 'cotal.cmd').ToLowerInvariant()) $true
  if ($firstCotal -eq (Join-Path $bin 'cotal.cmd')) {
    $cmd = Fresh 'cmd' 'cotal --version'
    Check "cotal --version in a new Command Prompt after $when" "$($cmd.code) $($cmd.text)" "0 cotal-ai $version"
    $ps = Fresh 'powershell' 'cotal --version; exit $LASTEXITCODE'
    Check "cotal --version in a new PowerShell after $when" "$($ps.code) $($ps.text)" "0 cotal-ai $version"
    $refused = Fresh 'cmd' 'cotal no-such-command'
    Check "a failing cotal command keeps its non-zero exit code after $when" ($refused.code -ne 0) $true
  }
}
function Removed([string]$when, [string]$directory) {
  Check "the user PATH no longer names the bin folder after $when" (Entries (Join-Path $directory 'bin')) 0
  $where = Fresh 'cmd' 'where cotal'
  Check "a new Command Prompt finds no cotal after $when" $where.code 1
}

$results = @()
try {
  if ($Expect -eq 'absent') {
    Run-Installer $Setup @('/S')
    Check 'the release has no bin folder' (Test-Path -LiteralPath (Join-Path $root 'bin')) $false
    Removed 'installing the release' $root
    Check 'the release leaves the user PATH as it was' (Read-UserPath).value $original.value
    Uninstall-Nsis
  } else {
    if ($Baseline) {
      Run-Installer (Resolve-Path -LiteralPath $Baseline).Path @('/S')
      Removed 'installing the earlier release' $root
      Run-Installer $Setup @('/S', '/UPDATE')
      Installed 'updating the earlier release' $root (Join-Path $root 'bin\cotal.cmd')
    } else {
      Run-Installer $Setup @('/S')
      Installed 'install' $root (Join-Path $root 'bin\cotal.cmd')
    }
    Run-Installer $UpdateSetup @('/S', '/UPDATE')
    Installed 'update' $root (Join-Path $root 'bin\cotal.cmd')
    Uninstall-Nsis
    Removed 'uninstall' $root
    Check 'uninstall puts the user PATH back exactly' (Read-UserPath).value $original.value

    # A cotal already on PATH (npm puts its launchers in a user PATH folder) keeps running. This
    # PATH ends with a semicolon, as Windows writes its default one, and must come back exactly.
    $other = Join-Path $Out 'other-cotal'
    New-Item -ItemType Directory -Force -Path $other | Out-Null
    Set-Content -LiteralPath (Join-Path $other 'cotal.cmd') -Value '@echo other-cotal' -Encoding ascii
    $withOther = @{ value = $(if ($original.value) { "$($original.value.TrimEnd(';'));$other;" } else { "$other;" }); kind = $(if ($original.kind) { $original.kind } else { [Microsoft.Win32.RegistryValueKind]::ExpandString }) }
    Write-UserPath $withOther
    Run-Installer $Setup @('/S')
    Installed 'install with another cotal on PATH' $root (Join-Path $other 'cotal.cmd')
    Check 'the other cotal still runs in a new Command Prompt' (Fresh 'cmd' 'cotal').text 'other-cotal'
    Uninstall-Nsis
    Check 'uninstall puts a user PATH ending in a semicolon back exactly, the other cotal included' (Read-UserPath).value $withOther.value
    Write-UserPath $original

    if ($Msi) {
      $log = Join-Path $Out 'msi-install.log'
      Run-Installer 'msiexec.exe' @('/i', "`"$((Resolve-Path -LiteralPath $Msi).Path)`"", '/qn', '/norestart', '/l*v', "`"$log`"")
      $directory = Join-Path $env:ProgramFiles 'Cotal'
      Installed 'MSI install' $directory (Join-Path $directory 'bin\cotal.cmd')
      Run-Installer 'msiexec.exe' @('/x', "`"$((Resolve-Path -LiteralPath $Msi).Path)`"", '/qn', '/norestart', '/l*v', "`"$(Join-Path $Out 'msi-uninstall.log')`"")
      Removed 'MSI uninstall' $directory
      Check 'MSI uninstall puts the user PATH back exactly' (Read-UserPath).value $original.value
    }
  }
} finally {
  $restored = (Read-UserPath).value -cne $original.value
  if ($restored) { Write-UserPath $original }
  $summary = @{ expect = $Expect; checks = $script:checks; failures = $script:failures; userPathRestoredByScript = $restored }
  $summary | ConvertTo-Json -Depth 4 | Set-Content (Join-Path $Out 'result.json')
}
Write-Output "$($script:checks - $script:failures.Count)/$($script:checks) checks passed"
if ($script:failures.Count) { exit 1 }
