import { existsSync } from "node:fs";
import { join } from "node:path";
import { withIdpSessionDir, withRemoteExchangeRetry } from "@cotal-ai/auth";
import { localUpdateManagers, readManagerContinuity, reportRunningManagers } from "@cotal-ai/cli/update";
import { CommandFailure, homeCotalDir, resolveControlTarget, type UpdateAdmission } from "@cotal-ai/workspace";
import { askManager } from "@cotal-ai/workspace/control";
import { queryDaemon } from "./client.js";
import { daemonPaths, EndpointRefusal } from "./endpoint.js";
import { installedDaemonIdentity, preflightInstalledDaemon, unitReceiptFile } from "./install.js";
import { processBirth, readLifetimeRecord } from "./lifetime.js";
import { observeUpdateDaemon, sameUpdateDaemon } from "./update-lifetime.js";

export interface ExecutionPreinstallRequest {
  readonly v: 1;
  readonly nonce: string;
  readonly installedEntry: string;
  readonly daemonArgv: readonly string[];
  readonly flags: Record<string, unknown>;
  readonly admission?: 1;
}

/** Preserve the v:1 projection read by released updaters, including its refusal order. */
async function readLegacyExecutionPreinstall(request: ExecutionPreinstallRequest): Promise<{ daemon?: { pid: number; start: string }; hostedSpaces: string[]; occupied: number }> {
  preflightInstalledDaemon({ state: join(homeCotalDir(), "daemon") }, undefined, request.daemonArgv);
  return withRemoteExchangeRetry(async () => {
    const readOne = (flags: Record<string, unknown>) => readManagerContinuity(flags, { readOnly: true, retainGraph: true, installedEntry: request.installedEntry });
    // A session with no runtime directory cannot reach a daemon socket, which is the same answer
    // as a daemon that is not running.
    let paths, reply;
    try { paths = daemonPaths(); reply = await queryDaemon({ paths }); }
    catch (error) {
      if (!(error instanceof EndpointRefusal) || !["NOT_RUNNING", "NO_RUNTIME_DIR"].includes(error.code)) throw error;
      await reportRunningManagers(request.flags, readOne, flags => localUpdateManagers(flags, request.installedEntry));
      return { hostedSpaces: [], occupied: 0 };
    }
    if (!reply.ok) throw new Error(`machine daemon custody is unreadable: ${reply.error.message}`);
    const lifetime = readLifetimeRecord(paths.lock);
    if (!lifetime?.start || lifetime.pid !== reply.result.pid || processBirth(lifetime.pid) !== lifetime.start) throw new Error("machine daemon lifetime changed during pre-install check");
    const active = (reply.result.managers ?? []).filter(manager => manager.pid !== undefined);
    let occupied = 0;
    for (const manager of active) {
      if (!manager.instanceId) throw new CommandFailure("refused", "LIFECYCLE_BLOCKED", `hosted Manager ${manager.space} has no verified instance identity`);
      await withIdpSessionDir(homeCotalDir(), async () => {
        const target = await resolveControlTarget({ space: manager.space }, "control-caller-privileged", manager.instanceId, { onRefusal: "throw", readOnly: true });
        const status = await askManager({ versionSkew: (text: string) => text, roster: async () => [] }, manager.space, target.server, "managerStatus", undefined, target.auth, "owner", 3000, { instanceId: manager.instanceId });
        if (!status.ok) throw new Error(status.error ?? "hosted Manager status did not answer");
        const count = (status.data as { agentCount?: unknown }).agentCount;
        if (!Number.isSafeInteger(count) || (count as number) < 0) throw new Error("hosted Manager returned an invalid agent count");
        occupied += count as number;
      });
    }
    if (process.platform === "linux") {
      for (const manager of localUpdateManagers(request.flags, request.installedEntry)) {
        if (active.some(hosted => hosted.instanceId === manager.instanceId)) continue;
        await readOne({ ...request.flags, space: manager.space, server: manager.server, on: manager.instanceId });
      }
    } else {
      await reportRunningManagers(request.flags, readOne);
      if (typeof request.flags.space !== "string" && typeof request.flags.creds !== "string") {
        const { readMeshRegistry } = await import("@cotal-ai/workspace");
        for (const entry of readMeshRegistry().entries) {
          if (active.some(manager => manager.space === entry.space)) continue;
          await readOne({ ...request.flags, space: entry.space });
        }
      }
    }
    if (processBirth(lifetime.pid) !== lifetime.start) throw new Error("machine daemon lifetime changed before pre-install receipt");
    return { daemon: { pid: lifetime.pid, start: lifetime.start }, hostedSpaces: active.map(manager => manager.space), occupied };
  });
}

/** Read-only target policy. Legacy evidence does not authorize a destructive restart. */
export async function readExecutionPreinstall(request: ExecutionPreinstallRequest) {
  if (request.admission === undefined) return readLegacyExecutionPreinstall(request);
  if (request.admission !== 1) throw new Error("invalid execution pre-install admission request");
  const daemon = await observeUpdateDaemon();
  let admission: UpdateAdmission;
  const deferred = (reason: string): UpdateAdmission => ({ disposition: "deferred", occupied: null, hostedSpaces: [], reason: reason.slice(0, 2000) });
  try {
    const paths = daemonPaths();
    const owned = existsSync(unitReceiptFile(paths)) && preflightInstalledDaemon(paths, undefined, request.daemonArgv);
    if (!owned || !installedDaemonIdentity(paths, undefined, request.daemonArgv).same) {
      admission = deferred(daemon ? "the running daemon belongs to another installation or has no recorded service; it and its Managers were left running" : "no recorded service belongs to this installation; activation was not requested");
    } else {
      const reply = await queryDaemon({ paths });
      if (!reply.ok) throw new Error(`daemon custody is unavailable: ${reply.error.message}`);
      if (!daemon || reply.result.pid !== daemon.pid) throw new Error("daemon status differs from its authenticated lifetime");
      const active = (reply.result.managers ?? []).filter(manager => manager.pid !== undefined);
      const inventory: Extract<UpdateAdmission, { disposition: "consent-stop" }>["inventory"][number][] = [];
      let occupied = 0;
      for (const manager of active) {
        if (!manager.instanceId) throw new Error(`Manager ${manager.space} has no verified instance identity`);
        const instanceId = manager.instanceId;
        await withIdpSessionDir(homeCotalDir(), async () => {
          const target = await resolveControlTarget({ space: manager.space }, "control-caller-privileged", instanceId, { onRefusal: "throw", readOnly: true });
          const client = { versionSkew: (text: string) => text, roster: async () => [] };
          const status = await askManager(client, manager.space, target.server, "managerStatus", undefined, target.auth, "owner", 3000, { instanceId });
          if (!status.ok) throw new Error(status.error ?? `Manager ${manager.space} did not answer`);
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
  return { daemon, admission };
}
