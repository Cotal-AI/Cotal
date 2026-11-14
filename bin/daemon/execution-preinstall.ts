import { join } from "node:path";
import { withIdpSessionDir, withRemoteExchangeRetry } from "@cotal-ai/auth";
import { localUpdateManagers, readManagerContinuity, reportRunningManagers } from "@cotal-ai/cli/update";
import { CommandFailure, homeCotalDir, resolveControlTarget } from "@cotal-ai/workspace";
import { askManager } from "@cotal-ai/workspace/control";
import { queryDaemon } from "./client.js";
import { daemonPaths, EndpointRefusal } from "./endpoint.js";
import { preflightInstalledDaemon } from "./install.js";
import { processBirth, readLifetimeRecord } from "./lifetime.js";

export interface ExecutionPreinstallRequest {
  readonly v: 1;
  readonly nonce: string;
  readonly installedEntry: string;
  readonly daemonArgv: readonly string[];
  readonly flags: Record<string, unknown>;
}

/** Read-only admission. Consent and all Manager/daemon mutation remain in the parent transaction. */
export async function readExecutionPreinstall(request: ExecutionPreinstallRequest): Promise<{ daemon?: { pid: number; start: string }; hostedSpaces: string[]; occupied: number }> {
  preflightInstalledDaemon({ state: join(homeCotalDir(), "daemon") }, undefined, request.daemonArgv);
  return withRemoteExchangeRetry(async () => {
    const readOne = (flags: Record<string, unknown>) => readManagerContinuity(flags, { readOnly: true, retainGraph: true, installedEntry: request.installedEntry });
    const paths = daemonPaths();
    let reply;
    try { reply = await queryDaemon({ paths }); }
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
