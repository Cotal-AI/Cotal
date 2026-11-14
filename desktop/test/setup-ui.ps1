param([Parameter(Mandatory=$true)][string]$Installer,[ValidateSet('install','occupied')][string]$Mode='install',[Parameter(Mandatory=$true)][string]$Output)
$ErrorActionPreference='Stop'
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class SetupNative {
  [DllImport("user32.dll", SetLastError=true)] public static extern bool PostMessage(IntPtr window, uint message, IntPtr w, IntPtr l);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr window);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
}
'@
function Click-Control($Control,$Window) {
  $dialog=[IntPtr]$Window.Current.NativeWindowHandle
  $activated=[SetupNative]::SetForegroundWindow($dialog)
  $handle=[IntPtr]$Control.Current.NativeWindowHandle
  if($handle -eq [IntPtr]::Zero){throw 'Installer control has no native window handle.'}
  $posted=[SetupNative]::PostMessage($handle,0x00F5,[IntPtr]::Zero,[IntPtr]::Zero)
  $script:observations+=@{at=[DateTime]::UtcNow.ToString('o');action='BM_CLICK';name=$Control.Current.Name;handle=$handle.ToInt64();dialog=$dialog.ToInt64();activated=$activated;foreground=[SetupNative]::GetForegroundWindow().ToInt64();posted=$posted}
  if(!$posted){throw 'Native installer BM_CLICK failed.'}
}
$process=Start-Process -FilePath $Installer -PassThru
$deadline=[DateTime]::UtcNow.AddSeconds(240)
$observations=@()
$occupiedSeen=$false
while (!$process.HasExited -and [DateTime]::UtcNow -lt $deadline) {
  $windows=[Windows.Automation.AutomationElement]::RootElement.FindAll([Windows.Automation.TreeScope]::Children,[Windows.Automation.PropertyCondition]::new([Windows.Automation.AutomationElement]::ProcessIdProperty,$process.Id))
  foreach($window in $windows) {
    $elements=@($window.FindAll([Windows.Automation.TreeScope]::Descendants,[Windows.Automation.Condition]::TrueCondition))
    $names=@($elements | ForEach-Object {$_.Current.Name})
    $observations+=@{at=[DateTime]::UtcNow.ToString('o');title=$window.Current.Name;names=$names;controls=@($elements|ForEach-Object{@{name=$_.Current.Name;type=$_.Current.ControlType.ProgrammaticName;id=$_.Current.AutomationId;enabled=$_.Current.IsEnabled;offscreen=$_.Current.IsOffscreen}})}
    if (($names -join ' ') -match '\d+ agent\(s\) are running') {
      $occupiedSeen=$true
      if($Mode -ne 'occupied') { throw 'Unexpected occupied refusal.' }
      $cancel=@($elements | Where-Object {$_.Current.Name -eq 'Cancel' -and $_.Current.IsEnabled -and !$_.Current.IsOffscreen})
      if($cancel.Count -eq 1) { Click-Control $cancel[0] $window }
      continue
    }
    if($Mode -eq 'occupied' -and $occupiedSeen) { continue }
    $buttons=@($elements | Where-Object {$_.Current.IsEnabled -and !$_.Current.IsOffscreen -and $_.Current.AutomationId -eq '1' -and $_.Current.Name -match '^(Next\s*>?|Install|Finish|Close|I Agree)$'})
    if($buttons.Count -eq 1) {
      if($buttons[0].Current.Name -eq 'Finish') {
        foreach($check in @($elements | Where-Object {$_.Current.ControlType -eq [Windows.Automation.ControlType]::CheckBox -and $_.Current.Name -match 'Run Cotal'})) { $toggle=$check.GetCurrentPattern([Windows.Automation.TogglePattern]::Pattern); if($toggle.Current.ToggleState -eq [Windows.Automation.ToggleState]::On){$toggle.Toggle()} }
      }
      Click-Control $buttons[0] $window
    }
  }
  Start-Sleep -Milliseconds 400
  $process.Refresh()
}
$observations | ConvertTo-Json -Depth 7 | Set-Content -LiteralPath $Output -Encoding UTF8
if(!$process.HasExited){throw 'Installer UI did not finish within 240 seconds.'}
if($Mode -eq 'occupied' -and !$occupiedSeen){throw 'Occupied agent count was never shown.'}
@{exitCode=$process.ExitCode;occupiedSeen=$occupiedSeen;observations=$observations.Count}|ConvertTo-Json -Compress
