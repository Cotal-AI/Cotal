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
$results = @()
$taskbarMissing = @()
foreach ($kind in @('nsis', 'msi')) {
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
    $links = @(Shortcuts $path)
    $links | Set-Content (Join-Path $out "$kind-shortcuts.txt")
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
    if (!$taskbarNamed) {
      $taskbarMissing += $kind
      Write-Warning 'Not proven: the Cotal taskbar button accessibility name. Explorer exposes unnamed running-app children. Screenshot and independent window, shortcut identity, lifecycle and uninstall checks are retained, not substituted for this name lookup.'
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
    $results += @{ installer = $kind; result = $(if ($taskbarNamed) { 'passed' } else { 'passed-with-taskbar-name-unproven' }); checks = $checks; taskbarNameProven = $taskbarNamed }
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
