# Harness only. No product code or scheduled task changes.
# powershell.exe -NoProfile -NonInteractive -File scripts/windows-gate-facts.ps1
# -Output is the artifact parent. A new private directory retains all evidence, also on failure.
# A granted lock while the child lives is a valid factual negative, not a failed assertion.
[CmdletBinding()]
param([string]$Output = ([IO.Path]::GetTempPath()))
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT) { throw 'Native Windows is required' }
if ($PSVersionTable.PSEdition -ne 'Desktop' -or -not [Environment]::Is64BitProcess) {
    throw 'Use 64-bit Windows PowerShell 5.1, not pwsh'
}
$framework = Join-Path $env:SystemRoot 'Microsoft.NET\Framework64\v4.0.30319'
$csc = Join-Path $framework 'csc.exe'
$reference = Join-Path $framework 'System.Web.Extensions.dll'
foreach ($file in @($csc, $reference)) {
    if (-not (Test-Path -LiteralPath $file -PathType Leaf)) { throw "Built-in Framework dependency absent: $file" }
}
$parent = [IO.Path]::GetFullPath($Output)
$null = [IO.Directory]::CreateDirectory($parent)
$directory = Join-Path $parent ('windows-gate-' + [Guid]::NewGuid().ToString('N'))
if (Test-Path -LiteralPath $directory) { throw 'Refusing an existing private directory' }
# Create with a protected DACL from the start. Private result files are ownership IPC.
$sid = [Security.Principal.WindowsIdentity]::GetCurrent().User
$acl = New-Object Security.AccessControl.DirectorySecurity
$acl.SetOwner($sid)
$acl.SetAccessRuleProtection($true, $false)
$rule = New-Object Security.AccessControl.FileSystemAccessRule($sid, 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow')
$acl.AddAccessRule($rule)
$null = [IO.Directory]::CreateDirectory($directory, $acl)
try {
$source = Join-Path $PSScriptRoot 'windows-gate-facts.cs'
$executable = Join-Path $directory 'windows-gate-facts.exe'
$compileLog = Join-Path $directory 'compile.log'
& $csc /nologo /target:exe /platform:x64 "/reference:$reference" "/out:$executable" $source 2>&1 | Out-File -LiteralPath $compileLog -Encoding utf8
if ($LASTEXITCODE -ne 0) { throw "Built-in C# compiler failed. See $compileLog" }
$manifest = [ordered]@{
    schema = 1
    directory = $directory
    sid = $sid.Value
    compiler = $csc
    compilerVersion = (Get-Item -LiteralPath $csc).VersionInfo.FileVersion
    sourceSha256 = (Get-FileHash -LiteralPath $source -Algorithm SHA256).Hash
    helperSha256 = (Get-FileHash -LiteralPath $executable -Algorithm SHA256).Hash
    powershell = $PSVersionTable.PSVersion.ToString()
    limitations = @('Harness measurement only, not product acceptance', 'Native execution required', 'No assertion that locks survive runner death', 'No retries hide post-exit lock release latency')
    docs = @(
        'https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-lockfileex',
        'https://learn.microsoft.com/en-us/windows/win32/api/processthreadsapi/nf-processthreadsapi-createprocessw',
        'https://learn.microsoft.com/en-us/windows/win32/api/handleapi/nf-handleapi-gethandleinformation',
        'https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-getfileinformationbyhandle'
    )
}
$manifest | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath (Join-Path $directory 'manifest.json') -Encoding utf8
# The observer retains native-backed process handles and kills only its exact owned processes.
# Evidence is not recursively removed, even on failure. No process names or host-wide queries.
& $executable observe $directory
$code = $LASTEXITCODE
if (-not (Test-Path -LiteralPath (Join-Path $directory 'report.json'))) { throw 'Native observer returned no report' }
exit $code
} catch {
    $failure = [ordered]@{ schema = 1; measurementComplete = $false; stage = 'launcher'; error = $_.Exception.ToString(); directory = $directory }
    $failure | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath (Join-Path $directory 'launcher-failure.json') -Encoding utf8
    $failure | ConvertTo-Json -Depth 8
    exit 1
}
