/**
 * `cotal daemon install` and `cotal daemon uninstall`: the machine daemon as a systemd user service.
 *
 * It starts at login, restarts on its own when it dies, and keeps running after the operator logs
 * out, which on a headless box is what linger provides. The unit is written to the user manager's
 * own configuration directory and registered through the same bounded `systemctl --user` steps the
 * rest of this CLI uses for its owned units; nothing here is a second supervision mechanism.
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
import { lstatSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { delimiter, isAbsolute, join } from "node:path";
import { mkSecretDir, writeSecretFile } from "@cotal-ai/core";
import { CommandFailure } from "@cotal-ai/workspace";
import { assertSystemdSource, createSystemdSource, daemonArgv, submitSystemdUnitControl, submitSystemdUnitRegistration, systemdUserUnitDirectory } from "@cotal-ai/cli";
import type { DaemonPaths } from "./endpoint.js";

/** What `install` wrote, so `uninstall` acts on that exact unit and never on a name. */
export interface UnitReceipt {
  readonly v: 1;
  readonly unit: string;
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
  return { v: 1, unit: r.unit, unitPath: r.unitPath, unitSha256: r.unitSha256, installedAt: r.installedAt, ...(typeof r.daemonHome === "string" ? { daemonHome: r.daemonHome } : {}) };
}

/** systemd unquotes a whole item, then expands specifiers and `ExecStart` variables. */
function unitValue(value: string, exec = false): string {
  if (!value || value.length > 4096 || /[\u0000-\u001f\u007f]/u.test(value)) throw new CommandFailure("refused", "USAGE_INVALID", "the daemon unit needs bounded arguments without terminal controls; no unit bytes were prepared");
  const escaped = value.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("%", "%%");
  return `"${exec ? escaped.replaceAll("$", "$$") : escaped}"`;
}

/** The invocation's own `PATH`, pinned absolute. A relative or empty entry would resolve against
 *  whichever directory the unit happens to start in, so it refuses instead. */
function pinnedPath(): string {
  const value = process.env.PATH ?? "";
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
  // `daemonArgv()` is the durable Node binary, the daemon heap flags, and this CLI's own entry.
  const cli = daemonArgv();
  const entry = cli.at(-1);
  if (cli.length < 2 || entry === undefined) throw new CommandFailure("refused", "UNSUPPORTED", "the daemon unit needs this CLI's durable Node and entry paths; a transient loader was not pinned");
  if (!isAbsolute(cli[0]!) || !isAbsolute(entry)) throw new CommandFailure("refused", "UNSUPPORTED", "the daemon unit needs absolute Node and entry paths");
  if (!cli.slice(1, -1).every((flag) => /^--[A-Za-z][A-Za-z0-9-]*(?:=[^\s"]*)?$/.test(flag))) throw new CommandFailure("refused", "UNSUPPORTED", "the daemon unit pins only Node flags between its executable and its entry");
  if (cli[0]!.includes("$")) throw new CommandFailure("refused", "UNSUPPORTED", "the native executable path contains a systemd variable marker; the installer did not guess its expansion");
  const unit = daemonUnitName(daemonHome);
  const argv = [...cli, "daemon", "serve", ...(daemonHome !== undefined ? ["--daemon-home", daemonHome] : [])];
  const bytes = [
    "[Unit]",
    "Description=Cotal machine daemon",
    "",
    "[Service]",
    "Type=simple",
    `Environment=PATH=${unitValue(pinnedPath())}`,
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

/** One bounded `loginctl` read or mutation for the invoking user. */
function loginctl(args: readonly string[]): { status: number | null; stdout: string } {
  const result = spawnSync("loginctl", [...args, "--no-ask-password", "--no-pager"], { encoding: "utf8", timeout: 15_000, maxBuffer: 32 * 1024, stdio: ["ignore", "pipe", "pipe"] });
  if (result.error || result.signal) throw new CommandFailure("refused", "DEPENDENCY_UNAVAILABLE", "loginctl did not answer; linger could not be established and no unit was written");
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
  readonly unit: string;
  readonly unitPath: string;
  readonly sha256: string;
  readonly user: string;
  readonly lingerAlready: boolean;
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

/** Everything `install` would do, with no effect: the unit it would write and the linger it needs. */
export function planInstall(paths: DaemonPaths, daemonHome: string | undefined): InstallPlan {
  const user = invokingUser();
  const rendered = renderDaemonUnit(systemdUserUnitDirectory(), daemonHome);
  const existing = readReceipt(paths);
  if (existing) throw new CommandFailure("refused", "CONFLICT", `this daemon already has an installed unit (${existing.unit}); remove it with \`cotal daemon uninstall\` before installing again`);
  return { unit: rendered.unit, unitPath: rendered.unitPath, sha256: rendered.sha256, user, lingerAlready: lingerEnabled(user),
    restart: directive(rendered.bytes, "Restart"), wantedBy: directive(rendered.bytes, "WantedBy"), ...(daemonHome !== undefined ? { daemonHome } : {}) };
}

export interface InstallResult extends InstallPlan {
  readonly lingerEnabled: boolean;
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
  const plan = planInstall(paths, daemonHome);
  const rendered = renderDaemonUnit(systemdUserUnitDirectory(), daemonHome);
  // This daemon's own state directory, which holds the receipt below. It is ours, so it is created
  // 0700 and checked; the user manager's unit directory is the operator's and is only created when
  // it is absent, never hardened or repaired when it is already there.
  mkSecretDir(paths.state);
  const unitDir = join(rendered.unitPath, "..");
  mkdirSync(unitDir, { recursive: true, mode: 0o700 });
  if (!plan.lingerAlready) {
    const enabled = loginctl(["enable-linger", plan.user]);
    if (enabled.status !== 0 || !lingerEnabled(plan.user)) throw new CommandFailure("refused", "PERMISSION_DENIED", `linger could not be enabled for ${plan.user}, so a unit would stop at logout; nothing was installed. Enable it with loginctl enable-linger ${plan.user} and run this again`);
  }
  createSystemdSource(rendered.unitPath, rendered.bytes, rendered.sha256);
  writeSecretFile(unitReceiptFile(paths), `${JSON.stringify({ v: 1, unit: rendered.unit, unitPath: rendered.unitPath, unitSha256: rendered.sha256, installedAt: new Date().toISOString(), ...(daemonHome !== undefined ? { daemonHome } : {}) } satisfies UnitReceipt)}\n`);
  submitSystemdUnitRegistration("reload", rendered.unit);
  submitSystemdUnitRegistration("enable", rendered.unit);
  submitSystemdUnitControl("start", rendered.unit);
  return { ...plan, lingerEnabled: true, state: "installed" };
}

export interface UninstallPlan {
  readonly unit: string;
  readonly unitPath: string;
  readonly installedAt: string;
}

/** The exact recorded unit `uninstall` would remove, refusing a receipt that no longer matches. */
export function planUninstall(paths: DaemonPaths): UninstallPlan {
  const receipt = readReceipt(paths);
  if (!receipt) throw new CommandFailure("refused", "TARGET_NOT_FOUND", "this daemon has no installed unit recorded by `cotal daemon install`; nothing was removed");
  try { lstatSync(receipt.unitPath); }
  catch { throw new CommandFailure("refused", "TARGET_NOT_FOUND", `the recorded unit file ${receipt.unitPath} is gone; nothing was removed. Delete ${unitReceiptFile(paths)} by hand to forget it`); }
  try { assertSystemdSource(receipt.unitPath, receipt.unitSha256); }
  catch { throw new CommandFailure("refused", "CONFLICT", `${receipt.unitPath} is not the unit this daemon installed; nothing was removed`); }
  return { unit: receipt.unit, unitPath: receipt.unitPath, installedAt: receipt.installedAt };
}

export interface UninstallResult extends UninstallPlan {
  readonly state: "removed";
}

/** Stop it, disable autostart, remove the unit and its receipt, and reload the user manager. */
export function applyUninstall(paths: DaemonPaths): UninstallResult {
  const plan = planUninstall(paths);
  submitSystemdUnitControl("stop", plan.unit);
  submitSystemdUnitRegistration("disable", plan.unit);
  rmSync(plan.unitPath, { force: true });
  submitSystemdUnitRegistration("reload", plan.unit);
  rmSync(unitReceiptFile(paths), { force: true });
  return { ...plan, state: "removed" };
}
