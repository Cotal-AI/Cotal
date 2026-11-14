param([int]$AppPid, [string]$Destination)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type @'
using System;
using System.Collections.Generic;
using System.Text;
using System.Runtime.InteropServices;
public class CotalWindow {
  [StructLayout(LayoutKind.Sequential)] public struct Rect { public int Left, Top, Right, Bottom; }
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr window, out Rect rect);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr window);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr window, int command);
  [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr window, uint message, IntPtr w, IntPtr l);
  public delegate bool EnumWindowProc(IntPtr window, IntPtr data);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowProc callback, IntPtr data);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr window);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr window, out uint pid);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr window, StringBuilder text, int count);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetClassName(IntPtr window, StringBuilder text, int count);
  public class Observation {
    public long handle;
    public string title, windowClass;
    public bool boundsRead;
    public int left, top, right, bottom;
  }
  public static Observation[] VisibleWindows(uint target) {
    var rows = new List<Observation>();
    EnumWindows((window, data) => {
      uint pid; GetWindowThreadProcessId(window, out pid);
      if (pid != target || !IsWindowVisible(window)) return true;
      var title = new StringBuilder(1024);
      var windowClass = new StringBuilder(256);
      GetWindowText(window, title, title.Capacity);
      GetClassName(window, windowClass, windowClass.Capacity);
      Rect bounds;
      bool boundsRead = GetWindowRect(window, out bounds);
      rows.Add(new Observation { handle=window.ToInt64(), title=title.ToString(),
        windowClass=windowClass.ToString(), boundsRead=boundsRead,
        left=bounds.Left, top=bounds.Top, right=bounds.Right, bottom=bounds.Bottom });
      return true;
    }, IntPtr.Zero);
    return rows.ToArray();
  }
}
'@
$app = Get-Process -Id $AppPid
# Observation only. MainWindowHandle below remains the existing selector.
$windowCensus = @()
$windowCensusError = $null
try { $windowCensus = @([CotalWindow]::VisibleWindows([uint32]$AppPid)) }
catch { $windowCensusError = $_.Exception.Message }
@{ at=[DateTime]::UtcNow.ToString('o'); pid=$AppPid; windows=$windowCensus; error=$windowCensusError } |
  ConvertTo-Json -Depth 5 -Compress | Add-Content -Encoding utf8 ([IO.Path]::ChangeExtension($Destination, '.windows.jsonl'))
$window = $app.MainWindowHandle
if ($window -eq [IntPtr]::Zero) { throw 'The app has no visible main window.' }
[CotalWindow]::ShowWindow($window, 9) | Out-Null
[CotalWindow]::SetForegroundWindow($window) | Out-Null
Start-Sleep -Milliseconds 500
$rect = New-Object CotalWindow+Rect
if (-not [CotalWindow]::GetWindowRect($window, [ref]$rect)) { throw 'Cannot read app window bounds.' }
$bitmap = New-Object System.Drawing.Bitmap ($rect.Right-$rect.Left), ($rect.Bottom-$rect.Top)
$graphics = [System.Drawing.Graphics]::FromImage($bitmap)
try {
  $graphics.CopyFromScreen($rect.Left, $rect.Top, 0, 0, $bitmap.Size)
  $bitmap.Save($Destination, [System.Drawing.Imaging.ImageFormat]::Png)
} finally { $graphics.Dispose(); $bitmap.Dispose() }
Write-Output "Captured PID $AppPid window $window to $Destination"
$root = [System.Windows.Automation.AutomationElement]::FromHandle($window)
$nodes = $root.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition)
$readback = @($nodes | ForEach-Object { @{ id=$_.Current.AutomationId; name=$_.Current.Name; type=$_.Current.ControlType.ProgrammaticName } })
$readback | ConvertTo-Json -Depth 4 | Set-Content -Encoding utf8 ([IO.Path]::ChangeExtension($Destination, '.accessibility.json'))
