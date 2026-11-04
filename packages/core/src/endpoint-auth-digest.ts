import { rawDigest, isWellFormedUnicode } from "./canonical.js";
import { EpEnvelopeError } from "./endpoint-error.js";

/** `authDigest`: `sha256:<hex>` over the UTF-8 bytes of the `auth` slot EXACTLY as carried. The
 *  slot is already a canonical signed artifact, so it is digested as bytes, never
 *  re-canonicalized; absent from the §13.4 fingerprint iff `auth` is absent. A malformed-UTF-16
 *  slot is refused (`bad-request`): a lone surrogate has no UTF-8 encoding, so its "digest"
 *  would be over a substituted value and two distinct slots could share one fingerprint. */
export function authDigest(auth: string): string {
  if (typeof auth !== "string" || !isWellFormedUnicode(auth))
    throw new EpEnvelopeError("bad-request", "auth slot is not a well-formed Unicode string");
  return rawDigest(auth);
}
