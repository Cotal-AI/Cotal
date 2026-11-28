/**
 * `cotal daemon install` and `cotal daemon uninstall`: the machine daemon as the signed-in user's own
 * native service. Linux uses a systemd user service (below), macOS a LaunchAgent in the user's GUI
 * domain (`install-darwin.ts`), and Windows a scheduled task that starts at the user's logon
 * (`install-win32.ts`). Each runs the daemon as the user who installed it, which is the desktop
 * profile. A system-scoped headless profile (a system unit, a LaunchDaemon or a Windows service under
 * a service account) is not offered here, and nothing here runs as root or LocalSystem.
 *
 * Every mechanism keeps the same ownership rule. `install` publishes its source at an absent name
 * and records its exact digest in a receipt before any registration, and `uninstall` acts only on
 * the receipt's unchanged source and the job registered from it. A name alone is never a claim.
 *
 * On Linux it starts at login, restarts on its own when it dies, and keeps running after the
 * operator logs out, which on a headless box is what linger provides. The unit is written to the
 * user manager's own configuration directory and registered through the same bounded
 * `systemctl --user` steps the rest of this CLI uses for its owned units; nothing here is a second
 * supervision mechanism.
 *
 * Why not `cotal service install`. That route supervises a saved service *definition* in one
 * *space*, through an instance record, a revision-pinned supervisor receipt and a per-instance
 * private extension store. The machine daemon is none of those: it is one per-user singleton that
 * runs before any space is chosen, and its sign-in and registration are its own state, not a
 * space's. So this reuses that route's unit rendering, publication and registration primitives and
 * leaves its definition/instance apparatus alone.
 *
 * Linger is required, not worked around. Without it the user manager stops at logout and takes the
 * daemon with it, which is the opposite of a persistent service, so `install` enables it and
 * reports it as a change. A refusal to enable it fails the install; there is no degraded install
 * that quietly dies at logout. `uninstall` does not disable it again, because other user services
 * may rely on it.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { accessSync, closeSync, constants, existsSync, lstatSync, mkdirSync, openSync, readFileSync, rmSync, statSync } from "node:fs";
import { delimiter, dirname, isAbsolute, join, posix } from "node:path";
import { homedir } from "node:os";
import { recordedSourceIdentity, recordedSourceMarked } from "./install-identity.js";
import { nativeRun } from "./install-native-run.js";
import { checkWindowsRecordedUnit } from "./ownership-win32.js";
import { Worker } from "node:worker_threads";
import { setTimeout as delay } from "node:timers/promises";
import { randomUUID } from "node:crypto";
import { acquireLock, acquireLockAsync, inspectLock, mkSecretDir, processStartToken, writeSecretFile, writeSecretFileAtomic } from "@cotal-ai/core";
import { codeSpan, CommandFailure, executionIdentity, readLocalRecordSource } from "@cotal-ai/workspace";
import { assertSystemdSource, assertSystemdSourceDirectory, createSystemdSource, daemonArgv, submitSystemdUnitControl, submitSystemdUnitRegistration, systemdUserUnitDirectory } from "@cotal-ai/cli";
import { checkDir, daemonUserServiceEnv, EndpointRefusal, DAEMON_PROTOCOL_VERSION, type DaemonPaths } from "./endpoint.js";
import { ClosedPeerRefusal, isStoppingLifetime, openVerified, queryDaemon, readLine } from "./client.js";
import { excludeLifetime, processBirth, readLifetimeRecord, type DaemonPeerLifetime } from "./lifetime.js";
import { darwinLaunchdJob, lockExclusiveNb, windowsUserSid } from "@cotal-ai/seat";
import { encode, type DaemonResponse } from "./protocol.js";
import { launchAgentService, missingLaunchAgentProgram, renderLaunchAgent, xmlText } from "./install-darwin.js";
import { finishRecordedOomPolicyIntent, missingSystemdProgram, observeSystemdRepairUnit, reconcileInstalledSystemdOomPolicy as reconcileSystemdOomPolicy } from "./install-linux-repair.js";
import { scheduledTaskName, scheduledTaskService } from "./install-win32.js";
import { daemonCommandCopy, windowsDaemonFirstStart } from "./guidance.js";
import { recoverPausedTask } from "./restart-recovery.js";
import { assertDesktopSetupComplete } from "./desktop-setup.js";
import { serviceApplicationPath } from "./desktop-path.js";
import { removeAllServiceRecords } from "./service-records.js";
import { assertServiceRepairPair, readServiceRepair, repairReplies, repairReplyResult, servicePolicyRepairFile, serviceRepairFile, sourceDigest } from "./service-repair.js";
import { claimSuspendableServiceRepairLock, DAEMON_SYSTEMD_START_TIMEOUT_SEC, startSystemdDaemonUnit } from "./startup-recovery.js";

/** The native supervisor that runs the daemon: one per desktop OS. */
export type ServiceMechanism = "systemd-user" | "launchd-agent" | "scheduled-task";

/** What `install` wrote, so `uninstall` acts on that exact unit and never on a name. */
export interface UnitReceipt {
  readonly v: 1;
  /** Absent in a receipt written before macOS and Windows support, which was always systemd. */
  readonly mechanism?: ServiceMechanism;
  /** The systemd unit, the LaunchAgent label or the scheduled task name. */
  readonly unit: string;
  /** The unit file, the LaunchAgent plist, or the task definition this install registered. */
  readonly unitPath: string;
  readonly unitSha256: string;
  readonly installedAt: string;
  readonly daemonHome?: string;
  readonly omittedRelativePathEntries?: readonly string[];
}

import { readReceipt, unitReceiptFile } from "./install-receipt.js";
export { unitReceiptFile } from "./install-receipt.js";

/** `cotal-daemon.service`, or `cotal-daemon-<16 hex>.service` for an explicit daemon home, derived
 *  the same way its socket directory is so the two always agree. */
function daemonUnitName(daemonHome: string | undefined): string {
  if (daemonHome === undefined) return "cotal-daemon.service";
  return `cotal-daemon-${createHash("sha256").update(daemonHome).digest("hex").slice(0, 16)}.service`;
}

function writeReceipt(paths: DaemonPaths, receipt: UnitReceipt): void {
  writeSecretFile(unitReceiptFile(paths), `${JSON.stringify(receipt)}\n`);
}

/** systemd unquotes a whole item, then expands specifiers and `ExecStart` variables. */
function unitValue(value: string, exec = false): string {
  if (!value || value.length > 4096 || /[\u0000-\u001f\u007f]/u.test(value)) throw new CommandFailure("refused", "USAGE_INVALID", "the daemon unit needs bounded arguments without terminal controls; no unit bytes were prepared");
  const escaped = value.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("%", "%%");
  return `"${exec ? escaped.replaceAll("$", "$$") : escaped}"`;
}

/** The invocation's own `PATH`, pinned absolute. A relative or empty entry would resolve against
 *  whichever directory the unit happens to start in, so it refuses instead. */
export function pinnedPath(value = process.env.PATH ?? "", grammar: Pick<typeof posix, "delimiter" | "isAbsolute"> = { delimiter, isAbsolute }): string {
  const entries = value.split(grammar.delimiter).filter((entry) => entry !== "");
  if (!entries.length || entries.some((entry) => !grammar.isAbsolute(entry))) throw new CommandFailure("refused", "UNSUPPORTED", "the daemon unit needs an absolute, pinned PATH; a relative or empty entry was not inherited");
  return entries.join(grammar.delimiter);
}

interface RenderedUnit {
  readonly unit: string;
  readonly unitPath: string;
  readonly bytes: string;
  readonly sha256: string;
}

/**
 * The unit this install writes. `Restart=always` is the one place it departs from the per-space
 * owned unit, and it is the point of the exercise: a daemon that dies must come back. The daemon
 * recovers its own stale socket under its lifetime lock, so a restart needs no cleanup between
 * attempts. `WantedBy=default.target` is what starts it at login, and linger is what keeps that
 * target up after the operator logs out.
 */
export function renderDaemonUnit(unitDirectory: string, daemonHome: string | undefined): RenderedUnit {
  const argv = daemonServeArgv(daemonHome);
  if (argv[0]!.includes("$")) throw new CommandFailure("refused", "UNSUPPORTED", "the native executable path contains a systemd variable marker; the installer did not guess its expansion");
  const unit = daemonUnitName(daemonHome);
  const bytes = [
    "[Unit]",
    "Description=Cotal machine daemon",
    "",
    "[Service]",
    "Type=notify",
    "NotifyAccess=all",
    `TimeoutStartSec=${DAEMON_SYSTEMD_START_TIMEOUT_SEC}`,
    `Environment=PATH=${unitValue(serviceApplicationPath())}`,
    "Environment=COTAL_DAEMON_NATIVE_SERVICE=1",
    `ExecStart=${argv.map((part) => unitValue(part, true)).join(" ")}`,
    "Restart=always",
    "RestartSec=2",
    "TimeoutStopSec=90",
    "KillMode=mixed",
    "OOMPolicy=continue",
    "",
    "[Install]",
    "WantedBy=default.target",
    "",
  ].join("\n");
  if (Buffer.byteLength(bytes) > 64 * 1024) throw new CommandFailure("refused", "USAGE_INVALID", "the daemon unit exceeds its bounded source size");
  return { unit, unitPath: join(unitDirectory, unit), bytes, sha256: createHash("sha256").update(bytes).digest("hex") };
}

/** The command every mechanism runs: `daemonArgv()` (the durable Node binary, the daemon heap flags
 *  and this CLI's own entry), then `daemon serve` and the explicit daemon home. */
export function daemonServeArgv(daemonHome: string | undefined): string[] {
  const cli = daemonArgv();
  const entry = cli.at(-1);
  if (cli.length < 2 || entry === undefined) throw new CommandFailure("refused", "UNSUPPORTED", "the daemon unit needs this CLI's durable Node and entry paths; a transient loader was not pinned");
  if (!isAbsolute(cli[0]!) || !isAbsolute(entry)) throw new CommandFailure("refused", "UNSUPPORTED", "the daemon unit needs absolute Node and entry paths");
  if (!cli.slice(1, -1).every((flag) => /^--[A-Za-z][A-Za-z0-9-]*(?:=[^\s"]*)?$/.test(flag))) throw new CommandFailure("refused", "UNSUPPORTED", "the daemon unit pins only Node flags between its executable and its entry");
  if (process.platform === "win32" && existsSync(join(dirname(dirname(entry)), "desktop-runtime.json"))) {
    const launcher = join(dirname(cli[0]!), "cotal-desktop.exe");
    if (!existsSync(launcher)) throw new CommandFailure("refused", "UNSUPPORTED", "the packaged desktop daemon launcher is missing; no console-program task was substituted");
    assertScheduledEntry(join(dirname(entry), "cotal.js"));
    assertScheduledEntry(join(dirname(entry), "daemon-native.js"));
    return [launcher, "--daemon", ...(daemonHome !== undefined ? ["--daemon-home", daemonHome] : [])];
  }
  if (process.platform === "win32") {
    assertScheduledEntry(join(dirname(entry), "daemon-native.js"));
  }
  return [...cli, "daemon", "serve", ...(daemonHome !== undefined ? ["--daemon-home", daemonHome] : [])];
}

/** Refuse a broken installed launch before publishing or registering a Windows task. */
export function assertScheduledEntry(entry: string): void {
  let file = false;
  try { file = lstatSync(entry).isFile(); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  if (!file) throw new CommandFailure("refused", "DEPENDENCY_UNAVAILABLE",
    `the scheduled task entry is missing or is not a file: ${entry}; no task was prepared`,
    { remedy: "repair or reinstall this Cotal installation before running \`cotal daemon install\` again" });
}

/** One native tool call's outcome. `detail` is a bounded single line of its output for a refusal. */
export interface NativeResult {
  readonly status: number | null;
  readonly stdout: string;
  readonly detail: string;
}

/** Runs one native tool by absolute path with an argument vector, never through a shell. */
export type NativeRun = (file: string, args: readonly string[], env?: NodeJS.ProcessEnv, timeoutMs?: number) => NativeResult;

/** What a macOS or Windows install would write and register, with no effect yet. */
export interface NativePlan {
  readonly mechanism: Exclude<ServiceMechanism, "systemd-user">;
  readonly unit: string;
  readonly unitPath: string;
  readonly bytes: Buffer;
  readonly sha256: string;
  readonly user: string;
  readonly restart: string;
  readonly wantedBy: string;
}

/**
 * One native per-user supervisor. `plan` reads and refuses but changes nothing; `publish` creates
 * the source at its absent name and verifies its digest; `register` hands it to the OS and starts
 * it. `check` refuses unless the receipt's source is unchanged and the job registered under its
 * name is the one it describes, and `remove` stops and deregisters that job and deletes the source.
 */
export interface NativeService {
  readonly mechanism: Exclude<ServiceMechanism, "systemd-user">;
  plan(paths: DaemonPaths, daemonHome: string | undefined, argv: readonly string[], searchPath: () => string): NativePlan;
  publish(plan: NativePlan): void;
  register(plan: NativePlan): void;
  check(receipt: UnitReceipt): void;
  stopped(receipt: UnitReceipt): boolean;
  isEnabled?(receipt: UnitReceipt): boolean;
  start(receipt: UnitReceipt): void;
  restart(receipt: UnitReceipt, reload?: boolean): void;
  remove(receipt: UnitReceipt, preserveSource?: boolean): void;
}

/** This OS's per-user supervisor, or `undefined` on Linux, whose systemd route is below. */
function nativeService(run: NativeRun = nativeRun): NativeService | undefined {
  if (process.platform === "linux") return undefined;
  if (process.platform === "darwin") return launchAgentService(run);
  if (process.platform === "win32") return scheduledTaskService(run);
  throw new CommandFailure("refused", "UNSUPPORTED", `cotal daemon install supports Linux, macOS and Windows; this is ${process.platform}, and no other supervisor was substituted`);
}

/** One bounded `loginctl` read or mutation for the invoking user. */
function loginctl(args: readonly string[]): { status: number | null; stdout: string } {
  const result = spawnSync("loginctl", [...args, "--no-ask-password", "--no-pager"], { encoding: "utf8", timeout: 15_000, maxBuffer: 32 * 1024, stdio: ["ignore", "pipe", "pipe"] });
  if (result.error || result.signal) throw new CommandFailure("refused", "DEPENDENCY_UNAVAILABLE", "loginctl did not answer; linger could not be established", { remedy: "make loginctl available on PATH and run from a logged-in session where it can reach systemd-logind, then retry" });
  return { status: result.status, stdout: typeof result.stdout === "string" ? result.stdout : "" };
}

function lingerEnabled(user: string): boolean {
  return readLinger(user) === true;
}

function readLinger(user: string): boolean | undefined {
  const read = loginctl(["show-user", user, "--property=Linger"]);
  if (read.status !== 0) return;
  const state = read.stdout.trim();
  if (state === "Linger=yes" || state === "Linger=no") return state === "Linger=yes";
}

/** The user whose manager this install targets, read from the environment and never from argv. */
function invokingUser(): string {
  const user = process.env.USER || process.env.LOGNAME;
  if (!user || !/^[A-Za-z0-9._][A-Za-z0-9._-]{0,31}$/.test(user)) throw new CommandFailure("refused", "TARGET_UNAVAILABLE", "this session's USER and LOGNAME do not name the user whose systemd manager would run the daemon", { remedy: "run from a logged-in session of the user who will run the daemon (login sets USER and LOGNAME)" });
  return user;
}

function enableLingerCommand(user: string): string {
  return `sudo loginctl enable-linger ${user}`;
}

function enableUnitCommand(unit: string): string {
  return `systemctl --user enable --now ${unit}`;
}

function lingerRepair(user: string, unit: string): string {
  return `Ask an administrator to run ${codeSpan(enableLingerCommand(user))}, then run ${codeSpan(enableUnitCommand(unit))} yourself.`;
}

export function linuxAutostartUnverified(unit: string, user = '"$USER"'): string {
  return `The recorded service's autostart could not be verified. Check it with ${codeSpan(`loginctl show-user ${user} --property=Linger`)} and ${codeSpan(`systemctl --user is-enabled ${unit}`)}.`;
}

/** A receipt records ownership, not autostart. Null means the recorded service could not be checked. */
export function linuxAutostartWarning(paths: DaemonPaths, daemonHome?: string, setupUnit?: string): string | null | undefined {
  if (process.platform !== "linux") return;
  const receipt = readReceipt(paths);
  if (!receipt || (receipt.mechanism !== undefined && receipt.mechanism !== "systemd-user")) return setupUnit === undefined ? undefined : null;
  if (setupUnit !== undefined && receipt.unit !== setupUnit) return null;
  if (!existsSync(receipt.unitPath)) return null;
  try {
    assertLinuxRecordedUnit(paths, daemonHome, receipt);
    const user = invokingUser();
    const linger = readLinger(user);
    if (linger === undefined) return null;
    const result = nativeRun("systemctl", ["--user", "--no-ask-password", "--no-pager", "show", receipt.unit, "--property=UnitFileState", "--value"], daemonUserServiceEnv(), 5000);
    const state = result.status === 0 ? result.stdout.trim() : undefined;
    if (linger && state === "enabled") return;
    if (state === "disabled" || state === "enabled-runtime") {
      return `The service is not enabled at boot and will not start automatically after a restart.${linger ? ` Run ${codeSpan(enableUnitCommand(receipt.unit))}.` : ` Linger is off, so it will not keep running after logout. ${lingerRepair(user, receipt.unit)}`}`;
    }
    if (!linger && state === "enabled") return `Linger is off, so the service will not keep running after logout or start at boot before you log in. Ask an administrator to run ${codeSpan(enableLingerCommand(user))}.`;
  } catch { /* A failed read does not prove autostart and must not change the command's outcome. */ }
  return null;
}

interface InstallPlan {
  readonly mechanism: ServiceMechanism;
  readonly unit: string;
  readonly unitPath: string;
  readonly sha256: string;
  readonly user: string;
  /** systemd only: whether the user's linger was already on. */
  readonly lingerAlready?: boolean;
  /** What the unit does, read back out of the bytes this install would write. */
  readonly restart: string;
  readonly wantedBy: string;
  readonly daemonHome?: string;
  /** The unchanged recorded service already belongs to this installation. */
  readonly alreadyInstalled?: true;
  /** An exact surviving Linux source was verified after its receipt was lost. */
  readonly recovered?: true;
}

/** A directive's value in the bytes that will be written, so a receipt never states a policy the
 *  unit does not carry. A template that stops setting one is reported as absent, not assumed. */
function directive(bytes: string, name: string): string {
  return new RegExp(`\n${name}=(.*)\n`).exec(bytes)?.[1] ?? "absent";
}

function refuseInstalled(paths: DaemonPaths, daemonHome: string | undefined): void {
  assertNoServiceRepair(paths);
  const existing = readReceipt(paths);
  if (existing) throw new CommandFailure("refused", "CONFLICT", `this daemon already has an installed unit (${existing.unit})`, {
    remedy: `remove it with ${codeSpan(daemonCommandCopy("uninstall", daemonHome))} before installing again`,
  });
}

function assertNoServiceRepair(paths: Pick<DaemonPaths, "state">, stopPeer?: DaemonPeerLifetime): boolean {
  if (process.platform !== "darwin" && process.platform !== "linux") return false;
  const held = inspectLock(join(paths.state, "service-repair.lock"));
  const otherOwner = held.state === "active" && held.owner.pid !== process.pid;
  // Darwin's advisory lock uses a different start-token format from the kernel peer lifetime.
  const peerOwnsLock = otherOwner && stopPeer?.pid === held.owner.pid && Boolean(held.owner.start)
    && (process.platform === "linux" ? held.owner.start === stopPeer.birth
      : held.owner.start === processStartToken(stopPeer.pid) && processBirth(stopPeer.pid) === stopPeer.birth);
  if ((otherOwner && !peerOwnsLock) || readServiceRepair(paths.state) || (process.platform === "linux" && readServiceRepair(paths.state, servicePolicyRepairFile(paths.state)))) throw new CommandFailure("refused", "CONFLICT", "the daemon service has an unfinished repair; run `cotal daemon status` to finish it");
  return peerOwnsLock;
}

function nativeInstallPlan(service: NativeService, paths: DaemonPaths, daemonHome: string | undefined): NativePlan {
  refuseInstalled(paths, daemonHome);
  return service.plan(paths, daemonHome, daemonServeArgv(daemonHome), () => serviceApplicationPath());
}

/** Everything `install` would do, with no effect: the unit it would write and, on Linux, the linger it needs. */
export function planInstall(paths: DaemonPaths, daemonHome: string | undefined): InstallPlan {
  const service = nativeService();
  if (service) {
    const { mechanism, unit, unitPath, sha256, user, restart, wantedBy } = nativeInstallPlan(service, paths, daemonHome);
    return { mechanism, unit, unitPath, sha256, user, restart, wantedBy, ...(daemonHome !== undefined ? { daemonHome } : {}) };
  }
  const user = invokingUser();
  const rendered = renderDaemonUnit(systemdUserUnitDirectory(), daemonHome);
  const existing = readReceipt(paths);
  if (existing) {
    const recorded = recordedUnit(paths, daemonHome);
    if (!recordedDaemonIdentity(recorded).same) throw new CommandFailure("refused", "CONFLICT", "the recorded daemon service belongs to another Cotal installation or pins a different Node runtime; nothing was changed", {
      remedy: `to replace the recorded service with this installation, run ${codeSpan(daemonCommandCopy("uninstall", daemonHome, ["--yes"]) + " && " + daemonCommandCopy("install", daemonHome))}`,
    });
    const source = readFileSync(existing.unitPath, "utf8");
    return { mechanism: "systemd-user", unit: existing.unit, unitPath: existing.unitPath, sha256: existing.unitSha256, user, lingerAlready: lingerEnabled(user), restart: directive(source, "Restart"), wantedBy: directive(source, "WantedBy"), ...(daemonHome !== undefined ? { daemonHome } : {}), alreadyInstalled: true };
  }
  let present = false;
  try { lstatSync(rendered.unitPath); present = true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new CommandFailure("refused", "TARGET_UNAVAILABLE", `${rendered.unitPath} could not be inspected; no absent unit was inferred`); }
  if (present) {
    const recovered = recoveredLinuxUnit(daemonHome);
    if (!recovered) throw new CommandFailure("refused", "CONFLICT", "the surviving daemon source changed while planning recovery; nothing was changed");
    return { mechanism: "systemd-user", unit: recovered.unit, unitPath: recovered.unitPath, sha256: recovered.unitSha256, user, lingerAlready: lingerEnabled(user), restart: directive(rendered.bytes, "Restart"), wantedBy: directive(rendered.bytes, "WantedBy"), ...(daemonHome !== undefined ? { daemonHome } : {}), recovered: true };
  }
  assertSystemdSourceDirectory(dirname(rendered.unitPath));
  return { mechanism: "systemd-user", unit: rendered.unit, unitPath: rendered.unitPath, sha256: rendered.sha256, user, lingerAlready: lingerEnabled(user),
    restart: directive(rendered.bytes, "Restart"), wantedBy: directive(rendered.bytes, "WantedBy"), ...(daemonHome !== undefined ? { daemonHome } : {}) };
}

interface InstallResult extends InstallPlan {
  /** systemd only: linger is on once the install returns. */
  readonly lingerEnabled?: boolean;
  readonly omittedRelativePathEntries?: readonly string[];
  readonly state: "installed";
}

/**
 * Write the unit, enable linger and autostart, and start it now.
 *
 * The order is what makes a half-done install recoverable. Every directory this needs exists before
 * the first system change, and the receipt is written as soon as the unit file is published, which
 * is the first change the operator would have to undo. So a failure anywhere after that still
 * leaves a unit `uninstall` can find and remove, never an enabled unit nothing records.
 */
export function applyInstall(paths: DaemonPaths, daemonHome: string | undefined, omittedRelativePathEntries?: readonly string[]): InstallResult {
  if (process.platform !== "darwin" && process.platform !== "linux") return applyInstallUnlocked(paths, daemonHome, omittedRelativePathEntries);
  // First-time Linux setup must confirm the service manager before creating daemon state.
  if (process.platform === "linux" && !existsSync(paths.state)) planInstall(paths, daemonHome);
  mkSecretDir(paths.state);
  const lock = acquireLock(join(paths.state, "service-repair.lock"));
  try { return applyInstallUnlocked(paths, daemonHome, omittedRelativePathEntries); }
  finally { lock.release(); }
}

function applyInstallUnlocked(paths: DaemonPaths, daemonHome: string | undefined, omittedRelativePathEntries?: readonly string[]): InstallResult {
  const omitted = omittedRelativePathEntries?.length ? { omittedRelativePathEntries } : {};
  const service = nativeService();
  if (service) {
    const plan = nativeInstallPlan(service, paths, daemonHome);
    mkSecretDir(paths.state);
    service.publish(plan);
    writeReceipt(paths, { v: 1, mechanism: plan.mechanism, unit: plan.unit, unitPath: plan.unitPath, unitSha256: plan.sha256, installedAt: new Date().toISOString(), ...(daemonHome !== undefined ? { daemonHome } : {}), ...omitted });
    service.register(plan);
    const { mechanism, unit, unitPath, sha256, user, restart, wantedBy } = plan;
    return { mechanism, unit, unitPath, sha256, user, restart, wantedBy, ...(daemonHome !== undefined ? { daemonHome } : {}), ...omitted, state: "installed" };
  }
  const plan = planInstall(paths, daemonHome);
  if (plan.alreadyInstalled) return { ...plan, lingerEnabled: plan.lingerAlready, ...omitted, state: "installed" };
  if (plan.recovered) {
    submitSystemdUnitControl("stop", plan.unit);
    const stopped = recoveredLinuxUnit(daemonHome);
    if (!stopped || stopped.unitSha256 !== plan.sha256) throw new CommandFailure("refused", "CONFLICT", "the surviving daemon source changed during its native stop; no receipt was restored and it was not started");
    mkSecretDir(paths.state);
    writeReceipt(paths, { v: 1, mechanism: "systemd-user", unit: plan.unit, unitPath: plan.unitPath, unitSha256: plan.sha256, installedAt: new Date().toISOString(), ...(daemonHome !== undefined ? { daemonHome } : {}), ...omitted });
    submitSystemdUnitControl("start", plan.unit);
    return { ...plan, lingerEnabled: plan.lingerAlready, ...omitted, state: "installed" };
  }
  const rendered = renderDaemonUnit(dirname(plan.unitPath), daemonHome);
  // This daemon's own state directory, which holds the receipt below. It is ours, so it is created
  // 0700 and checked; the user manager's unit directory is the operator's and is only created when
  // it is absent, never hardened or repaired when it is already there.
  mkSecretDir(paths.state);
  const unitDir = join(rendered.unitPath, "..");
  mkdirSync(unitDir, { recursive: true, mode: 0o700 });
  createSystemdSource(rendered.unitPath, rendered.bytes, rendered.sha256);
  writeReceipt(paths, { v: 1, mechanism: "systemd-user", unit: rendered.unit, unitPath: rendered.unitPath, unitSha256: rendered.sha256, installedAt: new Date().toISOString(), ...(daemonHome !== undefined ? { daemonHome } : {}), ...omitted });
  if (!plan.lingerAlready) {
    const enabled = loginctl(["enable-linger", plan.user]);
    const linger = enabled.status === 0 ? readLinger(plan.user) : false;
    if (!linger) throw new CommandFailure("refused", "PERMISSION_DENIED", `linger could not be ${linger === undefined ? "verified" : "enabled"} for ${plan.user}, so the recorded unit was not enabled or started`, {
      remedy: linger === undefined ? linuxAutostartUnverified(plan.unit, plan.user) : lingerRepair(plan.user, plan.unit),
    });
  }
  assertSystemdSource(rendered.unitPath, rendered.sha256);
  submitSystemdUnitRegistration("reload", rendered.unit);
  submitSystemdUnitRegistration("enable", rendered.unit);
  submitSystemdUnitControl("start", rendered.unit);
  return { ...plan, lingerEnabled: true, ...omitted, state: "installed" };
}

interface UninstallPlan {
  readonly mechanism: ServiceMechanism;
  readonly unit: string;
  readonly unitPath: string;
  readonly installedAt: string;
}

export interface DaemonStartPlan extends UninstallPlan {
  /** Non-enumerable version pin when startup update-recovery restored the previous CLI. */
  readonly recoveredVersion?: string;
}

function withRecoveredVersion(plan: UninstallPlan, recoveredVersion: string | undefined): DaemonStartPlan {
  if (!recoveredVersion) return plan;
  return Object.defineProperty({ ...plan }, "recoveredVersion", {
    value: recoveredVersion,
    enumerable: false,
    configurable: true,
  });
}

function recoveredLinuxUnit(daemonHome: string | undefined): UnitReceipt | undefined {
  if (process.platform !== "linux") return undefined;
  const unitDirectory = systemdUserUnitDirectory();
  try { lstatSync(join(unitDirectory, daemonUnitName(daemonHome))); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
  // A name is not authority. Require this installation's exact protected source and loaded fragment.
  const rendered = renderDaemonUnit(unitDirectory, daemonHome);
  try { assertSystemdSource(rendered.unitPath, rendered.sha256); }
  catch { throw new CommandFailure("refused", "CONFLICT", "the surviving daemon source does not match this installation's protected unit; nothing was changed"); }
  const names = ["Id", "LoadState", "FragmentPath", "DropInPaths", "NeedDaemonReload"];
  const read = nativeRun("systemctl", ["--user", "show", rendered.unit, "--all", "--no-pager", ...names.map(name => `--property=${name}`)]);
  const values = new Map<string, string>();
  for (const line of read.stdout.split("\n").filter(Boolean)) {
    const at = line.indexOf("="), key = line.slice(0, at);
    if (at < 1 || !names.includes(key) || values.has(key)) throw new CommandFailure("refused", "CONFLICT", "the surviving daemon unit's native identity is ambiguous; nothing was changed");
    values.set(key, line.slice(at + 1));
  }
  if (read.status !== 0 || values.size !== names.length || values.get("Id") !== rendered.unit || values.get("LoadState") !== "loaded" || values.get("FragmentPath") !== rendered.unitPath || values.get("DropInPaths") !== "" || values.get("NeedDaemonReload") !== "no")
    throw new CommandFailure("refused", "CONFLICT", "the surviving daemon unit is modified, overridden or not loaded from this installation's exact source; nothing was changed");
  return { v: 1, mechanism: "systemd-user", unit: rendered.unit, unitPath: rendered.unitPath, unitSha256: rendered.sha256, installedAt: lstatSync(rendered.unitPath).birthtime.toISOString(), ...(daemonHome !== undefined ? { daemonHome } : {}) };
}

/** The recorded unit, refused unless this OS runs its mechanism and its source and job are unchanged. */
function recordedUnit(paths: Pick<DaemonPaths, "state">, daemonHome: string | undefined, run: NativeRun = nativeRun, recover = false, repairing = false, missingReceipt?: () => CommandFailure): { receipt: UnitReceipt; plan: UninstallPlan; service: NativeService | undefined; recovered?: boolean } {
  if (!repairing) assertNoServiceRepair(paths);
  const service = nativeService(run);
  const saved = readReceipt(paths);
  const receipt = saved ?? (recover ? recoveredLinuxUnit(daemonHome) : undefined);
  if (!receipt) throw missingReceipt?.() ?? new CommandFailure("refused", "TARGET_NOT_FOUND", "this daemon has no installed unit recorded by `cotal daemon install`; nothing was removed");
  const mechanism = receipt.mechanism ?? "systemd-user";
  if (mechanism !== (service ? service.mechanism : "systemd-user")) throw new CommandFailure("refused", "CONFLICT", `the recorded unit ${receipt.unit} is a ${mechanism} unit, which this OS does not run; nothing was removed`);
  if (process.platform === "win32") {
    checkWindowsRecordedUnit(paths, receipt, service!);
    return { receipt, plan: { mechanism, unit: receipt.unit, unitPath: receipt.unitPath, installedAt: receipt.installedAt }, service };
  }
  try { lstatSync(receipt.unitPath); }
  catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") throw new CommandFailure("refused", "TARGET_NOT_FOUND", `the recorded unit file ${receipt.unitPath} is gone; nothing was removed. Delete ${unitReceiptFile(paths)} by hand to forget it`);
    const denied = code === "EACCES" || code === "EPERM";
    throw new CommandFailure("refused", denied ? "PERMISSION_DENIED" : "TARGET_UNAVAILABLE", "the recorded unit file could not be inspected; nothing was changed", {
      remedy: denied ? "keep the install receipt, restore access to the unit file's directory and retry" : "keep the install receipt, check the unit file's path and retry",
    });
  }
  if (service) service.check(receipt);
  else assertLinuxRecordedUnit(paths, daemonHome, receipt);
  return { receipt, plan: { mechanism, unit: receipt.unit, unitPath: receipt.unitPath, installedAt: receipt.installedAt }, service, recovered: saved === undefined };
}

function assertLinuxRecordedUnit(paths: Pick<DaemonPaths, "state">, daemonHome: string | undefined, receipt: UnitReceipt): void {
  const unit = daemonUnitName(daemonHome);
  if (receipt.daemonHome !== daemonHome || receipt.unit !== unit || receipt.unitPath !== join(systemdUserUnitDirectory(daemonUserServiceEnv()), unit))
    throw new CommandFailure("refused", "CONFLICT", "the systemd receipt does not name this daemon home's unit in the user manager's unit directory; nothing was changed", {
      remedy: `inspect ${codeSpan(unitReceiptFile(paths))} and ${codeSpan(receipt.unitPath)}. If this receipt is stale, remove only ${codeSpan(unitReceiptFile(paths))} to forget it, then run ${codeSpan(daemonCommandCopy("install", daemonHome))}. For an owned installation, run ${codeSpan(daemonCommandCopy("uninstall", daemonHome))} before reinstalling`,
    });
  try { assertSystemdSource(receipt.unitPath, receipt.unitSha256); }
  catch { throw new CommandFailure("refused", "CONFLICT", `${receipt.unitPath} is not the unit this daemon installed; nothing was removed`); }
}

/** The exact recorded unit `uninstall` would remove, refusing a receipt that no longer matches. */
export function planUninstall(paths: DaemonPaths, daemonHome: string | undefined, missingReceipt?: () => CommandFailure): UninstallPlan {
  return recordedUnit(paths, daemonHome, nativeRun, true, false, missingReceipt).plan;
}

/** Update only the PATH field the installer wrote. Windows tasks have no PATH pin. */
function pinnedPathMatch(mechanism: Exclude<ServiceMechanism, "scheduled-task">, source: string): { pattern: RegExp; match: RegExpExecArray; old: string } {
  const pattern = mechanism === "systemd-user" ? /^Environment=PATH="((?:\\.|[^"\\])*)"$/m : /(<key>PATH<\/key>\s*<string>)([^<]*)(<\/string>)/;
  const match = pattern.exec(source);
  if (!match) throw new CommandFailure("refused", "CONFLICT", "the recorded daemon service has no readable pinned PATH; nothing was changed");
  const old = mechanism === "systemd-user"
    ? match[1]!.replace(/\\([\\"])/g, "$1").replaceAll("%%", "%")
    : match[2]!.replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&quot;", '"').replaceAll("&apos;", "'").replaceAll("&amp;", "&");
  return { pattern, match, old };
}

export function refreshedDaemonPath(mechanism: ServiceMechanism, source: string, terminalPath = process.env.PATH ?? ""): string | undefined {
  if (mechanism === "scheduled-task") return undefined;
  const { pattern, match, old } = pinnedPathMatch(mechanism, source);
  // A systemd unit and a launchd plist carry a POSIX search path whatever host reads them.
  const merged = [...new Set([...pinnedPath(terminalPath, posix).split(posix.delimiter), ...pinnedPath(old, posix).split(posix.delimiter)])].join(posix.delimiter);
  return source.replace(pattern, () => mechanism === "systemd-user" ? `Environment=PATH=${unitValue(merged)}` : `${match[1]}${xmlText(merged)}${match[3]}`);
}

/** Prepare without changing disk or service state. The caller must hold the hosted seat fence
 *  before applying this installer-owned rewrite and restarting the service. */
export function planInstalledPathRefresh(paths: DaemonPaths, daemonHome?: string, accountPath = process.env.PATH ?? ""): ((assertOwner?: () => void) => void) | undefined {
  const { receipt, plan } = recordedUnit(paths, daemonHome);
  if (plan.mechanism === "scheduled-task") return undefined;
  const source = readFileSync(receipt.unitPath, "utf8");
  const os = plan.mechanism === "launchd-agent" ? "darwin" : "linux";
  const merged = [...new Set([
    ...pinnedPath(accountPath, posix).split(posix.delimiter),
    ...pinnedPath(pinnedPathMatch(plan.mechanism, source).old, posix).split(posix.delimiter),
  ])].join(posix.delimiter);
  const next = refreshedDaemonPath(plan.mechanism, source, serviceApplicationPath(merged, os))!;
  const sha256 = createHash("sha256").update(next).digest("hex");
  return (assertOwner) => {
    const lock = process.platform === "darwin" || process.platform === "linux" ? acquireLock(join(paths.state, "service-repair.lock")) : undefined;
    try {
    assertOwner?.();
    const current = recordedUnit(paths, daemonHome).receipt;
    if (current.unitSha256 !== receipt.unitSha256) throw new CommandFailure("refused", "CONFLICT", "the recorded daemon service changed during setup; run setup again");
    writeSecretFileAtomic(receipt.unitPath, next);
    try { writeSecretFileAtomic(unitReceiptFile(paths), `${JSON.stringify({ ...receipt, unitSha256: sha256 })}\n`); }
    catch (error) { writeSecretFileAtomic(receipt.unitPath, source); throw error; }
    assertSystemdSource(receipt.unitPath, sha256);
    if (plan.mechanism === "systemd-user") submitSystemdUnitRegistration("reload", receipt.unit);
    } finally { lock?.release(); }
  };
}

/** Start only the recorded, unchanged service. This does not restart an already-running daemon. */
export async function startInstalled(paths: DaemonPaths, daemonHome: string | undefined, expectedVersion?: string, report?: (detail: string) => void): Promise<DaemonStartPlan> {
  const lock = await claimSuspendableServiceRepairLock(join(paths.state, "service-repair.lock"));
  try {
  assertDesktopSetupComplete();
  if (process.platform === "win32") return restartWindowsInstalled(paths, daemonHome, expectedVersion, report, true);
  const { receipt, plan, service } = recordedUnit(paths, daemonHome);
  if (service) {
    service.start(receipt);
    return plan;
  }
  const { recoveredVersion } = await startSystemdDaemonUnit(paths, daemonHome, plan.unit, {
    refusalStyle: "unit-control",
    serviceEnv: process.env,
    suspendServiceLock: lock.suspend,
  });
  return withRecoveredVersion(plan, recoveredVersion);
  } finally { lock.release(); }
}

/** Start only an enabled, same-installation POSIX unit or LaunchAgent during update, never overriding an operator disable. */
export async function startEnabledInstalled(paths: DaemonPaths, daemonHome: string | undefined): Promise<{ started: boolean; unit: string; state: string }> {
  const lock = await claimSuspendableServiceRepairLock(join(paths.state, "service-repair.lock"));
  try {
  assertDesktopSetupComplete();
  const recorded = recordedUnit(paths, daemonHome);
  const identity = recordedDaemonIdentity(recorded);
  if (!identity.same) throw new CommandFailure("refused", "CONFLICT", `the recorded daemon source names another installation (${identity.installed}); update did not start it`);
  const { receipt, plan, service } = recorded;
  if (service) {
    if (service.isEnabled && !service.isEnabled(receipt)) return { started: false, unit: plan.unit, state: "disabled" };
    service.start(receipt);
    return { started: true, unit: plan.unit, state: "enabled" };
  }
  const read = nativeRun("systemctl", ["--user", "--no-ask-password", "--no-pager", "show", plan.unit, "--property=UnitFileState", "--value"], daemonUserServiceEnv());
  if (read.status !== 0) throw new CommandFailure("refused", "TARGET_UNAVAILABLE", `systemctl --user show ${plan.unit} did not confirm UnitFileState (${read.detail}); nothing was started`);
  const state = read.stdout.trim();
  if (!state) throw new CommandFailure("refused", "TARGET_UNAVAILABLE", `systemctl --user show ${plan.unit} reported an empty UnitFileState; nothing was started`);
  if (state !== "enabled") return { started: false, unit: plan.unit, state };
  await startSystemdDaemonUnit(paths, daemonHome, plan.unit, {
    refusalStyle: "unit-control",
    suspendServiceLock: lock.suspend,
  });
  return { started: true, unit: plan.unit, state: "enabled" };
  } finally { lock.release(); }
}

/** Validate a present service receipt from persistent state without runtime discovery. Return false only when absent. */
export function preflightInstalledDaemon(paths: Pick<DaemonPaths, "state">, daemonHome?: string, expectedArgv?: readonly string[]): boolean {
  try { lstatSync(unitReceiptFile(paths)); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
  if (expectedArgv) {
    const { receipt, plan } = recordedUnit(paths, daemonHome);
    recordedSourceIdentity(receipt, plan.mechanism, () => [...expectedArgv]);
  } else installedDaemonIdentity(paths, daemonHome);
  return true;
}

/** Read the native registration without creating a unit, including when its receipt was lost. */
export function nativeDaemonPresence(paths: DaemonPaths, daemonHome?: string): "absent" | "present" | "unavailable" {
  if (process.platform !== "linux") {
    const plan = planInstall(paths, daemonHome);
    return plan.alreadyInstalled || plan.recovered ? "present" : "absent";
  }
  assertNoServiceRepair(paths);
  const name = daemonUnitName(daemonHome);
  const path = join(systemdUserUnitDirectory(daemonUserServiceEnv()), name);
  try { lstatSync(path); return "present"; }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  const observed = nativeRun("systemctl", ["--user", "show", "--no-pager", "--property=LoadState", "--value", name], daemonUserServiceEnv(), 3000);
  if (observed.status !== 0) return "unavailable";
  const load = observed.stdout.trim();
  return load === "not-found" ? "absent" : load ? "present" : "unavailable";
}

/** The caller still needs lifetime exclusion. In particular, an installed service whose
 * supervisor reports activation or a restart must not be replaced by the Desktop sidecar. */
export function installedDaemonActivity(paths: DaemonPaths, daemonHome?: string): "stopped" | "transition" | "unverified" | "unavailable" {
  const recorded = recordedUnit(paths, daemonHome);
  if (!recordedDaemonIdentity(recorded).same) return "unverified";
  if (recorded.service) return recorded.service.stopped(recorded.receipt) ? "stopped" : "unverified";
  const observed = nativeRun("systemctl", ["--user", "show", "--no-pager", "--property=ActiveState", "--value", recorded.receipt.unit], daemonUserServiceEnv(), 3000);
  if (observed.status !== 0) return "unavailable";
  const active = observed.stdout.trim();
  if (active === "inactive") return "stopped";
  if (["activating", "deactivating", "reloading", "refreshing"].includes(active)) return "transition";
  return "unverified";
}

/** Recreate a shell installation's missing runtime binding without adopting another CLI's service. */
export function reconcileMissingShellRuntime(paths: Pick<DaemonPaths, "state">): void {
  if (process.platform !== "linux" || process.env.COTAL_LAUNCHER !== "1" || process.env.COTAL_INSTALL_RECONCILE !== "1") return;
  const root = process.env.npm_config_prefix;
  if (!root || !isAbsolute(root)) return;
  const lock = acquireLock(join(paths.state, "service-repair.lock"));
  try { reconcileShellRuntime(paths, root); }
  finally { lock.release(); }
}

function reconcileShellRuntime(paths: Pick<DaemonPaths, "state">, root: string): void {
  const { receipt, plan } = recordedUnit(paths, undefined);
  const identity = installedDaemonIdentity(paths);
  const argv = daemonServeArgv(undefined);
  const entry = argv[argv.indexOf("daemon") - 1];
  if (identity.same || identity.installedEntry !== entry || entry !== join(root, "lib", "node_modules", "cotal-ai", "dist", "cotal.js")) return;
  const source = readFileSync(receipt.unitPath, "utf8");
  const executable = /^ExecStart="((?:\\.|[^"\\])*)"/m.exec(source)?.[1];
  if (!executable) return;
  const old = executable.replace(/\\([\\"])/g, "$1").replaceAll("%%", "%").replaceAll("$$", "$");
  if (!recordedSourceMarked(receipt, plan.mechanism) || !old.startsWith(join(root, "runtime") + "/") || old.split("/").includes("..") || existsSync(old)) return;
  const next = source.replace(/^ExecStart="(?:\\.|[^"\\])*"/m, `ExecStart=${unitValue(argv[0]!, true)}`);
  const sha256 = createHash("sha256").update(next).digest("hex");
  // Revalidate the receipt and source immediately before publishing the owned rewrite.
  if (recordedUnit(paths, undefined).receipt.unitSha256 !== receipt.unitSha256) throw new CommandFailure("refused", "CONFLICT", "the recorded daemon service changed during installation");
  writeSecretFileAtomic(receipt.unitPath, next);
  try { writeSecretFileAtomic(unitReceiptFile(paths), `${JSON.stringify({ ...receipt, unitSha256: sha256 })}\n`); }
  catch (error) { writeSecretFileAtomic(receipt.unitPath, source); throw error; }
  assertSystemdSource(receipt.unitPath, sha256);
  submitSystemdUnitRegistration("reload", plan.unit, daemonUserServiceEnv());
}

/** Upgrade an unmodified same-installation Linux unit's OOMPolicy in place without restarting running seats. */
export function reconcileInstalledSystemdOomPolicy(paths: Pick<DaemonPaths, "state">, daemonHome?: string, report?: (line: string) => void): boolean {
  return reconcileSystemdOomPolicy(paths, daemonHome, daemonUnitName(daemonHome), report);
}

/** The executable and entry pinned by the verified native source, compared with this CLI. */
export function installedDaemonIdentity(paths: Pick<DaemonPaths, "state">, daemonHome?: string, expectedArgv?: readonly string[]): { same: boolean; installed: string; installedEntry: string; current: string; receiptKey: string } {
  const recorded = recordedUnit(paths, daemonHome);
  const identity = expectedArgv ? recordedSourceIdentity(recorded.receipt, recorded.plan.mechanism, () => [...expectedArgv]) : recordedDaemonIdentity(recorded);
  return { ...identity, receiptKey: `${recorded.receipt.installedAt}:${recorded.receipt.unitSha256}` };
}

/** Only the owner's installation kind is public. Never project its entry path. */
export function installationOwner(installedEntry: string): { kind: "app" | "cli" } {
  return { kind: existsSync(join(dirname(dirname(installedEntry)), "desktop-runtime.json")) ? "app" : "cli" };
}

/** Detect a candidate without asking the user manager about healthy or absent services. */
export function linuxMissingProgram(paths: Pick<DaemonPaths, "state">): boolean {
  const receipt = readReceipt(paths);
  if (!receipt) {
    try { lstatSync(unitReceiptFile(paths)); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
    throw new CommandFailure("refused", "CONFLICT", "the recorded daemon service receipt could not be verified");
  }
  if ((receipt.mechanism ?? "systemd-user") !== "systemd-user") return false;
  const source = readLocalRecordSource(receipt.unitPath, 64 * 1024, true);
  return source !== undefined && missingSystemdProgram(source.toString("utf8"));
}

/** Replace only a verified native unit whose program is gone. Keep sign-in and hosting records. */
export async function repairMissingInstalledProgram(paths: DaemonPaths, daemonHome?: string, report?: (line: string) => void): Promise<boolean> {
  const linux = process.platform === "linux";
  if (!linux && process.platform !== "darwin") return false;
  if (linux) await finishRecordedOomPolicyIntent(paths, daemonHome, daemonUnitName(daemonHome), report);
  const remedy = `inspect the recorded service. To replace a verified installation, run ${codeSpan(daemonCommandCopy("uninstall", daemonHome, ["--yes"]) + " && " + daemonCommandCopy("install", daemonHome))}`;
  const missing = (receipt: UnitReceipt) => linux ? missingSystemdProgram(readFileSync(receipt.unitPath, "utf8")) : missingLaunchAgentProgram(receipt);
  const failure = (detail: string, code: "CONFLICT" | "TARGET_UNAVAILABLE" | "LIFECYCLE_BLOCKED" = "CONFLICT") =>
    new CommandFailure("refused", code, `the recorded daemon program is missing: ${detail}`, { remedy });
  try {
    if (linux) {
      if (!linuxMissingProgram(paths) && readServiceRepair(paths.state) === undefined) return false;
      checkDir(paths.state);
      if (!readLocalRecordSource(unitReceiptFile(paths), 64 * 1024, true)) throw failure("the install receipt was not verified");
    } else if (!readReceipt(paths)) return false;
  } catch (error) {
    if (linux) throw new CommandFailure("refused", error instanceof CommandFailure && error.code === "CONFLICT" ? "CONFLICT" : "TARGET_UNAVAILABLE", `could not verify the recorded daemon program: ${(error as Error).message}`, { remedy });
    throw error;
  }
  const lock = await acquireLockAsync(join(paths.state, "service-repair.lock"), linux ? { onTimeout: () => failure("another command is still repairing the recorded service. Run `cotal daemon status` to check it") } : undefined);
  const systemd = (receipt: UnitReceipt, previous?: string) => {
    const source = readLocalRecordSource(receipt.unitPath, 64 * 1024, true)?.toString("utf8");
    if (!source || sourceDigest(source) !== receipt.unitSha256) throw failure("the recorded unit source changed during repair");
    return observeSystemdRepairUnit((file, args, env, timeout) => nativeRun(file, args, env ?? daemonUserServiceEnv(), timeout), receipt, source, previous);
  };
  const nativePid = (receipt: UnitReceipt) => {
    const job = darwinLaunchdJob(receipt.unit);
    return job.state === "loaded" ? job.job.pid : undefined;
  };
  let exclusion: ReturnType<typeof excludeLifetime> | undefined;
  let fenced = false;
  let owner: ReturnType<typeof readLifetimeRecord>;
  let socket: Awaited<ReturnType<typeof openVerified>> | undefined;
  let replies: ReturnType<typeof repairReplies> | undefined;
  const request = async (op: "status" | "managers-prepare-restart" | "managers-abort-restart") => {
    if (!socket || !owner?.start || processBirth(owner.pid) !== owner.start) throw new Error("the pinned daemon lifetime is no longer available");
    const id = randomUUID().replaceAll("-", "");
    const answer = replies!.read(id, op === "managers-prepare-restart" ? 130_000 : 70_000);
    socket.write(encode({ v: DAEMON_PROTOCOL_VERSION, id, op }));
    const raw: unknown = JSON.parse(await answer);
    if (!linux) return repairReplyResult(raw, id, op);
    const reply = raw as DaemonResponse;
    if (reply.id !== id || reply.v !== DAEMON_PROTOCOL_VERSION) throw new Error("the pinned daemon did not confirm service repair preparation");
    if (!reply.ok) throw failure(reply.error.message, "LIFECYCLE_BLOCKED");
    if ("event" in reply || !("version" in reply.result)) throw new Error("the pinned daemon refused service repair preparation");
    return reply.result;
  };
  try {
    let intent = readServiceRepair(paths.state);
    if (intent) {
      const actual = readReceipt(paths)!;
      if (!actual || actual.daemonHome !== daemonHome || intent.receipt.daemonHome !== daemonHome || (intent.receipt.mechanism ?? "systemd-user") !== (linux ? "systemd-user" : "launchd-agent")) throw new Error("the repair intent names another daemon home or service mechanism");
      const source = readFileSync(actual.unitPath, "utf8");
      assertServiceRepairPair(intent, actual, source);
      const matching = { ...intent.receipt, unitSha256: sourceDigest(source) };
      // Verify the physical source and any loaded job before recovering the interrupted pair.
      if (linux) {
        assertLinuxRecordedUnit(paths, daemonHome, matching);
        systemd(matching, source === intent.nextSource ? intent.previousSource : undefined);
      } else nativeService()!.check(matching);
      if (actual.unitSha256 !== matching.unitSha256) writeSecretFileAtomic(unitReceiptFile(paths), `${JSON.stringify(matching)}\n`);
    }
    const recorded = recordedUnit(paths, daemonHome, nativeRun, false, true);
    const { receipt, service, plan } = recorded;
    if (!intent && !missing(receipt)) return false;
    if (receipt.daemonHome !== daemonHome || !recordedSourceMarked(receipt, plan.mechanism)) throw failure("the service does not prove this daemon's native source; nothing was changed");
    const previousSource = intent?.previousSource ?? readFileSync(receipt.unitPath, "utf8");
    const argv = daemonServeArgv(daemonHome);
    const entry = argv[argv.indexOf("daemon") - 1]!;
    const manifest = JSON.parse(readFileSync(join(dirname(dirname(entry)), "package.json"), "utf8"));
    if (manifest.name !== "cotal-ai" || typeof manifest.version !== "string" || !manifest.version) throw failure("this Cotal installation's package could not be verified");
    const installedVersion = manifest.version as string;
    const version = intent?.version ?? installedVersion;
    if (installedVersion !== version) throw new Error("the recorded repair destination version changed; no service was stopped");
    if (intent && JSON.stringify(intent.argv) !== JSON.stringify(argv)) throw new Error("the repair must finish from its recorded Cotal installation");
    let hostedSpaces = intent?.hostedSpaces ?? [];
    // A running process loaded from the deleted bundle is not a replacement installation.
    for (const file of [argv[0]!, entry, ...(linux ? [] : [join(dirname(entry), "daemon-cwd.js")])]) {
      if (!statSync(file).isFile()) throw new CommandFailure("refused", "DEPENDENCY_UNAVAILABLE", "this Cotal installation cannot repair the missing daemon program; reinstall Cotal first");
    }
    if (linux) {
      accessSync(argv[0]!, constants.X_OK);
      accessSync(entry, constants.R_OK);
    }
    const renderedUnit = linux && !intent ? renderDaemonUnit(dirname(receipt.unitPath), daemonHome) : undefined;
    const next = intent ? { text: intent.nextSource, sha256: sourceDigest(intent.nextSource) }
      : renderedUnit ? { text: renderedUnit.bytes, sha256: renderedUnit.sha256 }
      : renderLaunchAgent({ label: receipt.unit, argv, searchPath: serviceApplicationPath(), workingDirectory: homedir(), logPath: join(paths.state, "daemon.log") });
    const published = !!intent && readFileSync(receipt.unitPath, "utf8") === intent.nextSource;
    const enabled = intent?.enabled ?? (linux ? systemd(receipt).enabled : service!.isEnabled!(receipt));
    owner = readLifetimeRecord(paths.lock);
    try {
      socket = await openVerified({ paths });
      socket.on("error", () => {});
      replies = repairReplies(socket);
      const answer = await request("status");
      if (!owner?.start || answer.pid !== owner.pid || processBirth(owner.pid) !== owner.start) throw new Error("the daemon lifetime changed before service repair");
      const matchedInvocation = linux ? systemd(receipt) : undefined;
      if ((matchedInvocation?.pid ?? nativePid(receipt)) !== answer.pid || (linux && processBirth(owner.pid) !== owner.start)) throw new Error("the answering daemon is not the recorded native job");
      if (intent && published && recordedSourceIdentity(receipt, plan.mechanism, intent.argv).same && answer.version === version) {
        if (hostedSpaces.some(space => !answer.managers?.some(manager => manager.space === space && manager.state === "answering"))) throw new Error("the repaired daemon's recorded Managers have not answered yet");
        rmSync(serviceRepairFile(paths.state));
        return true;
      }
      hostedSpaces = [...new Set([...hostedSpaces, ...(answer.managers ?? []).filter(manager => manager.pid !== undefined).map(manager => manager.space)])];
      fenced = true;
      await request("managers-prepare-restart");
      if (matchedInvocation && JSON.stringify(systemd(receipt)) !== JSON.stringify(matchedInvocation)) throw new Error("the systemd unit changed during hosted Manager preparation");
    } catch (error) {
      if (!(error instanceof EndpointRefusal && error.code === "NOT_RUNNING")) throw error;
      if (owner?.start && processBirth(owner.pid) === owner.start) throw new Error("the missing-program daemon is live but cannot be verified; its service was not changed");
      owner = undefined;
      if (linux) exclusion = excludeLifetime(paths.lock);
    }
    const current = recordedUnit(paths, daemonHome, nativeRun, false, true).receipt;
    if (JSON.stringify(current) !== JSON.stringify(receipt) || (!intent && !missing(current))) throw new Error("the daemon installation changed before repair");
    if (owner?.start && processBirth(owner.pid) !== owner.start) throw new Error("the daemon lifetime changed before repair");
    const native = linux ? systemd(current, published ? previousSource : undefined) : undefined;
    if (native) {
      if (native.pid !== (owner?.pid ?? 0) || native.enabled !== enabled) throw new Error("the systemd unit's lifetime or enablement changed before repair");
      if (published && !native.settled) throw new Error("the previously repaired unit has an unconfirmed native start");
    }
    intent ??= { v: 1, receipt, previousSource, nextSource: next.text, enabled, argv, version, hostedSpaces, phase: "prepared" };
    intent = { ...intent, hostedSpaces };
    writeSecretFileAtomic(serviceRepairFile(paths.state), `${JSON.stringify(intent)}\n`);
    if (!linux) service!.remove(current, true);
    else if (!published && !native!.settled) {
      const fresh = systemd(current);
      if (JSON.stringify(fresh) !== JSON.stringify(native) || (owner?.start && processBirth(owner.pid) !== owner.start)) throw new Error("the systemd unit changed before its native stop");
      submitSystemdUnitControl("stop", current.unit, daemonUserServiceEnv());
    }
    const deadline = Date.now() + 130_000;
    while (owner?.start && processBirth(owner.pid) === owner.start) {
      if (Date.now() >= deadline) throw new Error("the old daemon did not exit during service repair; source and receipt were retained");
      await delay(100);
    }
    while (!linux) {
      const native = nativeRun("/bin/launchctl", ["print", `gui/${process.getuid!()}/${receipt.unit}`]);
      if (native.status === 113) break;
      if (native.status !== 0) throw new Error("launchd could not confirm the old service absent; source and receipt were retained");
      if (Date.now() >= deadline) throw new Error("the old LaunchAgent did not unload during repair");
      await delay(100);
    }
    exclusion ??= excludeLifetime(paths.lock);
    try {
      const unchanged = recordedUnit(paths, daemonHome, nativeRun, false, true).receipt;
      if (JSON.stringify(unchanged) !== JSON.stringify(receipt)) throw new Error("the daemon receipt changed during repair");
      if (linux && !published) {
        const native = systemd(unchanged);
        if (!native.settled || native.enabled !== enabled) throw new Error("the systemd unit did not settle with unchanged enablement");
      }
      if (!published) {
        writeSecretFileAtomic(receipt.unitPath, next.text);
        try { writeSecretFileAtomic(unitReceiptFile(paths), `${JSON.stringify({ ...receipt, unitSha256: next.sha256 })}\n`); }
        catch (error) { writeSecretFileAtomic(receipt.unitPath, previousSource); throw error; }
      }
      writeSecretFileAtomic(serviceRepairFile(paths.state), `${JSON.stringify({ ...intent, phase: "published" })}\n`);
      if (linux) submitSystemdUnitRegistration("reload", receipt.unit, daemonUserServiceEnv());
    } finally { exclusion.release(); }
    const repaired = recordedUnit(paths, daemonHome, nativeRun, false, true).receipt;
    const repairedNative = linux ? systemd(repaired) : undefined;
    if (repairedNative && !repairedNative.settled) throw new Error("the repaired systemd unit was not confirmed stopped");
    if (!enabled || repairedNative?.enabled === false) {
      rmSync(serviceRepairFile(paths.state));
      return true;
    }
    if (linux) submitSystemdUnitControl("start", repaired.unit, daemonUserServiceEnv());
    else service!.start(repaired);
    const readyUntil = Date.now() + 60_000;
    for (;;) {
      try {
        const answer = await queryDaemon({ paths });
        if (!answer.ok || answer.result.version !== version) throw new Error("repaired daemon has not confirmed this installed version");
        const fresh = readLifetimeRecord(paths.lock);
        if (!fresh?.start || fresh.pid !== answer.result.pid || processBirth(fresh.pid) !== fresh.start || (fresh.pid === owner?.pid && fresh.start === owner.start)) throw new Error("the repaired daemon has no fresh verified lifetime");
        const current = recordedUnit(paths, daemonHome, nativeRun, false, true);
        if (!recordedSourceIdentity(current.receipt, plan.mechanism, argv).same) throw new Error("the repaired native source no longer names the selected installation");
        if ((linux ? systemd(current.receipt).pid : nativePid(current.receipt)) !== answer.result.pid || (linux && processBirth(fresh.pid) !== fresh.start)) throw new Error("the repaired endpoint is not the recorded native job");
        if (hostedSpaces.some(space => !answer.result.managers?.some(manager => manager.space === space && manager.state === "answering" && manager.pid !== undefined))) throw new Error("repaired hosted Managers have not answered");
        rmSync(serviceRepairFile(paths.state));
        return true;
      } catch (error) {
        if (Date.now() >= readyUntil) throw error;
        await delay(250);
      }
    }
  } catch (error) {
    if (!linux) throw error;
    if (error instanceof CommandFailure) throw new CommandFailure(error.outcome, error.code, error.message.startsWith("the recorded daemon program is missing:") ? error.message : `the recorded daemon program is missing: ${error.message}`, { remedy: error.remedy ?? remedy, native: error.native, target: error.target });
    throw failure((error as Error).message);
  } finally {
    try { if (fenced && owner?.start && processBirth(owner.pid) === owner.start) await request("managers-abort-restart").catch(error => { if (!linux) throw error; }); }
    finally { exclusion?.release(); replies?.close(); socket?.destroy(); lock.release(); }
  }
}

function recordedDaemonIdentity({ receipt, plan }: ReturnType<typeof recordedUnit>): { same: boolean; installed: string; installedEntry: string; current: string } {
  return recordedSourceIdentity(receipt, plan.mechanism, () => daemonServeArgv(receipt.daemonHome));
}

export interface DaemonOwnershipObservation {
  readonly state: "owned" | "not-owned" | "unknown";
  readonly reason: "verified" | "marker-absent" | "identity-differs" | "source-marker-absent" | "observation-failed" | "observation-timeout" | "observation-aborted" | "worker-failed";
  readonly stopPeerOwnsLock?: true;
}

/** A native launch marker is trusted only with this installation's verified recorded source. */
export function daemonStartedByOwnedService(paths: DaemonPaths, daemonHome?: string, stopPeer?: DaemonPeerLifetime): DaemonOwnershipObservation {
  if (process.env.COTAL_DAEMON_NATIVE_SERVICE !== "1") return { state: "not-owned", reason: "marker-absent" };
  try {
    const intent = process.platform === "darwin" || process.platform === "linux" ? (readServiceRepair(paths.state) ?? (process.platform === "linux" ? readServiceRepair(paths.state, servicePolicyRepairFile(paths.state)) : undefined)) : undefined;
    const stopPeerOwnsLock = !intent && assertNoServiceRepair(paths, stopPeer);
    const recorded = recordedUnit(paths, daemonHome, nativeRun, false, true);
    if (intent) assertServiceRepairPair(intent, recorded.receipt, readFileSync(recorded.receipt.unitPath, "utf8"));
    if (!recordedDaemonIdentity(recorded).same) return { state: "not-owned", reason: "identity-differs" };
    const { receipt, plan } = recorded;
    const marked = recordedSourceMarked(receipt, plan.mechanism);
    return marked ? { state: "owned", reason: "verified", ...(stopPeerOwnsLock ? { stopPeerOwnsLock: true } : {}) } : { state: "not-owned", reason: "source-marker-absent" };
  } catch { return { state: "unknown", reason: "observation-failed" }; }
}

/** A delayed Windows native child must not publish after uninstall removed its installation. */
export function admitWindowsNativeDaemon(paths: DaemonPaths, daemonHome?: string): void {
  assertDesktopSetupComplete();
  const receipt = readReceipt(paths);
  if (!receipt || receipt.mechanism !== "scheduled-task" || receipt.daemonHome !== daemonHome ||
      receipt.unit !== scheduledTaskName(daemonHome, windowsUserSid()) || receipt.unitPath !== join(paths.state, "service-task.xml"))
    throw new CommandFailure("refused", "CONFLICT", "the native daemon installation is no longer recorded for this home; startup refused");
  const source = readLocalRecordSource(receipt.unitPath, 64 * 1024, true);
  if (!source || createHash("sha256").update(source).digest("hex") !== receipt.unitSha256)
    throw new CommandFailure("refused", "CONFLICT", "the native daemon source changed before startup; startup refused");
  const plan: UninstallPlan = { mechanism: "scheduled-task", unit: receipt.unit, unitPath: receipt.unitPath, installedAt: receipt.installedAt };
  if (!recordedDaemonIdentity({ receipt, plan, service: undefined }).same)
    throw new CommandFailure("refused", "CONFLICT", "the native daemon source names another installation; startup refused");
}

/** Observe native provenance without running supervisor tools on the serving event loop. */
export function observeDaemonOwnedService(paths: DaemonPaths, daemonHome?: string, signal?: AbortSignal, stopPeer?: DaemonPeerLifetime): Promise<DaemonOwnershipObservation> {
  if (signal?.aborted) return Promise.resolve({ state: "unknown", reason: "observation-aborted" });
  if (process.env.COTAL_DAEMON_NATIVE_SERVICE !== "1") return Promise.resolve({ state: "not-owned", reason: "marker-absent" });
  return new Promise(resolve => {
    // Reuse the installer's exact source, identity and native-job checks. The worker's
    // default argv names this helper, so explicitly preserve the daemon's launch vector.
    let expected: string[] | undefined;
    if (process.platform === "win32") {
      try { expected = daemonServeArgv(daemonHome); }
      catch { resolve({ state: "unknown", reason: "observation-failed" }); return; }
    }
    const worker = new Worker(`
      const { parentPort, workerData } = require('node:worker_threads');
      process.argv = workerData.argv;
      process.execArgv = workerData.execArgv;
      if (workerData.execution) Object.defineProperty(globalThis, Symbol.for('cotal.execution.identity'), { value: Object.freeze(workerData.execution) });
      import(workerData.module).then(m => parentPort.postMessage(workerData.expected ? m.observeWindowsOwnedService(workerData.paths, workerData.expected) : m.daemonStartedByOwnedService(workerData.paths, workerData.home, workerData.stopPeer))).catch(() => parentPort.postMessage({ state: 'unknown', reason: 'worker-failed' }));
    `, { eval: true, workerData: { module: expected ? new URL("./ownership-win32.js", import.meta.url).href : import.meta.url, expected, paths, home: daemonHome, stopPeer, argv: process.argv, execArgv: process.execArgv, execution: executionIdentity() }, stdout: true, stderr: true });
    worker.stdout.resume(); worker.stderr.resume();
    let settled = false;
    const finish = (observation: DaemonOwnershipObservation) => {
      if (settled) return;
      settled = true; clearTimeout(timer);
      signal?.removeEventListener("abort", aborted);
      resolve(observation);
      void worker.terminate();
    };
    // whoami and the task lookup each retain their existing 30-second native bound.
    const timer = setTimeout(() => finish({ state: "unknown", reason: "observation-timeout" }), 65_000);
    const aborted = () => finish({ state: "unknown", reason: "observation-aborted" });
    signal?.addEventListener("abort", aborted, { once: true });
    worker.once("message", (value: DaemonOwnershipObservation) => finish(value));
    worker.once("error", () => finish({ state: "unknown", reason: "worker-failed" }));
    worker.once("exit", () => finish({ state: "unknown", reason: "worker-failed" }));
  });
}

/** Send a restart handshake on the caller's already verified, pinned connection. */
export async function requestInstalledDaemon(socket: Awaited<ReturnType<typeof openVerified>> | undefined, op: "daemon-stop" | "status", commit = false, timeoutMs = commit ? 5000 : 70_000) {
  const id = randomUUID().replaceAll("-", "");
  if (!socket) throw new Error("the pinned daemon connection is absent");
  socket.write(encode({ v: DAEMON_PROTOCOL_VERSION, id, op, ...(commit ? { commit: true } : {}) }));
  const reply = JSON.parse(await readLine(socket, timeoutMs)) as DaemonResponse;
  const unacknowledged = () => new Error(`the pinned daemon did not acknowledge ${op}`);
  if (!reply || typeof reply !== "object" || reply.v !== DAEMON_PROTOCOL_VERSION || reply.id !== id || "event" in reply) throw unacknowledged();
  if (reply.ok === false) {
    if (!reply.error || typeof reply.error.code !== "string" || typeof reply.error.message !== "string") throw unacknowledged();
    throw new CommandFailure("unknown", "OPERATION_UNKNOWN", `the pinned daemon refused ${op}: ${reply.error.code}: ${reply.error.message}`, {
      native: { code: reply.error.code, detail: reply.error.message },
    });
  }
  if (reply.ok !== true || !("result" in reply) || !reply.result || typeof reply.result !== "object" || !("version" in reply.result) || typeof reply.result.version !== "string") throw unacknowledged();
  return reply.result;
}

/** An automatic helper's captured authority, retained until its single activation deadline. */
interface WindowsAutomaticRestart {
  readonly deadline: number;
  readonly receipt: string;
  readonly pid: number;
  readonly start: string;
  readonly exited: () => boolean;
}

/** Restart the recorded Windows task only after the pinned daemon lifetime exits. */
async function restartWindowsInstalled(paths: DaemonPaths, daemonHome?: string, expectedVersion?: string, report?: (detail: string) => void, startOnly = false, automatic?: WindowsAutomaticRestart): Promise<UninstallPlan> {
  const remaining = (limit: number): number => {
    if (!automatic) return limit;
    const left = automatic.deadline - Date.now();
    if (left <= 0) throw new Error("Windows automatic activation deadline expired; release remains installed; use Start service");
    return Math.min(limit, left);
  };
  const run: NativeRun = automatic ? (file, args, env) => nativeRun(file, args, env, remaining(30_000)) : nativeRun;
  const recorded = () => recordedUnit(paths, daemonHome, run, false, false, startOnly ? () => new CommandFailure("refused", "TARGET_NOT_FOUND", "no scheduled task installation is recorded for this daemon", { remedy: windowsDaemonFirstStart(daemonHome) }) : undefined);
  const { receipt, plan } = recorded();
  if (process.platform !== "win32" || plan.mechanism !== "scheduled-task") throw new CommandFailure("refused", "UNSUPPORTED", "Windows daemon restart requires the recorded scheduled task");
  if (automatic && JSON.stringify(receipt) !== automatic.receipt) throw new Error("the captured Windows installation changed before activation");
  const task = scheduledTaskService(run);
  if (automatic) {
    const observed = task.inspect(receipt);
    if (!observed.present || observed.enabled !== true) throw new Error("the captured Windows task is absent or disabled; activation refused");
  }
  const before = readLifetimeRecord(paths.lock);
  let socket: Awaited<ReturnType<typeof openVerified>> | undefined;
  try { socket = await openVerified({ paths, timeoutMs: remaining(5000) }); }
  catch (error) {
    if (!(error instanceof EndpointRefusal && (error.code === "NOT_RUNNING" || ((startOnly || automatic) && error.code === "PEER_NOT_LOCK_OWNER")))) throw error;
  }
  socket?.on("error", () => {});
  const owner = readLifetimeRecord(paths.lock);
  const priorOwner = automatic ? { pid: automatic.pid, start: automatic.start } : startOnly ? undefined : owner;
  let phase = "prepare";
  let pauseAttempted = false;
  let stopCommitted = false;
  const progress = (detail: string) => { phase = detail; report?.(detail); };
  const startedAt = Date.now();
  const heartbeat = setInterval(() => report?.(`${phase} (${Math.floor((Date.now() - startedAt) / 1000)}s elapsed)`), 5000);
  let exclusion: ReturnType<typeof excludeLifetime> | undefined;
  let startGate: number | undefined;
  const request = (op: "daemon-stop" | "status", commit = false) => requestInstalledDaemon(socket, op, commit, remaining(commit ? 5000 : 70_000));
  try {
    let version = expectedVersion;
    if (socket && (!startOnly || (owner?.start && before?.pid === owner.pid && before.start === owner.start && processBirth(owner.pid) === owner.start))) {
    if (!owner?.start || before?.pid !== owner.pid || before.start !== owner.start || processBirth(owner.pid) !== owner.start) throw new Error("the daemon lifetime changed while opening its endpoint");
    const initial = await request("status");
    if (automatic && (owner!.pid !== automatic.pid || owner!.start !== automatic.start)) {
      if (!automatic.exited() || initial.version !== expectedVersion) throw new Error("another daemon lifetime replaced the captured generation");
      if (JSON.stringify(recorded().receipt) !== automatic.receipt) throw new Error("the installation changed while observing the replacement");
      const currentTask = task.inspect(receipt);
      if (!currentTask.present || currentTask.enabled !== true || currentTask.instances !== 1) throw new Error("the replacement does not have one enabled native task instance");
      return plan;
    }
    if (startOnly) {
      if (expectedVersion !== undefined && initial.version !== expectedVersion) throw new Error("replacement version or protocol did not match");
      const currentTask = task.inspect(receipt);
      if (!currentTask.present || currentTask.enabled !== true || currentTask.instances !== 1) throw new Error("the replacement does not have one enabled native task instance");
      return plan;
    }
    version ??= initial.version;
    await request("daemon-stop");
    progress("pausing the owned scheduled task and confirming native instances stopped");
    pauseAttempted = true;
    await task.pause(receipt);
    phase = "stop-commit";
    if (processBirth(owner!.pid) === owner!.start) {
      stopCommitted = true;
      try { await request("daemon-stop", true); }
      catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        const ended = error instanceof Error && error.message === "daemon closed the connection without a reply";
        if (code !== "EPIPE" && code !== "ECONNRESET" && !ended) throw error;
      }
    }
    progress("waiting for the old daemon lifetime to exit (up to 130s)");
    const deadline = Date.now() + remaining(130_000);
    for (;;) {
      let absent = false;
      try { const probe = await openVerified({ paths, timeoutMs: remaining(1000) }); probe.destroy(); }
      catch (error) {
        if (error instanceof EndpointRefusal && error.code === "NOT_RUNNING") absent = true;
        else if ((error as NodeJS.ErrnoException).code !== "ECONNRESET" && !(stopCommitted && isStoppingLifetime(error, owner)) && !(automatic && automatic.exited() && error instanceof EndpointRefusal && error.code === "PEER_NOT_LOCK_OWNER")) throw error;
      }
      if (processBirth(owner!.pid) !== owner!.start) {
        if (absent) break;
        if (automatic && automatic.exited()) {
          const currentLock = readLifetimeRecord(paths.lock);
          if (currentLock?.start && (currentLock.pid !== owner!.pid || currentLock.start !== owner!.start)) break;
        }
      }
      if (Date.now() >= deadline) throw new Error("old daemon death and endpoint absence were not confirmed within 130s");
      await delay(100);
    }
    } else if (!startOnly && !(automatic && automatic.exited()) && owner?.start && processBirth(owner.pid) === owner.start) {
      throw new Error("the recorded live daemon has no verified listener");
    }
    if (automatic && !automatic.exited()) throw new Error("the captured Windows daemon kernel lifetime has not ended");
    startGate = openSync(unitReceiptFile(paths), constants.O_RDWR);
    const startOwner = lockExclusiveNb(startGate);
    if (!startOwner) {
      closeSync(startGate); startGate = undefined;
      if (!startOnly && !automatic) throw new Error("another Windows daemon start is already in progress");
    } else {
      progress("verifying the recorded installation and owned task before startup");
      const current = recorded().receipt;
      if (JSON.stringify(current) !== JSON.stringify(receipt)) throw new Error("the installation changed during shutdown");
      const native = task.inspect(receipt);
      if (!native.present) throw new Error("the owned task is absent or still has native instances");
      if (native.instances === 0) {
        exclusion = excludeLifetime(paths.lock);
        try { const probe = await openVerified({ paths, timeoutMs: remaining(1000) }); probe.destroy(); throw new Error("a daemon endpoint still answers under lifetime exclusion"); }
        catch (error) { if (!(error instanceof EndpointRefusal && error.code === "NOT_RUNNING")) throw error; }
        // The replacement must acquire the lock itself. Never Run while holding exclusion.
        exclusion.release(); exclusion = undefined;
        progress("enabling and starting the verified owned scheduled task");
        if (automatic && !pauseAttempted) task.startEnabled(receipt);
        else task.start(receipt);
      } else if (!(startOnly || automatic) || native.instances !== 1 || native.enabled !== true) {
        throw new Error("the owned task is absent or still has native instances");
      }
    }
    progress("waiting for a fresh daemon to answer (up to 60s)");
    const readyUntil = Date.now() + remaining(60_000);
    for (;;) {
      try {
        const prior = readLifetimeRecord(paths.lock);
        const fresh = await openVerified({ paths, timeoutMs: remaining(1000) });
        try {
          const lifetime = readLifetimeRecord(paths.lock);
          if (!lifetime?.start || prior?.pid !== lifetime.pid || prior.start !== lifetime.start || (lifetime.pid === priorOwner?.pid && lifetime.start === priorOwner.start) || processBirth(lifetime.pid) !== lifetime.start) throw new Error("no fresh stable kernel lifetime");
          const id = randomUUID().replaceAll("-", "");
          fresh.write(encode({ v: DAEMON_PROTOCOL_VERSION, id, op: "status" }));
          const reply = JSON.parse(await readLine(fresh, remaining(20_000))) as DaemonResponse;
          if (reply.v !== DAEMON_PROTOCOL_VERSION || reply.id !== id || !reply.ok || "event" in reply || !("version" in reply.result) || (version !== undefined && reply.result.version !== version) || !("protocol" in reply.result) || reply.result.protocol !== DAEMON_PROTOCOL_VERSION) throw new Error("replacement version or protocol did not match");
          if (processBirth(lifetime.pid) !== lifetime.start) throw new Error("replacement exited during proof");
          if (JSON.stringify(recorded().receipt) !== JSON.stringify(receipt)) throw new Error("the installation changed during replacement startup");
          const readyTask = task.inspect(receipt);
          if (!readyTask.present || readyTask.enabled !== true || readyTask.instances !== 1) throw new Error("the replacement does not have one enabled native task instance");
          return plan;
        } finally { fresh.destroy(); }
      } catch (error) {
        if (Date.now() >= readyUntil) throw error;
        await delay(250);
      }
    }
  } catch (error) {
    let recovery = "ownership is ambiguous; the task was not enabled";
    try {
      if (!pauseAttempted) throw new Error("no task pause was attempted");
      task.inspect(receipt);
      recovery = await recoverPausedTask({
        pendingEnd: task.pendingEnd,
        unchanged() {
          if (JSON.stringify(recorded().receipt) !== JSON.stringify(receipt)) throw new Error("the installation changed");
        },
        async oldAnswers() {
          if (!socket || socket.destroyed || !owner?.start || processBirth(owner.pid) !== owner.start) return false;
          await request("status");
          if (processBirth(owner.pid) !== owner.start) throw new Error("old lifetime changed during recovery");
          return true;
        },
        async absent() {
          exclusion ??= excludeLifetime(paths.lock);
          try { const probe = await openVerified({ paths, timeoutMs: remaining(1000) }); probe.destroy(); throw new Error("a daemon still answers"); }
          catch (probeError) { if (!(probeError instanceof EndpointRefusal && probeError.code === "NOT_RUNNING")) throw probeError; }
          const native = task.inspect(receipt);
          if (!native.present || native.instances !== 0) throw new Error("native instances are not absent");
        },
        enable() { task.enable(receipt); },
      });
    } catch (recoveryError) { recovery += ` (${recoveryError instanceof Error ? recoveryError.message : String(recoveryError)})`; }
    throw new CommandFailure("unknown", "OPERATION_UNKNOWN", `Windows daemon restart failed during ${phase}: ${error instanceof Error ? error.message : String(error)}; ${recovery}; the generation fence, source and receipt were retained`, { ...(error instanceof CommandFailure && error.native ? { native: error.native } : {}), remedy: "inspect \`cotal daemon status\` and the recorded task in Task Scheduler, then run setup again. Do not clear a restart fence through a replacement connection" });
  } finally { clearInterval(heartbeat); socket?.destroy(); exclusion?.release(); if (startGate !== undefined) closeSync(startGate); }
}

/** Restart only the source and native job recorded for this daemon. */
export async function restartInstalled(paths: DaemonPaths, daemonHome?: string, reload = false, expectedVersion?: string, report?: (detail: string) => void, automatic?: WindowsAutomaticRestart): Promise<DaemonStartPlan> {
  const lock = await claimSuspendableServiceRepairLock(join(paths.state, "service-repair.lock"));
  try {
  if (process.platform === "win32") return restartWindowsInstalled(paths, daemonHome, expectedVersion, report, false, automatic);
  const { receipt, plan, service } = recordedUnit(paths, daemonHome);
  if (service) {
    service.restart(receipt, reload);
    return plan;
  }
  submitSystemdUnitControl("stop", plan.unit, daemonUserServiceEnv());
  const { recoveredVersion } = await startSystemdDaemonUnit(paths, daemonHome, plan.unit, {
    refusalStyle: "daemon-restart",
    suspendServiceLock: lock.suspend,
  });
  return withRecoveredVersion(plan, recoveredVersion);
  } finally { lock.release(); }
}

interface UninstallResult extends UninstallPlan {
  readonly state: "removed";
  readonly removedServiceRecords: readonly string[];
}

/** Stop it, disable autostart, erase its service records under lifetime exclusion, remove the unit
 *  and receipt, and reload the user manager (on macOS and Windows, the adapter's deregistration). */
export async function applyUninstall(paths: DaemonPaths, daemonHome: string | undefined): Promise<UninstallResult> {
  const lock = process.platform === "darwin" || process.platform === "linux" ? await acquireLockAsync(join(paths.state, "service-repair.lock")) : undefined;
  try { return await applyUninstallUnlocked(paths, daemonHome); }
  finally { lock?.release(); }
}

async function applyUninstallUnlocked(paths: DaemonPaths, daemonHome: string | undefined): Promise<UninstallResult> {
  const { receipt, plan, service, recovered } = recordedUnit(paths, daemonHome, nativeRun, true);
  if (recovered) {
    submitSystemdUnitControl("stop", plan.unit);
    mkSecretDir(paths.state);
  }
  checkDir(paths.state);
  // Pin a kernel-authenticated connection before removing the supervisor. It can
  // stop only that listener, never a reused PID or a later daemon generation.
  const before = readLifetimeRecord(paths.lock);
  let socket;
  let stopCommitted = false;
  try { socket = await openVerified({ paths }); }
  catch (error) { if (!(error instanceof EndpointRefusal && error.code === "NOT_RUNNING")) throw error; }
  const owner = readLifetimeRecord(paths.lock);
  let exclusion: ReturnType<typeof excludeLifetime> | undefined;
  const uncertain = (detail: string) => new CommandFailure("unknown", "OPERATION_UNKNOWN", `${detail}; the daemon source and receipt were retained`, { remedy: "inspect \`cotal daemon status\` and the native service, then retry \`cotal daemon uninstall\`" });
  try {
    if (socket && (!owner?.start || before?.pid !== owner.pid || before.start !== owner.start))
      throw uncertain("the daemon lifetime changed while its endpoint was opened");
    if (owner?.start && processBirth(owner.pid) === owner.start && !socket)
      throw uncertain("the recorded daemon has no verified answering endpoint");
    if (!socket) exclusion = excludeLifetime(paths.lock);
    // The supervisor can close this connection during the synchronous native step.
    socket?.on("error", () => {});
    if (socket && owner?.start && processBirth(owner.pid) === owner.start) {
      const id = randomUUID().replaceAll("-", "");
      socket.write(encode({ v: DAEMON_PROTOCOL_VERSION, id, op: "daemon-stop" }));
      try {
        const reply = JSON.parse(await readLine(socket, 70_000)) as DaemonResponse;
        if (!reply.ok || reply.id !== id) throw uncertain("the daemon did not acknowledge shutdown");
      } catch (error) {
        // A native stop can close the pinned connection before the request replies.
        // Only confirmed death of that same process permits proceeding.
        if (processBirth(owner.pid) === owner.start) throw error;
      }
    }
    if (service) service.remove(receipt, true);
    else {
      submitSystemdUnitControl("stop", plan.unit);
      submitSystemdUnitRegistration("disable", plan.unit);
    }
    if (socket && owner?.start && processBirth(owner.pid) === owner.start) {
      const id = randomUUID().replaceAll("-", "");
      stopCommitted = true;
      socket.write(encode({ v: DAEMON_PROTOCOL_VERSION, id, op: "daemon-stop", commit: true }));
      try {
        const reply = JSON.parse(await readLine(socket, 5000)) as DaemonResponse;
        if (!reply.ok || reply.id !== id) throw uncertain("the daemon did not commit shutdown");
      } catch (error) {
        // Native End/bootout may close the pinned transport just before the process
        // disappears. These observed transport losses are not a refusal or absence:
        // continue to the bounded process + endpoint + lifetime checks below.
        const code = (error as NodeJS.ErrnoException).code;
        const ended = error instanceof Error && error.message === "daemon closed the connection without a reply";
        if (code !== "EPIPE" && code !== "ECONNRESET" && !ended && processBirth(owner.pid) === owner.start) throw error;
      }
    }
    socket?.destroy();
    const deadline = Date.now() + 130_000;
    const observeUntil = Date.now() + (exclusion ? 250 : 0);
    for (;;) {
      let absent = false;
      try { const probe = await openVerified({ paths, timeoutMs: 1000 }); probe.destroy(); }
      catch (error) {
        if (error instanceof EndpointRefusal && error.code === "NOT_RUNNING") absent = true;
        // A Linux probe can connect just before unlink and read the lifetime after release.
        // Reobserve a vanished path, but still require endpoint absence and process exit.
        else if ((error as NodeJS.ErrnoException).code !== "ECONNRESET"
          && !(process.platform === "darwin" && error instanceof ClosedPeerRefusal)
          && !(process.platform === "linux" && socket && error instanceof EndpointRefusal && error.code === "PEER_NOT_LOCK_OWNER" && !existsSync(paths.socket))
          && !(process.platform === "win32" && stopCommitted && isStoppingLifetime(error, owner))) throw error;
      }
      if (absent && (!socket || !owner || (owner.start && processBirth(owner.pid) !== owner.start)) && Date.now() >= observeUntil) break;
      if (Date.now() >= deadline) throw uncertain("daemon shutdown was not confirmed within 130s");
      await delay(50);
    }
    // A delayed native child must acquire this same lock and recheck its receipt before
    // publishing. Keep exclusion through final absence and both deletions.
    exclusion ??= excludeLifetime(paths.lock);
    try { const probe = await openVerified({ paths, timeoutMs: 1000 }); probe.destroy(); throw uncertain("a daemon endpoint still answers"); }
    catch (error) { if (!(error instanceof EndpointRefusal && error.code === "NOT_RUNNING")) throw error; }
    // The wait above must not turn a changed source/receipt into deletion authority.
    const current = recordedUnit(paths, daemonHome, nativeRun, recovered === true).receipt;
    if (current.unitSha256 !== receipt.unitSha256 || current.installedAt !== receipt.installedAt) throw uncertain("the daemon installation changed during shutdown");
    let removedServiceRecords: string[];
    try { removedServiceRecords = removeAllServiceRecords(daemonHome ?? dirname(paths.state)); }
    catch { throw uncertain("removing local service credentials and identity records failed; some records may remain. Repair their permissions and retry uninstall; the remote records may remain until you remove the computer in the dashboard"); }
    rmSync(plan.unitPath, { force: true });
    if (!service) submitSystemdUnitRegistration("reload", plan.unit);
    rmSync(unitReceiptFile(paths), { force: true });
    return { ...plan, state: "removed", removedServiceRecords };
  } finally { socket?.destroy(); exclusion?.release(); }
}
