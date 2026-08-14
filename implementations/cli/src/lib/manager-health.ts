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
  /** ⚠️ No caller could be built, so the question was never put. Deliberately NOT `no-responder`:
   *  nothing was asked and no manager is implicated.
   *
   *  This arm exists because the standard pinned-caller resolve (`resolveControlTarget` →
   *  `connectOrExit`) calls `process.exit(1)` at thirteen sites. A read-only card that used it
   *  would TERMINATE on a missing credential or an unreachable broker — printing a truncated card
   *  and no verdict at all — in exactly the situation an operator ran the command to diagnose.
   *  Silence is the one output this surface may never produce, so the inability to ask is carried
   *  as a fact like any other. */
  | { condition: "no-auth"; detail: string; source: string; observedAt: number }
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

/** The local pid evidence, as `managerLivenessSnapshot()` reports it. */
export type LocalManagerEvidence = "alive" | "dead" | "unknown" | "absent" | "unattributable";

/**
 * What the card is entitled to claim, given local process evidence AND an affirmative health read.
 *
 * PURE ON PURPOSE. The decision is the part an operator acts on, so it is separated from the I/O
 * that feeds it and every row can be constructed deterministically — including the rows a live
 * broker makes expensive or racy to reach. A cell that has to schedule a wedge to check what the
 * card SAYS about a wedge is testing two things and proving neither.
 *
 * `startHint` is the field with teeth: it is the only output that tells an operator to LAUNCH
 * something, and a hint offered over a manager that is merely unreachable is how a second stack gets
 * started against a live one. It is earned in exactly one shape and denied everywhere else.
 */
export interface ManagerClaim {
  /** `serving` is the ONLY affirmative claim. */
  claim: "serving" | "wedged" | "absent" | "refused" | "misattributed" | "cannot-establish";
  /** Is the manager provably answering? Never true unless an attributed reply arrived. */
  serving: boolean;
  /** May the card tell the operator to start a manager? */
  startHint: boolean;
  /** Which condition failed, in the operator's words. Never a bare "unknown". */
  detail: string;
}

/**
 * The six-row decision table. ORDER IS LOAD-BEARING and each branch says why it comes where it does.
 */
export function managerClaim(local: LocalManagerEvidence, health: ManagerHealth): ManagerClaim {
  // 1. An attributed affirmative reply. The only route to green, and it does not consult the local
  //    pid at all: a manager that ANSWERS is serving whether or not this root recorded its pid.
  if (health.condition === "serving")
    return {
      claim: "serving", serving: true, startHint: false,
      detail: `answered in ${health.rttMs}ms as instance ${health.report.instanceId} (runtime ${health.report.runtime}, ${health.report.agentCount} agent(s), up ${health.report.uptimeMs}ms by its own clock)`,
    };

  // 2. Before any "nothing answered" reasoning: something DID answer, and it was the wrong manager.
  //    Placed here because its reply is affirmative and would otherwise be mistaken for ours, and
  //    because treating it as absence would invite starting a manager over a live sibling.
  if (health.condition === "unattributed")
    return {
      claim: "misattributed", serving: false, startHint: false,
      detail: `a manager answered but identified itself as ${health.replied}, not this root's ${health.expected} — that reply is true about a different process`,
    };

  // 3. A refusal is an ANSWER: something is serving and declined. Never absence, never a start hint.
  if (health.condition === "refused")
    return { claim: "refused", serving: false, startHint: false, detail: `the manager refused the health read: ${health.detail}` };

  // 4. The broker was never reached, so the manager is not implicated. Calling it down here would
  //    blame the wrong component and recommend the wrong repair.
  if (health.condition === "unreachable")
    return { claim: "cannot-establish", serving: false, startHint: false, detail: `the broker could not be reached, so nothing has been established about the manager: ${health.detail}` };

  // 5. We could not even ask. Distinct from every answer above and from silence below.
  if (health.condition === "no-auth" || health.condition === "malformed-reply")
    return { claim: "cannot-establish", serving: false, startHint: false, detail: health.detail };

  // 6. Local evidence we cannot attribute outranks the remaining remote silence: a record we cannot
  //    read may front a live process nobody can identify, and a start hint over it is the
  //    double-launch. Checked before the absent case for exactly that reason.
  if (local === "unknown" || local === "unattributable")
    return {
      claim: "cannot-establish", serving: false, startHint: false,
      detail: local === "unknown"
        ? "the kernel answered neither running nor no-such-process for the recorded pid, and no manager answered — ownership of that process cannot be established"
        : "the pid record does not hold a pid, and no manager answered — that record may front a live process nobody can identify",
    };

  // 7. Nothing answered, and a local process IS present: the wedge. This is the incident shape —
  //    the process exists, the health read gets nothing, and the old card called it running.
  //    Explicitly no start hint: the process is alive and a second one would contend with it.
  if (local === "alive")
    return {
      claim: "wedged", serving: false, startHint: false,
      detail: `a local process is present but no manager answered the health read — it is not serving, and starting another would contend with it`,
    };

  // 8. Nothing answered and no local process. ONLY here is the hint earned.
  return {
    claim: "absent", serving: false, startHint: true,
    detail: health.condition === "no-identity"
      ? "no manager is recorded for this root and none answered"
      : "no local process and no manager answered",
  };
}

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
  /** Undefined when no caller could be minted — reported as `no-auth`, never as a manager fact. */
  caller: EpCaller | undefined;
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

  // Order matters: this is checked AFTER the identity, because "there is no manager to ask about"
  // and "we could not build a caller to ask with" are different gaps and the first one makes the
  // second irrelevant.
  if (o.caller === undefined)
    return {
      condition: "no-auth",
      detail: `no caller credential could be built for space "${o.space}" — the health question was never put, so nothing has been established about the manager`,
      source, observedAt,
    };
  const caller = o.caller;

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
      service = await resolveService(nc, o.space, BASELINE_LIFECYCLE_ENDPOINT, caller, { deadlineMs: timeoutMs, instanceId });
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
