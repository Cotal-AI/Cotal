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
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
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
    [DllImport("user32.dll", CharSet=CharSet.Unicode, SetLastError=true)] public static extern IntPtr SendMessageW(IntPtr h, uint msg, IntPtr w, IntPtr l);
    [DllImport("user32.dll", SetLastError=true)] public static extern int GetMenuItemCount(IntPtr hMenu);
    [DllImport("user32.dll", CharSet=CharSet.Unicode, ExactSpelling=true, SetLastError=true)] static extern bool GetMenuItemInfoW(IntPtr hMenu, uint item, bool byPosition, ref MENUITEMINFOW info);
    [DllImport("user32.dll", ExactSpelling=true, SetLastError=true)] public static extern bool GetMenuItemRect(IntPtr hWnd, IntPtr hMenu, uint uItem, out RECT lprcItem);
    [DllImport("user32.dll", ExactSpelling=true)] public static extern IntPtr WindowFromPoint(POINT Point);
    [DllImport("user32.dll", SetLastError=true)] static extern bool SetCursorPos(int x, int y);
    [DllImport("user32.dll")] static extern void mouse_event(uint flags, uint dx, uint dy, uint data, UIntPtr extra);
    [DllImport("shell32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern IntPtr CommandLineToArgvW(string command, out int count);
    [DllImport("shell32.dll", ExactSpelling=true)] public static extern int Shell_NotifyIconGetRect([In] ref NOTIFYICONIDENTIFIER identifier, out RECT iconLocation);
    [DllImport("kernel32.dll")] static extern IntPtr LocalFree(IntPtr memory);
    [DllImport("advapi32.dll", ExactSpelling=true, SetLastError=true)] static extern bool OpenProcessToken(IntPtr ProcessHandle, uint DesiredAccess, out IntPtr TokenHandle);
    [DllImport("advapi32.dll", ExactSpelling=true, SetLastError=true)] static extern bool GetTokenInformation(IntPtr TokenHandle, int TokenInformationClass, IntPtr TokenInformation, int TokenInformationLength, out int ReturnLength);
    [DllImport("advapi32.dll", ExactSpelling=true)] static extern IntPtr GetSidSubAuthorityCount(IntPtr pSid);
    [DllImport("advapi32.dll", ExactSpelling=true)] static extern IntPtr GetSidSubAuthority(IntPtr pSid, uint nSubAuthority);
    [DllImport("kernel32.dll", ExactSpelling=true)] static extern bool CloseHandle(IntPtr hObject);
    [StructLayout(LayoutKind.Sequential)] public struct POINT { public int x, y; }
    [StructLayout(LayoutKind.Sequential)] public struct RECT { public int left, top, right, bottom; }
    [StructLayout(LayoutKind.Sequential)] public struct NOTIFYICONIDENTIFIER {
        public uint cbSize; public IntPtr hWnd; public uint uID; public Guid guidItem;
    }
    [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] public struct MENUITEMINFOW {
        public uint cbSize; public uint fMask; public uint fType; public uint fState; public uint wID;
        public IntPtr hSubMenu; public IntPtr hbmpChecked; public IntPtr hbmpUnchecked;
        public UIntPtr dwItemData; public IntPtr dwTypeData; public uint cch; public IntPtr hbmpItem;
    }
    public sealed class Win32MenuItem {
        public int index; public uint id; public uint type; public uint state; public string stringValue; public bool ok; public int win32Error;
    }
    public sealed class Win32MenuRead {
        public long hmenu; public int itemCount; public int win32Error; public Win32MenuItem[] items;
    }
    public static Win32MenuRead ReadMenu(IntPtr hwnd) {
        IntPtr hmenu = SendMessageW(hwnd, 0x01E1, IntPtr.Zero, IntPtr.Zero);
        if (hmenu == IntPtr.Zero) return new Win32MenuRead { hmenu = 0, itemCount = -1, win32Error = Marshal.GetLastWin32Error(), items = new Win32MenuItem[0] };
        int count = GetMenuItemCount(hmenu);
        int countErr = count < 0 ? Marshal.GetLastWin32Error() : 0;
        var rows = new List<Win32MenuItem>();
        for (int i = 0; i < count; i++) {
            var info = new MENUITEMINFOW();
            info.cbSize = (uint)Marshal.SizeOf(typeof(MENUITEMINFOW));
            info.fMask = 0x00000143; // MIIM_STATE | MIIM_ID | MIIM_STRING | MIIM_FTYPE
            bool ok = GetMenuItemInfoW(hmenu, (uint)i, true, ref info);
            int err = ok ? 0 : Marshal.GetLastWin32Error();
            string text = "";
            if (ok && info.cch > 0) {
                uint capacity = info.cch + 1;
                IntPtr buffer = Marshal.AllocHGlobal((int)capacity * 2);
                try {
                    info.cch = capacity;
                    info.dwTypeData = buffer;
                    if (GetMenuItemInfoW(hmenu, (uint)i, true, ref info)) {
                        text = Marshal.PtrToStringUni(buffer, (int)info.cch) ?? "";
                    } else {
                        ok = false;
                        err = Marshal.GetLastWin32Error();
                    }
                } finally { Marshal.FreeHGlobal(buffer); }
            }
            rows.Add(new Win32MenuItem { index = i, id = info.wID, type = info.fType, state = info.fState, stringValue = text, ok = ok, win32Error = err });
        }
        return new Win32MenuRead { hmenu = hmenu.ToInt64(), itemCount = count, win32Error = countErr, items = rows.ToArray() };
    }
    public sealed class ProcessIntegrity {
        public bool ok; public uint rid; public string level; public int win32Error;
    }
    public static ProcessIntegrity GetProcessIntegrity(IntPtr processHandle) {
        IntPtr token;
        if (!OpenProcessToken(processHandle, 0x0008, out token)) {
            return new ProcessIntegrity { ok = false, rid = 0, level = "unknown", win32Error = Marshal.GetLastWin32Error() };
        }
        try {
            int length = 0;
            GetTokenInformation(token, 25, IntPtr.Zero, 0, out length);
            if (length <= 0) {
                return new ProcessIntegrity { ok = false, rid = 0, level = "unknown", win32Error = Marshal.GetLastWin32Error() };
            }
            IntPtr buffer = Marshal.AllocHGlobal(length);
            try {
                if (!GetTokenInformation(token, 25, buffer, length, out length)) {
                    return new ProcessIntegrity { ok = false, rid = 0, level = "unknown", win32Error = Marshal.GetLastWin32Error() };
                }
                IntPtr sid = Marshal.ReadIntPtr(buffer);
                byte count = Marshal.ReadByte(GetSidSubAuthorityCount(sid));
                uint rid = (uint)Marshal.ReadInt32(GetSidSubAuthority(sid, (uint)(count - 1)));
                string label = rid < 0x1000 ? "Untrusted" : rid < 0x2000 ? "Low" : rid < 0x3000 ? "Medium" : rid < 0x4000 ? "High" : "System";
                return new ProcessIntegrity { ok = true, rid = rid, level = label, win32Error = 0 };
            } finally { Marshal.FreeHGlobal(buffer); }
        } finally { CloseHandle(token); }
    }
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
    function Record-RawExplorerTree($surface, $window) {
        $descendants = [System.Collections.Generic.List[object]]::new()
        $row = [ordered]@{ rawExplorerSurface = [ordered]@{
            className = $window.className; hwnd = $window.hwnd; visible = $window.visible; pid = $window.pid
        }; rawDescendantCount = $null; descendants = $descendants }
        $diagnostics.Add($row)
        $walker = [System.Windows.Automation.TreeWalker]::RawViewWalker
        function Walk-RawChildren($parent) {
            $element = $walker.GetFirstChild($parent)
            while ($null -ne $element) {
                $current = $element.Current
                $rect = $current.BoundingRectangle
                $descendants.Add([ordered]@{
                    controlType = $current.ControlType.ProgrammaticName; name = $current.Name
                    automationId = $current.AutomationId; className = $current.ClassName
                    frameworkId = $current.FrameworkId; offscreen = $current.IsOffscreen
                    boundingRectangle = [ordered]@{
                        empty = $rect.IsEmpty
                        left = if ($rect.IsEmpty) { $null } else { $rect.Left }
                        top = if ($rect.IsEmpty) { $null } else { $rect.Top }
                        width = if ($rect.IsEmpty) { $null } else { $rect.Width }
                        height = if ($rect.IsEmpty) { $null } else { $rect.Height }
                    }
                })
                Walk-RawChildren $element
                $element = $walker.GetNextSibling($element)
            }
        }
        try {
            Walk-RawChildren $surface
            $row['rawDescendantCount'] = $descendants.Count
        } catch {
            # A diagnostic read failure stays explicit and does not replace the existing selector.
            $row['error'] = $_.Exception.Message
        }
    }
    function Explorer-Surfaces {
        $trayWindows = @([LifecycleWindows]::Windows() | Where-Object { $_.className -in @('Shell_TrayWnd', 'Shell_SecondaryTrayWnd', 'NotifyIconOverflowWindow', 'TopLevelWindowForOverflowXamlIsland') })
        $diagnostics.Add([ordered]@{ explorerSurfaces = @($trayWindows | ForEach-Object {
            [ordered]@{ className = $_.className; hwnd = $_.hwnd; visible = $_.visible; pid = $_.pid }
        }) })
        foreach ($window in $trayWindows) {
            $process = Get-Process -Id $window.pid
            $explorer = Join-Path $env:WINDIR 'explorer.exe'
            if (![string]::Equals($process.Path, $explorer, [StringComparison]::OrdinalIgnoreCase)) { throw 'Tray surface is not owned by Windows Explorer.' }
            $surface = [System.Windows.Automation.AutomationElement]::FromHandle([IntPtr]$window.hwnd)
            Record-RawExplorerTree $surface $window
            if ($window.visible) { $surface }
        }
    }
    function Explorer-Children($surface) {
        $row = [ordered]@{ explorerSurface = [ordered]@{
            className = $surface.Current.ClassName; hwnd = $surface.Current.NativeWindowHandle
            visible = !$surface.Current.IsOffscreen; pid = $surface.Current.ProcessId
        }; descendantCount = $null }
        $diagnostics.Add($row)
        $elements = @(Children $surface)
        $row['descendantCount'] = $elements.Count
        $elements
    }
    Process-Candidates
    $diagnostics.Add([ordered]@{ candidates = @($candidates) })
    $appCandidates = @($candidates)
    if ($DaemonPid) {
        if (!$DaemonStart -or !$AppPid) { throw 'Daemon classification requires app PID and a pinned daemon birth.' }
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
        # Open read-only and request only the exact Cotal value in HKCU and HKLM. Do not enumerate other login entries.
        function Read-RunEntry([Microsoft.Win32.RegistryKey]$rootKey) {
            $subKey = $rootKey.OpenSubKey('Software\Microsoft\Windows\CurrentVersion\Run', $false)
            try {
                $raw = if ($null -ne $subKey) { $subKey.GetValue('Cotal', $null, [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames) } else { $null }
                if ($null -eq $raw) {
                    return [ordered]@{ present = $false }
                }
                if ($raw -isnot [string]) {
                    return [ordered]@{ present = $true; kind = $raw.GetType().FullName }
                }
                $parsedArgs = @([LifecycleWindows]::Arguments($raw))
                $matchesExpected = ($parsedArgs.Count -eq 2 -and $parsedArgs[1] -ceq '--background' -and [string]::Equals($parsedArgs[0], $expected, [StringComparison]::OrdinalIgnoreCase))
                return [ordered]@{
                    present = $true
                    matchesExpected = $matchesExpected
                    path = if ($parsedArgs.Count -ge 1) { $parsedArgs[0] } else { $null }
                    args = if ($parsedArgs.Count -gt 1) { @($parsedArgs[1..($parsedArgs.Count - 1)]) } else { @() }
                }
            } finally { if ($null -ne $subKey) { $subKey.Dispose() } }
        }
        $hkcuEntry = Read-RunEntry ([Microsoft.Win32.Registry]::CurrentUser)
        $hklmEntry = Read-RunEntry ([Microsoft.Win32.Registry]::LocalMachine)
        $appIntegrity = $null
        if ($AppPid) {
            $appOwners = @(Owned-Processes | Where-Object { $_.Id -eq $AppPid })
            if ($appOwners.Count -eq 1) {
                $integrity = [LifecycleWindows]::GetProcessIntegrity($appOwners[0].Handle)
                $appIntegrity = [ordered]@{
                    pid = $AppPid; ok = $integrity.ok; rid = ('0x' + $integrity.rid.ToString('X4'))
                    level = $integrity.level; win32Error = $integrity.win32Error
                }
            }
        }
        $diagnostics.Add([ordered]@{
            loginEntryObservation = [ordered]@{
                hkcu = $hkcuEntry
                hklm = $hklmEntry
                appIntegrity = $appIntegrity
            }
        })
        $key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Software\Microsoft\Windows\CurrentVersion\Run', $false)
        try {
            $value = if ($null -ne $key) { $key.GetValue('Cotal', $null, [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames) } else { $null }
            if ($null -eq $value) {
                $result = [ordered]@{ present = $false; hkcu = $hkcuEntry; hklm = $hklmEntry; appIntegrity = $appIntegrity }
            } else {
                if ($value -isnot [string]) { throw 'Cotal login value is not a string.' }
                $loginArgs = [LifecycleWindows]::Arguments($value)
                if ($loginArgs.Count -ne 2 -or $loginArgs[1] -cne '--background' -or ![string]::Equals($loginArgs[0], $expected, [StringComparison]::OrdinalIgnoreCase)) {
                    throw 'Cotal login value must contain only the exact expected executable and --background.'
                }
                $result = [ordered]@{ present = $true; path = $expected; args = @('--background'); hkcu = $hkcuEntry; hklm = $hklmEntry; appIntegrity = $appIntegrity }
            }
        } finally { if ($null -ne $key) { $key.Dispose() } }
    } elseif ($Action -eq 'describe') {
        $result = Snapshot
        if ($AppPid -and @($result.processes | Where-Object { $_.pid -eq $AppPid }).Count -ne 1) { throw 'AppPid does not own the expected binary.' }
    } else {
        if ($DaemonPid -and ($appCandidates.Count -ne 1 -or $appCandidates[0].pid -ne $AppPid)) { throw 'Expected one exact app candidate after service launcher classification.' }
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
            $windowHwnd = $windows[0].hwnd
            $rootElement = [System.Windows.Automation.AutomationElement]::FromHandle([IntPtr]$windowHwnd)
            function Exact-Control([string]$id) {
                $condition = [System.Windows.Automation.PropertyCondition]::new([System.Windows.Automation.AutomationElement]::AutomationIdProperty, $id)
                $stopwatch = [System.Diagnostics.Stopwatch]::StartNew()
                $samples = @()
                $controls = @()
                $descendants = @()
                for ($sampleIndex = 0; $sampleIndex -lt 30; $sampleIndex++) {
                    $sampleWatch = [System.Diagnostics.Stopwatch]::StartNew()
                    $descendants = @(Children $rootElement)
                    $controls = @($rootElement.FindAll([System.Windows.Automation.TreeScope]::Descendants, $condition))
                    $sampleWatch.Stop()
                    $offscreen = if ($controls.Count -eq 1) { $controls[0].Current.IsOffscreen } else { $null }
                    $samples += [ordered]@{
                        sample = $sampleIndex
                        elapsedMs = [int]$stopwatch.ElapsedMilliseconds
                        sampleMs = [int]$sampleWatch.ElapsedMilliseconds
                        descendantCount = $descendants.Count
                        matchCount = $controls.Count
                        offscreen = $offscreen
                    }
                    if ($controls.Count -gt 1) { break }
                    if ($controls.Count -eq 1 -and !$offscreen) {
                        $diagnostics.Add([ordered]@{ exactControl = [ordered]@{ id = $id; windowHwnd = $windowHwnd; samples = $samples } })
                        return $controls[0]
                    }
                    if ($sampleIndex -lt 29) { Start-Sleep -Milliseconds 100 }
                }
                $uiaDescendants = @($descendants | ForEach-Object {
                    [ordered]@{
                        controlType = $_.Current.ControlType.ProgrammaticName
                        name = $_.Current.Name
                        automationId = $_.Current.AutomationId
                        className = $_.Current.ClassName
                        frameworkId = $_.Current.FrameworkId
                    }
                })
                $diagnostics.Add([ordered]@{
                    exactControl = [ordered]@{
                        id = $id; windowHwnd = $windowHwnd; samples = $samples; uiaDescendants = $uiaDescendants
                    }
                })
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
            # Tauri 2.12.5 tray/mod.rs:230-232 with_id calls Self::new(), tray-icon 0.25.1 lib.rs:273-276
            # TrayIconBuilder::new() calls TrayIconId::new_unique() (tray_icon_id.rs:17-18, COUNTER.next() = 1),
            # and TrayIcon::new (windows/mod.rs:97) takes the next COUNTER value (2 today) with GUID_NULL.
            # Probe uID 1..16 on the verified owned tray_icon_app HWND and require one S_OK.
            $trayWindows = @([LifecycleWindows]::Windows() | Where-Object { $_.pid -eq $script:ownerPid -and $_.className -ceq 'tray_icon_app' })
            $diagnostics.Add([ordered]@{ trayWindows = @($trayWindows | ForEach-Object {
                [ordered]@{ pid = $_.pid; hwnd = $_.hwnd; visible = $_.visible; title = $_.title; className = $_.className }
            }) })
            if ($trayWindows.Count -ne 1) { throw 'Expected one exact tray_icon_app window owned by AppPid.' }
            $trayHwnd = [IntPtr]$trayWindows[0].hwnd
            $overflowOpened = $false
            $visibleSurfaces = @(Explorer-Surfaces)
            if ($visibleSurfaces.Count -eq 0) { throw 'Expected at least one visible verified Explorer tray surface.' }
            $explorerPid = $visibleSurfaces[0].Current.ProcessId
            function Get-TrayIconTarget([string]$stage, [System.Windows.Automation.AutomationElement[]]$surfaces, [bool]$opened) {
                $matches = @()
                $probeRows = @()
                foreach ($candidateUid in 1..16) {
                    $identifier = New-Object LifecycleWindows+NOTIFYICONIDENTIFIER
                    $identifier.cbSize = [uint32][System.Runtime.InteropServices.Marshal]::SizeOf([type][LifecycleWindows+NOTIFYICONIDENTIFIER])
                    $identifier.hWnd = $trayHwnd
                    $identifier.uID = [uint32]$candidateUid
                    $identifier.guidItem = [Guid]::Empty
                    $candidateRect = New-Object LifecycleWindows+RECT
                    $candidateHr = [LifecycleWindows]::Shell_NotifyIconGetRect([ref]$identifier, [ref]$candidateRect)
                    $probeRows += [ordered]@{ uID = $candidateUid; hresult = ('0x' + $candidateHr.ToString('X8')); ok = ($candidateHr -eq 0) }
                    if ($candidateHr -eq 0) {
                        $matches += [pscustomobject]@{ uID = $candidateUid; hr = $candidateHr; rect = $candidateRect }
                    }
                }
                if ($matches.Count -gt 1) {
                    $diagnostics.Add([ordered]@{
                        trayRectStage = $stage; trayHwnd = $trayHwnd.ToInt64(); uID = $null
                        matchingUids = @($matches | ForEach-Object { $_.uID }); probes = $probeRows; overflowOpened = $opened
                    })
                    throw "Ambiguous Shell_NotifyIconGetRect S_OK count $($matches.Count) for tray_icon_app hwnd $($trayHwnd.ToInt64()) across uID 1..16."
                }
                $foundUid = if ($matches.Count -eq 1) { $matches[0].uID } else { $null }
                $hr = if ($matches.Count -eq 1) { 0 } else { -2147467259 }
                $rect = if ($matches.Count -eq 1) { $matches[0].rect } else { New-Object LifecycleWindows+RECT }
                $width = $rect.right - $rect.left
                $height = $rect.bottom - $rect.top
                $empty = ($hr -ne 0 -or $width -le 0 -or $height -le 0)
                $x = if ($empty) { $null } else { $rect.left + $width / 2.0 }
                $y = if ($empty) { $null } else { $rect.top + $height / 2.0 }
                $inVisibleSurface = $false
                $hitRecord = $null
                $explorerOwned = $false
                if (!$empty) {
                    foreach ($surface in $surfaces) {
                        if ($surface.Current.ClassName -ceq 'NotifyIconOverflowWindow') {
                            $bounds = $surface.Current.BoundingRectangle
                            if (!$surface.Current.IsOffscreen -and !$bounds.IsEmpty -and $x -ge $bounds.Left -and $x -le $bounds.Right -and $y -ge $bounds.Top -and $y -le $bounds.Bottom) {
                                $inVisibleSurface = $true
                                break
                            }
                        } elseif ($surface.Current.ClassName -ceq 'Shell_TrayWnd') {
                            foreach ($node in @(Children $surface)) {
                                if ($node.Current.ClassName -ceq 'ToolbarWindow32' -and $node.Current.AutomationId -ceq '1504' -and !$node.Current.IsOffscreen) {
                                    $bounds = $node.Current.BoundingRectangle
                                    if (!$bounds.IsEmpty -and $x -ge $bounds.Left -and $x -le $bounds.Right -and $y -ge $bounds.Top -and $y -le $bounds.Bottom) {
                                        $inVisibleSurface = $true
                                        break
                                    }
                                }
                            }
                        }
                    }
                    $hit = [System.Windows.Automation.AutomationElement]::FromPoint([System.Windows.Point]::new($x, $y))
                    $explorerOwned = ($null -ne $hit -and !$hit.Current.IsOffscreen -and $hit.Current.ProcessId -eq $explorerPid -and $hit.Current.AutomationId -cne '1502')
                    $hitRecord = if ($null -eq $hit) { $null } else {
                        [ordered]@{
                            point = [ordered]@{ x = $x; y = $y }; pid = $hit.Current.ProcessId
                            controlType = $hit.Current.ControlType.ProgrammaticName; name = $hit.Current.Name
                            automationId = $hit.Current.AutomationId; className = $hit.Current.ClassName
                            hwnd = $hit.Current.NativeWindowHandle; offscreen = $hit.Current.IsOffscreen
                            explorerOwned = $explorerOwned
                        }
                    }
                }
                $diagnostics.Add([ordered]@{
                    trayRectStage = $stage; trayHwnd = $trayHwnd.ToInt64(); uID = $foundUid
                    matchingUids = @($matches | ForEach-Object { $_.uID })
                    hresult = ('0x' + $hr.ToString('X8')); ok = ($hr -eq 0)
                    rect = [ordered]@{
                        empty = $empty; left = $rect.left; top = $rect.top; right = $rect.right; bottom = $rect.bottom
                        width = $width; height = $height
                    }
                    inVisibleExplorerSurface = $inVisibleSurface; hitTest = $hitRecord; overflowOpened = $opened
                })
                [pscustomobject]@{ uID = $foundUid; hr = $hr; empty = $empty; x = $x; y = $y; inVisibleExplorerSurface = $inVisibleSurface; explorerOwned = $explorerOwned }
            }
            $iconTarget = Get-TrayIconTarget 'initial' $visibleSurfaces $overflowOpened
            if ($iconTarget.hr -ne 0 -and @([LifecycleWindows]::Windows() | Where-Object { $_.pid -eq $explorerPid -and $_.className -ceq 'NotifyIconOverflowWindow' -and $_.visible }).Count -gt 0) {
                throw "Shell_NotifyIconGetRect returned no S_OK for tray_icon_app hwnd $($trayHwnd.ToInt64()) across uID 1..16."
            }
            if (!$iconTarget.inVisibleExplorerSurface -or !$iconTarget.explorerOwned) {
                $expanders = @()
                foreach ($surface in $visibleSurfaces) {
                    if ($surface.Current.ClassName -cne 'Shell_TrayWnd') { continue }
                    $elements = @(Explorer-Children $surface)
                    $notify = @($elements | Where-Object { $_.Current.ClassName -ceq 'TrayNotifyWnd' -and $_.Current.AutomationId -ceq '303' -and !$_.Current.IsOffscreen })
                    foreach ($area in $notify) {
                        foreach ($child in @(Children $area)) {
                            if ($child.Current.ClassName -ceq 'Button' -and $child.Current.AutomationId -ceq '1502' -and !$child.Current.IsOffscreen -and $child.Current.IsEnabled) {
                                $expanders += $child
                            }
                        }
                    }
                }
                $diagnostics.Add([ordered]@{ overflowMatches = @($expanders | ForEach-Object {
                    $r = $_.Current.BoundingRectangle
                    [ordered]@{
                        name = $_.Current.Name; automationId = $_.Current.AutomationId; className = $_.Current.ClassName
                        controlType = $_.Current.ControlType.ProgrammaticName; offscreen = $_.Current.IsOffscreen
                        boundingRectangle = [ordered]@{
                            empty = $r.IsEmpty
                            left = if ($r.IsEmpty) { $null } else { $r.Left }
                            top = if ($r.IsEmpty) { $null } else { $r.Top }
                            width = if ($r.IsEmpty) { $null } else { $r.Width }
                            height = if ($r.IsEmpty) { $null } else { $r.Height }
                        }
                    }
                }); count = $expanders.Count })
                if ($expanders.Count -ne 1) {
                    if ($iconTarget.hr -ne 0) {
                        throw "Shell_NotifyIconGetRect returned no S_OK for tray_icon_app hwnd $($trayHwnd.ToInt64()) across uID 1..16."
                    }
                    throw 'Cotal icon is hidden and a unique Explorer overflow button (TrayNotifyWnd/303 -> Button/1502) is unavailable.'
                }
                $chevronRect = $expanders[0].Current.BoundingRectangle
                if ($chevronRect.IsEmpty -or $chevronRect.Width -le 0 -or $chevronRect.Height -le 0) { throw 'Explorer overflow chevron has no clickable rectangle.' }
                $cx = $chevronRect.Left + $chevronRect.Width / 2.0
                $cy = $chevronRect.Top + $chevronRect.Height / 2.0
                $chevronHit = [System.Windows.Automation.AutomationElement]::FromPoint([System.Windows.Point]::new($cx, $cy))
                $chevronOwned = ($null -ne $chevronHit -and !$chevronHit.Current.IsOffscreen -and $chevronHit.Current.ProcessId -eq $explorerPid)
                $diagnostics.Add([ordered]@{ chevronHitTest = if ($null -eq $chevronHit) { $null } else {
                    [ordered]@{
                        point = [ordered]@{ x = $cx; y = $cy }; pid = $chevronHit.Current.ProcessId
                        controlType = $chevronHit.Current.ControlType.ProgrammaticName; name = $chevronHit.Current.Name
                        automationId = $chevronHit.Current.AutomationId; className = $chevronHit.Current.ClassName
                        hwnd = $chevronHit.Current.NativeWindowHandle; offscreen = $chevronHit.Current.IsOffscreen
                        explorerOwned = $chevronOwned
                    }
                } })
                if (!$chevronOwned) { throw 'Explorer overflow chevron hit-test did not land on Windows Explorer.' }
                [LifecycleWindows]::Click($cx, $cy)
                $overflowOpened = $true
                for ($i = 0; $i -lt 20; $i++) {
                    if (@([LifecycleWindows]::Windows() | Where-Object { $_.pid -eq $explorerPid -and $_.className -ceq 'NotifyIconOverflowWindow' -and $_.visible }).Count -eq 1) { break }
                    Start-Sleep -Milliseconds 150
                }
                $visibleSurfaces = @(Explorer-Surfaces)
                $iconTarget = Get-TrayIconTarget 'after-overflow' $visibleSurfaces $overflowOpened
            }
            if ($iconTarget.hr -ne 0) {
                throw "Shell_NotifyIconGetRect returned no S_OK for tray_icon_app hwnd $($trayHwnd.ToInt64()) across uID 1..16."
            }
            if ($iconTarget.empty -or !$iconTarget.inVisibleExplorerSurface -or !$iconTarget.explorerOwned) {
                throw 'Cotal tray icon rectangle is not inside a visible verified Explorer tray surface.'
            }
            Assert-Owner
            # A real left click opens the app's native menu, not a synthetic product event.
            [LifecycleWindows]::Click($iconTarget.x, $iconTarget.y)
            $settingsLabel = 'Settings' + [char]0x2026
            $label = if ($Action -eq 'settings') { $settingsLabel } else { 'Quit app (computer stays connected)' }
            $menuTarget = $null
            $lastMenuObservation = $null
            for ($i = 0; $i -lt 30; $i++) {
                $allMenus = @([LifecycleWindows]::Windows() | Where-Object { $_.visible -and $_.className -eq '#32768' })
                $menus = @($allMenus | Where-Object { $_.pid -eq $script:ownerPid })
                $found = @()
                $settingsFound = @()
                $observedMenus = @()
                foreach ($menu in $menus) {
                    [uint32]$menuOwnerPid = 0
                    [LifecycleWindows]::GetWindowThreadProcessId([IntPtr]$menu.hwnd, [ref]$menuOwnerPid) | Out-Null
                    $root = [System.Windows.Automation.AutomationElement]::FromHandle([IntPtr]$menu.hwnd)
                    $menuChildren = @(Children $root)
                    $items = @()
                    $uiaDescendants = @()
                    foreach ($item in $menuChildren) {
                        $uiaDescendants += [ordered]@{
                            controlType = $item.Current.ControlType.ProgrammaticName
                            name = $item.Current.Name
                            className = $item.Current.ClassName
                            frameworkId = $item.Current.FrameworkId
                        }
                        if ($item.Current.ControlType -eq [System.Windows.Automation.ControlType]::MenuItem) {
                            $items += [ordered]@{ menuName = $item.Current.Name; pid = $item.Current.ProcessId; hwnd = $menu.hwnd }
                            $diagnostics.Add([ordered]@{ menuName = $item.Current.Name; pid = $item.Current.ProcessId; hwnd = $menu.hwnd })
                        }
                    }
                    $win32Menu = [LifecycleWindows]::ReadMenu([IntPtr]$menu.hwnd)
                    foreach ($wItem in $win32Menu.items) {
                        if ([int]$menuOwnerPid -eq $script:ownerPid -and $wItem.ok -and $wItem.type -eq 0 -and ($wItem.state -band 3) -eq 0) {
                            if ($wItem.stringValue -ceq $settingsLabel) {
                                $settingsFound += [pscustomobject]@{ menuHwnd = $menu.hwnd; menuOwnerPid = [int]$menuOwnerPid; hmenu = $win32Menu.hmenu; index = $wItem.index; id = $wItem.id; type = $wItem.type; state = $wItem.state; string = $wItem.stringValue }
                            }
                            if ($wItem.stringValue -ceq $label) {
                                $found += [pscustomobject]@{ menuHwnd = $menu.hwnd; menuOwnerPid = [int]$menuOwnerPid; hmenu = $win32Menu.hmenu; index = $wItem.index; id = $wItem.id; type = $wItem.type; state = $wItem.state; string = $wItem.stringValue }
                            }
                        }
                    }
                    $observedMenus += [ordered]@{
                        menuHwnd = $menu.hwnd; menuOwnerPid = [int]$menuOwnerPid; items = $items
                        uiaDescendants = $uiaDescendants
                        win32Menu = [ordered]@{
                            hmenu = $win32Menu.hmenu; itemCount = $win32Menu.itemCount; win32Error = $win32Menu.win32Error
                            items = @($win32Menu.items | ForEach-Object {
                                [ordered]@{ index = $_.index; id = $_.id; type = $_.type; state = $_.state; string = $_.stringValue; ok = $_.ok; win32Error = $_.win32Error }
                            })
                        }
                    }
                }
                $lastMenuObservation = [ordered]@{
                    menuOwnerPid = if ($observedMenus.Count -eq 1) { $observedMenus[0].menuOwnerPid } else { $null }
                    appPid = $script:ownerPid
                    overflowOpened = $overflowOpened
                    hasSettingsItem = ($settingsFound.Count -eq 1)
                    targetLabel = $label
                    targetMatches = $found.Count
                    menus = $observedMenus
                    allMenuWindows = @($allMenus | ForEach-Object { [ordered]@{ pid = $_.pid; hwnd = $_.hwnd; visible = $_.visible; className = $_.className } })
                }
                if ($found.Count -gt 1 -or $settingsFound.Count -gt 1) {
                    $diagnostics.Add([ordered]@{ menuObservation = $lastMenuObservation })
                    throw 'Ambiguous native menu item.'
                }
                if ($observedMenus.Count -eq 1 -and $observedMenus[0].menuOwnerPid -eq $script:ownerPid -and $settingsFound.Count -eq 1 -and $found.Count -eq 1) {
                    $menuTarget = $found[0]
                    break
                }
                Start-Sleep -Milliseconds 100
            }
            $diagnostics.Add([ordered]@{ menuObservation = $lastMenuObservation })
            if ($null -eq $menuTarget) { throw 'Exact native tray menu item was not exposed by the selected app PID.' }
            $itemRect = New-Object LifecycleWindows+RECT
            $rectOk = [LifecycleWindows]::GetMenuItemRect([IntPtr]::Zero, [IntPtr]$menuTarget.hmenu, [uint32]$menuTarget.index, [ref]$itemRect)
            $rectErr = if ($rectOk) { 0 } else { [System.Runtime.InteropServices.Marshal]::GetLastWin32Error() }
            $itemWidth = $itemRect.right - $itemRect.left
            $itemHeight = $itemRect.bottom - $itemRect.top
            $itemEmpty = (!$rectOk -or $itemWidth -le 0 -or $itemHeight -le 0)
            $mx = if ($itemEmpty) { 0.0 } else { $itemRect.left + $itemWidth / 2.0 }
            $my = if ($itemEmpty) { 0.0 } else { $itemRect.top + $itemHeight / 2.0 }
            $pt = New-Object LifecycleWindows+POINT
            $pt.x = [int]$mx
            $pt.y = [int]$my
            $pointHwnd = if ($itemEmpty) { [IntPtr]::Zero } else { [LifecycleWindows]::WindowFromPoint($pt) }
            [uint32]$pointPid = 0
            if ($pointHwnd -ne [IntPtr]::Zero) { [LifecycleWindows]::GetWindowThreadProcessId($pointHwnd, [ref]$pointPid) | Out-Null }
            $diagnostics.Add([ordered]@{
                menuItemHitTest = [ordered]@{
                    menuHwnd = $menuTarget.menuHwnd; hmenu = $menuTarget.hmenu; index = $menuTarget.index
                    id = $menuTarget.id; label = $menuTarget.string; rectOk = $rectOk; win32Error = $rectErr
                    rect = [ordered]@{ empty = $itemEmpty; left = $itemRect.left; top = $itemRect.top; right = $itemRect.right; bottom = $itemRect.bottom; width = $itemWidth; height = $itemHeight }
                    point = if ($itemEmpty) { $null } else { [ordered]@{ x = $pt.x; y = $pt.y } }
                    windowFromPointHwnd = $pointHwnd.ToInt64(); windowFromPointPid = [int]$pointPid
                }
            })
            if ($itemEmpty) { throw 'Win32 menu item has no clickable screen rectangle.' }
            if ($pointHwnd.ToInt64() -ne $menuTarget.menuHwnd -or [int]$pointPid -ne $script:ownerPid) {
                throw 'Menu item centre hit-test did not land on the owned #32768 menu window.'
            }
            Assert-Owner
            [LifecycleWindows]::Click($mx, $my)
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
