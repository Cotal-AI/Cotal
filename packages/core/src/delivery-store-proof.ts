import { fromPublic } from "@nats-io/nkeys";
import { artifactSignerFromSeed, newArtifactSigner, type ArtifactSigner } from "./identity.js";
import { signatureInput, signArtifact } from "./endpoint-signing.js";
import { parseDaemonStoreAnswer, type DaemonStoreAnswer, type SecretStore } from "./secret-store.js";
import type { DeliveryLeaseInfo } from "./lease.js";

export const DELIVERY_STORE_PROOF_KIND = "delivery-store-proof.seed";

type Signed = Record<string, unknown> & { sig: string };
type ProofLease = DeliveryLeaseInfo & { incarnation: string; proofKey: string; proofAttestation: Signed };

export async function loadOrCreateDeliveryStoreSigner(store: SecretStore, key: string): Promise<ArtifactSigner> {
  let seed = await store.get(key);
  if (seed === undefined) {
    await store.put(key, newArtifactSigner().seed);
    seed = await store.get(key);
  }
  if (seed === undefined) throw new Error(`delivery store proof seed ${key} remained absent after creation`);
  try { return artifactSignerFromSeed(seed); }
  catch (e) { throw new Error(`delivery store proof seed ${key} is unreadable: ${(e as Error).message}`); }
}

export async function loadDeliveryStoreSigner(store: SecretStore, key: string): Promise<ArtifactSigner | undefined> {
  const seed = await store.get(key);
  if (seed === undefined) return undefined;
  try { return artifactSignerFromSeed(seed); }
  catch (e) { throw new Error(`delivery store proof seed ${key} is unreadable: ${(e as Error).message}`); }
}

export function attestDeliveryProcess(
  space: string, holder: string, incarnation: string, proofKey: string, signer: ArtifactSigner,
): Signed {
  return signArtifact({ kind: "delivery-process-key", space, holder, incarnation, proofKey }, signer);
}

function verifies(raw: Record<string, unknown>, publicKey: string): boolean {
  if (typeof raw.sig !== "string" || !/^[A-Za-z0-9_-]{86}$/.test(raw.sig)) return false;
  try { return fromPublic(publicKey).verify(signatureInput(raw), Buffer.from(raw.sig, "base64url")); }
  catch { return false; }
}

export function assertCertifiedProofLease(
  lease: DeliveryLeaseInfo | undefined, space: string, storePublicKey: string,
): asserts lease is ProofLease {
  if (!lease || !lease.ready || !lease.holder || !lease.incarnation || !lease.proofKey ||
      !lease.proofAttestation || typeof lease.proofAttestation !== "object" || Array.isArray(lease.proofAttestation))
    throw new Error("delivery store proof requires a ready lease with a certified process key; upgrade the delivery daemon before classifying its store");
  const a = lease.proofAttestation as Record<string, unknown>;
  const fields = ["kind", "space", "holder", "incarnation", "proofKey", "sig"];
  if (Object.keys(a).some(k => !fields.includes(k)) || fields.some(k => !(k in a)) ||
      a.kind !== "delivery-process-key" || a.space !== space || a.holder !== lease.holder ||
      a.incarnation !== lease.incarnation || a.proofKey !== lease.proofKey || !verifies(a, storePublicKey))
    throw new Error("delivery lease process key is not certified by this manager's reload store; nothing reminted");
}

export function signDeliveryStoreAnswer(
  answer: DaemonStoreAnswer, space: string, caller: string, challenge: unknown,
  incarnation: string, key: ArtifactSigner,
): Signed {
  if (typeof challenge !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(challenge))
    throw new Error("delivery store proof requires a UUID challenge");
  return signArtifact({ kind: "delivery-store-proof", space, caller, challenge, incarnation,
    answer: parseDaemonStoreAnswer(answer) }, key);
}

export function parseDeliveryStoreProof(raw: unknown): { envelope: Record<string, unknown>; answer: DaemonStoreAnswer } {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("delivery store proof is missing");
  const p = raw as Record<string, unknown>;
  const fields = ["kind", "space", "caller", "challenge", "incarnation", "answer", "sig"];
  if (Object.keys(p).some(k => !fields.includes(k)) || fields.some(k => !(k in p)) || p.kind !== "delivery-store-proof")
    throw new Error("delivery store proof has an unreadable shape");
  return { envelope: p, answer: parseDaemonStoreAnswer(p.answer) };
}

export function verifyDeliveryStoreProof(
  raw: unknown, space: string, caller: string, challenge: string, lease: ProofLease,
): DaemonStoreAnswer {
  const { envelope: p, answer } = parseDeliveryStoreProof(raw);
  if (p.space !== space || p.caller !== caller || p.challenge !== challenge || p.incarnation !== lease.incarnation)
    throw new Error("delivery store proof does not match the request and lease incarnation");
  if (!answer.holdsDeliveryLease || answer.responder !== lease.holder)
    throw new Error("delivery store proof does not name the certified lease holder; nothing reminted");
  if (!verifies(p, lease.proofKey))
    throw new Error("delivery store proof signature does not verify against the certified process key");
  return answer;
}
