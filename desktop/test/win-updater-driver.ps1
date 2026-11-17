param(
  [Parameter(Mandatory = $true)][string]$AppPath,
  [Parameter(Mandatory = $true)][ValidateSet('describe', 'text', 'click', 'settings', 'close', 'quit', 'dump')][string]$Operation,
  [string]$TargetId = ''
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$savedCurrentDir = [Environment]::CurrentDirectory
try {
  [Environment]::CurrentDirectory = $PSHOME
  Add-Type -AssemblyName WindowsBase
  Add-Type -AssemblyName UIAutomationClient
  Add-Type -AssemblyName UIAutomationTypes
  Add-Type @'
using System;
using System.Collections.Generic;
using System.Text;
using System.Runtime.InteropServices;
public static class WinUpdaterNative {
  public delegate bool EnumWindowProc(IntPtr h, IntPtr data);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowProc callback, IntPtr data);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr h, StringBuilder text, int count);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassName(IntPtr h, StringBuilder text, int count);
  [DllImport("user32.dll", SetLastError = true)] public static extern bool PostMessage(IntPtr h, uint msg, IntPtr w, IntPtr l);
  [DllImport("user32.dll", SetLastError = true)] static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] static extern void mouse_event(uint flags, uint dx, uint dy, uint data, UIntPtr extra);
  public sealed class WindowRow {
    public int pid; public long hwnd; public bool visible; public string title; public string className;
  }
  public static WindowRow[] Windows() {
    var rows = new List<WindowRow>();
    if (!EnumWindows((h, data) => {
      uint pid; GetWindowThreadProcessId(h, out pid);
      var title = new StringBuilder(1024); GetWindowText(h, title, title.Capacity);
      var cls = new StringBuilder(256); GetClassName(h, cls, cls.Capacity);
      rows.Add(new WindowRow { pid = (int)pid, hwnd = h.ToInt64(), visible = IsWindowVisible(h), title = title.ToString(), className = cls.ToString() });
      return true;
    }, IntPtr.Zero)) throw new InvalidOperationException("EnumWindows failed.");
    return rows.ToArray();
  }
  public static void ClickPoint(double x, double y) {
    if (!SetCursorPos((int)x, (int)y)) throw new InvalidOperationException("SetCursorPos failed.");
    mouse_event(0x0002, 0, 0, 0, UIntPtr.Zero);
    mouse_event(0x0004, 0, 0, 0, UIntPtr.Zero);
  }
}
'@
} finally {
  [Environment]::CurrentDirectory = $savedCurrentDir
}

$expected = [IO.Path]::GetFullPath($AppPath)
$wmiRows = @(Get-CimInstance Win32_Process -Filter "Name = 'cotal-desktop.exe'" | Where-Object {
  $_.ExecutablePath -and [string]::Equals($_.ExecutablePath, $expected, [StringComparison]::OrdinalIgnoreCase) -and ($_.CommandLine -notlike '*--daemon*')
})
$live = @()
foreach ($row in $wmiRows) {
  $gp = Get-Process -Id $row.ProcessId -ErrorAction SilentlyContinue
  if ($gp -and !$gp.HasExited) {
    $live += @{
      pid = [int]$row.ProcessId
      path = [string]$row.ExecutablePath
      commandLine = [string]$row.CommandLine
      birth = $gp.StartTime.ToUniversalTime().ToFileTimeUtc().ToString()
    }
  }
}
if ($live.Count -ne 1) {
  throw "expected one running owned GUI app at $expected, found $($live.Count)"
}
$owner = $live[0]
$appPid = [int]$owner.pid
$windows = @([WinUpdaterNative]::Windows() | Where-Object { $_.pid -eq $appPid -and $_.visible -and $_.title -ceq 'Cotal' })
$visible = $windows.Count -eq 1
$hwnd = if ($visible) { [long]$windows[0].hwnd } else { [long]0 }

function Get-Descendants($element) {
  @($element.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition))
}

function Read-ElementText($element) {
  $direct = [string]$element.Current.Name
  if (![string]::IsNullOrWhiteSpace($direct)) { return $direct.Trim() }
  $vp = $null
  if ($element.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern, [ref]$vp)) {
    $val = [string]$vp.Current.Value
    if (![string]::IsNullOrWhiteSpace($val)) { return $val.Trim() }
  }
  $tp = $null
  if ($element.TryGetCurrentPattern([System.Windows.Automation.TextPattern]::Pattern, [ref]$tp)) {
    $txt = [string]$tp.DocumentRange.GetText(-1)
    if (![string]::IsNullOrWhiteSpace($txt)) { return $txt.Trim() }
  }
  $parts = @()
  foreach ($child in (Get-Descendants $element)) {
    $name = [string]$child.Current.Name
    if (![string]::IsNullOrWhiteSpace($name)) { $parts += $name.Trim() }
  }
  return ($parts -join ' ').Trim()
}

function Wait-MainScreen($root) {
  $boundMs = 60000
  $sw = [Diagnostics.Stopwatch]::StartNew()
  $openCond = [System.Windows.Automation.PropertyCondition]::new([System.Windows.Automation.AutomationElement]::AutomationIdProperty, 'open-settings')
  $loadCond = [System.Windows.Automation.PropertyCondition]::new([System.Windows.Automation.AutomationElement]::AutomationIdProperty, 'loading-title')
  $openSettings = @()
  $loadingTitle = @()
  while ($sw.ElapsedMilliseconds -lt $boundMs) {
    $openSettings = @($root.FindAll([System.Windows.Automation.TreeScope]::Descendants, $openCond) | Where-Object { !$_.Current.IsOffscreen })
    $loadingTitle = @($root.FindAll([System.Windows.Automation.TreeScope]::Descendants, $loadCond) | Where-Object { !$_.Current.IsOffscreen })
    if ($openSettings.Count -eq 1 -and $loadingTitle.Count -eq 0) {
      return @{ boundMs = $boundMs; waitedMs = [int]$sw.ElapsedMilliseconds; openSettingsFound = $true; loadingTitleGone = $true }
    }
    Start-Sleep -Milliseconds 250
  }
  if ($loadingTitle.Count -gt 0) {
    $loadingText = Read-ElementText $loadingTitle[0]
    throw "App remained on loading screen '$loadingText' (loading-title) after ${boundMs}ms (open-settings count=$($openSettings.Count))."
  }
  throw "Main screen did not expose open-settings within ${boundMs}ms (open-settings count=$($openSettings.Count), loading-title count=$($loadingTitle.Count))."
}

function Find-ById($root, [string]$id) {
  $cond = [System.Windows.Automation.PropertyCondition]::new([System.Windows.Automation.AutomationElement]::AutomationIdProperty, $id)
  $matches = @($root.FindAll([System.Windows.Automation.TreeScope]::Descendants, $cond))
  if ($matches.Count -ne 1) {
    throw "expected unique AutomationId '$id', found $($matches.Count)"
  }
  return $matches[0]
}

function Press-Element($root, $element, [string]$id) {
  if (!$element.Current.IsEnabled -or $element.Current.IsOffscreen) {
    throw "control '$id' is disabled or offscreen"
  }
  [WinUpdaterNative]::SetForegroundWindow([IntPtr]$hwnd) | Out-Null
  $invoke = $null
  if ($element.TryGetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern, [ref]$invoke)) {
    $invoke.Invoke()
    return @{ method = 'invoke'; pid = $appPid; id = $id; title = (Read-ElementText $element) }
  }
  $toggle = $null
  if ($element.TryGetCurrentPattern([System.Windows.Automation.TogglePattern]::Pattern, [ref]$toggle)) {
    $toggle.Toggle()
    return @{ method = 'toggle'; pid = $appPid; id = $id; title = (Read-ElementText $element) }
  }
  $rect = $element.Current.BoundingRectangle
  if ($rect.IsEmpty -or $rect.Width -le 0 -or $rect.Height -le 0) {
    throw "control '$id' has no clickable bounding rectangle"
  }
  $x = $rect.Left + ($rect.Width / 2.0)
  $y = $rect.Top + ($rect.Height / 2.0)
  $hit = [System.Windows.Automation.AutomationElement]::FromPoint([System.Windows.Point]::new($x, $y))
  if ($hit.Current.ProcessId -ne $appPid) {
    throw "control '$id' is obscured by process $($hit.Current.ProcessId)"
  }
  [WinUpdaterNative]::ClickPoint($x, $y)
  return @{ method = 'click'; pid = $appPid; id = $id; title = (Read-ElementText $element); x = $x; y = $y; hitPid = $hit.Current.ProcessId; owned = $true }
}

switch ($Operation) {
  'describe' {
    @{ pid = $appPid; visible = $visible; path = $owner.path; commandLine = $owner.commandLine; birth = $owner.birth; hwnd = $hwnd } | ConvertTo-Json -Compress
  }
  'text' {
    if (!$visible) { throw 'Cotal window is not visible for text read' }
    if (!$TargetId) { throw 'Missing TargetId for text operation' }
    $root = [System.Windows.Automation.AutomationElement]::FromHandle([IntPtr]$hwnd)
    $wait = Wait-MainScreen $root
    $el = Find-ById $root $TargetId
    @{ text = (Read-ElementText $el); mainScreenWait = $wait } | ConvertTo-Json -Compress
  }
  'click' {
    if (!$visible) { throw 'Cotal window is not visible for click' }
    if (!$TargetId) { throw 'Missing TargetId for click operation' }
    $root = [System.Windows.Automation.AutomationElement]::FromHandle([IntPtr]$hwnd)
    $wait = Wait-MainScreen $root
    $el = Find-ById $root $TargetId
    $pressed = Press-Element $root $el $TargetId
    $pressed['mainScreenWait'] = $wait
    $pressed | ConvertTo-Json -Compress
  }
  'settings' {
    if (!$visible) { throw 'Cotal window is not visible for settings navigation' }
    $root = [System.Windows.Automation.AutomationElement]::FromHandle([IntPtr]$hwnd)
    $wait = Wait-MainScreen $root
    $cond = [System.Windows.Automation.PropertyCondition]::new([System.Windows.Automation.AutomationElement]::AutomationIdProperty, 'settings-title')
    $existing = @($root.FindAll([System.Windows.Automation.TreeScope]::Descendants, $cond) | Where-Object { !$_.Current.IsOffscreen })
    if ($existing.Count -eq 1) {
      @{ operation = 'settings'; pid = $appPid; alreadyOpen = $true; mainScreenWait = $wait } | ConvertTo-Json -Compress
    } else {
      $btn = Find-ById $root 'open-settings'
      $pressed = Press-Element $root $btn 'open-settings'
      $check = @()
      for ($i = 0; $i -lt 30; $i++) {
        $check = @($root.FindAll([System.Windows.Automation.TreeScope]::Descendants, $cond) | Where-Object { !$_.Current.IsOffscreen })
        if ($check.Count -eq 1) { break }
        Start-Sleep -Milliseconds 200
      }
      if ($check.Count -ne 1) { throw 'Settings heading did not appear after clicking open-settings' }
      @{ operation = 'settings'; pid = $appPid; button = $pressed; mainScreenWait = $wait } | ConvertTo-Json -Compress
    }
  }
  'close' {
    if (!$visible) { throw 'Cotal window is already hidden' }
    foreach ($attempt in 1..2) {
      if (![WinUpdaterNative]::IsWindowVisible([IntPtr]$hwnd)) { break }
      if (![WinUpdaterNative]::PostMessage([IntPtr]$hwnd, 0x0010, [IntPtr]::Zero, [IntPtr]::Zero)) {
        throw 'PostMessage(WM_CLOSE) failed'
      }
      Start-Sleep -Milliseconds 900
    }
    for ($i = 0; $i -lt 30 -and [WinUpdaterNative]::IsWindowVisible([IntPtr]$hwnd); $i++) {
      Start-Sleep -Milliseconds 250
    }
    $nowVisible = [WinUpdaterNative]::IsWindowVisible([IntPtr]$hwnd)
    if ($nowVisible) { throw 'Window remained visible after two WM_CLOSE messages' }
    @{ pid = $appPid; visible = $false } | ConvertTo-Json -Compress
  }
  'quit' {
    Stop-Process -Id $appPid -Force -ErrorAction Stop
    $true | ConvertTo-Json -Compress
  }
  'dump' {
    $nodes = @()
    if ($visible) {
      $root = [System.Windows.Automation.AutomationElement]::FromHandle([IntPtr]$hwnd)
      foreach ($el in (Get-Descendants $root)) {
        $id = [string]$el.Current.AutomationId
        $name = [string]$el.Current.Name
        if ($id -or $name) {
          $text = if ($id) { Read-ElementText $el } else { $name }
          $nodes += @{ id = $id; name = $name; text = $text; type = [string]$el.Current.ControlType.ProgrammaticName; offscreen = [bool]$el.Current.IsOffscreen }
        }
      }
    }
    @{ pid = $appPid; visible = $visible; nodes = $nodes } | ConvertTo-Json -Depth 5 -Compress
  }
}
