/**
 * Owner-token derivation — the server-side step that turns an authenticated IdP subject into the
 * opaque, per-space `owner` the wire grammar carries (see `assertDerivedOwnerToken` in core for
 * the format contract this emits).
 *
 * Properties, by construction:
 *  - **Opaque / non-PII**: a keyed HMAC of the IdP subject — the token reveals nothing about the
 *    subject (email, name, global id) without the per-space secret, so it is safe in subjects,
 *    JetStream metadata, logs, and history filters.
 *  - **Per-space**: the secret is per-space, so the same human gets unlinkable owners across
 *    spaces.
 *  - **Deterministic**: same (secret, subject) → same owner, so re-login re-lands in the same
 *    lanes with no mapping table.
 *  - **nkey-disjoint**: the emitted format (`u_` + lowercase base32) can never be an nkey — the
 *    flip's acceptance criterion 2, asserted on every return value.
 */
import { createHmac } from "node:crypto";
import { assertDerivedOwnerToken, DERIVED_OWNER_PREFIX } from "@cotal-ai/core";

/** Domain-separation context — versioned so a future derivation change cannot silently collide
 *  with v1 tokens. Changing this re-keys every owner in the space; treat it as a migration. */
const DERIVATION_CONTEXT = "cotal-owner-v1";

/** Minimum secret size. 32 bytes = the HMAC-SHA256 block-security sweet spot; anything shorter
 *  is a config mistake (a guessable secret makes owners linkable/reversible offline). */
const MIN_SECRET_BYTES = 32;

const BASE32_LOWER = "abcdefghijklmnopqrstuvwxyz234567";

/** RFC 4648 base32 (lowercased, unpadded) — 16 bytes → 26 chars, matching the format contract. */
function base32LowerNoPad(bytes: Uint8Array): string {
  let out = "";
  let bits = 0;
  let acc = 0;
  for (const b of bytes) {
    acc = (acc << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += BASE32_LOWER[(acc >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32_LOWER[(acc << (5 - bits)) & 31];
  return out;
}

/** Derive the opaque per-space owner token for an authenticated IdP subject.
 *
 *  `spaceSecret` is the space's owner-derivation secret (≥32 bytes, operator-held, never on the
 *  wire); `externalSubject` is the IdP-authenticated stable subject (e.g. Better Auth `sub`) —
 *  ALREADY VERIFIED by the caller (this function derives, it does not authenticate). Truncation
 *  to 128 bits keeps the token subject-sized while leaving collision odds negligible for any
 *  realistic owner population (birthday bound 2^64). Fails loud on weak/empty inputs. */
export function deriveOwnerToken(spaceSecret: string | Uint8Array, externalSubject: string): string {
  const secret = typeof spaceSecret === "string" ? new TextEncoder().encode(spaceSecret) : spaceSecret;
  if (secret.byteLength < MIN_SECRET_BYTES)
    throw new Error(
      `deriveOwnerToken: spaceSecret must be at least ${MIN_SECRET_BYTES} bytes (got ${secret.byteLength}) — ` +
        `a short secret makes owner tokens offline-reversible/linkable`,
    );
  if (!externalSubject) throw new Error("deriveOwnerToken: externalSubject must be a non-empty IdP subject");
  const mac = createHmac("sha256", secret).update(`${DERIVATION_CONTEXT}:${externalSubject}`).digest();
  return assertDerivedOwnerToken(DERIVED_OWNER_PREFIX + base32LowerNoPad(mac.subarray(0, 16)));
}
