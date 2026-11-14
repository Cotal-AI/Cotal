/** Target-version admission reads, without preparing or replacing the installed daemon. */
import { join } from "node:path";
import { withIdpSessionDir, withRemoteExchangeRetry } from "@cotal-ai/auth";
import { localUpdateManagers, readManagerContinuity, reportRunningManagers, updateManagerPin } from "@cotal-ai/cli/update";
import { assertRecordIdentity, brokerAddressKey, CommandFailure, homeCotalDir, resolveControlTarget, shellPath } from "@cotal-ai/workspace";
import { askManager } from "@cotal-ai/workspace/control";
import { queryDaemon } from "./client.js";
import { daemonPaths, EndpointRefusal } from "./endpoint.js";
import { preflightInstalledDaemon } from "./install.js";

export interface TargetPreinstallRequest {
  readonly installedEntry: string;
  readonly daemonArgv: readonly string[];
  readonly flags: Record<string, unknown>;
}

export interface TargetPreinstallResult {
  readonly daemonObserved: boolean;
  readonly hostedSpaces: string[];
}

/** Read every affected hosted Manager and local Manager using the installed launch identity. */
export async function runTargetPreinstall(request: TargetPreinstallRequest): Promise<TargetPreinstallResult> {
  preflightInstalledDaemon({ state: join(homeCotalDir(), "daemon") }, undefined, request.daemonArgv);
  return withRemoteExchangeRetry(async () => {
    const { flags, installedEntry } = request;
    const readOne = (target: Record<string, unknown>) => readManagerContinuity(target, installedEntry);
    const reportLocal = (target: Record<string, unknown>) => reportRunningManagers(target, readOne, selected => localUpdateManagers(selected, installedEntry));
    const requireContinuity = async (verdict: Promise<"none" | "legacy">): Promise<void> => {
      if (await verdict === "legacy") throw new CommandFailure("refused", "LIFECYCLE_BLOCKED", "local Manager cannot preserve running agents on this computer during update", { remedy: "save their work, stop the affected agents, then rerun the same update command" });
    };
    let managers;
    try {
      const reply = await queryDaemon({ paths: daemonPaths() });
      if (!reply.ok) throw new Error(`machine daemon custody is unreadable: ${reply.error.message}`);
      managers = reply.result.managers ?? [];
    } catch (error) {
      if (!(error instanceof EndpointRefusal) || !["NOT_RUNNING", "NO_RUNTIME_DIR"].includes(error.code)) throw error;
      await requireContinuity(reportLocal(flags));
      return { daemonObserved: false, hostedSpaces: [] };
    }
    const active = managers.filter(manager => manager.pid !== undefined);
    const hostedSpaces = active.map(manager => manager.space);
    if (!active.length) {
      await requireContinuity(reportLocal(flags));
      return { daemonObserved: true, hostedSpaces };
    }
    for (const manager of active) {
      if (!manager.instanceId) throw new CommandFailure("refused", "LIFECYCLE_BLOCKED", `hosted Manager for ${manager.space} is ${manager.state}; its custody must answer before update`, { remedy: `run \`cotal daemon service-disconnect --space ${manager.space}\`, correct its sign-in or connection, then run \`cotal update\` again` });
      const reply = await withIdpSessionDir(homeCotalDir(), async () => {
        const target = await resolveControlTarget({ space: manager.space }, "control-caller-privileged", manager.instanceId, { onRefusal: "throw", readOnly: true });
        return askManager({ versionSkew: (text: string) => text, roster: async () => [] }, manager.space, target.server, "managerStatus", undefined, target.auth, "owner", 3000, { instanceId: manager.instanceId });
      });
      if (!reply.ok) throw new Error(reply.error ?? "hosted Manager status did not answer");
      const status = reply.data as { agentCount?: number; custody?: string; stopImpact?: { agents: { name: string }[] } };
      if (status.custody === "legacy" && status.agentCount !== 0) {
        const names = status.stopImpact?.agents.map(agent => agent.name);
        throw new CommandFailure("refused", "LIFECYCLE_BLOCKED", `hosted Manager ${manager.instanceId} cannot preserve running agents on this computer during update${names?.length ? ` (${names.join(", ")})` : ""}; restarting it would end them`, { remedy: `save their work; stop each with \`cotal stop <name> --on ${manager.instanceId} --space ${shellPath(manager.space)}\`, then rerun the same update command. To list agents, use \`cotal ps --on ${manager.instanceId} --space ${shellPath(manager.space)}\` (requires admin scope)` });
      }
    }
    if (process.platform === "linux" && typeof flags.creds !== "string") {
      const on = await updateManagerPin(flags, "cotal update");
      for (const manager of localUpdateManagers({ ...flags, ...(on === undefined ? {} : { on }) }, installedEntry)) {
        if (active.some(hosted => hosted.instanceId === manager.instanceId)) continue;
        if (typeof flags.space === "string" && flags.space !== manager.space) continue;
        if (typeof flags.server === "string" && brokerAddressKey(flags.server) !== brokerAddressKey(manager.server)) continue;
        if (on !== undefined && on !== manager.instanceId) continue;
        if (manager.process && assertRecordIdentity(manager.process).kind !== "match") throw new Error(`local Manager ${manager.instanceId} changed before its continuity read`);
        await requireContinuity(readOne({ ...flags, space: manager.space, server: manager.server, on: manager.instanceId }));
      }
    }
    if (process.platform !== "linux" && typeof flags.space !== "string") {
      const { readMeshRegistry } = await import("@cotal-ai/workspace");
      for (const entry of readMeshRegistry().entries) {
        if (active.some(manager => manager.space === entry.space)) continue;
        await requireContinuity(reportLocal({ ...flags, space: entry.space }));
      }
    }
    return { daemonObserved: true, hostedSpaces };
  });
}
