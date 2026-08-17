/**
 * The §13.3 endpoint ERROR primitives, split out NODE-FREE (P2 item 6): the catalog codes + the
 * {@link EpEnvelopeError} a consuming boundary throws. The §13.6 session rail + terminal-frame codec
 * need ONLY these, and they run in the browser console bundle — so the error must not drag in the
 * envelope's schema/digest machinery (endpoint-envelope → schema-profile computes a digest at module
 * load, i.e. `node:crypto`). `endpoint-envelope.ts` re-exports everything here, so no consumer's
 * import path changes; the browser-safe modules (rail + codec) import EpEnvelopeError from HERE.
 */

/** The §13.3 error catalog. Extensions add codes only under reverse-DNS; any code (catalog or
 *  extension) is one token of at most 64 bytes. */
export const EP_ERROR_CODES = Object.freeze([
  "bad-request", "unsupported-version", "op-mismatch", "class-mismatch", "target-mismatch",
  "sender-mismatch", "unauthenticated", "permission-denied", "not-found", "already-exists",
  "conflict", "contract-mismatch", "contract-invalid", "failed-precondition",
  "deadline-exceeded", "cancelled", "expired", "unavailable", "unimplemented",
  "resource-exhausted", "internal",
] as const);
export type EpErrorCode = (typeof EP_ERROR_CODES)[number];

/** One `details[]` entry: `kind` is reverse-DNS-namespaced (§13.3), the rest is open. */
export interface EpErrorDetail {
  kind: string;
  [key: string]: unknown;
}

/**
 * `details[].kind` for a refusal raised because a responder ANSWERED but was not the incarnation
 * this handle resolved against (§13.2): `failed-precondition` for a DIFFERENT instance, `expired`
 * for the SAME instance at another EPOCH. It marks what the code alone cannot say — **the request
 * drew an attributed reply from a live responder** — which rules out the reading "the incarnation
 * is gone, resolve again". The reply may be a refusal or a result and the marker does not say
 * which, so a retry here is a SECOND ATTEMPT that may duplicate an effect, never a repair.
 */
export const EP_UNBOUND_RESPONDER = "ai.cotal.ep.unbound-responder";

/** The {@link EP_UNBOUND_RESPONDER} payload. Two producers: the describe-bound currency check (a
 *  DIFFERENT instance) sets `answeredBy`/`boundTo`; the stale-epoch refusal (the SAME instance at
 *  another epoch) sets `answeredEpoch`/`heldEpoch` and says in `reference` which epoch `heldEpoch`
 *  is — `bind`, this caller's own resolve (so the handle is the stale side), or `registry`, the
 *  responder's current registered epoch (so a responder behind it is superseded and still
 *  answering). `boundTo` is set only where a bind exists. */
export interface EpUnboundResponderDetail extends EpErrorDetail {
  kind: typeof EP_UNBOUND_RESPONDER;
  endpoint: string;
  command: string;
  /** The instance whose attributed reply was refused. */
  answeredBy: string;
  /** The instance this handle resolved against; absent when the caller holds no bind. */
  boundTo?: string;
  answeredEpoch?: number;
  heldEpoch?: number;
  reference?: "bind" | "registry";
  /** Whether the call addressed one instance (`inst` rail) rather than the class queue. */
  pinned: boolean;
}

/** True iff `e` carries the {@link EP_UNBOUND_RESPONDER} marker: a responder ANSWERED the request
 *  (an attributed reply, which may be a refusal or a result), so retrying it is a second attempt
 *  that may duplicate an effect, not a repair. */
export function respondedButUnbound(e: unknown): boolean {
  return e instanceof EpEnvelopeError && (e.details ?? []).some((d) => d.kind === EP_UNBOUND_RESPONDER);
}

/**
 * `details[].kind` for a refusal raised because NO VALID REPLY REACHED THE CALLER: no responder on
 * the subject, or the deadline elapsed with nothing attributed to the request's nonce. A frame that
 * fails the request binding is dropped and is not an answer, so the marker means nothing
 * ATTRIBUTABLE arrived, not that no bytes did. `unavailable`/`deadline-exceeded` alone is not
 * evidence of silence — the same codes are raised where something did answer, or where a
 * caller-side read failed after the describe — so a consumer stating a reachability verdict keys on
 * this marker, never on the code.
 */
export const EP_UNANSWERED = "ai.cotal.ep.unanswered";

/** The {@link EP_UNANSWERED} payload: the call that drew no reply. */
export interface EpUnansweredDetail extends EpErrorDetail {
  kind: typeof EP_UNANSWERED;
  endpoint: string;
  command: string;
}

/** True iff `e` carries the {@link EP_UNANSWERED} marker: no valid reply reached the caller (no
 *  responder, or the deadline elapsed with nothing attributed to the request). */
export function unansweredRequest(e: unknown): boolean {
  return e instanceof EpEnvelopeError && (e.details ?? []).some((d) => d.kind === EP_UNANSWERED);
}

/**
 * `details[].kind` for a refusal raised because a caller-side read of the SERVICE REGISTRY failed
 * or did not settle: the scatter's freeze (§13.5) or its mandatory reconcile. It marks the failure
 * as the caller's own, establishing NOTHING about the responders — the freeze fails before any
 * request goes out, and the reconcile fails after the gather, where members may all have answered
 * and their replies simply could not be classified. A consumer must not read it as their silence.
 */
export const EP_REGISTRY_READ_FAILED = "ai.cotal.ep.registry-read-failed";

/** The {@link EP_REGISTRY_READ_FAILED} payload: the call whose registry read failed. */
export interface EpRegistryReadFailedDetail extends EpErrorDetail {
  kind: typeof EP_REGISTRY_READ_FAILED;
  endpoint: string;
  command: string;
}

/** True iff `e` carries the {@link EP_REGISTRY_READ_FAILED} marker: a caller-side registry read
 *  failed; the responders were not the failure. */
export function registryReadFailed(e: unknown): boolean {
  return e instanceof EpEnvelopeError && (e.details ?? []).some((d) => d.kind === EP_REGISTRY_READ_FAILED);
}

/**
 * `details[].kind` for a refusal raised by the RESPONDER because the request declared a bound
 * incarnation (`bind`, §13.3) that is not this instance: `failed-precondition` for a different
 * instance, `expired` for the same instance at another epoch. It marks what no caller-side check
 * can establish: **the command did not run, and no effect of it exists.**
 *
 * Set before the handler, before args validation, and before any seam that can consume a one-use
 * proof, by the only party that knows which incarnation it is. {@link EP_UNBOUND_RESPONDER} is
 * raised by the CALLER on the reply, after the responder has already acted — a report, not a
 * guard. So a caller holding THIS marker may re-resolve and re-issue without risking a duplicate,
 * which is exactly what a caller holding that one must not do.
 */
export const EP_BIND_REFUSED = "ai.cotal.ep.bind-refused";

/** The {@link EP_BIND_REFUSED} payload: the incarnation the caller bound, and the one that
 *  refused. Both ids are stated because either field alone can be the mismatching one — a
 *  different instance, or the same instance at any other epoch — and the reader needs to see
 *  which. */
export interface EpBindRefusedDetail extends EpErrorDetail {
  kind: typeof EP_BIND_REFUSED;
  endpoint: string;
  command: string;
  /** What the request's `bind` block declared. */
  boundTo: { instanceId: string; epoch: number };
  /** The refusing instance's own identity. */
  servedBy: { instanceId: string; epoch: number };
}

/** True iff an `EpError` carries the {@link EP_BIND_REFUSED} marker: a responder refused BEFORE
 *  executing, because it is not the incarnation the caller bound — the command did not run.
 *
 *  It takes an `EpError` and not a thrown value, unlike its sibling predicates, because this
 *  refusal never arrives as a throw: it is the responder's own application-level failure and
 *  those ride the reply (§13.5). A consumer reads it off `reply.error`.
 *
 *  A REPLY THAT CONTRADICTS ITSELF IS NOT A REFUSAL. The marker IS the assertion that the command
 *  did not run, and {@link EpError.outcome} says a responder refusing before dispatch MUST carry
 *  `not-executed` — but {@link EpBindRefusedDetail} carries no outcome of its own, so nothing in the
 *  type stops a reply pairing the marker with `executed`. That combination is not merely odd: the
 *  only consumer of this predicate re-issues a command **without** the {@link isRepeatSafeCommand}
 *  gate, on the strength of the marker, so resolving the contradiction toward "refused" re-sends a
 *  command the reply just said had ALREADY RUN. A present outcome that disagrees therefore wins, and
 *  the reply is not read as a refusal.
 *
 *  AN ABSENT OUTCOME IS NOT A REFUSAL EITHER, and it is the same answer as `unknown` because the
 *  spec says they are the same value: SPEC 1510, "an error reply that omits `outcome` MUST be read
 *  as `unknown`". An earlier revision accepted absence, on the argument that a responder too old to
 *  know the field emits exactly that and refusing it would stop core repairing splits for a third
 *  party that is otherwise behaving. That argument does not survive SPEC 2271: a client MUST NOT
 *  automatically re-issue a command declared `write` after any outcome that does not prove
 *  non-execution, whatever `id` the re-issue carries, and `unknown` proves nothing. Since this
 *  predicate is what licenses a re-issue that SKIPS {@link isRepeatSafeCommand}, accepting absence
 *  made core re-issue writes on an outcome the spec says is `unknown`.
 *
 *  The cost is real and it is bounded: a responder that omits the field no longer has its splits
 *  repaired. That responder is already non-conforming, because §13.3 requires a refusal raised
 *  before dispatch to carry `not-executed`, so what it loses is a repair it was never owed. This
 *  endpoint's own responder sets the field, so conforming deployments are unaffected. */
export function replyRefusedBeforeEffect(e: EpError | undefined): boolean {
  if (!(e?.details ?? []).some((d) => d.kind === EP_BIND_REFUSED)) return false;
  return e?.outcome === "not-executed";
}

/** §13.3 **Effect outcome**: whether the command's effect occurred. Emitted by the RESPONDER,
 *  which is the only party that knows. An omitted `outcome` MUST be read as `unknown`, so absence
 *  is never evidence of non-execution. */
export type EpEffectOutcome = "executed" | "not-executed" | "unknown";

/** The `EndpointReply.error` shape. */
export interface EpError {
  code: string;
  message: string;
  details?: EpErrorDetail[];
  /** §13.3. A responder refusing BEFORE dispatching to the handler MUST carry `not-executed`;
   *  one refusing AFTER the handler ran MUST carry `executed`; one that cannot tell MUST carry
   *  `unknown` rather than guess. Absent on a caller-raised refusal, which is not a reply. */
  outcome?: EpEffectOutcome;
}

/** A consuming-boundary rejection: the catalog code plus a human message. Boundaries convert it
 *  to an `EndpointReply` error via {@link EpEnvelopeError.toEpError} (or, on reply-less planes,
 *  to the §13.4 decision/quarantine fact carrying the same code). */
export class EpEnvelopeError extends Error {
  constructor(readonly code: EpErrorCode, message: string, readonly details?: EpErrorDetail[],
              readonly outcome?: EpEffectOutcome) {
    super(message);
    this.name = "EpEnvelopeError";
  }
  toEpError(): EpError {
    return {
      code: this.code, message: this.message,
      ...(this.details ? { details: this.details } : {}),
      ...(this.outcome ? { outcome: this.outcome } : {}),
    };
  }
}
