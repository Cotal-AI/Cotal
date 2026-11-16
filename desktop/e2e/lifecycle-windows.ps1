# Native UI driver. Run in the interactive Windows desktop that owns Explorer.
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$Binary,
    [Parameter(Mandatory = $true)][ValidateSet('describe', 'close-window', 'settings', 'quit', 'login-entry', 'connected-view', 'settings-back', 'disable-login', 'enable-login', 'read-login-settings', 'prove-login-cells')][string]$Action,
    [ValidateRange(1, 2147483647)][int]$AppPid,
    [ValidateRange(1, 2147483647)][int]$DaemonPid,
    [string]$DaemonStart,
    [ValidateRange(1, 65535)][int]$DebuggerPort
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
    } elseif ($Action -eq 'prove-login-cells') {
        # Prove cells (b), (c), and (d) for #6882 while restoring any original HKLM Run Cotal value in finally.
        Add-Type @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
public static class FilteredAppLauncher {
    [DllImport("advapi32.dll", SetLastError = true)]
    public static extern bool SaferCreateLevel(uint scopeId, uint levelId, uint openFlags, out IntPtr levelHandle, IntPtr reserved);
    [DllImport("advapi32.dll", SetLastError = true)]
    public static extern bool SaferComputeTokenFromLevel(IntPtr levelHandle, IntPtr inAccessToken, out IntPtr outAccessToken, uint dwFlags, IntPtr lpReserved);
    [DllImport("advapi32.dll", SetLastError = true)]
    public static extern bool SaferCloseLevel(IntPtr levelHandle);
    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    public static extern bool ConvertStringSidToSidW(string stringSid, out IntPtr pSid);
    [DllImport("advapi32.dll", SetLastError = true)]
    public static extern uint GetLengthSid(IntPtr pSid);
    [DllImport("advapi32.dll", SetLastError = true)]
    public static extern bool SetTokenInformation(IntPtr tokenHandle, int tokenInformationClass, IntPtr tokenInformation, uint tokenInformationLength);
    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    public static extern bool CreateProcessAsUserW(
        IntPtr hToken, string lpApplicationName, string lpCommandLine,
        IntPtr lpProcessAttributes, IntPtr lpThreadAttributes, bool bInheritHandles,
        uint dwCreationFlags, IntPtr lpEnvironment, string lpCurrentDirectory,
        ref STARTUPINFO lpStartupInfo, out PROCESS_INFORMATION lpProcessInformation);
    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    public static extern bool CreateProcessWithTokenW(
        IntPtr hToken, uint dwLogonFlags, string lpApplicationName, string lpCommandLine,
        uint dwCreationFlags, IntPtr lpEnvironment, string lpCurrentDirectory,
        ref STARTUPINFO lpStartupInfo, out PROCESS_INFORMATION lpProcessInformation);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    public static extern IntPtr GetEnvironmentStringsW();
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    public static extern bool FreeEnvironmentStringsW(IntPtr environment);
    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool CloseHandle(IntPtr hObject);
    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern IntPtr LocalFree(IntPtr hMem);
    [StructLayout(LayoutKind.Sequential)]
    public struct SID_AND_ATTRIBUTES { public IntPtr Sid; public uint Attributes; }
    [StructLayout(LayoutKind.Sequential)]
    public struct TOKEN_MANDATORY_LABEL { public SID_AND_ATTRIBUTES Label; }
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    public struct STARTUPINFO {
        public int cb; public string lpReserved; public string lpDesktop; public string lpTitle;
        public int dwX; public int dwY; public int dwXSize; public int dwYSize;
        public int dwXCountChars; public int dwYCountChars; public int dwFillAttribute;
        public int dwFlags; public short wShowWindow; public short cbReserved2;
        public IntPtr lpReserved2; public IntPtr hStdInput; public IntPtr hStdOutput; public IntPtr hStdError;
    }
    [StructLayout(LayoutKind.Sequential)]
    public struct PROCESS_INFORMATION {
        public IntPtr hProcess; public IntPtr hThread; public int dwProcessId; public int dwThreadId;
    }
    static IntPtr EnvironmentWith(string name, string value) {
        IntPtr block = GetEnvironmentStringsW();
        if (block == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error(), "GetEnvironmentStringsW failed");
        try {
            string prefix = name + "=";
            var kept = new System.Collections.Generic.List<string>();
            int cursor = 0;
            while (Marshal.ReadInt16(new IntPtr(block.ToInt64() + cursor)) != 0) {
                string entry = Marshal.PtrToStringUni(new IntPtr(block.ToInt64() + cursor));
                if (!entry.StartsWith(prefix, StringComparison.OrdinalIgnoreCase)) kept.Add(entry);
                cursor += (entry.Length + 1) * 2;
            }
            kept.Add(prefix + value);
            int bytes = 2;
            foreach (string entry in kept) bytes += (entry.Length + 1) * 2;
            IntPtr copy = Marshal.AllocHGlobal(bytes);
            int write = 0;
            foreach (string entry in kept) {
                byte[] encoded = System.Text.Encoding.Unicode.GetBytes(entry + "\0");
                Marshal.Copy(encoded, 0, new IntPtr(copy.ToInt64() + write), encoded.Length);
                write += encoded.Length;
            }
            Marshal.WriteInt16(copy, write, 0);
            return copy;
        } finally { FreeEnvironmentStringsW(block); }
    }
    public static int StartFiltered(string application, string commandLine, string workingDirectory, int debuggerPort) {
        if (debuggerPort < 1 || debuggerPort > 65535) throw new ArgumentOutOfRangeException("debuggerPort");
        IntPtr environment = EnvironmentWith("WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS", "--remote-debugging-port=" + debuggerPort + " --remote-debugging-address=127.0.0.1");
        try { return StartFilteredWith(application, commandLine, workingDirectory, environment); }
        finally { Marshal.FreeHGlobal(environment); }
    }
    static int StartFilteredWith(string application, string commandLine, string workingDirectory, IntPtr environment) {
        IntPtr hLevel;
        if (!SaferCreateLevel(1, 0x20000, 1, out hLevel, IntPtr.Zero))
            throw new Win32Exception(Marshal.GetLastWin32Error(), "SaferCreateLevel failed");
        try {
            IntPtr hToken;
            if (!SaferComputeTokenFromLevel(hLevel, IntPtr.Zero, out hToken, 0, IntPtr.Zero))
                throw new Win32Exception(Marshal.GetLastWin32Error(), "SaferComputeTokenFromLevel failed");
            try {
                IntPtr pSid;
                if (!ConvertStringSidToSidW("S-1-16-8192", out pSid))
                    throw new Win32Exception(Marshal.GetLastWin32Error(), "ConvertStringSidToSidW failed");
                try {
                    TOKEN_MANDATORY_LABEL tml = new TOKEN_MANDATORY_LABEL();
                    tml.Label.Sid = pSid;
                    tml.Label.Attributes = 0x20;
                    uint tmlSize = (uint)(Marshal.SizeOf(typeof(TOKEN_MANDATORY_LABEL)) + GetLengthSid(pSid));
                    IntPtr pTml = Marshal.AllocHGlobal((int)tmlSize);
                    try {
                        Marshal.StructureToPtr(tml, pTml, false);
                        if (!SetTokenInformation(hToken, 25, pTml, tmlSize))
                            throw new Win32Exception(Marshal.GetLastWin32Error(), "SetTokenInformation(TokenIntegrityLevel) failed");
                    } finally { Marshal.FreeHGlobal(pTml); }
                } finally { LocalFree(pSid); }
                STARTUPINFO si = new STARTUPINFO();
                si.cb = Marshal.SizeOf(typeof(STARTUPINFO));
                PROCESS_INFORMATION pi;
                if (!CreateProcessAsUserW(hToken, application, commandLine, IntPtr.Zero, IntPtr.Zero, false, 0x400, environment, workingDirectory, ref si, out pi)) {
                    int firstErr = Marshal.GetLastWin32Error();
                    if (!CreateProcessWithTokenW(hToken, 0, application, commandLine, 0x400, environment, workingDirectory, ref si, out pi))
                        throw new Win32Exception(Marshal.GetLastWin32Error(), "CreateProcessAsUserW (" + firstErr + ") and CreateProcessWithTokenW failed");
                }
                CloseHandle(pi.hThread);
                CloseHandle(pi.hProcess);
                return pi.dwProcessId;
            } finally { CloseHandle(hToken); }
        } finally { SaferCloseLevel(hLevel); }
    }
}
'@
        $runSubKey = 'Software\Microsoft\Windows\CurrentVersion\Run'
        $hklmRead = [Microsoft.Win32.Registry]::LocalMachine.OpenSubKey($runSubKey, $false)
        $priorHklm = $null
        $priorHklmKind = $null
        try {
            if ($null -ne $hklmRead) {
                $priorHklm = $hklmRead.GetValue('Cotal', $null, [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
                if ($null -ne $priorHklm) { $priorHklmKind = $hklmRead.GetValueKind('Cotal') }
            }
        } finally { if ($null -ne $hklmRead) { $hklmRead.Dispose() } }
        function Set-HklmRunValue([string]$val) {
            $k = [Microsoft.Win32.Registry]::LocalMachine.OpenSubKey($runSubKey, $true)
            if ($null -eq $k) { throw 'HKLM Run key could not be opened for proof setup.' }
            try { $k.SetValue('Cotal', $val, [Microsoft.Win32.RegistryValueKind]::String) }
            finally { $k.Dispose() }
        }
        function Remove-HklmRunValue {
            $k = [Microsoft.Win32.Registry]::LocalMachine.OpenSubKey($runSubKey, $true)
            if ($null -ne $k) {
                try { $k.DeleteValue('Cotal', $false) }
                finally { $k.Dispose() }
            }
        }
        function Read-HklmRunEntry {
            $subKey = [Microsoft.Win32.Registry]::LocalMachine.OpenSubKey($runSubKey, $false)
            try {
                $raw = if ($null -ne $subKey) { $subKey.GetValue('Cotal', $null, [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames) } else { $null }
                if ($null -eq $raw) { return [ordered]@{ present = $false } }
                if ($raw -isnot [string]) { return [ordered]@{ present = $true; kind = $raw.GetType().FullName; matchesExpected = $false } }
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
        function Invoke-Self([string]$subAction, [int]$targetPid) {
            $psExe = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
            $subArgs = @('-NoLogo', '-NoProfile', '-NonInteractive', '-File', $PSCommandPath, '-Binary', $expected, '-Action', $subAction)
            if ($targetPid -gt 0) { $subArgs += @('-AppPid', [string]$targetPid) }
            if ($DaemonPid -gt 0) { $subArgs += @('-DaemonPid', [string]$DaemonPid, '-DaemonStart', $DaemonStart) }
            $subOut = & $psExe @subArgs
            if ($LASTEXITCODE -ne 0) { throw "Sub-action $subAction failed ($LASTEXITCODE): $subOut" }
            return ($subOut | ConvertFrom-Json)
        }
        $cellsFile = if ($env:COTAL_DESKTOP_E2E_NATIVE_LOG) { Join-Path (Split-Path -Parent $env:COTAL_DESKTOP_E2E_NATIVE_LOG) 'windows-login-cells.json' } else { $null }
        $cellsProgress = [ordered]@{}
        function Save-CellsProgress {
            if ($cellsFile) {
                [IO.File]::WriteAllText($cellsFile, ($cellsProgress | ConvertTo-Json -Depth 10), [Text.UTF8Encoding]::new($false))
            }
        }
        $filteredProc = $null
        try {
            if (!$AppPid) { throw 'prove-login-cells requires AppPid of the running elevated app.' }
            $ownedValue = "`"$expected`" --background"
            $foreignExe = Join-Path (Split-Path -Parent $expected) 'node.exe'
            if (!(Test-Path -LiteralPath $foreignExe -PathType Leaf)) { throw 'Expected sibling node.exe for foreign HKLM proof cell.' }
            $foreignValue = "`"$foreignExe`" --background"

            # Cell (b): plant owned HKLM value and verify turning Open at login ON in the elevated app writes HKCU and removes owned HKLM.
            Set-HklmRunValue $ownedValue
            $plantedOnEnable = Read-HklmRunEntry
            if (!$plantedOnEnable.present -or !$plantedOnEnable.matchesExpected) { throw 'Cell (b) setup did not plant owned HKLM Run value.' }
            $enabledObs = Invoke-Self 'enable-login' $AppPid
            $afterEnable = Invoke-Self 'login-entry' $AppPid
            if (!$afterEnable.result.hkcu.present -or !$afterEnable.result.hkcu.matchesExpected -or $afterEnable.result.hklm.present) {
                throw 'Cell (b) failed: enabling Open at login in elevated app did not write HKCU and remove owned HKLM Run value.'
            }
            # Also verify turning Open at login OFF removes HKCU and any re-planted owned HKLM value.
            Set-HklmRunValue $ownedValue
            $plantedOnDisable = Read-HklmRunEntry
            if (!$plantedOnDisable.present -or !$plantedOnDisable.matchesExpected) { throw 'Cell (b) disable setup did not plant owned HKLM Run value.' }
            $disabledObs = Invoke-Self 'disable-login' $AppPid
            $afterDisable = Invoke-Self 'login-entry' $AppPid
            if ($afterDisable.result.hkcu.present -or $afterDisable.result.hklm.present) {
                throw 'Cell (b) disable check failed: disabling Open at login in elevated app did not clear HKCU and owned HKLM.'
            }
            $cellsProgress['cellB'] = [ordered]@{
                plantedBeforeEnable = ($plantedOnEnable.present -and $plantedOnEnable.matchesExpected)
                plantedBeforeDisable = ($plantedOnDisable.present -and $plantedOnDisable.matchesExpected)
                enableRemovedOwnedHklm = (!$afterEnable.result.hklm.present -and $afterEnable.result.hkcu.present)
                disableRemovedOwnedHklm = (!$afterDisable.result.hklm.present -and !$afterDisable.result.hkcu.present)
                enabledResult = $enabledObs.result
                disabledResult = $disabledObs.result
            }
            $diagnostics.Add([ordered]@{ cellB = $cellsProgress['cellB'] })
            Save-CellsProgress

            # Cell (d): plant foreign HKLM value and verify elevated app leaves it untouched.
            Set-HklmRunValue $foreignValue
            $null = Invoke-Self 'enable-login' $AppPid
            $afterForeignEnable = Invoke-Self 'login-entry' $AppPid
            $null = Invoke-Self 'disable-login' $AppPid
            $afterForeignDisable = Invoke-Self 'login-entry' $AppPid
            if (!$afterForeignEnable.result.hklm.present -or $afterForeignEnable.result.hklm.path -cne $foreignExe -or !$afterForeignDisable.result.hklm.present -or $afterForeignDisable.result.hklm.path -cne $foreignExe) {
                throw 'Cell (d) failed: elevated app modified or removed a foreign HKLM Run value.'
            }
            Remove-HklmRunValue
            $cellsProgress['cellD'] = [ordered]@{
                foreignPath = $foreignExe
                preservedOnEnable = ($afterForeignEnable.result.hklm.present -and $afterForeignEnable.result.hklm.path -ceq $foreignExe)
                preservedOnDisable = ($afterForeignDisable.result.hklm.present -and $afterForeignDisable.result.hklm.path -ceq $foreignExe)
            }
            $diagnostics.Add([ordered]@{ cellD = $cellsProgress['cellD'] })
            Save-CellsProgress

            # Quit the elevated app before launching the filtered Medium-integrity app for cell (c).
            $null = Invoke-Self 'quit' $AppPid

            # Cell (c): High-integrity Explorer on the runner refuses Shell_NotifyIconW from a Medium-integrity process (0x80004005), so open the window directly.
            # The fixture launches the app with the runner's real profile, not this helper's private APPDATA.
            if (!$env:USERPROFILE) { throw 'Cell (c) needs the runner profile to seed the saved login choice.' }
            $prefDir = Join-Path $env:USERPROFILE 'AppData\Roaming\ai.cotal.desktop'
            [IO.Directory]::CreateDirectory($prefDir) | Out-Null
            [IO.File]::WriteAllText((Join-Path $prefDir 'presence.json'), '{"login":false,"connected":true,"relocation_declined":false,"pin_offered":false,"close_explained":false}', [Text.UTF8Encoding]::new($false))
            Set-HklmRunValue $ownedValue
            $beforeFiltered = Read-HklmRunEntry
            if (!$beforeFiltered.present -or !$beforeFiltered.matchesExpected) { throw 'Cell (c) setup did not plant owned HKLM Run value.' }
            if ($DebuggerPort -lt 1) { throw 'prove-login-cells requires DebuggerPort reserved by the driver.' }
            $workDir = Split-Path -Parent $expected
            $filteredPid = [FilteredAppLauncher]::StartFiltered($expected, "`"$expected`"", $workDir, $DebuggerPort)
            $filteredProc = Get-Process -Id $filteredPid
            $null = $filteredProc.Handle
            for ($waitIdx = 0; $waitIdx -lt 40; $waitIdx++) {
                $mainWins = @([LifecycleWindows]::Windows() | Where-Object { $_.pid -eq $filteredPid -and $_.visible -and $_.title -ceq 'Cotal' })
                if ($mainWins.Count -eq 1) { break }
                Start-Sleep -Milliseconds 250
            }
            if ($waitIdx -eq 40) { throw 'Filtered Medium-integrity app did not show its Cotal window.' }
            $filteredSettings = $null
            for ($settingsIdx = 0; $settingsIdx -lt 40; $settingsIdx++) {
                try { $filteredSettings = Invoke-Self 'read-login-settings' $filteredPid } catch { $filteredSettings = $null }
                if ($filteredSettings -and $filteredSettings.result.checked -eq $false) { break }
                Start-Sleep -Milliseconds 250
            }
            if (-not ($filteredSettings -and $filteredSettings.result.checked -eq $false)) { throw 'Filtered app did not keep Open at login unchecked.' }
            $filteredEntries = Invoke-Self 'login-entry' $filteredPid
            $expectedError = 'An earlier version also set Cotal to open at login for every user of this computer. To remove that, open Cotal once as an administrator and change Open at login there.'
            $cellsProgress['cellC'] = [ordered]@{
                plantedBeforeFiltered = ($beforeFiltered.present -and $beforeFiltered.matchesExpected)
                appIntegrity = $filteredEntries.result.appIntegrity
                hklmRemained = $filteredEntries.result.hklm.present
                hkcuPresent = $filteredEntries.result.hkcu.present
                checked = $filteredSettings.result.checked
                loginError = $filteredSettings.result.loginError
                filteredPid = $filteredPid
                debuggerPort = $DebuggerPort
            }
            $diagnostics.Add([ordered]@{ cellC = $cellsProgress['cellC'] })
            Save-CellsProgress
            if ($filteredEntries.result.appIntegrity.level -cne 'Medium' -or !$filteredEntries.result.hklm.present -or !$filteredEntries.result.hklm.matchesExpected -or $filteredEntries.result.hkcu.present -or $filteredSettings.result.checked -ne $false -or $filteredSettings.result.loginError -cne $expectedError) {
                throw "Cell (c) failed: integrity=$($filteredEntries.result.appIntegrity.level) hklm=$($filteredEntries.result.hklm.present) hkcu=$($filteredEntries.result.hkcu.present) checked=$($filteredSettings.result.checked) loginError=$($filteredSettings.result.loginError)"
            }
            $filteredProc = $null
            $result = $cellsProgress
        } catch {
            $cellsProgress['error'] = $_.Exception.Message
            Save-CellsProgress
            throw
        } finally {
            if ($null -ne $filteredProc) {
                try {
                    $filteredProc.Refresh()
                    if (!$filteredProc.HasExited) { $filteredProc.Kill(); $filteredProc.WaitForExit(10000) | Out-Null }
                } catch {}
            }
            $restoreKey = [Microsoft.Win32.Registry]::LocalMachine.OpenSubKey($runSubKey, $true)
            if ($null -ne $restoreKey) {
                try {
                    if ($null -eq $priorHklm) { $restoreKey.DeleteValue('Cotal', $false) }
                    else { $restoreKey.SetValue('Cotal', $priorHklm, $priorHklmKind) }
                } finally { $restoreKey.Dispose() }
            }
        }
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
        if ($Action -in @('connected-view', 'settings-back', 'disable-login', 'enable-login', 'read-login-settings')) {
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
            function Read-SingleText([System.Windows.Automation.AutomationElement]$element, [string]$labelName) {
                $direct = $element.Current.Name
                if ($direct) { return $direct }
                $textNodes = @(Children $element | Where-Object { $_.Current.ControlType -eq [System.Windows.Automation.ControlType]::Text -and $_.Current.Name })
                if ($textNodes.Count -ne 1) {
                    throw "Expected one named Text child under '$labelName', found $($textNodes.Count)."
                }
                return $textNodes[0].Current.Name
            }
            if ($Action -eq 'connected-view') {
                $heading = Exact-Control 'connection-title'
                $label = Exact-Control 'tray-label'
                $result = [ordered]@{ title = $heading.Current.Name; label = (Read-SingleText $label 'tray-label') }
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
            } elseif ($Action -eq 'enable-login') {
                $checkbox = Exact-Control 'autostart'
                if ($checkbox.Current.ControlType -ne [System.Windows.Automation.ControlType]::CheckBox) { throw 'Exact autostart control is not a native accessibility checkbox.' }
                $toggle = $null
                if (!$checkbox.TryGetCurrentPattern([System.Windows.Automation.TogglePattern]::Pattern, [ref]$toggle)) { throw 'Exact autostart checkbox exposes no TogglePattern.' }
                if ($toggle.Current.ToggleState -eq [System.Windows.Automation.ToggleState]::Indeterminate) { throw 'Autostart checkbox state is indeterminate.' }
                if ($toggle.Current.ToggleState -eq [System.Windows.Automation.ToggleState]::Off) {
                    Assert-Owner
                    Click-Element $checkbox $true
                }
                for ($i = 0; $i -lt 40; $i++) {
                    $checkbox = Exact-Control 'autostart'
                    $toggle = $null
                    if (!$checkbox.TryGetCurrentPattern([System.Windows.Automation.TogglePattern]::Pattern, [ref]$toggle)) { throw 'Autostart checkbox lost TogglePattern.' }
                    $key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Software\Microsoft\Windows\CurrentVersion\Run', $false)
                    try { $entry = if ($null -ne $key) { $key.GetValue('Cotal', $null, [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames) } else { $null } }
                    finally { if ($null -ne $key) { $key.Dispose() } }
                    if ($toggle.Current.ToggleState -eq [System.Windows.Automation.ToggleState]::On -and $null -ne $entry) { break }
                    Start-Sleep -Milliseconds 250
                }
                if ($i -eq 40) { throw 'Native preference did not become checked with the Cotal HKCU Run value present.' }
                $result = [ordered]@{ checked = $true; present = $true }
            } elseif ($Action -eq 'read-login-settings') {
                Assert-Owner
                $openSettingsBtn = Exact-Control 'open-settings'
                if ($openSettingsBtn.Current.Name -ceq 'Settings') {
                    for ($waitBtn = 0; $waitBtn -lt 30; $waitBtn++) {
                        if ($openSettingsBtn.Current.ControlType -eq [System.Windows.Automation.ControlType]::Button -and $openSettingsBtn.Current.IsEnabled -and !$openSettingsBtn.Current.IsOffscreen) { break }
                        Start-Sleep -Milliseconds 100
                        $openSettingsBtn = Exact-Control 'open-settings'
                    }
                    if ($openSettingsBtn.Current.ControlType -ne [System.Windows.Automation.ControlType]::Button -or !$openSettingsBtn.Current.IsEnabled) {
                        throw 'Expected enabled open-settings button.'
                    }
                    Assert-Owner
                    Click-Element $openSettingsBtn
                }
                $heading = Exact-Control 'settings-title'
                if ($heading.Current.Name -cne 'Settings') { throw 'Expected exact Settings heading.' }
                $checkbox = Exact-Control 'autostart'
                $toggle = $null
                if (!$checkbox.TryGetCurrentPattern([System.Windows.Automation.TogglePattern]::Pattern, [ref]$toggle)) { throw 'Exact autostart checkbox exposes no TogglePattern.' }
                $errEl = Exact-Control 'login-error'
                $errText = Read-SingleText $errEl 'login-error'
                $result = [ordered]@{
                    checked = ($toggle.Current.ToggleState -eq [System.Windows.Automation.ToggleState]::On)
                    loginError = $errText
                }
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
                $uiaNotificationIcons = @()
                foreach ($surface in $surfaces) {
                    foreach ($node in @(Children $surface)) {
                        if ($node.Current.ClassName -ceq 'ToolbarWindow32' -and $node.Current.AutomationId -ceq '1504') {
                            foreach ($btn in @(Children $node)) {
                                $btnRect = $btn.Current.BoundingRectangle
                                $uiaNotificationIcons += [ordered]@{
                                    surface = $surface.Current.ClassName
                                    name = $btn.Current.Name
                                    automationId = $btn.Current.AutomationId
                                    className = $btn.Current.ClassName
                                    controlType = $btn.Current.ControlType.ProgrammaticName
                                    offscreen = $btn.Current.IsOffscreen
                                    boundingRectangle = [ordered]@{
                                        empty = $btnRect.IsEmpty
                                        left = if ($btnRect.IsEmpty) { $null } else { $btnRect.Left }
                                        top = if ($btnRect.IsEmpty) { $null } else { $btnRect.Top }
                                        width = if ($btnRect.IsEmpty) { $null } else { $btnRect.Width }
                                        height = if ($btnRect.IsEmpty) { $null } else { $btnRect.Height }
                                    }
                                }
                            }
                        }
                    }
                }
                $diagnostics.Add([ordered]@{
                    trayRectStage = $stage; trayHwnd = $trayHwnd.ToInt64(); uID = $foundUid
                    matchingUids = @($matches | ForEach-Object { $_.uID }); probes = $probeRows
                    uiaNotificationIcons = $uiaNotificationIcons
                    hresult = ('0x' + $hr.ToString('X8')); ok = ($hr -eq 0)
                    rect = [ordered]@{
                        empty = $empty; left = $rect.left; top = $rect.top; right = $rect.right; bottom = $rect.bottom
                        width = $width; height = $height
                    }
                    inVisibleExplorerSurface = $inVisibleSurface; hitTest = $hitRecord; overflowOpened = $opened
                })
                [pscustomobject]@{ uID = $foundUid; hr = $hr; empty = $empty; x = $x; y = $y; inVisibleExplorerSurface = $inVisibleSurface; explorerOwned = $explorerOwned }
            }
            $iconTarget = $null
            for ($initialAttempt = 0; $initialAttempt -lt 20; $initialAttempt++) {
                $iconTarget = Get-TrayIconTarget 'initial' $visibleSurfaces $overflowOpened
                if ($iconTarget.hr -eq 0 -or @([LifecycleWindows]::Windows() | Where-Object { $_.pid -eq $explorerPid -and $_.className -ceq 'NotifyIconOverflowWindow' -and $_.visible }).Count -eq 0) {
                    break
                }
                Start-Sleep -Milliseconds 150
                $visibleSurfaces = @(Explorer-Surfaces)
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
                for ($afterAttempt = 0; $afterAttempt -lt 20; $afterAttempt++) {
                    $visibleSurfaces = @(Explorer-Surfaces)
                    $iconTarget = Get-TrayIconTarget 'after-overflow' $visibleSurfaces $overflowOpened
                    if ($iconTarget.hr -eq 0 -and !$iconTarget.empty -and $iconTarget.inVisibleExplorerSurface -and $iconTarget.explorerOwned) { break }
                    Start-Sleep -Milliseconds 150
                }
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
    $reportedPid = if ($Action -in @('login-entry', 'prove-login-cells')) { 0 } elseif ($Action -in @('quit', 'settings', 'close-window', 'connected-view', 'settings-back', 'disable-login', 'enable-login', 'read-login-settings')) { $script:ownerPid } elseif ($selected.Count -eq 1) { $selected[0].pid } else { 0 }
    $visible = @($summary.windows | Where-Object { $_.pid -eq $reportedPid -and $_.visible -and $_.title -ceq 'Cotal' }).Count -gt 0
    $output = [ordered]@{ ok = $true; action = $Action; pid = $reportedPid; visible = $visible; candidates = @($candidates); appCandidates = @($appCandidates); serviceLauncher = $serviceLauncher; result = $result; diagnostics = @($diagnostics.ToArray()) }
    if ($Action -in @('connected-view', 'settings-back')) { $output['title'] = $result.title; $output['label'] = $result.label }
    if ($Action -eq 'disable-login') { $output['checked'] = $false; $output['present'] = $false }
    if ($Action -eq 'enable-login') { $output['checked'] = $true; $output['present'] = $true }
    if ($Action -eq 'read-login-settings') { $output['checked'] = $result.checked; $output['loginError'] = $result.loginError }
    if ($Action -eq 'login-entry') {
        $output['present'] = $result.present
        $output['hkcu'] = $result.hkcu
        $output['hklm'] = $result.hklm
        $output['appIntegrity'] = $result.appIntegrity
        if ($result.present) { $output['path'] = $result.path; $output['args'] = $result.args }
    }
    $output | ConvertTo-Json -Depth 10 -Compress
} catch {
    [ordered]@{ ok = $false; action = $Action; error = $_.Exception.Message; candidates = @($candidates); appCandidates = @($appCandidates); serviceLauncher = $serviceLauncher; diagnostics = @($diagnostics.ToArray()) } | ConvertTo-Json -Depth 10 -Compress
    [Console]::Error.WriteLine('Windows lifecycle helper failed: ' + $_.Exception.Message)
    exit 1
}
