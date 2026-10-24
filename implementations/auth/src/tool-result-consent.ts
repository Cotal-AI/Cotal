import { fromSeed } from "@nats-io/nkeys";
import { EpEnvelopeError, assertDerivedOwnerToken, assertLifecycleToken, assertValidOwnerToken, canonicalJson, isCasLoss,
  parseToolResultConsent, resolveToolResultConsentAnchor, signArtifact, verifyArtifactSignature, TOOL_RESULT_CONSENT_MAX_TTL_MS,
  type AnchorResolver, type SecretStore, type ToolResultConsent } from "@cotal-ai/core";
import type { KV } from "@nats-io/kv";
import { spaceSegment } from "@cotal-ai/workspace";
import { deriveOwnerForIdpSubject } from "./derive.js";
import { verifyToolResultHumanProof, type IdpConfig } from "./idp.js";
import { findInteractiveActor, findManagedActor } from "./ledger.js";

/** Provisioned by the trusted host. The seed is read only inside the auth process. */
export const toolResultConsentKey = (space: string): string => `auth/${spaceSegment(space)}/tool-result-consent-key.json`;
export interface ToolResultConsentInput {
  id: string;
  idpToken: string;
  subject: string;
  accountPublicKey: string;
  holder: { actor: string; lifecycleUid: string };
  target: { owner: string; actor: string; lifecycleUid: string };
  ttlMs: number;
}
export interface ToolResultConsentSignerOptions {
  keyId: string;
  /** Fresh account-local anchor resolution, injected only by the trusted composition. */
  resolveAnchor: AnchorResolver;
}
export type ToolResultConsentRecorder = (consent: ToolResultConsent) => Promise<void>;
function fail(code: "bad-request" | "permission-denied" | "unavailable", message: string): never {
  throw new EpEnvelopeError(code, message, undefined, "not-executed");
}
const rec = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
const exact = (v: unknown, keys: string[]): v is Record<string, unknown> => rec(v) && Object.keys(v).length === keys.length && keys.every(k => Object.hasOwn(v, k));

/** Closed host envelope. Owner, scope and timestamps cannot be supplied for the holder. */
export function parseToolResultConsentInput(raw: unknown): ToolResultConsentInput {
  if (!exact(raw, ["id", "idpToken", "subject", "accountPublicKey", "holder", "target", "ttlMs"]) ||
      !exact(raw.holder, ["actor", "lifecycleUid"]) || !exact(raw.target, ["owner", "actor", "lifecycleUid"]) ||
      typeof raw.id !== "string" || !/^[A-Za-z0-9_-]{1,200}$/.test(raw.id) ||
      typeof raw.idpToken !== "string" || !raw.idpToken || raw.idpToken.length > 16_384 ||
      typeof raw.subject !== "string" || !raw.subject || raw.subject.length > 512 ||
      typeof raw.accountPublicKey !== "string" || typeof raw.ttlMs !== "number" || !Number.isSafeInteger(raw.ttlMs) || raw.ttlMs <= 0 || raw.ttlMs > TOOL_RESULT_CONSENT_MAX_TTL_MS)
    fail("bad-request", "invalid closed tool-result consent request");
  try {
    assertDerivedOwnerToken(raw.target.owner as string);
    assertValidOwnerToken(raw.target.actor as string); assertValidOwnerToken(raw.holder.actor as string);
    assertLifecycleToken(raw.target.lifecycleUid as string); assertLifecycleToken(raw.holder.lifecycleUid as string);
  } catch { fail("bad-request", "invalid consent principal or lifecycle"); }
  return JSON.parse(canonicalJson(raw)) as ToolResultConsentInput;
}

/** Native atomic create, without a retry or a success classification after a lost acknowledgement. */
export function makeToolResultConsentRecorder(kv: Pick<KV, "put">, fence: () => void, space: string): ToolResultConsentRecorder {
  return async consent => {
    parseToolResultConsent(consent);
    if (consent.space !== space) fail("permission-denied", "consent record belongs to another space");
    fence();
    try { await kv.put(`consent.${consent.id}`, new TextEncoder().encode(JSON.stringify(consent)), { previousSeq: 0 }); }
    catch (error) {
      if (isCasLoss(error)) throw new EpEnvelopeError("conflict", "consent id is already recorded", undefined, "not-executed");
      throw new EpEnvelopeError("unavailable", "consent persistence outcome is unknown; no automatic retry", undefined, "unknown");
    }
    try { fence(); }
    catch { throw new EpEnvelopeError("unavailable", "consent recorded but authority fenced before release", undefined, "unknown"); }
  };
}

/** Sign and record within the host process. Nothing returns until the create-only write succeeds. */
export function createToolResultConsentSigner(deps: {
  space: string; accountPublicKey: string; dir: string; store: SecretStore; idp: IdpConfig;
  ownerSecret: string | Uint8Array; signer: ToolResultConsentSignerOptions; record: ToolResultConsentRecorder; now?: () => number;
}): (raw: unknown) => Promise<ToolResultConsent> {
  return async raw => {
    const input = parseToolResultConsentInput(raw);
    if (input.accountPublicKey !== deps.accountPublicKey) fail("permission-denied", "consent account mismatch");
    let proof: Awaited<ReturnType<typeof verifyToolResultHumanProof>>;
    try { proof = await verifyToolResultHumanProof(input.idpToken, deps.idp, deps.now); }
    catch { fail("permission-denied", "fresh signed password proof required"); }
    const owner = deriveOwnerForIdpSubject(deps.ownerSecret, deps.idp.issuer, proof.sub);
    const current = () => {
      const now = (deps.now ?? Date.now)();
      if (!Number.isSafeInteger(now) || now < 0 || now < proof.authTime * 1000 || now - proof.authTime * 1000 > 300_000 || now >= proof.exp * 1000)
        fail("permission-denied", "fresh signed password proof required");
      if (proof.sub !== input.subject || input.target.owner !== owner || input.target.actor === input.holder.actor)
        fail("permission-denied", "consent requires the same verified owner and an interactive holder");
      const holder = findInteractiveActor(deps.dir, owner, input.holder.actor);
      const target = findManagedActor(deps.dir, owner, input.target.actor);
      if (!holder || holder.lifecycleUid !== input.holder.lifecycleUid || !target || target.lifecycleUid !== input.target.lifecycleUid)
        fail("permission-denied", "consent holder or managed target lifecycle is not current");
      return now;
    };
    current();
    let stored: unknown;
    try { const value = await deps.store.get(toolResultConsentKey(deps.space)); stored = value === undefined ? undefined : JSON.parse(value); }
    catch { fail("unavailable", "consent signing material unavailable"); }
    if (!exact(stored, ["ver", "keyId", "seed"]) || stored.ver !== 1 || stored.keyId !== deps.signer.keyId || typeof stored.seed !== "string")
      fail("unavailable", "consent signing material unavailable");
    const now = current();
    const anchor = await resolveToolResultConsentAnchor(deps.signer.resolveAnchor, deps.signer.keyId, now);
    let signed: ToolResultConsent;
    try {
      const key = fromSeed(new TextEncoder().encode(stored.seed));
      try {
        if (key.getPublicKey() !== anchor.publicKey) fail("unavailable", "consent signing key does not match its anchor");
        const iat = current();
        if (iat < anchor.validFrom || iat > anchor.validTo) fail("permission-denied", "consent anchor is no longer current");
        signed = parseToolResultConsent(signArtifact({ v: 1, kind: "tool-result-consent", id: input.id, space: deps.space,
          target: input.target, holder: { owner, actor: input.holder.actor }, iat, exp: iat + input.ttlMs, issuer: { keyId: deps.signer.keyId } }, key));
        verifyArtifactSignature(signed as unknown as Record<string, unknown>, anchor);
      } finally { key.clear(); }
    } catch (error) {
      if (error instanceof EpEnvelopeError) throw error;
      fail("unavailable", "consent signing failed");
    }
    current();
    await deps.record(signed);
    try {
      current();
      const releasedAnchor = await resolveToolResultConsentAnchor(deps.signer.resolveAnchor, deps.signer.keyId, signed.iat);
      verifyArtifactSignature(signed as unknown as Record<string, unknown>, releasedAnchor);
      current();
      if ((deps.now ?? Date.now)() >= signed.exp) throw new Error("expired before release");
    } catch { throw new EpEnvelopeError("unavailable", "consent recorded but release authority changed", undefined, "unknown"); }
    return signed;
  };
}
