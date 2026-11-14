# Harness only. Run once with Windows PowerShell 5.1 in an interactive Windows session.
# powershell.exe -NoProfile -NonInteractive -File scripts/windows-task-facts.ps1 -Output <evidence-directory>
# Persists windows-task-facts.json and windows-task-facts.failure.txt on failure, plus stdout JSON.
# Existing evidence files are never overwritten. No native acceptance is implied by static checks.
# The action writes no files, including result.json. Its readiness travels only over a private pipe.
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$Output,
    [ValidateRange(5,120)][int]$TimeoutSeconds = 30
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$outputRoot = [IO.Path]::GetFullPath($Output)
$null = [IO.Directory]::CreateDirectory($outputRoot)
$reportPath = Join-Path $outputRoot 'windows-task-facts.json'
$failurePath = Join-Path $outputRoot 'windows-task-facts.failure.txt'
if ((Test-Path -LiteralPath $reportPath) -or (Test-Path -LiteralPath $failurePath)) { throw 'Refusing to overwrite existing task evidence' }
$report = [ordered]@{ schema = 1; fatalError = $null; cases = @() }
$failed = $false
function Write-NewEvidence($path, $text) {
    $stream = [IO.File]::Open($path, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::Read)
    try {
        $bytes = [Text.UTF8Encoding]::new($false).GetBytes($text)
        $stream.Write($bytes, 0, $bytes.Length)
    } finally { $stream.Dispose() }
}
try {
if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT) { throw 'Native Windows is required' }
if ($PSVersionTable.PSEdition -ne 'Desktop') { throw 'Use System32 WindowsPowerShell v1.0 powershell.exe (5.1), not pwsh' }

Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class TaskFactsPipe {
    [DllImport("kernel32.dll", SetLastError=true)]
    public static extern bool GetNamedPipeClientProcessId(IntPtr pipe, out uint pid);
}
'@
$sid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$exe = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
$whoami = Join-Path $env:SystemRoot 'System32\whoami.exe'
$service = New-Object -ComObject Schedule.Service
$service.Connect()
$folder = $service.GetFolder('\')
$report = [ordered]@{
    schema = 1
    fatalError = $null
    startedUtc = [DateTime]::UtcNow.ToString('o')
    nativeAcceptance = 'Not asserted: inspect observations and errors on the native host'
    currentSid = $sid
    os = [Environment]::OSVersion.VersionString
    powershell = $PSVersionTable.PSVersion.ToString()
    scheduler = 'Schedule.Service (local COM), taskschd.dll'
    executable = $exe
    executableVersion = (Get-Item -LiteralPath $exe).VersionInfo.FileVersion
    actionLifetimeLimitSeconds = 300
    safetyQuestion = 'Does DeleteTask remove only registration while this exact action survives, and does scheduler state settle after pre-result action termination? Observations answer, not EnginePID inference.'
    integrity = @(& $whoami /groups /fo csv /nh)
    provenance = @('Get-Process -Id', 'Win32_Process WHERE ProcessId = <owned PID>', 'GetNamedPipeClientProcessId', 'whoami.exe /groups /fo csv /nh')
    docs = @(
        'https://learn.microsoft.com/en-us/windows/win32/taskschd/taskservice',
        'https://learn.microsoft.com/en-us/windows/win32/taskschd/runningtask',
        'https://learn.microsoft.com/en-us/windows/win32/taskschd/taskfolder-registertaskdefinition',
        'https://learn.microsoft.com/en-us/windows/win32/taskschd/taskfolder-deletetask',
        'https://learn.microsoft.com/en-us/windows/win32/api/winbase/nf-winbase-getnamedpipeclientprocessid'
    )
    cases = @()
}

function Get-ExactTask($name) {
    try { return $folder.GetTask($name) }
    catch {
        if ($_.Exception.HResult -eq -2147024894) { return $null } # HRESULT_FROM_WIN32(ERROR_FILE_NOT_FOUND)
        throw
    }
}
function Assert-TaskOwner($name, $xml) {
    $t = Get-ExactTask $name
    if ($null -eq $t -or $t.Xml -cne $xml) { throw "Ambiguous task ownership: $name" }
    return $t
}
function Read-OwnedProcess($identity) {
    try { $p = Get-Process -Id $identity.pid -ErrorAction Stop }
    catch [Microsoft.PowerShell.Commands.ProcessCommandException] { return $null }
    # Pin the process handle BEFORE inspecting birth/executable, not after validation.
    $null = $p.Handle
    if ($p.HasExited) { $p.Dispose(); return $null }
    if ($p.StartTime.ToUniversalTime().Ticks.ToString() -cne $identity.birthTicks -or $p.Path -ine $identity.executable) {
        $p.Dispose()
        throw 'PID birth/executable changed, refusing process operation'
    }
    return $p
}
function Stop-OwnedProcess($identity) {
    $p = Read-OwnedProcess $identity
    if ($null -ne $p) {
        try { $p.Kill(); if (-not $p.WaitForExit(10000)) { throw 'Owned process did not exit' } }
        finally { $p.Dispose() }
    }
}
function Snapshot($name, $identity, $resultPath) {
    $t = Get-ExactTask $name
    $instances = @()
    $xml = $null
    $state = $null
    if ($null -ne $t) {
        $xml = $t.Xml
        $state = [int]$t.State
        foreach ($instance in $t.GetInstances(0)) {
            $instance.Refresh()
            $instances += [ordered]@{ instanceGuid = $instance.InstanceGuid; enginePID = $instance.EnginePID; currentAction = $instance.CurrentAction; state = [int]$instance.State }
        }
    }
    $p = Read-OwnedProcess $identity
    $alive = $null -ne $p
    if ($alive) { $p.Dispose() }
    return [ordered]@{ utc = [DateTime]::UtcNow.ToString('o'); taskPresent = $null -ne $t; taskState = $state; taskXml = $xml; instances = $instances; exactExecIdentity = $identity; exactExecAlive = $alive; resultAbsent = -not (Test-Path -LiteralPath $resultPath) }
}

foreach ($case in @('terminate-pre-result', 'delete-while-running')) {
    $nonce = [Guid]::NewGuid().ToString('N')
    $name = "cotal-task-facts-$nonce"
    $root = Join-Path ([IO.Path]::GetTempPath()) $name
    $probePath = Join-Path $root 'probe.ps1'
    $resultPath = Join-Path $root 'result.json'
    $pipeName = "cotal-task-facts-$nonce"
    $identity = $null
    $registeredXml = $null
    $pipe = $null
    $entry = [ordered]@{ case = $case; taskName = $name; scratch = $root; observations = @(); error = $null; cleanup = @() }
    $report.cases += $entry
    try {
        # A new GUID path, restricted before any script is written. No shared scratch or reuse.
        if (Test-Path -LiteralPath $root) { throw 'Scratch already exists' }
        $acl = New-Object Security.AccessControl.DirectorySecurity
        $acl.SetAccessRuleProtection($true, $false)
        $owner = New-Object Security.Principal.SecurityIdentifier($sid)
        $acl.SetOwner($owner)
        $rule = New-Object Security.AccessControl.FileSystemAccessRule($owner, 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow')
        $acl.AddAccessRule($rule)
        $null = [IO.Directory]::CreateDirectory($root, $acl)
        @'
param([string]$PipeName, [string]$ExpectedPath)
$ErrorActionPreference = 'Stop'
if ($PSCommandPath -cne $ExpectedPath) { throw 'Unexpected probe path' }
$p = Get-Process -Id $PID
$client = New-Object IO.Pipes.NamedPipeClientStream('.', $PipeName, [IO.Pipes.PipeDirection]::Out)
$client.Connect(30000)
$writer = New-Object IO.StreamWriter($client)
$writer.AutoFlush = $true
$writer.WriteLine((@{ pid = $PID; birthTicks = $p.StartTime.ToUniversalTime().Ticks.ToString(); executable = $p.Path; sid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value; integrity = @(& "$env:SystemRoot\System32\whoami.exe" /groups /fo csv /nh) } | ConvertTo-Json -Compress))
# Never write a result file, even after readiness. Controller owns all observations.
# Self-expiry bounds an orphan if controller readiness fails. No unverified PID is killed.
$expires = [DateTime]::UtcNow.AddMinutes(5)
while ([DateTime]::UtcNow -lt $expires) { Start-Sleep -Seconds 1 }
'@ | Set-Content -LiteralPath $probePath -Encoding UTF8
        $pipeAcl = New-Object IO.Pipes.PipeSecurity
        $pipeAcl.AddAccessRule((New-Object IO.Pipes.PipeAccessRule($owner, 'FullControl', 'Allow')))
        $pipe = New-Object IO.Pipes.NamedPipeServerStream($pipeName, [IO.Pipes.PipeDirection]::In, 1, [IO.Pipes.PipeTransmissionMode]::Byte, [IO.Pipes.PipeOptions]::Asynchronous, 4096, 4096, $pipeAcl)
        $definition = $service.NewTask(0)
        $definition.RegistrationInfo.Description = $name
        $definition.Principal.UserId = $sid
        $definition.Principal.LogonType = 3 # InteractiveToken
        $definition.Principal.RunLevel = 0 # LeastPrivilege
        $definition.Settings.AllowDemandStart = $true
        $definition.Settings.MultipleInstances = 2 # IgnoreNew
        $definition.Settings.RestartCount = 0
        $definition.Settings.DisallowStartIfOnBatteries = $false
        $definition.Settings.StopIfGoingOnBatteries = $false
        $definition.Settings.ExecutionTimeLimit = 'PT0S'
        if ($definition.Triggers.Count -ne 0) { throw 'Unexpected trigger' }
        $action = $definition.Actions.Create(0)
        $action.Path = $exe
        if ($probePath.Contains('%') -or $probePath.Contains('"')) { throw 'Unsafe task path' }
        $action.Arguments = '-NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "' + $probePath + '" -PipeName ' + $pipeName + ' -ExpectedPath "' + $probePath + '"'
        $action.WorkingDirectory = $root
        # TASK_CREATE only. Never overwrite an existing name.
        $task = $folder.RegisterTaskDefinition($name, $definition, 2, $sid, $null, 3)
        $registeredXml = $task.Xml
        $entry.registeredXml = $registeredXml
        $startUtc = [DateTime]::UtcNow
        $connection = $pipe.BeginWaitForConnection($null, $null)
        $running = $task.Run($null)
        $entry.runInstanceGuid = $running.InstanceGuid
        if (-not $connection.AsyncWaitHandle.WaitOne($TimeoutSeconds * 1000)) { throw 'Readiness pipe timed out, no process ownership inferred' }
        $pipe.EndWaitForConnection($connection)
        [uint32]$clientPid = 0
        if (-not [TaskFactsPipe]::GetNamedPipeClientProcessId($pipe.SafePipeHandle.DangerousGetHandle(), [ref]$clientPid)) { throw 'Cannot identify pipe client' }
        $reader = New-Object IO.StreamReader($pipe)
        $line = $reader.ReadLineAsync()
        if (-not $line.Wait($TimeoutSeconds * 1000)) { throw 'Readiness payload timed out' }
        $candidate = $line.Result | ConvertFrom-Json
        if ($candidate.pid -ne $clientPid -or $candidate.sid -cne $sid -or $candidate.executable -ine $exe) { throw 'Readiness identity mismatch' }
        $p = Read-OwnedProcess $candidate
        if ($null -eq $p) { throw 'Action exited before verification' }
        try {
            if ($p.StartTime.ToUniversalTime() -lt $startUtc.AddSeconds(-1)) { throw 'Action predates demand start' }
            $native = Get-CimInstance Win32_Process -Filter "ProcessId = $clientPid"
            # Scheduler may quote the executable even when its path contains no spaces.
            $expectedCommands = @(('"' + $exe + '" ' + $action.Arguments), ($exe + ' ' + $action.Arguments))
            if ($null -eq $native -or $native.ExecutablePath -ine $exe -or $native.CommandLine -cnotin $expectedCommands) { throw 'Exact native action command mismatch' }
            $identity = $candidate
            $entry.nativeAction = @{ processId = $native.ProcessId; parentProcessId = $native.ParentProcessId; creationDate = $native.CreationDate.ToUniversalTime().ToString('o'); executablePath = $native.ExecutablePath; commandLine = $native.CommandLine }
        } finally { $p.Dispose() }
        $null = Assert-TaskOwner $name $registeredXml
        $before = Snapshot $name $identity $resultPath
        $entry.observations += $before
        if (-not $before.exactExecAlive -or $before.taskState -ne 4 -or $before.instances.Count -ne 1 -or $before.instances[0].instanceGuid -cne $entry.runInstanceGuid) { throw 'Demand-started instance was not uniquely running' }
        if ($case -eq 'terminate-pre-result') {
            Stop-OwnedProcess $identity
            # Observe eventual scheduler state, bounded, without assuming engine PID is Exec PID.
            $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
            do {
                $null = Assert-TaskOwner $name $registeredXml
                $after = Snapshot $name $identity $resultPath
                if ($after.instances.Count -eq 0) { break }
                Start-Sleep -Milliseconds 100
            } while ([DateTime]::UtcNow -lt $deadline)
            $entry.observations += $after
            if ($after.exactExecAlive) { throw 'Exact action survived termination' }
        } else {
            $null = Assert-TaskOwner $name $registeredXml
            $folder.DeleteTask($name, 0)
            $entry.observations += Snapshot $name $identity $resultPath
            Start-Sleep -Milliseconds 500
            $after = Snapshot $name $identity $resultPath
            $entry.observations += $after
            $entry.rawProcessSurvivalAfterDelete = $after.exactExecAlive
            if ($after.taskPresent) { throw 'Task still present after DeleteTask' }
        }
        foreach ($observation in $entry.observations) { if (-not $observation.resultAbsent) { throw 'Unexpected result file' } }
    } catch { $entry.error = $_.Exception.ToString() }
    finally {
        if ($null -ne $identity) {
            try { Stop-OwnedProcess $identity; $entry.cleanup += 'Exact birth/executable matched action stopped or already exited' }
            catch { $entry.cleanup += "Process cleanup refused: $($_.Exception.Message)"; $entry.error = "Process cleanup refused: $($_.Exception.Message)" }
        }
        if ($null -ne $registeredXml) {
            try {
                if ($null -ne (Get-ExactTask $name)) {
                    $null = Assert-TaskOwner $name $registeredXml
                    $folder.DeleteTask($name, 0)
                }
                $entry.cleanup += 'Exact registered task absent'
            } catch { $entry.cleanup += "Task cleanup refused: $($_.Exception.Message)"; $entry.error = "Task cleanup refused: $($_.Exception.Message)" }
        }
        if ($null -ne $pipe) { $pipe.Dispose() }
        # Retain scratch as evidence, especially on ambiguous ownership or readiness failure.
        $entry.cleanup += 'Private scratch retained, caller owns removal after native review'
    }
}
$failed = @($report.cases | Where-Object { $null -ne $_.error }).Count -gt 0
} catch {
    $report.fatalError = $_.Exception.ToString()
    $failed = $true
} finally {
    $json = $report | ConvertTo-Json -Depth 15
    Write-NewEvidence $reportPath $json
    if ($failed) {
        $failure = @($report.fatalError) + @($report.cases | ForEach-Object { $_.error })
        Write-NewEvidence $failurePath ($failure -join [Environment]::NewLine)
    }
    $json
}
if ($failed) { exit 1 }
