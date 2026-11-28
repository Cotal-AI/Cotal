import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { globalConfigDir, type FlagSpec, type ParsedArgs } from "@cotal-ai/core";
import {
  CommandFailure,
  isCommandFailure,
  jsonFlag,
  plainFlag,
  presentationOf,
  renderReport,
  writeResult,
  type OutputWarning,
  claimUpdateClosureAccess,
  updateClosureOwner, withWindowsUpdateIdentity,
  homeCotalDir,
  readUpdateRecovery,
  clearUpdateRecovery,
  writeUpdateRecovery,
  readUpdateSettings,
  observeUpdateVersion,
  UPDATE_HOUR_MS,
  recordUpdateCompletion,
  recordUpdateDeferral,
  recordUpdateReleaseHold,
  recordUpdateRefusal,
  recordUpdateReplacement,
  setUpdateSetting,
  bindExtensionPeers,
  claimGlobalNpmUpdateLock,
  launcherInstallRoot,
  logicalExecutionEntry,
  loadExtensionsManifest,
  provenance,
  SEEDED_EXTENSIONS,
  type InstalledExtension,
  targetFlags,
  recoveryDisposition,
  liveUpdateClosureOwner,
  recoveryProcessStartToken,
  observeUnownedRecovery,
  UnreadableConnectorSelection,
} from "@cotal-ai/workspace";
import { isCliOnlyUpdate, maybeUpdateWithoutConnectorConfig, recoverUpdateWithoutConnectorConfig } from "../lib/update-without-config.js";
import { resumePublishedUpdate, retainUnusableRecovery } from "../lib/update-recovery-state.js";
import { readUpdatePending } from "../lib/update-pending.js";
import { snapshotUpdateClosure, type UpdateSnapshot } from "../lib/update-snapshot.js";
import { assertConfigAncestorProtected, connectorConfigPreflightFailure, manifestAccessReporter, prepareUpdateConnectorConfig, repairCurrentUpdateConnectorSelection, repairUpdateConnectorSelection, restoreUpdateManifestAccess } from "../lib/update-connector-config.js";
import { reclaimPreviousExtensionStages } from "../lib/extension-stage.js";
import { EXT_UPDATE_PARENT_ENV } from "./ext.js";
import { collectUpdateCaches } from "./update-caches.js";
import { repairOfflineExtensions } from "./update-offline.js";
import { claimExtensionUpdatePass } from "../lib/ext-mutation.js";
import { selfArgv } from "../lib/self-exec.js";
import { repairInstallModes } from "../lib/install-umask.js";
import { cliVersion, installedCliVersion } from "../lib/version.js";
import { runSeed, compareSemver, seedInstallationCurrent, assertReadableSeedState, readSeedRepairRefusal } from "../seed/reconcile.js";
import { operatorInstallDiffers, operatorUpdateSpec } from "../seed/verify.js";
import { cliPackageRoot, entryScript, seedWriterKind } from "../seed/paths.js";
import { refreshClientInstalls, refreshConnectorInstalls } from "./setup.js";
import { reportCurrentConnectorState } from "./setup-current-connectors.js";
import { c } from "../ui.js";
import { refreshOwnedCompletions } from "../lib/completion-install.js";
import { onFlag } from "../lib/control.js";
import {
  type CommandResult,
  STRICT_SEMVER,
  installedUpdatePrefix,
  verifyGlobalEntry,
  runNpmAsync,
  runNpm,
  runProcess,
  runGlobalProcess,
  latestNotAvailable,
  failure,
  message,
} from "./update-process.js";
import {
  latestVersion,
  latestVersionCheckRemedy,
  latestVersionCheckWarning,
  handleLatestVersionFailure,
  reportConnectorAccessRestored,
  checkReleaseArchives,
  ReleaseNotAvailable,
  ReleaseDateExcluded,
  DependencyCheckInterrupted,
  DependencyCheckNoSpace,
  registryNetworkFailure,
  deferStagingFailure,
  offlineUpdateMessage,
  waitForReleasePreflight,
} from "./update-release.js";
import { admitReconciliation, refusal, reportRunningManagers, reportUncheckedPreparedRecords } from "./update-continuity.js";
export { isStoppedLocalMesh, reportRunningManagers, readUpdateManagerContinuity, readManagerContinuity, printLegacyReport } from "./update-continuity.js";

export { parseNpmVersion, installedUpdatePrefix, verifyGlobalEntry } from "./update-process.js";
export { localUpdateManagers } from "../lib/update-managers.js";
export { managerPin as updateManagerPin } from "../lib/manager-choice.js";

const UPDATE_TARGET_ENV = "COTAL_UPDATE_TARGET_VERSION";
const UPDATE_PARENT_ENV = "COTAL_UPDATE_PARENT";
/** Set by a parent that waits for the installed daemon generation after its reconcile child and prints
 *  the wait line. A child prints the line itself unless its parent set this: a parent from before this
 *  marker never waits there, so the line would be lost. */
export const UPDATE_PARENT_WAITS_ENV = "COTAL_UPDATE_PARENT_WAITS";

export const updateFlags: readonly FlagSpec[] = [
  { name: "auto", type: "boolean", description: "show automatic updates, or set them with --auto off|on" },
  { name: "notify", type: "boolean", description: "show update notices, or set them with --notify off|on" },
  { name: "self", type: "boolean", description: "install the validated latest cotal-ai globally, then reconcile through it" },
  { name: "stop-agents", type: "boolean", description: "stop agents this computer cannot preserve, then continue the update" },
  { name: "check", type: "boolean", description: "read version availability and the recorded extension inventory; install and restart nothing" },
  jsonFlag, plainFlag,
  ...targetFlags,
  onFlag,
];

export interface ExecutionReplacement {
  readonly entry: string;
  readonly journal: string;
  preflight(target: Record<string, unknown>): Promise<void>;
  publish(): void;
  restore(): void;
  verify(version: string): void;
  verifyPublished?(version: string): boolean;
  /** Remove a retained target that was never published. */
  discard?(): void;
  /** Complete retained publication bookkeeping after successful reconciliation. */
  complete?(): void;
}

export interface UpdateRuntime {
  readonly env: NodeJS.ProcessEnv;
  readonly pid: number;
  readonly parentPid: number;
  readonly nodePath: string;
  now?(): number;
  sleep?(milliseconds: number): Promise<void>;
  recoveryOwnerStart?(pid: number): string | undefined;
  /** Check the execution destination and return true if its directory permissions were repaired. */
  preflightExecution?(): boolean | void;
  executionGlobalRoot?(): string;
  /** Preserve the selected execution binding while hardening installer-owned modes. */
  repairInstallModes?(root: string): number;
  /** Prepare a complete retained target under the held global root lock, without publication. */
  prepareExecution?(version: string, root: string, deferConnectors?: string): Promise<ExecutionReplacement>;
  connectorConfigDeferred?: boolean;
  /** Reopen only a journal already validated against this logical installation. */
  recoverExecution?(journal: string, withoutConnectors?: boolean): ExecutionReplacement;
  version(): string;
  /** Read package consistency only, without refreshing external harness integrations. */
  isCurrent?(): boolean;
  reconcile(selfUpdate: boolean): Promise<void>;
  /** Preserve native custody of an authenticated automatic update child before reconciliation. */
  adoptUpdateChild?(): Promise<boolean | void>;
  /** The native updater can survive its daemon's restart and verify automatic activation. */
  automaticGenerationWait?: boolean;
  /** Bring what connectors installed in their harnesses to this release; report each completed refresh. */
  refreshConnectors(report: (line: string) => void, selfUpdate: boolean): Promise<void>;
  /** Bring the entries client setup wrote in ACP clients to this release, once the operator
   *  extensions that provide them are current; one line per client. */
  refreshClients(): Promise<readonly string[]>;
  reportRunningManager(target: Record<string, unknown>): Promise<"none" | "legacy">;
  /** Authenticate and retain an installed same-version repair before its connector writes. */
  prepareReconciliation?(target: Record<string, unknown>): Promise<void>;
  /** Wait for the replacement, or return why native daemon activation remains incomplete. */
  waitForInstalledGeneration?(version: string): Promise<string | void>;
  /** Explain whether the machine daemon can act on the saved automatic-update preference. */
  automaticUpdateAdvice(): Promise<string | undefined>;
  extensions(): readonly InstalledExtension[];
  /** Why a first-party extension still needs its reinstall at `generation`, or undefined once it is kept. */
  verifyExtension(entry: InstalledExtension, generation: string): string | undefined;
  claimUpdatePass(): () => void;
  preparedRestart?(): boolean;
  /** Reserve empty hosted Manager admission after continuity checks, before replacement. */
  prepareReplacement?(): Promise<() => Promise<void>>;
  /** Validate recorded local service ownership before replacing packages or reconciling connectors. */
  preflightReplacement?(): Promise<void>;
  claimGlobalUpdate(root: string, onWait?: () => void): () => void;
  /** Read the selected global package again after acquiring its update reservation. */
  globalVersion?(root: string): string | undefined;
  verifyUpdatedEntry?(root: string, version: string): string;
  selfArgv(): string[];
  /** Whether this CLI runs from a source checkout, where `--self` installs a separate global copy. */
  checkout(): boolean;
  /** The verified prefix of an installed POSIX npm CLI, absent for a checkout or local/npx copy. */
  installPrefix(): string | undefined;
  npm(args: string[], inherit?: boolean): CommandResult;
  npmAsync(args: string[], archiveCache?: string): Promise<CommandResult>;
  spawn(file: string, args: string[], env: NodeJS.ProcessEnv, inherit?: boolean): CommandResult;
  spawnGlobal(
    root: string,
    operation: "install" | "reconcile",
    file: string,
    args: string[],
    env: NodeJS.ProcessEnv,
    inherit?: boolean,
    windowsVerbatimArguments?: boolean,
    staging?: string,
  ): Promise<CommandResult>;
  verifyGlobalEntry(root: string, expectedVersion: string): string;
  out(message: string): void;
  err(message: string): void;
  stdout(message: string): void;
  stderr(message: string): void;
  /** The offline latest-version check selected no release, so there is nothing to activate. */
  onOfflineVersionCheckSkipped?(): void;
  /** Set when a manual version-changing update has already waited for the installed generation. */
  generationWaited?: boolean;
}

export { installedCliVersion, repairInstallModes };
export const updateRuntime: UpdateRuntime = {
  env: process.env,
  pid: process.pid,
  parentPid: process.ppid,
  nodePath: process.execPath,
  version: cliVersion,
  isCurrent: () => {
    if (process.platform !== "linux") return false;
    if (!seedInstallationCurrent()) return false;
    try {
      const builtIns = new Set(Object.values(SEEDED_EXTENSIONS).map(entry => entry.pkg));
      return updateRuntime.extensions().filter(entry => entry.pkg.startsWith("@cotal-ai/") && !builtIns.has(entry.pkg))
        .every(entry => operatorInstallDiffers(entry, cliVersion()) === undefined);
    } catch { return false; }
  },
  preflightReplacement: async () => { assertReadableSeedState(); },
  refreshConnectors: async (report, selfUpdate) => { await refreshConnectorInstalls(report, selfUpdate); },
  refreshClients: refreshClientInstalls,
  reconcile: async (selfUpdate) => {
    await runSeed({ verify: true }, selfUpdate);
    const completion = refreshOwnedCompletions();
    if (completion.changed.length || completion.preserved.length) process.stdout.write(`${renderReport({ sections: [
      { title: "Owned shell completion", blocks: [
        { kind: "fields", rows: [["Changed files", String(completion.changed.length)], ["Preserved integrations", String(completion.preserved.length)]] },
        { kind: "lines", lines: [...completion.preserved.map((entry) => ({ text: `${entry.shell}: ${entry.reason}`, tone: "waiting" as const })), { text: "Startup files were not rewritten. Run `cotal completion` to inspect local integration.", tone: "hint" }] },
      ] },
    ] }, "rich", process.stdout)}\n`);
  },
  reportRunningManager: (target) => reportRunningManagers(target),
  automaticUpdateAdvice: async () => "Automatic installation requires the machine daemon service. Run `cotal daemon install`, then inspect `cotal daemon status`.",
  extensions: () => loadExtensionsManifest().extensions,
  verifyExtension: verifyCurrentExtension,
  claimUpdatePass: () => claimExtensionUpdatePass(),
  claimGlobalUpdate: (root, onWait) => claimGlobalNpmUpdateLock(root, { waitMs: 10 * 60_000, renew: true, onWait }),
  globalVersion: (root) => {
    const path = join(root, "cotal-ai", "package.json");
    if (!existsSync(path)) return undefined;
    const meta = JSON.parse(readFileSync(path, "utf8")) as { name?: string; version?: string };
    if (meta.name !== "cotal-ai" || !meta.version || !STRICT_SEMVER.test(meta.version)) throw new Error("the installed global cotal-ai version is invalid");
    return meta.version;
  },
  selfArgv,
  checkout: () => seedWriterKind() === "checkout",
  installPrefix: () => {
    const logical = logicalExecutionEntry();
    return installedUpdatePrefix(logical ? dirname(dirname(logical)) : cliPackageRoot(), logical ?? entryScript());
  },
  npm: runNpm,
  npmAsync: runNpmAsync,
  spawn: runProcess,
  spawnGlobal: runGlobalProcess,
  verifyGlobalEntry,
  out: console.log,
  err: console.error,
  stdout: (message) => void process.stdout.write(message),
  stderr: (message) => void process.stderr.write(message),
};

export async function update(args: ParsedArgs, rt: UpdateRuntime = updateRuntime): Promise<void> {
  validateUpdateArguments(args);
  if (args.values.auto || args.values.notify) {
    const key = args.values.auto ? "auto" : "notify";
    const value = args.positionals[0];
    let recoveredBackup: string | undefined;
    const current = readUpdateSettings(backup => {
      recoveredBackup = backup;
      if (!args.values.json) rt.err(`Damaged update settings saved to ${backup}; using defaults (automatic updates and notices on).`);
    });
    const settings = value === undefined ? current : setUpdateSetting(key, value === "on");
    const disabledByEnv = rt.env.COTAL_NO_UPDATE_CHECK === "1";
    const desktop = key === "auto" && existsSync(join(cliPackageRoot(), "desktop-runtime.json"));
    const advice = desktop
      ? "This runtime belongs to the desktop app. Automatic npm updates have no effect here; update the desktop app with its signed platform installer."
      : key === "auto" && settings.auto && ["linux", "darwin", "win32"].includes(process.platform) && !disabledByEnv
        ? await rt.automaticUpdateAdvice()
        : undefined;
    const line = `${key === "auto" ? "Automatic updates" : "Update notices"}: ${settings[key] ? "on" : "off"}${disabledByEnv ? " (disabled by COTAL_NO_UPDATE_CHECK=1)" : ""}`;
    if (!args.values.json && !args.values.plain) {
      rt.out(line);
      if (advice) rt.out(advice);
      return;
    }
    const file = join(homeCotalDir(), "update-settings.json");
    const warnings: OutputWarning[] = recoveredBackup
      ? [{ code: "SETTINGS_RECOVERED", target: { file, backup: recoveredBackup }, message: `Damaged update settings saved to ${recoveredBackup}; using defaults (automatic updates and notices on).` }]
      : [];
    const noOp = value !== undefined && recoveredBackup === undefined && current[key] === settings[key];
    writeResult(presentationOf(args.values), {
      command: "update",
      target: null,
      result: { kind: "update-preference", preference: key, enabled: settings[key], effective: !disabledByEnv && !desktop && settings[key], disabledByEnv, advice: advice ?? null, file },
      warnings,
      noOp,
    }, () => ({ sections: [{ blocks: [{ kind: "lines", lines: advice ? [line, advice] : [line] }] }] }));
    return;
  }
  // npm and reconciliation children need the same writable private scratch as the updater.
  // Select it before recovery or installation work so failure is a definite refusal.
  let scratch: string | undefined;
  const failures: string[] = [];
  for (const parent of new Set([tmpdir(), ...(process.platform === "win32" ? [] : ["/tmp"]), homedir()])) {
    try { scratch = mkdtempSync(join(parent, "cotal-update-")); break; }
    catch (error) { failures.push(message(error)); }
  }
  if (!scratch) throw new CommandFailure("refused", "DEPENDENCY_UNAVAILABLE", `cannot create a private temporary directory for the update: ${failures.join("; ")}; no changes were made`, {
    native: { outcome: "not-executed" }, remedy: "set TMPDIR to an existing writable folder, then run the update again",
  });
  const environments = [...new Set([process.env, rt.env])];
  const previous = environments.map(env => ({ env, values: { TMPDIR: env.TMPDIR, TMP: env.TMP, TEMP: env.TEMP } }));
  let continuation: string | undefined;
  try {
    for (const env of environments) Object.assign(env, { TMPDIR: scratch, TMP: scratch, TEMP: scratch });
    continuation = await (args.values.self === true ? withWindowsUpdateIdentity(() => updateInstallation(args, rt)) : updateInstallation(args, rt));
  } finally {
    for (const { env, values } of previous) for (const [key, value] of Object.entries(values)) {
      if (value === undefined) delete env[key];
      else env[key] = value;
    }
    rmSync(scratch, { recursive: true, force: true, maxRetries: 3 });
  }
  if (continuation) {
    const result = rt.spawn(rt.nodePath, [continuation, "update", ...args.raw], rt.env, true);
    if (result.error) throw new Error(`cannot continue the update through the restored installation: ${result.error}`);
    if (result.status !== 0) process.exitCode = result.status ?? 1;
    // The installed command owns any remaining activation and its exit result.
    rt.generationWaited = true;
  }
  if (args.values.self === true && !process.exitCode && childBinding(rt).kind === "none") collectUpdateCaches(dirname(scratch));
}

async function updateInstallation(args: ParsedArgs, rt: UpdateRuntime): Promise<string | undefined> {
  if (args.values.check === true) { await checkUpdate(args, rt); return; }
  if (args.values.self === true && existsSync(join(cliPackageRoot(), "desktop-runtime.json"))) {
    throw new CommandFailure("refused", "UNSUPPORTED", "this Cotal runtime belongs to the desktop app; npm self-update would separate it from its bundled runtime", {
      remedy: "update the desktop app with its signed platform installer; no npm self-update was attempted",
    });
  }
  const deferred = childBinding(rt).kind === "none" && await maybeUpdateWithoutConnectorConfig(args, rt, () => recoverInterruptedUpdate(rt, false, targetArgv(args.values)));
  if (deferred) return deferred.entry;
  let connectorSelection: UnreadableConnectorSelection | undefined;
  let preflightChanged = false;
  let permissionsRestored = false;
  let promotionRecovered = false;
  if (args.values.self === true) {
    const reportManifestAccess = manifestAccessReporter(line => { preflightChanged = true; rt.out(line); });
    try { preflightChanged = rt.preflightExecution?.() === true; }
    catch (error) {
      if (isCommandFailure(error)) throw error;
      const refusal = `This installation cannot update itself from this account: ${message(error)}; no changes were made`;
      if (rt.env.COTAL_AUTO_UPDATE === "1") recordUpdateRefusal(rt.version(), refusal);
      throw new CommandFailure("refused", "DEPENDENCY_UNAVAILABLE", refusal, {
        native: { outcome: "not-executed" },
      });
    }
    try {
      promotionRecovered = prepareUpdateConnectorConfig(Boolean(rt.prepareExecution), () => { preflightChanged = true; }, () => { permissionsRestored = true; }, reportManifestAccess);
    } catch (error) {
      if (error instanceof UnreadableConnectorSelection) connectorSelection = error;
      else {
        const failure = connectorConfigPreflightFailure(error, preflightChanged);
        recordUpdateDeferral(rt.version(), `connector configuration preflight: ${preflightDetail(failure)}`);
        throw failure;
      }
    }
    if (!connectorSelection) try { restoreUpdateManifestAccess(Boolean(rt.prepareExecution), reportManifestAccess); }
    catch (error) {
      if (error instanceof UnreadableConnectorSelection) connectorSelection = error;
      else {
        rt.err(c.red(`✗ ${refusal(error)}`));
        process.exitCode = 1;
        return;
      }
    }
  }
  const restored = await recoverInterruptedUpdate(rt, false, targetArgv(args.values));
  if (restored && (args.values.self !== true || restored.resumed)) return;
  if (restored && restored.version !== rt.version()) return restored.entry;
  try {
    assertConfigAncestorProtected();
  } catch (e) {
    rt.err(c.red(`✗ config folder protection: ${refusal(e)}`));
    recordUpdateDeferral(rt.version(), `config folder protection: ${preflightDetail(e)}`);
    process.exitCode = 1;
    return;
  }
  const install = launcherInstallRoot();
  for (const { what, root } of args.values.self === true && rt.prepareExecution ? [] : [...(install ? [{ what: "install", root: install }] : []), { what: "config", root: globalConfigDir() }]) {
    const repaired = (rt.repairInstallModes ?? repairInstallModes)(root);
    if (repaired) {
      preflightChanged = true;
      rt.out(c.green(`✓ removed group and other write from ${repaired} ${repaired === 1 ? "entry" : "entries"} in Cotal's ${what} at ${root}`));
    }
  }
  if (childBinding(rt).kind === "none") reclaimPreviousExtensionStages();
  const code = await executeUpdate(Boolean(args.values.self), rt, args.values, restored ? undefined : connectorSelection, preflightChanged, promotionRecovered, permissionsRestored);
  if (code !== 0) process.exitCode = code;
  else if (args.values.self !== true && childBinding(rt).kind !== "bound") {
    clearUpdateRecovery();
    recordUpdateCompletion(rt.version(), "manual update reconciled", true);
  }
}

/** Resume an abandoned replacement before a command or daemon can activate its closure. */
export async function recoverInterruptedUpdate(rt: UpdateRuntime = updateRuntime, startup = false, flags: string[] = []): Promise<{ entry: string; version: string; resumed?: true } | undefined> {
  if (childBinding(rt).kind === "bound") return;
  const observed = readUpdateRecovery();
  if (!observed) return;
  if (startup && liveUpdateClosureOwner(observed, rt.recoveryOwnerStart ?? recoveryProcessStartToken)) return;
  if (isCliOnlyUpdate(observed)) return recoverUpdateWithoutConnectorConfig(rt, observed);
  const release = claimUpdateClosureAccess(true);
  try {
    const record = readUpdateRecovery();
    if (!record) return;
    const now = rt.now?.() ?? Date.now();
    let decision = recoveryDisposition(record, now, rt.recoveryOwnerStart ?? recoveryProcessStartToken);
    if (decision.action === "wait") {
      try { observeUnownedRecovery(now); }
      catch (error) { throw new CommandFailure("refused", "DEPENDENCY_UNAVAILABLE", `${decision.instruction} Cannot save the first observation: ${message(error)}`, { remedy: "correct access to the Cotal home, then run `cotal update --self`" }); }
      decision = recoveryDisposition(record, now, rt.recoveryOwnerStart ?? recoveryProcessStartToken);
    }
    if (!startup && (decision.action === "restore" || decision.action === "retire") && record.execution && record.target === rt.version() && (record.phase === "replacing" || record.phase === "verified-ready")) return await resumePublishedUpdate(rt, record, flags, decision.action === "retire" ? now : undefined);
    if (decision.action === "retire") {
      let retained;
      try { retained = retainUnusableRecovery(record, now); }
      catch (error) { throw new CommandFailure("refused", "CONFLICT", `${decision.instruction} Retention could not complete: ${message(error)}`, { remedy: "inspect the recovery records and retained folders in the Cotal home, correct access, then run `cotal update --self`" }); }
      rt.out(`Retained unusable interrupted-update records in ${retained}; continuing the update.`);
      return;
    }
    if (startup && (decision.action === "wait" || decision.action === "active" || decision.action === "restore" && record.phase === "paused")) return;
    if (decision.action !== "restore") throw new CommandFailure("refused", decision.action === "active" ? "LIFECYCLE_BLOCKED" : decision.action === "wait" ? "CONFLICT" : "DEPENDENCY_UNAVAILABLE", decision.instruction, { native: { code: decision.action === "active" ? "UPDATE_RECOVERY_OWNER_ACTIVE" : decision.action === "wait" ? "UPDATE_RECOVERY_OBSERVATION_WAIT" : "UPDATE_RECOVERY_INSPECTION_FAILED" }, ...(decision.action === "active" ? {} : { remedy: "follow the recovery instruction above, then run `cotal update --self`" }) });
    if (!record.owner) return;
    try {
      if (!record.snapshot) throw new Error("interrupted update has no closure snapshot");
      writeUpdateRecovery({ ...record, owner: updateClosureOwner(), phase: "restoring" });
      const snapshot = snapshotUpdateClosure(record.snapshot);
      const completedRollback = !record.execution && !startup && record.phase === "paused" && record.installed === record.previous
        && record.renames !== undefined && record.renames.length > 0 && record.renames.every(entry => entry.done);
      const prefix = rt.installPrefix();
      const selected = record.execution && rt.executionGlobalRoot ? { status: 0, stdout: rt.executionGlobalRoot(), stderr: "" } : rt.npm(["root", "-g", ...(prefix ? ["--prefix", prefix] : [])]);
      const root = selected.stdout.trim();
      if (selected.status !== 0 || !isAbsolute(root) || /[\r\n]/.test(root)) throw new Error("cannot identify interrupted update installation");
      const releaseGlobal = rt.claimGlobalUpdate(root);
      try {
        if (completedRollback) {
          const version = rt.version();
          const entry = rt.verifyGlobalEntry(root, version);
          if (realpathSync(entry) !== realpathSync(entryScript())) throw new Error("paused repair must run from the verified installed CLI");
          snapshot.restore();
          const env = { ...rt.env, [UPDATE_TARGET_ENV]: version, [UPDATE_PARENT_ENV]: String(rt.pid), ...(!startup && rt.env.COTAL_AUTO_UPDATE !== "1" ? { [UPDATE_PARENT_WAITS_ENV]: "1" } : {}) };
          const reconciled = await rt.spawnGlobal(root, "reconcile", rt.nodePath, [entry, "update"], env, true);
          if (reconciled.status !== 0) throw new Error(failure(reconciled));
          if (!startup && rt.env.COTAL_AUTO_UPDATE !== "1") {
            const currentRecovery = readUpdateRecovery();
            if (currentRecovery && currentRecovery.phase !== "verified-ready") writeUpdateRecovery({ ...currentRecovery, installed: version, phase: "verified-ready" });
            await rt.waitForInstalledGeneration?.(version);
          }
          snapshot.discard();
          clearUpdateRecovery();
          recordUpdateCompletion(version, `repaired paused installation at ${version}`, true);
          rt.out(`Repaired the paused installation with cotal-ai@${version}; the machine service and its hosted Managers were verified.`);
          return { entry, version };
        }
        let entry: string;
        let recoveredExecution: ExecutionReplacement | undefined;
        if (record.execution) {
          if (!rt.recoverExecution) throw new Error("this binary cannot recover a staged execution transaction; rerun its installer");
          const execution = recoveredExecution = rt.recoverExecution(record.execution);
          execution.restore();
          execution.verify(record.previous);
          entry = execution.entry;
        } else {
          await checkReleaseArchives(record.previous, rt);
          const installed = await rt.spawnGlobal(root, "install", "npm", ["install", "-g", ...(prefix ? ["--prefix", prefix] : []), `cotal-ai@${record.previous}`], rt.env, true);
          if (installed.status !== 0) throw new Error(failure(installed));
          entry = rt.verifyGlobalEntry(root, record.previous);
        }
        snapshot.restore();
        const env = { ...rt.env, [UPDATE_TARGET_ENV]: record.previous, [UPDATE_PARENT_ENV]: String(rt.pid), ...(!startup && rt.env.COTAL_AUTO_UPDATE !== "1" ? { [UPDATE_PARENT_WAITS_ENV]: "1" } : {}) };
        const reconciled = await rt.spawnGlobal(root, "reconcile", rt.nodePath, [entry, "update"], env, true);
        if (reconciled.status !== 0) throw new Error(failure(reconciled));
        if (!startup && rt.env.COTAL_AUTO_UPDATE !== "1") {
          const currentRecovery = readUpdateRecovery();
          if (currentRecovery && currentRecovery.phase !== "verified-ready") writeUpdateRecovery({ ...currentRecovery, installed: record.previous, phase: "verified-ready" });
          await rt.waitForInstalledGeneration?.(record.previous);
        }
        snapshot.discard();
        clearUpdateRecovery();
        recoveredExecution?.complete?.();
        rt.out(`Restored cotal-ai@${record.previous} after an interrupted update.`);
        return { entry, version: record.previous };
      } finally { releaseGlobal(); }
    } catch (error) {
      writeUpdateRecovery({ ...readUpdateRecovery()!, phase: "paused", reason: `interrupted update restore failed: ${message(error)}` });
      throw error;
    }
  } finally { release(); }
}

/** Check mode is installation metadata only; target and mutation inputs are never ignored. */
export function validateUpdateArguments(args: ParsedArgs): void {
  presentationOf(args.values);
  if (args.values["stop-agents"] && args.values.self !== true) throw new CommandFailure("refused", "USAGE_INVALID", "--stop-agents requires `cotal update --self`");
  if (args.values.auto || args.values.notify) {
    if (args.values.auto && args.values.notify || args.values.self || args.values.check || args.values.space || args.values.server || args.values.creds || args.values.on !== undefined || args.positionals.length > 1 || args.positionals.some(value => value !== "on" && value !== "off"))
      throw new CommandFailure("refused", "USAGE_INVALID", "use `cotal update --auto [off|on]` or `cotal update --notify [off|on]` without other update flags");
    return;
  }
  if (args.positionals.length) throw new CommandFailure("refused", "USAGE_INVALID", "off or on requires --auto or --notify");
  if (args.values.check === true) {
    if (args.values.self || args.values.space !== undefined || args.values.server !== undefined || args.values.creds !== undefined || args.values.on !== undefined)
      throw new CommandFailure("refused", "USAGE_INVALID", "update --check reads this installation and takes no --self, mesh selection or --on");
  } else if (args.values.json || args.values.plain) throw new CommandFailure("refused", "UNSUPPORTED", "structured and plain update reports require --check; the installer keeps its native progress output");
}

function checkUpdate(args: ParsedArgs, rt: UpdateRuntime): void {
  const current = rt.version();
  const warnings: OutputWarning[] = [];
  let extensions: { package: string; version: string; firstParty: boolean; matchesCli: boolean | null }[] | null;
  try {
    extensions = rt.extensions().map((entry) => {
      if (!entry || typeof entry.pkg !== "string" || typeof entry.version !== "string" || !STRICT_SEMVER.test(entry.version)) throw new Error("invalid extension version entry");
      const firstParty = entry.pkg.startsWith("@cotal-ai/");
      return { package: entry.pkg, version: entry.version, firstParty, matchesCli: firstParty ? entry.version === current : null };
    });
  } catch {
    extensions = null;
    warnings.push({ code: "EXTENSION_INVENTORY_UNREADABLE", target: null, message: "The extension inventory could not be read. It was not repaired or treated as empty." });
  }
  const latest = latestVersion(rt);
  if (!latest.ok) warnings.push(latestVersionCheckWarning(latest));
  const comparison = latest.ok ? compareSemver(latest.version, current) : null;
  let reconciliation: ReturnType<typeof readUpdatePending>
    | { kind: "seed"; instruction: string }
    | { kind: "unreadable"; source: "seed"; error: string; instruction: string } = readUpdatePending(current);
  if (reconciliation.kind === "none" || reconciliation.kind === "version-mismatch") {
    try {
      const refusal = readSeedRepairRefusal(current);
      if (refusal) reconciliation = { kind: "seed", instruction: refusal.message };
    } catch (error) {
      reconciliation = { kind: "unreadable", source: "seed", error: refusal(error), instruction: "Run `cotal ext seed --repair` to reconcile the connectors." };
    }
  }
  if (reconciliation.kind === "unreadable") warnings.push({ code: "RECONCILIATION_UNREADABLE", target: null, message: `Reconciliation state could not be read: ${reconciliation.error}` });
  if (reconciliation.kind === "seed") warnings.push({ code: "OPERATION_PARTIAL", target: null, message: reconciliation.instruction });
  const manifestUnreadable = reconciliation.kind === "unreadable" && reconciliation.source === "manifest";
  const result = { kind: "update-check", reconciliation, current, latest: latest.ok ? latest.version : null, updateAvailable: comparison === null ? null : comparison > 0, extensions, scope: "registry version and recorded installation versions", installationChanged: false, processesRestarted: false };
  writeResult(presentationOf(args.values), {
    command: "update", target: null, result, warnings,
    ...(warnings.length ? { completeness: "partial" as const, partial: {
      message: reconciliation.kind === "seed" ? "Connector seeding needs reconciliation." : "Some update information could not be established.",
      remedy: reconciliation.kind === "seed" || reconciliation.kind === "unreadable" && reconciliation.source !== "receipt" ? reconciliation.instruction : latestVersionCheckRemedy(latest, extensions !== null && reconciliation.kind !== "unreadable"),
    } } : {}),
  }, (r) => ({ sections: [
    ...(r.reconciliation.kind === "none" ? [] : [{ title: "Reconciliation", blocks: [{ kind: "lines" as const, lines: [r.reconciliation.instruction] }] }]),
    { title: "Update availability", blocks: [{ kind: "fields", rows: [["Running CLI", r.current], ["Registry latest", r.latest ?? "not established"], ["CLI update", r.updateAvailable === null ? { text: "unknown", tone: "waiting" } : r.updateAvailable ? { text: "available", tone: "waiting" } : comparison === 0 ? "matches latest tag" : "running version is ahead of latest tag"]] }] },
    { title: "Recorded extensions", blocks: [r.extensions === null ? { kind: "lines", lines: [{ text: "Inventory unavailable. No repair was attempted.", tone: "waiting" }] } : r.extensions.length ? { kind: "table", columns: [{ key: "package", label: "Package" }, { key: "version", label: "Recorded version" }, { key: "state", label: "Generation" }], rows: r.extensions.map((entry) => ({ package: entry.package, version: entry.version, state: !entry.firstParty ? { text: "third party", tone: "hint" } : entry.matchesCli ? { text: "matches running CLI", tone: "ok" } : { text: "differs from running CLI", tone: "waiting" } })) } : { kind: "lines", lines: ["No extensions in the recorded inventory."] }, { kind: "lines", lines: [{ text: "Version records only. Package contents, signatures and running processes were not checked. No installation was reconciled or restarted.", tone: "hint" }] }] },
    ...(manifestUnreadable ? [] : [{ title: "Next", blocks: [{ kind: "commands" as const, items: [{ command: "cotal update", description: "Reconcile the current generation through the existing guarded updater" }, ...(r.updateAvailable ? [{ command: "cotal update --self", description: rt.checkout() ? "Install the verified latest CLI as a separate global copy and reconcile through it; this checkout does not change" : "Install the verified latest CLI and reconcile its generation" }] : []), { command: "cotal status", description: "Inspect this machine and its selected space" }] }] }]),
  ] }));
}
/** Injectable command body: production keeps one process seam; the smoke covers every decision branch. */
export async function executeUpdate(self: boolean, rt: UpdateRuntime = updateRuntime, target: Record<string, unknown> = {}, unreadableSelection?: UnreadableConnectorSelection, preflightChanged = false, promotionRecovered = false, permissionsRestored = false): Promise<number> {
  const current = rt.version();
  const child = childBinding(rt);
  if (child.kind === "invalid") {
    rt.err(c.red(`✗ invalid global update child binding: ${child.reason}; refusing to mutate extensions`));
    return 1;
  }
  if (child.kind === "bound") {
    if (self && rt.env.COTAL_AUTO_UPDATE === "1") recordUpdateDeferral(current, "waiting for update preflight");
    if (current !== child.target) {
      rt.err(c.red(`✗ global update child is cotal-ai ${current}, expected ${child.target}; refusing to mutate extensions`));
      return 1;
    }
    let independent = false;
    try { independent = await rt.adoptUpdateChild?.() === true; }
    catch (error) {
      rt.err(c.red(`✗ automatic update custody: ${refusal(error)}; package replacement already occurred; reconciliation was not started and the parent may retry or restore`));
      return 1;
    }
    // A parent that journals its transaction holds the daemon on the old generation until this
    // reconcile is verified. An older parent wrote no journal, and its daemon restarts as soon as
    // the package changes, so continuity is only answerable after that restart has settled.
    const journaled = readUpdateRecovery() !== undefined;
    if (journaled) {
      const result = await reconcileCurrent(current, rt, target, (ok) => ok ? 0 : 1, true);
      if (result !== 0) return result;
      // Only a child whose native custody survived the service boundary can verify activation.
      // Other automatic helpers retain their existing post-exit activation path.
      if (rt.env.COTAL_AUTO_UPDATE === "1" && !independent) return 0;
    }
    try {
      const recovery = readUpdateRecovery();
      if (recovery) writeUpdateRecovery({ ...recovery, installed: current, phase: "verified-ready" });
      await rt.waitForInstalledGeneration?.(current);
    } catch (error) {
      rt.err(c.red(`✗ installed daemon generation: ${refusal(error)}`));
      return 1;
    }
    return journaled ? 0 : reconcileCurrent(current, rt, target, (ok) => ok ? 0 : 1, true);
  }

  if (self) {
    const latest = latestVersion(rt);
    if (!latest.ok) {
      const code = await handleLatestVersionFailure(latest, current, rt, offlineUpdateMessage(preflightChanged), promotionRecovered, permissionsRestored);
      if (latest.offline && rt.env.COTAL_AUTO_UPDATE !== "1" && !unreadableSelection)
        await repairOfflineExtensions(current, rt, () => admitReconciliation(current, rt, target));
      return code;
    }
    const upgrading = compareSemver(latest.version, current) > 0;
    if (rt.env.COTAL_AUTO_UPDATE === "1") {
      // The live npm lookup can select a different version from the one the daemon held.
      const next = await observeUpdateVersion(latest.version) + UPDATE_HOUR_MS;
      if (upgrading && Date.now() < next) {
        reportConnectorAccessRestored(rt, permissionsRestored);
        recordUpdateReleaseHold(latest.version, next);
        return 0;
      }
      recordUpdateDeferral(current, "waiting for update preflight");
    }
    if (upgrading) {
      reportConnectorAccessRestored(rt, permissionsRestored);
      const code = await upgradeAndReconcile(latest.version, current, rt, target, preflightChanged, !permissionsRestored);
      if (code === 0 && rt.env.COTAL_AUTO_UPDATE !== "1") rt.generationWaited = true;
      return code;
    }
    if (unreadableSelection) {
      const repaired = repairCurrentUpdateConnectorSelection(Boolean(rt.prepareExecution), unreadableSelection, line => rt.err(line), () => { permissionsRestored = true; });
      reportConnectorAccessRestored(rt, permissionsRestored);
      rt.out(repaired ? "No newer CLI version." : "No newer CLI version. No connector reconciliation was run.");
      reportVersion(current, latest.version, rt, false);
      return 0;
    }
    reportConnectorAccessRestored(rt, permissionsRestored);
    if (rt.isCurrent?.()) {
      reportUncheckedPreparedRecords(rt, target);
      await reportCurrentConnectorState(current, rt);
      if (rt.env.COTAL_AUTO_UPDATE === "1") recordUpdateCompletion(current, "up to date", true);
      reportVersion(current, latest.version, rt, false);
      return 0;
    }

    return reconcileCurrent(current, rt, target, (reconciled, deferred) => {
      if (rt.env.COTAL_AUTO_UPDATE === "1") {
        if (reconciled) recordUpdateCompletion(current, `updated to ${current}`, true);
        else if (!deferred) {
          recordUpdateReplacement(current);
          recordUpdateCompletion(current, `reconciliation failed at ${current}`, false);
        }
      } else if (reconciled && rt === updateRuntime) {
        recordUpdateCompletion(current, `updated to ${current}`, true);
      }
      reportVersion(current, latest.version, rt, reconciled);
      return reconciled ? 0 : 1;
    }, true);
  }

  return reconcileCurrent(current, rt, target, (reconciled) => {
    const latest = latestVersion(rt);
    reportVersion(current, latest.ok ? latest.version : undefined, rt, reconciled);
    return reconciled ? 0 : 1;
  });
}

async function reconcileCurrent(
  current: string, rt: UpdateRuntime, target: Record<string, unknown>,
  finish: (reconciled: boolean, deferred?: boolean) => number, selfUpdate = false,
): Promise<number> {
  if (!await admitReconciliation(current, rt, target)) return finish(false, true);

  rt.out(c.bold("Built-in connectors"));
  try {
    await rt.reconcile(selfUpdate);
  } catch (e) {
    rt.err(c.red(`✗ built-in connectors: ${message(e)}`));
    return finish(false);
  }
  try {
    rt.out("Refreshing connector integrations");
    const refreshStarted = Date.now();
    await rt.refreshConnectors((line) => rt.out(c.green(`✓ ${line}`)), selfUpdate);
    rt.out(`✓ connector integrations refreshed (${((Date.now() - refreshStarted) / 1000).toFixed(1)} s)`);
  } catch (e) {
    rt.err(c.red(`✗ connector installs: ${message(e)}`));
    return finish(false);
  }

  let releaseMutation: () => void;
  try {
    releaseMutation = rt.claimUpdatePass();
  } catch (e) {
    rt.err(c.red(`✗ could not reserve the extension update pass: ${message(e)}`));
    return finish(false);
  }

  let code: number;
  try {
    const ok = await updateOperatorExtensions(rt, current);
    if (ok && rt.env.COTAL_AUTO_UPDATE !== "1") {
      rt.out("Cotal updates the managed pi connector, not your standalone pi extension. If you copied it, wait for the update to succeed, then reinstall `@cotal-ai/pi` at the version shown by `cotal --version` and repeat the copy. See https://docs.cotal.ai/docs/connect-pi/#load-the-extension-into-your-own-host");
    }
    code = finish(ok);
  } finally {
    releaseMutation();
  }
  return code === 0 ? refreshClients(rt) : code;
}

/** Point the ACP clients' Cotal entries at this Cotal, and return the exit status. A client provider
 *  ships in an operator extension, so this runs once the pass has made them current, and after the
 *  pass is released, because loading a provider takes the extension lock the pass holds. */
async function refreshClients(rt: UpdateRuntime): Promise<number> {
  try {
    const lines = await rt.refreshClients();
    if (lines.length > 0) rt.out(c.bold("Client integrations"));
    for (const line of lines) rt.out(c.green(`✓ ${line}`));
    return 0;
  } catch (e) {
    rt.err(c.red(`✗ client integrations: ${message(e)}`));
    return 1;
  }
}

/** Bring every first-party operator extension to `current`, under the update pass the caller holds,
 *  and say whether all of them are. */
async function updateOperatorExtensions(rt: UpdateRuntime, current: string): Promise<boolean> {
  let ok = true;
  rt.out(c.bold("Operator extensions"));
  let entries: readonly InstalledExtension[];
  try {
    // Exclude every seeded built-in (the connectors AND the bundled web dashboard) — runSeed already
    // reconciled them from the bundled store; letting web fall through here reinstalls it from npm on
    // top of the seed, drops its seeded marker, and makes `cotal update` fail offline on a bundled pkg.
    const builtIns = new Set(Object.values(SEEDED_EXTENSIONS).map((e) => e.pkg));
    entries = rt.extensions().filter((entry) => !builtIns.has(entry.pkg));
  } catch (e) {
    rt.err(c.red(`✗ could not read installed extensions: ${message(e)}`));
    return false;
  }
  if (!entries.length) rt.out(c.dim("operator extensions: none installed"));
  for (const entry of entries) {
    const recordedSpec = typeof entry.spec === "string" ? ` (recorded spec: ${entry.spec})` : "";
    if (!entry.pkg.startsWith("@cotal-ai/")) {
      rt.out(c.dim(`${entry.pkg}@${entry.version} - not auto-updated in v1${recordedSpec}`));
      continue;
    }
    let differs: string | undefined;
    try {
      differs = rt.verifyExtension(entry, current);
    } catch (e) {
      rt.err(c.red(`✗ ${entry.pkg}: ${message(e)}`));
      ok = false;
      continue;
    }
    if (differs === undefined) {
      rt.out(c.green(`✓ verified ${entry.pkg}@${current}`) + c.dim(` - current generation${recordedSpec}`));
      continue;
    }
    rt.err(c.dim(`${entry.pkg}: ${differs}; reinstalling`));
    const spec = operatorUpdateSpec(entry, current);
    const [bin, ...argv] = rt.selfArgv();
    const env: NodeJS.ProcessEnv = {
      ...rt.env,
      COTAL_SKIP_CONNECTOR_SEED: "1",
      [EXT_UPDATE_PARENT_ENV]: String(rt.pid),
    };
    delete env[UPDATE_TARGET_ENV];
    delete env[UPDATE_PARENT_ENV];
    delete env[UPDATE_PARENT_WAITS_ENV];
    const extensionStarted = Date.now();
    const result = rt.spawn(bin, [...argv, "ext", "__update-add", entry.pkg, spec], env);
    rt.out(`✓ extension ${entry.pkg} install finished (${((Date.now() - extensionStarted) / 1000).toFixed(1)} s)`);
    writeChildOutput(result);
    if (result.status !== 0) {
      rt.err(c.red(`✗ ${entry.pkg}: ${failure(result)}`));
      ok = false;
      if (result.status === null) {
        rt.err(c.red("✗ extension replay process ended abnormally; refusing to start another package mutation"));
        break;
      }
      continue;
    }
    rt.out(c.green(`✓ ${entry.pkg}@${current}`) + c.dim(` - current generation${recordedSpec}`));
  }
  return ok;

  function writeChildOutput(result: CommandResult): void {
    if (result.stderr) rt.stderr(result.stderr);
    if (result.stdout) rt.stdout(result.stdout);
  }
}

/** Keep a first-party extension that npm's record in the prefix proves installed at `generation`,
 *  rebinding its shared peers to this binary's copies as its reinstall would; otherwise say why it
 *  still needs that reinstall. The update pass calls it under its own claim, so it needs no child. */
export function verifyCurrentExtension(entry: InstalledExtension, generation: string): string | undefined {
  const differs = operatorInstallDiffers(entry, generation);
  if (differs !== undefined) return differs;
  for (const link of bindExtensionPeers([entry.pkg], entry.pkg))
    provenance.wrote(`${link.peer} link (${link.owner} → this CLI's copy)`, link.destination);
  return undefined;
}

function preflightDetail(error: unknown): string {
  return message(error).replace(/[\r\n\u001b]+/g, " ").replace(/(?:[A-Za-z]:[\\/]|\/)[^\s,;"']+/g, "<config path>").slice(0, 500);
}

async function upgradeAndReconcile(targetVersion: string, current: string, rt: UpdateRuntime, target: Record<string, unknown>, preflightChanged: boolean, reportSelectionAccess = true): Promise<number> {
  try { await rt.preflightReplacement?.(); }
  catch (error) {
    recordUpdateDeferral(targetVersion, "installed daemon preflight refused");
    rt.err(c.red(`✗ installed daemon preflight: ${refusal(error)}`));
    return 1;
  }
  try {
    if (!rt.prepareExecution && await rt.reportRunningManager(target) === "legacy") { recordUpdateDeferral(targetVersion, "waiting for agents to stop"); return 1; }
  } catch (e) {
    recordUpdateDeferral(targetVersion, "waiting for agents to stop");
    rt.err(c.red(`✗ running manager continuity check: ${refusal(e)}`));
    return 1;
  }

  let repairedSelection = false, selectionAccessRestored = false;
  const releaseChecksStarted = Date.now();
  try {
    const release = await waitForReleasePreflight(targetVersion, current, rt, () => {
      try {
        repairedSelection = repairUpdateConnectorSelection(Boolean(rt.prepareExecution), line => rt.err(line), () => { selectionAccessRestored = true; });
        if (reportSelectionAccess && selectionAccessRestored) { reportConnectorAccessRestored(rt, true); reportSelectionAccess = false; }
        return true;
      } catch (error) {
        recordUpdateDeferral(targetVersion, `connector configuration preflight: ${preflightDetail(error)}`);
        rt.err(`Cannot prepare the Cotal connector configuration: ${message(error)}. No CLI update was staged.`);
        return false;
      }
    });
    if (release !== "ready") return release === "deferred" ? 0 : 1;
    // In-place rollback downloads the previous release. Staged rollback retains its complete graph.
    if (!rt.prepareExecution) {
      rt.out(`Checking cotal-ai@${current} recovery archives`);
      await checkReleaseArchives(current, rt);
    }
    rt.out(`✓ release archives checked (${((Date.now() - releaseChecksStarted) / 1000).toFixed(1)} s)`);
  } catch (e) {
    if (e instanceof DependencyCheckInterrupted) {
      recordUpdateDeferral(targetVersion, message(e));
      rt.err(c.red(`✗ ${message(e)}. No installed packages were replaced. Run \`cotal update --self\` again.`));
      return 1;
    }
    if (e instanceof DependencyCheckNoSpace) {
      recordUpdateDeferral(targetVersion, "temporary filesystem is out of space", true);
      rt.err(c.red(`✗ ${message(e)}. No global install was attempted. Free space on the temporary filesystem, then run \`cotal update --self\` again.`));
      return 1;
    }
    if (e instanceof ReleaseDateExcluded) {
      recordUpdateDeferral(targetVersion, "npm date filter excludes the release");
      rt.err(c.red(`✗ ${message(e)}. No global install was attempted.`));
      return 1;
    }
    if (registryNetworkFailure(e)) {
      recordUpdateDeferral(targetVersion, "waiting for registry access", true);
      rt.out(offlineUpdateMessage(preflightChanged || repairedSelection));
      return 0;
    }
    recordUpdateDeferral(targetVersion, "waiting for registry or extension closure availability", true);
    rt.err(c.red(`✗ cotal-ai@${targetVersion} update preflight failed: ${message(e)}. No global install was attempted. ${e instanceof ReleaseNotAvailable ? "The release is still reaching the registry; run `cotal update --self` again in a few minutes." : "Correct the reported failure, then run `cotal update --self` again."}`));
    return 1;
  }

  let prefix: string | undefined;
  try {
    prefix = rt.installPrefix();
    if (prefix && process.platform !== "win32") {
      for (const [key, value] of Object.entries(rt.env)) {
        if (key.toLowerCase() === "npm_config_prefix" && value && realpathSync(value) !== prefix)
          throw new Error("npm's configured prefix differs from the invoked cotal install; run its installer launcher or correct npm_config_prefix");
      }
    }
  } catch (e) {
    rt.err(c.red(`✗ could not establish the invoked install prefix: ${message(e)}`));
    return 1;
  }
  const prefixArgs = prefix ? ["--prefix", prefix] : [];
  const rootResult = rt.executionGlobalRoot ? { status: 0, stdout: rt.executionGlobalRoot(), stderr: "" } : rt.npm(["root", "-g", ...prefixArgs]);
  if (rootResult.status !== 0) {
    rt.err(c.red(`✗ could not resolve npm's global root before install: ${failure(rootResult)}`));
    return 1;
  }
  const root = rootResult.stdout.trim();
  if (!isAbsolute(root) || /[\r\n]/.test(root)) {
    rt.err(c.red(`✗ npm returned an invalid global root: ${JSON.stringify(rootResult.stdout)}`));
    return 1;
  }

  if (prefix) {
    try {
      if (realpathSync(root) !== realpathSync(join(prefix, ...(process.platform === "win32" ? [] : ["lib"]), "node_modules")))
        throw new Error("npm's global root does not match the invoked install prefix");
    } catch (e) {
      rt.err(c.red(`✗ could not verify npm's selected global root: ${message(e)}`));
      return 1;
    }
  }

  try {
    assertConfigAncestorProtected();
  } catch (e) {
    rt.err(c.red(`✗ config folder protection: ${refusal(e)}`));
    recordUpdateDeferral(targetVersion, `config folder protection: ${preflightDetail(e)}`);
    return 1;
  }

  let releaseGlobal: () => void;
  try {
    releaseGlobal = rt.claimGlobalUpdate(root, () => rt.out("Waiting for another updater to release npm's global root"));
  } catch (e) {
    rt.err(c.red(`✗ could not reserve npm's global root for update: ${message(e)}`));
    return 1;
  }

  // Another updater may have finished while this process still has the old generation loaded.
  // Re-enter through its verified installation instead of replacing it or rolling back to stale code.
  try {
    const installed = rt.globalVersion?.(root);
    if (installed && compareSemver(installed, current) > 0 && compareSemver(installed, targetVersion) >= 0) {
      const entry = (rt.verifyUpdatedEntry ?? rt.verifyGlobalEntry)(root, installed);
      releaseGlobal();
      rt.out(`Another update installed cotal-ai@${installed}; rechecking the installed CLI`);
      const child = rt.spawn(rt.nodePath, [entry, "update", "--self", ...targetArgv(target), ...(target["stop-agents"] === true ? ["--stop-agents"] : [])], rt.env, true);
      if (child.stderr) rt.stderr(child.stderr);
      if (child.stdout) rt.stdout(child.stdout);
      return child.status ?? 1;
    }
  } catch (error) {
    releaseGlobal();
    rt.err(`could not recheck the installed global CLI: ${message(error)}`);
    return 1;
  }

  let execution: ExecutionReplacement | undefined;
  let stagedExecution = false;
  if (rt.prepareExecution) {
    stagedExecution = true;
    const prepareStarted = Date.now();
    try {
      rt.out(c.bold("cotal-ai binary"));
      rt.out(c.dim(`installing cotal-ai@${targetVersion} beside the running version; this ${current} process stays loaded until the new version is verified`));
      execution = await rt.prepareExecution(targetVersion, root);
      await execution.preflight(target);
      if (await rt.reportRunningManager(target) === "legacy") throw new Error("running Manager requires a restart that cannot preserve its agents");
      rt.out(`✓ new version installed and verified (${((Date.now() - prepareStarted) / 1000).toFixed(1)} s)`);
    } catch (error) {
      try { execution?.discard?.(); } catch { /* an unpublished copy left behind selects nothing */ }
      releaseGlobal();
      if (!execution && deferStagingFailure(error, targetVersion, rt, preflightChanged || repairedSelection)) return 0;
      recordUpdateDeferral(targetVersion, `staged pre-install check refused: ${preflightDetail(error)}`);
      rt.err(`staged pre-install check refused: ${message(error)}; no installed packages were replaced`);
      return 1;
    }
  }
  let releaseAdmission: (() => Promise<void>) | undefined;
  try {
    releaseAdmission = await rt.prepareReplacement?.();
  } catch (error) {
    try { execution?.discard?.(); } catch { /* an unpublished copy left behind selects nothing */ }
    releaseGlobal();
    recordUpdateDeferral(targetVersion, "waiting for agents to stop");
    rt.err(`update admission refused: ${message(error)}`);
    return 1;
  }
  let releaseClosure: (() => void) | undefined;
  let snapshot: UpdateSnapshot;
  const snapshotStarted = Date.now();
  try {
    releaseClosure = claimUpdateClosureAccess();
    rt.out("Saving update recovery snapshot");
    snapshot = snapshotUpdateClosure();
    rt.out(`✓ recovery snapshot saved (${((Date.now() - snapshotStarted) / 1000).toFixed(1)} s)`);
  } catch (error) {
    try { execution?.discard?.(); } catch { /* an unpublished copy left behind selects nothing */ }
    releaseClosure?.();
    await releaseAdmission?.();
    releaseGlobal();
    const detail = preflightDetail(error);
    recordUpdateDeferral(targetVersion, `update snapshot refused: ${detail}`);
    rt.err(`update snapshot refused: ${message(error)}`);
    return 1;
  }
  // npm replaces the live package tree. Keep custody until it and the verified reconcile
  // finish, even when the terminal sends Ctrl-C during that replacement.
  let interrupted = 0;
  const interrupt = (code: number): void => {
    if (interrupted) return;
    interrupted = code;
    rt.err(c.yellow("Interrupt received; finishing installation and reconciliation before exiting."));
  };
  const onInt = (): void => interrupt(130);
  const onTerm = (): void => interrupt(143);
  process.on("SIGINT", onInt);
  process.on("SIGTERM", onTerm);
  try {
  if (execution) {
    rt.out(`Switching to cotal-ai@${targetVersion}`);
  } else {
    rt.out(c.bold("cotal-ai binary"));
    rt.out(c.dim(`installing cotal-ai@${targetVersion} into npm's global installation; this ${current} process remains loaded until the verified global copy takes over`));
  }
  recordUpdateReplacement(targetVersion);
  writeUpdateRecovery({ previous: current, target: targetVersion, installed: current, phase: "replacing", reason: "global replacement in progress", owner: updateClosureOwner(), preparedRestart: rt.preparedRestart?.() ?? false, snapshot: snapshot.path, ...(execution ? { execution: execution.journal } : {}) });
  const npmInstall = ["install", "-g", ...prefixArgs, `cotal-ai@${targetVersion}`, "--json", "--fetch-retries=2", "--fetch-retry-mintimeout=1000", "--fetch-retry-maxtimeout=2000", "--fetch-timeout=15000"];
  const installStarted = Date.now();
  const installed: CommandResult = execution ? (() => {
    execution.publish();
    return { status: 0, stdout: "", stderr: "" };
  })() : await rt.spawnGlobal(
    root,
    "install",
    "npm",
    npmInstall,
    rt.env,
    false,
  );
  if (!execution) rt.out(`✓ global package install finished (${((Date.now() - installStarted) / 1000).toFixed(1)} s)`);
  if (latestNotAvailable(installed, targetVersion)) {
    // npm resolves the requested version before reifying the global tree. This refusal
    // did not replace packages, so neither rollback nor a failed-attempt charge applies.
    snapshot.discard();
    clearUpdateRecovery();
    const reason = `cotal-ai@${targetVersion} is not available yet. The release is still arriving; the next update check will try it again. No packages were replaced.`;
    recordUpdateDeferral(targetVersion, reason, true, true);
    rt.out(reason);
    return interrupted;
  }
  if (installed.stderr) rt.stderr(installed.stderr);
  if (installed.status !== 0) {
    rt.err(c.red(`✗ global cotal-ai@${targetVersion} install failed: ${failure(installed)}`));
    return await repairReplacement(`global install failed: ${failure(installed)}`);
  }

  rt.out("Verifying installed global entry");
  let entry: string;
  try {
    if (execution) { execution.verify(targetVersion); entry = execution.entry; }
    else entry = rt.verifyGlobalEntry(root, targetVersion);
  } catch (e) {
    rt.err(c.red(`✗ installed global cotal-ai could not be verified: ${message(e)}`));
    return await repairReplacement(`installed entry verification failed: ${message(e)}`);
  }
  const env: NodeJS.ProcessEnv = {
    ...rt.env,
    ...(prefix ? { npm_config_prefix: prefix } : {}),
    [UPDATE_TARGET_ENV]: targetVersion,
    [UPDATE_PARENT_ENV]: String(rt.pid),
    ...(rt.env.COTAL_AUTO_UPDATE !== "1" ? { [UPDATE_PARENT_WAITS_ENV]: "1" } : {}),
  };
  delete env[EXT_UPDATE_PARENT_ENV];
  rt.out(`Reconciling installed cotal-ai@${targetVersion}`);
  const reconcileStarted = Date.now();
  const child = await rt.spawnGlobal(root, "reconcile", rt.nodePath, [entry, "update", ...targetArgv(target)], env, true);
  rt.out(`✓ installed reconciliation finished (${((Date.now() - reconcileStarted) / 1000).toFixed(1)} s)`);
  if (child.stderr) rt.stderr(child.stderr);
  if (child.stdout) rt.stdout(child.stdout);
  if (child.status !== 0) {
    rt.err(c.red(`✗ cotal-ai@${targetVersion} installed globally, but its reconcile failed: ${failure(child)}`));
    return await repairReplacement(`reconcile failed: ${failure(child)}`, child.status ?? 1, readUpdateRecovery()?.phase === "verified-ready");
  }
  let activationDeferred: string | void = undefined;
  if (rt.env.COTAL_AUTO_UPDATE !== "1" || rt.automaticGenerationWait) {
    try {
      const recovery = readUpdateRecovery();
      if (recovery && recovery.phase !== "verified-ready") writeUpdateRecovery({ ...recovery, installed: targetVersion, phase: "verified-ready" });
      activationDeferred = await rt.waitForInstalledGeneration?.(targetVersion);
    } catch (error) {
      rt.err(c.red(`✗ installed daemon generation: ${refusal(error)}`));
      return await repairReplacement(`installed daemon generation: ${message(error)}`, 1, true);
    }
  }
  try { execution?.verify(targetVersion); }
  catch (error) { return await repairReplacement(`selected execution after reconciliation: ${message(error)}`, 1, true); }
  rt.out("Removing completed update recovery snapshot");
  snapshot.discard();
  clearUpdateRecovery();
  recordUpdateCompletion(targetVersion, activationDeferred || `updated to ${targetVersion}`, !activationDeferred);
  execution?.complete?.();
  if (activationDeferred) {
    rt.err(activationDeferred);
    return interrupted || 1;
  }
  if (stagedExecution) rt.out(c.green(`✓ cotal-ai@${targetVersion} in use and reconciled`));
  else rt.out(c.green(`✓ cotal-ai@${targetVersion} installed globally and reconciled`));
  return interrupted;

  async function reconcileVersion(version: string): Promise<boolean> {
    const verified = execution ? (execution.verify(version), version === targetVersion ? execution.entry : join(root, "cotal-ai", "dist/cotal.js")) : rt.verifyGlobalEntry(root, version);
    const repairEnv: NodeJS.ProcessEnv = { ...rt.env, ...(prefix ? { npm_config_prefix: prefix } : {}), [UPDATE_TARGET_ENV]: version, [UPDATE_PARENT_ENV]: String(rt.pid), ...(rt.env.COTAL_AUTO_UPDATE !== "1" ? { [UPDATE_PARENT_WAITS_ENV]: "1" } : {}) };
    delete repairEnv[EXT_UPDATE_PARENT_ENV];
    const result = await rt.spawnGlobal(root, "reconcile", rt.nodePath, [verified, "update", ...targetArgv(target)], repairEnv, true);
    if (result.stderr) rt.stderr(result.stderr);
    if (result.stdout) rt.stdout(result.stdout);
    if (result.status !== 0) return false;
    execution?.verify(version);
    if (rt.env.COTAL_AUTO_UPDATE !== "1" || rt.automaticGenerationWait) {
      const recovery = readUpdateRecovery();
      if (recovery && recovery.phase !== "verified-ready") writeUpdateRecovery({ ...recovery, installed: version, phase: "verified-ready" });
      await rt.waitForInstalledGeneration?.(version);
    }
    return true;
  }

  async function repairReplacement(reason: string, failureStatus = 1, skipTargetRetry = false): Promise<number> {
    if (!skipTargetRetry) {
      rt.err(c.yellow("Retrying reconciliation of the installed generation before rollback."));
      try {
        if (await reconcileVersion(targetVersion)) {
          snapshot.discard();
          clearUpdateRecovery();
          recordUpdateCompletion(targetVersion, `repaired and updated to ${targetVersion}`, true);
          execution?.complete?.();
          rt.out(c.green(`✓ cotal-ai@${targetVersion} repaired and reconciled`));
          return interrupted;
        }
      } catch (error) { rt.err(`reconcile retry: ${message(error)}`); }
    }
    rt.err(c.yellow(`Restoring verified cotal-ai@${current} through the global updater.`));
    try {
      const recovery = readUpdateRecovery();
      if (!recovery) throw new Error("update recovery journal is missing");
      writeUpdateRecovery({ ...recovery, phase: "restoring" });
      if (execution) {
        execution.restore();
      } else {
        await checkReleaseArchives(current, rt);
        const restored = await rt.spawnGlobal(root, "install", "npm", ["install", "-g", ...prefixArgs, `cotal-ai@${current}`], rt.env, true);
        if (restored.status !== 0) throw new Error(failure(restored));
        rt.verifyGlobalEntry(root, current);
      }
      snapshot.restore();
      if (execution) execution.verify(current);
      await releaseAdmission?.();
      releaseAdmission = await rt.prepareReplacement?.();
      if (!await reconcileVersion(current)) throw new Error("previous generation reconciliation failed");
      snapshot.discard();
      clearUpdateRecovery();
      recordUpdateCompletion(targetVersion, `update failed; restored and reconciled ${current}`, false);
      execution?.complete?.();
      rt.err(`Update failed; cotal-ai@${current} was restored and reconciled. Run \`cotal update --self\` to try again.`);
      return interrupted || failureStatus;
    } catch (error) {
      let installedVersion = "unknown";
      try { installedVersion = JSON.parse(readFileSync(join(root, "cotal-ai", "package.json"), "utf8")).version ?? "unknown"; } catch { /* Report an unknown install instead of claiming the previous tree survived. */ }
      const detail = `${reason}; repair failed: ${message(error)}`;
      writeUpdateRecovery({ ...readUpdateRecovery(), previous: current, target: targetVersion, installed: installedVersion, phase: "paused", reason: detail });
      rt.err(c.red(`✗ Update stopped: installed cotal-ai ${installedVersion}; ${detail}. Automatic updates are paused. Run \`cotal update --self\` to repair this installation.`));
      return interrupted || failureStatus;
    }
  }
  } finally {
    try {
      try { await releaseAdmission?.(); }
      finally { try { releaseClosure?.(); } finally { releaseGlobal(); } }
    } finally {
      process.off("SIGINT", onInt);
      process.off("SIGTERM", onTerm);
    }
  }
}

function targetArgv(target: Record<string, unknown>): string[] {
  const argv: string[] = [];
  for (const name of ["space", "server", "creds", "on"] as const) {
    const value = target[name];
    if (typeof value === "string") argv.push(`--${name}`, value);
  }
  return argv;
}

function reportVersion(current: string, latest: string | undefined, rt: UpdateRuntime, reconciled: boolean): void {
  const available = latest !== undefined && compareSemver(latest, current) > 0;
  rt.out(renderReport({ sections: [
    { title: "CLI version", blocks: [{ kind: "fields", rows: [["This process", current], ["Registry latest", latest ?? "not established"], ["Update", latest === undefined ? { text: "unknown", tone: "waiting" } : available ? { text: "available", tone: "waiting" } : "no newer latest tag"]] }, { kind: "lines", lines: [{ text: "Running processes keep the generation they loaded. This version report does not prove every live service was upgraded.", tone: "hint" }] }] },
    ...(reconciled ? [{ title: "Next", blocks: [{ kind: "commands" as const, items: [{ command: available ? "cotal update --self" : "cotal status", description: !available ? "Inspect the machine and selected space" : rt.checkout() ? "Install the validated CLI as a separate global copy and reconcile through it; this checkout does not change" : "Install the validated CLI and reconcile its matching extensions" }] }] }] : []),
  ] }, "rich", process.stdout));
}

function childBinding(rt: UpdateRuntime):
  | { kind: "none" }
  | { kind: "invalid"; reason: string }
  | { kind: "bound"; target: string } {
  const target = rt.env[UPDATE_TARGET_ENV];
  const parent = rt.env[UPDATE_PARENT_ENV];
  if (target === undefined && parent === undefined) return { kind: "none" };
  if (!target || !STRICT_SEMVER.test(target)) return { kind: "invalid", reason: "target version is missing or invalid" };
  if (!parent || !/^\d+$/.test(parent)) return { kind: "invalid", reason: "parent pid is missing or invalid" };
  if (Number(parent) !== rt.parentPid) return { kind: "invalid", reason: "parent pid does not match the launching process" };
  return { kind: "bound", target };
}
