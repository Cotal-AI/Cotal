param([switch]$LoginScopeOnly)

$ErrorActionPreference = 'Stop'
if ($env:RUNNER_ENVIRONMENT -ne 'github-hosted') { throw 'This installs only on disposable hosted runners.' }
$out = Join-Path $env:RUNNER_TEMP 'desktop-presence'
New-Item -ItemType Directory -Path $out -Force | Out-Null
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type @'
using System;
using System.Collections.Generic;
using System.Text;
using System.Runtime.InteropServices;
public static class PresenceWindow {
  [DllImport("advapi32.dll", SetLastError=true)] static extern bool OpenProcessToken(IntPtr process, uint access, out IntPtr token);
  [DllImport("advapi32.dll", SetLastError=true)] static extern bool GetTokenInformation(IntPtr token, int kind, out int value, int size, out int written);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
  public static bool IsElevated(IntPtr process) {
    IntPtr token;
    if (!OpenProcessToken(process, 8, out token)) throw new System.ComponentModel.Win32Exception();
    try {
      int value, written;
      if (!GetTokenInformation(token, 20, out value, sizeof(int), out written)) throw new System.ComponentModel.Win32Exception();
      return value != 0;
    } finally { CloseHandle(token); }
  }
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll", EntryPoint="GetWindowLongW")] public static extern int GetWindowLong(IntPtr h, int index);
  [DllImport("user32.dll")] public static extern IntPtr GetWindow(IntPtr h, uint command);
  [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr h, uint msg, IntPtr w, IntPtr l);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] private static extern IntPtr FindWindow(string cls, string title);
  // PowerShell coerces null string arguments to empty strings. Win32 needs null
  // to match any class/title, so keep the optional pointers inside typed C#.
  public static IntPtr MainWindow() { return FindWindow(null, "Cotal"); }
  public static IntPtr Taskbar() { return FindWindow("Shell_TrayWnd", null); }
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  public delegate bool EnumWindowProc(IntPtr h, IntPtr data);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowProc callback, IntPtr data);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder text, int count);
  public static string[] DescribeWindows() {
    var rows = new List<string>();
    EnumWindows((h, data) => {
      uint pid; GetWindowThreadProcessId(h, out pid);
      var title = new StringBuilder(512); GetWindowText(h, title, title.Capacity);
      rows.Add(String.Format("{0}\t{1}\t{2}\t{3}", pid, h.ToInt64(), IsWindowVisible(h), title));
      return true;
    }, IntPtr.Zero);
    return rows.ToArray();
  }
}
'@
function Screenshot($name) {
  $bounds = [Windows.Forms.SystemInformation]::VirtualScreen
  $bitmap = New-Object Drawing.Bitmap $bounds.Width, $bounds.Height
  $graphics = [Drawing.Graphics]::FromImage($bitmap)
  try {
    $graphics.CopyFromScreen($bounds.Location, [Drawing.Point]::Empty, $bounds.Size)
    $bitmap.Save((Join-Path $out $name), [Drawing.Imaging.ImageFormat]::Png)
  } finally { $graphics.Dispose(); $bitmap.Dispose() }
}
function Wait-Window($path) {
  for ($i = 0; $i -lt 40; $i++) {
    $processes = @(Get-Process 'cotal-desktop' -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq $path })
    $handle = [PresenceWindow]::MainWindow()
    [uint32]$windowPid = 0
    if ($handle -ne [IntPtr]::Zero) { [PresenceWindow]::GetWindowThreadProcessId($handle, [ref]$windowPid) | Out-Null }
    @{ second = $i; processes = @($processes | Select-Object Id, Path, MainWindowTitle); matchingWindow = $handle.ToInt64(); windowPid = $windowPid } | ConvertTo-Json -Depth 4 -Compress | Add-Content (Join-Path $out 'window-wait.jsonl')
    if ($processes.Count -eq 1 -and $windowPid -eq $processes[0].Id -and [PresenceWindow]::IsWindowVisible($handle)) {
      $processes[0] | Add-Member -NotePropertyName PresenceHandle -NotePropertyValue $handle
      return $processes[0]
    }
    Start-Sleep 1
  }
  [PresenceWindow]::DescribeWindows() | Set-Content (Join-Path $out 'window-timeout.txt')
  Screenshot 'window-timeout.png'
  throw 'Cotal did not present one top-level window.'
}
function Shortcuts($path) {
  $roots = @([Environment]::GetFolderPath('Desktop'), [Environment]::GetFolderPath('CommonDesktopDirectory'), [Environment]::GetFolderPath('StartMenu'), [Environment]::GetFolderPath('CommonStartMenu'))
  $links = @($roots | Where-Object { Test-Path $_ } | ForEach-Object { Get-ChildItem $_ -Filter 'Cotal.lnk' -Recurse })
  if ($links.Count -lt 2) { throw 'Start menu and desktop shortcuts are required.' }
  $shell = New-Object -ComObject Shell.Application
  $wsh = New-Object -ComObject WScript.Shell
  foreach ($link in $links) {
    if ($wsh.CreateShortcut($link.FullName).TargetPath -ne $path) { throw "Wrong shortcut target: $($link.FullName)" }
    $item = $shell.Namespace($link.DirectoryName).ParseName($link.Name)
    if ($item.ExtendedProperty('System.AppUserModel.ID') -ne 'ai.cotal.desktop') { throw "Wrong shortcut identity: $($link.FullName)" }
  }
  return $links.FullName
}
function Check-LoginScope($path) {
  $userRun = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'
  $machineRun = 'HKLM:\Software\Microsoft\Windows\CurrentVersion\Run'
  function Read-Login($key) {
    $registry = Get-Item -LiteralPath $key
    try { $registry.GetValue('Cotal', $null) } finally { $registry.Dispose() }
  }
  if ($null -ne (Read-Login $userRun) -or $null -ne (Read-Login $machineRun)) { throw 'Expected a fresh Windows runner with no Cotal login values.' }
  $prefs = Join-Path $env:APPDATA 'ai.cotal.desktop\presence.json'
  if (Test-Path -LiteralPath $prefs) { throw 'Expected fresh desktop preferences before the login scope check.' }
  $entry = Join-Path (Split-Path $path) 'runtime\dist\cotal.js'
  $original = "$entry.login-proof-original"
  $app = $null
  Move-Item -LiteralPath $entry -Destination $original
  try {
    # The installed app still runs its real status bridge and Windows login code.
    # Supply just the daemon's connected reply without signing in or installing a service.
    Set-Content -LiteralPath $entry -Encoding utf8 -Value @'
let input = '';
process.stdin.setEncoding('utf8').on('data', chunk => {
  input += chunk;
  if (!input.includes('\n')) return;
  const request = JSON.parse(input.slice(0, input.indexOf('\n')));
  const result = request.op === 'about'
    ? { version: '1.0.0', platform: 'win32', arch: 'x64', machine: 'Login scope test', memoryBytes: 8589934592 }
    : request.op === 'status'
      ? { version: '1.0.0', state: 'ready', account: { hostSupport: 'supported', mode: 'account', lastRegistration: '2026-01-01T00:00:00Z', spaces: [] } }
      : {};
  process.stdout.write(JSON.stringify({ v: 1, event: 'result', ok: true, result }) + '\n', () => process.exit(0));
});
'@
    $app = Start-Process -FilePath $path -PassThru
    $elevated = [PresenceWindow]::IsElevated($app.Handle)
    if (!$elevated) { throw 'The installed app does not have an elevated process token.' }
    $deadline = [DateTime]::UtcNow.AddSeconds(45)
    do {
      $app.Refresh()
      if ($app.HasExited) { throw "Installed app exited before registering login ($($app.ExitCode))." }
      $currentUser = Read-Login $userRun
      $localMachine = Read-Login $machineRun
      $connected = (Test-Path -LiteralPath $prefs) -and ((Get-Content -Raw -LiteralPath $prefs | ConvertFrom-Json).connected -eq $true)
      if ($connected -and ($currentUser -or $localMachine)) { break }
      Start-Sleep -Milliseconds 250
    } while ([DateTime]::UtcNow -lt $deadline)
    $receipt = @{ path = $path; appPid = $app.Id; elevated = $elevated; connected = $connected; HKCU = $currentUser; HKLM = $localMachine } | ConvertTo-Json -Compress
    $receipt | Set-Content (Join-Path $out 'login-scope.json')
    Write-Host $receipt
    if (!$connected -or $currentUser -ne "`"$path`" --background" -or $null -ne $localMachine) {
      throw 'An elevated connected app must register the installed executable in HKCU only.'
    }
  } finally {
    if ($app -and !$app.HasExited) { Stop-Process -Id $app.Id; $app.WaitForExit() }
    if ($null -ne (Read-Login $userRun)) { Remove-ItemProperty -LiteralPath $userRun -Name Cotal }
    if ($null -ne (Read-Login $machineRun)) { Remove-ItemProperty -LiteralPath $machineRun -Name Cotal }
    Remove-Item -LiteralPath $prefs -ErrorAction SilentlyContinue
    Move-Item -LiteralPath $original -Destination $entry -Force
  }
}
function Read-ExplorerRunningApps($taskbarHandle) {
  try {
    if (!('ExplorerTaskbarAccessibility' -as [type])) {
      $accessibility = [Reflection.Assembly]::Load('Accessibility')
      Add-Type -Path (Join-Path $PSScriptRoot 'windows-taskbar-accessibility.cs') -ReferencedAssemblies @($accessibility.Location, 'System.Collections.dll')
    }
    $toolbar = [ExplorerTaskbarAccessibility]::RunningApps($taskbarHandle)
    return @{ toolbar = $toolbar.ToInt64(); buttons = @([ExplorerTaskbarAccessibility]::Buttons($toolbar)); error = $null }
  } catch {
    return @{ toolbar = $null; buttons = @(); error = $_.Exception.GetBaseException().Message }
  }
}
$results = @()
$taskbarMissing = @()
foreach ($kind in $(if ($LoginScopeOnly) { @('nsis') } else { @('nsis', 'msi') })) {
  $owned = $null
  $launch = $null
  $installed = $false
  try {
    if ($kind -eq 'nsis') {
      $installer = Get-ChildItem desktop/src-tauri/target/release/bundle/nsis/*.exe | Select-Object -First 1
      $directory = Join-Path $env:LOCALAPPDATA 'Cotal'
      $p = Start-Process -FilePath $installer.FullName -ArgumentList @('/S', "/D=$directory") -Wait -PassThru
    } else {
      $installer = Get-ChildItem desktop/src-tauri/target/release/bundle/msi/*.msi | Select-Object -First 1
      $directory = Join-Path $env:ProgramFiles 'Cotal'
      $p = Start-Process msiexec.exe -ArgumentList @('/i', "`"$($installer.FullName)`"", '/qn', '/norestart', '/l*v', "`"$out/msi-install.log`"") -Wait -PassThru
    }
    if ($p.ExitCode -notin @(0, 3010)) { throw "$kind install exited $($p.ExitCode)" }
    $installed = $true
    $path = Join-Path $directory 'cotal-desktop.exe'
    if (!(Test-Path $path)) { throw 'Installed executable missing.' }
    if ($kind -eq 'nsis') { Check-LoginScope $path }
    if ($LoginScopeOnly) {
      $uninstaller = Get-ChildItem $directory -Filter '*uninstall*.exe' | Select-Object -First 1
      $p = Start-Process $uninstaller.FullName -ArgumentList @('/S', "_?=$directory") -Wait -PassThru
      if ($p.ExitCode -notin @(0, 3010)) { throw "nsis uninstall exited $($p.ExitCode)" }
      $installed = $false
      return
    }
    $links = @(Shortcuts $path)
    $links | Set-Content (Join-Path $out "$kind-shortcuts.txt")
    $beforeTaskbar = [PresenceWindow]::Taskbar()
    $beforeLegacy = Read-ExplorerRunningApps $beforeTaskbar
    $launch = Start-Process -FilePath $path -PassThru -RedirectStandardOutput (Join-Path $out "$kind-stdout.log") -RedirectStandardError (Join-Path $out "$kind-stderr.log")
    $launch.Id | Set-Content (Join-Path $out "$kind-launched-pid.txt")
    $owned = Wait-Window $path
    $handle = $owned.PresenceHandle
    if (![PresenceWindow]::IsWindowVisible($handle)) { throw 'Cotal window is hidden.' }
    $style = [PresenceWindow]::GetWindowLong($handle, -20)
    @{ handle = $handle.ToInt64(); style = $style; owner = [PresenceWindow]::GetWindow($handle, 4).ToInt64(); title = $owned.MainWindowTitle } | ConvertTo-Json | Set-Content (Join-Path $out "$kind-window.json")
    Start-Sleep 3
    Screenshot "$kind-taskbar.png"
    $taskbarHandle = [PresenceWindow]::Taskbar()
    if ($taskbarHandle -eq [IntPtr]::Zero) { throw 'Explorer taskbar is unavailable in this runner session.' }
    $taskbar = [System.Windows.Automation.AutomationElement]::FromHandle($taskbarHandle)
    $items = $taskbar.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition)
    $names = @($items | ForEach-Object { $_.Current.Name })
    $names | Set-Content (Join-Path $out "$kind-taskbar-elements.txt")
    $taskbarNamed = [bool]($names | Where-Object { $_ -match '^Cotal(?:\b|$)' })
    $taskbarNameSource = if ($taskbarNamed) { 'uia-name' } else { $null }
    $afterLegacy = Read-ExplorerRunningApps $taskbarHandle
    $beforeNamed = @($beforeLegacy.buttons | Where-Object { $_.Name -match '^Cotal(?:\b|$)' })
    $afterNamed = @($afterLegacy.buttons | Where-Object { $_.Name -match '^Cotal(?:\b|$)' })
    if (!$taskbarNamed -and !$beforeLegacy.error -and !$afterLegacy.error -and
        $beforeTaskbar -eq $taskbarHandle -and $beforeLegacy.toolbar -eq $afterLegacy.toolbar -and
        $beforeNamed.Count -eq 0 -and $afterNamed.Count -eq 1) {
      $taskbarNamed = $true
      $taskbarNameSource = 'explorer-msaa-name'
    }
    @{ before = $beforeLegacy; after = $afterLegacy; source = $taskbarNameSource } | ConvertTo-Json -Depth 6 | Set-Content (Join-Path $out "$kind-taskbar-accessibility.json")
    if (!$taskbarNamed) {
      $taskbarMissing += $kind
      Write-Warning 'Not proven: the Cotal taskbar button accessibility name. See the recorded Explorer UI Automation names and legacy reads. Screenshot and independent window, shortcut identity, lifecycle and uninstall checks are retained, not substituted for this name lookup.'
    }
    Start-Process -FilePath $path | Out-Null
    Start-Sleep 3
    $instances = @(Get-Process 'cotal-desktop' -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq $path })
    if ($instances.Count -ne 1 -or $instances[0].Id -ne $owned.Id) { throw 'Second launch did not reuse the existing process.' }
    'Second launch reused the existing process.' | Set-Content (Join-Path $out "$kind-single-instance.txt")
    [PresenceWindow]::PostMessage($handle, 0x0010, [IntPtr]::Zero, [IntPtr]::Zero) | Out-Null
    Start-Sleep 1
    [PresenceWindow]::PostMessage($handle, 0x0010, [IntPtr]::Zero, [IntPtr]::Zero) | Out-Null
    Start-Sleep 2
    if ([PresenceWindow]::IsWindowVisible($handle)) { throw 'Close did not hide to the tray.' }
    Start-Process -FilePath $path | Out-Null
    Start-Sleep 2
    if (![PresenceWindow]::IsWindowVisible($handle)) { throw 'Second launch did not restore hidden window.' }
    'Close hid the window and second launch restored it.' | Set-Content (Join-Path $out "$kind-hide-restore.txt")
    Stop-Process -Id $owned.Id
    Wait-Process -Id $owned.Id -ErrorAction SilentlyContinue
    $owned = $null
    # The disconnected welcome cannot enable startup. Seed the real plugin's exact Run entry to test uninstaller cleanup separately.
    $run = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'
    New-ItemProperty -Path $run -Name Cotal -PropertyType String -Value "`"$path`" --background" -Force | Out-Null
    if ($kind -eq 'nsis') {
      $uninstaller = Get-ChildItem $directory -Filter '*uninstall*.exe' | Select-Object -First 1
      $p = Start-Process $uninstaller.FullName -ArgumentList @('/S', "_?=$directory") -Wait -PassThru
    } else {
      $p = Start-Process msiexec.exe -ArgumentList @('/x', "`"$($installer.FullName)`"", '/qn', '/norestart', '/l*v', "`"$out/msi-uninstall.log`"") -Wait -PassThru
    }
    if ($p.ExitCode -notin @(0, 3010)) { throw "$kind uninstall exited $($p.ExitCode)" }
    foreach ($link in $links) { if (Test-Path $link) { throw "Shortcut remains: $link" } }
    if (Get-ItemProperty -Path $run -Name Cotal -ErrorAction SilentlyContinue) { throw 'App login entry remains after uninstall.' }
    $installed = $false
    $checks = @('shortcuts', 'shortcut-aumid', 'visible-window', 'single-instance', 'hide', 'restore', 'uninstall-shortcuts', 'uninstall-login')
    if ($taskbarNamed) { $checks += 'explorer-taskbar-button' }
    $results += @{ installer = $kind; result = $(if ($taskbarNamed) { 'passed' } else { 'passed-with-taskbar-name-unproven' }); checks = $checks; taskbarNameProven = $taskbarNamed; taskbarNameSource = $taskbarNameSource }
    @{ platform = 'Windows'; results = $results } | ConvertTo-Json -Depth 6 | Set-Content (Join-Path $out 'result.json')
  } finally {
    if ($launch -and (Get-Process -Id $launch.Id -ErrorAction SilentlyContinue)) {
      Stop-Process -Id $launch.Id -ErrorAction SilentlyContinue
    }
    if ($owned -and !(Get-Process -Id $owned.Id -ErrorAction SilentlyContinue).HasExited) { Stop-Process -Id $owned.Id -ErrorAction SilentlyContinue }
    if ($installed) { Write-Warning "$kind cleanup is incomplete. Disposable runner owns remaining installation." }
  }
}
@{ platform = 'Windows'; results = $results } | ConvertTo-Json -Depth 6 | Set-Content (Join-Path $out 'result.json')
if ($taskbarMissing.Count) { Write-Warning "Taskbar accessibility name remains unproven for: $($taskbarMissing -join ', '). No other acceptance check was weakened." }
