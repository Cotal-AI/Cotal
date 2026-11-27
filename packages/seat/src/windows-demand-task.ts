/** Common Task Scheduler ownership checks. The caller binds $d and the exact expected values. */
export const verifyWindowsDemandTask = String.raw`
function Test-CotalDemandTask($d, $command, $arguments, $directory, $expectedSid) {
  if ($d.Actions.Count -ne 1) { return $false }
  $a = $d.Actions.Item(1)
  $sid = [string]$d.Principal.UserId
  if ($sid -notmatch '^S-1-') { $sid = ([Security.Principal.NTAccount]::new($sid)).Translate([Security.Principal.SecurityIdentifier]).Value }
  return ($a.Type -eq 0 -and [string]$a.Path -ceq $command -and [string]$a.Arguments -ceq $arguments -and
    [string]$a.WorkingDirectory -ceq $directory -and $sid -ceq $expectedSid -and $d.Principal.LogonType -eq 3 -and
    $d.Principal.RunLevel -eq 0 -and $d.Triggers.Count -eq 0 -and $d.Settings.RestartCount -eq 0 -and
    $d.Settings.MultipleInstances -eq 2 -and $d.Settings.ExecutionTimeLimit -eq 'PT0S' -and $d.Settings.AllowDemandStart)
}
`;
