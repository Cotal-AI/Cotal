param([int]$AppPid, [string]$Destination)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type @'
using System;
using System.Runtime.InteropServices;
public class CotalWindow {
  [StructLayout(LayoutKind.Sequential)] public struct Rect { public int Left, Top, Right, Bottom; }
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr window, out Rect rect);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr window);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr window, int command);
  [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr window, uint message, IntPtr w, IntPtr l);
}
'@
$app = Get-Process -Id $AppPid
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
