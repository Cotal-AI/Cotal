param([Parameter(Mandatory=$true)][int]$TargetPid, [Parameter(Mandatory=$true)][string]$Output)
$ErrorActionPreference='Stop'
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$process = Get-Process -Id $TargetPid -ErrorAction Stop
$null = $process.Handle
$birth = $process.StartTime.ToUniversalTime().ToFileTimeUtc().ToString()
$modules = @($process.Modules | ForEach-Object { $_.FileName })
$window = $process.MainWindowHandle
$elements = @()
if ($window -ne [IntPtr]::Zero) {
  $root=[System.Windows.Automation.AutomationElement]::FromHandle($window)
  $elements=@($root.FindAll([System.Windows.Automation.TreeScope]::Descendants,[System.Windows.Automation.Condition]::TrueCondition) | ForEach-Object {
    @{ id=$_.Current.AutomationId; text=$_.Current.Name; type=$_.Current.ControlType.ProgrammaticName; offscreen=$_.Current.IsOffscreen }
  })
}
$process.Refresh()
if ($process.HasExited -or $process.StartTime.ToUniversalTime().ToFileTimeUtc().ToString() -cne $birth) { throw 'Owned lifetime changed during query.' }
@{pid=$TargetPid;birth=$birth;path=$process.Path;modules=$modules;window=$window.ToInt64();elements=$elements} | ConvertTo-Json -Depth 6 -Compress
$bounds=[Windows.Forms.SystemInformation]::VirtualScreen
$bitmap=New-Object Drawing.Bitmap $bounds.Width,$bounds.Height
$graphics=[Drawing.Graphics]::FromImage($bitmap)
try { $graphics.CopyFromScreen($bounds.Location,[Drawing.Point]::Empty,$bounds.Size); $bitmap.Save($Output,[Drawing.Imaging.ImageFormat]::Png) }
finally { $graphics.Dispose();$bitmap.Dispose() }
