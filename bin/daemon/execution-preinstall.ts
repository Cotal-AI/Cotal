import { existsSync } from "node:fs";
import { withIdpSessionDir } from "@cotal-ai/auth";
import { homeCotalDir, resolveControlTarget, type UpdateAdmission } from "@cotal-ai/workspace";
import { askManager } from "@cotal-ai/workspace/control";
import { queryDaemon } from "./client.js";
import { daemonPaths, prepareDaemonRuntimeEnvironment } from "./endpoint.js";
import { installedDaemonIdentity, preflightInstalledDaemon, unitReceiptFile } from "./install.js";
import { observeUpdateDaemon, sameUpdateDaemon } from "./update-lifetime.js";
import { processBirth } from "./lifetime.js";

export interface ExecutionPreinstallRequest {
  readonly v: 1;
  readonly nonce: string;
  readonly installedEntry: string;
  readonly daemonArgv: readonly string[];
  readonly flags: Record<string, unknown>;
}

/** Read-only target policy. Unknown custody permits software publication, never a destructive restart. */
export async function readExecutionPreinstall(request: ExecutionPreinstallRequest) {
  const daemon = await observeUpdateDaemon();
  let admission: UpdateAdmission;
  const deferred = (reason: string): UpdateAdmission => ({ disposition: "deferred", occupied: null, hostedSpaces: [], reason: reason.slice(0, 2000) });
  try {
    prepareDaemonRuntimeEnvironment();
    const paths = daemonPaths();
    const recorded = existsSync(unitReceiptFile(paths)) && preflightInstalledDaemon(paths, undefined, request.daemonArgv);
    const same = recorded && installedDaemonIdentity(paths, undefined, request.daemonArgv).same;
    if (!daemon) {
      // No daemon runs, so nothing is hosted and nothing can be interrupted. The installed lifecycle
      // goes on to start a recorded service, or to report why it stays stopped.
      admission = { disposition: "restart-empty", occupied: 0, hostedSpaces: [] };
    } else if (!same) {
      admission = deferred("the running daemon belongs to another installation or has no recorded service; it and its Managers were left running");
    } else {
      const reply = await queryDaemon({ paths });
      if (!reply.ok) throw new Error(`daemon custody is unavailable: ${reply.error.message}`);
      if (reply.result.pid !== daemon.pid) throw new Error("daemon status differs from its authenticated lifetime");
      if (!Array.isArray(reply.result.managers)) throw new Error("hosted Manager inventory is unknown");
      const active = reply.result.managers.filter(manager => manager.pid !== undefined);
      const inventory: Extract<UpdateAdmission, { disposition: "consent-stop" }>["inventory"][number][] = [];
      let occupied = 0;
      for (const manager of active) {
        if (!manager.instanceId) throw new Error(`Manager ${manager.space} has no verified instance identity`);
        const instanceId = manager.instanceId;
        const birth = processBirth(manager.pid!);
        if (!birth) throw new Error(`Manager ${manager.space} lifetime is unreadable`);
        await withIdpSessionDir(homeCotalDir(), async () => {
          const target = await resolveControlTarget({ space: manager.space }, "control-caller-privileged", instanceId, { onRefusal: "throw", readOnly: true });
          const client = { versionSkew: (text: string) => text, roster: async () => [] };
          const status = await askManager(client, manager.space, target.server, "managerStatus", undefined, target.auth, "owner", 3000, { instanceId });
          if (!status.ok) throw new Error(status.error ?? `Manager ${manager.space} did not answer`);
          if ((status.data as { instanceId?: unknown }).instanceId !== instanceId || processBirth(manager.pid!) !== birth) throw new Error(`Manager ${manager.space} identity changed`);
          const count = (status.data as { agentCount?: unknown }).agentCount;
          if (!Number.isSafeInteger(count) || (count as number) < 0) throw new Error(`Manager ${manager.space} work count is unknown`);
          occupied += count as number;
          if (count === 0) return;
          const rows = await askManager(client, manager.space, target.server, "ps", undefined, target.auth, "owner", 3000, { instanceId });
          const agents = rows.data as { name: string; id: string; lifecycleUid: string }[];
          if (!rows.ok || !Array.isArray(agents) || agents.length !== count || agents.some(agent => !agent || [agent.name, agent.id, agent.lifecycleUid].some(value => typeof value !== "string" || !value))) throw new Error(`Manager ${manager.space} exact work inventory is unavailable`);
          inventory.push({ space: manager.space, instanceId, agents: agents.map(({ name, id, lifecycleUid }) => ({ name, id, lifecycleUid })) });
        });
      }
      const hostedSpaces = active.map(manager => manager.space);
      admission = occupied === 0 ? { disposition: "restart-empty", occupied: 0, hostedSpaces } : { disposition: "consent-stop", occupied, hostedSpaces, inventory };
    }
  } catch (error) {
    admission = deferred(`${error instanceof Error ? error.message : String(error)}; the daemon and its Managers were left running`);
  }
  if (!sameUpdateDaemon(daemon, await observeUpdateDaemon())) throw new Error("machine daemon lifetime changed during target admission");
  // Released updaters (0.165.4 to 0.168.0) refuse a receipt whose `occupied` is not a non-negative
  // integer and read nothing else from it. The admission carries the unknown count.
  return { daemon, hostedSpaces: admission.hostedSpaces, occupied: admission.occupied ?? 0, admission };
}
