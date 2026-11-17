$ErrorActionPreference = 'Stop'
Import-Module "$PSHOME\Modules\Microsoft.PowerShell.Management\Microsoft.PowerShell.Management.psd1" -ErrorAction Stop
Import-Module "$PSHOME\Modules\Microsoft.PowerShell.Utility\Microsoft.PowerShell.Utility.psd1" -ErrorAction Stop
Import-Module "$PSHOME\Modules\Microsoft.PowerShell.Security\Microsoft.PowerShell.Security.psd1" -ErrorAction Stop
Import-Module "$PSHOME\Modules\CimCmdlets\CimCmdlets.psd1" -ErrorAction Stop
$runtime = Join-Path $env:LOCALAPPDATA 'Cotal\runtime'
$report = [ordered]@{
  runtime = $runtime
  probeSid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
  probeElevated = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
  owner = $null
  access = @()
  firstEntry = $null
  readOnly = @()
  errors = @()
  holders = $null
}
try {
  $acl = Get-Acl -LiteralPath $runtime -ErrorAction Stop
  $report.owner = $acl.Owner
  $report.access = @($acl.Access | ForEach-Object { @{ identity = $_.IdentityReference.Value; rights = [string]$_.FileSystemRights; type = [string]$_.AccessControlType; inherited = $_.IsInherited } })
  $first = Get-ChildItem -LiteralPath $runtime -Force -ErrorAction Stop | Select-Object -First 1
  if ($first) { $report.firstEntry = @{ path = $first.FullName; owner = (Get-Acl -LiteralPath $first.FullName -ErrorAction Stop).Owner } }
} catch { $report.errors += @{ operation = 'acl'; message = $_.Exception.Message } }
try {
  $files = @(Get-ChildItem -LiteralPath $runtime -Recurse -Force -File -ErrorAction Stop)
  $report.readOnly = @($files | Where-Object { $_.Attributes -band [IO.FileAttributes]::ReadOnly } | Select-Object -ExpandProperty FullName)
  # Restart Manager accepts filenames, not directories. See RmGetList ERROR_ACCESS_DENIED.
  Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
[StructLayout(LayoutKind.Sequential)]
public struct ProofProcess {
  public uint pid;
  public System.Runtime.InteropServices.ComTypes.FILETIME startTime;
}
[StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
public struct ProofHolder {
  public ProofProcess process;
  [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 256)] public string appName;
  [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 64)] public string serviceName;
  public uint type, status, session;
  [MarshalAs(UnmanagedType.Bool)] public bool restartable;
}
public static class ProofHolders {
  [DllImport("rstrtmgr.dll", CharSet = CharSet.Unicode)] public static extern int RmStartSession(out uint session, uint flags, string key);
  [DllImport("rstrtmgr.dll", CharSet = CharSet.Unicode)] public static extern int RmRegisterResources(uint session, uint count, string[] paths, uint apps, IntPtr processes, uint services, string[] names);
  [DllImport("rstrtmgr.dll")] public static extern int RmGetList(uint session, out uint needed, ref uint count, [In, Out] ProofHolder[] holders, out uint reboot);
  [DllImport("rstrtmgr.dll")] public static extern int RmEndSession(uint session);
}
'@
  $session = [uint32]0
  $started = [ProofHolders]::RmStartSession([ref]$session, 0, [Guid]::NewGuid().ToString('N'))
  if ($started -ne 0) { throw "RmStartSession error $started" }
  try {
    $paths = [string[]]@($files | Select-Object -ExpandProperty FullName)
    if ($paths.Count -eq 0) { throw 'Runtime contains no files to register' }
    $registered = [ProofHolders]::RmRegisterResources($session, $paths.Count, $paths, 0, [IntPtr]::Zero, 0, $null)
    if ($registered -ne 0) { throw "RmRegisterResources error $registered" }
    $needed = [uint32]0; $count = [uint32]0; $reboot = [uint32]0
    $listed = [ProofHolders]::RmGetList($session, [ref]$needed, [ref]$count, $null, [ref]$reboot)
    $entries = @()
    for ($attempt = 0; $listed -eq 234 -and $attempt -lt 3; $attempt++) {
      $count = $needed
      $buffer = New-Object 'ProofHolder[]' $count
      $listed = [ProofHolders]::RmGetList($session, [ref]$needed, [ref]$count, $buffer, [ref]$reboot)
      if ($listed -eq 0) { $entries = @($buffer | Select-Object -First $count | ForEach-Object { @{ pid = $_.process.pid; appName = $_.appName; serviceName = $_.serviceName; startLow = $_.process.startTime.dwLowDateTime; startHigh = $_.process.startTime.dwHighDateTime } }) }
    }
    if ($listed -ne 0) { throw "RmGetList error $listed; needed $needed" }
    $report.holders = @{ fileCount = $paths.Count; code = $listed; processes = $entries }
  } finally { [void][ProofHolders]::RmEndSession($session) }
} catch { $report.errors += @{ operation = 'file-holders'; message = $_.Exception.Message } }
try {
  $report.runtimeProcesses = @(Get-CimInstance Win32_Process -ErrorAction Stop | Where-Object { $_.ExecutablePath -and $_.ExecutablePath.StartsWith($runtime + '\', [StringComparison]::OrdinalIgnoreCase) } | ForEach-Object { @{ pid = $_.ProcessId; parentPid = $_.ParentProcessId; path = $_.ExecutablePath; created = $_.CreationDate.ToUniversalTime().ToString('o') } })
} catch { $report.errors += @{ operation = 'runtime-processes'; message = $_.Exception.Message } }
$report | ConvertTo-Json -Depth 8
