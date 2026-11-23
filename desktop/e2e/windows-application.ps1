param(
  [Parameter(Mandatory=$true)][ValidateSet('install','restore')][string]$Action,
  [Parameter(Mandatory=$true)][string]$Directory,
  [Parameter(Mandatory=$true)][string]$Receipt
)
$ErrorActionPreference = 'Stop'
if (-not [IO.Path]::IsPathRooted($Directory) -or -not (Test-Path -LiteralPath $Directory -PathType Container)) { throw 'Owned fixture directory must exist' }
if ($Action -eq 'install') {
  if (Test-Path -LiteralPath $Receipt) { throw 'Fixture PATH receipt already exists' }
  $previous = [Environment]::GetEnvironmentVariable('Path', 'User')
  $entries = @($previous -split ';' | Where-Object { $_ })
  if ($entries -contains $Directory) { throw 'Fixture directory already belongs to User PATH' }
  $installed = if ([string]::IsNullOrEmpty($previous)) { $Directory } else { $previous.TrimEnd(';') + ';' + $Directory }
  # Retain restoration authority before the registry mutation, including an absent value.
  @{ directory=$Directory; previous=$previous; installed=$installed; restored=$false } |
    ConvertTo-Json | Set-Content -LiteralPath $Receipt -Encoding UTF8
  [Environment]::SetEnvironmentVariable('Path', $installed, 'User')
  if ([Environment]::GetEnvironmentVariable('Path', 'User') -cne $installed) { throw 'Fixture User PATH update did not persist' }
} else {
  $record = Get-Content -LiteralPath $Receipt -Raw | ConvertFrom-Json
  if ($record.directory -cne $Directory -or $record.restored) { throw 'Fixture PATH receipt ownership mismatch' }
  $current = [Environment]::GetEnvironmentVariable('Path', 'User')
  if ($current -cne $record.installed -and $current -cne $record.previous) { throw 'User PATH changed outside this fixture, refusing overwrite' }
  [Environment]::SetEnvironmentVariable('Path', $record.previous, 'User')
  if ([Environment]::GetEnvironmentVariable('Path', 'User') -cne $record.previous) { throw 'Original User PATH was not restored' }
  $record.restored = $true
  $record | ConvertTo-Json | Set-Content -LiteralPath $Receipt -Encoding UTF8
}
