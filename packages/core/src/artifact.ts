/**
 * The `artifact` reference part and the object-store digest boundary (SPEC §5).
 *
 * An artifact is bytes that do not fit in a message. The message carries a REFERENCE — identity
 * and size, never a location — so the backing store can change without touching a single message
 * shape. Resolution is the reader's job.
 *
 * THE PART IS A CLAIM, NOT A FACT. `name`, `mediaType`, and `size` are whatever the publisher
 * wrote. Only `digest` is self-verifying, because the bytes either hash to it or they do not. A
 * receiver that preallocates from the part's `size`, or trusts its `mediaType` to decide how to
 * handle the bytes, has taken a hostile publisher's word for it; the store's commit-time metadata
 * is the one that was checked.
 *
 * This module deliberately holds the store boundary and NOT the digest primitives: `rawDigest` /
 * `verifyRawBytes` live in `canonical.ts`, which knows nothing about any store and must stay that
 * way.
 */
import { DIGEST_PREFIX, isContractDigest } from "./canonical.js";

/** The core part kind. Bare (not reverse-DNS) because this is Cotal's own reserved primitive, not
 *  a wrapped external vocabulary — SPEC §5's reserved slot, now defined. */
export const ARTIFACT_PART_KIND = "artifact" as const;

/**
 * The object-store digest header form, MEASURED rather than assumed (nats-server 2.14.4,
 * `@nats-io/obj` 3.4.0): `SHA-256=` followed by the **base64url alphabet WITH `=` padding** —
 * e.g. `SHA-256=vSqOx0BLVInPlO4PJ1RvMKaI4Y5g1Uhfr-Jthge1elc=`. Over 200 blobs, `-` and `_`
 * appeared and `+` and `/` never did.
 *
 * That form is neither of the two things Node's `createHash(...).digest()` produces, which is the
 * whole reason this function exists. See {@link fromObjectStoreDigest}.
 */
const OS_DIGEST_PREFIX = "SHA-256=";

/** 32 bytes of SHA-256 is 43 significant base64 characters plus one optional `=` pad. The
 *  alphabet is deliberately BOTH spellings (`-_` and `+/`): they decode to the same bytes, so
 *  accepting both is correct parsing of an unambiguous superset, not a fallback. Anything else —
 *  wrong length, stray character, no prefix — is refused loudly. */
const OS_DIGEST_BODY_RE = /^[A-Za-z0-9_-]{43}=?$|^[A-Za-z0-9+/]{43}=?$/;

/**
 * Convert an object-store digest header to Cotal's `sha256:<hex>` identity form.
 *
 * CONVERT BY DECODING. NEVER BY RE-ENCODING. The obvious implementation — hash the bytes, encode
 * the hash, compare the strings — is wrong, and wrong in a way that passes its first test:
 * measured over 2000 digests, re-encoding to standard base64 mismatches **1490 of 2000** (every
 * digest whose bytes land on `+` or `/`), and re-encoding to base64url mismatches **2000 of 2000**
 * (Node strips the padding the store emits). Decoding to hex matched 2000 of 2000. The failure is
 * in the digest CONTENT, not on a branch a smoke would naturally reach, so a re-encoding
 * comparison looks correct until roughly three quarters of real artifacts fail to verify.
 *
 * The base64 form never escapes this function: everything above it speaks `sha256:<hex>`.
 */
export function fromObjectStoreDigest(osDigest: string): string {
  if (typeof osDigest !== "string" || !osDigest.startsWith(OS_DIGEST_PREFIX))
    throw new Error(`fromObjectStoreDigest: expected a ${JSON.stringify(OS_DIGEST_PREFIX)}-prefixed digest, got ${JSON.stringify(osDigest)}`);
  const body = osDigest.slice(OS_DIGEST_PREFIX.length);
  // Validate BEFORE decoding: Node's base64 decoder silently skips characters it does not
  // recognize, so garbage can decode to a plausible 32 bytes. The shape check is what makes the
  // length assertion below meaningful rather than decorative.
  if (!OS_DIGEST_BODY_RE.test(body))
    throw new Error(`fromObjectStoreDigest: ${JSON.stringify(osDigest)} is not 32 bytes of base64 SHA-256 (expected 43 characters plus optional padding)`);
  const bytes = Buffer.from(body, "base64url");
  if (bytes.length !== 32)
    throw new Error(`fromObjectStoreDigest: ${JSON.stringify(osDigest)} decoded to ${bytes.length} bytes, not 32`);
  return DIGEST_PREFIX + bytes.toString("hex");
}

/**
 * A reference to bytes in the space's artifact store (SPEC §5).
 *
 * There is deliberately no location field. The digest IS the identity: content-addressed, so a
 * re-put of identical bytes is idempotent, and resolution can move from a JetStream Object Store
 * to anything else without a message-shape change.
 */
export interface ArtifactPart {
  kind: typeof ARTIFACT_PART_KIND;
  /** Human name, e.g. `coverage-report.html`. A publisher's claim (see the module doc). */
  name: string;
  /** MIME type. A publisher's claim. */
  mediaType: string;
  /** `sha256:<hex>` over the RAW bytes — the artifact's identity. Self-verifying. */
  digest: string;
  /** Size in bytes. A publisher's claim: never preallocate from it. */
  size: number;
}

/**
 * Structural guard for an `artifact` part.
 *
 * It validates the digest FORM, not just the field's type, because a malformed digest is not a
 * reference to anything — it is a lookup that can only ever fail, and admitting it here would push
 * the refusal to a fetch that reads as "missing artifact" instead of "malformed message". Same
 * reason `size` must be a non-negative safe integer: `-1`, `NaN`, and `1e30` are all "a number".
 */
export function isArtifactPart(value: unknown): value is ArtifactPart {
  if (!value || typeof value !== "object") return false;
  const p = value as Record<string, unknown>;
  return p.kind === ARTIFACT_PART_KIND &&
    typeof p.name === "string" && p.name.length > 0 &&
    typeof p.mediaType === "string" && p.mediaType.length > 0 &&
    typeof p.digest === "string" && isContractDigest(p.digest) &&
    typeof p.size === "number" && Number.isSafeInteger(p.size) && p.size >= 0;
}
