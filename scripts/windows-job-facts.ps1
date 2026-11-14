# Harness only. Windows PowerShell 5.1, native Windows2022, published npm installation supplied separately.
[CmdletBinding()]
param([Parameter(Mandatory=$true)][string]$PackageRoot, [Parameter(Mandatory=$true)][string]$Node, [Parameter(Mandatory=$true)][string]$Output)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT -or $PSVersionTable.PSEdition -ne 'Desktop' -or -not [Environment]::Is64BitProcess) { throw 'Use native x64 Windows PowerShell 5.1' }
$Node = (Get-Command $Node -CommandType Application).Source
$PackageRoot = [IO.Path]::GetFullPath($PackageRoot)
$parent = [IO.Path]::GetFullPath($Output)
$null = [IO.Directory]::CreateDirectory($parent)
$sid = [Security.Principal.WindowsIdentity]::GetCurrent().User
$directory = Join-Path $parent ('windows-job-' + [Guid]::NewGuid().ToString('N'))
$acl = New-Object Security.AccessControl.DirectorySecurity
$acl.SetOwner($sid)
$acl.SetAccessRuleProtection($true,$false)
$acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule($sid,'FullControl','ContainerInherit,ObjectInherit','None','Allow')))
$null = [IO.Directory]::CreateDirectory($directory,$acl)
$report = [ordered]@{ schema=1; cell='nativeWindows2022'; approvals=@('core57c8ff65','corrected-owner-contract'); pass=$false; directory=$directory; cases=@(); error=$null; limitations=@('Finite sampling cannot prove absence of sub-sample races','Main Node action inAnyJob only; helper immediate flags and separate direct-action control do not identify Node immediate job','No product acceptance claimed','Ambiguous live custody retained for disposable-host teardown') }
function Save($name,$value) { $value | ConvertTo-Json -Depth 30 | Set-Content -LiteralPath (Join-Path $directory $name) -Encoding UTF8 }
function Wait-File($dir,$name) {
    $clock = [Diagnostics.Stopwatch]::StartNew()
    while (-not (Test-Path -LiteralPath (Join-Path $dir $name))) {
        if ($clock.Elapsed.TotalSeconds -gt 30) { throw "Timed out: $name. Inspect retained worker failures" }
        Start-Sleep -Milliseconds 10
    }
}
function Quote($s) { if ($s.Contains('"') -or $s.Contains('%') -or $s.EndsWith('\')) { throw 'Unsafe task argument' }; return '"' + $s + '"' }
try {
    $framework = Join-Path $env:SystemRoot 'Microsoft.NET\Framework64\v4.0.30319'
    $source = Join-Path $PSScriptRoot 'windows-job-facts.cs'
    foreach ($f in @('windows-job-facts.cs','windows-job-facts.ps1')) { Copy-Item -LiteralPath (Join-Path $PSScriptRoot $f) -Destination (Join-Path $directory $f) }
    $publishedFiles = @(Get-ChildItem -LiteralPath (Join-Path $PackageRoot 'node_modules\@cotal-ai\workspace') -File -Recurse | Where-Object { $_.Name -eq 'win32-process.js' -or $_.Extension -eq '.node' -or $_.Name -eq 'package.json' })
    $publishedFiles += @(Get-ChildItem -LiteralPath (Join-Path $PackageRoot 'node_modules\@cotal-ai\seat') -File -Recurse | Where-Object { $_.Extension -eq '.node' -or $_.Name -eq 'package.json' })
    Save 'published-hashes.json' @($publishedFiles | ForEach-Object { @{ path=$_.FullName; sha256=(Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash } })
    $helper = Join-Path $directory 'windows-job-facts.exe'
    $worker = Join-Path $directory 'windows-job-facts.mjs'
    Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'windows-job-facts.mjs') -Destination $worker
    & (Join-Path $framework 'csc.exe') /nologo /target:exe /platform:x64 "/reference:$(Join-Path $framework 'System.Web.Extensions.dll')" "/reference:$(Join-Path $framework 'System.Management.dll')" "/out:$helper" $source 2>&1 | Out-File (Join-Path $directory 'compile.log')
    if ($LASTEXITCODE -ne 0) { throw 'Framework csc failed' }
    & $helper load-control $directory 2>&1 | Out-File (Join-Path $directory 'load-sharing-control.log')
    if ($LASTEXITCODE -ne 0) { throw 'Native setup JSON sharing control failed' }
    & $helper wait-controls $directory 2>&1 | Out-File (Join-Path $directory 'wait-controls.log')
    if ($LASTEXITCODE -ne 0) { throw 'Native kernel wait controls failed' }
    Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class JobPipeIdentity {
 [DllImport("kernel32.dll",SetLastError=true)] public static extern bool GetNamedPipeClientProcessId(IntPtr pipe,out uint pid);
}
'@
    $service = New-Object -ComObject Schedule.Service
    $service.Connect()
    $folder = $service.GetFolder('\')
    # Separate direct-action context control, core ea01d84d. It is not the Node action's immediate-job proof.
    try {
    $controlSource = @'
param([string]$Output)
$ErrorActionPreference='Stop'
try {
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public static class OwnJob {
 [DllImport("kernel32.dll",SetLastError=true)] public static extern bool IsProcessInJob(IntPtr process,IntPtr job,out bool inside);
 [DllImport("kernel32.dll",SetLastError=true)] public static extern bool QueryInformationJobObject(IntPtr job,int cls,IntPtr data,uint size,out uint returned);
}
"@
[bool]$inside=$false
if (-not [OwnJob]::IsProcessInJob([Diagnostics.Process]::GetCurrentProcess().Handle,[IntPtr]::Zero,[ref]$inside)) { throw "IsProcessInJob error $([Runtime.InteropServices.Marshal]::GetLastWin32Error())" }
$r=@{ pid=$PID; inJob=$inside; sid=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value; integrity=@(& "$env:SystemRoot\System32\whoami.exe" /all /fo csv); scope='Direct PowerShell control action own immediate job, not Node action job'; queries=@() }
if($inside) {
 foreach($pair in @(@(2,64),@(9,144),@(4,4),@(3,4096))) {
  $p=[Runtime.InteropServices.Marshal]::AllocHGlobal($pair[1])
  try {
   [uint32]$n=0
   if(-not [OwnJob]::QueryInformationJobObject([IntPtr]::Zero,$pair[0],$p,$pair[1],[ref]$n)) { throw "Query class $($pair[0]) error $([Runtime.InteropServices.Marshal]::GetLastWin32Error())" }
   $bytes=New-Object byte[] $pair[1]
   [Runtime.InteropServices.Marshal]::Copy($p,$bytes,0,$pair[1])
   $q=@{class=$pair[0];returned=$n;raw=[Convert]::ToBase64String($bytes)}
   if($pair[0] -eq 2 -or $pair[0] -eq 9) { $q.flags=[BitConverter]::ToUInt32($bytes,16);$q.processTime100ns=[BitConverter]::ToInt64($bytes,0).ToString();$q.jobTime100ns=[BitConverter]::ToInt64($bytes,8).ToString() }
   $r.queries += $q
  } finally { [Runtime.InteropServices.Marshal]::FreeHGlobal($p) }
 }
}
$r | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath ($Output+'.tmp') -Encoding UTF8
Move-Item -LiteralPath ($Output+'.tmp') -Destination $Output
} catch { @{error=$_.Exception.ToString()} | ConvertTo-Json | Set-Content -LiteralPath $Output -Encoding UTF8; exit 1 }
'@
    $controlPath = Join-Path $directory 'scheduler-context-control.ps1'
    $controlResult = Join-Path $directory 'scheduler-context-control.json'
    $controlSource | Set-Content -LiteralPath $controlPath -Encoding UTF8
    $controlName = 'cotal-job-context-' + [Guid]::NewGuid().ToString('N')
    $cd = $service.NewTask(0)
    $cd.Principal.UserId=$sid.Value; $cd.Principal.LogonType=3; $cd.Principal.RunLevel=0
    $cd.Settings.AllowDemandStart=$true; $cd.Settings.MultipleInstances=2; $cd.Settings.RestartCount=0
    $cd.Settings.DisallowStartIfOnBatteries=$false; $cd.Settings.StopIfGoingOnBatteries=$false; $cd.Settings.ExecutionTimeLimit='PT0S'
    $ca=$cd.Actions.Create(0)
    $ca.Path=Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
    $ca.Arguments='-NoProfile -NonInteractive -ExecutionPolicy Bypass -File '+(Quote $controlPath)+' -Output '+(Quote $controlResult)
    $ca.WorkingDirectory=$directory
    $ct=$folder.RegisterTaskDefinition($controlName,$cd,2,$sid.Value,$null,3)
    $report.contextControl=@{task=$controlName;xml=$ct.Xml;scope='Separate direct action control only. Helper context does not establish same immediate job as Node.'}
    $cr=$ct.Run($null)
    Wait-File $directory 'scheduler-context-control.json'
    $controlFacts=Get-Content -Raw -LiteralPath $controlResult | ConvertFrom-Json
    if($null -ne $controlFacts.PSObject.Properties['error']) { throw 'Direct action context control failed' }
    $report.contextControl.facts=$controlFacts
    $report.contextControl.instanceGuid=$cr.InstanceGuid
    } catch { $report.contextControl=@{ error=$_.Exception.ToString(); scope='Separate control failed. Main falsification phases still execute independently.' } }
    # Keep control registration for disposable teardown, never stop an unpinned action.
    foreach ($mode in @('kill','normal')) {
        $dir = Join-Path $directory $mode
        $null = [IO.Directory]::CreateDirectory($dir)
        [IO.File]::WriteAllBytes((Join-Path $dir 'gate.bin'),[byte[]]@(71))
        $name = 'cotal-job-facts-' + [Guid]::NewGuid().ToString('N')
        $pipeName = $name
        $pipeAcl = New-Object IO.Pipes.PipeSecurity
        $pipeAcl.AddAccessRule((New-Object IO.Pipes.PipeAccessRule($sid,'FullControl','Allow')))
        $pipe = New-Object IO.Pipes.NamedPipeServerStream($pipeName,[IO.Pipes.PipeDirection]::In,1,[IO.Pipes.PipeTransmissionMode]::Byte,[IO.Pipes.PipeOptions]::Asynchronous,4096,4096,$pipeAcl)
        $entry = [ordered]@{ mode=$mode; task=$name; directory=$dir; observations=@(); error=$null; cleanup='retained until verified quiescent' }
        $report.cases += $entry
        $registeredXml = $null
        $p = $null
        $censusAgent = $null
        $observer = $null
        try {
            $definition = $service.NewTask(0)
            $definition.RegistrationInfo.Description = $name
            $definition.Principal.UserId = $sid.Value
            $definition.Principal.LogonType = 3
            $definition.Principal.RunLevel = 0 # LeastPrivilege
            $definition.Settings.AllowDemandStart = $true
            $definition.Settings.MultipleInstances = 2
            $definition.Settings.RestartCount = 0
            $definition.Settings.DisallowStartIfOnBatteries = $false
            $definition.Settings.StopIfGoingOnBatteries = $false
            $definition.Settings.ExecutionTimeLimit = 'PT0S'
            if ($definition.Triggers.Count -ne 0) { throw 'Unexpected task trigger' }
            $action = $definition.Actions.Create(0)
            $action.Path = $Node
            $action.WorkingDirectory = $dir
            $action.Arguments = (Quote $worker) + ' runner ' + (Quote $dir) + ' ' + (Quote $PackageRoot) + ' ' + (Quote $helper) + ' ' + (Quote ('\\.\pipe\' + $pipeName))
            $task = $folder.RegisterTaskDefinition($name,$definition,2,$sid.Value,$null,3)
            $registeredXml = $task.Xml
            $entry.taskXml = $registeredXml
            $connection = $pipe.BeginWaitForConnection($null,$null)
            $started = [DateTime]::UtcNow
            $running = $task.Run($null)
            $entry.instanceGuid = $running.InstanceGuid
            if (-not $connection.AsyncWaitHandle.WaitOne(30000)) { throw 'Private readiness pipe timeout, no PID ownership inferred' }
            $pipe.EndWaitForConnection($connection)
            [uint32]$clientPid = 0
            if (-not [JobPipeIdentity]::GetNamedPipeClientProcessId($pipe.SafePipeHandle.DangerousGetHandle(),[ref]$clientPid)) { throw 'Cannot obtain kernel pipe client PID' }
            $reader = New-Object IO.StreamReader($pipe)
            $line = $reader.ReadLineAsync()
            if (-not $line.Wait(10000)) { throw 'Private pipe identity timeout' }
            $id = $line.Result | ConvertFrom-Json
            if ($id.pid -ne $clientPid -or $id.sid -cne $sid.Value -or $id.executable -ine $Node) { throw 'Authenticated identity mismatch' }
            $p = Get-Process -Id $clientPid
            $null = $p.Handle # pin before birth/path verification
            $birth = $p.StartTime.ToUniversalTime()
            if ($birth.ToFileTimeUtc().ToString() -cne $id.token -or $p.Path -ine $Node -or $birth -lt $started.AddSeconds(-1)) { throw 'Pinned birth/executable mismatch' }
            $nativeAction = Get-CimInstance Win32_Process -Filter "ProcessId = $clientPid"
            $commands = @(((Quote $Node) + ' ' + $action.Arguments), ($Node + ' ' + $action.Arguments))
            if ($nativeAction.CommandLine -cnotin $commands -or $nativeAction.ExecutablePath -ine $Node) { throw 'Exact scheduled action command mismatch' }
            $entry.action = @{ identity=$id; kernelPipePid=$clientPid; command=$nativeAction.CommandLine; parentPid=$nativeAction.ParentProcessId }
            # Outside the workspace job. Pins only PIDs supplied by its exact native member list.
            $censusAgent = Start-Process -FilePath $helper -ArgumentList @('census',(Quote $dir)) -PassThru -RedirectStandardError (Join-Path $dir 'census-agent-error.log') -RedirectStandardOutput (Join-Path $dir 'census-agent.log')
            $null = $censusAgent.Handle
            Wait-File $dir 'ready.json'
            $runnerFile = Get-Content -Raw -LiteralPath (Join-Path $dir 'runner.json') | ConvertFrom-Json
            if ($runnerFile.pid -ne $clientPid -or $runnerFile.token -cne $id.token) { throw 'Private file identity differs from authenticated runner' }
            $entry.integrity = @(& "$env:SystemRoot\System32\whoami.exe" /all /fo csv)
            $running.Refresh()
            $entry.observations += @{ phase='before'; utc=[DateTime]::UtcNow.ToString('o'); taskState=[int]$task.State; instanceState=[int]$running.State; enginePid=$running.EnginePID; instanceGuid=$running.InstanceGuid }
            # Independent contender pins descendants before any kill. No Task.Stop or process-tree kill.
            $observer = Start-Process -FilePath $helper -ArgumentList @('observe',(Quote $dir),$mode) -PassThru -RedirectStandardError (Join-Path $dir 'observer-error.log') -RedirectStandardOutput (Join-Path $dir 'observer.log')
            $null = $observer.Handle
            Wait-File $dir 'contender-ready.json'
            $armed = Get-Content -Raw -LiteralPath (Join-Path $dir 'ready.json') | ConvertFrom-Json
            $pinned = Get-Content -Raw -LiteralPath (Join-Path $dir 'contender-ready.json') | ConvertFrom-Json
            $expected = @($armed.census | ForEach-Object { "$($_.pid):$($_.token)" } | Sort-Object)
            $actual = @($pinned.census | ForEach-Object { "$($_.pid):$($_.token)" } | Sort-Object)
            if (($expected -join ',') -cne ($actual -join ',') -or @($pinned.alive | Where-Object { $_ -ne $true }).Count -ne 0) { throw 'Contender did not pin the full live armed census' }
            $entry.armedCensus = $armed
            $entry.pinnedCensus = $pinned
            [IO.File]::WriteAllText((Join-Path $dir 'verify-census'),'')
            Wait-File $dir 'census-verified.json'
            if ($p.HasExited) { throw 'Runner exited before contender readiness' }
            if ($folder.GetTask($name).Xml -cne $registeredXml) { throw 'Task ownership changed' }
            [IO.File]::WriteAllText((Join-Path $dir 'go'),'')
            if (-not $observer.WaitForExit(45000)) { throw 'Observer timeout, retained custody for teardown' }
            $observer.WaitForExit() # Drain redirected output after confirmed process exit.
            $entry.observation = Get-Content -Raw -LiteralPath (Join-Path $dir 'observation.json') | ConvertFrom-Json
            try {
                $running.Refresh()
                $entry.observations += @{ phase='after'; utc=[DateTime]::UtcNow.ToString('o'); taskState=[int]$task.State; instanceState=[int]$running.State; enginePid=$running.EnginePID }
            } catch {
                $cause = $_.Exception
                while ($null -ne $cause.InnerException) { $cause = $cause.InnerException }
                if ($cause.HResult -ne -2147216629) { throw } # SCHED_E_TASK_NOT_RUNNING 0x8004130B
                $settledTask = $folder.GetTask($name)
                $entry.observations += @{ phase='after'; utc=[DateTime]::UtcNow.ToString('o'); taskState=[int]$settledTask.State; instanceAbsent=$true; nativeError='0x8004130B' }
            }
            if (-not $p.WaitForExit(10000)) { throw 'Runner not quiescent after measurement' }
            if ($observer.ExitCode -ne 0 -or -not $entry.observation.pass) { throw 'Native measurement falsified or incomplete, inspect every sample' }
            [IO.File]::WriteAllText((Join-Path $dir 'census-agent-stop'),'')
            if (-not $censusAgent.WaitForExit(10000) -or $censusAgent.ExitCode -ne 0) { throw 'Census agent failed or did not settle' }
            $ownedTask = $folder.GetTask($name)
            if ($ownedTask.Xml -cne $registeredXml) { throw 'Task ownership changed before registration cleanup' }
            if ($ownedTask.GetInstances(0).Count -ne 0) { throw 'Owned task still has an instance after native quiescence' }
            $folder.DeleteTask($name,0)
            $entry.cleanup = 'Exact owned registration deleted after runner/descendants quiescent; evidence retained'
        } catch { $entry.error = $_.Exception.ToString() }
        finally {
            # Release only our diagnostic agent by its cooperative stop file and pinned Process.
            # Never kill a task, manager or unclassified process to make evidence collection pass.
            if ($null -ne $censusAgent) {
                [IO.File]::WriteAllText((Join-Path $dir 'census-agent-stop'),'')
                if (-not $censusAgent.WaitForExit(35000)) { $entry.error = 'Owned census agent did not settle; retained for disposable-host teardown' }
                else { $censusAgent.WaitForExit() } # Flush redirected streams before hashing.
                $censusAgent.Dispose()
            }
            if ($null -ne $observer) { $observer.Dispose() }
            if ($null -ne $p) { $p.Dispose() }
            $pipe.Dispose()
        }
    }
    $report.mainPass = @($report.cases | Where-Object { $null -ne $_.error }).Count -eq 0
    $report.contextComparison = @()
    foreach ($case in $report.cases) {
        $helperPath = Join-Path $case.directory 'scheduler-job.json'
        if (Test-Path -LiteralPath $helperPath) {
            $hf = Get-Content -Raw -LiteralPath $helperPath | ConvertFrom-Json
            $comparison = @{ mode=$case.mode; helper=$hf; interpretation='Helper flags never establish Node immediate-job limits. Separate direct-action control is contextual only.' }
            if ($report.contextControl.ContainsKey('facts')) {
                $comparison.directControl=$report.contextControl.facts
                $extended = @($report.contextControl.facts.queries | Where-Object { $_.class -eq 9 })
                if ($extended.Count -eq 1) { $comparison.flagsDisagree=($extended[0].flags -ne $hf.limitFlags) }
            }
            $report.contextComparison += $comparison
        }
    }
    $report.pass = $report.mainPass -and -not $report.contextControl.ContainsKey('error')
} catch { $report.error = $_.Exception.ToString() }
finally {
    $report.sid = $sid.Value
    $report.node = $Node
    $report.packageRoot = $PackageRoot
    Save 'report.json' $report
    $hashes = @(Get-ChildItem -LiteralPath $directory -File -Recurse | ForEach-Object { @{ path=$_.FullName; sha256=(Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash } })
    Save 'artifact-hashes.json' $hashes
    $report | ConvertTo-Json -Depth 30
}
if (-not $report.pass) { exit 1 }
