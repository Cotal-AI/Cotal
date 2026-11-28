param([Parameter(Mandatory)][string]$Installer)
$ErrorActionPreference = 'Stop'
if ($env:DESKTOP_LAB_DISPOSABLE -ne '1' -or ![IO.Path]::IsPathRooted($Installer) -or $Installer -notlike '*-setup.exe') {
  throw 'Use an assigned Windows lab and pass an absolute path to a setup program.'
}
Get-ChildItem Env:COTAL_* | Remove-Item
$env:DO_NOT_TRACK = '1'
& (Join-Path $PSScriptRoot 'clean-install-windows-path.ps1')
if ((Test-Path "$env:LOCALAPPDATA\Cotal") -or (Test-Path "$env:APPDATA\Cotal")) { throw 'Use a lab account without Cotal state.' }
if ((Get-AuthenticodeSignature -LiteralPath $Installer).Status -ne 'Valid') { throw 'The installer does not have a valid Authenticode signature.' }
$setup = Start-Process -FilePath $Installer -Wait -PassThru
if ($setup.ExitCode -ne 0) { throw "Desktop setup exited $($setup.ExitCode)." }
$app = Join-Path $env:LOCALAPPDATA 'Cotal\cotal-desktop.exe'
if (!(Test-Path $app)) { throw 'The installer did not install Cotal.' }
if (!(Get-Process cotal-desktop -ErrorAction SilentlyContinue)) { Start-Process -FilePath $app }
Write-Output '1 PASS installed and opened Cotal. Follow clean-install-lab.md. Do not record the device code.'
