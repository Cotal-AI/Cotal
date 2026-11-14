import { createHash, randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import { closeSync, constants, fchmodSync, lstatSync, openSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { writeSecretFileAtomic, writeSecretFileCreateOnly } from "@cotal-ai/core";
import { lockExclusiveNb } from "@cotal-ai/seat";
import { homeCotalDir, claimUpdateClosureAccess, readLocalRecordSource, windowsBootDisposition, windowsUpdateManuallyCleared, WINDOWS_INTERRUPTED_UPDATE, UPDATE_HOUR_MS, win32ProcessBinding } from "@cotal-ai/workspace";
import { daemonStartedByOwnedService } from "./install.js";
import { daemonPaths } from "./endpoint.js";
import { xmlText } from "./install-xml.js";
import { windowsArgument } from "./install-win32.js";

export interface WindowsUpdateReceipt {
  v: 1; nonce: string; name: string; source: string; sha256: string; argv: string[]; bootId: number; failures: number;
  revoked: boolean; env: Record<string, string>; owner?: { pid: number; start: string; bootId: number }; drained?: boolean; done?: boolean;
}
const receiptPath = () => join(homeCotalDir(), "update-windows.json");
const pausePath = () => join(homeCotalDir(), "update-windows-paused.json");
const digest = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");
const system32 = (...parts: string[]) => join(process.env.SystemRoot ?? "C:\\Windows", "System32", ...parts);
const powershell = (script: string, env: Record<string, string> = {}): string => execFileSync(system32("WindowsPowerShell", "v1.0", "powershell.exe"), ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")], { env: { ...process.env, ...env }, timeout: 20_000, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], windowsHide: true }).replace(/^\uFEFF/, "").trim();

/** Require physical private state and no broad write authority before reading a custody record. */
function protect(path: string): void {
  const script = ["$ErrorActionPreference='Stop'", "$p=$env:COTAL_UPDATE_FILE", "$sid=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value", "while($p){$i=Get-Item -LiteralPath $p -Force; if(($i.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0){throw 'automatic update state has a reparse point'}; if($p -ceq $env:COTAL_UPDATE_HOME -or $p.StartsWith($env:COTAL_UPDATE_HOME+[IO.Path]::DirectorySeparatorChar,[StringComparison]::OrdinalIgnoreCase)){$a=Get-Acl -LiteralPath $p; foreach($r in $a.Access){$s=$r.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value; if($r.AccessControlType -eq 'Allow' -and $s -notin @($sid,'S-1-5-18','S-1-5-32-544') -and ($r.FileSystemRights -band 0xD0116) -ne 0){throw 'automatic update state permits foreign writes'}}}; $parent=[IO.Path]::GetDirectoryName($p); if($parent -eq $p){break}; $p=$parent}"].join("\n");
  powershell(script, { COTAL_UPDATE_FILE: path, COTAL_UPDATE_HOME: homeCotalDir() });
}
function save(record: WindowsUpdateReceipt): void { writeSecretFileAtomic(receiptPath(), `${JSON.stringify(record)}\n`); }
export function readWindowsUpdate(): WindowsUpdateReceipt | undefined {
  const info = lstatSync(receiptPath(), { throwIfNoEntry: false });
  if (!info) return undefined;
  if (!info.isFile() || info.isSymbolicLink()) throw new Error("Windows automatic update receipt is not a physical file");
  if (process.platform === "win32") protect(receiptPath());
  const bytes = readLocalRecordSource(receiptPath(), 64 * 1024, true);
  if (!bytes) throw new Error("Windows automatic update receipt disappeared");
  const r = JSON.parse(bytes.toString("utf8")) as WindowsUpdateReceipt;
  if (r?.v !== 1 || !/^[a-f0-9]{32}$/.test(r.nonce) || r.name !== `cotal-update-${r.nonce}` || r.source !== join(homeCotalDir(), `${r.name}.xml`) || !/^[a-f0-9]{64}$/.test(r.sha256) || !Array.isArray(r.argv) || r.argv.length !== 4 || r.argv.some(a => typeof a !== "string") || !Number.isInteger(r.failures) || r.failures < 0 || typeof r.revoked !== "boolean" || !r.env || typeof r.env !== "object" || Object.values(r.env).some(value => typeof value !== "string")) throw new Error("invalid Windows automatic update receipt");
  windowsBootDisposition(r.bootId, r.bootId);
  if (r.owner && (!Number.isSafeInteger(r.owner.pid) || r.owner.pid <= 1 || !/^\d+$/.test(r.owner.start) || r.owner.bootId !== r.bootId)) throw new Error("invalid Windows updater owner identity");
  if (r.drained !== undefined && typeof r.drained !== "boolean" || r.done !== undefined && typeof r.done !== "boolean") throw new Error("invalid Windows updater completion");
  return r;
}
function gate(r: WindowsUpdateReceipt): number {
  const path = join(homeCotalDir(), `${r.name}.gate`);
  // LockFileEx needs GENERIC_READ or GENERIC_WRITE. Append-only handles have neither.
  const fd = openSync(path, constants.O_RDWR | constants.O_CREAT, 0o600);
  try { fchmodSync(fd, 0o600); protect(path); if (!lockExclusiveNb(fd)) throw new Error("Windows automatic update helper still has admission custody"); return fd; }
  catch (error) { closeSync(fd); throw error; }
}
function assertSource(r: WindowsUpdateReceipt): void {
  protect(r.source);
  const bytes = readLocalRecordSource(r.source, 64 * 1024, true);
  if (!bytes || digest(bytes) !== r.sha256) throw new Error("Windows automatic update task source changed");
}
const taskPrelude = "$ErrorActionPreference='Stop'; $s=New-Object -ComObject Schedule.Service; $s.Connect(); $f=$s.GetFolder('\\'); $t=@($f.GetTasks(1) | Where-Object {$_.Name -ceq $env:COTAL_UPDATE_TASK}); if($t.Count -gt 1){throw 'ambiguous update task'}; ";
interface Task { present: boolean; state?: number; instances?: number; enabled?: boolean; xml?: string; }
function task(r: WindowsUpdateReceipt, operation: "read" | "disable" | "delete" = "read"): Task {
  assertSource(r);
  const script = taskPrelude + "if($t.Count -eq 0){'{\"present\":false}';exit 0}; $d=$t[0].Definition; $sid=[string]$d.Principal.UserId; if($sid -notmatch '^S-1-'){$sid=([Security.Principal.NTAccount]::new($sid)).Translate([Security.Principal.SecurityIdentifier]).Value}; " +
    "if($d.Actions.Count -ne 1){throw 'automatic update task has extra actions'}; $a=$d.Actions.Item(1); if($a.Type -ne 0 -or [string]$a.Path -cne $env:COTAL_UPDATE_COMMAND -or [string]$a.Arguments -cne $env:COTAL_UPDATE_ARGUMENTS -or [string]$a.WorkingDirectory -cne $env:COTAL_UPDATE_DIRECTORY -or $sid -cne $env:COTAL_UPDATE_SID -or $d.Principal.LogonType -ne 3 -or $d.Principal.RunLevel -ne 0 -or $d.Triggers.Count -ne 0 -or $d.Settings.RestartCount -ne 0 -or $d.Settings.MultipleInstances -ne 2 -or $d.Settings.ExecutionTimeLimit -ne 'PT0S' -or -not $d.Settings.AllowDemandStart){throw 'registered automatic update task differs from receipt'}; " +
    (operation === "disable" ? "$t[0].Enabled=$false; " : operation === "delete" ? "if($t[0].GetInstances(0).Count -ne 0 -or $t[0].State -notin @(1,3)){throw 'update task still has custody'}; $f.DeleteTask($env:COTAL_UPDATE_TASK,0); '{\"present\":false}';exit 0; " : "") +
    "ConvertTo-Json -Compress -InputObject @{present=$true;state=[int]$t[0].State;instances=[int]$t[0].GetInstances(0).Count;enabled=[bool]$t[0].Enabled}";
  const result = JSON.parse(powershell(script, { COTAL_UPDATE_TASK: r.name, COTAL_UPDATE_COMMAND: r.argv[0]!, COTAL_UPDATE_ARGUMENTS: r.argv.slice(1).map(windowsArgument).join(" "), COTAL_UPDATE_DIRECTORY: homeCotalDir(), COTAL_UPDATE_SID: win32ProcessBinding().userSid() })) as Task;
  if (result.present !== false && (result.present !== true || !Number.isInteger(result.state) || !Number.isInteger(result.instances))) throw new Error("Task Scheduler returned unknown automatic custody");
  return result;
}
function ownerAlive(r: WindowsUpdateReceipt): boolean {
  if (!r.owner) return false;
  const token = win32ProcessBinding().creationToken(r.owner.pid);
  if (token !== undefined) return token === r.owner.start;
  try { process.kill(r.owner.pid, 0); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") return false; throw error; }
  throw new Error("Windows automatic owner lifetime cannot be read");
}

/** A dead owner in the same boot pauses automatic installation, never manual admission. */
export function cleanWindowsUpdate(): "absent" | "pending" | "paused" | "failed" | "completed" {
  const r = readWindowsUpdate();
  if (!r) return "absent";
  const boot = windowsBootDisposition(r.bootId, win32ProcessBinding().bootId());
  if (boot === "same" && ownerAlive(r)) return "pending";
  const fd = gate(r);
  let releaseUpdate: (() => void) | undefined;
  try {
    const current = readWindowsUpdate();
    if (!current || current.nonce !== r.nonce) throw new Error("Windows update custody changed during cleanup");
    task(r, "disable");
    const cleared = windowsUpdateManuallyCleared(r.nonce);
    if (r.owner && !r.drained && boot === "same" && !cleared) {
      writeSecretFileAtomic(pausePath(), `${JSON.stringify({ v: 1, nonce: r.nonce, bootId: r.bootId })}\n`);
      save({ ...r, revoked: true });
      return "paused";
    }
    releaseUpdate = claimUpdateClosureAccess(true);
    save({ ...r, revoked: true });
    const observed = task(r);
    if (observed.present && (observed.instances !== 0 || ![1, 3].includes(observed.state!))) return "pending";
    if (observed.present) task(r, "delete");
    if (task(r).present) throw new Error("Windows update task removal not confirmed");
    if (!r.done && !cleared) {
      const path = join(homeCotalDir(), "update-attempt.json");
      const raw = readLocalRecordSource(path, 64 * 1024, true);
      if (!raw) throw new Error("Windows update attempt record is missing");
      const attempt = JSON.parse(raw.toString("utf8"));
      if (!Number.isSafeInteger(attempt.failures) || attempt.failures < 0) throw new Error("invalid Windows update failure count");
      writeSecretFileAtomic(path, `${JSON.stringify({ ...attempt, failures: Math.max(attempt.failures, r.failures + 1), result: "Windows automatic updater was interrupted; retrying automatically", next: Date.now() + UPDATE_HOUR_MS })}\n`);
    }
    writeSecretFileAtomic(pausePath(), "null\n");
    rmSync(receiptPath()); rmSync(r.source);
    return r.done || cleared ? "completed" : "failed";
  } finally { releaseUpdate?.(); closeSync(fd); }
}

export function renderWindowsUpdateTask(sid: string, argv: readonly string[], home: string): Buffer {
  if (!/^S-1-[0-9]+(?:-[0-9]+)+$/.test(sid) || argv.length !== 4 || !/^(?:[A-Za-z]:\\|\\\\)/.test(argv[0]!) || !/^(?:[A-Za-z]:\\|\\\\)/.test(home) || argv.some(value => !value || /[\0\r\n%]/.test(value)) || /[\0\r\n%]/.test(home)) throw new Error("Windows update task needs a valid SID and absolute unchanged arguments");
  const text = `<?xml version="1.0" encoding="UTF-16"?><Task version="1.3" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task"><RegistrationInfo><Description>Cotal one-shot automatic update</Description></RegistrationInfo><Triggers/><Principals><Principal id="Author"><UserId>${xmlText(sid)}</UserId><LogonType>InteractiveToken</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal></Principals><Settings><MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy><DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries><StopIfGoingOnBatteries>false</StopIfGoingOnBatteries><ExecutionTimeLimit>PT0S</ExecutionTimeLimit><AllowStartOnDemand>true</AllowStartOnDemand></Settings><Actions Context="Author"><Exec><Command>${xmlText(argv[0]!)}</Command><Arguments>${xmlText(argv.slice(1).map(windowsArgument).join(" "))}</Arguments><WorkingDirectory>${xmlText(home)}</WorkingDirectory></Exec></Actions></Task>`;
  const bytes = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, "utf16le")]);
  if (bytes.length > 64 * 1024) throw new Error("Windows update task source exceeds its byte limit");
  return bytes;
}
export function startWindowsUpdate(failures: number): void {
  if (process.platform !== "win32" || daemonStartedByOwnedService(daemonPaths()).state !== "owned") throw new Error("Windows automatic update does not own its native daemon service");
  if (!["absent", "completed", "failed"].includes(cleanWindowsUpdate())) throw new Error(WINDOWS_INTERRUPTED_UPDATE);
  const nonce = randomBytes(16).toString("hex"), name = `cotal-update-${nonce}`;
  const argv = [process.execPath, fileURLToPath(new URL("./update-windows-runner.js", import.meta.url)), nonce, homeCotalDir()];
  const source = join(homeCotalDir(), `${name}.xml`), bytes = renderWindowsUpdateTask(win32ProcessBinding().userSid(), argv, homeCotalDir());
  writeSecretFileCreateOnly(source, bytes);
  const keys = ["PATH", "HOME", "COTAL_HOME", "XDG_CONFIG_HOME", "TMPDIR", "npm_config_prefix", "npm_config_registry", "DO_NOT_TRACK", "COTAL_TELEMETRY", "COTAL_SKIP_CONNECTOR_SEED"];
  const env = Object.fromEntries(keys.filter(key => process.env[key] !== undefined).map(key => [key, process.env[key]!]));
  const r: WindowsUpdateReceipt = { v: 1, nonce, name, source, argv, env, sha256: digest(bytes), failures, bootId: win32ProcessBinding().bootId(), revoked: false };
  save(r); assertSource(r);
  const fd = gate(r); closeSync(fd);
  execFileSync(system32("schtasks.exe"), ["/Create", "/TN", name, "/XML", source], { timeout: 20_000, windowsHide: true, stdio: "pipe" });
  if (!task(r).present) throw new Error("Windows updater task registration not confirmed");
  execFileSync(system32("schtasks.exe"), ["/Run", "/TN", name], { timeout: 20_000, windowsHide: true, stdio: "pipe" });
}

export function admitWindowsUpdate(nonce: string): { receipt: WindowsUpdateReceipt; release(): void; complete(done: boolean): void } {
  const r = readWindowsUpdate();
  if (process.platform !== "win32" || !r || nonce !== r.nonce || r.revoked || r.owner || JSON.stringify(process.argv) !== JSON.stringify(r.argv)) throw new Error("Windows automatic helper does not match an unused admission receipt");
  const fd = gate(r);
  try {
    const checked = readWindowsUpdate();
    if (!checked || checked.nonce !== nonce || checked.revoked || checked.owner) throw new Error("Windows automatic helper admission was revoked");
    if (windowsBootDisposition(r.bootId, win32ProcessBinding().bootId()) !== "same" || !task(r).present) throw new Error("Windows automatic helper task or boot changed");
    const start = win32ProcessBinding().creationToken(process.pid);
    if (!start) throw new Error("Windows automatic helper birth is unavailable");
    const owned = { ...r, owner: { pid: process.pid, start, bootId: r.bootId } };
    save(owned);
    return { receipt: owned, release: () => closeSync(fd), complete(done) { save({ ...owned, revoked: true, drained: true, done }); } };
  } catch (error) { closeSync(fd); throw error; }
}
