param([Parameter(Mandatory=$true)][ValidateSet('inspect','disable','enable','start','census','recover')][string]$Action)
function Write-SetupStep([string]$Step) {
  try {
    $elapsed=[long]([DateTime]::UtcNow-[Diagnostics.Process]::GetCurrentProcess().StartTime.ToUniversalTime()).TotalMilliseconds
    $directory=[IO.Path]::Combine($env:LOCALAPPDATA,'CotalSetup')
    $null=[IO.Directory]::CreateDirectory($directory)
    $file=[IO.Path]::Combine($directory,'helper.log')
    $line='{"action":"'+$script:Action+'","step":"'+$Step+'","elapsedMs":'+$elapsed+',"pid":'+$PID+'}'
    [IO.File]::AppendAllText($file,$line+"`n",[Text.UTF8Encoding]::new($false))
    $lines=[IO.File]::ReadAllLines($file)
    if($lines.Length -gt 200){[IO.File]::WriteAllLines($file,$lines[($lines.Length-200)..($lines.Length-1)],[Text.UTF8Encoding]::new($false))}
  } catch { # Diagnostics must not replace the action's result.
  }
}
Write-SetupStep 'start'
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$root = [IO.Path]::GetFullPath($env:COTAL_SETUP_ROOT).TrimEnd('\')
$statePath = Join-Path $env:LOCALAPPDATA 'CotalSetup\service-update.json'
Write-SetupStep 'identity-read'
$sid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$name = "cotal-daemon-$sid"
function File-Digest([string]$Path) {
  Write-SetupStep 'digest'
  $stream=[IO.File]::OpenRead($Path)
  $algorithm=[Security.Cryptography.SHA256]::Create()
  try { return [BitConverter]::ToString($algorithm.ComputeHash($stream)).Replace('-','').ToLowerInvariant() }
  finally { $algorithm.Dispose(); $stream.Dispose() }
}
function Get-OwnedTask {
  $receiptPath = Join-Path $env:LOCALAPPDATA 'Cotal\daemon\service-unit.json'
  Write-SetupStep 'scheduler-create'
  $scheduler = New-Object -ComObject Schedule.Service
  Write-SetupStep 'scheduler-connect'
  $scheduler.Connect()
  Write-SetupStep 'task-folder'
  $folder = $scheduler.GetFolder('\')
  Write-SetupStep 'task-read'
  $tasks = @($folder.GetTasks(1) | Where-Object { $_.Name -ceq $name })
  if ($tasks.Count -gt 0) {
    $action=$tasks[0].Definition.Actions
    if ($action.Count -eq 1 -and ![string]::Equals($action.Item(1).Path,(Join-Path $root 'cotal-desktop.exe'),[StringComparison]::OrdinalIgnoreCase)) {
      $belongsHere=$false
      if (Test-Path -LiteralPath $receiptPath) {
        Write-SetupStep 'foreign-receipt-read'
        $record=Get-Content -Raw -LiteralPath $receiptPath | ConvertFrom-Json
        if (Test-Path -LiteralPath $record.unitPath) {
          Write-SetupStep 'foreign-source-read'
          [xml]$recordedSource=Get-Content -Raw -LiteralPath $record.unitPath
          $belongsHere=[string]::Equals([string]$recordedSource.Task.Actions.Exec.Command,(Join-Path $root 'cotal-desktop.exe'),[StringComparison]::OrdinalIgnoreCase)
        }
      }
      if ($belongsHere) { throw 'The registered application task changed from its owned definition.' }
      return @{foreign=$true;task=$tasks[0]}
    }
  }
  if (!(Test-Path -LiteralPath $receiptPath)) {
    if ($tasks.Count -ne 0) { throw 'An application task exists without its installation receipt.' }
    return $null
  }
  Write-SetupStep 'receipt-read'
  $receipt = Get-Content -Raw -LiteralPath $receiptPath | ConvertFrom-Json
  $source = Join-Path $env:LOCALAPPDATA 'Cotal\daemon\service-task.xml'
  if ($receipt.v -ne 1 -or $receipt.mechanism -cne 'scheduled-task' -or $receipt.unit -cne $name -or $receipt.unitPath -cne $source -or $receipt.daemonHome) { throw 'The service receipt does not name this user and default daemon.' }
  if ((File-Digest $source) -cne $receipt.unitSha256) { throw 'The recorded task source changed.' }
  if ($tasks.Count -ne 1) { throw 'The recorded scheduled task is missing or ambiguous.' }
  Write-SetupStep 'source-read'
  [xml]$xml = Get-Content -Raw -LiteralPath $source
  $task = $tasks[0]
  $actions = $task.Definition.Actions
  $principal = $task.Definition.Principal
  $user = $principal.UserId
  Write-SetupStep 'principal-read'
  if ($user -notmatch '^S-1-') { $user = ([Security.Principal.NTAccount]::new($user)).Translate([Security.Principal.SecurityIdentifier]).Value }
  if ($actions.Count -ne 1 -or $actions.Item(1).Path -cne [string]$xml.Task.Actions.Exec.Command -or $actions.Item(1).Arguments -cne [string]$xml.Task.Actions.Exec.Arguments -or $actions.Item(1).WorkingDirectory -cne [string]$xml.Task.Actions.Exec.WorkingDirectory -or $user -cne $sid -or $principal.LogonType -ne 3 -or $principal.RunLevel -ne 0) { throw 'The registered task no longer matches the owned definition.' }
  if (![string]::Equals($actions.Item(1).Path,(Join-Path $root 'cotal-desktop.exe'),[StringComparison]::OrdinalIgnoreCase) -or $actions.Item(1).Arguments -cne '--daemon') { throw 'The service belongs to another installation.' }
  return @{ task=$task; receipt=$receipt; receiptDigest=(File-Digest $receiptPath) }
}
try {
  Write-SetupStep 'module-management'
  Import-Module "$PSHOME\Modules\Microsoft.PowerShell.Management\Microsoft.PowerShell.Management.psd1"
  Write-SetupStep 'module-utility'
  Import-Module "$PSHOME\Modules\Microsoft.PowerShell.Utility\Microsoft.PowerShell.Utility.psd1"
  Write-SetupStep 'module-cim'
  Import-Module "$PSHOME\Modules\CimCmdlets\CimCmdlets.psd1"
  function Read-OwnedProcesses {
    Write-SetupStep 'process-list'
    if (!(Test-Path -LiteralPath $root -PathType Container)) {
      return @{ processes=@(); skipped=@(); executableNames=@() }
    }
    $exeSet = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
    foreach ($file in (Get-ChildItem -LiteralPath $root -Recurse -File -Filter '*.exe')) {
      $null = $exeSet.Add([string]$file.Name)
    }
    $rows = @(Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId,ExecutablePath,Name,CreationDate)
    $savedCurrentDir = [Environment]::CurrentDirectory
    try {
      [Environment]::CurrentDirectory = $PSHOME
      Add-Type @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class CensusProcess {
  [DllImport("kernel32.dll", SetLastError = true)]
  public static extern IntPtr OpenProcess(uint access, bool inherit, int pid);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  public static extern bool QueryFullProcessImageNameW(IntPtr process, uint flags, StringBuilder exe, ref uint size);
  [DllImport("kernel32.dll", SetLastError = true)]
  public static extern bool GetExitCodeProcess(IntPtr process, out uint exitCode);
  [DllImport("kernel32.dll", SetLastError = true)]
  public static extern bool GetProcessTimes(IntPtr process, out long creation, out long exit, out long kernel, out long user);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  public static extern IntPtr CreateFileW(string name, uint access, uint share, IntPtr security, uint disposition, uint flags, IntPtr templateFile);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  public static extern uint GetFinalPathNameByHandleW(IntPtr file, StringBuilder path, uint size, uint flags);
  [DllImport("kernel32.dll", SetLastError = true)]
  public static extern bool CloseHandle(IntPtr handle);
}
'@
    } finally {
      [Environment]::CurrentDirectory = $savedCurrentDir
    }
    $finalRoot = $null
    $rootHandle = [CensusProcess]::CreateFileW($root, 0, 7, [IntPtr]::Zero, 3, 0x02000000, [IntPtr]::Zero)
    if ($rootHandle -eq [IntPtr]::new(-1) -or $rootHandle -eq [IntPtr]::Zero) {
      $err = [Runtime.InteropServices.Marshal]::GetLastWin32Error()
      throw "Cannot identify installation folder $root (CreateFileW error $err). Run the installer again."
    }
    try {
      $rootSb = [Text.StringBuilder]::new(32768)
      $rootLen = [CensusProcess]::GetFinalPathNameByHandleW($rootHandle, $rootSb, [uint32]$rootSb.Capacity, 0)
      if ($rootLen -eq 0 -or $rootLen -ge $rootSb.Capacity) {
        $err = [Runtime.InteropServices.Marshal]::GetLastWin32Error()
        throw "Cannot identify installation folder $root (GetFinalPathNameByHandleW error $err). Run the installer again."
      }
      $finalRoot = $rootSb.ToString().TrimEnd('\')
    } finally {
      [CensusProcess]::CloseHandle($rootHandle) | Out-Null
    }
    if ([string]::IsNullOrWhiteSpace($finalRoot)) {
      throw "Cannot identify installation folder $root (empty final path). Run the installer again."
    }
    $owned = @()
    $skipped = @()
    foreach ($row in $rows) {
      $isNamedCandidate = [bool]($row.Name -and $exeSet.Contains([string]$row.Name))
      $isWmiUnderRoot = [bool]($row.ExecutablePath -and $row.ExecutablePath.StartsWith($root+'\',[StringComparison]::OrdinalIgnoreCase))
      if (!$isNamedCandidate -and !$isWmiUnderRoot) { continue }
      $created = if ($row.CreationDate) { $row.CreationDate.ToUniversalTime().ToString('o') } else { 'unknown' }
      if ($row.ExecutablePath) {
        $wmiHandle = [CensusProcess]::CreateFileW([string]$row.ExecutablePath, 0, 7, [IntPtr]::Zero, 3, 0x02000000, [IntPtr]::Zero)
        if ($wmiHandle -eq [IntPtr]::new(-1) -or $wmiHandle -eq [IntPtr]::Zero) {
          $err = [Runtime.InteropServices.Marshal]::GetLastWin32Error()
          $wmiCheck = [CensusProcess]::OpenProcess(0x00001000, $false, [int]$row.ProcessId)
          if ($wmiCheck -eq [IntPtr]::Zero) {
            if ([Runtime.InteropServices.Marshal]::GetLastWin32Error() -eq 87) { continue }
          } else {
            try {
              $wmiCode = [uint32]0
              if ([CensusProcess]::GetExitCodeProcess($wmiCheck, [ref]$wmiCode) -and $wmiCode -ne 259) { continue }
            } finally {
              [CensusProcess]::CloseHandle($wmiCheck) | Out-Null
            }
          }
          throw "Cannot identify $($row.Name) process $($row.ProcessId), parent $($row.ParentProcessId), created $created (WMI CreateFileW error $err). Close it before running setup again."
        }
        try {
          $wmiSb = [Text.StringBuilder]::new(32768)
          $wmiLen = [CensusProcess]::GetFinalPathNameByHandleW($wmiHandle, $wmiSb, [uint32]$wmiSb.Capacity, 0)
          if ($wmiLen -eq 0 -or $wmiLen -ge $wmiSb.Capacity) {
            $err = [Runtime.InteropServices.Marshal]::GetLastWin32Error()
            throw "Cannot identify $($row.Name) process $($row.ProcessId), parent $($row.ParentProcessId), created $created (WMI GetFinalPathNameByHandleW error $err). Close it before running setup again."
          }
          $isWmiUnderRoot = $wmiSb.ToString().StartsWith($finalRoot+'\',[StringComparison]::OrdinalIgnoreCase)
        } finally {
          [CensusProcess]::CloseHandle($wmiHandle) | Out-Null
        }
      }
      $handle = [CensusProcess]::OpenProcess(0x00001000, $false, [int]$row.ProcessId)
      if ($handle -eq [IntPtr]::Zero) {
        $err = [Runtime.InteropServices.Marshal]::GetLastWin32Error()
        if ($err -eq 87) { continue }
        if ($err -eq 5 -and $isNamedCandidate -and !$isWmiUnderRoot) {
          $skipped += @{ pid=[int]$row.ProcessId; name=[string]$row.Name; error='ERROR_ACCESS_DENIED (5)' }
          continue
        }
        throw "Cannot identify $($row.Name) process $($row.ProcessId), parent $($row.ParentProcessId), created $created (Win32 error $err). Close it before running setup again."
      }
      try {
        $exitCode = [uint32]0
        if (![CensusProcess]::GetExitCodeProcess($handle, [ref]$exitCode)) {
          $err = [Runtime.InteropServices.Marshal]::GetLastWin32Error()
          throw "Cannot identify $($row.Name) process $($row.ProcessId), parent $($row.ParentProcessId), created $created (GetExitCodeProcess error $err). Close it before running setup again."
        }
        if ($exitCode -ne 259) { continue }
        $sb = [Text.StringBuilder]::new(32768)
        $size = [uint32]32768
        if (![CensusProcess]::QueryFullProcessImageNameW($handle, 0, $sb, [ref]$size)) {
          $err = [Runtime.InteropServices.Marshal]::GetLastWin32Error()
          $recheck = [uint32]0
          if ([CensusProcess]::GetExitCodeProcess($handle, [ref]$recheck) -and $recheck -ne 259) { continue }
          throw "Cannot identify $($row.Name) process $($row.ProcessId), parent $($row.ParentProcessId), created $created (QueryFullProcessImageNameW error $err). Close it before running setup again."
        }
        $rawImagePath = $sb.ToString()
        $fileHandle = [CensusProcess]::CreateFileW($rawImagePath, 0, 7, [IntPtr]::Zero, 3, 0x02000000, [IntPtr]::Zero)
        if ($fileHandle -eq [IntPtr]::new(-1) -or $fileHandle -eq [IntPtr]::Zero) {
          $err = [Runtime.InteropServices.Marshal]::GetLastWin32Error()
          $recheck = [uint32]0
          if ([CensusProcess]::GetExitCodeProcess($handle, [ref]$recheck) -and $recheck -ne 259) { continue }
          throw "Cannot identify $($row.Name) process $($row.ProcessId), parent $($row.ParentProcessId), created $created (CreateFileW error $err). Close it before running setup again."
        }
        $finalImagePath = $null
        try {
          $finalSb = [Text.StringBuilder]::new(32768)
          $finalLen = [CensusProcess]::GetFinalPathNameByHandleW($fileHandle, $finalSb, [uint32]$finalSb.Capacity, 0)
          if ($finalLen -eq 0 -or $finalLen -ge $finalSb.Capacity) {
            $err = [Runtime.InteropServices.Marshal]::GetLastWin32Error()
            throw "Cannot identify $($row.Name) process $($row.ProcessId), parent $($row.ParentProcessId), created $created (GetFinalPathNameByHandleW error $err). Close it before running setup again."
          }
          $finalImagePath = $finalSb.ToString()
        } finally {
          [CensusProcess]::CloseHandle($fileHandle) | Out-Null
        }
        $creationTime = [long]0; $exitTime = [long]0; $kernelTime = [long]0; $userTime = [long]0
        if (![CensusProcess]::GetProcessTimes($handle, [ref]$creationTime, [ref]$exitTime, [ref]$kernelTime, [ref]$userTime)) {
          $err = [Runtime.InteropServices.Marshal]::GetLastWin32Error()
          throw "Cannot identify $($row.Name) process $($row.ProcessId), parent $($row.ParentProcessId), created $created (GetProcessTimes error $err). Close it before running setup again."
        }
        $birth = $creationTime.ToString()
        if ($finalImagePath.StartsWith($finalRoot+'\',[StringComparison]::OrdinalIgnoreCase)) {
          $owned += @{ pid=[int]$row.ProcessId; parentPid=[int]$row.ParentProcessId; name=[string]$row.Name; path=($root + $finalImagePath.Substring($finalRoot.Length)); birth=$birth }
        }
      } finally {
        [CensusProcess]::CloseHandle($handle) | Out-Null
      }
    }
    return @{ processes=$owned; skipped=$skipped; executableNames=@($exeSet | Sort-Object) }
  }
  if ($Action -eq 'census') {
    ConvertTo-Json -InputObject (Read-OwnedProcesses) -Depth 5 -Compress
    Write-SetupStep 'return'; exit 0
  }
  $owned = Get-OwnedTask
  if ($Action -eq 'recover') {
    Write-SetupStep 'handover-check'
    if (!(Test-Path -LiteralPath $statePath)) { 'none'; Write-SetupStep 'return'; exit 0 }
    $state=$null
    $damaged=$false
    $recoveryMessage='An unreadable or invalid setup handover was repaired. Prior running state was unknown, so no service was started.'
    try {
      Write-SetupStep 'handover-read'
      $state=Get-Content -LiteralPath $statePath -Raw | ConvertFrom-Json
      if ($state.schema -ne 1 -or $state.phase -notin @('preparing','copying','ready') -or $state.installPath -isnot [string]) { $damaged=$true }
      elseif (![string]::Equals($state.installPath,$root,[StringComparison]::OrdinalIgnoreCase)) {
        $damaged=$true
        if (!(Test-Path -LiteralPath $state.installPath -PathType Container)) { $recoveryMessage='The setup handover named an installation folder that no longer exists. It was repaired. Prior running state was unknown, so no service was started.' }
        else { $recoveryMessage='The setup handover named another installation. It was repaired. Prior running state was unknown, so no service was started.' }
      }
    } catch { $damaged=$true }
    if (!$damaged -and $state.phase -eq 'ready') {
      Write-SetupStep 'handover-remove-ready'
      Remove-Item -LiteralPath $statePath
      'none'; Write-SetupStep 'return'; exit 0
    }
    if (!$damaged -and $state.phase -eq 'preparing' -and $state.oldPid) {
      Write-SetupStep 'old-process-read'
      $process=Get-Process -Id $state.oldPid -ErrorAction SilentlyContinue
      if ($process -and $process.StartTime.ToUniversalTime().ToFileTimeUtc().ToString() -ceq $state.oldBirth) {
        if (!$owned -or $owned.foreign -or $owned.receiptDigest -cne $state.receiptDigest) { throw 'The original service ownership changed during preparation.' }
        Write-SetupStep 'task-restore'
        $owned.task.Enabled=[bool]$state.taskEnabled
        Write-SetupStep 'handover-remove-preparing'
        Remove-Item -LiteralPath $statePath
        'none'; Write-SetupStep 'return'; exit 0
      }
    }
    $scan=Read-OwnedProcesses
    $ownedRows=@($scan.processes)
    $apps=[Collections.Generic.HashSet[int]]::new()
    foreach($row in $ownedRows) { if ([string]::Equals($row.path,(Join-Path $root 'cotal-desktop.exe'),[StringComparison]::OrdinalIgnoreCase)) { $null=$apps.Add([int]$row.pid) } }
    do {
      $changed=$false
      foreach($row in $ownedRows) { if ($apps.Contains([int]$row.parentPid) -and $apps.Add([int]$row.pid)) { $changed=$true } }
    } while($changed)
    $live=@($ownedRows | Where-Object { !$apps.Contains([int]$_.pid) })
    if ($live.Count -ne 0) { throw 'Another program still uses the interrupted installation or could not be identified. Close it before running setup again.' }
    if ($owned -and !$owned.foreign -and $owned.task.GetInstances(0).Count -ne 0) { throw 'The owned task still has a native instance. No replacement was authorized.' }
    if ($damaged) {
      $state=@{schema=1;installPath=$root;targetVersion=$env:COTAL_SETUP_VERSION;oldVersion=$null;installed=[bool]($owned -and !$owned.foreign);foreign=[bool]($owned -and $owned.foreign);taskEnabled=[bool]($owned -and !$owned.foreign -and $owned.task.Enabled);running=$false;receiptDigest=$(if($owned -and !$owned.foreign){$owned.receiptDigest}else{$null});skippedProcesses=@($scan.skipped);executableNames=@($scan.executableNames);phase='copying';recoveryMessage=$recoveryMessage}
    } else {
      if ($state.installed -and (!$owned -or $owned.foreign -or $owned.receiptDigest -cne $state.receiptDigest)) { throw 'The owned task changed during interrupted setup.' }
      $state.phase='copying'
      $state.targetVersion=$env:COTAL_SETUP_VERSION
      $state | Add-Member -NotePropertyName skippedProcesses -NotePropertyValue @($scan.skipped) -Force
      $state | Add-Member -NotePropertyName executableNames -NotePropertyValue @($scan.executableNames) -Force
    }
    if ($owned -and !$owned.foreign) {
      Write-SetupStep 'task-disable-recovery'
      $owned.task.Enabled=$false
      if ($owned.task.Enabled -or $owned.task.GetInstances(0).Count -ne 0) { throw 'The owned task did not confirm disabled zero-instance state for recovery.' }
    }
    Write-SetupStep 'handover-write'
    [IO.File]::WriteAllText($statePath,($state|ConvertTo-Json -Compress),[Text.UTF8Encoding]::new($false))
    'recover'; Write-SetupStep 'return'; exit 0
  }
  if ($owned -and $owned.foreign) {
    if ($Action -ne 'inspect' -and $Action -ne 'recover') { throw 'The service belongs to another installation and was not changed.' }
    '{"installed":false,"foreign":true}'; Write-SetupStep 'return'; exit 0
  }
  if (!$owned) {
    if ($Action -ne 'inspect') { throw 'No owned service was installed.' }
    '{"installed":false}'; Write-SetupStep 'return'; exit 0
  }
  $task = $owned.task
  Write-SetupStep 'task-action'
  switch ($Action) {
    'disable' { $task.Enabled = $false; if ($task.Enabled) { throw 'The owned task did not become disabled.' } }
    'enable' { $task.Enabled = $true; if (!$task.Enabled) { throw 'The owned task did not become enabled.' } }
    'start' { if (!$task.Enabled) { throw 'The owned task is disabled.' }; if ($task.GetInstances(0).Count -eq 0) { $null = $task.Run($null) } }
  }
  ConvertTo-Json -InputObject @{ installed=$true; enabled=[bool]$task.Enabled; instances=[int]$task.GetInstances(0).Count; receiptDigest=$owned.receiptDigest; unit=$name } -Compress
} catch {
  Write-SetupStep 'error'
  $message=$_.Exception.Message -replace '[\r\n\x00-\x1f]',' '
  $resultDirectory=Join-Path $env:LOCALAPPDATA 'CotalSetup'
  $null=New-Item -ItemType Directory -Path $resultDirectory -Force
  $result=@{schema=1;outcome='refused';code=21;message=$message;activeAgents=0;fromVersion=$null;toVersion=$env:COTAL_SETUP_VERSION;completedAt=[DateTime]::UtcNow.ToString('o')} | ConvertTo-Json -Compress
  Write-SetupStep 'result-write'
  [IO.File]::WriteAllText((Join-Path $resultDirectory 'result.json'),$result,[Text.UTF8Encoding]::new($false))
  [IO.File]::WriteAllText((Join-Path $resultDirectory 'message.txt'),$message+"`r`n")
  [Console]::Error.WriteLine($message)
  exit 21
} finally { Write-SetupStep 'exit' }
