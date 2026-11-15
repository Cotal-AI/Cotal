/** The binary composes machine-daemon custody with the stock package updater. */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import { registry, type Command } from "@cotal-ai/core";
import { update, updateRuntime, installedCliVersion, localUpdateManagers, readManagerContinuity, updateManagerPin } from "@cotal-ai/cli/update";
import { withIdpSessionDir, withRemoteExchangeRetry } from "@cotal-ai/auth";
import { brokerAddressKey, assertRecordIdentity, CommandFailure, homeCotalDir, readUpdateRecovery, claimUpdateClosureAccess, resolveControlTarget } from "@cotal-ai/workspace";
import { askManager } from "@cotal-ai/workspace/control";
import { daemonPaths, EndpointRefusal } from "./endpoint.js";
import { managerViaDaemon, queryDaemon } from "./client.js";
import { installedDaemonIdentity, preflightInstalledDaemon, restartInstalled, unitReceiptFile } from "./install.js";
import { excludeLifetime, processBirth, readLifetimeRecord } from "./lifetime.js";
import { waitForInstalledDaemonGeneration } from "./update-generation.js";
import { adoptAutomaticUpdateChild } from "./update-scope.js";
import { captureWindowsGeneration, closeWindowsGeneration, windowsGenerationLifecycle } from "./update-generation-win32.js";

const command = registry.resolve<Command>("command", "update");
registry.unregister("command", "update");
const composed: Command = { ...command, async run(args) {
  let hostedSpaces: string[] = [];
  let daemonObserved = false;
  let preparedRestart = false;
  let absentRecoveryHost = false;
  let currentPackages = false;
  let askedToStop = false;
  let recoveryFence = false;
  try {
  await update(args, { ...updateRuntime, isCurrent() {
    currentPackages = updateRuntime.isCurrent?.() === true;
    return currentPackages;
  }, async automaticUpdateAdvice() {
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
    if (!daemonObserved) return async () => {};
    const paths = daemonPaths();
    try { await managerViaDaemon({ paths }, { op: "managers-prepare-restart" }); }
    catch (error) { throw new Error(`daemon unavailable or refused update preparation: ${error instanceof Error ? error.message : String(error)}`); }
    preparedRestart = true;
    return async () => {
      try {
        const current = await queryDaemon({ paths });
        if (current.ok && current.result.version === updateRuntime.version()) await managerViaDaemon({ paths }, { op: "managers-abort-restart" });
      } catch (error) {
        if (!(error instanceof EndpointRefusal) || !["NOT_RUNNING", "PEER_NOT_LOCK_OWNER"].includes(error.code)) throw error;
      }
    };
  }, waitForInstalledGeneration: async version => {
    if (absentRecoveryHost) return;
    await waitForInstalledDaemonGeneration(version, process.platform === "win32" ? { lifecycle: windowsGenerationLifecycle } : {});
  }, reportRunningManager: (flags) => withRemoteExchangeRetry(async () => {
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
        absentRecoveryHost = recovery.phase === "restoring";
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
      if (error instanceof EndpointRefusal && ["NOT_RUNNING", "NO_RUNTIME_DIR"].includes(error.code)) return updateRuntime.reportRunningManager(flags);
      throw error;
    }
    // Updating this installation restarts the machine daemon, including spaces not selected by flags.
    for (const manager of managers) {
      if (manager.pid === undefined) console.log(`hosted Manager ${manager.space}: ${manager.state}; no live child, skipped`);
    }
    const active = managers.filter((manager) => manager.pid !== undefined);
    hostedSpaces = active.map((manager) => manager.space);
    if (!active.length) return updateRuntime.reportRunningManager(flags);
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
        if (await readManagerContinuity({ ...flags, space: manager.space, server: manager.server, on: manager.instanceId }) === "legacy") localVerdict = "legacy";
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
  }) });
  } finally {
    closeWindowsGeneration();
    if (recoveryFence) await managerViaDaemon({ paths: daemonPaths() }, { op: "managers-abort-restart" });
  }
  if (currentPackages || args.values.check === true || args.values.auto || args.values.notify || process.exitCode || !daemonObserved) return;
  // The daemon started this update and restarts itself once this process has exited. A restart
  // asked for from here would stop this process with the rest of the service.
  if (process.env.COTAL_AUTO_UPDATE === "1") return;
  // This process keeps the release it loaded. The daemon must run the release now installed.
  const expectedVersion = installedCliVersion();
  const paths = daemonPaths();
  const current = await queryDaemon({ paths });
  if (!current.ok) throw new Error("the installed daemon did not answer after update");
  if (!existsSync(unitReceiptFile(paths))) {
    console.log(`machine daemon: PID ${current.result.pid} runs Cotal ${current.result.version}; no recorded user service, left running`);
    return;
  }
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
} };
registry.register(composed);
