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
  if (!(Test-Path -LiteralPath $receiptPath)) {
    if ($tasks.Count -ne 0) { throw 'A scheduled task exists without its installation receipt.' }
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
    $state = Get-Content -LiteralPath $statePath -Raw | ConvertFrom-Json
    if ($state.schema -ne 1 -or ![string]::Equals($state.installPath,$root,[StringComparison]::OrdinalIgnoreCase) -or $state.phase -notin @('copying','ready') -or $state.targetVersion -cne $env:COTAL_SETUP_VERSION) { throw 'An interrupted setup handover is invalid or belongs to another installer. Run the same installer again.' }
    if ($state.phase -eq 'ready') { 'finish'; exit 0 }
    if ($state.installed) {
      if (!$owned -or $owned.receiptDigest -cne $state.receiptDigest -or $owned.task.Enabled -or $owned.task.GetInstances(0).Count -ne 0) { throw 'Interrupted setup requires the unchanged owned task disabled with no running instances.' }
    } elseif ($owned) { throw 'A service appeared after interrupted setup began.' }
    if ($state.oldPid) {
      $process = Get-Process -Id $state.oldPid -ErrorAction SilentlyContinue
      if ($process -and $process.StartTime.ToUniversalTime().ToFileTimeUtc().ToString() -ceq $state.oldBirth) { throw 'The old service is still alive. No replacement was authorized.' }
    }
    $live=@(Get-CimInstance Win32_Process -Property ProcessId,ExecutablePath | Where-Object { $_.ExecutablePath -and $_.ExecutablePath.StartsWith($root+'\',[StringComparison]::OrdinalIgnoreCase) })
    if ($live.Count -ne 0) { throw 'A process still uses the interrupted installation. Close it before running setup again.' }
    'recover'; exit 0
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
