import { AmbiguousPeerError, assertLifecycleToken, resolvePeer, type Presence } from "@cotal-ai/core";
import { CommandFailure } from "../output.js";
import type { ManagerPin } from "./manager.js";

/** Resolve a live presence address before submitting any manager request. The hint grants no
 * authority. Keep its canonical name and incarnation with the instance selected for the mint. */
export function presenceSeat(roster: readonly Presence[], name: string): { instanceId: string; expectedSeat: NonNullable<ManagerPin["expectedSeat"]> } {
  const target = { agent: name };
  let peer: Presence | undefined;
  try { peer = resolvePeer(roster.filter(p => p.status !== "offline"), name); }
  catch (error) {
    if (error instanceof AmbiguousPeerError) throw new CommandFailure("refused", "TARGET_AMBIGUOUS", error.message, { target });
    throw new CommandFailure("refused", "USAGE_INVALID", error instanceof Error ? error.message : String(error), { target });
  }
  if (!peer) throw new CommandFailure("refused", "TARGET_NOT_FOUND", `no managed agent "${name}" in live presence for this space`, { target });
  const instance = peer.card.meta?.["ai.cotal.manager.instance"];
  if (typeof instance !== "string" || !peer.lifecycleUid)
    throw new CommandFailure("refused", "TARGET_UNAVAILABLE", `agent "${peer.card.name}" reports no holding manager instance or lifecycle`, { target });
  try {
    return { instanceId: assertLifecycleToken(instance, "holding manager instance"), expectedSeat: { name: peer.card.name, id: peer.card.id, lifecycleUid: assertLifecycleToken(peer.lifecycleUid, "seat lifecycle") } };
  } catch {
    throw new CommandFailure("refused", "TARGET_UNAVAILABLE", `agent "${peer.card.name}" reports an invalid holding manager instance or lifecycle`, { target });
  }
}
