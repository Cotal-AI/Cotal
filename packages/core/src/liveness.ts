/**
 * THE PEER-READABLE LIVENESS SURFACE (#1577) — "which plane is broken?", askable by a credentialed
 * peer that does not own the plane it is asking about.
 *
 * THE DEFECT THIS MODULE EXISTS TO REMOVE. The subjects that answer "is the manager alive" are
 * owner-only, so a peer holding valid credentials cannot ask. When its join or its send fails, the
 * peer cannot tell a credential problem from a dead manager, an unbound delivery daemon, or a broker
 * that is perfectly fine — so EVERY failure presents as a credential failure, because that is the
 * only hypothesis the peer is able to form. The reporter's week produced six independent surfaces
 * that each reported success over a failure, including a `pgrep` that matched its own command line
 * and therefore fails in BOTH directions. An instrument that cannot fail is not an instrument.
 *
 * WHAT IS BORROWED RATHER THAN INVENTED. The vocabulary is #1594's responder classifier
 * ({@link ResponderState}), moved here from the CLI so there is ONE of it: bound, unbound, stale,
 * unknown, with `unknown` first class. That module's whole point was that a lease which cannot be
 * read is NOT health, and this surface inherits that property rather than re-deciding it. The CLI's
 * `delivery-responder.ts` now re-exports these, so both surfaces cannot drift apart.
 *
 * WHAT IS NEW: the ASK, and only the ask. A peer cannot read either lease — the manager bucket is
 * denied to agents by omission and must stay that way (see the note on {@link LivenessAnswer}) — so
 * the peer does not read state at all. It sends a presence request and grades THE OUTCOME OF ASKING.
 *
 * WHY THE OUTCOME OF ASKING IS A SOUND LIVENESS SIGNAL, AND WHERE IT STOPS BEING ONE. NATS reports
 * "nobody is subscribed to this subject" (NoResponders, status 503) as a distinct outcome from "I
 * waited and nothing came back" (a timeout). That distinction is the entire instrument:
 *
 *   • a reply            → the responder is bound AND answered, so it grades its own readiness;
 *   • NoResponders (503) → the broker itself says no responder is bound: `unbound`, positively;
 *   • a timeout          → SOMETHING is subscribed but did not answer, or the broker never
 *                          answered us at all. That is `unknown`, never `unbound` and never health.
 *   • a permission error → `unknown`. The peer has learnt about its own credential, not about the
 *                          plane, and converting that into a verdict about the plane is the
 *                          reported bug wearing new clothes.
 *
 * This is why a timeout must not be folded into `unbound` even though both "look like" nothing came
 * back. A 503 is the BROKER's own report about subscription state and is evidence. A timeout is the
 * absence of evidence, and an absence of evidence is exactly what this issue says must stop being
 * rendered as a verdict.
 *
 * SHAPE. This is the Synadia micro protocol's `$SRV.INFO` in intent — a read-only, presence-only,
 * request/reply probe on a well-known subject — but it is deliberately NOT the literal `$SRV` wire
 * protocol. `$SRV` appears nowhere in this repository, and its subjects sit OUTSIDE the
 * `cotal.<space>.>` tree: a surface there would escape per-space account isolation, every existing
 * grant builder, and the subject audit that sweeps a space by prefix. So the probe rides a Cotal
 * rail inside the space ({@link livenessSubject}), carries the micro protocol's semantics, and stays
 * inside the boundaries the rest of the system already enforces.
 */
import type { DeliveryLeaseInfo } from "./lease.js";

/** What is known about a RESPONDER, as opposed to a process. Moved verbatim from the CLI's #1594
 *  classifier so the liveness surface and `cotal status` cannot drift apart.
 *
 *  `unknown` IS A FIRST-CLASS ANSWER AND MUST NOT BE FOLDED INTO `bound`. A read can fail for
 *  reasons that say nothing about the daemon (no target resolved, broker unreachable, a denied read
 *  on a mesh whose creds predate the read grant). Reporting any of those as health is the original
 *  defect in a new place.
 *
 *  `stale` IS ALSO NOT `bound`. A ready record whose holder is not the daemon this workspace
 *  launched is a dead or foreign daemon's leftover, and the mesh it describes cannot spawn, retire
 *  or join. It is kept distinct from `unbound` because the operator's next move differs. */
export type ResponderState = "bound" | "unbound" | "stale" | "unknown";

/** The two planes a peer may ask about. Deliberately a CLOSED set rather than a free string: the
 *  whole complaint is that liveness is unaskable, and the fix must not become a general-purpose
 *  probe rail that grows a third meaning later. `manager` is the lifecycle/control plane (its
 *  control moved to the v0.4 `service` endpoint at 1d); `delivery` is the server-side delivery
 *  daemon that serves `ctl.delivery`. */
export const LIVENESS_PLANES = Object.freeze(["manager", "delivery"] as const);
export type LivenessPlane = (typeof LIVENESS_PLANES)[number];

/** Is `plane` one this surface answers for? A closed-set guard, so an unrecognised plane is refused
 *  rather than answered with a default — a probe that answers every input is the "sweep that gives
 *  the same answer at every input" failure, and it would report health for planes that do not
 *  exist. */
export function isLivenessPlane(plane: string): plane is LivenessPlane {
  return (LIVENESS_PLANES as readonly string[]).includes(plane);
}

/** THE ANSWER, AND EVERYTHING IT IS NOT.
 *
 *  Two fields: whether a responder is bound for the named plane, and an OPAQUE token for which
 *  responder said so. No holder, no pid, no workspace root, no instance id, no runtime, no roster,
 *  no membership — none of which a peer needs in order to learn WHICH PLANE IS BROKEN, and all of
 *  which the issue explicitly says the surface does not need to expose.
 *
 *  THIS IS THE SECURITY BOUNDARY AND IT IS WHY THE PEER DOES NOT SIMPLY READ THE LEASE. The manager
 *  lease row ({@link import("./lease.js").ManagerLeaseInfo}) carries `holder`, `instanceId`,
 *  `runtime`, `root` and `pid` — the operator's workspace path and process id. An agent holds no
 *  grant on that bucket at all, by deliberate omission (`provision.ts`: "an agent must never read,
 *  write, or delete it"), and granting one to make liveness askable would hand every peer the
 *  operator's filesystem layout and a pid to signal. So the row NEVER leaves the responder: the
 *  responder reduces it to one enum and answers with that. Presence is the whole ask, and
 *  presence is the whole answer.
 *
 *  `since`/`uptime` are deliberately absent too, though `$SRV.INFO` would carry them: a timestamp
 *  on the manager's lease dates the operator's last restart, which is state. */
export interface LivenessAnswer {
  /** The plane this answer is about, echoed so a reply cannot be mistaken for another plane's. */
  plane: LivenessPlane;
  /** Whether a responder is bound for that plane, in #1594's vocabulary. */
  responder: ResponderState;
  /** WHICH RESPONDER ANSWERED, as an opaque per-bind token, or `undefined` when no responder
   *  answered at all (a 503, a timeout, a refusal, an unreadable reply).
   *
   *  IT ANSWERS "WAS THIS THE SAME ONE" AND NOTHING ELSE, and that narrowness is the design. Manager
   *  instances coexist per instance id, each answers only about ITSELF, and the queue group hands a
   *  probe to an arbitrary member — so two probes that disagree are, without this field,
   *  indistinguishable from one responder that changed state. Comparing tokens tells those apart.
   *
   *  IT IS NOT AN IDENTITY. The value is minted at bind time from nothing ({@link
   *  import("./endpoint.js").CotalEndpoint.serveLiveness}) and is not the endpoint's principal, the
   *  lease row's `instanceId`, a pid, a host or a path. A peer can tell two responders apart and can
   *  learn nothing else about either, which is the same boundary the rest of this type holds: a
   *  field that named the real instance would have re-opened the lease row the responder exists to
   *  keep off the wire.
   *
   *  ONE PROBE STILL SAMPLES ONE RESPONDER. This field does not aggregate the plane, and a single
   *  answer cannot report a split. It makes a split OBSERVABLE across repeated probes, where before
   *  it was not observable at all. */
  instance?: string;
}

/** Classify a lease record into responder state — #1594's pure classifier, moved here so the CLI
 *  status surfaces and this liveness surface grade by the SAME rule.
 *
 *  `undefined` means the lease key is absent, which on a mesh that HAS a daemon recorded is an
 *  unbound responder rather than a missing opinion: the daemon creates its lease before it binds, so
 *  no lease at all means nothing has even claimed the slot.
 *
 *  `expectedHolder` is not optional information when it is knowable. A daemon that is SIGKILLed
 *  leaves its `ready:true` record in the bucket for the rest of the bucket TTL, so `ready` alone
 *  answers "did SOME daemon bind recently enough that its record has not expired", which is not the
 *  question being asked. When the caller can name the daemon it means, a foreign or dead holder's
 *  record classifies as `stale` rather than as health. When it genuinely cannot know, pass
 *  `undefined` and the holder is not checked. */
export function responderFromLease(
  lease: DeliveryLeaseInfo | undefined,
  expectedHolder?: string,
): ResponderState {
  if (lease === undefined) return "unbound";
  if (lease.ready !== true) return "unbound";
  if (expectedHolder !== undefined && lease.holder !== expectedHolder) return "stale";
  return "bound";
}

/** Read the axis through a caller-supplied lease reader, mapping a FAILED read to `unknown` rather
 *  than to either health state. The reader is injected so offline surfaces (which must not open a
 *  connection) and connected ones share one classification without sharing a transport. */
export async function responderStateFromReader(
  readLease: () => Promise<DeliveryLeaseInfo | undefined>,
  expectedHolder?: string,
): Promise<ResponderState> {
  try {
    return responderFromLease(await readLease(), expectedHolder);
  } catch {
    return "unknown";
  }
}

/** How a peer's probe ENDED, as distinct from what it means. Kept separate from
 *  {@link ResponderState} on purpose: the caller reports what happened on the wire, and this module
 *  owns the single rule that turns that into a verdict, so no call site can invent its own mapping.
 *
 *   • `replied`      — a well-formed answer came back; the responder graded itself.
 *   • `noResponders` — the BROKER reported 503/no-responders: positively nothing is subscribed.
 *   • `timeout`      — we waited and nothing came back. Something may be subscribed and wedged.
 *   • `refused`      — the broker refused us (permissions), or the transport failed. This says
 *                      something about OUR credential or OUR link, and nothing about the plane.
 *   • `malformed`    — a reply arrived that this surface cannot read. */
export type ProbeOutcome = "replied" | "noResponders" | "timeout" | "refused" | "malformed";

/** THE ONE RULE that turns a probe outcome into a responder verdict, and the heart of #1577.
 *
 *  ONLY `noResponders` may become `unbound`, because only it is the broker's own positive report
 *  that no responder is subscribed. `timeout`, `refused` and `malformed` ALL become `unknown`: each
 *  is a failure to find out, and this issue exists because failures to find out were being rendered
 *  as findings. A peer that cannot reach the broker learns that it cannot reach the broker.
 *
 *  `replied` defers to the responder's OWN verdict, which it derived from its lease through
 *  {@link responderFromLease} — so a daemon that has claimed its slot but not bound its loops
 *  answers `unbound` about itself rather than being counted as alive merely because it answered. A
 *  reply carrying no readable verdict is `malformed`, hence `unknown`; it is not silently promoted
 *  to `bound` on the strength of having replied at all. That promotion is precisely the `pgrep`
 *  error — treating evidence that a process exists as evidence that it works. */
export function responderFromProbe(outcome: ProbeOutcome, answered?: ResponderState): ResponderState {
  if (outcome === "replied") return answered ?? "unknown";
  if (outcome === "noResponders") return "unbound";
  return "unknown";
}

/** Read a wire reply into an answer, or `undefined` if it is not one. Strict on purpose: an
 *  unrecognised `responder` value, a plane that does not match the one asked about, or a body of the
 *  wrong shape all return `undefined`, which the caller grades as `malformed` and therefore
 *  `unknown`. A lenient parse here would let a garbled or foreign reply be read as health, and this
 *  is the exact seam where "it said something" becomes "it said it was fine".
 *
 *  `instance` IS STRICT TOO, FOR A DIFFERENT REASON THAN THE OTHER FIELDS. It is not the verdict, so
 *  a bad one cannot say "healthy" — but a caller compares tokens to tell two responders apart, and
 *  a value it cannot compare (a number, an object, an empty string) would silently read as "the same
 *  responder as the other answer that also had no usable token". That is a split rendered as
 *  agreement. A reply naming a responder in a form this surface cannot read is therefore `malformed`
 *  rather than an answer with the field dropped. A reply with NO `instance` at all is still
 *  readable: it is an answer from a responder that predates the field. */
export function parseLivenessAnswer(body: unknown, expectPlane: LivenessPlane): LivenessAnswer | undefined {
  if (typeof body !== "object" || body === null) return undefined;
  const { plane, responder, instance } = body as { plane?: unknown; responder?: unknown; instance?: unknown };
  if (typeof plane !== "string" || !isLivenessPlane(plane) || plane !== expectPlane) return undefined;
  if (responder !== "bound" && responder !== "unbound" && responder !== "stale" && responder !== "unknown") return undefined;
  if (instance !== undefined && (typeof instance !== "string" || instance === "")) return undefined;
  return instance === undefined ? { plane, responder } : { plane, responder, instance };
}

/** The consequence of an unbound responder, in the operator's terms rather than the daemon's — per
 *  plane, because they break different things and the reporter's cost was diagnosis time, not
 *  ignorance that something was wrong. Purely presentational: no state, no identity. */
export function livenessConsequence(plane: LivenessPlane): string {
  return plane === "delivery"
    ? "no spawn, no retirement, no join until it binds"
    : "no spawn, stop, attach or despawn until it binds";
}

/** Render one axis for a human, naming UNKNOWN as unchecked rather than as either health state.
 *  The `unknown` arm is the line this whole issue is about: it must never read as reassurance. */
export function livenessLine(answer: LivenessAnswer): string {
  switch (answer.responder) {
    case "bound":
      return `${answer.plane}: responder bound`;
    case "unbound":
      return `${answer.plane}: RESPONDER NOT BOUND - ${livenessConsequence(answer.plane)}`;
    case "stale":
      return `${answer.plane}: RESPONDER NOT BOUND - a DEAD holder's ready record is still in the lease (it expires on its own) - ${livenessConsequence(answer.plane)}`;
    case "unknown":
      return `${answer.plane}: responder state UNCHECKED - the probe did not complete, so this is not a health report`;
  }
}
