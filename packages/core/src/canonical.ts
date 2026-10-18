/**
 * RFC 8785 canonical JSON and content addressing (SPEC §13.7, D28).
 *
 * Contract identity is the SHA-256 digest of the RFC 8785 canonicalization of a JSON value,
 * over I-JSON: lone surrogates are rejected loudly (never escaped through), because a digest
 * over non-interchangeable text is not an identity. The strict `canonicalizeEx` path is pinned
 * (`undefinedInArrayToNull: false`): an `undefined` anywhere in the value is a programming
 * error, not data, and MUST NOT silently become `null`.
 */
import { createHash } from "node:crypto";
import { DIGEST_PREFIX, canonicalJson, hasLoneSurrogate, isContractDigest, isWellFormedUnicode } from "./canonical-json.js";

export { DIGEST_PREFIX, canonicalJson, isContractDigest, isWellFormedUnicode };

/** Content address of a contract artifact: `sha256:<hex>` over its RFC 8785 form (SPEC §13.7). */
export function contractDigest(value: unknown): string {
  return DIGEST_PREFIX + createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
}

/** `sha256:<hex>` over RAW bytes (a string digests as its UTF-8 encoding), NEVER re-canonicalized:
 *  the digest form for artifacts carried as opaque bytes — the §13.3 `auth` slot (`authDigest`,
 *  digested exactly as carried) and the §13.4 raw stored submission bytes (`submissionDigest`).
 *  A string input MUST be well-formed UTF-16: a lone surrogate has no UTF-8 encoding, the
 *  encoder would substitute U+FFFD, and two DISTINCT carried values would silently share one
 *  digest — the opposite of "exactly as carried". Throws instead. */
export function rawDigest(data: Uint8Array | string): string {
  const h = createHash("sha256");
  if (typeof data === "string") {
    if (hasLoneSurrogate(data)) throw new Error("rawDigest: lone surrogate in string input; no UTF-8 encoding exists, the digest would not be over the carried value");
    h.update(data, "utf8");
  } else {
    h.update(data);
  }
  return DIGEST_PREFIX + h.digest("hex");
}

/** Verify OPAQUE bytes against their advertised `sha256:<hex>` digest, and return them unchanged.
 *
 *  The counterpart to {@link rawDigest}, as {@link verifyArtifact} is to {@link contractDigest} —
 *  and deliberately NOT the same function. `verifyArtifact` parses its input as JSON and
 *  re-canonicalizes it; artifact bytes are opaque (an image, a tarball, a truncated file) and must
 *  never be parsed, both because parsing would reject legitimate content and because a digest over
 *  a re-serialization is not a digest over what was carried.
 *
 *  This runs on every fetch, before any byte reaches a caller. Digest-verify on READ is what
 *  catches the truncation class: a store that hands back a short object is otherwise
 *  indistinguishable from a small one. */
export function verifyRawBytes(bytes: Uint8Array, digest: string): Uint8Array {
  if (!isContractDigest(digest)) throw new Error(`verifyRawBytes: malformed digest ${JSON.stringify(digest)}`);
  const actual = rawDigest(bytes);
  if (actual !== digest) throw new Error(`verifyRawBytes: digest mismatch over ${bytes.byteLength} bytes; advertised ${digest}, content is ${actual}`);
  return bytes;
}

/** Verify fetched artifact BYTES against their advertised digest (verify-on-read, SPEC §13.7):
 *  content addressing, not store ACLs, is the tamper boundary. The bytes must parse as JSON and
 *  re-canonicalize to the digest; anything else throws. Returns the parsed artifact.
 *  For opaque (non-JSON) bytes use {@link verifyRawBytes}. */
export function verifyArtifact(bytes: Uint8Array, digest: string): unknown {
  if (!isContractDigest(digest)) throw new Error(`verifyArtifact: malformed digest ${JSON.stringify(digest)}`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch (e) {
    throw new Error(`verifyArtifact: artifact for ${digest} is not valid UTF-8 JSON: ${(e as Error).message}`);
  }
  const actual = contractDigest(parsed);
  if (actual !== digest) throw new Error(`verifyArtifact: digest mismatch; advertised ${digest}, content is ${actual}`);
  return parsed;
}
