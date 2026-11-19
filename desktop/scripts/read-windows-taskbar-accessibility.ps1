param([Parameter(Mandatory = $true)][long]$TaskbarHandle)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
try {
    if ($PSVersionTable.PSEdition -ne 'Desktop' -or $TaskbarHandle -eq 0) { throw 'Expected Windows PowerShell and a nonzero Explorer taskbar handle.' }
    $accessibility = [Reflection.Assembly]::Load('Accessibility')
    Add-Type -Path (Join-Path $PSScriptRoot 'windows-taskbar-accessibility.cs') -ReferencedAssemblies @($accessibility.Location, 'System.dll', 'System.Core.dll')
    $toolbar = [ExplorerTaskbarAccessibility]::RunningApps([IntPtr]$TaskbarHandle)
    @{ toolbar = $toolbar.ToInt64(); buttons = @([ExplorerTaskbarAccessibility]::Buttons($toolbar)) } | ConvertTo-Json -Depth 5 -Compress
} catch {
    [Console]::Error.WriteLine($_.Exception.GetBaseException().Message)
    exit 1
}
