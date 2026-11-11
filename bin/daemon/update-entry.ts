/** The binary composes machine-daemon custody with the stock package updater. */
import { existsSync } from "node:fs";
import { registry, type Command } from "@cotal-ai/core";
import { update, updateRuntime } from "@cotal-ai/cli/update";
import { withIdpSessionDir, withRemoteExchangeRetry } from "@cotal-ai/auth";
import { CommandFailure, homeCotalDir, resolveControlTarget, shellPath } from "@cotal-ai/workspace";
import { askManager } from "@cotal-ai/workspace/control";
import { daemonPaths, EndpointRefusal } from "./endpoint.js";
import { managerViaDaemon, queryDaemon } from "./client.js";
import { installedDaemonIdentity, restartInstalled, unitReceiptFile } from "./install.js";
import { waitForInstalledDaemonGeneration } from "./update-generation.js";

const command = registry.resolve<Command>("command", "update");
registry.unregister("command", "update");
const composed: Command = { ...command, async run(args) {
  let hostedSpaces: string[] = [];
  let daemonObserved = false;
  await update(args, { ...updateRuntime, waitForInstalledGeneration: waitForInstalledDaemonGeneration, reportRunningManager: (flags) => withRemoteExchangeRetry(async () => {
    let managers;
    try {
      const reply = await queryDaemon({ paths: daemonPaths() });
      if (!reply.ok) throw new Error(`machine daemon custody is unreadable: ${reply.error.message}`);
      daemonObserved = true;
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
    for (const manager of active) {
      // A failed earlier observation is not proof that a retained child's endpoint cannot answer.
      // Keep the fresh, instance-pinned custody check below as the authority for update admission.
      if (!manager.instanceId) throw new CommandFailure("refused", "LIFECYCLE_BLOCKED", `hosted Manager for ${manager.space} is ${manager.state}; its custody must answer before update`, { remedy: `run cotal daemon service-disconnect --space ${manager.space}, correct its sign-in or connection, then run cotal update again` });
      const reply = await withIdpSessionDir(homeCotalDir(), async () => {
        const target = await resolveControlTarget({ space: manager.space }, "control-caller-privileged", manager.instanceId, { onRefusal: "throw", readOnly: true });
        return askManager({ versionSkew: (text: string) => text, roster: async () => [] }, manager.space, target.server, "managerStatus", undefined, target.auth, "owner", 3000, { instanceId: manager.instanceId });
      });
      if (!reply.ok) throw new Error(reply.error ?? "hosted Manager status did not answer");
      const status = reply.data as { agentCount?: number; custody?: string; stopImpact?: { agents: { name: string }[] } };
      if (status.custody === "legacy" && status.agentCount !== 0) {
        const names = status.stopImpact?.agents.map((agent) => agent.name);
        throw new CommandFailure("refused", "LIFECYCLE_BLOCKED", `hosted Manager ${manager.instanceId} cannot preserve running agents on this computer during update${names?.length ? ` (${names.join(", ")})` : ""}; restarting it would end them`, { remedy: `save their work; stop each with cotal stop <name> --on ${manager.instanceId} --space ${shellPath(manager.space)}, then rerun the same update command. To list agents, use cotal ps --on ${manager.instanceId} --space ${shellPath(manager.space)} (requires admin scope)` });
      }
      console.log(`hosted Manager ${manager.space}: instance ${manager.instanceId} answered; ${status.agentCount ?? "unknown"} seat(s)`);
    }
    // The stock resolver still inspects other locally hosted spaces when one is not selected.
    if (typeof flags.space !== "string") {
      const { readMeshRegistry } = await import("@cotal-ai/workspace");
      for (const entry of readMeshRegistry().entries) {
        if (active.some((manager) => manager.space === entry.space)) continue;
        if (await updateRuntime.reportRunningManager({ ...flags, space: entry.space }) === "legacy") return "legacy";
      }
    }
    return "none";
  }) });
  if (args.values.check === true || process.exitCode || !daemonObserved) return;
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
  if (current.result.version !== updateRuntime.version()) {
    const hosted = (current.result.managers ?? []).some((manager) => manager.pid !== undefined);
    if (hosted) await managerViaDaemon({ paths }, { op: "managers-prepare-restart" });
    try { await restartInstalled(paths, undefined, false, updateRuntime.version(), detail => console.log(`machine daemon: ${detail}`)); }
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
      if (reply.ok && reply.result.version === updateRuntime.version() && hostedSpaces.every((space) => reply.result.managers?.some((manager) => manager.space === space && manager.state === "answering"))) return;
    } catch (error) { if (!(error instanceof EndpointRefusal) || !["NOT_RUNNING", "PEER_NOT_LOCK_OWNER"].includes(error.code)) throw error; }
    if (Date.now() >= deadline) throw new CommandFailure("refused", "LIFECYCLE_BLOCKED", "the updated daemon did not restore its hosted Managers before the deadline", { remedy: "read cotal daemon status and the recorded daemon user service" });
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
} };
registry.register(composed);
