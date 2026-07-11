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
import { canonicalizeEx } from "json-canonicalize";

/** Digest identity form used everywhere a contract artifact is referenced: `sha256:<hex>`. */
export const DIGEST_PREFIX = "sha256:" as const;
const DIGEST_RE = /^sha256:[0-9a-f]{64}$/;

/** True iff `s` is a well-formed `sha256:<hex>` artifact digest. */
export function isContractDigest(s: string): boolean {
  return DIGEST_RE.test(s);
}

/** True iff the string contains an unpaired UTF-16 surrogate (not well-formed / I-JSON
 *  violation). Manual scan: the repo's TS lib target predates `String#isWellFormed`. */
function hasLoneSurrogate(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      const n = s.charCodeAt(i + 1);
      if (!(n >= 0xdc00 && n <= 0xdfff)) return true;
      i++; // well-formed pair; skip the low half
    } else if (c >= 0xdc00 && c <= 0xdfff) {
      return true; // low surrogate with no preceding high half
    }
  }
  return false;
}

/** Walk a JSON value and throw on any string that is not well-formed UTF-16 (lone
 *  surrogates violate I-JSON; canonicalizing them would mint a digest for text that cannot
 *  interchange). Also rejects `undefined` in arrays/objects and non-finite numbers, which
 *  RFC 8785 cannot represent. */
function assertInterchangeable(v: unknown, path: string): void {
  if (v === null) return;
  switch (typeof v) {
    case "string":
      if (hasLoneSurrogate(v)) throw new Error(`canonicalJson: lone surrogate in string at ${path} (I-JSON violation)`);
      return;
    case "number":
      if (!Number.isFinite(v)) throw new Error(`canonicalJson: non-finite number at ${path}`);
      return;
    case "boolean":
      return;
    case "undefined":
      throw new Error(`canonicalJson: undefined at ${path} (strict mode never coerces to null)`);
    case "object": {
      if (Array.isArray(v)) {
        v.forEach((e, i) => assertInterchangeable(e, `${path}[${i}]`));
        return;
      }
      for (const [k, e] of Object.entries(v as Record<string, unknown>)) {
        if (hasLoneSurrogate(k)) throw new Error(`canonicalJson: lone surrogate in key at ${path}.${k}`);
        assertInterchangeable(e, `${path}.${k}`);
      }
      return;
    }
    default:
      throw new Error(`canonicalJson: unsupported ${typeof v} at ${path}`);
  }
}

/** RFC 8785 canonical JSON text of a value (strict: I-JSON enforced, no undefined→null). */
export function canonicalJson(value: unknown): string {
  assertInterchangeable(value, "$");
  return canonicalizeEx(value, { undefinedInArrayToNull: false });
}

/** Content address of a contract artifact: `sha256:<hex>` over its RFC 8785 form (SPEC §13.7). */
export function contractDigest(value: unknown): string {
  return DIGEST_PREFIX + createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
}

/** `sha256:<hex>` over RAW bytes (a string digests as its UTF-8 encoding), NEVER re-canonicalized:
 *  the digest form for artifacts carried as opaque bytes — the §13.3 `auth` slot (`authDigest`,
 *  digested exactly as carried) and the §13.4 raw stored submission bytes (`submissionDigest`). */
export function rawDigest(data: Uint8Array | string): string {
  const h = createHash("sha256");
  if (typeof data === "string") h.update(data, "utf8");
  else h.update(data);
  return DIGEST_PREFIX + h.digest("hex");
}

/** Verify fetched artifact BYTES against their advertised digest (verify-on-read, SPEC §13.7):
 *  content addressing, not store ACLs, is the tamper boundary. The bytes must parse as JSON and
 *  re-canonicalize to the digest; anything else throws. Returns the parsed artifact. */
export function verifyArtifact(bytes: Uint8Array, digest: string): unknown {
  if (!isContractDigest(digest)) throw new Error(`verifyArtifact: malformed digest ${JSON.stringify(digest)}`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch (e) {
    throw new Error(`verifyArtifact: artifact for ${digest} is not valid UTF-8 JSON: ${(e as Error).message}`);
  }
  const actual = contractDigest(parsed);
  if (actual !== digest) throw new Error(`verifyArtifact: digest mismatch — advertised ${digest}, content is ${actual}`);
  return parsed;
}
