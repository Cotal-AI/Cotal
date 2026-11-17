import { join } from "node:path";
import { withIdpSessionDir, withRemoteExchangeRetry } from "@cotal-ai/auth";
import { localUpdateManagers, readManagerContinuity, reportRunningManagers } from "@cotal-ai/cli/update";
import { CommandFailure, homeCotalDir, resolveControlTarget } from "@cotal-ai/workspace";
import { askManager } from "@cotal-ai/workspace/control";
import { queryDaemon } from "./client.js";
import { daemonPaths, EndpointRefusal } from "./endpoint.js";
import { preflightInstalledDaemon } from "./install.js";
import { setTimeout as delay } from "node:timers/promises";
import { preinstallPreservationObservation, preservingPreinstallRefusal } from "./preinstall-preservation.js";
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
    let preservingDeadline: number | undefined;
    const hostedIdentity = (status: typeof reply.result) => JSON.stringify(status.managers.filter(row => row.pid !== undefined).map(row => [row.space, row.pid, row.instanceId]).sort((a, b) => String(a[0]).localeCompare(String(b[0]))));
    const initialHostedIdentity = hostedIdentity(reply.result);
    let occupied = 0;
    for (const manager of active) {
      if (!manager.instanceId) throw new CommandFailure("refused", "LIFECYCLE_BLOCKED", `hosted Manager ${manager.space} has no verified instance identity`);
      const managerBirth = processBirth(manager.pid!);
      if (!managerBirth) throw new Error("hosted Manager lifetime is unreadable during pre-install check");
      await withIdpSessionDir(homeCotalDir(), async () => {
        const target = await resolveControlTarget({ space: manager.space }, "control-caller-privileged", manager.instanceId, { onRefusal: "throw", readOnly: true });
        let observed = reply.result;
        const pin = () => {
          if (processBirth(lifetime.pid) !== lifetime.start || observed.pid !== lifetime.pid || hostedIdentity(observed) !== initialHostedIdentity) throw new Error("machine daemon or hosted Manager identities changed during preserving observation");
          const current = observed.managers.find(row => row.space === manager.space && row.instanceId === manager.instanceId);
          if (!current || current.pid !== manager.pid || processBirth(manager.pid!) !== managerBirth) throw new Error("hosted Manager lifetime changed during preserving observation");
        };
        let status;
        for (;;) {
          pin();
          status = await askManager({ versionSkew: (text: string) => text, roster: async () => [] }, manager.space, target.server, "managerStatus", undefined, target.auth, "owner", preservingDeadline === undefined ? 3000 : Math.max(1, Math.min(3000, preservingDeadline - Date.now())), { instanceId: manager.instanceId });
          if (status.ok) break;
          if (!/manager is in preserving mode/.test(status.error ?? "")) throw new Error(status.error ?? "hosted Manager status did not answer");
          preservingDeadline ??= Date.now() + 5000;
          const custody = preinstallPreservationObservation(observed);
          if (custody.seats !== 0 || !["gone", "transaction"].includes(custody.owner) || Date.now() >= preservingDeadline) throw preservingPreinstallRefusal(custody);
          await delay(Math.min(100, Math.max(1, preservingDeadline - Date.now())));
          const fresh = await queryDaemon({ paths, timeoutMs: Math.max(1, Math.min(1000, preservingDeadline - Date.now())) });
          if (!fresh.ok) throw new Error("machine daemon custody is unreadable during preserving observation");
          observed = fresh.result;
        }
        pin();
        if ((status.data as { instanceId?: unknown }).instanceId !== manager.instanceId) throw new Error("hosted Manager instance changed before pre-install receipt");
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
