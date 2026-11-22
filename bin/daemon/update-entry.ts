/** The binary composes machine-daemon custody with the stock package updater. */
import { existsSync, readFileSync, readdirSync, readlinkSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline/promises";
import { execFileSync } from "node:child_process";
import { registry, type Command } from "@cotal-ai/core";
import { claimGlobalNpmUpdateLock } from "@cotal-ai/workspace";
import { submitSystemdUnitControl } from "@cotal-ai/cli";
import { update, updateRuntime, installedCliVersion, localUpdateManagers, readManagerContinuity, readUpdateManagerContinuity, updateManagerPin, repairInstallModes, verifyGlobalEntry } from "@cotal-ai/cli/update";
import { withIdpSessionDir, withRemoteExchangeRetry } from "@cotal-ai/auth";
import { brokerAddressKey, assertRecordIdentity, CommandFailure, homeCotalDir, readUpdateRecovery, claimUpdateClosureAccess, recordUpdateActivation, writeUpdateRecovery, resolveControlTarget, type UpdateAdmission } from "@cotal-ai/workspace";
import { askManager } from "@cotal-ai/workspace/control";
import { daemonPaths, daemonUserServiceEnv, EndpointRefusal, type DaemonPaths } from "./endpoint.js";
import { managerViaDaemon, queryDaemon } from "./client.js";
import { installedDaemonIdentity, linuxMissingProgram, planUninstall, preflightInstalledDaemon, reconcileMissingShellRuntime, repairMissingInstalledProgram, restartInstalled, startEnabledInstalled, unitReceiptFile } from "./install.js";
import { excludeLifetime, processBirth, readLifetimeRecord } from "./lifetime.js";
import { isDaemonStatusInterrupted, waitForInstalledDaemonGeneration } from "./update-generation.js";
import { cleanupExecutionStore } from "../execution-store.js";
import { repairExecutionInstallModes } from "../execution-transaction.js";
import { prepareExecutionUpdate, preflightExecutionUpdate, recoverExecutionUpdate, executionInstallRoot } from "./execution-update.js";
import type { ExecutionPreinstallReceipt } from "./execution-preinstall-client.js";
import { findMesh, logicalExecutionEntry, pruneRetainedConnectorConfig, retainConnectorConfig, shellPath } from "@cotal-ai/workspace";
import { reportRunningManagers } from "@cotal-ai/cli/update";
import { adoptAutomaticUpdateChild } from "./update-scope.js";
import { captureWindowsGeneration, closeWindowsGeneration, windowsGenerationLifecycle } from "./update-generation-win32.js";
import { hasUpdateDaemonLifetime, observeUpdateDaemon, sameUpdateDaemon } from "./update-lifetime.js";
import { daemonServiceRequirement, foreignDaemonUpdateReport } from "./guidance.js";
import { observeExecutionVersion, selectExecutionProgram } from "../cotal.js";

/** A reconcile child of a parent that said it waits after the child and prints the line. A parent
 *  from before that marker never waits there, so its child keeps the line. */
export function currentParentWaits(env: NodeJS.ProcessEnv, parentPid: number, journaled: boolean): boolean {
  const parent = env.COTAL_UPDATE_PARENT;
  return env.COTAL_UPDATE_PARENT_WAITS === "1" && parent !== undefined && /^\d+$/.test(parent) && Number(parent) === parentPid && journaled;
}

async function posixGenerationLifecycle(paths: DaemonPaths, quiet = false): Promise<{ poll(): Promise<boolean | void>; close(): void }> {
  const initial = readLifetimeRecord(paths.lock);
  let observedLive = Boolean(initial?.start && processBirth(initial.pid) === initial.start);
  let started = false;
  return {
    async poll() {
      if (started || observedLive) return;
      const current = readLifetimeRecord(paths.lock);
      if (current?.start && processBirth(current.pid) === current.start) {
        observedLive = true;
        return;
      }
      const installation = installedDaemonIdentity(paths);
      if (!installation.same) {
        if (!quiet) console.log(foreignDaemonUpdateReport(installation.installedEntry));
        started = true;
        return false;
      }
      started = true;
      const outcome = await startEnabledInstalled(paths, undefined);
      if (!outcome.started) {
        if (!quiet) console.log(`machine daemon: ${outcome.unit}: service is ${outcome.state}; not started`);
        return false;
      }
    },
    close() {},
  };
}

/** Refuse a session that has no runtime directory while this account's daemon runs: its socket cannot be named from here. */
function assertDaemonReachable(): void {
  try { daemonPaths(); return; }
  catch (error) { if (!(error instanceof EndpointRefusal) || error.code !== "NO_RUNTIME_DIR") throw error; }
  const lifetime = readLifetimeRecord(join(homeCotalDir(), "daemon", "daemon.lock"));
  if (lifetime?.start && processBirth(lifetime.pid) === lifetime.start)
    throw new Error("the machine daemon is running and this session has no XDG_RUNTIME_DIR to reach it; run the update from a login session of this account, or leave it to the daemon's automatic update");
}

/** Retry only status. A disappearing socket after an interruption is not proof of absence. */
async function reconcileDaemonStatus(paths: DaemonPaths, expected = false): ReturnType<typeof queryDaemon> {
  const deadline = Date.now() + 120_000;
  let interruption: unknown;
  for (;;) {
    try { return await queryDaemon({ paths, timeoutMs: Math.min(20_000, Math.max(1, deadline - Date.now())) }); }
    catch (error) {
      if (isDaemonStatusInterrupted(error)) interruption = error;
      else if (!(error instanceof EndpointRefusal && error.code === "NOT_RUNNING" && (expected || interruption))) throw error;
      await new Promise(resolve => setTimeout(resolve, Math.min(250, Math.max(0, deadline - Date.now()))));
      if (Date.now() >= deadline) throw interruption ?? error;
    }
  }
}

async function collectConnectorSets(): Promise<void> {
  try {
    const entry = logicalExecutionEntry();
    if (!entry || updateRuntime.checkout()) return;
    const release = claimUpdateClosureAccess();
    try {
      const holders: (string | undefined)[] = [];
      const managers = localUpdateManagers({}, entry);
      for (const manager of managers) {
        if (manager.ownership === "foreign" || !manager.instanceId) return;
        if (!manager.process || assertRecordIdentity(manager.process).kind !== "match") return;
        const target = await resolveControlTarget({ space: manager.space, server: manager.server }, "control-caller-admin", manager.instanceId, { onRefusal: "throw", readOnly: true });
        const reply = await askManager({ versionSkew: text => text, roster: async () => [] }, manager.space, target.server, "managerStatus", undefined, target.auth, "owner", 3000, { instanceId: manager.instanceId });
        if (!reply.ok || assertRecordIdentity(manager.process).kind !== "match") return;
        const version = (reply.data as { version?: unknown } | undefined)?.version;
        holders.push(typeof version === "string" ? version : undefined);
      }
      if (hasUpdateDaemonLifetime()) {
        const paths = daemonPaths();
        const reply = await queryDaemon({ paths });
        if (!reply.ok) return;
        const lifetime = readLifetimeRecord(paths.lock);
        if (!lifetime?.start || lifetime.pid !== reply.result.pid || processBirth(lifetime.pid) !== lifetime.start) return;
        // Hosted Managers can remain on an earlier generation than their daemon.
        // Their separate records must all have appeared in the authenticated inventory.
        if ((reply.result.managers ?? []).some(row => row.pid !== undefined && !managers.some(manager => manager.pid === row.pid && manager.instanceId === row.instanceId))) return;
        holders.push(reply.result.version);
      }
      if (managers.some(manager => !manager.process || assertRecordIdentity(manager.process).kind !== "match")) return;
      pruneRetainedConnectorConfig(holders);
    } finally { release(); }
  } catch { /* An incomplete inventory or failed collection never fails the update. */ }
}

const command = registry.resolve<Command>("command", "update");
registry.unregister("command", "update");
const composed: Command = { ...command, async run(args) {
  let hostedSpaces: string[] = [];
  let daemonObserved = false;
  let preparedRestart = false;
  let currentPackages = false;
  let retainedReconciliation = false;
  let askedToStop = false;
  let targetReceipt: ExecutionPreinstallReceipt | undefined;
  let replacementVersion: string | undefined;
  let targetAdmissionChecked = false;
  let reconcileDaemonObserved = false;
  let recoveryFence = false;
  let repairService: DaemonPaths | undefined;
  let repairServiceStopped = false;
  let interruptedChildRoot: string | undefined;
  let legacyRepair = false;
  let admission: UpdateAdmission | undefined;
  const staged = Boolean(logicalExecutionEntry() && !updateRuntime.checkout() && (process.platform === "linux" || process.platform === "darwin"));
  const standaloneReconcile = args.values.self !== true && !process.env.COTAL_UPDATE_PARENT;
  const recoveryAdmission = readUpdateRecovery();
  if (recoveryAdmission?.admission && process.env.COTAL_UPDATE_PARENT === String(process.ppid) && recoveryAdmission.owner?.pid === process.ppid && recoveryAdmission.phase !== "restoring" && recoveryAdmission.target === updateRuntime.version()) {
    const release = claimUpdateClosureAccess(); release();
    admission = recoveryAdmission.admission;
  }
  const systemdActivationDeferred = () => process.platform === "linux" && admission?.disposition === "deferred" &&
    admission.reason.startsWith("the systemd user manager did not answer `systemctl --user show-environment`");
  const deferActivation = (reason: string, occupied: number | null = null) => {
    admission = { disposition: "deferred", occupied, hostedSpaces: admission?.hostedSpaces ?? [], reason: reason.slice(0, 2000) };
  };
  const consumeAdmission = async (flags: Record<string, unknown>): Promise<void> => {
    if (admission?.disposition !== "consent-stop") return;
    const plan = admission;
    let consent = flags["stop-agents"] === true && process.env.COTAL_AUTO_UPDATE !== "1";
    if (!consent && !askedToStop && !process.env.COTAL_UPDATE_PARENT && process.env.COTAL_AUTO_UPDATE !== "1" && process.stdin.isTTY && process.stdout.isTTY) {
      askedToStop = true;
      console.log(`These agents cannot survive this update: ${plan.inventory.flatMap(manager => manager.agents.map(agent => `${manager.space}: ${agent.name}`)).join(", ")}`);
      const input = createInterface({ input: process.stdin, output: process.stdout });
      try { consent = /^(y|yes)$/i.test((await input.question("Stop these agents and continue the update? [y/N] ")).trim()); }
      finally { input.close(); }
    }
    if (!consent) { deferActivation("running agents were not stopped; save their work and run `cotal update --self --stop-agents` to activate", plan.occupied); return; }
    for (const manager of plan.inventory) await withIdpSessionDir(homeCotalDir(), async () => {
      const target = await resolveControlTarget({ space: manager.space }, "control-caller-privileged", manager.instanceId, { onRefusal: "throw", readOnly: true });
      const client = { versionSkew: (text: string) => text, roster: async () => [] };
      const fresh = await askManager(client, manager.space, target.server, "ps", undefined, target.auth, "owner", 3000, { instanceId: manager.instanceId });
      const rows = fresh.data as { name: string; id: string; lifecycleUid: string }[];
      if (!fresh.ok || !Array.isArray(rows) || rows.length !== manager.agents.length || manager.agents.some(agent => !rows.some(row => row.name === agent.name && row.id === agent.id && row.lifecycleUid === agent.lifecycleUid))) throw new Error("target-issued agent inventory changed after consent; no further stops authorized");
      for (const agent of manager.agents) {
        const result = await askManager(client, manager.space, target.server, "stop", { name: agent.name }, target.auth, "owner", 20_000, { instanceId: manager.instanceId, expectedTarget: { id: agent.id, lifecycleUid: agent.lifecycleUid } });
        if (!result.ok) throw new Error(result.error ?? `could not stop ${agent.name}`);
      }
    });
    admission = { disposition: "restart-empty", occupied: 0, hostedSpaces: plan.hostedSpaces };
  };
  const retainsExecution = () => targetReceipt !== undefined || readUpdateRecovery()?.execution !== undefined;
  const reportsRetainedExecution = () => retainedReconciliation || retainsExecution();
  const retainedReads = (flags: Record<string, unknown>) => readManagerContinuity(flags, { readOnly: true, retainGraph: true, installedEntry: logicalExecutionEntry() });
  const retainedReport = (flags: Record<string, unknown>) => reportRunningManagers(flags, retainedReads, selected => localUpdateManagers(selected, logicalExecutionEntry()), { retainGraph: true });
  /** Target admission covers the daemon and the Managers it hosts. Every other local Manager keeps
   *  the generation it loaded, so it is named here and a failed read never refuses the update. */
  const nameRetainedManagers = async (flags: Record<string, unknown>): Promise<void> => {
    if (typeof flags.creds === "string") return;
    try {
      const hosted = new Set<string | undefined>();
      if (targetReceipt?.daemon) {
        const daemon = await queryDaemon({ paths: daemonPaths() });
        if (!daemon.ok) throw new Error(`machine daemon custody is unreadable: ${daemon.error.message}`);
        for (const manager of daemon.result.managers ?? []) hosted.add(manager.instanceId);
      }
      for (const manager of localUpdateManagers(flags, logicalExecutionEntry())) {
        if (manager.ownership !== "foreign" && hosted.has(manager.instanceId)) continue;
        await readUpdateManagerContinuity(manager, flags, retainedReads, { retainGraph: true });
      }
    } catch (error) {
      console.log(`Managers outside the machine daemon were not all read (${error instanceof Error ? error.message : String(error)}); each keeps running the version it loaded`);
    }
  };
  try {
  if (args.values.self === true && args.values.check !== true && !args.values.auto && !args.values.notify && !process.env.COTAL_AUTO_UPDATE && !process.env.COTAL_UPDATE_PARENT && (process.platform === "darwin" || process.platform === "linux")) {
    let paths: DaemonPaths | undefined;
    try { paths = daemonPaths(); }
    catch (error) {
      if (process.platform !== "linux" || !(error instanceof EndpointRefusal) || error.code !== "NO_RUNTIME_DIR") throw error;
      if (linuxMissingProgram({ state: join(homeCotalDir(), "daemon") })) throw new CommandFailure("refused", "TARGET_UNAVAILABLE", "the recorded daemon program is missing and this session cannot reach the user service", { remedy: "run `cotal daemon install` from a logged-in session using the working Cotal installation" });
    }
    if (paths && await repairMissingInstalledProgram(paths)) console.log("The recorded service's missing program was replaced with this Cotal installation. An operator-disabled service remains stopped.");
  }
  if (process.platform === "linux" && args.values.self === true && process.env.COTAL_AUTO_UPDATE !== "1" && !process.env.COTAL_UPDATE_PARENT) {
    const prefix = updateRuntime.installPrefix();
    if (prefix && existsSync(join(prefix, "lib/node_modules/.cotal-update-child"))) {
      const marker = JSON.parse(readFileSync(join(prefix, "lib/node_modules/.cotal-update-child"), "utf8"));
      if (marker.phase === "ambiguous" || marker.phase === "pending") interruptedChildRoot = join(prefix, "lib/node_modules");
      if ((marker.phase === "ambiguous" && marker.custody === undefined) ||
        (marker.phase === "pending" && marker.gated === undefined && marker.intermediary === false && ["global install", "global reconcile"].includes(marker.operation))) {
        legacyRepair = true;
        const paths = daemonPaths();
        if (existsSync(unitReceiptFile(paths))) {
          if (!installedDaemonIdentity(paths).same) throw new Error("ambiguous update repair cannot stop another installation's daemon");
          try {
            const reply = await queryDaemon({ paths });
            if (!reply.ok) throw new Error("daemon status unavailable for ambiguous update repair");
            await managerViaDaemon({ paths }, { op: "managers-prepare-restart" });
            repairService = paths;
          } catch (error) {
            if (!(error instanceof EndpointRefusal) || error.code !== "NOT_RUNNING") throw error;
            repairService = paths;
          }
        }
      }
    }
  }
  const runtime = { ...updateRuntime, automaticGenerationWait: process.platform === "linux",
    claimGlobalUpdate: (root: string, onWait?: () => void) => claimGlobalNpmUpdateLock(root, { waitMs: 10 * 60_000, renew: true, onWait, ...(legacyRepair && root === interruptedChildRoot ? { repairAmbiguous: () => {
      const ancestors = new Set<number>();
      const unavailable = () => new CommandFailure("refused", "LIFECYCLE_BLOCKED", "The interrupted update cannot be recovered until the systemd user manager answers on the user bus. Run `cotal update --self` again when it is available.", {
        native: { outcome: "not-executed" },
      });
      let native: string;
      try {
        native = execFileSync("busctl", ["--user", "--no-pager", "--timeout=5s", "call", "org.freedesktop.DBus", "/org/freedesktop/DBus", "org.freedesktop.DBus", "GetConnectionUnixProcessID", "s", "org.freedesktop.systemd1"], { env: daemonUserServiceEnv(), encoding: "utf8", timeout: 6000, stdio: ["ignore", "pipe", "pipe"] }).trim();
      } catch { throw unavailable(); }
      const manager = /^u ([1-9]\d*)$/.exec(native);
      if (!manager) throw unavailable();
      const managerPid = Number(manager[1]);
      const managerStart = processBirth(managerPid);
      if (!managerStart) throw unavailable();
      if (repairService) {
        const plan = planUninstall(repairService, undefined);
        if (!installedDaemonIdentity(repairService).same || plan.mechanism !== "systemd-user") throw new Error("daemon installation changed before repair");
        submitSystemdUnitControl("stop", plan.unit, daemonUserServiceEnv());
        repairServiceStopped = true;
      }
      for (let pid = process.pid; pid > 1 && !ancestors.has(pid);) {
        ancestors.add(pid);
        const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
        pid = Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1]);
      }
      for (const entry of readdirSync("/proc")) {
        if (!/^\d+$/.test(entry) || ancestors.has(Number(entry))) continue;
        const pid = Number(entry);
        try {
          if (statSync(`/proc/${pid}`).uid !== process.getuid!()) continue;
          if (pid === managerPid && processBirth(pid) === managerStart) continue;
          if (readFileSync(`/proc/${pid}/comm`, "utf8").trim() === "(sd-pam)") {
            const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
            const parent = Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1]);
            if (parent === managerPid && processBirth(parent) === managerStart) continue;
          }
          const executable = readlinkSync(`/proc/${pid}/exe`);
          if (executable !== "/usr/bin/dbus-daemon")
            throw new Error(`ambiguous update repair is waiting for process ${pid} to exit; no marker was cleared`);
        } catch (error) {
          if (["ENOENT", "ESRCH"].includes((error as NodeJS.ErrnoException).code ?? "") && !existsSync(`/proc/${pid}`)) continue;
          throw error;
        }
      }
      console.log("Retaining the interrupted update marker after confirming this account has no other application process.");
    } } : {}) }),
    ...(logicalExecutionEntry() && !updateRuntime.checkout() && (process.platform === "linux" || process.platform === "darwin") ? {
      preflightExecution: preflightExecutionUpdate,
      repairInstallModes: (root: string) => repairExecutionInstallModes(executionInstallRoot(), () => repairInstallModes(root)),
      executionGlobalRoot: () => dirname(executionInstallRoot()),
      globalVersion: () => observeExecutionVersion(executionInstallRoot()),
      verifyUpdatedEntry: (root: string, version: string) => {
        const installed = executionInstallRoot();
        const selected = selectExecutionProgram(installed);
        const selectedVersion = updateRuntime.globalVersion!(dirname(selected.root));
        if (selectedVersion !== version) throw new Error("the selected execution changed before the update recheck");
        const packageVersion = updateRuntime.globalVersion!(root);
        if (!packageVersion) throw new Error("the installed global package is missing");
        return verifyGlobalEntry(root, packageVersion);
      },
      prepareExecution: async (version: string, root: string) => {
        const execution = await prepareExecutionUpdate(version, root, receipt => { targetReceipt = receipt; admission = receipt.admission; hostedSpaces = [...receipt.hostedSpaces]; daemonObserved = receipt.daemon !== undefined; });
        replacementVersion = version;
        return { entry: execution.entry, get journal() { return execution.journal; }, preflight: execution.preflight, restore: execution.restore, verify: execution.verify, complete: execution.complete, discard: execution.discard, publish() {
          const recovery = readUpdateRecovery();
          if (!recovery || !admission) throw new Error("target admission has no bound update transaction");
          writeUpdateRecovery({ ...recovery, admission });
          recordUpdateActivation(logicalExecutionEntry()!, version, admission.disposition === "deferred" ? admission.reason : undefined);
          execution.publish();
        } };
      },
      recoverExecution: recoverExecutionUpdate,
    } : {}), async prepareReconciliation(flags: Record<string, unknown>) {
    const entry = logicalExecutionEntry();
    if (!entry || updateRuntime.checkout() || !["linux", "darwin"].includes(process.platform) || process.env.COTAL_UPDATE_PARENT || readUpdateRecovery()) return;
    let hostedInstances = new Set<string | undefined>();
    if (args.values.self !== true || hasUpdateDaemonLifetime()) {
      try {
        const daemon = await reconcileDaemonStatus(daemonPaths());
        if (!daemon.ok) throw new Error(`machine daemon custody is unreadable: ${daemon.error.message}`);
        reconcileDaemonObserved = standaloneReconcile;
        hostedInstances = new Set((daemon.result.managers ?? []).map(manager => manager.instanceId));
      } catch (error) {
        if (!(error instanceof EndpointRefusal) || !["NOT_RUNNING", "NO_RUNTIME_DIR"].includes(error.code)) throw error;
        if (error.code === "NO_RUNTIME_DIR") assertDaemonReachable();
      }
    }
    const managers = localUpdateManagers(flags, entry).filter(manager => !hostedInstances.has(manager.instanceId));
    if (!managers.length) return;
    for (const manager of managers) {
      if (!manager.process || assertRecordIdentity(manager.process).kind !== "match") throw new Error(`local Manager ${manager.instanceId} changed before reconciliation admission`);
      await readUpdateManagerContinuity(manager, flags, retainedReads, { retainGraph: true });
      if (assertRecordIdentity(manager.process).kind !== "match") throw new Error(`local Manager ${manager.instanceId} changed during reconciliation admission`);
    }
    retainConnectorConfig();
    retainedReconciliation = true;
    for (const manager of managers) {
      if (manager.ownership === "foreign") continue;
      const command = findMesh(manager.space)?.userAuth?.remote
        ? `\`cd ${shellPath(manager.root)} && cotal manager restart --with-agents --yes --space ${shellPath(manager.space)}\``
        : `\`cd ${shellPath(manager.root)} && cotal down --with-agents --yes --space ${shellPath(manager.space)} && cotal up --space ${shellPath(manager.space)}\``;
      console.log(`Manager ${manager.instanceId} keeps its agents on the previous version and takes the installed version at its next restart. When their work is finished, restart from its recorded folder: ${command}`);
    }
  }, isCurrent() {
    currentPackages = updateRuntime.isCurrent?.() === true;
    return currentPackages;
  }, async automaticUpdateAdvice() {
    const systemdAdvice = () => {
      const requirement = daemonServiceRequirement();
      return requirement && `${requirement.message} ${requirement.remedy}`;
    };
    try {
      const reply = await queryDaemon({ paths: daemonPaths() });
      if (!reply.ok) throw new Error(`machine daemon update schedule is unreadable: ${reply.error.message}`);
      if (!reply.result.update) throw new Error("machine daemon returned no update schedule; run `cotal daemon status` to inspect it");
      if (reply.result.update.automatic && typeof reply.result.update.nextAttempt === "string") return undefined;
      const inactive = "The daemon is not scheduling automatic installation. Run `cotal daemon status` to inspect it.";
      const unsupported = systemdAdvice();
      return `${inactive} ${unsupported ?? "If no daemon service is installed, run `cotal daemon install`."}`;
    } catch (error) {
      if (error instanceof EndpointRefusal && error.code === "PEER_NOT_LOCK_OWNER") {
        return `Could not check the automatic update schedule: ${error.message}.`;
      }
      if (error instanceof EndpointRefusal && ["NOT_RUNNING", "NO_RUNTIME_DIR"].includes(error.code)) {
        return systemdAdvice() ?? "No daemon service is running the automatic update schedule. Run `cotal daemon install`, then inspect `cotal daemon status`.";
      }
      throw error;
    }
  }, async preflightReplacement() {
    if (staged && args.values.self === true || admission) return;
    await updateRuntime.preflightReplacement?.();
    preflightInstalledDaemon({ state: join(homeCotalDir(), "daemon") });
  }, adoptUpdateChild: adoptAutomaticUpdateChild, preparedRestart: () => preparedRestart, async prepareReplacement() {
    if (readUpdateRecovery()?.phase === "restoring") admission = undefined;
    let paths: DaemonPaths | undefined;
    try { paths = daemonPaths(); }
    catch (error) { if (!(error instanceof EndpointRefusal) || error.code !== "NO_RUNTIME_DIR") throw error; }
    if (targetReceipt && !targetAdmissionChecked && readUpdateRecovery()?.phase !== "restoring") {
      // The lifetime record lives under the home, so it is readable in a session with no runtime directory.
      if (!sameUpdateDaemon(targetReceipt.daemon, await observeUpdateDaemon()))
        throw new Error("machine daemon lifetime changed after target pre-install checks; retry the update");
      retainConnectorConfig();
    }
    if (admission?.disposition === "deferred") { targetAdmissionChecked = true; return async () => {}; }
    if (!daemonObserved || !paths) {
      targetAdmissionChecked = true;
      return async () => {};
    }
    try { await managerViaDaemon({ paths }, { op: "managers-prepare-restart" }); }
    catch (error) {
      if (readUpdateRecovery()?.phase === "restoring" && error instanceof EndpointRefusal && error.code === "NOT_RUNNING") {
        const exclusion = excludeLifetime(paths.lock);
        exclusion.release();
        return async () => {};
      }
      if (!admission) throw new Error(`daemon unavailable or refused update preparation: ${error instanceof Error ? error.message : String(error)}`);
      deferActivation(`restart preparation was not confirmed: ${error instanceof Error ? error.message : String(error)}`);
      return async () => {};
    }
    preparedRestart = true;
    targetAdmissionChecked = true;
    return async () => {
      try {
        const current = await queryDaemon({ paths });
        // The daemon authenticates this caller's process lifetime and releases only its fences.
        // A staged rollback may have prepared a newer daemon than the updater's loaded code.
        if (current.ok && (retainsExecution() || current.result.version === updateRuntime.version())) await managerViaDaemon({ paths }, { op: "managers-abort-restart" });
      } catch (error) {
        if (!(error instanceof EndpointRefusal) || !["NOT_RUNNING", "PEER_NOT_LOCK_OWNER"].includes(error.code)) throw error;
      }
    };
  }, waitForInstalledGeneration: async (version: string) => {
    if (admission?.disposition === "deferred") {
      // The reconcile child must finish successfully. The publishing parent owns the final outcome.
      if (!systemdActivationDeferred() || !targetReceipt?.daemon) return;
      const pid = targetReceipt.daemon.pid;
      let current: Awaited<ReturnType<typeof queryDaemon>> | undefined;
      try { current = await queryDaemon({ paths: daemonPaths(), timeoutMs: 5_000 }); }
      catch { /* Activation is already deferred. Do not claim that an unreadable PID still answers. */ }
      if (current?.ok && current.result.version === version && current.result.state === "ready") return;
      const daemon = current?.ok && current.result.pid === pid
        ? `machine daemon PID ${pid} still runs Cotal ${current.result.version}`
        : `could not confirm activation of the machine daemon (previous PID ${pid})`;
      return `machine daemon activation deferred: cotal-ai@${version} was installed and reconciled, but ${daemon}. The systemd user manager did not answer. Run \`cotal update\` from a session where \`systemctl --user show-environment\` answers.`;
    }
    if (process.platform === "linux" && process.env.COTAL_AUTO_UPDATE === "1") {
      const paths = daemonPaths();
      if (existsSync(unitReceiptFile(paths)) && installedDaemonIdentity(paths).same) {
        const current = await queryDaemon({ paths }).catch(error => {
          if (error instanceof EndpointRefusal && error.code === "NOT_RUNNING") return undefined;
          throw error;
        });
        if (current?.ok && current.result.version !== version) await restartInstalled(paths, undefined, false, version);
      }
    }
    // A current parent waits after this child and prints the line. An older parent prints nothing,
    // so this child keeps the line. The wait itself runs either way.
    const recovery = readUpdateRecovery();
    const currentParent = currentParentWaits(process.env, process.ppid, recovery !== undefined);
    const restartPrepared = process.platform === "linux" && process.env.COTAL_AUTO_UPDATE !== "1" &&
      process.env.COTAL_UPDATE_PARENT === String(process.ppid) && process.env.COTAL_UPDATE_TARGET_VERSION === version &&
      recovery?.phase === "verified-ready" && recovery.installed === version && recovery.preparedRestart === true &&
      recovery.owner?.pid === process.ppid && recovery.owner.nonce === process.env.COTAL_UPDATE_CLOSURE_NONCE &&
      recovery.owner.start === process.env.COTAL_UPDATE_CLOSURE_START;
    if (restartPrepared) { const release = claimUpdateClosureAccess(); release(); }
    await waitForInstalledDaemonGeneration(version, {
      lifecycle: (paths: DaemonPaths, deadline: number) => process.platform === "win32" ? windowsGenerationLifecycle(paths, deadline, currentParent) : posixGenerationLifecycle(paths, currentParent),
      quiet: currentParent,
      restartPrepared,
    });
  }, reportRunningManager: (flags: Record<string, unknown>) => withRemoteExchangeRetry(async () => {
    if (admission) {
      await consumeAdmission(flags);
      if (targetReceipt) await nameRetainedManagers(flags);
      if (admission.disposition === "deferred" || targetReceipt) return "none";
      // No daemon runs: nothing is hosted, so there is no fence to confirm.
      if (!await observeUpdateDaemon()) return "none";
      const observed = await queryDaemon({ paths: daemonPaths() });
      const evidence = observed.ok ? observed.result.update?.restartEvidence : undefined;
      if (!evidence?.prepared || evidence.managers.some(row => !row.fenced || row.seats !== 0)) throw new Error("target-authorized restart is no longer fenced and empty");
      return "none";
    }
    const recovery = readUpdateRecovery();
    if (recovery?.preparedRestart && process.env.COTAL_UPDATE_PARENT === String(process.ppid) && process.env.COTAL_UPDATE_TARGET_VERSION === updateRuntime.version() && recovery?.owner?.pid === process.ppid && recovery.owner.nonce === process.env.COTAL_UPDATE_CLOSURE_NONCE && recovery.owner.start === process.env.COTAL_UPDATE_CLOSURE_START) {
      const release = claimUpdateClosureAccess();
      release();
      const paths = daemonPaths();
      const lifetime = readLifetimeRecord(paths.lock);
      let absent = !existsSync(paths.lock) || (lifetime?.start !== undefined && processBirth(lifetime.pid) !== lifetime.start);
      if (!lifetime && !absent) {
        const exclusion = excludeLifetime(paths.lock);
        exclusion.release();
        absent = true;
      }
      if (absent) {
        if (process.platform === "win32") await captureWindowsGeneration(paths);
        console.log("hosted Manager continuity: daemon lifetime proves no live host");
        return "none";
      }
      let observed = await queryDaemon({ paths });
      let evidence = observed.ok ? observed.result.update?.restartEvidence : undefined;
      if (recovery.phase === "restoring" && !evidence?.prepared) {
        // Restart ownership belongs to a daemon generation. Restoration cannot reuse a dead
        // generation's fence, so the current host must independently fence and confirm zero seats.
        await managerViaDaemon({ paths }, { op: "managers-prepare-restart" });
        recoveryFence = true;
        observed = await queryDaemon({ paths });
        evidence = observed.ok ? observed.result.update?.restartEvidence : undefined;
      }
      if (!evidence?.prepared || evidence.managers.some(row => !row.fenced || row.seats !== 0)) throw new Error("prepared update admission is no longer fenced and empty");
      if (process.platform === "win32") await captureWindowsGeneration(paths);
      console.log("hosted Manager continuity: daemon verified prepared fences and zero seats");
      return "none";
    }
    const installedChild = process.env.COTAL_UPDATE_PARENT === String(process.ppid) && process.env.COTAL_UPDATE_TARGET_VERSION === updateRuntime.version();
    if (staged && (args.values.self === true || installedChild) && !hasUpdateDaemonLifetime())
      return reportsRetainedExecution() ? retainedReport(flags) : updateRuntime.reportRunningManager(flags);
    let managers;
    try {
      const paths = daemonPaths();
      const reply = standaloneReconcile ? await reconcileDaemonStatus(paths, reconcileDaemonObserved) : await queryDaemon({ paths });
      if (!reply.ok) throw new Error(`machine daemon custody is unreadable: ${reply.error.message}`);
      daemonObserved = true;
      if (process.platform === "win32") await captureWindowsGeneration(daemonPaths());
      managers = reply.result.managers ?? [];
    } catch (error) {
      if (!reconcileDaemonObserved && error instanceof EndpointRefusal && ["NOT_RUNNING", "NO_RUNTIME_DIR"].includes(error.code)) {
        if (error.code === "NOT_RUNNING" && process.platform === "win32") await captureWindowsGeneration(daemonPaths());
        return reportsRetainedExecution() ? retainedReport(flags) : updateRuntime.reportRunningManager(flags);
      }
      throw error;
    }
    // Updating this installation restarts the machine daemon, including spaces not selected by flags.
    for (const manager of managers) {
      if (manager.pid === undefined) console.log(`hosted Manager ${manager.space}: ${manager.state}; no live child, skipped`);
    }
    const active = managers.filter((manager) => manager.pid !== undefined);
    hostedSpaces = active.map((manager) => manager.space);
    if (!active.length) return reportsRetainedExecution() ? retainedReport(flags) : updateRuntime.reportRunningManager(flags);
    const blockedAgents: { space: string; describe: string; stop(): Promise<void> }[] = [];
    for (const manager of active) {
      // A failed earlier observation is not proof that a retained child's endpoint cannot answer.
      // Keep the fresh, instance-pinned custody check below as the authority for update admission.
      if (!manager.instanceId) throw new CommandFailure("refused", "LIFECYCLE_BLOCKED", `hosted Manager for ${manager.space} is ${manager.state}; its custody must answer before update`, { remedy: `run \`cotal daemon service-disconnect --space ${manager.space}\`, correct its sign-in or connection, then run \`cotal update\` again` });
      const reply = await withIdpSessionDir(homeCotalDir(), async () => {
        const target = await resolveControlTarget({ space: manager.space }, "control-caller-privileged", manager.instanceId, { onRefusal: "throw", readOnly: true });
        return askManager({ versionSkew: (text: string) => text, roster: async () => [] }, manager.space, target.server, "managerStatus", undefined, target.auth, "owner", 3000, { instanceId: manager.instanceId });
      });
      if (!reply.ok) throw new Error(reply.error ?? "hosted Manager status did not answer");
      const status = reply.data as { agentCount?: number; custody?: string };
      if (status.custody === "legacy" && status.agentCount !== 0) {
        const instanceId = manager.instanceId;
        const inventory = await withIdpSessionDir(homeCotalDir(), async () => {
          const target = await resolveControlTarget({ space: manager.space }, "control-caller-privileged", instanceId, { onRefusal: "throw", readOnly: true });
          const rows = await askManager({ versionSkew: (text: string) => text, roster: async () => [] }, manager.space, target.server, "ps", undefined, target.auth, "owner", 3000, { instanceId });
          if (!rows.ok || !Array.isArray(rows.data)) throw new Error(rows.error ?? "hosted Manager agent inventory did not answer");
          return rows.data as { name: string; id: string; lifecycleUid: string; activeAt?: number }[];
        });
        if (inventory.some(agent => !agent || typeof agent.name !== "string" || !agent.name || typeof agent.id !== "string" || !agent.id || typeof agent.lifecycleUid !== "string" || !agent.lifecycleUid)) throw new Error("hosted Manager returned an unfenced agent inventory; no stop authorized");
        if (inventory.length !== status.agentCount) throw new Error("hosted Manager agent inventory changed during update preflight; retry the update");
        const describe = inventory.map(agent => `${agent.name} (idle ${typeof agent.activeAt === "number" ? `${Math.max(0, Math.floor((Date.now() - agent.activeAt) / 60_000))} min` : "time unavailable"})`).join(", ");
        blockedAgents.push({ space: manager.space, describe, async stop() {
          await withIdpSessionDir(homeCotalDir(), async () => {
            const target = await resolveControlTarget({ space: manager.space }, "control-caller-privileged", instanceId, { onRefusal: "throw", readOnly: true });
            const client = { versionSkew: (text: string) => text, roster: async () => [] };
            const fresh = await askManager(client, manager.space, target.server, "ps", undefined, target.auth, "owner", 3000, { instanceId });
            if (!fresh.ok || !Array.isArray(fresh.data)) throw new Error(fresh.error ?? "agent inventory did not answer before stop");
            const current = fresh.data as typeof inventory;
            if (current.length !== inventory.length || inventory.some(agent => !current.some(row => row.id === agent.id && row.lifecycleUid === agent.lifecycleUid && row.name === agent.name))) throw new Error("agent inventory changed after consent; no further stops authorized; retry the update");
            for (const agent of inventory) {
              const stopped = await askManager(client, manager.space, target.server, "stop", { name: agent.name }, target.auth, "owner", 20_000, { instanceId, expectedTarget: { id: agent.id, lifecycleUid: agent.lifecycleUid } });
              if (!stopped.ok) throw new Error(stopped.error ?? `could not stop ${agent.name}`);
            }
            const empty = await askManager(client, manager.space, target.server, "managerStatus", undefined, target.auth, "owner", 3000, { instanceId });
            if (!empty.ok || (empty.data as { agentCount?: number })?.agentCount !== 0) throw new Error("hosted Manager still has running agents; update deferred");
          });
        } });
      }
      console.log(`hosted Manager ${manager.space}: instance ${manager.instanceId} answered; ${status.agentCount ?? "unknown"} seat(s)`);
    }
    // A daemon child is only one form of local custody. Read service and foreground Managers
    // from this install too, including another instance serving the same space.
    let localVerdict: "none" | "legacy" = "none";
    if (process.platform === "linux" && typeof flags.creds !== "string") {
      const on = await updateManagerPin(flags, "cotal update");
      for (const manager of localUpdateManagers({ ...flags, ...(on === undefined ? {} : { on }) })) {
        if (manager.ownership === "foreign") {
          await readUpdateManagerContinuity(manager, flags);
          continue;
        }
        if (active.some(hosted => hosted.instanceId === manager.instanceId)) continue;
        if (typeof flags.space === "string" && flags.space !== manager.space) continue;
        if (typeof flags.server === "string" && brokerAddressKey(flags.server) !== brokerAddressKey(manager.server)) continue;
        if (on !== undefined && on !== manager.instanceId) continue;
        if (await readUpdateManagerContinuity(manager, flags, reportsRetainedExecution() ? retainedReads : readManagerContinuity, { retainGraph: reportsRetainedExecution() }) === "legacy") localVerdict = "legacy";
      }
    }
    if (process.platform !== "linux" && typeof flags.space !== "string") {
      const { readMeshRegistry } = await import("@cotal-ai/workspace");
      for (const entry of readMeshRegistry().entries) {
        if (active.some(manager => manager.space === entry.space)) continue;
        if (await updateRuntime.reportRunningManager({ ...flags, space: entry.space }) === "legacy") return "legacy";
      }
    }
    if (localVerdict === "legacy") return localVerdict;
    if (blockedAgents.length) {
      const summary = blockedAgents.map(row => `${row.space}: ${row.describe}`).join("; ");
      let consent = flags["stop-agents"] === true && process.env.COTAL_AUTO_UPDATE !== "1";
      if (!consent && !askedToStop && process.env.COTAL_AUTO_UPDATE !== "1" && !process.env.COTAL_UPDATE_PARENT && process.stdin.isTTY && process.stdout.isTTY) {
        askedToStop = true;
        console.log(`These agents cannot survive this update: ${summary}`);
        const input = createInterface({ input: process.stdin, output: process.stdout });
        try { consent = /^(y|yes)$/i.test((await input.question("Stop these agents and continue the update? [y/N] ")).trim()); }
        finally { input.close(); }
      }
      if (!consent) throw new CommandFailure("refused", "LIFECYCLE_BLOCKED", `cannot preserve running agents on this computer during update (${summary}); restarting would end them`, { remedy: "save their work, then run `cotal update --self --stop-agents` to stop them and finish the update" });
      for (const row of blockedAgents) await row.stop();
    }
    return localVerdict;
  }) };
  if (interruptedChildRoot) {
    const release = runtime.claimGlobalUpdate(interruptedChildRoot);
    release();
  }
  if (logicalExecutionEntry() && !updateRuntime.checkout() && args.values.check !== true && !args.values.auto && !args.values.notify && !process.env.COTAL_UPDATE_PARENT) cleanupExecutionStore(executionInstallRoot());
  await update(args, runtime);
  if (args.values.check === true || args.values.auto || args.values.notify || process.exitCode) return;
  if (!currentPackages) await collectConnectorSets();
  // The daemon started this update and restarts itself once this process has exited. A restart
  // asked for from here would stop this process with the rest of the service.
  if (admission?.disposition === "deferred") {
    if (systemdActivationDeferred()) {
      console.log(`machine daemon: ${admission.reason}. Activation was not attempted.`);
      return;
    }
    console.log(`machine daemon activation deferred: ${admission.reason}; software update finished`);
    return;
  }
  if (process.env.COTAL_AUTO_UPDATE === "1") return;
  // Current packages need no Manager census or restart. Keep the guarded start of a stopped native service.
  if (currentPackages) {
    const state = join(homeCotalDir(), "daemon");
    if (daemonObserved || !existsSync(unitReceiptFile({ state })) || await observeUpdateDaemon()) return;
  }
  // This process keeps the release it loaded. The daemon must run the selected or installed release.
  const expectedVersion = replacementVersion ?? installedCliVersion();
  // A version-changing update already waited for the installed generation before it returned.
  // Waiting again prints the same line a second time in this process.
  if (!daemonObserved) {
    if ((args.values.self === true || process.env.COTAL_INSTALL_RECONCILE === "1") && runtime.generationWaited !== true) {
      await waitForInstalledDaemonGeneration(expectedVersion, {
        lifecycle: (paths: DaemonPaths, deadline: number) => process.platform === "win32" ? windowsGenerationLifecycle(paths, deadline) : posixGenerationLifecycle(paths),
      });
    }
    return;
  }
  const paths = daemonPaths();
  const current = standaloneReconcile ? await reconcileDaemonStatus(paths, true) : await queryDaemon({ paths });
  if (!current.ok) throw new Error("the installed daemon did not answer after update");
  if (!existsSync(unitReceiptFile(paths))) {
    console.log(`machine daemon: PID ${current.result.pid} runs Cotal ${current.result.version}; no recorded user service, left running`);
    return;
  }
  if (process.env.COTAL_INSTALL_RECONCILE === "1") reconcileMissingShellRuntime(paths);
  if (process.platform === "linux" && linuxMissingProgram(paths)) throw new CommandFailure("refused", "CONFLICT", "the recorded daemon program is missing", { remedy: "run `cotal daemon install` from a working Cotal installation to repair the recorded service" });
  const installation = installedDaemonIdentity(paths);
  if (!installation.same) {
    console.log(`${foreignDaemonUpdateReport(installation.installedEntry)} The daemon is running Cotal ${current.result.version}.`);
    return;
  }
  if (current.result.version !== expectedVersion) {
    const hosted = (current.result.managers ?? []).some((manager) => manager.pid !== undefined);
    if (hosted) await managerViaDaemon({ paths }, { op: "managers-prepare-restart" });
    try { await restartInstalled(paths, undefined, false, expectedVersion, detail => console.log(`machine daemon: ${detail}`)); }
    catch (error) {
      if (hosted && process.platform !== "win32") {
        try { await managerViaDaemon({ paths }, { op: "managers-abort-restart" }); }
        catch { /* The native restart failure remains the primary outcome. */ }
      }
      throw error;
    }
  }
  const deadline = Date.now() + 120_000;
  for (;;) {
    try {
      const reply = await queryDaemon({ paths, timeoutMs: Math.min(20_000, Math.max(1, deadline - Date.now())) });
      if (reply.ok && reply.result.version === expectedVersion && hostedSpaces.every((space) => reply.result.managers?.some((manager) => manager.space === space && manager.state === "answering"))) return;
    } catch (error) {
      if (!isDaemonStatusInterrupted(error) && !(error instanceof EndpointRefusal && ["NOT_RUNNING", "PEER_NOT_LOCK_OWNER"].includes(error.code))) throw error;
    }
    if (Date.now() >= deadline) throw new CommandFailure("refused", "LIFECYCLE_BLOCKED", "the updated daemon did not restore its hosted Managers before the deadline", { remedy: "read \`cotal daemon status\` and the recorded daemon user service" });
    await new Promise((resolve) => setTimeout(resolve, Math.min(250, Math.max(0, deadline - Date.now()))));
  }
  } finally {
    closeWindowsGeneration();
    if (repairService) {
      if (repairServiceStopped) await startEnabledInstalled(repairService, undefined);
      try { await managerViaDaemon({ paths: repairService }, { op: "managers-abort-restart" }); }
      catch (error) { if (!(error instanceof EndpointRefusal) || error.code !== "NOT_RUNNING") throw error; }
    }
    if (recoveryFence) await managerViaDaemon({ paths: daemonPaths() }, { op: "managers-abort-restart" });
  }
} };
registry.register(composed);
