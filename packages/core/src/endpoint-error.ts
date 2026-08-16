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
 * `details[].kind` for a `failed-precondition` raised because a responder ANSWERED but was not the
 * incarnation this handle resolved against (§13.2). It marks the one fact a caller cannot recover
 * from the code alone: **the request drew an attributed reply from a live responder**. That reply
 * may be a refusal (validation, authorization, admission, business) or a result; the marker does
 * not say which, and it does not prove the command executed or that any effect landed. What it
 * rules out is the reading "the incarnation is gone, resolve again": a retry here is a SECOND
 * ATTEMPT that may duplicate an effect, so an automatic re-invoke must not take it as a repair.
 */
export const EP_UNBOUND_RESPONDER = "ai.cotal.ep.unbound-responder";

/** True iff `e` carries the {@link EP_UNBOUND_RESPONDER} marker — i.e. a responder handled the
 *  request, so retrying it is a SECOND execution, not a repair. */
export function respondedButUnbound(e: unknown): boolean {
  return e instanceof EpEnvelopeError && (e.details ?? []).some((d) => d.kind === EP_UNBOUND_RESPONDER);
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
