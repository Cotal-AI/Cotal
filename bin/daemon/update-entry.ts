/** The binary composes machine-daemon custody with the stock package updater. */
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline/promises";
import { registry, type Command } from "@cotal-ai/core";
import { update, updateRuntime, installedCliVersion, localUpdateManagers, readManagerContinuity, updateManagerPin, repairInstallModes } from "@cotal-ai/cli/update";
import { withIdpSessionDir, withRemoteExchangeRetry } from "@cotal-ai/auth";
import { brokerAddressKey, assertRecordIdentity, CommandFailure, homeCotalDir, readUpdateRecovery, claimUpdateClosureAccess, resolveControlTarget } from "@cotal-ai/workspace";
import { askManager } from "@cotal-ai/workspace/control";
import { daemonPaths, EndpointRefusal, type DaemonPaths } from "./endpoint.js";
import { managerViaDaemon, queryDaemon } from "./client.js";
import { installedDaemonIdentity, preflightInstalledDaemon, reconcileMissingShellRuntime, restartInstalled, startEnabledInstalled, unitReceiptFile } from "./install.js";
import { excludeLifetime, processBirth, readLifetimeRecord } from "./lifetime.js";
import { waitForInstalledDaemonGeneration } from "./update-generation.js";
import { cleanupExecutionStore } from "../execution-store.js";
import { repairExecutionInstallModes } from "../execution-transaction.js";
import { prepareExecutionUpdate, preflightExecutionUpdate, recoverExecutionUpdate, executionInstallRoot } from "./execution-update.js";
import type { ExecutionPreinstallReceipt } from "./execution-preinstall-client.js";
import { findMesh, logicalExecutionEntry, pruneRetainedConnectorConfig, retainConnectorConfig, shellPath } from "@cotal-ai/workspace";
import { reportRunningManagers } from "@cotal-ai/cli/update";
import { adoptAutomaticUpdateChild } from "./update-scope.js";
import { daemonServiceRequirement } from "./service-platform.js";
import { captureWindowsGeneration, closeWindowsGeneration, windowsGenerationLifecycle } from "./update-generation-win32.js";

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
        if (!quiet) console.log(`machine daemon: the background service belongs to another Cotal installation (${installation.installedEntry}). This update left it stopped.`);
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

async function collectConnectorSets(): Promise<void> {
  try {
    const entry = logicalExecutionEntry();
    if (!entry || updateRuntime.checkout()) return;
    const release = claimUpdateClosureAccess();
    try {
      const holders: (string | undefined)[] = [];
      const managers = localUpdateManagers({}, entry);
      for (const manager of managers) {
        if (!manager.process || assertRecordIdentity(manager.process).kind !== "match") return;
        const target = await resolveControlTarget({ space: manager.space, server: manager.server }, "control-caller-admin", manager.instanceId, { onRefusal: "throw", readOnly: true });
        const reply = await askManager({ versionSkew: text => text, roster: async () => [] }, manager.space, target.server, "managerStatus", undefined, target.auth, "owner", 3000, { instanceId: manager.instanceId });
        if (!reply.ok || assertRecordIdentity(manager.process).kind !== "match") return;
        const version = (reply.data as { version?: unknown } | undefined)?.version;
        holders.push(typeof version === "string" ? version : undefined);
      }
      try {
        const paths = daemonPaths();
        const reply = await queryDaemon({ paths });
        if (!reply.ok) return;
        const lifetime = readLifetimeRecord(paths.lock);
        if (!lifetime?.start || lifetime.pid !== reply.result.pid || processBirth(lifetime.pid) !== lifetime.start) return;
        // Hosted Managers can remain on an earlier generation than their daemon.
        // Their separate records must all have appeared in the authenticated inventory.
        if ((reply.result.managers ?? []).some(row => row.pid !== undefined && !managers.some(manager => manager.pid === row.pid && manager.instanceId === row.instanceId))) return;
        holders.push(reply.result.version);
      } catch (error) {
        if (!(error instanceof EndpointRefusal) || !["NOT_RUNNING", "NO_RUNTIME_DIR"].includes(error.code)) return;
        if (error.code === "NO_RUNTIME_DIR" && existsSync(join(homeCotalDir(), "daemon", "daemon.lock"))) return;
        assertDaemonReachable();
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
  let recoveryFence = false;
  const retainsExecution = () => targetReceipt !== undefined || readUpdateRecovery()?.execution !== undefined;
  const reportsRetainedExecution = () => retainedReconciliation || retainsExecution() || (currentPackages && logicalExecutionEntry() !== undefined && !updateRuntime.checkout() && (process.platform === "linux" || process.platform === "darwin"));
  const retainedReads = (flags: Record<string, unknown>) => readManagerContinuity(flags, { readOnly: true, retainGraph: true, installedEntry: logicalExecutionEntry() });
  const retainedReport = (flags: Record<string, unknown>) => reportRunningManagers(flags, retainedReads, selected => localUpdateManagers(selected, logicalExecutionEntry()));
  try {
  if (logicalExecutionEntry() && !updateRuntime.checkout() && args.values.check !== true && !args.values.auto && !args.values.notify && !process.env.COTAL_UPDATE_PARENT) cleanupExecutionStore(executionInstallRoot());
  const runtime = { ...updateRuntime,
    ...(logicalExecutionEntry() && !updateRuntime.checkout() && (process.platform === "linux" || process.platform === "darwin") ? {
      preflightExecution: preflightExecutionUpdate,
      repairInstallModes: (root: string) => repairExecutionInstallModes(executionInstallRoot(), () => repairInstallModes(root)),
      executionGlobalRoot: () => dirname(executionInstallRoot()),
      prepareExecution: async (version: string, root: string) => {
        assertDaemonReachable();
        const execution = await prepareExecutionUpdate(version, root, receipt => { targetReceipt = receipt; });
        replacementVersion = version;
        return execution;
      },
      recoverExecution: recoverExecutionUpdate,
    } : {}), async prepareReconciliation(flags: Record<string, unknown>) {
    const entry = logicalExecutionEntry();
    if (!entry || updateRuntime.checkout() || !["linux", "darwin"].includes(process.platform) || process.env.COTAL_UPDATE_PARENT || readUpdateRecovery()) return;
    try {
      const daemon = await queryDaemon({ paths: daemonPaths() });
      if (!daemon.ok) throw new Error(`machine daemon custody is unreadable: ${daemon.error.message}`);
      return; // Hosted daemon admission and restart handling remain unchanged.
    } catch (error) {
      if (!(error instanceof EndpointRefusal) || !["NOT_RUNNING", "NO_RUNTIME_DIR"].includes(error.code)) throw error;
      if (error.code === "NO_RUNTIME_DIR") assertDaemonReachable();
    }
    const managers = localUpdateManagers(flags, entry);
    if (!managers.length) return;
    for (const manager of managers) {
      if (!manager.process || assertRecordIdentity(manager.process).kind !== "match") throw new Error(`local Manager ${manager.instanceId} changed before reconciliation admission`);
      await retainedReads({ ...flags, space: manager.space, server: manager.server, on: manager.instanceId });
      if (assertRecordIdentity(manager.process).kind !== "match") throw new Error(`local Manager ${manager.instanceId} changed during reconciliation admission`);
    }
    retainConnectorConfig();
    retainedReconciliation = true;
    for (const manager of managers) {
      const command = findMesh(manager.space)?.userAuth?.remote
        ? `\`cd ${shellPath(manager.root)} && cotal manager restart --with-agents --yes --space ${shellPath(manager.space)}\``
        : `\`cd ${shellPath(manager.root)} && cotal down --with-agents --yes --space ${shellPath(manager.space)} && cotal up --space ${shellPath(manager.space)}\``;
      console.log(`Manager ${manager.instanceId} keeps its agents on the previous version and takes the installed version at its next restart. When their work is finished, restart from its recorded folder: ${command}`);
    }
  }, isCurrent() {
    currentPackages = updateRuntime.isCurrent?.() === true;
    return currentPackages;
  }, async automaticUpdateAdvice() {
    const requirement = daemonServiceRequirement();
    if (requirement) return `${requirement.message}. ${requirement.remedy}. Automatic installation remains unavailable without a supported native daemon service.`;
    try {
      const reply = await queryDaemon({ paths: daemonPaths() });
      if (!reply.ok) throw new Error(`machine daemon update schedule is unreadable: ${reply.error.message}`);
      if (!reply.result.update) throw new Error("machine daemon returned no update schedule; run `cotal daemon status` to inspect it");
      if (reply.result.update.automatic && typeof reply.result.update.nextAttempt === "string") return undefined;
      return "The daemon is not scheduling automatic installation. Run `cotal daemon status` to inspect it. If no daemon service is installed, run `cotal daemon install`.";
    } catch (error) {
      if (error instanceof EndpointRefusal && ["NOT_RUNNING", "NO_RUNTIME_DIR"].includes(error.code)) {
        return "No daemon service is running the automatic update schedule. Run `cotal daemon install`, then inspect `cotal daemon status`.";
      }
      throw error;
    }
  }, async preflightReplacement() {
    await updateRuntime.preflightReplacement?.();
    preflightInstalledDaemon({ state: join(homeCotalDir(), "daemon") });
  }, adoptUpdateChild: adoptAutomaticUpdateChild, preparedRestart: () => preparedRestart, async prepareReplacement() {
    let paths: DaemonPaths | undefined;
    try { paths = daemonPaths(); }
    catch (error) { if (!(error instanceof EndpointRefusal) || error.code !== "NO_RUNTIME_DIR") throw error; }
    if (targetReceipt && !targetAdmissionChecked) {
      // The lifetime record lives under the home, so it is readable in a session with no runtime directory.
      const lifetime = readLifetimeRecord(paths?.lock ?? join(homeCotalDir(), "daemon", "daemon.lock"));
      if (targetReceipt.daemon ? !lifetime?.start || lifetime.pid !== targetReceipt.daemon.pid || lifetime.start !== targetReceipt.daemon.start || processBirth(lifetime.pid) !== lifetime.start : lifetime !== undefined)
        throw new Error("machine daemon lifetime changed after target pre-install checks; retry the update");
    }
    if (!daemonObserved || !paths) {
      targetAdmissionChecked = true;
      return async () => {};
    }
    try { await managerViaDaemon({ paths }, { op: "managers-prepare-restart" }); }
    catch (error) { throw new Error(`daemon unavailable or refused update preparation: ${error instanceof Error ? error.message : String(error)}`); }
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
    // A current parent waits after this child and prints the line. An older parent prints nothing,
    // so this child keeps the line. The wait itself runs either way.
    const currentParent = currentParentWaits(process.env, process.ppid, readUpdateRecovery() !== undefined);
    await waitForInstalledDaemonGeneration(version, {
      lifecycle: (paths: DaemonPaths, deadline: number) => process.platform === "win32" ? windowsGenerationLifecycle(paths, deadline, currentParent) : posixGenerationLifecycle(paths, currentParent),
      quiet: currentParent,
    });
  }, reportRunningManager: (flags: Record<string, unknown>) => withRemoteExchangeRetry(async () => {
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
    let managers;
    try {
      const reply = await queryDaemon({ paths: daemonPaths() });
      if (!reply.ok) throw new Error(`machine daemon custody is unreadable: ${reply.error.message}`);
      daemonObserved = true;
      if (process.platform === "win32") await captureWindowsGeneration(daemonPaths());
      managers = reply.result.managers ?? [];
    } catch (error) {
      if (error instanceof EndpointRefusal && ["NOT_RUNNING", "NO_RUNTIME_DIR"].includes(error.code)) {
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
      const status = reply.data as { agentCount?: number; custody?: string; stopImpact?: { agents: { name: string }[] } };
      if (!currentPackages && status.custody === "legacy" && status.agentCount !== 0) {
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
      if (currentPackages && status.custody === "legacy" && status.agentCount !== 0) {
        const names = status.stopImpact?.agents.map(agent => agent.name);
        console.log(`hosted Manager ${manager.instanceId}: a later update will require stopping its agents${names?.length ? ` (${names.join(", ")})` : ""}`);
      }
      console.log(`hosted Manager ${manager.space}: instance ${manager.instanceId} answered; ${status.agentCount ?? "unknown"} seat(s)`);
    }
    // A daemon child is only one form of local custody. Read service and foreground Managers
    // from this install too, including another instance serving the same space.
    let localVerdict: "none" | "legacy" = "none";
    if (process.platform === "linux" && typeof flags.creds !== "string") {
      const on = await updateManagerPin(flags, "cotal update");
      for (const manager of localUpdateManagers({ ...flags, ...(on === undefined ? {} : { on }) })) {
        if (active.some(hosted => hosted.instanceId === manager.instanceId)) continue;
        if (typeof flags.space === "string" && flags.space !== manager.space) continue;
        if (typeof flags.server === "string" && brokerAddressKey(flags.server) !== brokerAddressKey(manager.server)) continue;
        if (on !== undefined && on !== manager.instanceId) continue;
        if (manager.process && assertRecordIdentity(manager.process).kind !== "match") throw new Error(`local Manager ${manager.instanceId} changed before its continuity read`);
        if (await (reportsRetainedExecution() ? retainedReads : readManagerContinuity)({ ...flags, space: manager.space, server: manager.server, on: manager.instanceId }) === "legacy") localVerdict = "legacy";
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
  await update(args, runtime);
  if (args.values.check === true || args.values.auto || args.values.notify || process.exitCode) return;
  await collectConnectorSets();
  // The daemon started this update and restarts itself once this process has exited. A restart
  // asked for from here would stop this process with the rest of the service.
  if (process.env.COTAL_AUTO_UPDATE === "1") return;
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
  if (currentPackages) return;
  const paths = daemonPaths();
  const current = await queryDaemon({ paths });
  if (!current.ok) throw new Error("the installed daemon did not answer after update");
  if (!existsSync(unitReceiptFile(paths))) {
    console.log(`machine daemon: PID ${current.result.pid} runs Cotal ${current.result.version}; no recorded user service, left running`);
    return;
  }
  if (process.env.COTAL_INSTALL_RECONCILE === "1") reconcileMissingShellRuntime(paths);
  const installation = installedDaemonIdentity(paths);
  if (!installation.same) {
    console.log(`machine daemon: ${installation.installed} runs Cotal ${current.result.version}; another installation was left running`);
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
      const reply = await queryDaemon({ paths });
      if (reply.ok && reply.result.version === expectedVersion && hostedSpaces.every((space) => reply.result.managers?.some((manager) => manager.space === space && manager.state === "answering"))) return;
    } catch (error) { if (!(error instanceof EndpointRefusal) || !["NOT_RUNNING", "PEER_NOT_LOCK_OWNER"].includes(error.code)) throw error; }
    if (Date.now() >= deadline) throw new CommandFailure("refused", "LIFECYCLE_BLOCKED", "the updated daemon did not restore its hosted Managers before the deadline", { remedy: "read \`cotal daemon status\` and the recorded daemon user service" });
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  } finally {
    closeWindowsGeneration();
    if (recoveryFence) await managerViaDaemon({ paths: daemonPaths() }, { op: "managers-abort-restart" });
  }
} };
registry.register(composed);
