/**
 * THE DELIVERY RESPONDER AXIS (#1576) — one reader, used by every surface that answers
 * "can this mesh spawn, retire and join right now".
 *
 * THE DEFECT THIS MODULE EXISTS TO REMOVE. The delivery daemon's PROCESS and its RESPONDER are two
 * different facts, and every operator-facing surface used to report the first while the second was
 * what the mesh actually depends on. A reporter ran a 30-agent fleet for 22 hours against a daemon
 * that never bound: `systemctl is-active` said active (the PARENT `cotal up` was alive), `cotal ps`
 * listed the agents, and bare `cotal status` printed `delivery  running (pid 291)` — the identical
 * line it prints when the responder IS bound. Spawn, retirement and join were all failing the whole
 * time, and the only place the real cause was ever named was inside one PTY, on one operation.
 *
 * THE SOURCE OF TRUTH IS THE SHARD-0 LEASE `ready` FLAG, and it is not a new one: the daemon
 * CAS-creates its lease `ready:false` BEFORE binding (the single-flight gate that stops two daemons
 * splitting a durable), then flips it to `ready:true` only AFTER `startPlane3` has bound the
 * `ctl.delivery` responder and the fan-out/reader loops. So `ready === true` is the only fact that
 * distinguishes "the responder is bound" from "a process exists" (pidfile) or "a slot was claimed"
 * (lease present, not ready). See `DeliveryLeaseInfo` in core and the flip site in the daemon.
 *
 * WHY A SHARED MODULE RATHER THAN A SECOND READ. `--components` already computed this correctly and
 * bare `status` did not, which is precisely how the two surfaces came to disagree about a mesh's
 * health. Both now reduce through {@link deliveryResponderState}, so a future change cannot fix one
 * and leave the other green. It reads; it never mints, writes or repairs.
 */
import type { DeliveryLeaseInfo } from "@cotal-ai/core";

/** What is known about the responder, as opposed to the process.
 *
 *  `unknown` IS A FIRST-CLASS ANSWER AND MUST NOT BE FOLDED INTO `bound`. A lease read can fail for
 *  reasons that say nothing about the daemon (no target resolved, broker unreachable, a denied read
 *  on a mesh whose creds predate the read grant). Reporting any of those as health is the original
 *  defect in a new place, so the renderer says the axis was not checked and names the surface that
 *  can check it. */
export type DeliveryResponderState = "bound" | "unbound" | "unknown";

/** The consequence, in the operator's terms rather than the daemon's.
 *
 *  This sentence is the whole point of the fix. The boot path used to print a PROMISE
 *  ("boot durable joins will reconcile when it is") and nothing else: true, but it told an operator
 *  nothing about what was broken MEANWHILE, so a 22-hour outage read as a progress note. The
 *  reconcile is real and does run once a daemon binds; what nobody was told is that until it binds,
 *  these three operations cannot complete. */
export const RESPONDER_UNBOUND_CONSEQUENCE =
  "no spawn, no retirement, no join until it binds";

/** Classify a shard-0 lease record. `undefined` means the lease key is absent, which on a mesh that
 *  HAS a delivery daemon recorded is an unbound responder, not a missing opinion: the daemon creates
 *  its lease before it binds, so no lease at all means nothing has even claimed the slot. */
export function deliveryResponderFromLease(lease: DeliveryLeaseInfo | undefined): DeliveryResponderState {
  if (lease === undefined) return "unbound";
  return lease.ready === true ? "bound" : "unbound";
}

/** Read the axis through a caller-supplied lease reader, mapping a FAILED read to `unknown` rather
 *  than to either health state. The reader is injected so the offline surfaces (which must not open
 *  a connection) and the connected ones share one classification without sharing a transport. */
export async function deliveryResponderState(
  readLease: () => Promise<DeliveryLeaseInfo | undefined>,
): Promise<DeliveryResponderState> {
  try {
    return deliveryResponderFromLease(await readLease());
  } catch {
    return "unknown";
  }
}

/** The bare-`status` process row's delivery suffix: what the recorded PROCESS means once the
 *  responder axis is known.
 *
 *  A LIVE PID WITH AN UNBOUND RESPONDER IS THE REPORTED DEFECT, so it is the case that must never
 *  render as a bare "running". A live pid whose responder is bound is genuinely serving and says so.
 *  An unchecked axis says it is unchecked and names `--components`; it never implies either. */
export function deliveryRowSuffix(live: boolean, state: DeliveryResponderState, componentsHint: string): string {
  if (!live) return "";
  switch (state) {
    case "bound":
      return " · responder bound";
    case "unbound":
      return ` · RESPONDER NOT BOUND - ${RESPONDER_UNBOUND_CONSEQUENCE}`;
    case "unknown":
      return ` · responder state unchecked (${componentsHint})`;
  }
}
