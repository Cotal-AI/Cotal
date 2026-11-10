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
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { basename, delimiter, dirname, isAbsolute, join } from "node:path";
import { mkSecretDir, writeSecretFile, writeSecretFileAtomic } from "@cotal-ai/core";
import { codeSpan, CommandFailure } from "@cotal-ai/workspace";
import { assertSystemdSource, assertSystemdSourceDirectory, createSystemdSource, daemonArgv, submitSystemdUnitControl, submitSystemdUnitRegistration, systemdUserUnitDirectory } from "@cotal-ai/cli";
import type { DaemonPaths } from "./endpoint.js";
import { launchAgentService, xmlText } from "./install-darwin.js";
import { scheduledTaskService } from "./install-win32.js";
import { daemonCommandCopy } from "./guidance.js";

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
}

/** Where the receipt lives: beside the lifetime lock, in this daemon's own state directory. */
export function unitReceiptFile(paths: DaemonPaths): string {
  return join(paths.state, "service-unit.json");
}

/** `cotal-daemon.service`, or `cotal-daemon-<16 hex>.service` for an explicit daemon home, derived
 *  the same way its socket directory is so the two always agree. */
export function daemonUnitName(daemonHome: string | undefined): string {
  if (daemonHome === undefined) return "cotal-daemon.service";
  return `cotal-daemon-${createHash("sha256").update(daemonHome).digest("hex").slice(0, 16)}.service`;
}

function readReceipt(paths: DaemonPaths): UnitReceipt | undefined {
  let o: unknown;
  try { o = JSON.parse(readFileSync(unitReceiptFile(paths), "utf8")); } catch { return undefined; }
  if (!o || typeof o !== "object") return undefined;
  const r = o as Record<string, unknown>;
  if (r.v !== 1 || typeof r.unit !== "string" || typeof r.unitPath !== "string" || typeof r.unitSha256 !== "string" || typeof r.installedAt !== "string") return undefined;
  if (r.mechanism !== undefined && r.mechanism !== "systemd-user" && r.mechanism !== "launchd-agent" && r.mechanism !== "scheduled-task") return undefined;
  return { v: 1, ...(r.mechanism !== undefined ? { mechanism: r.mechanism } : {}), unit: r.unit, unitPath: r.unitPath, unitSha256: r.unitSha256, installedAt: r.installedAt, ...(typeof r.daemonHome === "string" ? { daemonHome: r.daemonHome } : {}) };
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
function pinnedPath(value = process.env.PATH ?? ""): string {
  const entries = value.split(delimiter).filter((entry) => entry !== "");
  if (!entries.length || entries.some((entry) => !isAbsolute(entry))) throw new CommandFailure("refused", "UNSUPPORTED", "the daemon unit needs an absolute, pinned PATH; a relative or empty entry was not inherited");
  return entries.join(delimiter);
}

export interface RenderedUnit {
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
    "Type=simple",
    `Environment=PATH=${unitValue(pinnedPath())}`,
    "Environment=COTAL_DAEMON_NATIVE_SERVICE=1",
    `ExecStart=${argv.map((part) => unitValue(part, true)).join(" ")}`,
    "Restart=always",
    "RestartSec=2",
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
    return [launcher, "--daemon", ...(daemonHome !== undefined ? ["--daemon-home", daemonHome] : [])];
  }
  return [...cli, "daemon", "serve", ...(daemonHome !== undefined ? ["--daemon-home", daemonHome] : [])];
}

/** One native tool call's outcome. `detail` is a bounded single line of its output for a refusal. */
export interface NativeResult {
  readonly status: number | null;
  readonly stdout: string;
  readonly detail: string;
}

/** Runs one native tool by absolute path with an argument vector, never through a shell. */
export type NativeRun = (file: string, args: readonly string[], env?: NodeJS.ProcessEnv) => NativeResult;

function nativeRun(file: string, args: readonly string[], env?: NodeJS.ProcessEnv): NativeResult {
  const result = spawnSync(file, args, { encoding: "utf8", timeout: 30_000, maxBuffer: 256 * 1024, stdio: ["ignore", "pipe", "pipe"], windowsHide: true, ...(env ? { env } : {}) });
  if (result.error || result.signal) throw new CommandFailure("refused", "DEPENDENCY_UNAVAILABLE", `${basename(file)} did not answer; no further native step was taken`);
  const stdout = typeof result.stdout === "string" ? result.stdout : "";
  const stderr = typeof result.stderr === "string" ? result.stderr : "";
  return { status: result.status, stdout, detail: (stderr.trim() || stdout.trim()).replace(/[\u0000-\u001f\u007f]+/gu, " ").slice(0, 300) };
}

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
  start(receipt: UnitReceipt): void;
  restart(receipt: UnitReceipt, reload?: boolean): void;
  remove(receipt: UnitReceipt): void;
}

/** This OS's per-user supervisor, or `undefined` on Linux, whose systemd route is below. */
function nativeService(): NativeService | undefined {
  if (process.platform === "linux") return undefined;
  if (process.platform === "darwin") return launchAgentService(nativeRun);
  if (process.platform === "win32") return scheduledTaskService(nativeRun);
  throw new CommandFailure("refused", "UNSUPPORTED", `cotal daemon install supports Linux, macOS and Windows; this is ${process.platform}, and no other supervisor was substituted`);
}

/** One bounded `loginctl` read or mutation for the invoking user. */
function loginctl(args: readonly string[]): { status: number | null; stdout: string } {
  const result = spawnSync("loginctl", [...args, "--no-ask-password", "--no-pager"], { encoding: "utf8", timeout: 15_000, maxBuffer: 32 * 1024, stdio: ["ignore", "pipe", "pipe"] });
  if (result.error || result.signal) throw new CommandFailure("refused", "DEPENDENCY_UNAVAILABLE", "loginctl did not answer; linger could not be established", { remedy: "make loginctl available on PATH and run from a logged-in session where it can reach systemd-logind, then retry" });
  return { status: result.status, stdout: typeof result.stdout === "string" ? result.stdout : "" };
}

function lingerEnabled(user: string): boolean {
  const read = loginctl(["show-user", user, "--property=Linger"]);
  // An unknown user (never logged in, no session) answers nonzero; that is "not lingering".
  return read.status === 0 && read.stdout.split("\n").includes("Linger=yes");
}

/** The user whose manager this install targets, read from the environment and never from argv. */
function invokingUser(): string {
  const user = process.env.USER || process.env.LOGNAME;
  if (!user || !/^[A-Za-z0-9._][A-Za-z0-9._-]{0,31}$/.test(user)) throw new CommandFailure("refused", "TARGET_UNAVAILABLE", "this session's USER and LOGNAME do not name the user whose systemd manager would run the daemon", { remedy: "run from a logged-in session of the user who will run the daemon (login sets USER and LOGNAME)" });
  return user;
}

export interface InstallPlan {
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
}

/** A directive's value in the bytes that will be written, so a receipt never states a policy the
 *  unit does not carry. A template that stops setting one is reported as absent, not assumed. */
function directive(bytes: string, name: string): string {
  return new RegExp(`\n${name}=(.*)\n`).exec(bytes)?.[1] ?? "absent";
}

function refuseInstalled(paths: DaemonPaths, daemonHome: string | undefined): void {
  const existing = readReceipt(paths);
  if (existing) throw new CommandFailure("refused", "CONFLICT", `this daemon already has an installed unit (${existing.unit})`, {
    remedy: `remove it with ${codeSpan(daemonCommandCopy("uninstall", daemonHome))} before installing again`,
  });
}

function nativeInstallPlan(service: NativeService, paths: DaemonPaths, daemonHome: string | undefined): NativePlan {
  refuseInstalled(paths, daemonHome);
  return service.plan(paths, daemonHome, daemonServeArgv(daemonHome), pinnedPath);
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
  refuseInstalled(paths, daemonHome);
  let present = false;
  try { lstatSync(rendered.unitPath); present = true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new CommandFailure("refused", "TARGET_UNAVAILABLE", `${rendered.unitPath} could not be inspected; no absent unit was inferred`); }
  if (present) throw new CommandFailure("refused", "CONFLICT", `${rendered.unitPath} already exists and no install of this daemon recorded it; it was not written over`);
  assertSystemdSourceDirectory(dirname(rendered.unitPath));
  return { mechanism: "systemd-user", unit: rendered.unit, unitPath: rendered.unitPath, sha256: rendered.sha256, user, lingerAlready: lingerEnabled(user),
    restart: directive(rendered.bytes, "Restart"), wantedBy: directive(rendered.bytes, "WantedBy"), ...(daemonHome !== undefined ? { daemonHome } : {}) };
}

export interface InstallResult extends InstallPlan {
  /** systemd only: linger is on once the install returns. */
  readonly lingerEnabled?: boolean;
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
export function applyInstall(paths: DaemonPaths, daemonHome: string | undefined): InstallResult {
  const service = nativeService();
  if (service) {
    const plan = nativeInstallPlan(service, paths, daemonHome);
    mkSecretDir(paths.state);
    service.publish(plan);
    writeReceipt(paths, { v: 1, mechanism: plan.mechanism, unit: plan.unit, unitPath: plan.unitPath, unitSha256: plan.sha256, installedAt: new Date().toISOString(), ...(daemonHome !== undefined ? { daemonHome } : {}) });
    service.register(plan);
    const { mechanism, unit, unitPath, sha256, user, restart, wantedBy } = plan;
    return { mechanism, unit, unitPath, sha256, user, restart, wantedBy, ...(daemonHome !== undefined ? { daemonHome } : {}), state: "installed" };
  }
  const plan = planInstall(paths, daemonHome);
  const rendered = renderDaemonUnit(dirname(plan.unitPath), daemonHome);
  // This daemon's own state directory, which holds the receipt below. It is ours, so it is created
  // 0700 and checked; the user manager's unit directory is the operator's and is only created when
  // it is absent, never hardened or repaired when it is already there.
  mkSecretDir(paths.state);
  const unitDir = join(rendered.unitPath, "..");
  mkdirSync(unitDir, { recursive: true, mode: 0o700 });
  createSystemdSource(rendered.unitPath, rendered.bytes, rendered.sha256);
  writeReceipt(paths, { v: 1, mechanism: "systemd-user", unit: rendered.unit, unitPath: rendered.unitPath, unitSha256: rendered.sha256, installedAt: new Date().toISOString(), ...(daemonHome !== undefined ? { daemonHome } : {}) });
  if (!plan.lingerAlready) {
    const enabled = loginctl(["enable-linger", plan.user]);
    if (enabled.status !== 0 || !lingerEnabled(plan.user)) throw new CommandFailure("refused", "PERMISSION_DENIED", `linger could not be enabled for ${plan.user}, so the recorded unit was not enabled or started. Remove it with \`cotal daemon uninstall\`, enable linger with loginctl enable-linger ${plan.user} and run this again`);
  }
  assertSystemdSource(rendered.unitPath, rendered.sha256);
  submitSystemdUnitRegistration("reload", rendered.unit);
  submitSystemdUnitRegistration("enable", rendered.unit);
  submitSystemdUnitControl("start", rendered.unit);
  return { ...plan, lingerEnabled: true, state: "installed" };
}

export interface UninstallPlan {
  readonly mechanism: ServiceMechanism;
  readonly unit: string;
  readonly unitPath: string;
  readonly installedAt: string;
}

/** The recorded unit, refused unless this OS runs its mechanism and its source and job are unchanged. */
function recordedUnit(paths: DaemonPaths, daemonHome: string | undefined): { receipt: UnitReceipt; plan: UninstallPlan; service: NativeService | undefined } {
  const service = nativeService();
  const receipt = readReceipt(paths);
  if (!receipt) throw new CommandFailure("refused", "TARGET_NOT_FOUND", "this daemon has no installed unit recorded by `cotal daemon install`; nothing was removed");
  const mechanism = receipt.mechanism ?? "systemd-user";
  if (mechanism !== (service ? service.mechanism : "systemd-user")) throw new CommandFailure("refused", "CONFLICT", `the recorded unit ${receipt.unit} is a ${mechanism} unit, which this OS does not run; nothing was removed`);
  try { lstatSync(receipt.unitPath); }
  catch { throw new CommandFailure("refused", "TARGET_NOT_FOUND", `the recorded unit file ${receipt.unitPath} is gone; nothing was removed. Delete ${unitReceiptFile(paths)} by hand to forget it`); }
  if (mechanism === "scheduled-task" && receipt.unitPath !== join(paths.state, "service-task.xml")) throw new CommandFailure("refused", "CONFLICT", "the scheduled-task receipt names a definition outside this daemon state; nothing was changed");
  if (service) service.check(receipt);
  else {
    const unit = daemonUnitName(daemonHome);
    if (receipt.daemonHome !== daemonHome || receipt.unit !== unit || receipt.unitPath !== join(systemdUserUnitDirectory(), unit))
      throw new CommandFailure("refused", "CONFLICT", "the systemd receipt does not name this daemon home's unit in the user manager's unit directory; nothing was changed");
    try { assertSystemdSource(receipt.unitPath, receipt.unitSha256); }
    catch { throw new CommandFailure("refused", "CONFLICT", `${receipt.unitPath} is not the unit this daemon installed; nothing was removed`); }
  }
  return { receipt, plan: { mechanism, unit: receipt.unit, unitPath: receipt.unitPath, installedAt: receipt.installedAt }, service };
}

/** The exact recorded unit `uninstall` would remove, refusing a receipt that no longer matches. */
export function planUninstall(paths: DaemonPaths, daemonHome: string | undefined): UninstallPlan {
  return recordedUnit(paths, daemonHome).plan;
}

/** Update only the PATH field the installer wrote. Windows tasks have no PATH pin. */
export function refreshedDaemonPath(mechanism: ServiceMechanism, source: string, terminalPath = process.env.PATH ?? ""): string | undefined {
  if (mechanism === "scheduled-task") return undefined;
  const pattern = mechanism === "systemd-user" ? /^Environment=PATH="((?:\\.|[^"\\])*)"$/m : /(<key>PATH<\/key>\s*<string>)([^<]*)(<\/string>)/;
  const match = pattern.exec(source);
  if (!match) throw new CommandFailure("refused", "CONFLICT", "the recorded daemon service has no readable pinned PATH; nothing was changed");
  const old = mechanism === "systemd-user"
    ? match[1]!.replace(/\\([\\"])/g, "$1").replaceAll("%%", "%")
    : match[2]!.replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&quot;", '"').replaceAll("&apos;", "'").replaceAll("&amp;", "&");
  const merged = [...new Set([...pinnedPath(terminalPath).split(delimiter), ...pinnedPath(old).split(delimiter)])].join(delimiter);
  return source.replace(pattern, () => mechanism === "systemd-user" ? `Environment=PATH=${unitValue(merged)}` : `${match[1]}${xmlText(merged)}${match[3]}`);
}

/** Prepare without changing disk or service state. The caller must hold the hosted seat fence
 *  before applying this installer-owned rewrite and restarting the service. */
export function planInstalledPathRefresh(paths: DaemonPaths, daemonHome?: string): (() => void) | undefined {
  const { receipt, plan } = recordedUnit(paths, daemonHome);
  if (plan.mechanism === "scheduled-task") return undefined;
  const source = readFileSync(receipt.unitPath, "utf8");
  const next = refreshedDaemonPath(plan.mechanism, source)!;
  const sha256 = createHash("sha256").update(next).digest("hex");
  return () => {
    const current = recordedUnit(paths, daemonHome).receipt;
    if (current.unitSha256 !== receipt.unitSha256) throw new CommandFailure("refused", "CONFLICT", "the recorded daemon service changed during setup; run setup again");
    writeSecretFileAtomic(receipt.unitPath, next);
    try { writeSecretFileAtomic(unitReceiptFile(paths), `${JSON.stringify({ ...receipt, unitSha256: sha256 })}\n`); }
    catch (error) { writeSecretFileAtomic(receipt.unitPath, source); throw error; }
    assertSystemdSource(receipt.unitPath, sha256);
    if (plan.mechanism === "systemd-user") submitSystemdUnitRegistration("reload", receipt.unit);
  };
}

/** Start only the recorded, unchanged service. This does not restart an already-running daemon. */
export function startInstalled(paths: DaemonPaths, daemonHome: string | undefined): UninstallPlan {
  const { receipt, plan, service } = recordedUnit(paths, daemonHome);
  if (service) service.start(receipt);
  else submitSystemdUnitControl("start", plan.unit);
  return plan;
}

/** The executable and entry pinned by the verified native source, compared with this CLI. */
export function installedDaemonIdentity(paths: DaemonPaths, daemonHome?: string): { same: boolean; installed: string; current: string } {
  const { receipt, plan } = recordedUnit(paths, daemonHome);
  const bytes = readFileSync(receipt.unitPath);
  const decode = (value: string) => value.replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&quot;", '"').replaceAll("&apos;", "'").replaceAll("&amp;", "&");
  let argv: string[];
  if (plan.mechanism === "systemd-user") {
    const line = /^ExecStart=(.*)$/m.exec(bytes.toString("utf8"))?.[1];
    if (!line) throw new CommandFailure("refused", "CONFLICT", "the recorded daemon unit has no readable executable and entry");
    argv = [...line.matchAll(/"((?:\\.|[^"\\])*)"|([^\s"]+)/g)].map(match => (match[1] ?? match[2]!).replace(/\\([\\"])/g, "$1").replaceAll("%%", "%").replaceAll("$$", "$"));
  } else if (plan.mechanism === "launchd-agent") {
    const array = /<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/.exec(bytes.toString("utf8"))?.[1] ?? "";
    argv = [...array.matchAll(/<string>([^<]*)<\/string>/g)].map(match => decode(match[1]!));
  } else {
    const text = bytes.subarray(2).toString("utf16le");
    const executable = decode(/<Command>([^<]*)<\/Command>/.exec(text)?.[1] ?? "");
    const args = decode(/<Arguments>([^<]*)<\/Arguments>/.exec(text)?.[1] ?? "");
    argv = [executable, ...[...args.matchAll(/"([^"]*)"|(\S+)/g)].map(match => match[1] ?? match[2]!)];
  }
  const expected = daemonServeArgv(receipt.daemonHome);
  const coordinate = (args: string[]) => {
    const daemon = args.indexOf("daemon");
    const entry = daemon >= 2 ? args[daemon - 1]! : args[0]!;
    return { executable: args[0], entry };
  };
  const installed = coordinate(argv), current = coordinate(expected);
  // launchd pins the adjacent cwd bootstrap instead of cotal.js itself.
  if (plan.mechanism === "launchd-agent") installed.entry = argv[argv.indexOf("daemon") - 2]!.replace(/daemon-cwd\.js$/, "cotal.js");
  if (plan.mechanism === "scheduled-task") installed.entry = installed.entry.replace(/daemon-native\.js$/, "cotal.js");
  if (!installed.executable || !installed.entry) throw new CommandFailure("refused", "CONFLICT", "the recorded daemon installation could not be identified");
  const canonical = (path: string) => { try { return realpathSync(path); } catch { return path; } };
  return { same: canonical(installed.executable) === canonical(current.executable!) && canonical(installed.entry) === canonical(current.entry), installed: `${installed.executable} ${installed.entry}`, current: `${current.executable} ${current.entry}` };
}

/** A native launch marker is trusted only with this installation's verified recorded source. */
export function daemonStartedByOwnedService(paths: DaemonPaths, daemonHome?: string): boolean {
  if (process.env.COTAL_DAEMON_NATIVE_SERVICE !== "1") return false;
  try {
    if (!installedDaemonIdentity(paths, daemonHome).same) return false;
    const { receipt, plan } = recordedUnit(paths, daemonHome);
    const source = readFileSync(receipt.unitPath).toString(plan.mechanism === "scheduled-task" ? "utf16le" : "utf8");
    return plan.mechanism === "systemd-user" ? source.includes("Environment=COTAL_DAEMON_NATIVE_SERVICE=1")
      : plan.mechanism === "launchd-agent" ? source.includes("<key>COTAL_DAEMON_NATIVE_SERVICE</key><string>1</string>")
      : source.includes("daemon-native.js");
  } catch { return false; }
}

/** Restart only the source and native job recorded for this daemon. */
export function restartInstalled(paths: DaemonPaths, daemonHome?: string, reload = false): UninstallPlan {
  const { receipt, plan, service } = recordedUnit(paths, daemonHome);
  if (service) service.restart(receipt, reload);
  else {
    submitSystemdUnitControl("stop", plan.unit);
    const result = nativeRun("systemctl", ["--user", "--no-ask-password", "--no-pager", "start", plan.unit]);
    if (result.status !== 0) throw new CommandFailure("unknown", "OPERATION_UNKNOWN", `the native daemon start did not confirm completion (${result.detail}); it was not retried`, { target: { unit: plan.unit }, remedy: "correct the native service error, then run cotal daemon start" });
  }
  return plan;
}

export interface UninstallResult extends UninstallPlan {
  readonly state: "removed";
}

/** Stop it, disable autostart, remove the unit and its receipt, and reload the user manager (on
 *  macOS and Windows, the adapter's own stop and deregistration). */
export function applyUninstall(paths: DaemonPaths, daemonHome: string | undefined): UninstallResult {
  const { receipt, plan, service } = recordedUnit(paths, daemonHome);
  if (service) {
    service.remove(receipt);
    rmSync(unitReceiptFile(paths), { force: true });
    return { ...plan, state: "removed" };
  }
  submitSystemdUnitControl("stop", plan.unit);
  submitSystemdUnitRegistration("disable", plan.unit);
  rmSync(plan.unitPath, { force: true });
  submitSystemdUnitRegistration("reload", plan.unit);
  rmSync(unitReceiptFile(paths), { force: true });
  return { ...plan, state: "removed" };
}
