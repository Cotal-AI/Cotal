import assert from "node:assert/strict";
import { newArtifactSigner } from "../src/identity.js";
import {
  assertCertifiedProofLease,
  attestDeliveryProcess,
  loadDeliveryStoreSigner,
  loadOrCreateDeliveryStoreSigner,
  parseDeliveryStoreProof,
  signDeliveryStoreAnswer,
  verifyDeliveryStoreProof,
} from "../src/delivery-store-proof.js";
import type { SecretStore } from "../src/secret-store.js";

class MemoryStore implements SecretStore {
  readonly values = new Map<string, string>();
  async get(key: string) { return this.values.get(key); }
  async put(key: string, value: string) { this.values.set(key, value); }
  async delete(key: string) { this.values.delete(key); }
}
const store = new MemoryStore();
const storeSigner = await loadOrCreateDeliveryStoreSigner(store, "proof.seed");
assert.equal((await loadDeliveryStoreSigner(store, "proof.seed"))?.publicKey, storeSigner.publicKey);
const processSigner = newArtifactSigner();
const challenge = "5bd695bd-f5d1-4ecb-925a-b07182e96609";
const answer = { identity: { kind: "injected" as const, coordinate: "store-a" }, responder: "local.delivery", holdsDeliveryLease: true };
const lease = {
  holder: answer.responder, incarnation: "process-one", proofKey: processSigner.publicKey,
  proofAttestation: attestDeliveryProcess("test-space", answer.responder, "process-one", processSigner.publicKey, storeSigner),
  ready: true, since: Date.now(),
};
const signed = () => signDeliveryStoreAnswer(answer, "test-space", "local.manager", challenge, "process-one", processSigner);
let count = 0;
const pass = (name: string, f: () => void) => { f(); count++; console.log(`PASS ${name}`); };
pass("store certificate", () => assertCertifiedProofLease(lease, "test-space", storeSigner.publicKey));
pass("valid challenge", () => assert.deepEqual(verifyDeliveryStoreProof(signed(), "test-space", "local.manager", challenge, lease), answer));
pass("parse closed proof", () => assert.deepEqual(parseDeliveryStoreProof(signed()).answer, answer));
pass("copied credential replaces process key without store certificate", () => {
  const attacker = newArtifactSigner();
  const replaced = { ...lease, proofKey: attacker.publicKey };
  assert.throws(() => assertCertifiedProofLease(replaced, "test-space", storeSigner.publicKey));
});
pass("attacker self-certifies with a foreign store key", () => {
  const attacker = newArtifactSigner();
  const replaced = { ...lease, proofKey: attacker.publicKey,
    proofAttestation: attestDeliveryProcess("test-space", lease.holder, lease.incarnation, attacker.publicKey, newArtifactSigner()) };
  assert.throws(() => assertCertifiedProofLease(replaced, "test-space", storeSigner.publicKey));
});
pass("wrong process signature", () => {
  const attacker = newArtifactSigner();
  const forged = signDeliveryStoreAnswer(answer, "test-space", "local.manager", challenge, "process-one", attacker);
  assert.throws(() => verifyDeliveryStoreProof(forged, "test-space", "local.manager", challenge, lease));
});
for (const [field, value] of Object.entries({ space: "other", caller: "local.other", challenge: "other", incarnation: "process-two", sig: "invalid" }))
  pass(`changed ${field}`, () => assert.throws(() => verifyDeliveryStoreProof({ ...signed(), [field]: value }, "test-space", "local.manager", challenge, lease)));
pass("changed answer", () => assert.throws(() => verifyDeliveryStoreProof({ ...signed(), answer: { ...answer, identity: { kind: "injected", coordinate: "store-b" } } }, "test-space", "local.manager", challenge, lease)));
pass("unknown proof field", () => assert.throws(() => parseDeliveryStoreProof({ ...signed(), extra: true })));
pass("legacy unsigned answer", () => assert.throws(() => parseDeliveryStoreProof(answer)));
pass("missing store seed", async () => assert.equal(await loadDeliveryStoreSigner(store, "absent"), undefined));
assert.equal(count, 15);
console.log(`DELIVERY-STORE-PROOF SMOKE: ${count} passed, 0 failed`);
