import type { EpCaller } from "./endpoint-subjects.js";
import { assertLifecycleToken } from "./subjects.js";

/** Refuse a minted `manager-caller` bearer (SPEC §10) that is not bound to the caller's space and
 *  principal or that names another instance than the one the caller selected, and return the caller
 *  triple and the bound instance. Only the routing coordinates are decoded: the broker verifies the
 *  signed bearer before any call. Every client that mints this view checks it here, so a new claim
 *  is checked in one place. */
export function managerCallerBinding(
  bearer: string,
  expected: { space: string; owner: string; actor: string; lifecycleUid: string; instanceId?: string },
): { caller: EpCaller; instanceId: string } {
  let payload: { sub?: unknown; aud?: unknown; act?: Record<string, unknown> };
  try {
    const parts = bearer.split(".");
    if (parts.length !== 3) throw new Error("invalid JWT");
    payload = JSON.parse(Buffer.from(parts[1]!, "base64url").toString("utf8"));
  } catch {
    throw new Error("manager control exchange returned an invalid bearer");
  }
  const act = payload?.act;
  if (!act || act.view !== "manager-caller" || payload.sub !== expected.owner ||
      act.owner !== expected.owner || act.actor !== expected.actor || act.lifecycleUid !== expected.lifecycleUid ||
      !(payload.aud === expected.space || (Array.isArray(payload.aud) && payload.aud.length === 1 && payload.aud[0] === expected.space)))
    throw new Error("manager control exchange returned different space, principal, lifecycle or view coordinates");
  if (typeof act.managerInstanceId !== "string")
    throw new Error("manager control exchange returned no concrete manager instance");
  const instanceId = assertLifecycleToken(act.managerInstanceId, "managerInstanceId");
  if (expected.instanceId !== undefined && instanceId !== expected.instanceId)
    throw new Error("manager control exchange selected a different manager instance");
  return { caller: { owner: expected.owner, actor: expected.actor, uid: expected.lifecycleUid }, instanceId };
}
