/**
 * The stock service endpoint renewal source behind `AuthProvider.serviceEndpointRenewal`: the bearer
 * function one registered service witness passes to a long-lived endpoint (`EndpointOptions.bearer`).
 *
 * Request identity follows the service authority rule (docs/embedding.md, "Service authority
 * contracts"): one requestId per operation and witness, persisted with the witness's renewal material
 * in the caller's store before the first send, and replayed with the same body on every later pull,
 * restarts included. The first pull activates (the signed-in IdP proof); every later pull renews on
 * the stored renewal proof. A replay re-checks the gate and mints from now, so the same renew request
 * keeps producing fresh material for as long as the root and the approval allow.
 * When the stored renewal proof has expired, the source replays the same persisted activate request
 * on the signed-in login instead: the door's activate replay mints again while the root and the
 * approval stand, and takes no new request slot.
 *
 * It owns no timer: the endpoint calls it ahead of each expiry and on reconnect. Concurrent pulls share
 * one request. A transport failure, a rate limit, a missing or rejected sign-in, or a store failure is
 * an outage the next pull retries with the same request; any other door denial ends the source for
 * good. Tokens leave only through `bearer()`; state and errors carry fixed text and expiries.
 */
import { randomBytes } from "node:crypto";
import {
  ServiceAuthorityTransportError, serviceWitnessDigest,
  type AuthProvider, type SecretStore, type ServiceAuthorityRequest, type ServiceAuthorityResult, type ServiceEndpointRenewal,
  type ServiceEndpointRenewalState, type ServiceRegistrationWitness,
} from "@cotal-ai/core";
import { spaceSegment } from "@cotal-ai/workspace";

const KIND = "service-endpoint-renewal";

interface Material { accessBearer: string; accessExpiresAt: number; renewalProof: string; renewalExpiresAt: number }
interface RenewalRecord { v: 1; kind: typeof KIND; witnessDigest: string; activateRequestId: string; renewRequestId: string; material: Material | null }

/** Where one witness's renewal record lives in the caller's store. */
export function serviceRenewalKey(witness: ServiceRegistrationWitness): string {
  return `auth/${spaceSegment(witness.space)}/service-renewal/${serviceWitnessDigest(witness).slice("sha256:".length)}.json`;
}

/** Denials that do not end the source: the next pull replays the same request. */
const TRANSIENT = new Set(["rate-limited"]);
/** Denial codes reported by name (each ends the source). Any other is reported as `unrecognized`, so no remote text escapes. */
const KNOWN = new Set(["expired", "approval-revoked", "root-revoked", "stale-witness", "permission-denied", "unauthenticated", "proof-mismatch",
  "unsupported", "conflict", "resource-exhausted", "registration-pending", "bad-request", "registration-active", "approval-mismatch", "not-found"]);

const hex32 = /^[0-9a-f]{32}$/;
const nowS = () => Math.floor(Date.now() / 1000);

const UNREADABLE = "the service renewal record is not well formed; restore it or remove it deliberately";

function parseRecord(raw: string, witnessDigest: string): RenewalRecord {
  let o: Record<string, unknown>;
  try { o = JSON.parse(raw) as Record<string, unknown>; } catch { throw new Error(UNREADABLE); }
  if (o === null || typeof o !== "object" || Array.isArray(o)) throw new Error(UNREADABLE);
  const m = o.material as Record<string, unknown> | null | undefined;
  const ok = o.v === 1 && o.kind === KIND && o.witnessDigest === witnessDigest && typeof o.activateRequestId === "string" && hex32.test(o.activateRequestId)
    && typeof o.renewRequestId === "string" && hex32.test(o.renewRequestId)
    && (m === null || (m !== undefined && typeof m.accessBearer === "string" && typeof m.renewalProof === "string"
      && Number.isSafeInteger(m.accessExpiresAt) && Number.isSafeInteger(m.renewalExpiresAt)));
  if (!ok) throw new Error(UNREADABLE);
  return o as unknown as RenewalRecord;
}

/** Build the renewal source for one witness over the provider's own authority client. */
export function serviceEndpointRenewal(provider: AuthProvider, opts: { store: SecretStore; dir: string; witness: ServiceRegistrationWitness }): ServiceEndpointRenewal {
  const { store, dir, witness } = opts;
  if (!provider.serviceEndpointAuthority) throw new Error("this auth provider does not host service endpoints");
  const authority = provider.serviceEndpointAuthority.bind(provider);
  const witnessDigest = serviceWitnessDigest(witness), key = serviceRenewalKey(witness);
  let state: ServiceEndpointRenewalState = { state: "idle" };
  let sentinelCreds: string | undefined;
  let inflight: Promise<string> | undefined;
  let closed = false;
  const abort = new AbortController();

  /** The stored record, or a new one created before any request is sent. */
  async function record(): Promise<RenewalRecord> {
    const stored = await store.get(key);
    if (stored !== undefined) return parseRecord(stored, witnessDigest);
    const fresh: RenewalRecord = { v: 1, kind: KIND, witnessDigest, activateRequestId: randomBytes(16).toString("hex"),
      renewRequestId: randomBytes(16).toString("hex"), material: null };
    if (await store.create(key, JSON.stringify(fresh))) return fresh;
    const winner = await store.get(key);
    if (winner === undefined) throw new Error("the service renewal record could not be created or read");
    return parseRecord(winner, witnessDigest);
  }

  const end = (reason: string): never => {
    state = { state: "ended", reason };
    throw new Error(`service renewal ended (${reason}); nothing more will be requested for this registration`);
  };
  const outage = (sentence: string): never => {
    state = { state: "unavailable" };
    throw new Error(sentence);
  };

  /** The stored record, with any store or parse failure reported as fixed text. */
  async function readRecord(): Promise<RenewalRecord> {
    try { return await record(); } catch (e) {
      return outage(e instanceof Error && e.message === UNREADABLE ? `${UNREADABLE}; nothing was sent` : "service renewal could not read its record from the store; nothing was sent");
    }
  }

  async function pull(): Promise<string> {
    const rec = await readRecord();
    const m = rec.material;
    // No material, or a renewal proof past its expiry: replay the persisted activate on the signed-in login.
    const renewing = m !== null && m.renewalExpiresAt > nowS();
    const operation = renewing ? "renew" : "activate";
    const request = { v: 1, kind: "service-endpoint-authority", operation, requestId: renewing ? rec.renewRequestId : rec.activateRequestId,
      space: witness.space, accountPublicKey: witness.accountPublicKey, endpoint: witness.endpoint, instanceId: witness.instanceId, witness } as ServiceAuthorityRequest;
    let answer: { result: ServiceAuthorityResult; sentinelCreds: string };
    try {
      answer = await authority({ store, dir, request, signal: abort.signal, ...(renewing ? { proof: { kind: "service-renewal", token: m.renewalProof } } : {}) });
    } catch (e) {
      if (closed) throw new Error("service renewal is closed");
      if (e instanceof ServiceAuthorityTransportError) outage(`service renewal is unavailable (${operation} not confirmed); the next pull replays the same request`);
      // A missing session (`signed-out`) or the IdP refusing the cached one (stock fetchIdpJwt's 401 sentence).
      if (!renewing && ((e as { code?: unknown }).code === "signed-out" || /rejected the cached session/.test((e as Error).message ?? "")))
        outage("service renewal needs this machine's sign-in to reactivate; sign in again, and the next pull replays the same request");
      outage(`service renewal could not send its ${operation} request; the next pull retries it`);
    }
    const r = answer!.result;
    if (r.state === "denied") {
      if (TRANSIENT.has(r.reason)) outage(`service renewal is unavailable (${r.reason}); the next pull replays the same request`);
      end(KNOWN.has(r.reason) ? r.reason : "unrecognized");
    }
    if (r.state !== "credential") end("unrecognized");
    const c = r as Extract<ServiceAuthorityResult, { state: "credential" }>;
    if (c.accessExpiresAt <= nowS()) outage("service renewal received an access bearer that has already expired; the next pull replays the same request");
    const material: Material = { accessBearer: c.accessBearer, accessExpiresAt: c.accessExpiresAt, renewalProof: c.renewalProof, renewalExpiresAt: c.renewalExpiresAt };
    try { await store.put(key, JSON.stringify({ ...rec, material } satisfies RenewalRecord)); }
    catch { outage("service renewal could not store its new material; the next pull replays the same request"); }
    sentinelCreds = answer!.sentinelCreds;
    state = { state: "current", accessExpiresAt: material.accessExpiresAt, renewalExpiresAt: material.renewalExpiresAt };
    return material.accessBearer;
  }

  return {
    bearer() {
      if (closed) return Promise.reject(new Error("service renewal is closed"));
      if (state.state === "ended") return Promise.reject(new Error(`service renewal ended (${state.reason}); nothing more will be requested for this registration`));
      inflight ??= pull().finally(() => { inflight = undefined; });
      return inflight;
    },
    state: () => state,
    get sentinelCreds() { return sentinelCreds; },
    async close() {
      if (closed) return;
      closed = true;
      abort.abort();
      await inflight?.catch(() => {});
      if (state.state !== "ended") state = { state: "closed" };
    },
  };
}
