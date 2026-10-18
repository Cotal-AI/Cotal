/**
 * The human consent to tool-result sharing (SPEC §13.6, "Private tool results"): a signed,
 * closed artifact that lets ONE holder read ONE agent incarnation's tool results until `exp`.
 *
 * WHO CAN MINT IT. Only a key registered in the anchor registry with the `consents` role, which
 * a host registers for its authenticated HUMAN route: the host verifies a fresh interactive IdP
 * proof for the target's owner, derives the owner from the verified subject, and signs. An agent
 * holds no such key, so an agent cannot consent for its owner, and a copy of the artifact confers
 * nothing to anyone but the holder it names (presenter equality is checked where it is applied).
 *
 * WHAT IT BINDS. The space (audience), the exact target `(owner, actor, lifecycleUid)`, the holder
 * principal, the scope `tool-results`, the time the host checked the human proof, and a window of
 * at most 24 hours. A successor incarnation is a different target; nothing carries over.
 */
import { randomBytes } from "node:crypto";
import { EpEnvelopeError } from "./endpoint-envelope.js";
import { canonicalJson } from "./canonical.js";
import { parsePrincipalKey, assertValidOwnerToken, assertLifecycleToken } from "./subjects.js";
import {
  assertAnchorScopeCovers,
  assertArtifactCurrency,
  resolveAnchorForUse,
  signArtifact,
  verifyArtifactSignature,
  type AnchorResolver,
} from "./endpoint-signing.js";

export const TOOL_RESULT_CONSENT_SCOPE = "tool-results";
export const TOOL_RESULT_CONSENT_MAX_TTL_MS = 24 * 60 * 60 * 1000;
/** The human proof must be checked at most this long before the host signs. */
export const TOOL_RESULT_CONSENT_PROOF_MAX_AGE_MS = 5 * 60 * 1000;
export const TOOL_RESULT_CONSENT_MAX_BYTES = 4 * 1024;

export interface ToolResultConsentTarget {
  owner: string;
  actor: string;
  lifecycleUid: string;
}

export interface ToolResultConsent {
  v: 1;
  id: string;
  space: string;
  scope: typeof TOOL_RESULT_CONSENT_SCOPE;
  target: ToolResultConsentTarget;
  /** The reading principal `<owner>.<actor>`; its owner is the target's owner. */
  holder: { id: string };
  /** When the host verified the fresh interactive human proof (epoch ms). */
  proofAt: number;
  iat: number;
  exp: number;
  issuer: { keyId: string };
  sig: string;
}

const isRec = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
function invalid(what: string): never {
  throw new EpEnvelopeError("contract-invalid", `${what} (SPEC 13.6 tool-result consent)`);
}
function closed(o: Record<string, unknown>, keys: readonly string[], what: string): void {
  for (const k of Object.keys(o)) if (!keys.includes(k)) invalid(`${what} carries the unknown field "${k}" (closed schema)`);
}
function target(raw: unknown): ToolResultConsentTarget {
  if (!isRec(raw)) invalid("target is not an object");
  closed(raw, ["owner", "actor", "lifecycleUid"], "target");
  if (typeof raw.owner !== "string" || typeof raw.actor !== "string" || raw.actor.length === 0 || raw.actor.length > 64 || typeof raw.lifecycleUid !== "string")
    invalid("target is not { owner, actor, lifecycleUid }");
  return { owner: assertValidOwnerToken(raw.owner), actor: raw.actor, lifecycleUid: assertLifecycleToken(raw.lifecycleUid, "target.lifecycleUid") };
}
function holderFor(raw: unknown, t: ToolResultConsentTarget): { id: string } {
  if (!isRec(raw)) invalid("holder is not an object");
  closed(raw, ["id"], "holder");
  const p = typeof raw.id === "string" ? parsePrincipalKey(raw.id) : null;
  if (!p) invalid("holder.id is not a principal <owner>.<actor>");
  if (p.owner !== t.owner) throw new EpEnvelopeError("permission-denied", "a tool-result consent names a holder outside the target's owner (SPEC 13.6)");
  return { id: raw.id as string };
}
const int = (v: unknown, what: string): number => {
  if (typeof v !== "number" || !Number.isSafeInteger(v) || v < 0) invalid(`${what} is not a non-negative integer`);
  return v;
};

export interface MintToolResultConsentArgs {
  space: string;
  target: ToolResultConsentTarget;
  holder: string;
  /** When the host verified the human's fresh interactive proof. */
  proofAt: number;
  ttlMs: number;
  issuerKeyId: string;
  now?: number;
}

/** Sign a consent. Host-side only, after the host's own IdP verification of the target owner. */
export function mintToolResultConsent(args: MintToolResultConsentArgs, keyPair: { sign(input: Uint8Array): Uint8Array }): ToolResultConsent {
  const now = args.now ?? Date.now();
  if (!Number.isSafeInteger(now)) invalid("now is not an integer");
  if (!Number.isSafeInteger(args.ttlMs) || args.ttlMs <= 0 || args.ttlMs > TOOL_RESULT_CONSENT_MAX_TTL_MS)
    invalid(`ttlMs ${String(args.ttlMs)} is not in (0, ${TOOL_RESULT_CONSENT_MAX_TTL_MS}]`);
  const t = target(args.target);
  const proofAt = int(args.proofAt, "proofAt");
  if (proofAt > now || now - proofAt > TOOL_RESULT_CONSENT_PROOF_MAX_AGE_MS) invalid("the human proof is not fresh");
  const unsigned = {
    v: 1 as const,
    id: randomBytes(18).toString("base64url"),
    space: args.space,
    scope: TOOL_RESULT_CONSENT_SCOPE as typeof TOOL_RESULT_CONSENT_SCOPE,
    target: t,
    holder: holderFor({ id: args.holder }, t),
    proofAt,
    iat: now,
    exp: now + args.ttlMs,
    issuer: { keyId: args.issuerKeyId },
  };
  return signArtifact(unsigned, keyPair);
}

/** Verify a presented consent for `expect` (the serving agent's own incarnation). Fail closed:
 *  closed schema and byte bound, audience, exact target, holder under the target's owner, a fresh
 *  `consents`-role anchor whose scope covers `tool-results`, the signature over the exact artifact,
 *  proof freshness at signing, then currency. */
export async function verifyToolResultConsent(
  raw: unknown,
  opts: { space: string; expect: ToolResultConsentTarget; resolveAnchor: AnchorResolver; now?: number },
): Promise<ToolResultConsent> {
  const now = opts.now ?? Date.now();
  if (!Number.isSafeInteger(now) || now < 0) throw new EpEnvelopeError("failed-precondition", "now must be a non-negative safe integer (SPEC 13.10)");
  if (!isRec(raw)) invalid("a consent is not an object");
  let canonical: string;
  try {
    const { sig: _sig, ...rest } = raw;
    canonical = canonicalJson(rest);
  } catch (e) {
    invalid(`consent does not canonicalize: ${(e as Error)?.message ?? String(e)}`);
  }
  if (Buffer.byteLength(canonical, "utf8") > TOOL_RESULT_CONSENT_MAX_BYTES) invalid(`consent exceeds ${TOOL_RESULT_CONSENT_MAX_BYTES} bytes`);
  closed(raw, ["v", "id", "space", "scope", "target", "holder", "proofAt", "iat", "exp", "issuer", "sig"], "consent");
  if (raw.v !== 1) invalid(`unknown consent version ${String(raw.v)}`);
  if (typeof raw.id !== "string" || !/^[A-Za-z0-9_-]{16,64}$/.test(raw.id)) invalid("id is not a bounded base64url token");
  if (raw.space !== opts.space) throw new EpEnvelopeError("permission-denied", `consent is not for space "${opts.space}" (audience, SPEC 13.6)`);
  if (raw.scope !== TOOL_RESULT_CONSENT_SCOPE) invalid(`scope is not "${TOOL_RESULT_CONSENT_SCOPE}"`);
  const t = target(raw.target);
  if (t.owner !== opts.expect.owner || t.actor !== opts.expect.actor)
    throw new EpEnvelopeError("target-mismatch", "consent names another agent (SPEC 13.6)");
  if (t.lifecycleUid !== opts.expect.lifecycleUid) throw new EpEnvelopeError("expired", "consent names another incarnation (SPEC 13.6)");
  const holder = holderFor(raw.holder, t);
  const proofAt = int(raw.proofAt, "proofAt");
  const iat = int(raw.iat, "iat");
  const exp = int(raw.exp, "exp");
  if (!isRec(raw.issuer)) invalid("issuer is not an object");
  closed(raw.issuer, ["keyId"], "issuer");
  if (typeof raw.issuer.keyId !== "string") invalid("issuer.keyId is not a string");

  const anchor = await resolveAnchorForUse(opts.resolveAnchor, { keyId: raw.issuer.keyId, role: "consents", at: iat });
  assertAnchorScopeCovers(anchor, "consents", TOOL_RESULT_CONSENT_SCOPE, "the consent's scope");
  verifyArtifactSignature(raw, anchor);
  if (proofAt > iat || iat - proofAt > TOOL_RESULT_CONSENT_PROOF_MAX_AGE_MS)
    throw new EpEnvelopeError("permission-denied", "the consent's human proof was not fresh when it was signed (SPEC 13.6)");
  assertArtifactCurrency({ iat, exp }, { now, ceilingMs: TOOL_RESULT_CONSENT_MAX_TTL_MS, what: "tool-result consent", ceilingName: "consent", refusals: "post-signature" });
  return { v: 1, id: raw.id, space: opts.space, scope: TOOL_RESULT_CONSENT_SCOPE, target: t, holder, proofAt, iat, exp, issuer: { keyId: raw.issuer.keyId }, sig: raw.sig as string };
}
