# Named job recovery diagnostic only. No customer installation mutation.
[CmdletBinding()]
param([Parameter(Mandatory=$true)][string]$Output)
Set-StrictMode -Version Latest
$ErrorActionPreference='Stop'
if ($PSVersionTable.PSEdition -ne 'Desktop' -or -not [Environment]::Is64BitProcess) { throw 'Native x64 Windows PowerShell5.1 required' }
$sid=[Security.Principal.WindowsIdentity]::GetCurrent().User
$directory=Join-Path $Output ('windows-named-job-'+[Guid]::NewGuid().ToString('N'))
$acl=New-Object Security.AccessControl.DirectorySecurity
$acl.SetOwner($sid);$acl.SetAccessRuleProtection($true,$false)
$acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule($sid,'FullControl','ContainerInherit,ObjectInherit','None','Allow')))
$null=[IO.Directory]::CreateDirectory($directory,$acl)
$report=@{approval='core8b3e4e59';cases=@();pass=$false;error=$null;limitations=@('Natural absence liveness pins are a subset while births continue; no universal death claim','Owner-alive open control explicitly retains job handle; natural postdeath case does not','No product acceptance')}
function Wait-File($dir,$name) {
 $clock=[Diagnostics.Stopwatch]::StartNew()
 while(-not (Test-Path -LiteralPath (Join-Path $dir $name))) { if($clock.ElapsedMilliseconds -gt 20000){throw "Timeout $name"};Start-Sleep -Milliseconds 5 }
}
function Quote($value) { if($value.Contains('"') -or $value.EndsWith('\')){throw 'Unsafe fixture path'};return '"'+$value+'"' }
try {
 $framework=Join-Path $env:SystemRoot 'Microsoft.NET\Framework64\v4.0.30319'
 foreach($name in @('windows-named-job-facts.cs','windows-named-job-facts.ps1')) { Copy-Item -LiteralPath (Join-Path $PSScriptRoot $name) -Destination (Join-Path $directory $name) }
 $exe=Join-Path $directory 'windows-named-job-facts.exe'
 & (Join-Path $framework 'csc.exe') /nologo /target:exe /platform:x64 "/reference:$(Join-Path $framework 'System.Web.Extensions.dll')" "/reference:$(Join-Path $framework 'System.Management.dll')" "/out:$exe" (Join-Path $directory 'windows-named-job-facts.cs') 2>&1 | Out-File (Join-Path $directory 'compile.log')
 if($LASTEXITCODE -ne 0){throw 'Named native fixture compilation failed'}
 foreach($mode in @('open-control','after-owner-exit','immediate-successor')) {
  $dir=Join-Path $directory $mode;$null=[IO.Directory]::CreateDirectory($dir)
  $entry=@{mode=$mode;error=$null;ownerExitObserved=$false;observerExitObserved=$false}
  $report.cases += $entry
  $owner=$null;$observer=$null
  try {
   $owner=Start-Process -FilePath $exe -ArgumentList @('owner',(Quote $dir)) -PassThru -RedirectStandardOutput (Join-Path $dir 'owner.log') -RedirectStandardError (Join-Path $dir 'owner-error.log')
   $null=$owner.Handle
   Wait-File $dir 'owner-ready.json'
   $attempt=Get-Content -Raw -LiteralPath (Join-Path $dir 'attempt.json') | ConvertFrom-Json
   if($attempt.owner.pid -ne $owner.Id -or $attempt.owner.token -cne $owner.StartTime.ToUniversalTime().ToFileTimeUtc().ToString() -or $owner.Path -ine $exe -or $attempt.owner.sid -cne $sid.Value){throw 'Owner identity mismatch'}
   $observer=Start-Process -FilePath $exe -ArgumentList @('observe',(Quote $dir),$mode) -PassThru -RedirectStandardOutput (Join-Path $dir 'observer.log') -RedirectStandardError (Join-Path $dir 'observer-error.log')
   $null=$observer.Handle
   if(-not $observer.WaitForExit(45000)){throw 'Named observer timeout, retained disposable custody'}
   $observer.WaitForExit();$entry.observerExitObserved=$true
   $entry.observation=Get-Content -Raw -LiteralPath (Join-Path $dir 'named-observation.json') | ConvertFrom-Json
   $entry.observerExitCode=$observer.ExitCode
   if(-not $owner.WaitForExit(10000)){throw 'Exact owner did not exit after observer intervention'}
   $owner.WaitForExit();$entry.ownerExitObserved=$true
  } catch {$entry.error=$_.Exception.ToString()}
  finally {
   if($null -ne $owner -and -not $owner.HasExited){[IO.File]::WriteAllText((Join-Path $dir 'owner-stop'),'');if($owner.WaitForExit(10000)){$owner.WaitForExit();$entry.ownerExitObserved=$true}}
   if($null -ne $observer){$observer.Dispose()};if($null -ne $owner){$owner.Dispose()}
  }
 }
 $report.pass=@($report.cases | Where-Object {$null -ne $_.error -or -not $_.observation.pass}).Count -eq 0
} catch {$report.error=$_.Exception.ToString()}
finally {
 $report | ConvertTo-Json -Depth 30 | Set-Content -LiteralPath (Join-Path $directory 'named-report.json') -Encoding UTF8
 $hashes=@(Get-ChildItem -LiteralPath $directory -File -Recurse | ForEach-Object {try{@{path=$_.FullName;sha256=(Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash}}catch{@{path=$_.FullName;error=$_.Exception.ToString()}}})
 $hashes | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath (Join-Path $directory 'artifact-hashes.json') -Encoding UTF8
 $report | ConvertTo-Json -Depth 30
}
if(-not $report.pass){exit 1}
