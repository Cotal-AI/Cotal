import { PermissionViolationError } from "@nats-io/nats-core";

/** True when a failure is a NATS *permission denial* — the subject is forbidden to this
 *  endpoint's creds — rather than a missing responder or a timeout. The two need opposite
 *  fixes (grant the capability vs. start/await the service), so callers (e.g. a control
 *  request that can't reach the manager) must tell them apart instead of defaulting to
 *  "service down". Unwraps a wrapped `cause` and falls back to the server's error text, since
 *  a denied publish can surface either as the typed error or inside a request rejection. */
export function isPermissionDenied(e: unknown): boolean {
  if (e instanceof PermissionViolationError) return true;
  if ((e as { cause?: unknown } | null)?.cause instanceof PermissionViolationError) return true;
  return /permissions?\s+violation/i.test(String((e as { message?: unknown } | null)?.message ?? ""));
}
