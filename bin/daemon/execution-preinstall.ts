import { join } from "node:path";
import { withIdpSessionDir } from "@cotal-ai/auth";
import { linuxSharedPtyMayBeActive } from "@cotal-ai/seat";
import { homeCotalDir, resolveControlTarget, type UpdateAdmission } from "@cotal-ai/workspace";
import { askManager } from "@cotal-ai/workspace/control";
import { queryDaemon } from "./client.js";
import { daemonPaths } from "./endpoint.js";
import { installedDaemonIdentity, preflightInstalledDaemon } from "./install.js";
import { observeUpdateDaemon, sameUpdateDaemon } from "./update-lifetime.js";
import { processBirth } from "./lifetime.js";
import { HostedLaunchSettlementTimeout, readSettledHostedStatus } from "./update-launch-settlement.js";
import { PREINSTALL_PROGRESS } from "./execution-preinstall-client.js";

export interface ExecutionPreinstallRequest {
  readonly v: 1;
  readonly nonce: string;
  readonly installedEntry: string;
  readonly daemonArgv: readonly string[];
  readonly flags: Record<string, unknown>;
  readonly supportsExtendedLaunchWait?: true;
}

// Released callers stop the entire child after 120 seconds. Both budgets span all Managers
// and leave time for the closing daemon identity observation and receipt.
export function stagedLaunchDeadline(request: Pick<ExecutionPreinstallRequest, "supportsExtendedLaunchWait">, started: number): number {
  return started + (request.supportsExtendedLaunchWait === true ? 200_000 : 80_000);
}

export const pendingLaunchDeferral = "a hosted spawn is still in progress";

export function stagedCustodyDeferral(error: unknown): Extract<UpdateAdmission, { disposition: "deferred" }> {
  if (error instanceof HostedLaunchSettlementTimeout && error.pending === "held") throw error;
  const reason = error instanceof HostedLaunchSettlementTimeout ? pendingLaunchDeferral : `machine daemon custody could not be checked: ${error instanceof Error ? error.message : String(error)}`;
  return { disposition: "deferred", occupied: null, hostedSpaces: [], reason: reason.slice(0, 2000) };
}

async function withinLaunchDeadline<T>(deadline: number, read: () => Promise<T>): Promise<T> {
  const remaining = deadline - performance.now();
  if (remaining <= 0) throw new Error("the staged custody check reached its deadline");
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([read(), new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("the staged custody check reached its deadline")), remaining);
    })]);
  } finally { clearTimeout(timer); }
}

/** Read-only target policy. Unknown custody permits software publication, never a destructive restart. */
export async function readExecutionPreinstall(request: ExecutionPreinstallRequest) {
  const launchDeadline = stagedLaunchDeadline(request, performance.now());
  const daemon = await observeUpdateDaemon();
  let admission: UpdateAdmission;
  const deferred = (reason: string): UpdateAdmission => ({ disposition: "deferred", occupied: null, hostedSpaces: [], reason: reason.slice(0, 2000) });
  try {
    const state = { state: join(homeCotalDir(), "daemon") };
    const recorded = preflightInstalledDaemon(state, undefined, request.daemonArgv);
    if (!daemon) {
      // A stopped daemon can still have a draining native PTY unit. Preinstall observes it but
      // never signals it. An idle installation may go on to start its recorded service.
      admission = linuxSharedPtyMayBeActive(request.installedEntry, homeCotalDir())
        ? deferred("the previous hosted PTY processes are still stopping") : { disposition: "restart-empty", occupied: 0, hostedSpaces: [] };
    } else if (!recorded || !installedDaemonIdentity(state, undefined, request.daemonArgv).same) {
      admission = deferred("the running daemon belongs to another installation or has no recorded service; it and its Managers were left running");
    } else {
      const paths = daemonPaths();
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
        // Allow the poller to classify a pending launch at its deadline. Bound any final
        // in-progress transport or credential read separately before closing the receipt.
        const { agentCount: count } = await withinLaunchDeadline(launchDeadline + 2_000,
          () => readSettledHostedStatus(paths, manager.space, instanceId, "update --self", line => process.stdout.write(`${PREINSTALL_PROGRESS}${line}\n`), launchDeadline));
        if (processBirth(manager.pid!) !== birth) throw new Error(`Manager ${manager.space} identity changed`);
        if (typeof count !== "number" || !Number.isSafeInteger(count) || count < 0) throw new Error(`Manager ${manager.space} work count is unknown`);
        occupied += count;
        if (count === 0) continue;
        await withinLaunchDeadline(launchDeadline, () => withIdpSessionDir(homeCotalDir(), async () => {
          const target = await resolveControlTarget({ space: manager.space }, "control-caller-privileged", instanceId, { onRefusal: "throw", readOnly: true });
          const client = { versionSkew: (text: string) => text, roster: async () => [] };
          const rows = await askManager(client, manager.space, target.server, "ps", undefined, target.auth, "owner", 3000, { instanceId });
          const agents = rows.data as { name: string; id: string; lifecycleUid: string }[];
          if (!rows.ok || !Array.isArray(agents) || agents.length !== count || agents.some(agent => !agent || [agent.name, agent.id, agent.lifecycleUid].some(value => typeof value !== "string" || !value))) throw new Error(`Manager ${manager.space} exact work inventory is unavailable`);
          inventory.push({ space: manager.space, instanceId, agents: agents.map(({ name, id, lifecycleUid }) => ({ name, id, lifecycleUid })) });
        }));
      }
      const hostedSpaces = active.map(manager => manager.space);
      admission = occupied > 0 ? { disposition: "consent-stop", occupied, hostedSpaces, inventory }
        : (active.length === 0 || active.length !== reply.result.managers.length) && linuxSharedPtyMayBeActive(request.installedEntry, homeCotalDir()) ? deferred("the previous hosted PTY processes are still stopping")
          : { disposition: "restart-empty", occupied: 0, hostedSpaces };
    }
  } catch (error) {
    admission = stagedCustodyDeferral(error);
  }
  if (!sameUpdateDaemon(daemon, await observeUpdateDaemon())) throw new Error("machine daemon lifetime changed during target admission");
  // Released updaters (0.165.4 to 0.168.0) refuse a receipt whose `occupied` is not a non-negative
  // integer and read nothing else from it. The admission carries the unknown count.
  return { daemon, hostedSpaces: admission.hostedSpaces, occupied: admission.occupied ?? 0, admission };
}
