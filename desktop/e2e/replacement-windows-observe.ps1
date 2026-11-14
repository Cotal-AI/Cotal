param([Parameter(Mandatory=$true)][int]$TargetPid, [string]$Output, [switch]$Census, [string]$Binary, [string]$NodeBinary, [string]$Unit)
$ErrorActionPreference='Stop'
if ($Census) {
  if (!$Binary -or !$NodeBinary -or !$Unit) { throw 'Exact installed paths and scheduled task name are required.' }
  function Pin-Process([int]$Id) {
    try {
      $process=Get-Process -Id $Id -ErrorAction Stop
      $null=$process.Handle
      $birth=$process.StartTime.ToUniversalTime().ToFileTimeUtc().ToString()
      $path=$process.Path
      $row=Get-CimInstance Win32_Process -Filter "ProcessId=$Id" -Property ProcessId,ParentProcessId,ExecutablePath -ErrorAction Stop
      $process.Refresh()
      if (!$row -or $process.HasExited -or $process.StartTime.ToUniversalTime().ToFileTimeUtc().ToString() -cne $birth) { throw 'Process lifetime changed during observation.' }
      return @{state='read';pid=$Id;birth=$birth;path=$path;parentPid=[int]$row.ParentProcessId}
    } catch { return @{state='unknown';pid=$Id;reason=$_.Exception.Message} }
  }
  $daemon=Pin-Process $TargetPid
  $parent=if ($daemon.state -eq 'read') { Pin-Process $daemon.parentPid } else { @{state='unknown';reason='Daemon parent could not be read.'} }
  # Query only safe fields. Preserve every same-name unreadable candidate rather than claiming absence.
  $rows=@(Get-CimInstance Win32_Process -Filter "Name='cotal-desktop.exe' OR Name='node.exe'" -Property ProcessId,ParentProcessId,ExecutablePath -ErrorAction Stop)
  $processes=@()
  $unknown=@()
  foreach ($row in $rows) {
    if (!$row.ExecutablePath) { $unknown+=@{pid=$row.ProcessId;state='unknown';reason='Executable path unavailable'}; continue }
    if ([string]::Equals($row.ExecutablePath,$Binary,[StringComparison]::OrdinalIgnoreCase) -or [string]::Equals($row.ExecutablePath,$NodeBinary,[StringComparison]::OrdinalIgnoreCase)) {
      $processes+=Pin-Process ([int]$row.ProcessId)
    }
  }
  try {
    $tasks=@(Get-ScheduledTask -TaskPath '\' -TaskName $Unit -ErrorAction Stop)
    if ($tasks.Count -ne 1) { throw 'Exact scheduled task query was not singular.' }
    $info=Get-ScheduledTaskInfo -InputObject $tasks[0] -ErrorAction Stop
    $task=@{state='read';unit=$Unit;taskState=$tasks[0].State.ToString();lastRunTime=$(if ($null -ne $info.LastRunTime) { $info.LastRunTime.ToUniversalTime().ToString('o') } else { $null });nextRunTime=$(if ($null -ne $info.NextRunTime) { $info.NextRunTime.ToUniversalTime().ToString('o') } else { $null });lastTaskResult=$info.LastTaskResult}
  } catch { $task=@{state='unknown';unit=$Unit;reason=$_.Exception.Message} }
  @{daemon=$daemon;parent=$parent;task=$task;processes=$processes;unknownCandidates=$unknown} | ConvertTo-Json -Depth 7 -Compress
  exit 0
}
if (!$Output) { throw 'Screenshot output path required.' }
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
