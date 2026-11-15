param([Parameter(Mandatory=$true)][string]$Installer,[Parameter(Mandatory=$true)][string]$Output,[Parameter(Mandatory=$true)][string]$ExpectedVersion)
$ErrorActionPreference='Stop'
if($env:RUNNER_ENVIRONMENT -cne 'github-hosted'){throw 'Probe requires an owned disposable Windows runner.'}
$null=New-Item -ItemType Directory -Path $Output -Force
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class ProbePaths {
 [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] public static extern uint GetShortPathNameW(string path,StringBuilder output,uint size);
 [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] public static extern uint GetLongPathNameW(string path,StringBuilder output,uint size);
}
'@
$root=Join-Path $env:LOCALAPPDATA 'Cotal'
$setup=Join-Path $env:LOCALAPPDATA 'CotalSetup'
$handover=Join-Path $setup 'service-update.json'
$env:COTAL_TELEMETRY='off'
$env:COTAL_SKIP_CONNECTOR_SEED='1'
$ownsHandover=$false
$report=@{head=$env:GITHUB_SHA;expectedVersion=$ExpectedVersion;psModulePath=$env:PSModulePath;installerSha256=(Get-FileHash $Installer -Algorithm SHA256).Hash.ToLowerInvariant();cases=@();status='incomplete'}
function Read-Normalized([string]$File) { return [IO.File]::ReadAllText($File,[Text.Encoding]::UTF8).Replace("`r`n","`n") }
function Save { [IO.File]::WriteAllText((Join-Path $Output 'result.json'),($report|ConvertTo-Json -Depth 15),[Text.UTF8Encoding]::new($false)) }
function Path-Api([string]$Path,[bool]$Short) {
 $buffer=[Text.StringBuilder]::new(32768)
 $count=if($Short){[ProbePaths]::GetShortPathNameW($Path,$buffer,32768)}else{[ProbePaths]::GetLongPathNameW($Path,$buffer,32768)}
 if($count -eq 0 -or $count -ge 32768){throw "Path API failed: $Path"}
 return $buffer.ToString()
}
function Start-Owned([string]$File,[string[]]$Arguments,[string]$Capture='',[string]$InputText='') {
 $info=[Diagnostics.ProcessStartInfo]::new()
 $info.FileName=$File
 $info.Arguments=$Arguments -join ' '
 $info.UseShellExecute=$false
 if($Capture){$info.RedirectStandardOutput=$true;$info.RedirectStandardError=$true}
 if($InputText){$info.RedirectStandardInput=$true}
 $child=[Diagnostics.Process]::new()
 $child.StartInfo=$info
 if(!$child.Start()){throw 'Owned process could not start.'}
 $null=$child.Handle
 $inputError=$null
 if($InputText){try{$child.StandardInput.Write($InputText);$child.StandardInput.Close()}catch{$inputError=$_.Exception.Message}}
 if($Capture){return @{process=$child;stdout=$child.StandardOutput.ReadToEndAsync();stderr=$child.StandardError.ReadToEndAsync();inputError=$inputError}}
 return @{process=$child}
}
function Invoke-Probe([string]$Role,[string]$Launch,[string]$StatePath,[string]$Label,[bool]$ExpectedRefusal=$true,[bool]$Plant=$true) {
 if($Plant){[IO.File]::WriteAllText($handover,(@{schema=1;installPath=$StatePath;phase='copying'}|ConvertTo-Json -Compress),[Text.UTF8Encoding]::new($false))}
 $entry=@{label=$Label;role=$Role;launchRoot=$Launch;handoverPath=$StatePath;expectedRefusal=$ExpectedRefusal;outcome=$null;refused=$false;observationComplete=$false}
 $process=$null
 try {
  if($Role -eq 'app-bridge') {
   $process=(Start-Owned ([IO.Path]::Combine($Launch,'cotal-desktop.exe')) @()).process
   $deadline=[DateTime]::UtcNow.AddSeconds(45)
   $names=@()
   do {
    $process.Refresh()
    if($process.HasExited){break}
    $windows=[Windows.Automation.AutomationElement]::RootElement.FindAll([Windows.Automation.TreeScope]::Children,[Windows.Automation.PropertyCondition]::new([Windows.Automation.AutomationElement]::ProcessIdProperty,$process.Id))
    $names=@()
    foreach($window in $windows){foreach($element in $window.FindAll([Windows.Automation.TreeScope]::Descendants,[Windows.Automation.Condition]::TrueCondition)){$names+=$element.Current.Name}}
    if(($names -contains 'Setup was interrupted') -or ($names -contains 'The background service is not running') -or ($names -contains 'This operation could not finish')){break}
    Start-Sleep -Milliseconds 300
   } while([DateTime]::UtcNow -lt $deadline)
   $entry.outcome=@{pid=$process.Id;uiNames=$names;exited=$process.HasExited;exit=$(if($process.HasExited){$process.ExitCode}else{$null})}
   $entry.refused=($names -contains 'Setup was interrupted') -and (($names -join ' ') -match 'Run the installer again to finish updating Cotal\.')
   $entry.screenValuesValid=!(($names -join ' ') -match 'undefined|NaN')
   $entry.observationComplete=($names.Count -gt 0 -or $process.HasExited)
  } else {
   $stdout=Join-Path $Output "$Label-$Role.stdout.txt"
   $stderr=Join-Path $Output "$Label-$Role.stderr.txt"
   if($Role -eq 'native-launcher'){$file=[IO.Path]::Combine($Launch,'cotal-desktop.exe');$arguments=@('--daemon')}
   else {
    $file=[IO.Path]::Combine($Launch,'node.exe')
    $scriptRoot=if($Label -eq 'long-state-prefix-launch'){$root}else{$Launch}
    $scriptPath=[IO.Path]::Combine($scriptRoot,'runtime\dist\cotal.js')
    $entry.executablePath=$file
    $entry.scriptPath=$scriptPath
    $arguments=@(('"'+$scriptPath+'"'),'daemon','start','--json')
   }
   $started=Start-Owned $file $arguments 'capture'
   $process=$started.process
   $exited=$process.WaitForExit(45000)
   if(!$exited){$process.Kill();$process.WaitForExit()}
   $process.Refresh()
   $outText=$started.stdout.GetAwaiter().GetResult().Replace("`r`n","`n")
   $errText=$started.stderr.GetAwaiter().GetResult().Replace("`r`n","`n")
   [IO.File]::WriteAllText($stdout,$outText)
   [IO.File]::WriteAllText($stderr,$errText)
   $entry.outcome=@{pid=$process.Id;exited=$exited;exit=$(if($exited){$process.ExitCode}else{$null});stdout=$outText;stderr=$errText}
   if($Role -eq 'native-launcher'){$entry.refused=($exited -and $entry.outcome.exit -eq 1)}
   else {
    if(![string]::IsNullOrWhiteSpace($entry.outcome.stdout)) {
     try {$answer=$entry.outcome.stdout|ConvertFrom-Json;$entry.outcome.errorCode=$answer.error.code;$entry.outcome.errorMessage=$answer.error.message}
     catch {$entry.outcome.parseError=$_.Exception.Message}
    }
    $entry.refused=($exited -and $null -ne $entry.outcome.exit -and $entry.outcome.exit -ne 0 -and $entry.outcome.errorCode -ceq 'CONFLICT' -and $entry.outcome.errorMessage -match '^Setup was interrupted')
   }
   $entry.observationComplete=($exited -and $null -ne $entry.outcome.exit)
  }
 } catch {$entry.error=$_.Exception.Message}
 finally {
  if($process -and !$process.HasExited){$process.Kill();$process.WaitForExit()}
  $report.cases+=,$entry
  Save
  if($Plant){Remove-Item -LiteralPath $handover -ErrorAction SilentlyContinue}
 }
 return $entry
}
try {
 $existing=@()
 foreach($path in @($root,$handover)) {
  if(Test-Path -LiteralPath $path) {
   $item=Get-Item -LiteralPath $path
   $entries=if($item.PSIsContainer){@(Get-ChildItem -LiteralPath $path -Force|ForEach-Object{$_.Name})}else{@($item.Name)}
   $existing+=@{path=$path;directory=[bool]$item.PSIsContainer;entries=$entries}
  }
 }
 $report.preexisting=$existing
 if($existing.Count -gt 0){throw ('Probe requires clean owned installation and handover. Existing paths: '+($existing|ConvertTo-Json -Depth 4 -Compress))}
 $install=(Start-Owned $Installer @('/S')).process
 if(!$install.WaitForExit(240000) -or $null -eq $install.ExitCode -or $install.ExitCode -ne 0){throw 'Candidate installation did not confirm success.'}
 if(((Read-Normalized (Join-Path $root 'runtime\package.json'))|ConvertFrom-Json).version -cne $ExpectedVersion){throw 'Wrong synthetic candidate.'}
 $short=Path-Api $root $true
 $long=Path-Api $short $false
 $report.paths=@{requested=$root;short=$short;long=$long}
 Save
 if([string]::Equals($short,$long,[StringComparison]::OrdinalIgnoreCase)){$report.status='blocked-no-8.3-alias';throw 'Volume has no distinct 8.3 alias, not a pass.'}
 if(![string]::Equals($long,$root,[StringComparison]::OrdinalIgnoreCase)){throw 'Alias does not expand to the owned installation.'}
 $null=New-Item -ItemType Directory -Path $setup -Force
 $ownsHandover=$true
 $different=Join-Path $Output 'different-existing-folder'
 $null=New-Item -ItemType Directory -Path $different
 $missing=Join-Path $Output 'missing-folder'
 $cases=@(
  @{label='control-long';launch=$long;state=$long;refuse=$true},
  @{label='long-state-short-launch';launch=$short;state=$long;refuse=$true},
  @{label='short-state-long-launch';launch=$long;state=$short;refuse=$true},
  @{label='prefix-state-long-launch';launch=$long;state=('\\?\'+$long);refuse=$true},
  @{label='long-state-prefix-launch';launch=('\\?\'+$long);state=$long;refuse=$true},
  @{label='trailing-state-long-launch';launch=$long;state=($long+'\');refuse=$true},
  @{label='case-state-long-launch';launch=$long;state=$long.ToUpperInvariant();refuse=$true},
  @{label='different-existing';launch=$long;state=$different;refuse=$false},
  @{label='missing-folder';launch=$long;state=$missing;refuse=$true}
 )
 foreach($case in $cases) {
  foreach($role in @('native-launcher','app-bridge','cli-start')){$null=Invoke-Probe $role $case.launch $case.state $case.label $case.refuse}
 }
 [IO.File]::WriteAllText($handover,(@{schema=1;installPath=$missing;phase='copying'}|ConvertTo-Json -Compress),[Text.UTF8Encoding]::new($false))
 $rerun=(Start-Owned $Installer @('/S')).process
 $rerunExited=$rerun.WaitForExit(300000)
 $report.recovery=@{exited=$rerunExited;exit=$(if($rerunExited){$rerun.ExitCode}else{$null});handoverRemoved=!(Test-Path -LiteralPath $handover);result=$(if(Test-Path (Join-Path $setup 'result.json')){(Read-Normalized (Join-Path $setup 'result.json'))|ConvertFrom-Json}else{$null})}
 Save
 if(!$rerunExited -or $null -eq $rerun.ExitCode -or $rerun.ExitCode -ne 0 -or !$report.recovery.handoverRemoved){throw 'Running the installer again did not clear the missing-folder handover.'}
 $null=Invoke-Probe 'app-bridge' $long '' 'after-missing-folder-recovery' $false $false
 $report.bridgeObservations=@()
 foreach($bridgeRoot in @($long,('\\?\'+$long))) {
  $bridgeScript=[IO.Path]::Combine($bridgeRoot,'runtime\dist\cotal.js')
  $bridge=Start-Owned ([IO.Path]::Combine($long,'node.exe')) @(('"'+$bridgeScript+'"'),'daemon','desktop') 'capture' ('{"op":"about"}'+"`n")
  $bridgeExited=$bridge.process.WaitForExit(45000)
  if(!$bridgeExited){$bridge.process.Kill();$bridge.process.WaitForExit()}
  $bridgeOut=$bridge.stdout.GetAwaiter().GetResult().Replace("`r`n","`n")
  $bridgeErr=$bridge.stderr.GetAwaiter().GetResult().Replace("`r`n","`n")
  $report.bridgeObservations+=@{scriptPath=$bridgeScript;executablePath=[IO.Path]::Combine($long,'node.exe');exited=$bridgeExited;exit=$(if($bridgeExited){$bridge.process.ExitCode}else{$null});stdout=$bridgeOut;stderr=$bridgeErr;inputError=$bridge.inputError;stdoutBytes=[Text.Encoding]::UTF8.GetByteCount($bridgeOut);stderrBytes=[Text.Encoding]::UTF8.GetByteCount($bridgeErr)}
  Save
 }
 $report.observationIssues=@($report.cases|Where-Object{$_.error -or !$_.observationComplete})
 if($report.observationIssues.Count -gt 0){throw 'One or more guard observations are incomplete. All available cases were retained.'}
 $report.acceptanceFailures=@($report.cases|Where-Object{$_.refused -ne $_.expectedRefusal -or ($_.role -eq 'app-bridge' -and !$_.screenValuesValid)})
 if($report.acceptanceFailures.Count -gt 0){throw 'Fixed guard acceptance failed. All cases were retained.'}
 if($report.recovery.result.message -notmatch 'installation folder that no longer exists'){throw 'Missing-folder recovery did not explain its actual cause.'}
 $report.status='fixed-acceptance-complete'
} catch {$report.error=$_.Exception.Message;throw}
finally {
 if($ownsHandover -and (Test-Path $handover)){Remove-Item -LiteralPath $handover}
 $report.handoverRemoved=!(Test-Path $handover)
 Save
}
