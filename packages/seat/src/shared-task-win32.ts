import { spawnSync } from "node:child_process";
import { lstatSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { windowsUserSid } from "./host.js";
import { checkWindowsCustodyPath, checkWindowsCustodyRoot } from "./shared-files-win32.js";
import type { WindowsSeatSlot } from "./shared-slot-win32.js";
import { verifyWindowsDemandTask } from "./windows-demand-task.js";

type TaskState = { present: false; refused?: true } | { present: true; enabled: boolean; instances: number };

/** Use COM create-only registration and exact-name lookup, not a process launched by the service.
 * The action runs the verified retained executable directly. No credentials enter the task
 * definition. The caller holds the custody start lock for each task operation. */
export function windowsCustodyTask(slot: WindowsSeatSlot, runtime: { root: string; key: string; program: string; entry: string }, session: number) {
  let { root } = slot;
  checkWindowsCustodyRoot(root);
  root = realpathSync.native(root);
  if (/["%\x00-\x1f]/.test(root)) throw new Error("Windows PTY task path cannot be passed unchanged");
  checkWindowsCustodyRoot(runtime.root);
  const program = retainedPath(runtime.root, runtime.program);
  const script = retainedPath(runtime.root, runtime.entry);
  if (!Number.isInteger(session) || session <= 0 || session > 0x7fffffff) throw new Error("Windows PTY custody needs an interactive session");
  const { key, name, sid } = slot;
  if (sid !== windowsUserSid() || !/^[0-9a-f]{32}$/.test(key) || name !== `cotal-pty-${key}-${sid}` || slot.generation !== runtime.key ||
      resolve(root, "..", "..") !== dirname(realpathSync.native(runtime.root))) throw new Error("unknown Windows PTY task slot");
  const source = `Cotal local PTY custody ${key}`;
  const systemRoot = process.env.SystemRoot;
  if (!systemRoot || !/^[a-z]:\\/i.test(systemRoot)) throw new Error("Windows directory is unavailable");
  const shell = join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const args = [script, root, name].map(value => /\s/.test(value) ? `"${value}"` : value).join(" ");
  const receipt = join(root, "task.xml");
  function run(op: "inspect" | "start" | "remove"): TaskState {
    if (lstatSync(receipt, { throwIfNoEntry: false })) checkWindowsCustodyPath(receipt, false);
    const result = spawnSync(shell, ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", SCRIPT], {
      input: Buffer.from(JSON.stringify({ op, name, program, args, root, sid, source, session, receipt }).replace(/[^\x00-\x7f]/g, c => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`), "ascii"),
      stdio: ["pipe", "pipe", "ignore"], encoding: "utf8", timeout: 8000, windowsHide: true, maxBuffer: 16_384,
    });
    if (result.error || result.status !== 0) throw new Error("Windows PTY task ownership or disposition is unknown");
    const row = JSON.parse(result.stdout.trim()) as { present?: unknown; refused?: unknown; enabled?: unknown; instances?: unknown } | null;
    if (row?.present === false) return row.refused === true && op === "start" ? { present: false, refused: true } : { present: false };
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

const SCRIPT = Buffer.from(verifyWindowsDemandTask + String.raw`
$ErrorActionPreference = 'Stop'
# Load the inbox cmdlets directly in the desktop daemon's restricted environment.
$PSModuleAutoLoadingPreference = 'None'
Import-Module ([IO.Path]::Combine($PSHOME, 'Modules\Microsoft.PowerShell.Utility\Microsoft.PowerShell.Utility.psd1'))
Import-Module ([IO.Path]::Combine($PSHOME, 'Modules\Microsoft.PowerShell.Management\Microsoft.PowerShell.Management.psd1'))
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
    $s = $d.Settings
    if ($task.Path -cne ('\' + $a.name) -or $d.RegistrationInfo.Source -cne $a.source -or
        -not (Test-CotalDemandTask $d $a.program $a.args $a.root $a.sid) -or
        $s.DisallowStartIfOnBatteries -or $s.StopIfGoingOnBatteries -or $s.RunOnlyIfIdle -or $s.RunOnlyIfNetworkAvailable) { throw 'Foreign task definition' }
    $info = Get-Item -LiteralPath $a.receipt -Force
    if ($info.Length -gt 65536 -or $info.PSIsContainer -or ($info.Attributes -band [IO.FileAttributes]::ReparsePoint) -or
        [IO.File]::ReadAllText($a.receipt) -cne [string]$task.Xml) { throw 'Foreign task source' }
}
$task = Find-Exact
if (!$task -and $a.op -eq 'start') {
    if (Test-Path -LiteralPath $a.receipt) { throw 'Prior task disposition is unknown' }
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
    try { $null = $folder.RegisterTaskDefinition($a.name, $d, 2, $a.sid, $null, 3, $null) }
    catch {
        $errorInfo = $_.Exception
        while ($errorInfo.InnerException) { $errorInfo = $errorInfo.InnerException }
        if (($errorInfo.HResult -eq -2147024891 -or $errorInfo.HResult -eq -2147023636) -and !(Find-Exact)) {
            '{"present":false,"refused":true}'; exit 0
        }
        throw
    }
    $task = Find-Exact
    if (!$task) { throw 'Task registration not observed' }
    $bytes = [Text.Encoding]::UTF8.GetBytes([string]$task.Xml)
    if ($bytes.Length -gt 65536) { throw 'Unexpected task XML size' }
    $file = [IO.File]::Open($a.receipt, [IO.FileMode]::CreateNew)
    try { $file.Write($bytes, 0, $bytes.Length); $file.Flush($true) } finally { $file.Dispose() }
}
if (!$task) { '{"present":false}'; exit 0 }
Assert-Owned $task
$count = [int]$task.GetInstances(0).Count
if ($a.op -eq 'remove') {
    if ($count -ne 0) { throw 'Task is active' }
    $folder.DeleteTask($a.name, 0)
    if (Find-Exact) { throw 'Task removal not observed' }
    [IO.File]::Delete($a.receipt)
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
