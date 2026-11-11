/**
 * The Windows adapter for `cotal daemon install`: a scheduled task that runs the daemon as the
 * signed-in user.
 *
 * Task Scheduler is the per-user supervisor Windows ships. The task's logon trigger names this
 * user's SID, so it starts at this user's logon only, and a standard user can register it without
 * elevation. It runs on the user's interactive token at least privilege, so no password is stored
 * and nothing runs as LocalSystem. The trigger repeats every minute with no end, and the task
 * ignores a start while its instance is running, so a daemon that exits is started again within a
 * minute. The battery and run-time limits are off, and it runs at normal priority.
 *
 * `schtasks /Create /XML` registers the definition from a file this install first creates in the
 * daemon's own state directory, as UTF-16 with a byte order mark, and records the digest of. The
 * task name carries the user's SID, so two users of one machine never collide. `uninstall` acts
 * only while that file is unchanged and the task registered under its name still runs that file's
 * exact command and arguments. That read uses `Get-ScheduledTask` through a fixed PowerShell script
 * that takes the task name from its environment, because `schtasks /Query /XML` does not reliably
 * state the encoding of what it prints.
 *
 * The desktop package uses its GUI-subsystem launcher to keep Node hidden. An unpackaged CLI
 * uses Node directly and can show a console window. The headless
 * profile, a Windows service under a dedicated service account, is not offered here.
 */
import { setTimeout as delay } from "node:timers/promises";
import { createHash } from "node:crypto";
import { lstatSync, rmSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { basename, join, win32 } from "node:path";
import { writeSecretFileCreateOnly } from "@cotal-ai/core";
import { CommandFailure, readLocalRecordSource } from "@cotal-ai/workspace";
import { xmlText } from "./install-darwin.js";
import type { NativePlan, NativeRun, NativeService, UnitReceipt } from "./install.js";

/** A System32 tool, resolved from the Windows directory and never from `PATH`. */
function system32(...segments: string[]): string {
  return join(process.env.SystemRoot || process.env.windir || "C:\\Windows", "System32", ...segments);
}

const SOURCE_LIMIT = 64 * 1024;

/** `cotal-daemon-<SID>`, or `cotal-daemon-<16 hex>-<SID>` for an explicit daemon home, derived as
 *  its socket directory is. */
export function scheduledTaskName(daemonHome: string | undefined, sid: string): string {
  if (!/^S-1-[0-9]+(?:-[0-9]+)+$/.test(sid)) throw new CommandFailure("refused", "TARGET_UNAVAILABLE", "the current Windows user has no readable SID; no task name was derived");
  if (daemonHome === undefined) return `cotal-daemon-${sid}`;
  return `cotal-daemon-${createHash("sha256").update(daemonHome).digest("hex").slice(0, 16)}-${sid}`;
}

/** One argument as the Microsoft C runtime splits a command line: quoted when it holds a space or
 *  tab, with the backslashes before the closing quote doubled. A double quote is refused, as no
 *  Windows path holds one, and so is `%`, which Task Scheduler expands with no escape. */
export function windowsArgument(arg: string): string {
  if (!arg || arg.includes('"') || arg.includes("%")) throw new CommandFailure("refused", "UNSUPPORTED", "a task argument is empty or holds a double quote or %, which Task Scheduler would not pass through unchanged; no task was prepared");
  if (!/[ \t]/.test(arg)) return arg;
  return `"${arg}${"\\".repeat(/\\*$/.exec(arg)![0].length)}"`;
}

export interface ScheduledTaskInput {
  readonly sid: string;
  readonly argv: readonly string[];
  readonly workingDirectory: string;
}

/** The task definition this install registers. */
export function renderScheduledTask(input: ScheduledTaskInput): { text: string; bytes: Buffer; sha256: string; command: string; arguments: string } {
  const nativeArgv = [...input.argv];
  const daemon = nativeArgv.indexOf("daemon");
  if (daemon >= 2 && /cotal\.[cm]?js$/i.test(nativeArgv[daemon - 1]!)) nativeArgv[daemon - 1] = win32.join(win32.dirname(nativeArgv[daemon - 1]!), "daemon-native.js");
  const [command, ...rest] = nativeArgv;
  // Windows path rules on every host, so the definition renders the same wherever it is checked.
  if (command === undefined || !win32.isAbsolute(command) || !win32.isAbsolute(input.workingDirectory) || command.includes("%") || input.workingDirectory.includes("%")) throw new CommandFailure("refused", "UNSUPPORTED", "the task needs absolute executable and working paths without %; no task was prepared");
  const args = rest.map(windowsArgument).join(" ");
  const sid = xmlText(input.sid);
  const text = [
    '<?xml version="1.0" encoding="UTF-16"?>',
    '<Task version="1.3" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">',
    "  <RegistrationInfo><Description>Cotal machine daemon</Description></RegistrationInfo>",
    "  <Triggers>",
    `    <LogonTrigger><Enabled>true</Enabled><Repetition><Interval>PT1M</Interval><StopAtDurationEnd>false</StopAtDurationEnd></Repetition><UserId>${sid}</UserId></LogonTrigger>`,
    "  </Triggers>",
    "  <Principals>",
    `    <Principal id="Author"><UserId>${sid}</UserId><LogonType>InteractiveToken</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal>`,
    "  </Principals>",
    "  <Settings>",
    "    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>",
    "    <RestartOnFailure><Interval>PT1M</Interval><Count>255</Count></RestartOnFailure>",
    "    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>",
    "    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>",
    "    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>",
    "    <Priority>4</Priority>",
    "  </Settings>",
    '  <Actions Context="Author">',
    `    <Exec><Command>${xmlText(command)}</Command><Arguments>${xmlText(args)}</Arguments><WorkingDirectory>${xmlText(input.workingDirectory)}</WorkingDirectory></Exec>`,
    "  </Actions>",
    "</Task>",
    "",
  ].join("\r\n");
  const bytes = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, "utf16le")]);
  if (bytes.length > SOURCE_LIMIT) throw new CommandFailure("refused", "USAGE_INVALID", "the task definition exceeds its bounded source size");
  return { text, bytes, sha256: createHash("sha256").update(bytes).digest("hex"), command, arguments: args };
}

/** An element's text in a definition this install wrote, unescaped; `absent` when it is not there. */
function element(text: string, name: string): string {
  const raw = new RegExp(`<${name}>([^<]*)</${name}>`).exec(text)?.[1];
  return raw === undefined ? "absent" : raw.replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&quot;", '"').replaceAll("&apos;", "'").replaceAll("&amp;", "&");
}

/** What Task Scheduler has registered under one task name in the root folder. */
interface RegisteredTask {
  readonly present: boolean;
  readonly state?: string;
  readonly enabled?: boolean;
  readonly instances?: number;
  readonly actions?: number;
  readonly execute?: string;
  readonly arguments?: string;
  readonly workingDirectory?: string;
  readonly userId?: string;
  readonly logonType?: number;
  readonly runLevel?: number;
}

/** Fixed: the task name arrives only through `COTAL_DAEMON_TASK`, never as script text. It lists
 *  every task and filters, because a filtered `Get-ScheduledTask` that matches nothing is an error
 *  rather than an empty answer. */
const READ_TASK = [
  "$ErrorActionPreference = 'Stop'",
  "Import-Module ScheduledTasks",
  "[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)",
  "$task = @(Get-ScheduledTask | Where-Object { $_.TaskPath -ceq '\\' -and $_.TaskName -ceq $env:COTAL_DAEMON_TASK })",
  "if ($task.Count -eq 0) { '{\"present\":false}'; exit 0 }",
  "$actions = @($task[0].Actions)",
  "$principal = $task[0].Principal",
  "$principalSid = [string]$principal.UserId",
  "if ($principalSid -notmatch '^S-1-') { $principalSid = ([System.Security.Principal.NTAccount]::new($principalSid)).Translate([System.Security.Principal.SecurityIdentifier]).Value }",
  "$enabled = $null; $instances = $null",
  "if ($env:COTAL_DAEMON_TASK_INSTANCES -eq '1') {",
  "$scheduler = New-Object -ComObject 'Schedule.Service'",
  "$scheduler.Connect()",
  "$registered = $scheduler.GetFolder('\\').GetTask($env:COTAL_DAEMON_TASK)",
  "$enabled = [bool]$registered.Enabled; $instances = [int]$registered.GetInstances(0).Count",
  "}",
  "ConvertTo-Json -Compress -InputObject @{ enabled = $enabled; instances = $instances; present = $true; state = [string]$task[0].State; actions = $actions.Count; execute = [string]$actions[0].Execute; arguments = [string]$actions[0].Arguments; workingDirectory = [string]$actions[0].WorkingDirectory; userId = $principalSid; logonType = [int]$principal.LogonType; runLevel = [int]$principal.RunLevel }",
].join("\n");

/** Windows refresh pauses the owned task without deleting its installation. */
export interface WindowsTaskService extends NativeService {
  pause(receipt: UnitReceipt): Promise<void>;
  resume(receipt: UnitReceipt): void;
}

export function scheduledTaskService(run: NativeRun): WindowsTaskService {
  const sid = (): string => {
    const out = run(system32("whoami.exe"), ["/user", "/fo", "csv", "/nh"]);
    const value = out.status === 0 ? out.stdout.trim().split(",").pop()?.replace(/^"|"$/g, "").trim() : undefined;
    if (!value || !/^S-1-[0-9]+(?:-[0-9]+)+$/.test(value)) throw new CommandFailure("refused", "TARGET_UNAVAILABLE", `whoami did not name the current user's SID (${out.detail}); nothing was changed`);
    return value;
  };
  const registered = (name: string, requireInstances = false): RegisteredTask => {
    const out = run(system32("WindowsPowerShell", "v1.0", "powershell.exe"), ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(READ_TASK, "utf16le").toString("base64")], { ...process.env, COTAL_DAEMON_TASK: name, COTAL_DAEMON_TASK_INSTANCES: requireInstances ? "1" : "0" });
    let o: unknown;
    try { o = out.status === 0 ? JSON.parse(out.stdout.replace(/^\uFEFF/, "").trim()) : undefined; } catch { o = undefined; }
    const r = o && typeof o === "object" ? o as Record<string, unknown> : undefined;
    if (r?.present === false) return { present: false };
    if (r?.present !== true || typeof r.state !== "string" || typeof r.actions !== "number" || typeof r.execute !== "string" || typeof r.arguments !== "string" || typeof r.workingDirectory !== "string" || typeof r.userId !== "string" || typeof r.logonType !== "number" || typeof r.runLevel !== "number") throw new CommandFailure("refused", "TARGET_UNAVAILABLE", `Task Scheduler did not answer for ${name} (${out.detail}); nothing was changed`);
    if (requireInstances && (typeof r.enabled !== "boolean" || !Number.isSafeInteger(r.instances) || (r.instances as number) < 0)) throw new CommandFailure("refused", "TARGET_UNAVAILABLE", "Task Scheduler did not confirm enabled state and running instances; nothing was inferred");
    return { present: true, enabled: r.enabled as boolean | undefined, instances: r.instances as number | undefined, state: r.state, actions: r.actions, execute: r.execute, arguments: r.arguments, workingDirectory: r.workingDirectory, userId: r.userId, logonType: r.logonType, runLevel: r.runLevel };
  };
  const step = (args: readonly string[]): void => {
    const result = run(system32("schtasks.exe"), args);
    if (result.status !== 0) throw new CommandFailure("unknown", "OPERATION_UNKNOWN", `schtasks ${args.join(" ")} did not confirm completion (${result.detail}); it was not retried`, { remedy: "inspect the task in Task Scheduler, then remove it with cotal daemon uninstall" });
  };
  /** The registered task, refused unless it runs the recorded definition's exact command. */
  const owned = (receipt: UnitReceipt, requireInstances = false): RegisteredTask => {
    // A receipt names only the task and definition this daemon home and user derive, so it can
    // never steer a delete at another task.
    if (receipt.unit !== scheduledTaskName(receipt.daemonHome, sid()) || basename(receipt.unitPath) !== "service-task.xml") throw new CommandFailure("refused", "CONFLICT", `the recorded task ${receipt.unit} is not this daemon's task; nothing was removed`);
    const bytes = readLocalRecordSource(receipt.unitPath, SOURCE_LIMIT, true);
    if (!bytes || createHash("sha256").update(bytes).digest("hex") !== receipt.unitSha256 || bytes[0] !== 0xff || bytes[1] !== 0xfe) throw new CommandFailure("refused", "CONFLICT", `${receipt.unitPath} is not the task definition this daemon installed; nothing was removed`);
    const text = bytes.subarray(2).toString("utf16le");
    const task = registered(receipt.unit, requireInstances);
    if (task.present && (task.actions !== 1 || task.execute !== element(text, "Command") || task.arguments !== element(text, "Arguments") || task.workingDirectory !== element(text, "WorkingDirectory") || task.userId !== element(text, "UserId") || task.logonType !== 3 || task.runLevel !== 0))
      throw new CommandFailure("refused", "CONFLICT", `the task registered as ${receipt.unit} no longer runs the command this daemon installed; nothing was removed`);
    return task;
  };
  return {
    mechanism: "scheduled-task",
    async pause(receipt) {
      const task = owned(receipt, true);
      if (!task.present || !task.enabled) throw new CommandFailure("refused", "CONFLICT", "the owned scheduled task is absent or disabled; refresh was refused");
      step(["/Change", "/TN", receipt.unit, "/DISABLE"]);
      const disabled = owned(receipt, true);
      if (!disabled.present || disabled.enabled !== false) throw new CommandFailure("unknown", "OPERATION_UNKNOWN", "the owned task did not confirm disabled state");
      if (disabled.instances! > 0) {
        owned(receipt, true);
        step(["/End", "/TN", receipt.unit]);
      }
      for (let attempt = 0; attempt < 3; attempt++) {
        const ended = owned(receipt, true);
        if (!ended.present || ended.enabled !== false) break;
        if (ended.instances === 0) return;
        if (attempt < 2) await delay(250);
      }
      throw new CommandFailure("unknown", "OPERATION_UNKNOWN", "the owned task did not confirm no running instances after End");
    },
    resume(receipt) {
      const task = owned(receipt, true);
      if (!task.present || task.enabled !== false || task.instances !== 0) throw new CommandFailure("refused", "CONFLICT", "the paused owned task changed before resume");
      step(["/Change", "/TN", receipt.unit, "/ENABLE"]);
      const enabled = owned(receipt, true);
      if (!enabled.present || enabled.enabled !== true) throw new CommandFailure("unknown", "OPERATION_UNKNOWN", "the owned task did not confirm enabled state");
      if (enabled.instances === 0) step(["/Run", "/TN", receipt.unit]);
    },
    plan(paths, daemonHome, argv): NativePlan {
      const user = sid();
      const unit = scheduledTaskName(daemonHome, user);
      const unitPath = join(paths.state, "service-task.xml");
      let present = false;
      try { lstatSync(unitPath); present = true; }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new CommandFailure("refused", "TARGET_UNAVAILABLE", `${unitPath} could not be inspected; no absent task definition was inferred`); }
      if (present) throw new CommandFailure("refused", "CONFLICT", `${unitPath} already exists and no install of this daemon recorded it; it was not written over`);
      if (registered(unit).present) throw new CommandFailure("refused", "CONFLICT", `a task named ${unit} is already registered and no install of this daemon recorded it; nothing was written`);
      const { text, bytes, sha256 } = renderScheduledTask({ sid: user, argv, workingDirectory: homedir() });
      return { mechanism: "scheduled-task", unit, unitPath, bytes, sha256, user: userInfo().username,
        restart: `every ${element(text, "Interval")} unless running (${element(text, "MultipleInstancesPolicy")})`, wantedBy: `logon of ${element(text, "UserId")}` };
    },
    publish(plan) {
      writeSecretFileCreateOnly(plan.unitPath, plan.bytes);
      const written = readLocalRecordSource(plan.unitPath, SOURCE_LIMIT, true);
      if (!written || createHash("sha256").update(written).digest("hex") !== plan.sha256) throw new CommandFailure("unknown", "OPERATION_UNKNOWN", "the published task definition could not be verified against its exact recorded digest; no task was registered");
    },
    register(plan) {
      step(["/Create", "/TN", plan.unit, "/XML", plan.unitPath]);
      step(["/Run", "/TN", plan.unit]);
    },
    check(receipt) {
      owned(receipt);
    },
    start(receipt) {
      const task = owned(receipt);
      if (!task.present) throw new CommandFailure("refused", "TARGET_NOT_FOUND", "the recorded scheduled task is absent; no replacement task was created");
      if (task.state !== "Running") step(["/Run", "/TN", receipt.unit]);
    },
    // Production restarts must use install.ts restartInstalled, which pins the old
    // listener and confirms its death before resume. This legacy synchronous adapter
    // operation cannot establish daemon lifetime replacement.
    restart(receipt) {
      const task = owned(receipt);
      if (!task.present) throw new CommandFailure("refused", "TARGET_NOT_FOUND", "the recorded scheduled task is absent; no replacement task was created");
      if (task.state === "Running") step(["/End", "/TN", receipt.unit]);
      step(["/Run", "/TN", receipt.unit]);
    },
    remove(receipt, preserveSource = false) {
      const task = owned(receipt);
      if (task.present) {
        // Disabled first, so its one-minute repetition cannot start it between the end and the delete.
        step(["/Change", "/TN", receipt.unit, "/DISABLE"]);
        if (task.state === "Running") step(["/End", "/TN", receipt.unit]);
        step(["/Delete", "/TN", receipt.unit, "/F"]);
      }
      if (!preserveSource) rmSync(receipt.unitPath, { force: true });
    },
  };
}
