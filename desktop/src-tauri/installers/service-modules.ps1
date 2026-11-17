param([Parameter(Mandatory=$true)][string]$Runtime)
$ErrorActionPreference = 'Stop'
Import-Module "$PSHOME\Modules\Microsoft.PowerShell.Management\Microsoft.PowerShell.Management.psd1" -ErrorAction Stop
Import-Module "$PSHOME\Modules\Microsoft.PowerShell.Utility\Microsoft.PowerShell.Utility.psd1" -ErrorAction Stop
$prefix = [IO.Path]::GetFullPath($Runtime).TrimEnd('\') + '\'
$holders = @()
$errors = @()
foreach ($process in Get-Process) {
  try {
    foreach ($module in $process.Modules) {
      if ($module.FileName.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)) {
        $holders += @{ pid = $process.Id; name = $process.ProcessName; startedAt = $process.StartTime.ToUniversalTime().ToString('o'); file = $module.FileName }
      }
    }
  } catch {
    $errors += @{ pid = $process.Id; name = $process.ProcessName; message = $_.Exception.Message }
  }
}
@{ holders = $holders; errors = $errors } | ConvertTo-Json -Depth 5 -Compress
