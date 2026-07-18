/**
 * v0.4 signed-artifact encoding and trust anchors (SPEC §13.10, D18/D28) — the ONE signature
 * encoding every signed §13 artifact uses (trait definitions/attachments now; capability
 * handles, checkpoint resumes, session grants, receipts as their slices land), plus the
 * anchor-registry verification seam those verifiers resolve keys through.
 *
 * Encoding (§13.10, normative): the signature input is the UTF-8 bytes of the RFC 8785
 * canonical JSON of the artifact WITH ITS `sig` FIELD ABSENT; the signature is Ed25519
 * (nkeys); `sig` carries it base64url-encoded, unpadded. Verification recomputes the
 * canonical form, resolves the signing key FRESH in the anchor registry, and fails closed
 * on any mismatch — unknown key, out-of-window use, role mismatch, scope violation,
 * revocation, or a signature that does not verify.
 *
 * The anchor REGISTRY itself (the `signer.<keyId>` §13.7 record family, its mediated
 * writers, rotation tooling) is D18 scope; this module owns the artifact-side contract:
 * the resolver SEAM a verifier reads through and the fail-closed enforcement of what a
 * resolved anchor authorizes.
 */
import { fromPublic } from "@nats-io/nkeys";
import { canonicalJson } from "./canonical.js";
import { EpEnvelopeError, type EpErrorCode } from "./endpoint-envelope.js";

/**
 * The §13.6/§13.10 validity-window currency rules for a timed signed artifact, in ONE place —
 * handle links and session grants both call this (SPEC 1778: session expiry follows the handle
 * rules), so a rule added or tightened later lands in every verifier by construction instead of
 * hand-copied blocks drifting apart:
 *
 *   1. `exp > iat` (an empty/backward window never verifies)
 *   2. `nbf ≤ exp` (a window that opens after it closes never verifies)
 *   3. the validity SPAN is measured from `min(iat, nbf)` and must fit the ceiling (an early
 *      `nbf` or forward-dated `iat` cannot manufacture a longer window)
 *   4. no FUTURE `iat` (a forward-dated artifact never verifies, §13.10)
 *   5. `nbf ≤ now ≤ exp` (the window itself)
 *   6. `exp ≤ now + ceiling` (clock-anchored: a dated-in-the-future artifact cannot outlive
 *      its ceiling even when its own span is in-bounds)
 *
 * `refusals` picks the refusal-code policy by WHERE the caller runs the check: "opaque" for a
 * verifier that checks currency BEFORE the signature (handle links — every refusal is
 * `permission-denied`, so a forged artifact learns nothing from the code), "post-signature"
 * for one that checks after identity is established (session grants — structural violations
 * are `contract-invalid`, an early presentation `failed-precondition`, a stale one `expired`).
 */
export function assertArtifactCurrency(
  t: { iat: number; nbf?: number; exp: number },
  a: { now: number; ceilingMs: number; what: string; ceilingName: string; refusals: "opaque" | "post-signature" },
): void {
  // The CLOCK AUTHORITY itself is validated before any rule runs: every check below is a pure
  // numeric comparison, and a NaN/fractional/negative `now` makes each one silently false — a
  // verifier whose clock is invalid must refuse, never accept (fail closed on the caller seam,
  // the same entry rule verifyHandleChain pins on its own `opts.now`).
  if (!Number.isSafeInteger(a.now) || a.now < 0)
    throw new EpEnvelopeError("failed-precondition", `${a.what}: the currency clock now=${JSON.stringify(a.now)} is not a non-negative safe integer; an invalid clock authority never verifies (SPEC 13.10)`);
  if (!Number.isSafeInteger(a.ceilingMs) || a.ceilingMs <= 0)
    throw new EpEnvelopeError("internal", `${a.what}: the ${a.ceilingName} ceiling ${JSON.stringify(a.ceilingMs)} is not a positive integer`);
  const soft = (code: EpErrorCode): EpErrorCode => (a.refusals === "opaque" ? "permission-denied" : code);
  const nbf = t.nbf ?? t.iat;
  if (t.exp <= t.iat)
    throw new EpEnvelopeError(soft("contract-invalid"), `${a.what} exp ${t.exp} is not after iat ${t.iat}; an empty/backward window never verifies (SPEC 13.6)`);
  if (nbf > t.exp)
    throw new EpEnvelopeError(soft("contract-invalid"), `${a.what} nbf ${nbf} is past its exp ${t.exp}; a window that opens after it closes never verifies (SPEC 13.6)`);
  if (t.exp - Math.min(t.iat, nbf) > a.ceilingMs)
    throw new EpEnvelopeError(soft("contract-invalid"), `${a.what} validity span ${t.exp - Math.min(t.iat, nbf)}ms exceeds the ${a.ceilingName} ceiling ${a.ceilingMs}ms (SPEC 13.6)`);
  if (t.iat > a.now)
    throw new EpEnvelopeError("permission-denied", `${a.what} claims a FUTURE signing time (iat ${t.iat} > now ${a.now}); a forward-dated artifact never verifies (SPEC 13.10)`);
  if (a.now < nbf)
    throw new EpEnvelopeError(soft("failed-precondition"), `${a.what} is not yet valid (nbf ${nbf}, now ${a.now}) (SPEC 13.6)`);
  if (a.now > t.exp)
    throw new EpEnvelopeError(soft("expired"), `${a.what} expired at ${t.exp} (now ${a.now}) (SPEC 13.6)`);
  if (t.exp > a.now + a.ceilingMs)
    throw new EpEnvelopeError("permission-denied", `${a.what} remains valid ${t.exp - a.now}ms past now, beyond the clock-anchored ${a.ceilingName} ceiling ${a.ceilingMs}ms; a dated-in-the-future artifact cannot outlive its ceiling (SPEC 13.6)`);
}

/** The §13.10 anchor roles: which artifact family a registered key may sign. */
export const ANCHOR_ROLES = Object.freeze([
  "handles", "traits", "receipts", "resume", "sessions", "authz-slots", "obligations", "payments",
] as const);
export type AnchorRole = (typeof ANCHOR_ROLES)[number];

/** One resolved `signer.<keyId>` anchor (§13.10), as the registry projection a verifier
 *  consumes: the record's spec fields plus the status-side revocation. `scope` is the
 *  per-role structured ceiling; a role listed in `roles` whose scope dimension is ABSENT is
 *  CLOSED, not open (§13.10: "a key without a dimension ceiling has that dimension closed").
 *  For the `traits` role the entries are reverse-DNS DOMAIN prefixes the key may define and
 *  attest traits under (third-party authorities register under their domain claim; the
 *  space-operator key carries `ai.cotal`). */
export interface SignerAnchor {
  keyId: string;
  /** nkeys-encoded Ed25519 public key the artifact signature verifies against. */
  publicKey: string;
  /** The principal or reverse-DNS domain the key belongs to. */
  owner: string;
  /** The LIFECYCLE UID of the owning principal (§13.1: a principal is `(id, lifecycleUid)`,
   *  so the record identifies its key's principal fully). Absent for a domain-owned key.
   *  REQUIRED wherever a verifier must bind the key to a specific lifecycle (a child handle's
   *  issuer, §13.6) — there, an absent binding FAILS CLOSED: owner text alone would let a
   *  recycled alias re-register a key and issue off its predecessor's artifacts. */
  ownerLifecycleUid?: string;
  roles: readonly AnchorRole[];
  scope?: Partial<Record<AnchorRole, readonly string[]>>;
  /** Validity window, ms epoch, both inclusive. Rotation registers a successor and closes
   *  this window; overlap is permitted for handoff. */
  validFrom: number;
  validTo: number;
  /** Status-side revocation: immediate for NEW verifications (effected work is not
   *  retroactively unwound). */
  revoked?: boolean;
}

/** The fresh-resolution seam (§13.10: "a verifier resolves the artifact's keyId FRESH at
 *  verification"): production reads the space's `signer.<keyId>` record; a test supplies a
 *  faithful map. `undefined` = unknown key (fail closed). Trust roots never merge across
 *  spaces — the resolver IS the space binding. */
export type AnchorResolver = (keyId: string) => Promise<SignerAnchor | undefined> | SignerAnchor | undefined;

const isRec = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
const B64URL = /^[A-Za-z0-9_-]{86}$/; // unpadded base64url of a 64-byte Ed25519 signature

/** The D28 signature INPUT: UTF-8 bytes of the artifact's RFC 8785 canonical JSON with `sig`
 *  absent. The strict canonical path throws on non-interchangeable values (lone surrogates,
 *  undefined, non-finite numbers) — an artifact that cannot canonicalize cannot sign. */
export function signatureInput(artifact: Record<string, unknown>): Uint8Array {
  const { sig: _sig, ...rest } = artifact;
  return new TextEncoder().encode(canonicalJson(rest));
}

/** Sign an artifact (D28): returns the artifact WITH its base64url unpadded `sig`. The
 *  key pair is any nkeys KeyPair (the seed side); the matching public key is what the
 *  anchor registry carries. */
export function signArtifact<T extends Record<string, unknown>>(
  artifact: T,
  keyPair: { sign(input: Uint8Array): Uint8Array },
): T & { sig: string } {
  if ("sig" in artifact && artifact.sig !== undefined)
    throw new Error("signArtifact: the artifact already carries a sig; signing is over the sig-absent form (SPEC 13.10)");
  const sig = Buffer.from(keyPair.sign(signatureInput(artifact))).toString("base64url");
  return { ...artifact, sig };
}

/** Verify an artifact's D28 signature against a RESOLVED anchor's public key. Fails closed
 *  (`permission-denied`): malformed/absent `sig`, a public key nkeys cannot parse, or a
 *  signature that does not verify over the recomputed canonical form. Shape/binding checks
 *  belong to the artifact's own verifier — this is exactly the signature step. */
export function verifyArtifactSignature(artifact: Record<string, unknown>, anchor: SignerAnchor): void {
  const sig = artifact.sig;
  if (typeof sig !== "string" || !B64URL.test(sig))
    throw new EpEnvelopeError("permission-denied", "artifact sig is not an unpadded base64url Ed25519 signature (SPEC 13.10)");
  let ok: boolean;
  try {
    ok = fromPublic(anchor.publicKey).verify(signatureInput(artifact), Buffer.from(sig, "base64url"));
  } catch (e) {
    throw new EpEnvelopeError("permission-denied", `artifact signature does not verify against anchor ${anchor.keyId}: ${(e as Error).message} (SPEC 13.10: fail closed)`);
  }
  if (!ok)
    throw new EpEnvelopeError("permission-denied", `artifact signature does not verify against anchor ${anchor.keyId}'s registered key (SPEC 13.10: forged or tampered artifacts fail loud)`);
}

/** Parse an untrusted resolver result at this consuming boundary: the anchor a verifier
 *  enforces MUST be a well-formed registry projection — a garbled record (NaN window, unknown
 *  role, non-string key) fails loud, never weakens into an open ceiling. */
function assertAnchorShape(a: unknown, keyId: string): SignerAnchor {
  const bad = (what: string): never => {
    throw new EpEnvelopeError("failed-precondition", `resolved anchor for ${keyId} is garbled (${what}); an unreadable anchor record never authorizes (SPEC 13.10)`);
  };
  if (!isRec(a)) bad("not an object");
  const o = a as Record<string, unknown>;
  if (o.keyId !== keyId) bad(`keyId ${JSON.stringify(o.keyId)} is not the resolved ${keyId}`);
  if (typeof o.publicKey !== "string" || o.publicKey.length === 0) bad("publicKey is not a string");
  if (typeof o.owner !== "string" || o.owner.length === 0) bad("owner is not a string");
  if (o.ownerLifecycleUid !== undefined && (typeof o.ownerLifecycleUid !== "string" || o.ownerLifecycleUid.length === 0)) bad("ownerLifecycleUid is not a string");
  if (!Array.isArray(o.roles) || !o.roles.every((r) => (ANCHOR_ROLES as readonly string[]).includes(r as string))) bad("roles is not an array of anchor roles");
  if (o.scope !== undefined) {
    if (!isRec(o.scope)) bad("scope is not an object");
    for (const [role, entries] of Object.entries(o.scope as Record<string, unknown>)) {
      if (!(ANCHOR_ROLES as readonly string[]).includes(role)) bad(`scope names unknown role "${role}"`);
      if (!Array.isArray(entries) || !entries.every((e) => typeof e === "string" && e.length > 0)) bad(`scope.${role} is not a string array`);
    }
  }
  if (typeof o.validFrom !== "number" || !Number.isSafeInteger(o.validFrom)) bad("validFrom is not an integer");
  if (typeof o.validTo !== "number" || !Number.isSafeInteger(o.validTo)) bad("validTo is not an integer");
  if (o.revoked !== undefined && typeof o.revoked !== "boolean") bad("revoked is not a boolean");
  return o as unknown as SignerAnchor;
}

/**
 * Resolve an anchor FRESH for one use and enforce the §13.10 gate (fail closed): unknown key,
 * revocation (immediate for new verifications), role mismatch, and window are all refusals.
 * `at` is the artifact's own signing time where it carries one (an attachment's `ts`), or the
 * verification time for timeless artifacts (a content-addressed definition): the WINDOW binds
 * the signing act; revocation binds the verification. Scope is enforced separately by the
 * artifact's verifier ({@link assertAnchorScopeCovers}) against its own dimension.
 */
export async function resolveAnchorForUse(
  resolve: AnchorResolver,
  use: { keyId: string; role: AnchorRole; at: number },
): Promise<SignerAnchor> {
  if (typeof use.keyId !== "string" || use.keyId.length === 0)
    throw new EpEnvelopeError("permission-denied", "artifact names no signing keyId; an unattributable signature never verifies (SPEC 13.10)");
  let raw: SignerAnchor | undefined;
  try {
    raw = await resolve(use.keyId);
  } catch (e) {
    throw new EpEnvelopeError("unavailable", `the anchor-registry read failed for ${use.keyId}; verification fails closed, never open (SPEC 13.10): ${(e as Error)?.message ?? String(e)}`);
  }
  if (raw === undefined)
    throw new EpEnvelopeError("permission-denied", `signing key ${use.keyId} is not in the anchor registry; unknown keys fail closed (SPEC 13.10)`);
  const anchor = assertAnchorShape(raw, use.keyId);
  if (anchor.revoked === true)
    throw new EpEnvelopeError("permission-denied", `signing key ${use.keyId} is revoked; revocation is immediate for new verifications (SPEC 13.10)`);
  if (!anchor.roles.includes(use.role))
    throw new EpEnvelopeError("permission-denied", `signing key ${use.keyId} does not carry the "${use.role}" role; a key signs only its registered artifact families (SPEC 13.10)`);
  if (!Number.isSafeInteger(use.at))
    throw new EpEnvelopeError("failed-precondition", `anchor use time ${String(use.at)} is not an integer; a garbled timestamp cannot pass a validity window (SPEC 13.10)`);
  if (use.at < anchor.validFrom || use.at > anchor.validTo)
    throw new EpEnvelopeError("permission-denied", `signing key ${use.keyId} is outside its validity window at ${use.at} (window ${anchor.validFrom}..${anchor.validTo}); out-of-window use fails closed (SPEC 13.10)`);
  return anchor;
}

/** Enforce a role's scope ceiling on one subject under dot-prefix containment: an entry
 *  covers `subject` iff it equals it or is a strict dot-prefix (`ai.cotal` covers
 *  `ai.cotal.guarded`). An ABSENT scope dimension for the role is CLOSED, not open
 *  (§13.10) — a key with the role but no ceiling entries authorizes nothing. */
export function assertAnchorScopeCovers(anchor: SignerAnchor, role: AnchorRole, subject: string, what: string): void {
  const entries = anchor.scope?.[role];
  if (entries === undefined || entries.length === 0)
    throw new EpEnvelopeError("permission-denied", `signing key ${anchor.keyId} carries the "${role}" role with no scope ceiling; an absent dimension is closed, not open, so it cannot sign ${what} (SPEC 13.10)`);
  const covered = entries.some((e) => subject === e || subject.startsWith(`${e}.`));
  if (!covered)
    throw new EpEnvelopeError("permission-denied", `signing key ${anchor.keyId}'s "${role}" scope [${entries.join(", ")}] does not cover ${what} "${subject}" (SPEC 13.10/13.6: containment, never widening)`);
}
