/**
 * AFFIRMATIVE manager health: is a manager ANSWERING for this root, right now.
 *
 * The lane's rule, and the reason this file is not a one-liner over `managerLiveness()`: **liveness
 * must be established by the same machinery a supervisor would trust, and absence of evidence is a
 * REFUSAL, not a pass.** `kill(pid, 0)` proves neither that the pid is a manager nor that a manager
 * answers — measured, not argued: a SIGSTOPped manager keeps its pid, keeps its lease inside the
 * TTL, and serves nothing, and the ready card called it running.
 *
 * WHY THIS DOES NOT GO THROUGH `askManager`. That helper collapses every failure into one
 * `{ok:false, error:string}` — a broker that could not be connected, a resolve that found no
 * responder, an auth refusal and a command-level error all arrive as the same shape with different
 * prose. A surface built on it could only name its condition by matching that prose, which is the
 * fragile thing wearing the shape of the honest thing. Driving the ep primitives directly makes the
 * STAGE the classification: the connect throws, or the resolve finds nobody, or the invoke is
 * refused, and each is a different fact about the world.
 *
 * The manager's own typed `status` is the smallest affirmative call available: `VOID` input,
 * `manager.read`, and a reply that carries `instanceId`, `runtime`, `agentCount`, `uptimeMs`
 * (manager-service-contract.ts:55-68). It is deliberately not `ps`: `ps` answers *can this manager
 * enumerate its agents*, a heavier claim over a larger reply.
 *
 * ATTRIBUTION IS VERIFIED, NOT ASSUMED. The request is pinned to this root's persisted instance id,
 * because an unpinned resolve can be answered by a sibling manager and manufacture a green about
 * the wrong process. But a pin is a request to the routing layer, not a proof about the answer — so
 * the reply's OWN `instanceId` must equal the pinned one, and a mismatch is its own condition. An
 * affirmative answer from an unidentified responder is not an affirmative answer about this root.
 *
 * `uptimeMs` is the responder's clock and is carried as reported, never converted to a local
 * timestamp: an age computed against a foreign clock is the defect this surface exists to catch.
 */
import { BASELINE_LIFECYCLE_ENDPOINT, EpEnvelopeError, invokeCommand, resolveService, standaloneConnectOpts, type EpCaller } from "@cotal-ai/core";
import { connect } from "@nats-io/transport-node";

/** How long the whole probe may take. A health read that has not answered is not a health read:
 *  the bound exists so the surface can say "did not answer in Nms" instead of hanging, and the
 *  number is reported with the verdict so a reader can tell a slow mesh from a dead one. */
export const MANAGER_HEALTH_TIMEOUT_MS = 3_000;

/** What the manager reported about itself. Its clock, its numbers — attributed, never re-based. */
export interface ManagerStatusReport {
  instanceId: string;
  runtime: string;
  agentCount: number;
  uptimeMs: number;
}

/**
 * A CLOSED union. Every arm names which condition failed, because a bare "unknown" is read as
 * "fine" by every operator who is in a hurry, which is all of them.
 *
 * `serving` is the ONLY affirmative arm and it is reachable only by a reply that arrived, parsed,
 * and identified itself as the pinned instance.
 */
export type ManagerHealth =
  | { condition: "serving"; report: ManagerStatusReport; source: string; observedAt: number; rttMs: number }
  /** No persisted identity for this root+space: there is nothing to pin to, so nothing was asked.
   *  NOT a statement that no manager is running. */
  | { condition: "no-identity"; detail: string; source: string; observedAt: number }
  /** The broker could not be reached at all. The manager is NOT implicated — saying "manager down"
   *  here would blame the wrong component and invite the wrong repair. */
  | { condition: "unreachable"; detail: string; source: string; observedAt: number; rttMs: number }
  /** The broker answered but no manager service resolved for the pinned instance inside the bound.
   *  This is the WEDGE signature and the absent signature at once; the local pid evidence is what
   *  separates them, and the caller combines the two rather than this function guessing. */
  | { condition: "no-responder"; detail: string; source: string; observedAt: number; rttMs: number }
  /** A responder existed and refused: permission, capability, or a command-level error. A refusal
   *  is an ANSWER — something is serving — and must never be rendered as absence. */
  | { condition: "refused"; detail: string; source: string; observedAt: number; rttMs: number }
  /** ⚠️ A reply arrived from a DIFFERENT instance than the one pinned. Its own affirmative content
   *  is true about some other manager, which makes it worse than silence here. */
  | { condition: "unattributed"; expected: string; replied: string; source: string; observedAt: number; rttMs: number }
  /** A reply arrived, was attributed, and did not match the contract. Reported rather than
   *  coerced: a health surface that guesses at a malformed answer is inventing the fact. */
  | { condition: "malformed-reply"; detail: string; source: string; observedAt: number; rttMs: number };

/** Every fact this surface reports carries where it came from. */
const sourceFor = (server: string, instanceId: string): string => `manager status @ ${server} (instance ${instanceId})`;

/**
 * Ask THE manager pinned to `instanceId` whether it is serving, within `timeoutMs`.
 *
 * Never throws for a health reason: an exception here would be a bug in the probe, and every state
 * of the world is a named arm of the union. `now` is injectable so a cell can assert the reported
 * `observedAt` without racing the clock.
 */
export async function probeManagerHealth(o: {
  space: string;
  server: string;
  instanceId: string | undefined;
  caller: EpCaller;
  creds?: string;
  bearer?: string;
  sentinelCreds?: string;
  tls?: boolean;
  timeoutMs?: number;
  now?: () => number;
}): Promise<ManagerHealth> {
  const now = o.now ?? Date.now;
  const timeoutMs = o.timeoutMs ?? MANAGER_HEALTH_TIMEOUT_MS;
  const observedAt = now();

  // Nothing to pin to means nothing was ASKED. Reporting this as "no manager" would be a claim
  // about the world derived from a gap in our own records.
  if (o.instanceId === undefined)
    return {
      condition: "no-identity",
      detail: `no persisted manager instance identity for space "${o.space}" under this root — there is no instance to address, so no health question was asked`,
      source: `local records (space ${o.space})`,
      observedAt,
    };
  const instanceId = o.instanceId;
  const source = sourceFor(o.server, instanceId);

  const started = now();
  const rtt = (): number => now() - started;

  let nc;
  try {
    nc = await connect({
      servers: o.server,
      ...standaloneConnectOpts(
        o.creds ? { creds: o.creds, tls: o.tls === true } : o.bearer ? { bearer: o.bearer, sentinelCreds: o.sentinelCreds, tls: o.tls === true } : { tls: o.tls === true },
      ),
      maxReconnectAttempts: 0,
    });
  } catch (e) {
    // The STAGE is the classification: we never got a connection, so nothing has been established
    // about any manager.
    return { condition: "unreachable", detail: (e as Error).message, source, observedAt, rttMs: rtt() };
  }

  try {
    let service;
    try {
      service = await resolveService(nc, o.space, BASELINE_LIFECYCLE_ENDPOINT, o.caller, { deadlineMs: timeoutMs, instanceId });
    } catch (e) {
      // The broker answered; the pinned manager did not. A wedged manager and an absent one both
      // land here, and this function does NOT guess between them — the caller holds the local pid
      // evidence that separates them.
      const msg = e instanceof EpEnvelopeError ? `${e.code}: ${e.message}` : (e as Error).message;
      return { condition: "no-responder", detail: `no manager answered for instance ${instanceId} within ${timeoutMs}ms (${msg})`, source, observedAt, rttMs: rtt() };
    }

    const r = await invokeCommand(nc, o.space, service, "status", undefined, { deadlineMs: timeoutMs });
    if (r.reply.ok !== true)
      return {
        condition: "refused",
        detail: r.reply.error?.message ?? r.reply.error?.code ?? "the manager refused the status read without naming a reason",
        source, observedAt, rttMs: rtt(),
      };

    const d = r.reply.data as Partial<ManagerStatusReport> | undefined;
    // Attribution BEFORE shape: a reply from the wrong instance is not made acceptable by being
    // well-formed, and checking the shape first would let a sibling's valid answer read as ours.
    if (typeof d?.instanceId !== "string")
      return { condition: "malformed-reply", detail: "the status reply carries no instanceId, so the answer cannot be attributed to any manager", source, observedAt, rttMs: rtt() };
    if (d.instanceId !== instanceId)
      return { condition: "unattributed", expected: instanceId, replied: d.instanceId, source, observedAt, rttMs: rtt() };

    if (typeof d.runtime !== "string" || typeof d.agentCount !== "number" || typeof d.uptimeMs !== "number")
      return { condition: "malformed-reply", detail: `the status reply from ${instanceId} does not match the contract (runtime/agentCount/uptimeMs)`, source, observedAt, rttMs: rtt() };

    return {
      condition: "serving",
      report: { instanceId: d.instanceId, runtime: d.runtime, agentCount: d.agentCount, uptimeMs: d.uptimeMs },
      source, observedAt, rttMs: rtt(),
    };
  } catch (e) {
    // An invoke that threw rather than replying: a responder was resolved, so this is not absence.
    const msg = e instanceof EpEnvelopeError ? `${e.code}: ${e.message}` : (e as Error).message;
    return { condition: "no-responder", detail: `the manager resolved but did not complete the status read within ${timeoutMs}ms (${msg})`, source, observedAt, rttMs: rtt() };
  } finally {
    await nc.drain().catch(() => nc.close());
  }
}
