# Native UI driver. Run in the interactive Windows desktop that owns Explorer.
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$Binary,
    [Parameter(Mandatory = $true)][ValidateSet('describe', 'close-window', 'settings', 'quit', 'login-entry', 'connected-view', 'settings-back', 'disable-login')][string]$Action,
    [ValidateRange(1, 2147483647)][int]$AppPid,
    [ValidateRange(1, 2147483647)][int]$DaemonPid,
    [string]$DaemonStart
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$diagnostics = [System.Collections.Generic.List[object]]::new()
$candidates = @()
$appCandidates = @()
$serviceLauncher = $null
try {
    if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT) { throw 'Native Windows desktop required.' }
    $expected = (Get-Item -LiteralPath $Binary).FullName
    if (!(Test-Path -LiteralPath $expected -PathType Leaf)) { throw 'Binary must be an existing executable file.' }
    Add-Type -AssemblyName WindowsBase
    Add-Type -AssemblyName UIAutomationClient
    Add-Type -AssemblyName UIAutomationTypes
    Add-Type @'
using System;
using System.Collections.Generic;
using System.Text;
using System.Runtime.InteropServices;
public static class LifecycleWindows {
    public delegate bool Callback(IntPtr h, IntPtr data);
    [DllImport("user32.dll")] public static extern bool EnumWindows(Callback callback, IntPtr data);
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
    [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int GetWindowText(IntPtr h, StringBuilder text, int count);
    [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int GetClassName(IntPtr h, StringBuilder text, int count);
    [DllImport("user32.dll", SetLastError=true)] public static extern bool PostMessage(IntPtr h, uint msg, IntPtr w, IntPtr l);
    [DllImport("user32.dll", SetLastError=true)] static extern bool SetCursorPos(int x, int y);
    [DllImport("user32.dll")] static extern void mouse_event(uint flags, uint dx, uint dy, uint data, UIntPtr extra);
    [DllImport("shell32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern IntPtr CommandLineToArgvW(string command, out int count);
    [DllImport("kernel32.dll")] static extern IntPtr LocalFree(IntPtr memory);
    public sealed class Window {
        public int pid; public long hwnd; public bool visible; public string title; public string className;
    }
    public static Window[] Windows() {
        var rows = new List<Window>();
        if (!EnumWindows((h, data) => {
            uint pid; GetWindowThreadProcessId(h, out pid);
            var title = new StringBuilder(1024); GetWindowText(h, title, title.Capacity);
            var cls = new StringBuilder(256); GetClassName(h, cls, cls.Capacity);
            rows.Add(new Window { pid=(int)pid, hwnd=h.ToInt64(), visible=IsWindowVisible(h), title=title.ToString(), className=cls.ToString() });
            return true;
        }, IntPtr.Zero)) throw new InvalidOperationException("EnumWindows failed.");
        return rows.ToArray();
    }
    public static void Click(double x, double y) {
        if (!SetCursorPos((int)x, (int)y)) throw new InvalidOperationException("SetCursorPos failed.");
        mouse_event(0x0002, 0, 0, 0, UIntPtr.Zero);
        mouse_event(0x0004, 0, 0, 0, UIntPtr.Zero);
    }
    public static string[] Arguments(string command) {
        int count; var memory = CommandLineToArgvW(command, out count);
        if (memory == IntPtr.Zero) throw new InvalidOperationException("CommandLineToArgvW failed.");
        try {
            var args = new string[count];
            for (int i=0; i<count; i++) args[i]=Marshal.PtrToStringUni(Marshal.ReadIntPtr(memory, i*IntPtr.Size));
            return args;
        } finally { LocalFree(memory); }
    }
}
'@
    function Owned-Processes {
        # Never select a process by its executable name. Inaccessible unrelated paths are ignored.
        @(Get-Process | ForEach-Object {
            try {
                if ([string]::Equals($_.Path, $expected, [StringComparison]::OrdinalIgnoreCase)) { $_ }
            } catch { }
        })
    }
    function Snapshot {
        $owned = @(Owned-Processes)
        $ids = @($owned | ForEach-Object { $_.Id })
        [ordered]@{
            processes = @($owned | ForEach-Object { [ordered]@{ pid = $_.Id; path = $expected } })
            windows = @([LifecycleWindows]::Windows() | Where-Object { $_.pid -in $ids } | ForEach-Object {
                [ordered]@{ pid = $_.pid; hwnd = $_.hwnd; visible = $_.visible; title = $_.title; className = $_.className }
            })
        }
    }
    function Process-Candidates {
        Owned-Processes | ForEach-Object {
            $script:candidates += [ordered]@{ pid = $_.Id; birth = $_.StartTime.ToUniversalTime().ToString('o'); path = $_.Path }
        }
    }
    function Assert-Owner {
        $matches = @(Owned-Processes | Where-Object { $_.Id -eq $script:ownerPid })
        if ($matches.Count -ne 1) { throw 'The selected PID no longer owns the exact expected binary.' }
        $originalProcess.Refresh()
        if ($originalProcess.HasExited -or $matches[0].StartTime -ne $originalProcess.StartTime) { throw 'The selected process birth changed.' }
    }
    function Children($element) {
        $element.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition)
    }
    function Click-Element($element, [bool]$nativeMouse = $false) {
        if (!$element.Current.IsEnabled -or $element.Current.IsOffscreen) { throw 'UI element is disabled or offscreen.' }
        if (!$nativeMouse) {
            $pattern = $null
            if ($element.TryGetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern, [ref]$pattern)) {
                $pattern.Invoke()
                return
            }
        }
        $rect = $element.Current.BoundingRectangle
        if ($rect.IsEmpty -or $rect.Width -le 0 -or $rect.Height -le 0) { throw 'UI element has no clickable rectangle.' }
        $x = $rect.Left + $rect.Width / 2
        $y = $rect.Top + $rect.Height / 2
        $hit = [System.Windows.Automation.AutomationElement]::FromPoint([System.Windows.Point]::new($x, $y))
        if ($hit.Current.ProcessId -ne $element.Current.ProcessId) { throw 'UI element is obscured by another process.' }
        [LifecycleWindows]::Click($x, $y)
    }
    function Explorer-Surfaces {
        $windows = @([LifecycleWindows]::Windows() | Where-Object { $_.visible -and $_.className -in @('Shell_TrayWnd', 'Shell_SecondaryTrayWnd', 'NotifyIconOverflowWindow', 'TopLevelWindowForOverflowXamlIsland') })
        foreach ($window in $windows) {
            $process = Get-Process -Id $window.pid
            $explorer = Join-Path $env:WINDIR 'explorer.exe'
            if (![string]::Equals($process.Path, $explorer, [StringComparison]::OrdinalIgnoreCase)) { throw 'Tray surface is not owned by Windows Explorer.' }
            [System.Windows.Automation.AutomationElement]::FromHandle([IntPtr]$window.hwnd)
        }
    }
    function Find-TrayIcon {
        $icons = @()
        foreach ($surface in @(Explorer-Surfaces)) {
            foreach ($element in (Children $surface)) {
                $name = $element.Current.Name
                if ($name -and $element.Current.ControlType -eq [System.Windows.Automation.ControlType]::Button) {
                    $diagnostics.Add([ordered]@{ explorerButton = $name; automationId = $element.Current.AutomationId; className = $element.Current.ClassName; offscreen = $element.Current.IsOffscreen })
                }
                if ($name -ceq 'Cotal: connected' -or $name -ceq 'Cotal: not connected') {
                    if (!$element.Current.IsOffscreen -and $element.Current.ControlType -eq [System.Windows.Automation.ControlType]::Button) { $icons += $element }
                }
            }
        }
        if ($icons.Count -gt 1) { throw 'Multiple exact Cotal tray icons found. Refusing an ambiguous click.' }
        if ($icons.Count -eq 1) { return $icons[0] }
    }
    Process-Candidates
    $diagnostics.Add([ordered]@{ candidates = @($candidates) })
    $appCandidates = @($candidates)
    if ($DaemonPid) {
        if ($Action -ne 'describe' -or !$DaemonStart -or !$AppPid) { throw 'Daemon classification requires describe, app PID and a pinned daemon birth.' }
        $daemonProcess = Get-Process -Id $DaemonPid
        $null = $daemonProcess.Handle
        if ($daemonProcess.StartTime.ToUniversalTime().ToFileTimeUtc().ToString() -cne $DaemonStart) { throw 'Answering daemon birth changed before census.' }
        $daemonRow = Get-CimInstance Win32_Process -Filter "ProcessId=$DaemonPid" -Property ProcessId,ParentProcessId
        if (!$daemonRow -or $daemonRow.ProcessId -ne $DaemonPid) { throw 'Daemon parent query unavailable.' }
        $launcher = Get-Process -Id $daemonRow.ParentProcessId
        $null = $launcher.Handle
        if ($launcher.Id -eq $AppPid -or ![string]::Equals($launcher.Path, $expected, [StringComparison]::OrdinalIgnoreCase) -or $launcher.StartTime -gt $daemonProcess.StartTime) { throw 'Answering daemon parent is not a separate exact service launcher.' }
        $serviceLauncher = [ordered]@{ pid = $launcher.Id; birth = $launcher.StartTime.ToUniversalTime().ToString('o'); path = $launcher.Path }
        $matchingLauncher = @($candidates | Where-Object { $_.pid -eq $serviceLauncher.pid -and $_.birth -ceq $serviceLauncher.birth -and $_.path -ieq $serviceLauncher.path })
        if ($matchingLauncher.Count -ne 1) { throw 'Service launcher is not pinned in the complete candidate census.' }
        $daemonProcess.Refresh()
        $launcher.Refresh()
        if ($daemonProcess.HasExited -or $launcher.HasExited) { throw 'Daemon or launcher exited during app census.' }
        $appCandidates = @($candidates | Where-Object { $_.pid -ne $serviceLauncher.pid })
    }
    if ($Action -eq 'login-entry') {
        # Open read-only and request only the exact Cotal value. Do not enumerate other login entries.
        $key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Software\Microsoft\Windows\CurrentVersion\Run', $false)
        try {
            $value = if ($null -ne $key) { $key.GetValue('Cotal', $null, [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames) } else { $null }
            if ($null -eq $value) {
                $result = [ordered]@{ present = $false }
            } else {
                if ($value -isnot [string]) { throw 'Cotal login value is not a string.' }
                $loginArgs = [LifecycleWindows]::Arguments($value)
                if ($loginArgs.Count -ne 2 -or $loginArgs[1] -cne '--background' -or ![string]::Equals($loginArgs[0], $expected, [StringComparison]::OrdinalIgnoreCase)) {
                    throw 'Cotal login value must contain only the exact expected executable and --background.'
                }
                $result = [ordered]@{ present = $true; path = $expected; args = @('--background') }
            }
        } finally { if ($null -ne $key) { $key.Dispose() } }
    } elseif ($Action -eq 'describe') {
        $result = Snapshot
        if ($AppPid -and @($result.processes | Where-Object { $_.pid -eq $AppPid }).Count -ne 1) { throw 'AppPid does not own the expected binary.' }
    } else {
        $owners = @(Owned-Processes)
        if ($AppPid) { $owners = @($owners | Where-Object { $_.Id -eq $AppPid }) }
        if ($owners.Count -ne 1) { throw 'Expected one exact binary owner. Supply AppPid if multiple instances exist.' }
        $originalProcess = $owners[0]
        $null = $originalProcess.Handle # Retain an OS handle so PID reuse cannot satisfy the exit check.
        $script:ownerPid = $originalProcess.Id
        $diagnostics.Add((Snapshot))
        if ($Action -in @('connected-view', 'settings-back', 'disable-login')) {
            $windows = @([LifecycleWindows]::Windows() | Where-Object { $_.pid -eq $script:ownerPid -and $_.visible -and $_.title -ceq 'Cotal' })
            if ($windows.Count -ne 1) { throw 'Expected one visible owned Cotal window for native UIAutomation.' }
            $rootElement = [System.Windows.Automation.AutomationElement]::FromHandle([IntPtr]$windows[0].hwnd)
            function Exact-Control([string]$id) {
                $condition = [System.Windows.Automation.PropertyCondition]::new([System.Windows.Automation.AutomationElement]::AutomationIdProperty, $id)
                $controls = @($rootElement.FindAll([System.Windows.Automation.TreeScope]::Descendants, $condition))
                if ($controls.Count -ne 1) { throw "Exact AutomationId '$id' unavailable or ambiguous in owned window. WebView2 accessibility support required." }
                if ($controls[0].Current.IsOffscreen) { throw "Exact AutomationId '$id' is offscreen." }
                return $controls[0]
            }
            if ($Action -eq 'connected-view') {
                $heading = Exact-Control 'connection-title'
                $label = Exact-Control 'tray-label'
                $result = [ordered]@{ title = $heading.Current.Name; label = $label.Current.Name }
                if (!$result.title -or !$result.label) { throw 'Exact native view controls expose empty accessibility names.' }
            } elseif ($Action -eq 'settings-back') {
                Assert-Owner
                $heading = Exact-Control 'settings-title'
                $back = Exact-Control 'open-settings'
                if ($heading.Current.Name -cne 'Settings') { throw 'Expected exact Settings heading before Back.' }
                if ($back.Current.Name -cne 'Back' -or $back.Current.ControlType -ne [System.Windows.Automation.ControlType]::Button -or !$back.Current.IsEnabled) { throw 'Expected exact enabled Back button.' }
                $result = [ordered]@{ title = $heading.Current.Name; label = $back.Current.Name }
                Assert-Owner
                if (![LifecycleWindows]::IsWindowVisible([IntPtr]$windows[0].hwnd)) { throw 'Owned Settings window is no longer visible.' }
                Click-Element $back
                for ($i = 0; $i -lt 40; $i++) {
                    Assert-Owner
                    $controls = @(Children $rootElement)
                    $settings = @($controls | Where-Object { $_.Current.AutomationId -ceq 'settings-title' })
                    $connection = @($controls | Where-Object { $_.Current.AutomationId -ceq 'connection-title' })
                    if ($settings.Count -gt 1 -or $connection.Count -gt 1) { throw 'Ambiguous Settings or connection heading after Back.' }
                    if (($settings.Count -eq 0 -or $settings[0].Current.IsOffscreen) -and $connection.Count -eq 1 -and !$connection[0].Current.IsOffscreen) { break }
                    Start-Sleep -Milliseconds 250
                }
                if ($i -eq 40 -or ![LifecycleWindows]::IsWindowVisible([IntPtr]$windows[0].hwnd)) { throw 'Back did not hide Settings and reveal the owned connection view.' }
            } else {
                $checkbox = Exact-Control 'autostart'
                if ($checkbox.Current.ControlType -ne [System.Windows.Automation.ControlType]::CheckBox) { throw 'Exact autostart control is not a native accessibility checkbox.' }
                $toggle = $null
                if (!$checkbox.TryGetCurrentPattern([System.Windows.Automation.TogglePattern]::Pattern, [ref]$toggle)) { throw 'Exact autostart checkbox exposes no TogglePattern.' }
                if ($toggle.Current.ToggleState -eq [System.Windows.Automation.ToggleState]::Indeterminate) { throw 'Autostart checkbox state is indeterminate.' }
                if ($toggle.Current.ToggleState -eq [System.Windows.Automation.ToggleState]::On) {
                    $key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Software\Microsoft\Windows\CurrentVersion\Run', $false)
                    try { $entry = if ($null -ne $key) { $key.GetValue('Cotal', $null, [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames) } else { $null } }
                    finally { if ($null -ne $key) { $key.Dispose() } }
                    if ($null -ne $entry) {
                        if ($entry -isnot [string]) { throw 'Refusing preference change for a non-string Run value.' }
                        $entryArgs = [LifecycleWindows]::Arguments($entry)
                        if ($entryArgs.Count -ne 2 -or $entryArgs[1] -cne '--background' -or ![string]::Equals($entryArgs[0], $expected, [StringComparison]::OrdinalIgnoreCase)) { throw 'Refusing preference change for a foreign Cotal Run value.' }
                    }
                    Assert-Owner
                    Click-Element $checkbox $true
                }
                for ($i = 0; $i -lt 40; $i++) {
                    $checkbox = Exact-Control 'autostart'
                    $toggle = $null
                    if (!$checkbox.TryGetCurrentPattern([System.Windows.Automation.TogglePattern]::Pattern, [ref]$toggle)) { throw 'Autostart checkbox lost TogglePattern.' }
                    $key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Software\Microsoft\Windows\CurrentVersion\Run', $false)
                    try { $entry = if ($null -ne $key) { $key.GetValue('Cotal', $null) } else { $null } }
                    finally { if ($null -ne $key) { $key.Dispose() } }
                    if ($toggle.Current.ToggleState -eq [System.Windows.Automation.ToggleState]::Off -and $null -eq $entry) { break }
                    Start-Sleep -Milliseconds 250
                }
                if ($i -eq 40) { throw 'Native preference did not become unchecked with the Cotal Run value absent.' }
                $result = [ordered]@{ checked = $false; present = $false }
            }
        } elseif ($Action -eq 'close-window') {
            $windows = @([LifecycleWindows]::Windows() | Where-Object { $_.pid -eq $script:ownerPid -and $_.visible -and $_.title -ceq 'Cotal' })
            if ($windows.Count -ne 1) { throw 'Expected one visible Cotal top-level window owned by AppPid.' }
            $hwnd = [IntPtr]$windows[0].hwnd
            # The first close can leave the first-use explanation visible. Always send a second close.
            foreach ($attempt in 1..2) {
                Assert-Owner
                [uint32]$windowOwner = 0
                [LifecycleWindows]::GetWindowThreadProcessId($hwnd, [ref]$windowOwner) | Out-Null
                if ($windowOwner -ne $script:ownerPid) { throw 'Window ownership changed before WM_CLOSE.' }
                if (![LifecycleWindows]::PostMessage($hwnd, 0x0010, [IntPtr]::Zero, [IntPtr]::Zero)) { throw 'PostMessage(WM_CLOSE) failed.' }
                Start-Sleep -Milliseconds 1000
                $diagnostics.Add([ordered]@{ closeAttempt = $attempt; visible = [LifecycleWindows]::IsWindowVisible($hwnd) })
            }
            for ($i = 0; $i -lt 20 -and [LifecycleWindows]::IsWindowVisible($hwnd); $i++) { Start-Sleep -Milliseconds 250 }
            Assert-Owner
            if ([LifecycleWindows]::IsWindowVisible($hwnd)) { throw 'Two native closes did not hide the window.' }
            $result = Snapshot
        } else {
            $icon = Find-TrayIcon
            if ($null -eq $icon) {
                $expanders = @()
                foreach ($surface in @(Explorer-Surfaces)) {
                    foreach ($element in (Children $surface)) {
                        if ($element.Current.AutomationId -in @('SystemTrayIcon', 'NotificationChevron') -or $element.Current.Name -in @('Show hidden icons', 'Show Hidden Icons')) {
                            if (!$element.Current.IsOffscreen -and $element.Current.ControlType -eq [System.Windows.Automation.ControlType]::Button) { $expanders += $element }
                        }
                    }
                }
                $diagnostics.Add([ordered]@{ overflowMatches = @($expanders | ForEach-Object {
                    [ordered]@{ name = $_.Current.Name; automationId = $_.Current.AutomationId; className = $_.Current.ClassName; offscreen = $_.Current.IsOffscreen }
                }); count = $expanders.Count })
                if ($expanders.Count -ne 1) { throw 'Cotal icon is hidden and a unique Explorer overflow button is unavailable (English UI required for name-based discovery).' }
                Click-Element $expanders[0]
                Start-Sleep -Milliseconds 700
                $icon = Find-TrayIcon
            }
            if ($null -eq $icon) { throw 'Exact Cotal tray icon not exposed by Explorer UIAutomation, including overflow.' }
            Assert-Owner
            $diagnostics.Add([ordered]@{ trayName = $icon.Current.Name; explorerPid = $icon.Current.ProcessId })
            # A real left click opens the app's native menu, not a synthetic product event.
            Click-Element $icon $true
            $label = if ($Action -eq 'settings') { 'Settings' + [char]0x2026 } else { 'Quit app (computer stays connected)' }
            $menuItem = $null
            for ($i = 0; $i -lt 30; $i++) {
                $menus = @([LifecycleWindows]::Windows() | Where-Object { $_.pid -eq $script:ownerPid -and $_.visible -and $_.className -eq '#32768' })
                $found = @()
                foreach ($menu in $menus) {
                    $root = [System.Windows.Automation.AutomationElement]::FromHandle([IntPtr]$menu.hwnd)
                    foreach ($item in (Children $root)) {
                        if ($item.Current.ControlType -eq [System.Windows.Automation.ControlType]::MenuItem) {
                            $diagnostics.Add([ordered]@{ menuName = $item.Current.Name; pid = $item.Current.ProcessId; hwnd = $menu.hwnd })
                            if ($item.Current.Name -ceq $label -and $item.Current.ProcessId -eq $script:ownerPid) { $found += $item }
                        }
                    }
                }
                if ($found.Count -gt 1) { throw 'Ambiguous native menu item.' }
                if ($found.Count -eq 1) { $menuItem = $found[0]; break }
                Start-Sleep -Milliseconds 100
            }
            if ($null -eq $menuItem) { throw 'Exact native tray menu item was not exposed by the selected app PID.' }
            Assert-Owner
            Click-Element $menuItem
            for ($i = 0; $i -lt 40; $i++) {
                $current = Snapshot
                if ($Action -eq 'quit') {
                    $originalProcess.Refresh()
                    if ($originalProcess.HasExited) { break }
                } elseif (@($current.windows | Where-Object { $_.pid -eq $script:ownerPid -and $_.visible -and $_.title -ceq 'Cotal' }).Count -gt 0) { break }
                Start-Sleep -Milliseconds 250
            }
            if ($i -eq 40) { throw 'Native tray action did not reach its expected process/window state.' }
            $result = [ordered]@{ invoked = $label; pid = $script:ownerPid; state = $current }
        }
    }
    # Keep the caller's common lifecycle fields at the top level, with full native evidence below.
    $summary = Snapshot
    $selected = @($summary.processes)
    if ($AppPid) { $selected = @($selected | Where-Object { $_.pid -eq $AppPid }) }
    $reportedPid = if ($Action -eq 'login-entry') { 0 } elseif ($Action -in @('quit', 'settings', 'close-window', 'connected-view', 'settings-back', 'disable-login')) { $script:ownerPid } elseif ($selected.Count -eq 1) { $selected[0].pid } else { 0 }
    $visible = @($summary.windows | Where-Object { $_.pid -eq $reportedPid -and $_.visible -and $_.title -ceq 'Cotal' }).Count -gt 0
    $output = [ordered]@{ ok = $true; action = $Action; pid = $reportedPid; visible = $visible; candidates = @($candidates); appCandidates = @($appCandidates); serviceLauncher = $serviceLauncher; result = $result; diagnostics = @($diagnostics.ToArray()) }
    if ($Action -in @('connected-view', 'settings-back')) { $output['title'] = $result.title; $output['label'] = $result.label }
    if ($Action -eq 'disable-login') { $output['checked'] = $false; $output['present'] = $false }
    if ($Action -eq 'login-entry') {
        $output['present'] = $result.present
        if ($result.present) { $output['path'] = $result.path; $output['args'] = $result.args }
    }
    $output | ConvertTo-Json -Depth 10 -Compress
} catch {
    [ordered]@{ ok = $false; action = $Action; error = $_.Exception.Message; candidates = @($candidates); appCandidates = @($appCandidates); serviceLauncher = $serviceLauncher; diagnostics = @($diagnostics.ToArray()) } | ConvertTo-Json -Depth 10 -Compress
    [Console]::Error.WriteLine('Windows lifecycle helper failed: ' + $_.Exception.Message)
    exit 1
}
