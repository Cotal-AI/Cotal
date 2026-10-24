import { spawnSync } from "node:child_process";
import { lstatSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { assertRecordIdentity, CommandFailure, protectedLocalDirectory } from "@cotal-ai/workspace";
import type { ServiceInstance } from "./service-instances.js";
import type { serviceSupervisorProjection } from "./service-supervision.js";

type RecordedSupervisor = ReturnType<typeof serviceSupervisorProjection>;
const properties = ["Id", "LoadState", "ActiveState", "SubState", "UnitFileState", "MainPID", "InvocationID", "FragmentPath", "NeedDaemonReload", "DropInPaths"] as const;

/** The user manager's own config directory, never this CLI shell's XDG override. A missing
 *  bus or malformed environment is a refusal, not permission to guess a home path. */
export function systemdUserUnitDirectory(): string {
  if (process.platform !== "linux") throw new CommandFailure("refused", "UNSUPPORTED", "this native unit directory read requires a Linux systemd user manager");
  const result = spawnSync("systemctl", ["--user", "show-environment"], { encoding: "utf8", timeout: 2000, maxBuffer: 64 * 1024, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  if (result.error || result.signal || result.status !== 0 || typeof result.stdout !== "string") throw new CommandFailure("refused", "DEPENDENCY_UNAVAILABLE", "the systemd user manager did not answer its bounded environment read; no unit directory was guessed");
  const paths = new Map<string, string>();
  for (const line of result.stdout.split("\n")) {
    if (!line) continue;
    const index = line.indexOf("=");
    if (index < 1) throw new CommandFailure("refused", "SCHEMA_INVALID", "the user manager returned an invalid environment line; no directory was selected");
    const name = line.slice(0, index);
    if (name !== "HOME" && name !== "XDG_CONFIG_HOME") continue;
    if (paths.has(name)) throw new CommandFailure("refused", "SCHEMA_INVALID", "the user manager returned duplicate directory variables; no directory was selected");
    paths.set(name, line.slice(index + 1));
  }
  const xdg = paths.get("XDG_CONFIG_HOME"), home = paths.get("HOME");
  const config = xdg === undefined || xdg === "" ? home && join(home, ".config") : xdg;
  if (!config || !isAbsolute(config) || config.length > 4096 || /[\u0000-\u001f\u007f]/u.test(config)) throw new CommandFailure("refused", "TARGET_UNAVAILABLE", "the user manager did not identify a bounded absolute config directory; no shell HOME or relative XDG path was substituted");
  return join(config, "systemd", "user");
}

/** An exact recorded user-unit read. Never discovers a unit by process name/cwd, reads its
 *  environment, invokes a unit action/reload, or interprets output as an action recipe. */
export function observeRecordedSupervisor(instance: ServiceInstance, recorded: Pick<RecordedSupervisor, "mechanism" | "fileObservation" | "unit" | "unitPath">) {
  const observedAt = new Date().toISOString();
  const unavailable = (reason: string) => ({ state: "unavailable" as const, observedAt, reason, unit: recorded.unit, activeState: null, subState: null, loadState: null, unitFileState: null, mainPid: null, invocationId: null, mainProcessAttribution: "not-checked" as const, daemonReloadRequired: null, dropInsReported: null, readiness: "not-checked" as const });
  if (recorded.mechanism === "none-recorded") return unavailable("no supervisor is recorded; external OS supervision was not discovered");
  if (recorded.mechanism !== "systemd-user" || process.platform !== "linux") return unavailable("the recorded supervisor has no supported native status reader on this platform");
  if (recorded.fileObservation !== "matches-recorded-bytes" || !recorded.unit || !recorded.unitPath) return unavailable("the recorded unit file is missing, modified, unreadable or belongs to another host");
  const result = spawnSync("systemctl", ["--user", "show", recorded.unit, ...properties.map((name) => `--property=${name}`), "--all", "--no-pager", "--no-ask-password"], { encoding: "utf8", timeout: 1500, maxBuffer: 32 * 1024, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  if (result.error || result.status !== 0 || result.signal) return unavailable("the native user-manager status read did not return a complete result; no native diagnostic body was copied");
  const values = new Map<string, string>();
  for (const line of result.stdout.split("\n")) {
    if (!line) continue;
    const index = line.indexOf("=");
    if (index < 1) return unavailable("the native user-manager status has an invalid property record");
    const name = line.slice(0, index), value = line.slice(index + 1);
    if (!(properties as readonly string[]).includes(name) || values.has(name) || /[\u0000-\u001f\u007f]/u.test(value)) return unavailable("the native user-manager status has unexpected or duplicated properties");
    values.set(name, value);
  }
  if (values.size !== properties.length || values.get("Id") !== recorded.unit) return unavailable("the native user-manager did not identify the complete exact recorded unit");
  const mainPid = values.get("MainPID")!;
  if (!/^(?:0|[1-9][0-9]*)$/.test(mainPid) || !Number.isSafeInteger(Number(mainPid)) || Number(mainPid) > 2_147_483_647 || !/^(?:[0-9a-f]{32})?$/.test(values.get("InvocationID")!) || !["yes", "no"].includes(values.get("NeedDaemonReload")!)) return unavailable("the native user-manager returned invalid process/invocation coordinates");
  for (const name of ["LoadState", "ActiveState", "SubState", "UnitFileState"] as const) if (!/^[A-Za-z0-9_-]{1,80}$/.test(values.get(name)!)) return unavailable("the native user-manager returned an unsupported state label");
  try {
    if (realpathSync.native(values.get("FragmentPath")!) !== realpathSync.native(recorded.unitPath)) return unavailable("the native user-manager loaded a different unit fragment than the recorded file");
  } catch { return unavailable("the native user-manager did not establish the same physical recorded unit fragment"); }
  let mainProcessAttribution: "service-process" | "launcher" | "different-or-unattributed" | "not-reported" = Number(mainPid) === 0 ? "not-reported" : "different-or-unattributed";
  if (instance.process?.pid === Number(mainPid) && assertRecordIdentity(instance.process).kind === "match") mainProcessAttribution = "service-process";
  else if (instance.launcher.pid === Number(mainPid) && assertRecordIdentity(instance.launcher).kind === "match") mainProcessAttribution = "launcher";
  return { state: "observed" as const, observedAt, reason: null, unit: recorded.unit, activeState: values.get("ActiveState")!, subState: values.get("SubState")!, loadState: values.get("LoadState")!, unitFileState: values.get("UnitFileState")!, mainPid: Number(mainPid) || null, invocationId: values.get("InvocationID") || null, mainProcessAttribution, daemonReloadRequired: values.get("NeedDaemonReload") === "yes", dropInsReported: Boolean(values.get("DropInPaths")), readiness: "not-checked" as const };
}

/** One bounded user-manager mutation. A nonzero/timeout is unknown because native effects may
 *  have landed. Never copy systemctl output or retry the command after an uncertain result. */
export function submitSystemdUnitRegistration(step: "reload" | "enable" | "disable", unit: string): void {
  if (process.platform !== "linux" || !/^cotal-[0-9a-f]{64}\.service$/.test(unit)) throw new CommandFailure("refused", "USAGE_INVALID", "the native install step needs an exact owned service-unit name");
  const argv = ["--user", "--no-ask-password", "--no-pager", ...(step === "reload" ? ["daemon-reload"] : [step, unit])];
  const result = spawnSync("systemctl", argv, { encoding: "utf8", timeout: 15_000, maxBuffer: 32 * 1024, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  if (result.error || result.signal || result.status !== 0) throw new CommandFailure("unknown", "OPERATION_UNKNOWN", `the native ${step} request did not confirm completion; its exact user-unit state must be inspected before reconciliation`, { target: { unit, step } });
}

/** A verified source file and exact native fragment are prerequisites; a nominally enabled
 *  name cannot stand in for an inactive, unchanged unit with no drop-ins. */
export function submitSystemdUnitControl(operation: "start" | "stop", unit: string): void {
  if (process.platform !== "linux" || !/^cotal-[0-9a-f]{64}\.service$/.test(unit)) throw new CommandFailure("refused", "USAGE_INVALID", "the native service control needs one exact owned unit");
  const result = spawnSync("systemctl", ["--user", "--no-ask-password", "--no-pager", operation, unit], { encoding: "utf8", timeout: 30_000, maxBuffer: 32 * 1024, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  if (result.error || result.signal || result.status !== 0) throw new CommandFailure("unknown", "OPERATION_UNKNOWN", `the native ${operation} request did not confirm completion; it was not retried`, { target: { unit, operation } });
}

export function assertSystemdUnitAbsent(unit: string, unitPath: string): void {
  if (process.platform !== "linux" || !/^cotal-[0-9a-f]{64}\.service$/.test(unit)) throw new CommandFailure("refused", "USAGE_INVALID", "native removal requires one exact owned unit name");
  try {
    protectedLocalDirectory(dirname(unitPath));
    lstatSync(unitPath);
    throw new Error("unit file still present");
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new CommandFailure("unknown", "OPERATION_UNKNOWN", "the removed unit path did not confirm absence under its original physical parent"); }
  const requested = ["Id", "LoadState", "ActiveState", "UnitFileState", "MainPID", "FragmentPath", "NeedDaemonReload", "DropInPaths"] as const;
  const result = spawnSync("systemctl", ["--user", "show", unit, ...requested.map((name) => `--property=${name}`), "--all", "--no-pager", "--no-ask-password"], { encoding: "utf8", timeout: 1500, maxBuffer: 32 * 1024, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  if (result.error || result.signal || result.status !== 0 || typeof result.stdout !== "string") throw new CommandFailure("unknown", "OPERATION_UNKNOWN", "the native user manager did not confirm absence of the exact unit after reload");
  const values = new Map<string, string>();
  for (const line of result.stdout.split("\n")) {
    if (!line) continue;
    const index = line.indexOf("=");
    if (index < 1 || !requested.includes(line.slice(0, index) as typeof requested[number]) || values.has(line.slice(0, index))) throw new CommandFailure("unknown", "OPERATION_UNKNOWN", "the native absent-unit response is incomplete or ambiguous");
    values.set(line.slice(0, index), line.slice(index + 1));
  }
  if (values.size !== requested.length || values.get("Id") !== unit || values.get("LoadState") !== "not-found" || values.get("ActiveState") !== "inactive" || !["", "disabled"].includes(values.get("UnitFileState") ?? "invalid") || values.get("MainPID") !== "0" || values.get("FragmentPath") !== "" || values.get("NeedDaemonReload") !== "no" || values.get("DropInPaths") !== "") throw new CommandFailure("unknown", "OPERATION_UNKNOWN", "the user manager has not established an absent, unloaded, inactive exact unit");
}

export function assertSystemdInstallState(instance: ServiceInstance, unit: string, unitPath: string, autostart: "disabled" | "enabled"): void {
  const native = observeRecordedSupervisor(instance, { mechanism: "systemd-user", fileObservation: "matches-recorded-bytes", unit, unitPath });
  if (native.state !== "observed" || native.loadState !== "loaded" || native.activeState !== "inactive" || native.mainPid !== null || native.daemonReloadRequired || native.dropInsReported || native.unitFileState !== autostart) throw new CommandFailure("unknown", "OPERATION_UNKNOWN", "the native user manager did not confirm an unchanged, inactive unit with the required autostart state; no further install effect was submitted", { target: { unit, instanceId: instance.instanceId, observed: native.state, loadState: native.loadState, activeState: native.activeState, unitFileState: native.unitFileState } });
}
