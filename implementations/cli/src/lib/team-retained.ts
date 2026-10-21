import { DEV_OWNER } from "@cotal-ai/core";
import { CommandFailure, type ControlAuth } from "@cotal-ai/workspace";
import { askManager, managerFailure } from "./control.js";
import { listAdditiveTeamAttempts, retainedAdditiveTeamAttempts, type AdditiveAgentReceipt, type AdditiveTeamAttempt } from "./team-additive-attempt.js";

type Agent = AdditiveAgentReceipt["createdAgents"][number];
export interface OriginalIncarnation { requested: string; name: string; id: string; lifecycleUid: string; evidence: "static-slot-active-live" | "manager-ps-exact-identity"; slotRevision: number | null }

/** Retained agent or mixed deployments for this exact manifest. A removed deployment is not
 *  retained and never matches. An unreadable inventory returns nothing here, so the caller's
 *  own guards refuse it unchanged. */
export function retainedTeamMatches(root: string, space: string, manifestHash: string): AdditiveTeamAttempt[] | undefined {
  let inventory: ReturnType<typeof listAdditiveTeamAttempts>;
  try { inventory = listAdditiveTeamAttempts(root); } catch { return undefined; }
  const rows = retainedAdditiveTeamAttempts(inventory).filter((row) => row.space === space && row.manifestHash === manifestHash && row.requestedAgents.length > 0);
  return rows.length ? rows : undefined;
}

/** Each original incarnation, read from its original manager. Static auth reads the durable slot
 *  (identity, lifecycle UID, active, live). Open meshes have no slot store, so the pinned manager's
 *  `ps` must report the exact identity and lifecycle UID. A missing, retired, successor or
 *  foreign holder refuses; nothing is relaunched or adopted. The read is ordered, not atomic. */
export async function verifyOriginalIncarnations(input: { space: string; server: string; auth: ControlAuth; mode: "auth" | "open"; managerInstanceId: string; agents: readonly Agent[]; target: Record<string, unknown> }): Promise<{ managerEpoch: number | null; agents: OriginalIncarnation[] }> {
  const { space, server, auth, managerInstanceId: manager, agents, target } = input;
  const refuse = (agent: Agent, message: string) => new CommandFailure("refused", "LIFECYCLE_BLOCKED", message, { target: { ...target, agent: agent.name, expectedId: agent.id, expectedLifecycleUid: agent.lifecycleUid }, remedy: "inspect team show <deployment-id>; a missing or replaced incarnation is not relaunched or adopted by a re-apply" });
  if (input.mode === "auth") {
    const answer = await askManager(space, server, "slots", { names: agents.map((row) => row.name), includeRetired: true }, auth, "any", 2_000, { instanceId: manager });
    if (!answer.ok) throw managerFailure(answer, "retained incarnation inspection", target);
    const rows = answer.data as Array<{ name?: unknown; owner?: unknown; actor?: unknown; slotLifecycleUid?: unknown; slotPhase?: unknown; slotRevision?: unknown; headLifecycleUid?: unknown; live?: unknown; managerInstanceId?: unknown }>;
    if (answer.managerInstanceId !== manager || !Number.isSafeInteger(answer.managerEpoch) || !Array.isArray(rows) || rows.length > agents.length || new Set(rows.map((row) => row?.name)).size !== rows.length || rows.some((row) => !agents.some((agent) => agent.name === row?.name)))
      throw new CommandFailure("refused", "SCHEMA_INVALID", "the original manager did not return a bounded attributed slot query; no incarnation was inferred", { target });
    return { managerEpoch: answer.managerEpoch!, agents: agents.map((agent) => {
      const row = rows.find((item) => item.name === agent.name);
      if (!row || row.owner !== DEV_OWNER || row.actor !== agent.id || row.slotLifecycleUid !== agent.lifecycleUid || row.managerInstanceId !== manager || row.headLifecycleUid !== undefined && row.headLifecycleUid !== agent.lifecycleUid)
        throw refuse(agent, "an original static slot is absent, foreign or names a successor incarnation; no relaunch or same-name adoption was attempted");
      if (row.slotPhase !== "active" || row.live !== true || !Number.isSafeInteger(row.slotRevision))
        throw refuse(agent, "an original incarnation is not active and live; a re-apply does not restart, resume or replace it");
      return { requested: agent.requested, name: agent.name, id: agent.id, lifecycleUid: agent.lifecycleUid, evidence: "static-slot-active-live" as const, slotRevision: row.slotRevision as number };
    }) };
  }
  const answer = await askManager(space, server, "ps", undefined, auth, "any", 2_000, { instanceId: manager });
  if (!answer.ok) throw managerFailure(answer, "retained incarnation inspection", target);
  const live = answer.data as Array<{ name?: unknown; id?: unknown; lifecycleUid?: unknown }>;
  if (answer.managerInstanceId !== manager || !Array.isArray(live) || live.length > 10_000 || live.some((row) => !row || typeof row.name !== "string" || typeof row.id !== "string" || typeof row.lifecycleUid !== "string"))
    throw new CommandFailure("refused", "SCHEMA_INVALID", "the original manager did not return a bounded, attributed agent inventory; no incarnation was inferred", { target });
  return { managerEpoch: Number.isSafeInteger(answer.managerEpoch) ? answer.managerEpoch! : null, agents: agents.map((agent) => {
    const exact = live.filter((row) => row.id === agent.id);
    if (exact.length !== 1 || exact[0]!.name !== agent.name || exact[0]!.lifecycleUid !== agent.lifecycleUid || live.some((row) => row.name === agent.name && row.id !== agent.id))
      throw refuse(agent, "the original incarnation is not the only exact identity holder in the manager's inventory; no relaunch or same-name adoption was attempted");
    return { requested: agent.requested, name: agent.name, id: agent.id, lifecycleUid: agent.lifecycleUid, evidence: "manager-ps-exact-identity" as const, slotRevision: null };
  }) };
}
