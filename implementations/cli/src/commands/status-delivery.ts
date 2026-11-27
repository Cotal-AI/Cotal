import type { MeshTarget, Tone } from "@cotal-ai/workspace";
import { RESPONDER_STALE_TEXT, RESPONDER_UNBOUND_CONSEQUENCE, type DeliveryResponderState } from "../lib/delivery-responder.js";
import { displayCmd } from "../lib/self-exec.js";

/** The delivery responder row shared by compact and verbose status. An open mesh with no lease
 *  does not use a delivery daemon. */
export function responderText(state: DeliveryResponderState | null, mode: MeshTarget["mode"], stackBlocked = false, deliveryPid?: number, storeFull = false): { text: string; tone: Tone } | undefined {
  if (state === null && mode === "open") return { text: "not used - an open mesh runs no delivery daemon", tone: "hint" };
  // `up` starts no second daemon beside a running delivery member.
  if (state === "unbound" && deliveryPid !== undefined)
    return { text: `no lease · stack-delivery pid ${deliveryPid} is alive but holds no lease, so it is starting or not responding`, tone: "failed" };
  if (state === "unbound")
    return { text: `NOT BOUND - ${RESPONDER_UNBOUND_CONSEQUENCE} · ${stackBlocked ? `\`${displayCmd()} up\` refuses until the stack block is cleared, as Next shows` : storeFull ? `the full store refuses its lease, so \`${displayCmd()} up\` starts it only once there is room, as Next shows` : `start it with \`${displayCmd()} up\``}`, tone: "failed" };
  if (state === "stale")
    return { text: `NOT BOUND - ${RESPONDER_STALE_TEXT} · \`${displayCmd()} up\` restarts it, after waiting out the lease`, tone: "failed" };
  if (state === "bound") return { text: "bound", tone: "ok" };
  return undefined;
}
