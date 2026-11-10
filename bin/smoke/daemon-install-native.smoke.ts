/**
 * `cotal daemon install` on macOS and Windows: the LaunchAgent and scheduled-task adapters, driven
 * through their shipped plan, publish, register, check and remove steps against owned temporary
 * directories and a recording native runner. No launchctl, schtasks or PowerShell runs, and no
 * user or machine configuration is touched; the runner answers as the OS tool would and records the
 * exact argument vector it was handed.
 *
 * Cells (each asserts exact codes, argument vectors or bytes):
 *  N1 the plist: label derivation, escaped arguments with no shell, KeepAlive and RunAtLoad, a
 *     pinned PATH, and refusals for control characters and relative paths;
 *  N2 the LaunchAgent lifecycle: plan reads `print gui/<uid>/<label>` and treats only 113 as
 *     absent, a loaded label or a foreign plist refuses CONFLICT with the file unchanged, publish
 *     creates a 0600 plist with the planned digest, register runs `enable` then `bootstrap`, a
 *     changed plist refuses removal, and remove boots out only a loaded label;
 *  N3 the task definition: UTF-16 with a byte order mark, the user's SID on the trigger and the
 *     principal, interactive token at least privilege, and arguments that a Microsoft C runtime
 *     split returns unchanged; `%` and `"` refuse;
 *  N4 the scheduled-task lifecycle: the SID comes from whoami, the task read gets the name only
 *     through its environment, an existing task or definition refuses CONFLICT, register runs
 *     `/Create /XML` then `/Run`, a task whose command changed refuses removal, and remove disables,
 *     ends only a running task, and deletes it;
 *  N5 the receipt dispatch on this OS: a receipt from before mechanisms reads as systemd, and a
 *     LaunchAgent receipt refuses CONFLICT here with nothing removed;
 *  N6 Linux built-CLI receipt binding against real files and recording native-tool subprocesses:
 *     valid default/managed receipts work; redirected paths, wrong units and copied homes refuse
 *     before any native mutation or file removal. No real systemd or linger change occurs.
 *
 * Real supervisor lifecycle acceptance belongs to daemon-install-real.smoke.mjs on disposable hosts.
 *
 * Run: tsx bin/smoke/daemon-install-native.smoke.ts   (POSIX; the Windows adapter runs on its fake)
 */
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { CommandFailure } from "@cotal-ai/workspace";
import type { DaemonPaths } from "../daemon/endpoint.js";
import { planUninstall, type NativeResult, type NativeRun, type UnitReceipt } from "../daemon/install.js";
import { launchAgentLabel, launchAgentService, renderLaunchAgent, xmlText } from "../daemon/install-darwin.js";
import { renderScheduledTask, scheduledTaskName, scheduledTaskService, windowsArgument } from "../daemon/install-win32.js";

let pass = 0, fail = 0;
const check = (name: string, cond: boolean, extra?: unknown) => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); } else { fail++; console.log(`  ✗ FAIL: ${name}`, extra ?? ""); }
};
const code = (fn: () => unknown): string => {
  try { fn(); return "none"; } catch (e) { return e instanceof CommandFailure ? e.code : `throw:${(e as Error).message}`; }
};
const sha = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");

interface Call { file: string; args: readonly string[]; env?: NodeJS.ProcessEnv }
/** A native runner that records every call and answers from `answer`. */
function recorder(answer: (call: Call) => Partial<NativeResult>): { run: NativeRun; calls: Call[] } {
  const calls: Call[] = [];
  return { calls, run: (file, args, env) => {
    const call = { file, args: [...args], ...(env ? { env } : {}) };
    calls.push(call);
    return { status: 0, stdout: "", detail: "", ...answer(call) };
  } };
}

// The physical path: macOS puts the temp dir under /var, a symlink, which a protected service
// directory refuses as it would for a user, and the fixture home here stands in for a real one.
const root = realpathSync(mkdtempSync(join(tmpdir(), "dni-")));
const savedHome = process.env.HOME;
try {
  const uid = process.getuid?.();
  const node = "/opt/cotal/1.2.3/bin/node";
  const bootstrap = fileURLToPath(new URL("../daemon-cwd.js", import.meta.url));
  const argv = [node, "--max-semi-space-size=1", "/opt/cotal/1.2.3/lib/cotal.js", "daemon", "serve", "--daemon-home", "/Users/a b/&<home>"];

  console.log("N1 plist");
  {
    check("default label", launchAgentLabel(undefined) === "ai.cotal.daemon");
    check("home label is derived from the home", launchAgentLabel("/x") === `ai.cotal.daemon.${sha("/x").slice(0, 16)}`);
    const { text, sha256 } = renderLaunchAgent({ label: "ai.cotal.daemon", argv, searchPath: "/usr/bin:/bin", workingDirectory: "/Users/a", logPath: "/Users/a/.cotal/daemon/daemon.log" });
    check("arguments are escaped, one string each", text.includes("<string>/Users/a b/&amp;&lt;home&gt;</string>") && (text.match(/<string>/g) ?? []).length === argv.length + 6, text);
    check("directory is carried by the bootstrap's arguments", text.includes(`<string>${xmlText(bootstrap)}</string><string>/Users/a</string><string>daemon</string><string>serve</string>`));
    const alias = renderLaunchAgent({ label: "ai.cotal.daemon", argv: [node, "/usr/local/bin/cotal", "daemon", "serve"], searchPath: "/bin", workingDirectory: "/Users/a", logPath: "/log" });
    check("a CLI alias still pins this package's bootstrap", alias.text.includes(`<string>${xmlText(bootstrap)}</string>`) && !alias.text.includes("/usr/local/bin/daemon-cwd.js"));
    check("no unobservable WorkingDirectory property is emitted", !text.includes("<key>WorkingDirectory</key>"));
    check("KeepAlive and RunAtLoad are true", text.includes("<key>KeepAlive</key><true/>") && text.includes("<key>RunAtLoad</key><true/>"));
    check("PATH is pinned", text.includes("<key>PATH</key><string>/usr/bin:/bin</string>") && text.includes("<key>COTAL_DAEMON_NATIVE_SERVICE</key><string>1</string>"));
    check("digest is of the exact bytes", sha256 === sha(text));
    check("a control character refuses", code(() => renderLaunchAgent({ label: "ai.cotal.daemon", argv: [node, "a\nb"], searchPath: "/bin", workingDirectory: "/", logPath: "/l" })) === "USAGE_INVALID");
    check("a relative executable refuses", code(() => renderLaunchAgent({ label: "ai.cotal.daemon", argv: ["node", "x"], searchPath: "/bin", workingDirectory: "/", logPath: "/l" })) === "USAGE_INVALID");
  }

  console.log("N2 LaunchAgent lifecycle");
  // Windows has no user id for a launchd GUI domain, so the adapter refuses there before it reads
  // anything, and the lifecycle cells, which drive it with injected launchctl answers, do not run.
  if (uid === undefined) {
    const state = join(root, "mac-state");
    mkdirSync(state, { mode: 0o700 });
    const paths: DaemonPaths = { dir: join(root, "run"), socket: join(root, "run", "daemon.sock"), state, lock: join(state, "daemon.lock") };
    const r = recorder(() => ({}));
    check("a platform with no user id refuses a LaunchAgent plan UNSUPPORTED, reading nothing", code(() => launchAgentService(r.run, () => ({ state: "absent" })).plan(paths, undefined, argv, () => "/usr/bin:/bin")) === "UNSUPPORTED" && r.calls.length === 0, r.calls);
    console.log(`  ○ NOT RUN N2 lifecycle cells: no launchd user id on ${process.platform}`);
  } else {
    const home = join(root, "mac-home");
    mkdirSync(join(home, "Library"), { recursive: true, mode: 0o700 });
    process.env.HOME = home;
    const state = join(root, "mac-state");
    mkdirSync(state, { mode: 0o700 });
    const paths: DaemonPaths = { dir: join(root, "run"), socket: join(root, "run", "daemon.sock"), state, lock: join(state, "daemon.lock") };
    const label = "ai.cotal.daemon";
    const plist = join(home, "Library", "LaunchAgents", `${label}.plist`);
    const target = `gui/${uid}/${label}`;

    let printStatus = 113;
    const r = recorder((c) => c.args[0] === "print" ? { status: printStatus, detail: printStatus === 125 ? "Domain does not support specified action" : "" } : {});
    const loadedArgv = [node, "--max-semi-space-size=1", bootstrap, home, ...argv.slice(3)];
    let observedJob: import("@cotal-ai/seat").DarwinLaunchdLookup = { state: "loaded", job: { label, program: node, programArguments: loadedArgv } };
    const service = launchAgentService(r.run, () => observedJob);
    const plan = service.plan(paths, undefined, argv, () => "/usr/bin:/bin");
    check("plan reads the label in the user's GUI domain", r.calls.length === 1 && r.calls[0]!.file === "/bin/launchctl" && r.calls[0]!.args.join(" ") === `print ${target}`, r.calls);
    check("plan names the plist under ~/Library/LaunchAgents", plan.unitPath === plist && plan.unit === label && plan.mechanism === "launchd-agent");
    check("plan states restart and start from the bytes", plan.restart === "KeepAlive=true" && plan.wantedBy === `login to gui/${uid} (RunAtLoad=true)`, plan);
    check("plan logs into the daemon's state", plan.bytes.toString().includes(`<key>StandardErrorPath</key><string>${join(state, "daemon.log")}</string>`));
    printStatus = 0;
    check("a loaded label refuses CONFLICT", code(() => service.plan(paths, undefined, argv, () => "/bin")) === "CONFLICT");
    printStatus = 125;
    check("a domain that does not answer refuses TARGET_UNAVAILABLE", code(() => service.plan(paths, undefined, argv, () => "/bin")) === "TARGET_UNAVAILABLE");
    printStatus = 113;

    mkdirSync(join(home, "Library", "LaunchAgents"), { mode: 0o755 });
    writeFileSync(plist, "foreign");
    check("a foreign plist at the path refuses CONFLICT", code(() => service.plan(paths, undefined, argv, () => "/bin")) === "CONFLICT");
    check("and it is left unchanged", readFileSync(plist, "utf8") === "foreign");
    rmSync(plist);

    r.calls.length = 0;
    service.publish(plan);
    const stat = lstatSync(plist);
    check("publish creates a 0600 regular plist with the planned digest", stat.isFile() && (stat.mode & 0o777) === 0o600 && sha(readFileSync(plist)) === plan.sha256);
    check("publish calls nothing native", r.calls.length === 0);
    service.register(plan);
    check("register runs enable then bootstrap", r.calls.map((c) => c.args.join(" ")).join(" | ") === `enable ${target} | bootstrap gui/${uid} ${plist}`, r.calls);

    const receipt: UnitReceipt = { v: 1, mechanism: "launchd-agent", unit: label, unitPath: plist, unitSha256: plan.sha256, installedAt: "t" };
    r.calls.length = 0;
    service.check(receipt);
    check("check passes the unchanged plist after one domain read", r.calls.length === 1 && r.calls[0]!.args[0] === "print");
    check("a different recorded digest refuses CONFLICT", code(() => service.check({ ...receipt, unitSha256: "0".repeat(64) })) === "CONFLICT");
    printStatus = 0;
    check("new loaded job proves its directory through arguments without a WorkingDirectory field", code(() => service.check(receipt)) === "none");
    const originalJob = observedJob;
    for (const badJob of [
      { state: "absent" as const },
      { state: "unavailable" as const, reason: "fixture" },
      { state: "loaded" as const, job: { label, program: "/foreign", programArguments: loadedArgv } },
      { state: "loaded" as const, job: { label, program: node, programArguments: ["foreign"] } },
      { state: "loaded" as const, job: { label, program: node, programArguments: argv } },
      { state: "loaded" as const, job: { label, programArguments: loadedArgv } },
      { state: "loaded" as const, job: { label, program: node } },
    ]) {
      observedJob = badJob;
      r.calls.length = 0;
      check("unverified or changed loaded job refuses teardown", ["TARGET_UNAVAILABLE", "CONFLICT"].includes(code(() => service.remove(receipt))));
      check("refused teardown sends no bootout", !r.calls.some((call) => call.args[0] === "bootout") && lstatSync(plist).isFile());
    }
    observedJob = originalJob;
    r.calls.length = 0;
    service.restart(receipt);
    check("restarting a loaded owned job force-kickstarts only its exact target", JSON.stringify(r.calls.map(c => [c.file, ...c.args])) === JSON.stringify([
      ["/bin/launchctl", "print", target], ["/bin/launchctl", "kickstart", "-k", target],
    ]), r.calls);
    printStatus = 113;
    r.calls.length = 0;
    service.restart(receipt);
    check("restarting an unloaded owned job bootstraps only its recorded plist", JSON.stringify(r.calls.map(c => [c.file, ...c.args])) === JSON.stringify([
      ["/bin/launchctl", "print", target], ["/bin/launchctl", "bootstrap", `gui/${uid}`, plist],
    ]), r.calls);
    printStatus = 0;
    observedJob = { state: "loaded", job: { label, program: "/foreign", programArguments: loadedArgv } };
    r.calls.length = 0;
    check("restarting a job with changed ownership refuses CONFLICT", code(() => service.restart(receipt)) === "CONFLICT");
    check("refused restart sends no native mutation and preserves the plist", r.calls.every(c => c.file === "/bin/launchctl" && c.args[0] === "print") && sha(readFileSync(plist)) === receipt.unitSha256, r.calls);
    observedJob = originalJob;
    r.calls.length = 0;
    service.start(receipt);
    check("starting a loaded job never force-restarts it", r.calls.some((call) => call.args[0] === "kickstart") && !r.calls.some((call) => call.args.includes("-k")));
    const newSource = readFileSync(plist, "utf8");
    const legacyDirectory = `<key>WorkingDirectory</key><string>${xmlText(home)}</string>`;
    const legacySource = newSource
      .replace(/<key>ProgramArguments<\/key><array>[\s\S]*?<\/array>/, `<key>ProgramArguments</key><array>${argv.map(a => `<string>${xmlText(a)}</string>`).join("")}</array>`)
      .replace("<key>EnvironmentVariables</key>", `${legacyDirectory}\n<key>EnvironmentVariables</key>`);
    writeFileSync(plist, legacySource, { mode: 0o600 });
    const legacyReceipt = { ...receipt, unitSha256: sha(legacySource) };
    observedJob = { state: "loaded", job: { label, program: node, programArguments: argv } };
    r.calls.length = 0;
    check("legacy missing WorkingDirectory still refuses start", code(() => service.start(legacyReceipt)) === "CONFLICT");
    check("legacy missing WorkingDirectory still refuses removal", code(() => service.remove(legacyReceipt)) === "CONFLICT");
    check("legacy refusal changes no native job or source", r.calls.every(c => c.args[0] === "print") && readFileSync(plist, "utf8") === legacySource);
    observedJob = { state: "loaded", job: { label, program: node, programArguments: argv, workingDirectory: home } };
    check("legacy matching native directory remains accepted", code(() => service.check(legacyReceipt)) === "none");
    observedJob = { state: "loaded", job: { label, program: node, programArguments: argv, workingDirectory: "/foreign" } };
    check("legacy changed native directory still refuses", code(() => service.check(legacyReceipt)) === "CONFLICT");
    const unknownSource = legacySource.replace(legacyDirectory, "");
    writeFileSync(plist, unknownSource, { mode: 0o600 });
    observedJob = { state: "loaded", job: { label, program: node, programArguments: argv } };
    check("directory-free source without the bootstrap refuses", code(() => service.check({ ...receipt, unitSha256: sha(unknownSource) })) === "CONFLICT");
    writeFileSync(plist, newSource, { mode: 0o600 });
    observedJob = originalJob;
    printStatus = 0;
    r.calls.length = 0;
    check("a receipt naming another label refuses CONFLICT", code(() => service.remove({ ...receipt, unit: "com.example.other" })) === "CONFLICT");
    check("a receipt naming another plist refuses CONFLICT", code(() => service.remove({ ...receipt, unitPath: join(home, "other.plist") })) === "CONFLICT");
    check("and neither reached launchd nor removed the plist", r.calls.length === 0 && lstatSync(plist).isFile());
    printStatus = 113;

    const failing = recorder((c) => c.args[0] === "bootstrap" ? { status: 5, detail: "Bootstrap failed: 5: Input/output error" } : { status: c.args[0] === "print" ? 113 : 0 });
    check("a refused bootstrap is OPERATION_UNKNOWN", code(() => launchAgentService(failing.run).register(plan)) === "OPERATION_UNKNOWN");

    printStatus = 113;
    r.calls.length = 0;
    const copy = readFileSync(plist);
    service.remove(receipt);
    check("remove of an unloaded label boots nothing out", r.calls.every((c) => c.args[0] === "print") && r.calls.length > 0, r.calls);
    check("and removes the plist", (() => { try { lstatSync(plist); return false; } catch { return true; } })());
    writeFileSync(plist, copy, { mode: 0o600 });
    printStatus = 0;
    r.calls.length = 0;
    service.remove(receipt);
    check("remove of a loaded label boots out that exact label once", r.calls.at(-1)!.args.join(" ") === `bootout ${target}` && r.calls.filter((c) => c.args[0] === "bootout").length === 1, r.calls);
  }

  console.log("N3 task definition");
  {
    const sid = "S-1-5-21-1004336348-1177238915-682003330-1001";
    check("default task name carries the SID", scheduledTaskName(undefined, sid) === `cotal-daemon-${sid}`);
    check("home task name is derived from the home", scheduledTaskName("C:\\h", sid) === `cotal-daemon-${sha("C:\\h").slice(0, 16)}-${sid}`);
    check("a malformed SID refuses", code(() => scheduledTaskName(undefined, "S-1-x")) === "TARGET_UNAVAILABLE");
    const winArgv = ["C:\\Program Files\\nodejs\\node.exe", "--max-semi-space-size=1", "C:\\Program Files\\cotal\\cotal.js", "daemon", "serve", "--daemon-home", "C:\\Users\\a b\\home\\"];
    const t = renderScheduledTask({ sid, argv: winArgv, workingDirectory: "C:\\Users\\a b" });
    check("UTF-16LE with a byte order mark", t.bytes[0] === 0xff && t.bytes[1] === 0xfe && t.bytes.subarray(2).toString("utf16le") === t.text && t.sha256 === sha(t.bytes));
    check("the trigger and principal name the SID", t.text.includes(`<UserId>${sid}</UserId></LogonTrigger>`) && t.text.includes(`<Principal id="Author"><UserId>${sid}</UserId><LogonType>InteractiveToken</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal>`));
    check("restarts by a one-minute repetition that ignores a running instance", t.text.includes("<Repetition><Interval>PT1M</Interval><StopAtDurationEnd>false</StopAtDurationEnd></Repetition>") && t.text.includes("<MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>") && !t.text.includes("<Duration>"));
    check("no run-time or battery limit", t.text.includes("<ExecutionTimeLimit>PT0S</ExecutionTimeLimit>") && t.text.includes("<DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>") && t.text.includes("<StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>"));
    check("the command is the executable, unquoted", t.command === winArgv[0] && t.text.includes(`<Command>${winArgv[0]}</Command>`));
    check("a C runtime split of the arguments returns them unchanged", JSON.stringify(splitWindows(t.arguments)) === JSON.stringify([winArgv[1], "C:\\Program Files\\cotal\\daemon-native.js", ...winArgv.slice(3)]), [t.arguments, splitWindows(t.arguments)]);
    check("% refuses", code(() => windowsArgument("%APPDATA%")) === "UNSUPPORTED");
    check("a double quote refuses", code(() => windowsArgument('a"b')) === "UNSUPPORTED");
    check("a relative executable refuses", code(() => renderScheduledTask({ sid, argv: ["node.exe"], workingDirectory: "C:\\" })) === "UNSUPPORTED");
  }

  console.log("N4 scheduled-task lifecycle");
  {
    const sid = "S-1-5-21-1-2-3-1001";
    const name = `cotal-daemon-${sid}`;
    const state = join(root, "win-state");
    mkdirSync(state, { mode: 0o700 });
    const paths: DaemonPaths = { dir: join(root, "wrun"), socket: join(root, "wrun", "s"), state, lock: join(state, "daemon.lock") };
    const posixArgv = ["/opt/node", "/opt/cotal.js", "daemon", "serve"];
    let task: Record<string, unknown> = { present: false };
    // The working directory the adapter writes is the home it reads, which Windows takes from USERPROFILE.
    const security = { userId: sid, logonType: 3, runLevel: 0, workingDirectory: homedir() };
    const r = recorder((c) => {
      if (c.file.endsWith("whoami.exe")) return { stdout: `"host\\user","${sid}"\r\n` };
      if (c.file.endsWith("powershell.exe")) return { stdout: `\uFEFF${JSON.stringify(task)}\r\n` };
      return {};
    });
    const service = scheduledTaskService(r.run);
    const plan = service.plan(paths, undefined, posixArgv, () => { throw new Error("a task pins no PATH"); });
    const ps = r.calls.find((c) => c.file.endsWith("powershell.exe"))!;
    const script = Buffer.from(ps.args.at(-1)!, "base64").toString("utf16le");
    check("the SID comes from whoami", r.calls[0]!.file.endsWith("whoami.exe") && r.calls[0]!.args.join(" ") === "/user /fo csv /nh");
    check("the task read takes the name only from its environment", ps.env?.COTAL_DAEMON_TASK === name && !script.includes(name) && ps.args.slice(0, 4).join(" ") === "-NoLogo -NoProfile -NonInteractive -EncodedCommand");
    check("plan names the task and its definition file", plan.unit === name && plan.unitPath === join(state, "service-task.xml") && plan.mechanism === "scheduled-task");
    check("plan states restart and start from the bytes", plan.restart === "every PT1M unless running (IgnoreNew)" && plan.wantedBy === `logon of ${sid}`, plan);
    task = { present: true, ...security, state: "Ready", actions: 1, execute: "x", arguments: "" };
    check("an existing task refuses CONFLICT", code(() => service.plan(paths, undefined, posixArgv, () => "")) === "CONFLICT");
    task = { present: false };

    r.calls.length = 0;
    service.publish(plan);
    // Windows protects the file by ACL, not by mode bits, so only POSIX reads 0600 back.
    check("publish creates the definition with the planned digest", sha(readFileSync(plan.unitPath)) === plan.sha256 && (process.platform === "win32" || (lstatSync(plan.unitPath).mode & 0o777) === 0o600));
    check("an existing definition refuses the next plan", code(() => service.plan(paths, undefined, posixArgv, () => "")) === "CONFLICT");
    service.register(plan);
    const schtasks = (calls: Call[]) => calls.filter((c) => c.file.endsWith("schtasks.exe")).map((c) => c.args.join(" ")).join(" | ");
    check("register runs /Create /XML then /Run", schtasks(r.calls) === `/Create /TN ${name} /XML ${plan.unitPath} | /Run /TN ${name}`, r.calls);

    const receipt: UnitReceipt = { v: 1, mechanism: "scheduled-task", unit: name, unitPath: plan.unitPath, unitSha256: plan.sha256, installedAt: "t" };
    const text = readFileSync(plan.unitPath).subarray(2).toString("utf16le");
    const recorded = { execute: /<Command>([^<]*)</.exec(text)![1], arguments: /<Arguments>([^<]*)</.exec(text)![1] };
    task = { present: true, ...security, state: "Running", actions: 1, ...recorded };
    check("check passes the task that runs the recorded command", code(() => service.check(receipt)) === "none");
    r.calls.length = 0;
    check("a receipt naming another task refuses CONFLICT", code(() => service.remove({ ...receipt, unit: "OneDrive Standalone Update Task" })) === "CONFLICT");
    check("a receipt naming another user's task refuses CONFLICT", code(() => service.remove({ ...receipt, unit: "cotal-daemon-S-1-5-21-9-9-9-1002" })) === "CONFLICT");
    check("and neither reached schtasks nor removed the definition", schtasks(r.calls) === "" && lstatSync(plan.unitPath).isFile());
    task = { present: true, ...security, state: "Running", actions: 1, execute: "C:\\other.exe", arguments: recorded.arguments };
    check("a task whose command changed refuses CONFLICT", code(() => service.check(receipt)) === "CONFLICT");
    task = { present: true, ...security, state: "Running", actions: 2, ...recorded };
    check("a task with a second action refuses CONFLICT", code(() => service.check(receipt)) === "CONFLICT");
    for (const changed of [{ userId: "S-1-5-18" }, { logonType: 5 }, { runLevel: 1 }, { workingDirectory: "C:\\foreign" }]) {
      task = { present: true, ...security, state: "Running", actions: 1, ...recorded, ...changed };
      check("changed task principal or working context refuses CONFLICT", code(() => service.check(receipt)) === "CONFLICT");
    }
    task = { present: true, ...security, state: "Running", actions: 1, ...recorded };
    r.calls.length = 0;
    service.start(receipt);
    check("starting a running task does not restart it", schtasks(r.calls) === "");
    r.calls.length = 0;
    service.restart(receipt);
    check("restarting a running owned task ends then runs only that task", schtasks(r.calls) === `/End /TN ${name} | /Run /TN ${name}`, r.calls);
    task = { present: true, ...security, state: "Ready", actions: 1, ...recorded };
    r.calls.length = 0;
    service.restart(receipt);
    check("restarting an inactive owned task runs without ending it", schtasks(r.calls) === `/Run /TN ${name}`, r.calls);
    task = { present: true, ...security, state: "Running", actions: 1, ...recorded, userId: "S-1-5-18" };
    r.calls.length = 0;
    check("restarting a task with changed ownership refuses CONFLICT", code(() => service.restart(receipt)) === "CONFLICT");
    check("refused restart sends no schtasks mutation and preserves the definition", schtasks(r.calls) === "" && sha(readFileSync(plan.unitPath)) === receipt.unitSha256, r.calls);
    task = { present: false };
    r.calls.length = 0;
    check("restarting an absent task refuses TARGET_NOT_FOUND", code(() => service.restart(receipt)) === "TARGET_NOT_FOUND");
    check("absent restart neither creates nor runs a task", schtasks(r.calls) === "" && sha(readFileSync(plan.unitPath)) === receipt.unitSha256, r.calls);
    task = { present: true, ...security, state: "Ready", actions: 1, ...recorded };
    r.calls.length = 0;
    service.start(receipt);
    check("starting an inactive owned task submits one Run", schtasks(r.calls) === `/Run /TN ${name}`);

    check("a different recorded digest refuses CONFLICT", code(() => service.check({ ...receipt, unitSha256: "0".repeat(64) })) === "CONFLICT");

    const copy = readFileSync(plan.unitPath);
    task = { present: true, ...security, state: "Running", actions: 1, ...recorded };
    r.calls.length = 0;
    service.remove(receipt);
    check("remove disables, ends the running task, then deletes it", schtasks(r.calls) === `/Change /TN ${name} /DISABLE | /End /TN ${name} | /Delete /TN ${name} /F`, r.calls);
    check("and removes the definition", (() => { try { lstatSync(plan.unitPath); return false; } catch { return true; } })());
    writeFileSync(plan.unitPath, copy, { mode: 0o600 });
    task = { present: true, ...security, state: "Ready", actions: 1, ...recorded };
    r.calls.length = 0;
    service.remove(receipt);
    check("a task that is not running is not ended", schtasks(r.calls) === `/Change /TN ${name} /DISABLE | /Delete /TN ${name} /F`, r.calls);
    writeFileSync(plan.unitPath, copy, { mode: 0o600 });
    task = { present: false };
    r.calls.length = 0;
    service.remove(receipt);
    check("an absent task needs no schtasks call", schtasks(r.calls) === "");
  }

  console.log("N5 receipt dispatch on this OS");
  if (process.platform === "linux") {
    const state = join(root, "linux-state");
    mkdirSync(state, { mode: 0o700 });
    const paths: DaemonPaths = { dir: join(root, "lrun"), socket: join(root, "lrun", "s"), state, lock: join(state, "daemon.lock") };
    const receiptFile = join(state, "service-unit.json");
    writeFileSync(receiptFile, JSON.stringify({ v: 1, unit: "cotal-daemon.service", unitPath: join(state, "gone.service"), unitSha256: "0".repeat(64), installedAt: "t" }));
    check("a receipt without a mechanism is a systemd unit", code(() => planUninstall(paths, undefined)) === "TARGET_NOT_FOUND");
    writeFileSync(receiptFile, JSON.stringify({ v: 1, mechanism: "launchd-agent", unit: "ai.cotal.daemon", unitPath: receiptFile, unitSha256: "0".repeat(64), installedAt: "t" }));
    check("a LaunchAgent receipt refuses CONFLICT on Linux", code(() => planUninstall(paths, undefined)) === "CONFLICT");
    check("and the receipt is kept", lstatSync(receiptFile).isFile());
  } else console.log(`  ○ UNTESTED N5: the dispatch cells read a Linux receipt; this is ${process.platform}`);

  console.log("N6 Linux receipt binding through the built CLI and real files");
  if (process.platform === "linux") {
    const cli = fileURLToPath(new URL("../dist/cotal.js", import.meta.url));
    const tool = readFileSync(new URL("fixtures/daemon-systemd-tool.mjs", import.meta.url), "utf8");
    const runtime = join(root, "rt"); mkdirSync(runtime, { mode: 0o700 });
    for (const kind of ["default", "managed", "outside-path", "wrong-unit", "copied-home"]) {
      const dir = join(root, kind); mkdirSync(dir, { mode: 0o700 });
      for (const name of ["home", "cotal", "a", "b", "config", "native"]) mkdirSync(join(dir, name), { mode: 0o700 });
      const a = join(dir, "a"), b = join(dir, "b");
      const context = { home: join(dir, "home"), config: join(dir, "config"), calls: join(dir, "calls.jsonl"), units: ["cotal-daemon.service", `cotal-daemon-${sha(a).slice(0, 16)}.service`, `cotal-daemon-${sha(b).slice(0, 16)}.service`] };
      const configFile = join(dir, "context.json"); writeFileSync(configFile, JSON.stringify(context), { mode: 0o600 });
      for (const name of ["systemctl", "loginctl"]) writeFileSync(join(dir, "native", name), `#!${process.execPath}\n${tool}`, { mode: 0o700 });
      const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("COTAL_") && !["NODE_OPTIONS", "NODE_PATH"].includes(key)));
      Object.assign(env, { USER: "smoke", LOGNAME: "smoke", HOME: context.home, COTAL_HOME: join(dir, "cotal"), XDG_CONFIG_HOME: context.config, XDG_RUNTIME_DIR: runtime, XDG_CACHE_HOME: join(dir, "cache"), XDG_STATE_HOME: join(dir, "state"), XDG_DATA_HOME: join(dir, "data"), PATH: `${join(dir, "native")}:/usr/local/bin:/usr/bin:/bin`, DAEMON_UNIT_FIXTURE: configFile, DO_NOT_TRACK: "1", NO_COLOR: "1" });
      const call = (verb: string, home: string | undefined, flags: string[] = []) => {
        const child = spawnSync(process.execPath, [cli, "daemon", verb, ...(home ? ["--daemon-home", home] : []), ...flags, "--json"], { cwd: dir, env, encoding: "utf8", timeout: 30_000, maxBuffer: 256 * 1024 });
        if (child.error || child.signal) throw new Error(`N6 ${verb} did not exit normally`);
        const doc = JSON.parse(child.stdout) as { outcome: string; error?: { code: string } };
        return { status: child.status, doc };
      };
      const effects = (): number => existsSync(context.calls) ? readFileSync(context.calls, "utf8").trim().split("\n").map((line) => JSON.parse(line) as { operation: string }).filter((c) => !["directory-read", "linger-read"].includes(c.operation)).length : 0;
      const home = kind === "default" ? undefined : a;
      const receiptFile = join(home ?? join(dir, "cotal", "daemon"), "service-unit.json");
      const installed = call("install", home);
      if (installed.status !== 0) throw new Error(`N6 ${kind} install fixture refused ${JSON.stringify(installed.doc)}`);
      const receipt = JSON.parse(readFileSync(receiptFile, "utf8")) as UnitReceipt;
      if (kind === "default" || kind === "managed") {
        check(`N6 valid ${kind} receipt plans and starts`, call("uninstall", home, ["--dry-run"]).status === 0 && call("start", home).status === 0);
        const removed = call("uninstall", home, ["--yes"]);
        check(`N6 valid ${kind} receipt removes its source and receipt`, removed.status === 0 && !existsSync(receipt.unitPath) && !existsSync(receiptFile));
        continue;
      }
      let selected = home, changed = { ...receipt };
      let unrelated: string | undefined;
      if (kind === "outside-path") {
        unrelated = join(context.home, "unrelated.txt");
        writeFileSync(unrelated, readFileSync(receipt.unitPath), { mode: 0o600 });
        changed = { ...receipt, unitPath: unrelated };
      } else if (kind === "wrong-unit") changed = { ...receipt, unit: context.units[2]! };
      else selected = b;
      const selectedReceipt = join(selected!, "service-unit.json");
      writeFileSync(selectedReceipt, JSON.stringify(changed), { mode: 0o600 });
      const before = effects();
      const results = [call("uninstall", selected, ["--dry-run"]), call("start", selected), call("uninstall", selected, ["--yes"])];
      check(`N6 ${kind} refuses plan, start and uninstall`, results.every((r) => r.status === 2 && r.doc.error?.code === "CONFLICT"));
      check(`N6 ${kind} submits no service action`, effects() === before);
      check(`N6 ${kind} keeps source, receipt and unrelated file`, existsSync(receipt.unitPath) && existsSync(selectedReceipt) && (unrelated === undefined || existsSync(unrelated)));
    }
  } else console.log(`  ○ UNTESTED N6: Linux CLI receipt binding; this is ${process.platform}`);
} finally {
  if (savedHome === undefined) delete process.env.HOME; else process.env.HOME = savedHome;
  rmSync(root, { recursive: true, force: true });
}

/** CommandLineToArgvW's rules for the argument tail: whitespace splits, a quote toggles, and 2n
 *  backslashes before a quote are n backslashes, 2n+1 are n and a literal quote. */
function splitWindows(line: string): string[] {
  const out: string[] = [];
  let current = "", quoted = false, started = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (ch === "\\") {
      let n = 0;
      while (line[i] === "\\") { n++; i++; }
      if (line[i] === '"') { current += "\\".repeat(Math.floor(n / 2)); if (n % 2) current += '"'; else quoted = !quoted; }
      else { current += "\\".repeat(n); i--; }
      started = true;
    } else if (ch === '"') { quoted = !quoted; started = true; }
    else if ((ch === " " || ch === "\t") && !quoted) { if (started) out.push(current); current = ""; started = false; }
    else { current += ch; started = true; }
  }
  if (started) out.push(current);
  return out;
}

console.log(`\ndaemon-install-native smoke: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
