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
 * this handle resolved against (§13.2): `failed-precondition` when a DIFFERENT instance answered,
 * `expired` when the SAME instance answered at a different EPOCH (a same-root restart, or a
 * superseded incarnation still connected). It marks the one fact a caller cannot recover
 * from the code alone: **the request drew an attributed reply from a live responder**. That reply
 * may be a refusal (validation, authorization, admission, business) or a result; the marker does
 * not say which, and it does not prove the command executed or that any effect landed. What it
 * rules out is the reading "the incarnation is gone, resolve again": a retry here is a SECOND
 * ATTEMPT that may duplicate an effect, so an automatic re-invoke must not take it as a repair.
 */
export const EP_UNBOUND_RESPONDER = "ai.cotal.ep.unbound-responder";

/** The {@link EP_UNBOUND_RESPONDER} payload. Two producers set it. The describe-bound currency check
 *  (a DIFFERENT instance answered) sets `answeredBy` and `boundTo`, and they differ. The stale-epoch
 *  refusal (the SAME instance answered at another epoch) sets `answeredEpoch` and `heldEpoch`, and
 *  says in `reference` what `heldEpoch` is: `bind`, the epoch this caller's own resolve bound (a
 *  responder ahead of it is a successor and the handle is the stale side), or `registry`, a currency
 *  read of the responder's current registered epoch (nothing of the caller's is stale; a responder
 *  behind it is a superseded incarnation still answering). `boundTo` is set only where a bind exists. */
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
 * `details[].kind` for a refusal raised because the request drew NO REPLY AT ALL: the broker
 * reported no responder on the subject, or the reply deadline elapsed with nothing attributed to
 * the request. It marks the one fact a consumer cannot recover from the code alone: **nothing
 * answered**. The same codes are also raised where something did answer or where the failure is a
 * read on the caller's own side (a responder's `ok:false` describe reply is rethrown under its own
 * code, `unavailable` included; a store or registry read fails after the describe was answered), so
 * `unavailable` or `deadline-exceeded` on its own is not evidence of silence. Only the producers
 * that observed the silence set this marker; a consumer that states a reachability verdict keys on
 * it, never on the code.
 */
export const EP_UNANSWERED = "ai.cotal.ep.unanswered";

/** The {@link EP_UNANSWERED} payload: the call that drew no reply. */
export interface EpUnansweredDetail extends EpErrorDetail {
  kind: typeof EP_UNANSWERED;
  endpoint: string;
  command: string;
}

/** True iff `e` carries the {@link EP_UNANSWERED} marker: the request drew no reply at all (no
 *  responder, or the deadline elapsed unanswered). */
export function unansweredRequest(e: unknown): boolean {
  return e instanceof EpEnvelopeError && (e.details ?? []).some((d) => d.kind === EP_UNANSWERED);
}

/**
 * `details[].kind` for a refusal raised because a read of the SERVICE REGISTRY that the verb
 * performs on the caller's side did not settle within its bound or failed: the scatter's freeze
 * (§13.5, the expected set) or its mandatory registration reconcile. It marks that the failure is
 * the caller's own registry read, not the responders: nothing about them is established (the
 * freeze fails before any request goes out; the reconcile fails after the gather, so members may
 * all have answered and their replies could not be classified). A consumer must not read it as
 * their silence.
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

/** The `EndpointReply.error` shape. */
export interface EpError {
  code: string;
  message: string;
  details?: EpErrorDetail[];
}

/** A consuming-boundary rejection: the catalog code plus a human message. Boundaries convert it
 *  to an `EndpointReply` error via {@link EpEnvelopeError.toEpError} (or, on reply-less planes,
 *  to the §13.4 decision/quarantine fact carrying the same code). */
export class EpEnvelopeError extends Error {
  constructor(readonly code: EpErrorCode, message: string, readonly details?: EpErrorDetail[]) {
    super(message);
    this.name = "EpEnvelopeError";
  }
  toEpError(): EpError {
    return { code: this.code, message: this.message, ...(this.details ? { details: this.details } : {}) };
  }
}
