import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { windowsUserSid } from "./host.js";
import { checkWindowsCustodyPath, checkWindowsCustodyRoot } from "./shared-files-win32.js";

type TaskState = { present: false } | { present: true; enabled: boolean; instances: number };

/** Use COM create-only registration and exact-name lookup, not a process launched by the service.
 * The task's fixed bootstrap starts the verified retained executable. No credentials enter the task
 * definition. The caller holds the custody start lock for each task operation. */
export function windowsCustodyTask(root: string, runtime: { root: string; program: string; entry: string }, session: number) {
  checkWindowsCustodyRoot(root);
  root = realpathSync.native(root);
  if (/["%\x00-\x1f]/.test(root)) throw new Error("Windows PTY task path cannot be passed unchanged");
  checkWindowsCustodyRoot(runtime.root);
  const program = retainedPath(runtime.root, runtime.program);
  const script = retainedPath(runtime.root, runtime.entry);
  if (!Number.isInteger(session) || session <= 0 || session > 0x7fffffff) throw new Error("Windows PTY custody needs an interactive session");
  const sid = windowsUserSid();
  const key = createHash("sha256").update(sid).update("\0").update(root.toLowerCase()).digest("hex").slice(0, 32);
  const name = `cotal-pty-${key}`;
  const source = `Cotal local PTY custody ${key}`;
  const systemRoot = process.env.SystemRoot;
  if (!systemRoot || !/^[a-z]:\\/i.test(systemRoot)) throw new Error("Windows directory is unavailable");
  const shell = join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  // Task Scheduler inherits the user's environment and cannot set an action's environment block.
  // A fixed, profile-free bootstrap drops inherited Node configuration before invoking Node.
  const quote = (part: string) => "'" + part.replaceAll("'", "''") + "'";
  const bootstrap = `$ErrorActionPreference='Stop'\n` +
    `foreach ($key in @('NODE_OPTIONS','NODE_PATH','NODE_V8_COVERAGE','NODE_COMPILE_CACHE')) { [Environment]::SetEnvironmentVariable($key,$null,'Process') }\n` +
    `$env:DO_NOT_TRACK='1'\n& ${[program, script, root, name].map(quote).join(" ")}\nexit $LASTEXITCODE\n`;
  const args = `-NoLogo -NoProfile -NonInteractive -WindowStyle Hidden -EncodedCommand ${Buffer.from(bootstrap, "utf16le").toString("base64")}`;
  function run(op: "inspect" | "start" | "remove"): TaskState {
    const result = spawnSync(shell, ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", SCRIPT], {
      input: Buffer.from(JSON.stringify({ op, name, program: shell, args, root, sid, source, session }).replace(/[^\x00-\x7f]/g, c => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`), "ascii"),
      stdio: ["pipe", "pipe", "ignore"], encoding: "utf8", timeout: 8000, windowsHide: true, maxBuffer: 16_384,
    });
    if (result.error || result.status !== 0) throw new Error("Windows PTY task ownership or disposition is unknown");
    const row = JSON.parse(result.stdout.trim()) as { present?: unknown; enabled?: unknown; instances?: unknown } | null;
    if (row?.present === false) return { present: false };
    if (row?.present !== true || typeof row.enabled !== "boolean" || typeof row.instances !== "number" || !Number.isSafeInteger(row.instances) || row.instances < 0)
      throw new Error("Windows PTY task ownership or disposition is unknown");
    return { present: true, enabled: row.enabled, instances: row.instances };
  }
  return { name, inspect: () => run("inspect"), start: () => run("start"), removeIdle: () => run("remove") };
}

function retainedPath(root: string, path: string): string {
  path = resolve(path);
  const inside = relative(root, path);
  if (!inside || isAbsolute(inside) || inside === ".." || inside.startsWith(`..${sep}`) ||
      realpathSync.native(path).toLowerCase() !== path.toLowerCase()) throw new Error("Windows PTY task needs a retained runtime");
  checkWindowsCustodyRoot(dirname(path));
  checkWindowsCustodyPath(path, false);
  if (/["%\x00-\x1f]/.test(path)) throw new Error("Windows PTY task path cannot be passed unchanged");
  return path;
}

const SCRIPT = Buffer.from(String.raw`
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$a = [Console]::In.ReadToEnd() | ConvertFrom-Json
$scheduler = New-Object -ComObject Schedule.Service
$scheduler.Connect()
$folder = $scheduler.GetFolder('\')
function Find-Exact {
    try { $folder.GetTask($a.name) }
    catch {
        $errorInfo = $_.Exception
        while ($errorInfo.InnerException) { $errorInfo = $errorInfo.InnerException }
        if ($errorInfo.HResult -ne -2147024894) { throw }
    }
}
function Assert-Owned($task) {
    $d = $task.Definition
    $p = $d.Principal
    $s = $d.Settings
    $sid = [string]$p.UserId
    if ($sid -notmatch '^S-1-') { $sid = ([Security.Principal.NTAccount]::new($sid)).Translate([Security.Principal.SecurityIdentifier]).Value }
    if ($task.Path -cne ('\' + $a.name) -or $d.RegistrationInfo.Source -cne $a.source -or
        $d.Triggers.Count -ne 0 -or $d.Actions.Count -ne 1 -or $sid -cne $a.sid -or $p.LogonType -ne 3 -or $p.RunLevel -ne 0 -or
        $s.MultipleInstances -ne 2 -or !$s.AllowDemandStart -or $s.DisallowStartIfOnBatteries -or $s.StopIfGoingOnBatteries -or
        $s.ExecutionTimeLimit -cne 'PT0S' -or $s.RestartCount -ne 0 -or $s.RunOnlyIfIdle -or $s.RunOnlyIfNetworkAvailable) { throw 'Foreign task definition' }
    $action = $d.Actions.Item(1)
    if ($action.Type -ne 0 -or $action.Path -cne $a.program -or $action.Arguments -cne $a.args -or $action.WorkingDirectory -cne $a.root) { throw 'Foreign task action' }
}
$task = Find-Exact
if (!$task -and $a.op -eq 'start') {
    $d = $scheduler.NewTask(0)
    $d.RegistrationInfo.Source = $a.source
    $d.Principal.UserId = $a.sid
    $d.Principal.LogonType = 3
    $d.Principal.RunLevel = 0
    $d.Settings.MultipleInstances = 2
    $d.Settings.ExecutionTimeLimit = 'PT0S'
    $d.Settings.DisallowStartIfOnBatteries = $false
    $d.Settings.StopIfGoingOnBatteries = $false
    $action = $d.Actions.Create(0)
    $action.Path = $a.program
    $action.Arguments = $a.args
    $action.WorkingDirectory = $a.root
    # TASK_CREATE, never TASK_CREATE_OR_UPDATE. TASK_LOGON_INTERACTIVE_TOKEN stores no password.
    $null = $folder.RegisterTaskDefinition($a.name, $d, 2, $a.sid, $null, 3, $null)
    $task = Find-Exact
    if (!$task) { throw 'Task registration not observed' }
}
if (!$task) { '{"present":false}'; exit 0 }
Assert-Owned $task
$count = [int]$task.GetInstances(0).Count
if ($a.op -eq 'remove') {
    if ($count -ne 0) { throw 'Task is active' }
    $folder.DeleteTask($a.name, 0)
    if (Find-Exact) { throw 'Task removal not observed' }
    '{"present":false}'; exit 0
}
if ($a.op -eq 'start' -and !$task.Enabled) { throw 'Task is disabled' }
$row = @{present=$true; enabled=[bool]$task.Enabled; instances=$count}
if ($a.op -eq 'start' -and $count -eq 0) {
    # TASK_RUN_USE_SESSION_ID, pinned to the hosted Manager's interactive session.
    $null = $task.RunEx($null, 4, [int]$a.session, $null)
    $row.instances = [int]$task.GetInstances(0).Count
}
ConvertTo-Json -Compress -InputObject $row
`, "utf16le").toString("base64");
