param([Parameter(Mandatory=$true)][string]$Installer,[ValidateSet('install','occupied')][string]$Mode='install',[Parameter(Mandatory=$true)][string]$Output)
$ErrorActionPreference='Stop'
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$process=Start-Process -FilePath $Installer -PassThru
$deadline=[DateTime]::UtcNow.AddSeconds(240)
$observations=@()
$occupiedSeen=$false
while (!$process.HasExited -and [DateTime]::UtcNow -lt $deadline) {
  $windows=[Windows.Automation.AutomationElement]::RootElement.FindAll([Windows.Automation.TreeScope]::Children,[Windows.Automation.PropertyCondition]::new([Windows.Automation.AutomationElement]::ProcessIdProperty,$process.Id))
  foreach($window in $windows) {
    $elements=@($window.FindAll([Windows.Automation.TreeScope]::Descendants,[Windows.Automation.Condition]::TrueCondition))
    $names=@($elements | ForEach-Object {$_.Current.Name})
    $observations+=@{at=[DateTime]::UtcNow.ToString('o');title=$window.Current.Name;names=$names}
    if (($names -join ' ') -match '\d+ agent\(s\) are running') {
      $occupiedSeen=$true
      if($Mode -ne 'occupied') { throw 'Unexpected occupied refusal.' }
      $cancel=@($elements | Where-Object {$_.Current.ControlType -eq [Windows.Automation.ControlType]::Button -and $_.Current.Name -eq 'Cancel'})
      if($cancel.Count -eq 1) { $cancel[0].GetCurrentPattern([Windows.Automation.InvokePattern]::Pattern).Invoke() }
      continue
    }
    if($Mode -eq 'occupied' -and $occupiedSeen) { continue }
    $buttons=@($elements | Where-Object {$_.Current.ControlType -eq [Windows.Automation.ControlType]::Button -and $_.Current.IsEnabled -and $_.Current.Name -match '^(Next\s*>?|Install|Finish|Close|I Agree)$'})
    if($buttons.Count -eq 1) {
      if($buttons[0].Current.Name -eq 'Finish') {
        foreach($check in @($elements | Where-Object {$_.Current.ControlType -eq [Windows.Automation.ControlType]::CheckBox -and $_.Current.Name -match 'Run Cotal'})) { $toggle=$check.GetCurrentPattern([Windows.Automation.TogglePattern]::Pattern); if($toggle.Current.ToggleState -eq [Windows.Automation.ToggleState]::On){$toggle.Toggle()} }
      }
      $buttons[0].GetCurrentPattern([Windows.Automation.InvokePattern]::Pattern).Invoke()
    }
  }
  Start-Sleep -Milliseconds 400
  $process.Refresh()
}
$observations | ConvertTo-Json -Depth 7 | Set-Content -LiteralPath $Output -Encoding UTF8
if(!$process.HasExited){throw 'Installer UI did not finish within 240 seconds.'}
if($Mode -eq 'occupied' -and !$occupiedSeen){throw 'Occupied agent count was never shown.'}
@{exitCode=$process.ExitCode;occupiedSeen=$occupiedSeen;observations=$observations.Count}|ConvertTo-Json -Compress
