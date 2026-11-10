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
using System.Runtime.InteropServices;
public static class PresenceWindow {
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll", EntryPoint="GetWindowLongW")] public static extern int GetWindowLong(IntPtr h, int index);
  [DllImport("user32.dll")] public static extern IntPtr GetWindow(IntPtr h, uint command);
  [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr h, uint msg, IntPtr w, IntPtr l);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern IntPtr FindWindow(string cls, string title);
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
    if ($processes.Count -eq 1 -and $processes[0].MainWindowHandle -ne 0) { return $processes[0] }
    Start-Sleep 1
  }
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
foreach ($kind in @('nsis', 'msi')) {
  $owned = $null
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
    Start-Process -FilePath $path | Out-Null
    $owned = Wait-Window $path
    $handle = $owned.MainWindowHandle
    if (![PresenceWindow]::IsWindowVisible($handle)) { throw 'Cotal window is hidden.' }
    $style = [PresenceWindow]::GetWindowLong($handle, -20)
    @{ handle = $handle.ToInt64(); style = $style; owner = [PresenceWindow]::GetWindow($handle, 4).ToInt64(); title = $owned.MainWindowTitle } | ConvertTo-Json | Set-Content (Join-Path $out "$kind-window.json")
    Start-Sleep 3
    Screenshot "$kind-taskbar.png"
    $taskbarHandle = [PresenceWindow]::FindWindow('Shell_TrayWnd', $null)
    if ($taskbarHandle -eq [IntPtr]::Zero) { throw 'Explorer taskbar is unavailable in this runner session.' }
    $taskbar = [System.Windows.Automation.AutomationElement]::FromHandle($taskbarHandle)
    $items = $taskbar.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition)
    $names = @($items | ForEach-Object { $_.Current.Name })
    $names | Set-Content (Join-Path $out "$kind-taskbar-elements.txt")
    if (!($names | Where-Object { $_ -match '^Cotal(?:\b|$)' })) { throw 'Explorer has no Cotal taskbar button.' }
    Start-Process -FilePath $path | Out-Null
    Start-Sleep 3
    $instances = @(Get-Process 'cotal-desktop' -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq $path })
    if ($instances.Count -ne 1 -or $instances[0].Id -ne $owned.Id) { throw 'Second launch did not reuse the existing process.' }
    [PresenceWindow]::PostMessage($handle, 0x0010, [IntPtr]::Zero, [IntPtr]::Zero) | Out-Null
    Start-Sleep 1
    [PresenceWindow]::PostMessage($handle, 0x0010, [IntPtr]::Zero, [IntPtr]::Zero) | Out-Null
    Start-Sleep 2
    if ([PresenceWindow]::IsWindowVisible($handle)) { throw 'Close did not hide to the tray.' }
    Start-Process -FilePath $path | Out-Null
    Start-Sleep 2
    if (![PresenceWindow]::IsWindowVisible($handle)) { throw 'Second launch did not restore hidden window.' }
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
    $results += @{ installer = $kind; result = 'passed'; checks = @('shortcuts', 'shortcut-aumid', 'visible-window', 'explorer-taskbar-button', 'single-instance', 'hide', 'restore', 'uninstall-shortcuts', 'uninstall-login') }
  } finally {
    if ($owned -and !(Get-Process -Id $owned.Id -ErrorAction SilentlyContinue).HasExited) { Stop-Process -Id $owned.Id -ErrorAction SilentlyContinue }
    if ($installed) { Write-Warning "$kind cleanup is incomplete. Disposable runner owns remaining installation." }
  }
}
@{ platform = 'Windows'; results = $results } | ConvertTo-Json -Depth 6 | Set-Content (Join-Path $out 'result.json')
