# Failure-only installed-window diagnostic. Never activates Retry or a connection action.
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][ValidateRange(1, 2147483647)][int]$AppPid,
    [Parameter(Mandatory = $true)][string]$Binary
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$report = [ordered]@{ ok = $false; pid = $AppPid; birth = $null; hwnd = $null; processTree = $null; before = @(); after = @(); invokedDetails = $false; refusal = $null }
try {
    Add-Type -AssemblyName UIAutomationClient
    Add-Type -AssemblyName UIAutomationTypes
    Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class LaunchDetailsWindow {
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hwnd);
}
'@
    $expected = (Get-Item -LiteralPath $Binary).FullName
    $owner = Get-Process -Id $AppPid
    $null = $owner.Handle
    $report.birth = $owner.StartTime.ToUniversalTime().ToString('o')
    if (![string]::Equals($owner.Path, $expected, [StringComparison]::OrdinalIgnoreCase)) { throw 'Launch PID does not own the installed binary.' }
    $hwnd = $owner.MainWindowHandle
    $report.hwnd = $hwnd.ToInt64()
    function Assert-WindowOwner {
        $owner.Refresh()
        if ($owner.HasExited -or $owner.StartTime.ToUniversalTime().ToString('o') -cne $report.birth) { throw 'Installed app process lifetime changed.' }
        [uint32]$windowPid = 0
        $null = [LaunchDetailsWindow]::GetWindowThreadProcessId($hwnd, [ref]$windowPid)
        if ($windowPid -ne $AppPid -or ![LaunchDetailsWindow]::IsWindowVisible($hwnd)) { throw 'Installed window is no longer visible and owned.' }
    }
    Assert-WindowOwner
    try {
        $processes = @(Get-CimInstance Win32_Process -Property Name,ProcessId,ParentProcessId,CreationDate)
        $descendants = [System.Collections.Generic.List[object]]::new()
        $parents = @($AppPid)
        $seen = [System.Collections.Generic.HashSet[int]]::new()
        $null = $seen.Add($AppPid)
        while ($parents.Count -gt 0) {
            $next = @()
            foreach ($process in $processes) {
                if ($process.ParentProcessId -in $parents -and $seen.Add([int]$process.ProcessId)) {
                    $descendants.Add([ordered]@{ name = $process.Name; pid = $process.ProcessId; parentPid = $process.ParentProcessId; creationTime = $process.CreationDate.ToUniversalTime().ToString('o') })
                    $next += [int]$process.ProcessId
                }
            }
            $parents = $next
        }
        Assert-WindowOwner
        $report.processTree = @($descendants.ToArray())
    } catch { $report['processTreeError'] = $_.Exception.Message }
    $root = [System.Windows.Automation.AutomationElement]::FromHandle($hwnd)
    function Nodes($parent) {
        $parent.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition)
    }
    function Read-Nodes($elements) {
        @($elements | ForEach-Object {
            [ordered]@{ id = $_.Current.AutomationId; name = $_.Current.Name; type = $_.Current.ControlType.ProgrammaticName; offscreen = $_.Current.IsOffscreen }
        })
    }
    $nodes = @(Nodes $root)
    $report.before = @(Read-Nodes $nodes)
    $details = @($nodes | Where-Object { $_.Current.AutomationId -ceq 'details' -and !$_.Current.IsOffscreen })
    if ($details.Count -ne 1) { throw 'Expected one visible Details disclosure in the failed installed window.' }
    $refusal = @($nodes | Where-Object { $_.Current.AutomationId -ceq 'refusal-detail' -and !$_.Current.IsOffscreen })
    if ($refusal.Count -eq 0) {
        $buttons = @(Nodes $details[0] | Where-Object { $_.Current.Name -ceq 'Details' -and $_.Current.ControlType -eq [System.Windows.Automation.ControlType]::Button -and !$_.Current.IsOffscreen -and $_.Current.IsEnabled })
        if ($buttons.Count -ne 1) { throw 'Expected one enabled native Details button inside the exact disclosure.' }
        $invoke = $null
        if (!$buttons[0].TryGetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern, [ref]$invoke)) { throw 'Native Details button has no InvokePattern.' }
        Assert-WindowOwner
        $invoke.Invoke()
        $report.invokedDetails = $true
        Start-Sleep -Milliseconds 800
    }
    Assert-WindowOwner
    $nodes = @(Nodes $root)
    $report.after = @(Read-Nodes $nodes)
    $refusal = @($nodes | Where-Object { $_.Current.AutomationId -ceq 'refusal-detail' -and !$_.Current.IsOffscreen })
    if ($refusal.Count -ne 1) { throw 'Expanded Details did not expose one visible exact refusal.' }
    $text = @($refusal[0].Current.Name) + @((Nodes $refusal[0]) | ForEach-Object { $_.Current.Name })
    $report.refusal = ($text | Where-Object { $_ } | Select-Object -Unique) -join "`n"
    if ([string]::IsNullOrWhiteSpace($report.refusal)) { throw 'Expanded Details exposed no refusal text.' }
    $report.ok = $true
} catch {
    $report['error'] = $_.Exception.Message
} finally {
    $report | ConvertTo-Json -Depth 8 -Compress
}
if (!$report.ok) { exit 1 }
