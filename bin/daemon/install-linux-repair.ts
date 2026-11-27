import { lstatSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { acquireLock, acquireLockAsync, writeSecretFileAtomic } from "@cotal-ai/core";
import { assertSystemdSource, submitSystemdUnitRegistration, systemdUserUnitDirectory } from "@cotal-ai/cli";
import { codeSpan, CommandFailure, readLocalRecordSource } from "@cotal-ai/workspace";
import { checkDir, daemonUserServiceEnv, type DaemonPaths } from "./endpoint.js";
import { daemonCommandCopy } from "./guidance.js";
import { recordedSourceIdentity, recordedSystemdArgv } from "./install-identity.js";
import { nativeRun } from "./install-native-run.js";
import { readReceipt, unitReceiptFile } from "./install-receipt.js";
import { assertServiceRepairPair, readServiceRepair, servicePolicyRepairFile, sourceDigest, type ServiceRepairIntent } from "./service-repair.js";
import { daemonServeArgv, type NativeRun, type UnitReceipt } from "./install.js";

/** Only a missing runtime or CLI entry makes the recorded program a repair candidate. */
export function missingSystemdProgram(source: string): boolean {
  const argv = recordedSystemdArgv(source);
  const daemon = argv.length - (argv.at(-2) === "--daemon-home" ? 4 : 2);
  if (daemon < 2 || argv[daemon] !== "daemon" || argv[daemon + 1] !== "serve" || !isAbsolute(argv[0]!) || !isAbsolute(argv[daemon - 1]!)) {
    throw new CommandFailure("refused", "CONFLICT", "the recorded daemon unit has no readable executable and entry");
  }
  let missing = false;
  for (const path of [argv[0]!, argv[daemon - 1]!]) {
    try {
      if (!statSync(path).isFile()) throw new CommandFailure("refused", "CONFLICT", "the recorded daemon program is not a file; nothing was changed");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      missing = true;
    }
  }
  return missing;
}

/** Verify the loaded effective command separately from the fragment's on-disk digest. */
export function observeSystemdRepairUnit(run: NativeRun, receipt: UnitReceipt, source: string, previousSource?: string): { pid: number; settled: boolean; enabled: boolean; invocation: string } {
  const unavailable = () => new CommandFailure("refused", "TARGET_UNAVAILABLE", "the recorded systemd unit's loaded definition could not be verified; nothing was changed");
  const conflict = () => new CommandFailure("refused", "CONFLICT", "the loaded systemd unit does not prove the recorded source and command; nothing was changed");
  const fields = ["Id", "LoadState", "FragmentPath", "DropInPaths", "NeedDaemonReload", "Transient", "MainPID", "ControlPID", "ActiveState", "SubState", "UnitFileState", "InvocationID", "WorkingDirectory", "Job"];
  const read = run("systemctl", ["--user", "--no-ask-password", "--no-pager", "show", receipt.unit, "--all", ...fields.map(field => `--property=${field}`)], undefined, 5000);
  if (read.status !== 0) throw unavailable();
  const values = new Map<string, string>();
  for (const line of read.stdout.split("\n").filter(Boolean)) {
    const at = line.indexOf("="), field = line.slice(0, at), value = line.slice(at + 1);
    if (at < 1 || !fields.includes(field) || values.has(field) || /[\u0000-\u001f\u007f]/u.test(value)) throw unavailable();
    values.set(field, value);
  }
  if (values.size !== fields.length) throw unavailable();
  const needsReload = values.get("NeedDaemonReload");
  if (values.get("Id") !== receipt.unit || values.get("LoadState") !== "loaded" || values.get("FragmentPath") !== receipt.unitPath || values.get("DropInPaths") !== "" || (needsReload !== "no" && !(previousSource && needsReload === "yes")) || values.get("Transient") !== "no") throw conflict();
  if (values.get("WorkingDirectory") !== "") throw conflict();
  if (values.get("Job") !== "0" && values.get("Job") !== "") throw unavailable();
  const enabled = values.get("UnitFileState");
  const pid = Number(values.get("MainPID")), invocation = values.get("InvocationID")!;
  if (!/^(0|[1-9][0-9]*)$/.test(values.get("MainPID")!) || pid > 2_147_483_647 || values.get("ControlPID") !== "0" || !/^(?:[0-9a-f]{32})?$/.test(invocation) || !["enabled", "disabled"].includes(enabled!)) throw unavailable();
  const active = values.get("ActiveState"), sub = values.get("SubState");
  const settled = pid === 0 && ((active === "inactive" && sub === "dead") || (active === "failed" && sub === "failed"));
  if (!settled && !(pid > 0 && active === "active" && sub === "running" && invocation && !/^0+$/.test(invocation)) && !(pid === 0 && active === "activating" && sub === "auto-restart")) throw unavailable();
  const object = receipt.unit.replace(/[^a-zA-Z0-9]/g, char => `_${char.charCodeAt(0).toString(16)}`);
  const exec = run("busctl", ["--user", "--no-pager", "--timeout=5s", "--json=short", "get-property", "org.freedesktop.systemd1", `/org/freedesktop/systemd1/unit/${object}`, "org.freedesktop.systemd1.Service", "ExecStartEx", "ExecStopEx", "ExecStopPostEx"], undefined, 6000);
  if (exec.status !== 0) throw unavailable();
  let properties: ({ type?: unknown; data?: unknown } | null)[];
  try { properties = exec.stdout.trim().split("\n").map(line => JSON.parse(line)); } catch { throw unavailable(); }
  if (properties.length !== 3 || properties.some(prop => prop?.type !== "a(sasasttttuii)" || !Array.isArray(prop.data))) throw unavailable();
  if (properties.slice(1).some(prop => JSON.stringify(prop?.data) !== "[]")) throw conflict();
  const value = properties[0];
  if (value?.type !== "a(sasasttttuii)" || !Array.isArray(value.data) || value.data.length !== 1 || !Array.isArray(value.data[0]) || value.data[0].length !== 10) throw unavailable();
  const [program, args, flags] = value.data[0];
  const argv = recordedSystemdArgv(source);
  const suffix = receipt.daemonHome === undefined ? ["daemon", "serve"] : ["daemon", "serve", "--daemon-home", receipt.daemonHome];
  if (JSON.stringify(argv.slice(-suffix.length)) !== JSON.stringify(suffix)) throw conflict();
  const matches = (expected: string[]) => program === expected[0] && JSON.stringify(args) === JSON.stringify(expected.map((part, i) => i ? part.replaceAll("$", "$$$$") : part));
  if (JSON.stringify(flags) !== "[]" || (!matches(argv) && !(previousSource && settled && matches(recordedSystemdArgv(previousSource))))) throw conflict();
  // Reload can replace ExecStart while retaining MainPID from an earlier command.
  if (pid > 0 && value.data[0][7] !== pid) throw conflict();
  if (needsReload !== "no" && !settled) throw conflict();
  return { pid, settled, enabled: enabled === "enabled", invocation };
}

/** Add OOMPolicy=continue to an unmodified stock unit that has not yet configured OOMPolicy. */
export function upgradedSystemdOomPolicy(source: string): string | undefined {
  if (/^[ \t]*OOMPolicy=/m.test(source)) return undefined;
  if (/^KillMode=mixed$/m.test(source)) return source.replace(/^KillMode=mixed$/m, "KillMode=mixed\nOOMPolicy=continue");
  if (/^Restart=always$/m.test(source)) return source.replace(/^Restart=always$/m, "Restart=always\nOOMPolicy=continue");
  return undefined;
}

function decodeSystemdEnvValue(value: string): string | undefined {
  if (!value.startsWith("$'")) return value;
  if (!value.endsWith("'")) return undefined;
  const bytes: Buffer[] = [];
  const escapes: Record<string, string> = { a: "\x07", b: "\b", f: "\f", n: "\n", r: "\r", t: "\t", v: "\v", "\\": "\\", "'": "'", '"': '"' };
  const body = value.slice(2, -1);
  for (let i = 0; i < body.length;) {
    if (body[i] === "'") return undefined;
    if (body[i] !== "\\") {
      const end = body.indexOf("\\", i), text = body.slice(i, end < 0 ? undefined : end);
      if (text.includes("'")) return undefined;
      bytes.push(Buffer.from(text));
      i += text.length;
      continue;
    }
    const escaped = body[++i];
    if (escaped !== undefined && Object.hasOwn(escapes, escaped)) { bytes.push(Buffer.from(escapes[escaped]!)); i++; continue; }
    const octal = body.slice(i, i + 3);
    if (!/^[0-3][0-7]{2}$/.test(octal)) return undefined;
    bytes.push(Buffer.from([Number.parseInt(octal, 8)]));
    i += 3;
  }
  try { return new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(bytes)); }
  catch { return undefined; }
}

function systemdDropInDirectoryNames(unit: string): string[] {
  const names = new Set([`${unit}.d`]);
  const suffixIndex = unit.lastIndexOf(".");
  if (suffixIndex > 0) {
    const stem = unit.slice(0, suffixIndex), suffix = unit.slice(suffixIndex);
    names.add(`${suffix.slice(1)}.d`);
    const parts = stem.split("-");
    for (let count = parts.length - 1; count >= 1; count--) {
      const prefix = parts.slice(0, count).join("-");
      if (prefix) names.add(`${prefix}-${suffix}.d`);
    }
  }
  return [...names];
}

function hasUnitDropInOnDisk(run: NativeRun, unit: string, unitPath: string, env?: NodeJS.ProcessEnv): boolean {
  const envRead = run("systemctl", ["--user", "show-environment"], env, 2000);
  if (envRead.status !== 0) return true;
  const mgr: Record<string, string> = {};
  for (const line of envRead.stdout.split("\n")) {
    if (!line) continue;
    const at = line.indexOf("=");
    if (at < 1) return true;
    const name = line.slice(0, at);
    if (!["HOME", "XDG_CONFIG_HOME", "XDG_CONFIG_DIRS", "XDG_DATA_HOME", "XDG_DATA_DIRS", "XDG_RUNTIME_DIR"].includes(name)) continue;
    const decoded = decodeSystemdEnvValue(line.slice(at + 1));
    if (decoded === undefined || mgr[name] !== undefined) return true;
    mgr[name] = decoded;
  }
  const dirs = new Set<string>();
  const add = (dir?: string) => { if (dir && isAbsolute(dir) && dir.length <= 4096 && !/[\u0000-\u001f\u007f]/u.test(dir)) dirs.add(dir); };
  add(dirname(unitPath));
  add(`${dirname(unitPath)}.control`);
  for (const src of [mgr, env ?? {}]) {
    const home = src.HOME, cfg = src.XDG_CONFIG_HOME || (home ? join(home, ".config") : undefined);
    const data = src.XDG_DATA_HOME || (home ? join(home, ".local", "share") : undefined), rt = src.XDG_RUNTIME_DIR;
    if (cfg) { add(join(cfg, "systemd", "user")); add(join(cfg, "systemd", "user.control")); }
    if (home) { add(join(home, ".config", "systemd", "user")); add(join(home, ".config", "systemd", "user.control")); add(join(home, ".local", "share", "systemd", "user")); }
    if (data) add(join(data, "systemd", "user"));
    if (rt) for (const sub of ["user", "user.control", "transient", "generator", "generator.early", "generator.late"]) add(join(rt, "systemd", sub));
    for (const entry of (src.XDG_CONFIG_DIRS || "/etc/xdg").split(":")) if (entry) add(join(entry, "systemd", "user"));
    for (const entry of (src.XDG_DATA_DIRS || "/usr/local/share:/usr/share").split(":")) if (entry) add(join(entry, "systemd", "user"));
  }
  for (const sys of ["/etc/systemd/user", "/run/systemd/user", "/usr/local/lib/systemd/user", "/usr/lib/systemd/user", "/lib/systemd/user"]) add(sys);
  const dropInNames = systemdDropInDirectoryNames(unit);
  for (const dir of dirs) {
    for (const dropInName of dropInNames) {
      const candidate = join(dir, dropInName);
      try {
        if (!statSync(candidate).isDirectory()) return true;
        if (readdirSync(candidate).some(entry => !entry.startsWith(".") && entry.endsWith(".conf"))) return true;
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== "ENOENT" && code !== "ENOTDIR") return true;
      }
    }
  }
  return false;
}

/** Inspect every loaded user unit in one call so daemon-reload never applies another unit's pending change. */
function observeOtherUnitsNeedDaemonReload(run: NativeRun, ownUnit: string, env?: NodeJS.ProcessEnv): "none" | "other-pending" | "unverified" {
  let read: ReturnType<NativeRun>;
  try {
    read = run("systemctl", ["--user", "--no-ask-password", "--no-pager", "show", "*", "--all", "--property=Id,NeedDaemonReload"], env, 5000);
  } catch { return "unverified"; }
  if (read.status !== 0) return "unverified";
  const blocks = read.stdout.replace(/\r\n/g, "\n").trimEnd().split("\n\n").filter(Boolean);
  if (blocks.length === 0) return "unverified";
  let sawOwnUnit = false;
  for (const block of blocks) {
    let id: string | undefined, needsReload: string | undefined;
    for (const line of block.split("\n")) {
      const at = line.indexOf("=");
      if (at < 1) return "unverified";
      const key = line.slice(0, at), val = line.slice(at + 1);
      if (/[\u0000-\u001f\u007f]/u.test(val)) return "unverified";
      if (key === "Id" && id === undefined) id = val;
      else if (key === "NeedDaemonReload" && needsReload === undefined) needsReload = val;
      else return "unverified";
    }
    if (!id || (needsReload !== "yes" && needsReload !== "no")) return "unverified";
    if (id === ownUnit) sawOwnUnit = true;
    else if (needsReload !== "no") return "other-pending";
  }
  return sawOwnUnit ? "none" : "unverified";
}

type SystemdPolicyUnitState =
  | { readonly loaded: false }
  | { readonly loaded: true; readonly dropInPaths: string; readonly needsReload: boolean; readonly oomPolicy: string; readonly dropInOnDisk: boolean };

function readSystemdPolicyUnitState(run: NativeRun, unit: string, unitPath: string, env?: NodeJS.ProcessEnv): SystemdPolicyUnitState {
  try {
    const fields = ["Id", "LoadState", "FragmentPath", "DropInPaths", "NeedDaemonReload", "OOMPolicy"];
    const read = run("systemctl", ["--user", "--no-ask-password", "--no-pager", "show", unit, "--all", ...fields.map(field => `--property=${field}`)], env, 5000);
    if (read.status !== 0) return { loaded: false };
    const values = new Map<string, string>();
    for (const line of read.stdout.split("\n").filter(Boolean)) {
      const at = line.indexOf("="), field = line.slice(0, at), value = line.slice(at + 1);
      if (at < 1 || !fields.includes(field) || values.has(field) || /[\u0000-\u001f\u007f]/u.test(value)) return { loaded: false };
      values.set(field, value);
    }
    const needsReload = values.get("NeedDaemonReload");
    if (values.size !== fields.length || values.get("Id") !== unit || values.get("LoadState") !== "loaded" || values.get("FragmentPath") !== unitPath || (needsReload !== "yes" && needsReload !== "no")) return { loaded: false };
    return { loaded: true, dropInPaths: values.get("DropInPaths")!, needsReload: needsReload === "yes", oomPolicy: values.get("OOMPolicy")!, dropInOnDisk: hasUnitDropInOnDisk(run, unit, unitPath, env) };
  } catch { return { loaded: false }; }
}

function isInPlaceOomPolicyIntent(intent: ServiceRepairIntent): boolean {
  return (intent.receipt.mechanism ?? "systemd-user") === "systemd-user" && upgradedSystemdOomPolicy(intent.previousSource) === intent.nextSource;
}

function policySkippedReport(unit: string, reason: string): string {
  return `machine daemon: ${unit} left unchanged (${reason}); Cotal did not update or reload OOMPolicy`;
}

function reloadFailedReport(unit: string): string {
  return `machine daemon: ${unit} updated with OOMPolicy=continue, but systemctl --user daemon-reload failed; run \`systemctl --user daemon-reload\` or retry \`cotal update\``;
}

function reloadSkippedReport(unit: string, reason?: string): string {
  return `machine daemon: ${unit} needs a reload (\`systemctl --user daemon-reload\`)${reason ? ` (${reason})` : ""}, and Cotal did not reload it`;
}

function systemdUnavailableReason(error: unknown): string {
  if (error instanceof CommandFailure && error.native?.code === "ENOENT") return "systemctl was not found";
  const message = error instanceof Error ? error.message : "";
  if (message.includes("ENOENT")) return "systemctl was not found";
  return "the systemd user manager did not answer";
}

function resolveUserUnitDirectory(env: NodeJS.ProcessEnv): { readonly dir: string } | { readonly reason: string } {
  let probe: ReturnType<NativeRun>;
  try {
    probe = nativeRun("systemctl", ["--user", "show-environment"], env, 2000);
  } catch (error) {
    return { reason: systemdUnavailableReason(error) };
  }
  if (probe.status !== 0) return { reason: "the systemd user manager did not answer" };
  try { return { dir: systemdUserUnitDirectory(env) }; }
  catch (error) { return { reason: systemdUnavailableReason(error) }; }
}

function submitPolicyReload(unit: string, env: NodeJS.ProcessEnv, report?: (line: string) => void): boolean {
  try {
    submitSystemdUnitRegistration("reload", unit, env);
    return true;
  } catch {
    report?.(reloadFailedReport(unit));
    return false;
  }
}

function reloadUpgradedPolicyIfSafe(paths: Pick<DaemonPaths, "state">, receipt: UnitReceipt, env: NodeJS.ProcessEnv, report?: (line: string) => void, state = readSystemdPolicyUnitState(nativeRun, receipt.unit, receipt.unitPath, env)): boolean {
  let digestMatchesReceipt = false;
  try {
    assertSystemdSource(receipt.unitPath, receipt.unitSha256);
    digestMatchesReceipt = readReceipt(paths)?.unitSha256 === receipt.unitSha256;
  } catch { digestMatchesReceipt = false; }
  if (!digestMatchesReceipt) {
    report?.(reloadSkippedReport(receipt.unit, "the unit file was modified"));
    return false;
  }
  if (!state.loaded) {
    report?.(reloadSkippedReport(receipt.unit, "the systemd user manager did not verify the loaded unit"));
    return false;
  }
  if (state.dropInPaths !== "" || state.dropInOnDisk) {
    report?.(reloadSkippedReport(receipt.unit, "drop-ins are present"));
    return false;
  }
  if (state.oomPolicy === "continue") {
    if (state.needsReload) report?.(reloadSkippedReport(receipt.unit, "the unit has a pending reload"));
    return false;
  }
  const otherUnits = observeOtherUnitsNeedDaemonReload(nativeRun, receipt.unit, env);
  if (otherUnits !== "none") {
    report?.(reloadSkippedReport(receipt.unit, otherUnits === "other-pending" ? "another user unit has a pending reload" : "loaded user units could not be verified"));
    return false;
  }
  return submitPolicyReload(receipt.unit, env, report);
}

function hasPolicyRepairFile(state: string): boolean {
  try { lstatSync(servicePolicyRepairFile(state)); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
}

/** Finish a journaled in-place OOMPolicy upgrade under an already held service-repair.lock. */
function completeInPlaceOomPolicyIntent(paths: Pick<DaemonPaths, "state">, daemonHome: string | undefined, expectedUnit: string, report?: (line: string) => void): boolean {
  const intent = readServiceRepair(paths.state, servicePolicyRepairFile(paths.state));
  if (!intent) return false;
  if (!isInPlaceOomPolicyIntent(intent)) throw new CommandFailure("refused", "CONFLICT", "the recorded daemon unit OOMPolicy repair intent is invalid; nothing was changed");
  const actual = readReceipt(paths);
  if (!actual || actual.daemonHome !== daemonHome || intent.receipt.daemonHome !== daemonHome || actual.unit !== expectedUnit)
    throw new CommandFailure("refused", "CONFLICT", "the recorded daemon service repair intent names another daemon home");
  const env = daemonUserServiceEnv();
  if (actual.unitPath !== join(systemdUserUnitDirectory(env), expectedUnit))
    throw new CommandFailure("refused", "CONFLICT", "the systemd receipt does not name this daemon home's unit in the user manager's unit directory; nothing was changed");
  const source = readLocalRecordSource(actual.unitPath, 64 * 1024, true)?.toString("utf8");
  if (!source) throw new CommandFailure("refused", "CONFLICT", "the recorded daemon unit source could not be verified");
  assertServiceRepairPair(intent, actual, source);
  assertSystemdSource(actual.unitPath, sourceDigest(source));
  const nextSha = sourceDigest(intent.nextSource);
  if (source !== intent.nextSource) writeSecretFileAtomic(actual.unitPath, intent.nextSource);
  assertSystemdSource(actual.unitPath, nextSha);
  const nextReceipt: UnitReceipt = { ...intent.receipt, unitSha256: nextSha };
  if (actual.unitSha256 !== nextSha) writeSecretFileAtomic(unitReceiptFile(paths), `${JSON.stringify(nextReceipt)}\n`);
  rmSync(servicePolicyRepairFile(paths.state), { force: true });
  const state = readSystemdPolicyUnitState(nativeRun, nextReceipt.unit, nextReceipt.unitPath, env);
  if (state.loaded && !state.needsReload && state.oomPolicy === "continue" && !(state.dropInPaths === "" && state.dropInOnDisk)) return false;
  return reloadUpgradedPolicyIfSafe(paths, nextReceipt, env, report, state);
}

/** Complete an interrupted OOMPolicy update with its own refusal sentence and remedy before missing-program checks. */
export async function finishRecordedOomPolicyIntent(paths: Pick<DaemonPaths, "state">, daemonHome: string | undefined, expectedUnit: string, report?: (line: string) => void): Promise<void> {
  const file = servicePolicyRepairFile(paths.state);
  const remedy = `inspect ${file} and the recorded unit file; restore the recorded unit if it was modified during the update, then run ${codeSpan(daemonCommandCopy("status", daemonHome))}`;
  try {
    if (!hasPolicyRepairFile(paths.state)) return;
    checkDir(paths.state);
  } catch (error) {
    throw new CommandFailure("refused", error instanceof CommandFailure ? error.code : "TARGET_UNAVAILABLE", `could not finish the interrupted daemon unit OOMPolicy update: ${(error as Error).message}`, { remedy });
  }
  const lock = await acquireLockAsync(join(paths.state, "service-repair.lock"), {
    onTimeout: () => new CommandFailure("refused", "CONFLICT", "could not finish the interrupted daemon unit OOMPolicy update: another command is still repairing the recorded service. Run `cotal daemon status` to check it", { remedy }),
  });
  try {
    completeInPlaceOomPolicyIntent(paths, daemonHome, expectedUnit, report);
  } catch (error) {
    const code = error instanceof CommandFailure ? error.code : "CONFLICT";
    const detail = (error as Error).message;
    throw new CommandFailure("refused", code, detail.startsWith("could not finish the interrupted daemon unit OOMPolicy update:") ? detail : `could not finish the interrupted daemon unit OOMPolicy update: ${detail}`, {
      remedy: error instanceof CommandFailure && error.remedy ? error.remedy : remedy,
    });
  } finally { lock.release(); }
}

/** Upgrade an unmodified same-installation Linux unit's OOMPolicy in place without restarting running seats. */
export function reconcileInstalledSystemdOomPolicy(paths: Pick<DaemonPaths, "state">, daemonHome?: string, expectedUnit = "cotal-daemon.service", report?: (line: string) => void): boolean {
  if (process.platform !== "linux") return false;
  const skip = (unit: string, reason: string) => { report?.(policySkippedReport(unit, reason)); return false; };
  const pending = hasPolicyRepairFile(paths.state);
  const existing = readReceipt(paths);
  if (!existing || (existing.mechanism ?? "systemd-user") !== "systemd-user" || existing.daemonHome !== daemonHome || existing.unit !== expectedUnit) {
    if (!pending) return false;
  }
  let candidateUnit = existing?.unit ?? expectedUnit;
  if (!pending && existing) {
    const raw = readLocalRecordSource(existing.unitPath, 64 * 1024, true)?.toString("utf8");
    if (!raw) return skip(existing.unit, "the unit file could not be verified");
    if (sourceDigest(raw) !== existing.unitSha256) return skip(existing.unit, "the unit file was modified");
    if (upgradedSystemdOomPolicy(raw) === undefined && !/^[ \t]*OOMPolicy=continue$/m.test(raw)) {
      return skip(existing.unit, /^[ \t]*OOMPolicy=/m.test(raw) ? "OOMPolicy is already set" : "the unit file has custom service settings");
    }
  }
  let lock: ReturnType<typeof acquireLock>;
  try {
    lock = acquireLock(join(paths.state, "service-repair.lock"), { waitMs: 0, label: "service-repair" });
  } catch { return skip(candidateUnit, "another service repair is in progress"); }
  try {
    if (hasPolicyRepairFile(paths.state)) return completeInPlaceOomPolicyIntent(paths, daemonHome, expectedUnit, report);
    const receipt = readReceipt(paths);
    if (!receipt || (receipt.mechanism ?? "systemd-user") !== "systemd-user" || receipt.daemonHome !== daemonHome || receipt.unit !== expectedUnit) return false;
    candidateUnit = receipt.unit;
    let rawUnderLock: string | undefined;
    try {
      assertSystemdSource(receipt.unitPath, receipt.unitSha256);
      rawUnderLock = readFileSync(receipt.unitPath, "utf8");
    } catch { return skip(receipt.unit, "the unit file was modified"); }
    const needsUpgrade = upgradedSystemdOomPolicy(rawUnderLock);
    const alreadyContinue = !needsUpgrade && /^[ \t]*OOMPolicy=continue$/m.test(rawUnderLock);
    if (!needsUpgrade && !alreadyContinue) {
      return skip(receipt.unit, /^[ \t]*OOMPolicy=/m.test(rawUnderLock) ? "OOMPolicy is already set" : "the unit file has custom service settings");
    }
    let sameInstall = false;
    let argv: string[];
    try {
      argv = daemonServeArgv(daemonHome);
      sameInstall = recordedSourceIdentity(receipt, "systemd-user", () => argv).same;
    } catch { return skip(receipt.unit, "the recorded installation could not be verified"); }
    if (!sameInstall) return needsUpgrade ? skip(receipt.unit, "the service belongs to another Cotal installation") : false;
    let env: NodeJS.ProcessEnv;
    try { env = daemonUserServiceEnv(); }
    catch { return needsUpgrade ? skip(receipt.unit, "the systemd user manager did not answer") : false; }
    const resolvedDir = resolveUserUnitDirectory(env);
    if ("reason" in resolvedDir) return needsUpgrade ? skip(receipt.unit, resolvedDir.reason) : false;
    if (receipt.unitPath !== join(resolvedDir.dir, expectedUnit)) {
      return needsUpgrade ? skip(receipt.unit, "the unit file is outside the user manager's unit directory") : false;
    }
    const state = readSystemdPolicyUnitState(nativeRun, receipt.unit, receipt.unitPath, env);
    if (!needsUpgrade) {
      if (!state.loaded || (!state.needsReload && !state.dropInOnDisk)) return false;
      if (!state.needsReload && state.dropInPaths !== "") return false;
      return reloadUpgradedPolicyIfSafe(paths, receipt, env, report, state);
    }
    if (!state.loaded) return skip(receipt.unit, "the systemd user manager did not verify the loaded unit");
    if (state.dropInPaths !== "" || state.dropInOnDisk) return skip(receipt.unit, "drop-ins are present");
    if (state.needsReload) return skip(receipt.unit, "the unit already has a pending reload");
    const otherUnits = observeOtherUnitsNeedDaemonReload(nativeRun, receipt.unit, env);
    if (otherUnits !== "none") {
      return skip(receipt.unit, otherUnits === "other-pending" ? "another user unit has a pending reload" : "loaded user units could not be verified");
    }
    const entry = argv[argv.lastIndexOf("daemon") - 1]!;
    const version = (JSON.parse(readFileSync(join(dirname(dirname(entry)), "package.json"), "utf8")) as { version?: string }).version ?? "";
    if (!version) return skip(receipt.unit, "the CLI package version could not be read");
    if (readReceipt(paths)?.unitSha256 !== receipt.unitSha256) throw new CommandFailure("refused", "CONFLICT", "the recorded daemon service changed during update");
    const enabledRead = nativeRun("systemctl", ["--user", "--no-ask-password", "--no-pager", "show", receipt.unit, "--property=UnitFileState", "--value"], env, 5000);
    const intent: ServiceRepairIntent = { v: 1, receipt, previousSource: rawUnderLock, nextSource: needsUpgrade, enabled: enabledRead.status === 0 && enabledRead.stdout.trim() === "enabled", argv, version, hostedSpaces: [], phase: "prepared" };
    writeSecretFileAtomic(servicePolicyRepairFile(paths.state), `${JSON.stringify(intent)}\n`);
    writeSecretFileAtomic(receipt.unitPath, needsUpgrade);
    const sha256 = sourceDigest(needsUpgrade);
    assertSystemdSource(receipt.unitPath, sha256);
    const nextReceipt: UnitReceipt = { ...receipt, unitSha256: sha256 };
    writeSecretFileAtomic(unitReceiptFile(paths), `${JSON.stringify(nextReceipt)}\n`);
    rmSync(servicePolicyRepairFile(paths.state), { force: true });
    return reloadUpgradedPolicyIfSafe(paths, nextReceipt, env, report);
  } finally { lock.release(); }
}
