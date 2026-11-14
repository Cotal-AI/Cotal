param([Parameter(Mandatory=$true)][ValidateSet('inspect','disable','enable','start','census','recover')][string]$Action)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$root = [IO.Path]::GetFullPath($env:COTAL_SETUP_ROOT).TrimEnd('\')
$statePath = Join-Path $env:LOCALAPPDATA 'CotalSetup\service-update.json'
$sid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$name = "cotal-daemon-$sid"
function Get-OwnedTask {
  $receiptPath = Join-Path $env:LOCALAPPDATA 'Cotal\daemon\service-unit.json'
  $scheduler = New-Object -ComObject Schedule.Service
  $scheduler.Connect()
  $folder = $scheduler.GetFolder('\')
  $tasks = @($folder.GetTasks(1) | Where-Object { $_.Name -ceq $name })
  if ($tasks.Count -gt 0) {
    $action=$tasks[0].Definition.Actions
    if ($action.Count -eq 1 -and ![string]::Equals($action.Item(1).Path,(Join-Path $root 'cotal-desktop.exe'),[StringComparison]::OrdinalIgnoreCase)) {
      $belongsHere=$false
      if (Test-Path -LiteralPath $receiptPath) {
        $record=Get-Content -Raw -LiteralPath $receiptPath | ConvertFrom-Json
        if (Test-Path -LiteralPath $record.unitPath) {
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
  $receipt = Get-Content -Raw -LiteralPath $receiptPath | ConvertFrom-Json
  $source = Join-Path $env:LOCALAPPDATA 'Cotal\daemon\service-task.xml'
  if ($receipt.v -ne 1 -or $receipt.mechanism -cne 'scheduled-task' -or $receipt.unit -cne $name -or $receipt.unitPath -cne $source -or $receipt.daemonHome) { throw 'The service receipt does not name this user and default daemon.' }
  if ((Get-FileHash -LiteralPath $source -Algorithm SHA256).Hash.ToLowerInvariant() -cne $receipt.unitSha256) { throw 'The recorded task source changed.' }
  if ($tasks.Count -ne 1) { throw 'The recorded scheduled task is missing or ambiguous.' }
  [xml]$xml = Get-Content -Raw -LiteralPath $source
  $task = $tasks[0]
  $actions = $task.Definition.Actions
  $principal = $task.Definition.Principal
  $user = $principal.UserId
  if ($user -notmatch '^S-1-') { $user = ([Security.Principal.NTAccount]::new($user)).Translate([Security.Principal.SecurityIdentifier]).Value }
  if ($actions.Count -ne 1 -or $actions.Item(1).Path -cne [string]$xml.Task.Actions.Exec.Command -or $actions.Item(1).Arguments -cne [string]$xml.Task.Actions.Exec.Arguments -or $actions.Item(1).WorkingDirectory -cne [string]$xml.Task.Actions.Exec.WorkingDirectory -or $user -cne $sid -or $principal.LogonType -ne 3 -or $principal.RunLevel -ne 0) { throw 'The registered task no longer matches the owned definition.' }
  if (![string]::Equals($actions.Item(1).Path,(Join-Path $root 'cotal-desktop.exe'),[StringComparison]::OrdinalIgnoreCase) -or $actions.Item(1).Arguments -cne '--daemon') { throw 'The service belongs to another installation.' }
  return @{ task=$task; receipt=$receipt; receiptDigest=(Get-FileHash -LiteralPath $receiptPath -Algorithm SHA256).Hash.ToLowerInvariant() }
}
try {
  if ($Action -eq 'census') {
    $rows = @(Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId,ExecutablePath,Name,CreationDate)
    $owned = @()
    foreach ($row in $rows) {
      if (!$row.ExecutablePath) {
        if ($row.Name -in @('node.exe','cotal-desktop.exe')) { throw "Cannot identify $($row.Name) process $($row.ProcessId)." }
        continue
      }
      if ($row.ExecutablePath.StartsWith($root+'\',[StringComparison]::OrdinalIgnoreCase)) {
        $owned += @{ pid=[int]$row.ProcessId; parentPid=[int]$row.ParentProcessId; name=$row.Name; path=$row.ExecutablePath; birth=$row.CreationDate.ToUniversalTime().ToFileTimeUtc().ToString() }
      }
    }
    ConvertTo-Json -InputObject @{ processes=$owned } -Depth 5 -Compress
    exit 0
  }
  $owned = Get-OwnedTask
  if ($Action -eq 'recover') {
    if (!(Test-Path -LiteralPath $statePath)) { 'none'; exit 0 }
    $state=$null
    $damaged=$false
    try {
      $state=Get-Content -LiteralPath $statePath -Raw | ConvertFrom-Json
      if ($state.schema -ne 1 -or ![string]::Equals($state.installPath,$root,[StringComparison]::OrdinalIgnoreCase) -or $state.phase -notin @('preparing','copying','ready')) { $damaged=$true }
    } catch { $damaged=$true }
    if (!$damaged -and $state.phase -eq 'ready') {
      Remove-Item -LiteralPath $statePath
      'none'; exit 0
    }
    if (!$damaged -and $state.phase -eq 'preparing' -and $state.oldPid) {
      $process=Get-Process -Id $state.oldPid -ErrorAction SilentlyContinue
      if ($process -and $process.StartTime.ToUniversalTime().ToFileTimeUtc().ToString() -ceq $state.oldBirth) {
        if (!$owned -or $owned.foreign -or $owned.receiptDigest -cne $state.receiptDigest) { throw 'The original service ownership changed during preparation.' }
        $owned.task.Enabled=[bool]$state.taskEnabled
        Remove-Item -LiteralPath $statePath
        'none'; exit 0
      }
    }
    $live=@(Get-CimInstance Win32_Process -Property ProcessId,ExecutablePath,Name | Where-Object { ($_.ExecutablePath -and $_.ExecutablePath.StartsWith($root+'\',[StringComparison]::OrdinalIgnoreCase)) -or (!$_.ExecutablePath -and $_.Name -in @('node.exe','cotal-desktop.exe')) })
    if ($live.Count -ne 0) { throw 'A process still uses the interrupted installation or could not be identified. Close it before running setup again.' }
    if ($owned -and !$owned.foreign -and $owned.task.GetInstances(0).Count -ne 0) { throw 'The owned task still has a native instance. No replacement was authorized.' }
    if ($damaged) {
      $state=@{schema=1;installPath=$root;targetVersion=$env:COTAL_SETUP_VERSION;oldVersion=$null;installed=[bool]($owned -and !$owned.foreign);foreign=[bool]($owned -and $owned.foreign);taskEnabled=[bool]($owned -and !$owned.foreign -and $owned.task.Enabled);running=$false;receiptDigest=$(if($owned -and !$owned.foreign){$owned.receiptDigest}else{$null});phase='copying';recoveryMessage='An unreadable setup handover was repaired. Prior running state was unknown, so no service was started.'}
    } else {
      if ($state.installed -and (!$owned -or $owned.foreign -or $owned.receiptDigest -cne $state.receiptDigest)) { throw 'The owned task changed during interrupted setup.' }
      $state.phase='copying'
      $state.targetVersion=$env:COTAL_SETUP_VERSION
    }
    if ($owned -and !$owned.foreign) {
      $owned.task.Enabled=$false
      if ($owned.task.Enabled) { throw 'The owned task did not confirm disabled state for recovery.' }
    }
    [IO.File]::WriteAllText($statePath,($state|ConvertTo-Json -Compress),[Text.UTF8Encoding]::new($false))
    'recover'; exit 0
  }
  if ($owned -and $owned.foreign) {
    if ($Action -ne 'inspect' -and $Action -ne 'recover') { throw 'The service belongs to another installation and was not changed.' }
    '{"installed":false,"foreign":true}'; exit 0
  }
  if (!$owned) {
    if ($Action -ne 'inspect') { throw 'No owned service was installed.' }
    '{"installed":false}'; exit 0
  }
  $task = $owned.task
  switch ($Action) {
    'disable' { $task.Enabled = $false; if ($task.Enabled) { throw 'The owned task did not become disabled.' } }
    'enable' { $task.Enabled = $true; if (!$task.Enabled) { throw 'The owned task did not become enabled.' } }
    'start' { if (!$task.Enabled) { throw 'The owned task is disabled.' }; if ($task.GetInstances(0).Count -eq 0) { $null = $task.Run($null) } }
  }
  ConvertTo-Json -InputObject @{ installed=$true; enabled=[bool]$task.Enabled; instances=[int]$task.GetInstances(0).Count; receiptDigest=$owned.receiptDigest; unit=$name } -Compress
} catch {
  $message=$_.Exception.Message -replace '[\r\n\x00-\x1f]',' '
  $resultDirectory=Join-Path $env:LOCALAPPDATA 'CotalSetup'
  $null=New-Item -ItemType Directory -Path $resultDirectory -Force
  $result=@{schema=1;outcome='refused';code=21;message=$message;activeAgents=0;fromVersion=$null;toVersion=$env:COTAL_SETUP_VERSION;completedAt=[DateTime]::UtcNow.ToString('o')} | ConvertTo-Json -Compress
  [IO.File]::WriteAllText((Join-Path $resultDirectory 'result.json'),$result,[Text.UTF8Encoding]::new($false))
  [IO.File]::WriteAllText((Join-Path $resultDirectory 'message.txt'),$message+"`r`n")
  [Console]::Error.WriteLine($message)
  exit 21
}
