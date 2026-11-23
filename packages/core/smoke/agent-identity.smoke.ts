import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import {
  agentIdentityKey, assertLifecycleToken, createAgentContinuityKey, decideAgentLink, EpEnvelopeError, mintAgentUid,
  mintedAgentIdentity, mintLifecycleUid, parseAgentIdentityRecord, signAgentLink,
  type AgentIdentityRecord, type AgentLinkProof, type AgentLinkRequest, type EpErrorCode,
} from "../src/index.js";

let cases = 0;
const failed: string[] = [];
const check = (name: string, fn: () => void): void => {
  try { fn(); cases++; } catch (e) { failed.push(name); console.error(`FAIL ${name}`, e); }
};
const refuses = (fn: () => unknown, code: EpErrorCode): void => {
  assert.throws(fn, (e: unknown) => e instanceof EpEnvelopeError && e.code === code);
};
const owner = (c: string): string => `u_${c.repeat(26)}`;
const tokenHash = (): string => createHash("sha256").update(randomBytes(32)).digest("hex");

const SPACE = "team";
const OWNER = owner("a");
const OTHER_OWNER = owner("b");
const T0 = 1_800_000_000_000;
const T = T0 + 3_600_000;
const key = createAgentContinuityKey();
const otherKey = createAgentContinuityKey();
const agentUid = mintAgentUid();
const firstRun = { lifecycleUid: mintLifecycleUid(), actor: "builder", tokenHash: tokenHash() };
const minted = mintedAgentIdentity({ agentUid, owner: OWNER, publicKey: key.publicKey, ...firstRun, now: T0 });

const relaunch = { lifecycleUid: mintLifecycleUid(), actor: "builder", tokenHash: tokenHash() };
const ctx = { space: SPACE, owner: OWNER, actor: relaunch.actor, tokenHash: relaunch.tokenHash };
const claims = { agentUid, keyEpoch: 0, linkSeq: 1, issuedAt: T, expiresAt: T + 120_000 };
const proof = signAgentLink(key.privateKey, ctx, claims);
const request = (over: Partial<AgentLinkRequest> = {}): AgentLinkRequest =>
  ({ ...ctx, proof, lifecycleUid: relaunch.lifecycleUid, predecessor: "settled", now: T, ...over });
const signedFor = (over: Partial<typeof ctx>, claimOver: Partial<typeof claims> = {}, privateKey = key.privateKey): AgentLinkProof =>
  signAgentLink(privateKey, { ...ctx, ...over }, { ...claims, ...claimOver });

check("agentUid grammar is disjoint from lifecycle UIDs", () => {
  const drawn = new Set<string>();
  for (let i = 0; i < 1000; i++) {
    const uid = mintAgentUid();
    assert.match(uid, /^ag_[a-z2-7]{26}$/);
    assert.throws(() => assertLifecycleToken(uid));
    drawn.add(uid);
  }
  assert.equal(drawn.size, 1000);
  assert.equal(agentIdentityKey(agentUid), `agentid.${agentUid}`);
  for (const bad of [mintLifecycleUid(), agentUid.toUpperCase(), `${agentUid}x`, "ag_", `ag_${"1".repeat(26)}`, OWNER])
    assert.throws(() => agentIdentityKey(bad));
});

check("a minted identity starts linked to the run that minted it", () => {
  assert.deepEqual(minted, {
    v: 1, agentUid, owner: OWNER, state: "active", key: { alg: "ed25519", publicKey: key.publicKey }, keyEpoch: 0, linkSeq: 1,
    current: { ...firstRun, linkedAt: T0, via: "mint" }, createdAt: T0,
  });
  assert.deepEqual(parseAgentIdentityRecord(`agentid.${agentUid}`, JSON.parse(JSON.stringify(minted))), minted);
});

check("mint refuses malformed inputs and static owners", () => {
  const args = { agentUid, owner: OWNER, publicKey: key.publicKey, ...firstRun, now: T0 };
  for (const over of [
    { owner: "UABCDEFGHIJKLMNOPQRSTUVWXYZ234567ABCDEFGHIJKLMNOPQRSTUVW" }, { owner: "cli" }, { publicKey: "short" },
    { lifecycleUid: "has_underscore_aaaaaaaaaaaaaaa" }, { actor: "a.b" }, { tokenHash: firstRun.tokenHash.toUpperCase() }, { now: 0 },
  ])
    assert.throws(() => mintedAgentIdentity({ ...args, ...over }));
});

const linked = decideAgentLink(minted, request());

check("the continuity key links a relaunch and advances the sequence", () => {
  assert.equal(linked.changed, true);
  assert.deepEqual(linked.record, { ...minted, linkSeq: 2, current: { ...relaunch, linkedAt: T, via: "key" } });
  assert.deepEqual(parseAgentIdentityRecord(agentIdentityKey(agentUid), linked.record), linked.record);
});

check("an exact retry of the linked enrollment changes nothing", () => {
  const retry = decideAgentLink(linked.record, request({ now: T + 1000 }));
  assert.equal(retry.changed, false);
  assert.deepEqual(retry.record, linked.record);
});

check("a retry still needs the signature", () => {
  const forged = { ...proof, signature: signedFor({}, {}, otherKey.privateKey).signature };
  refuses(() => decideAgentLink(linked.record, request({ proof: forged })), "permission-denied");
});

check("a used proof never links another run", () => {
  refuses(() => decideAgentLink(linked.record, request({ lifecycleUid: mintLifecycleUid() })), "permission-denied");
});

check("the next relaunch signs the next sequence, under any name", () => {
  const run = { lifecycleUid: mintLifecycleUid(), actor: "builder_2", tokenHash: tokenHash() };
  const next = signedFor({ actor: run.actor, tokenHash: run.tokenHash }, { linkSeq: 2 });
  const out = decideAgentLink(linked.record, request({ ...run, proof: next }));
  assert.equal(out.changed, true);
  assert.equal(out.record.linkSeq, 3);
  assert.deepEqual(out.record.current, { ...run, linkedAt: T, via: "key" });
});

check("the proof binds the space", () => {
  refuses(() => decideAgentLink(minted, request({ space: "other" })), "permission-denied");
});

check("the key holder cannot move the identity to another owner", () => {
  const forOther = signedFor({ owner: OTHER_OWNER });
  refuses(() => decideAgentLink(minted, request({ owner: OTHER_OWNER, proof: forOther })), "permission-denied");
});

check("the proof binds the actor", () => {
  refuses(() => decideAgentLink(minted, request({ actor: "intruder" })), "permission-denied");
});

check("an intercepted proof cannot link a run holding another token", () => {
  refuses(() => decideAgentLink(minted, request({ tokenHash: tokenHash() })), "permission-denied");
});

check("another key does not link", () => {
  refuses(() => decideAgentLink(minted, request({ proof: signedFor({}, {}, otherKey.privateKey) })), "permission-denied");
});

check("a proof for another identity does not link this one", () => {
  refuses(() => decideAgentLink(minted, request({ proof: signedFor({}, { agentUid: mintAgentUid() }) })), "permission-denied");
});

check("the proof names the current key epoch and sequence", () => {
  for (const over of [{ keyEpoch: 1 }, { linkSeq: 0 }, { linkSeq: 2 }])
    refuses(() => decideAgentLink(minted, request({ proof: signedFor({}, over) })), "permission-denied");
});

check("a tampered or bare proof does not link", () => {
  const sig = proof.signature;
  const flipped = `${sig.slice(0, 40)}${sig[40] === "A" ? "B" : "A"}${sig.slice(41)}`;
  refuses(() => decideAgentLink(minted, request({ proof: { ...proof, signature: flipped } })), "permission-denied");
  refuses(() => decideAgentLink(minted, request({ proof: { ...proof, signature: randomBytes(64).toString("base64url") } })), "permission-denied");
});

check("the proof shape is closed", () => {
  const { signature: _, ...unsigned } = proof;
  for (const bad of [{ ...proof, persona: "builder" }, { ...proof, name: "builder" }, unsigned, { agentUid }, null, "proof", [proof]])
    refuses(() => decideAgentLink(minted, request({ proof: bad })), "bad-request");
});

check("the window is at most 300 s and checked with 60 s of skew", () => {
  const at = (issuedAt: number, expiresAt: number, now: number) =>
    () => decideAgentLink(minted, request({ proof: signedFor({}, { issuedAt, expiresAt }), now }));
  assert.equal(at(T, T + 300_000, T)().changed, true);
  refuses(at(T, T + 300_001, T), "permission-denied");
  refuses(at(T, T, T), "permission-denied");
  assert.equal(at(T, T + 1000, T + 1000 + 59_999)().changed, true);
  refuses(at(T, T + 1000, T + 1000 + 60_000), "permission-denied");
  assert.equal(at(T + 60_000, T + 61_000, T)().changed, true);
  refuses(at(T + 60_001, T + 61_000, T), "permission-denied");
});

check("a malformed enrollment is a bad request", () => {
  for (const over of [{ lifecycleUid: agentUid }, { actor: "a.b" }, { actor: "a-b" }, { tokenHash: "00" }])
    refuses(() => decideAgentLink(minted, request(over)), "bad-request");
});

check("a revoked identity never links", () => {
  const revoked = parseAgentIdentityRecord(agentIdentityKey(agentUid), { ...minted, state: "revoked", revokedAt: T });
  refuses(() => decideAgentLink(revoked, request()), "failed-precondition");
});

check("one live lifecycle per identity", () => {
  refuses(() => decideAgentLink(minted, request({ predecessor: "live" })), "conflict");
  refuses(() => decideAgentLink(minted, request({ predecessor: "unknown" })), "unavailable");
});

check("liveness is not revealed before the signature verifies", () => {
  refuses(() => decideAgentLink(minted, request({ predecessor: "live", proof: signedFor({}, {}, otherKey.privateKey) })), "permission-denied");
});

check("a stored record outside the closed shape never authorizes", () => {
  const k = agentIdentityKey(agentUid);
  const bad: unknown[] = [
    { ...minted, extra: 1 }, { ...minted, v: 2 }, { ...minted, state: "paused" }, { ...minted, revokedAt: T },
    { ...minted, state: "revoked" }, { ...minted, linkSeq: 0 }, { ...minted, keyEpoch: -1 }, { ...minted, owner: "cli" },
    { ...minted, key: { alg: "ed448", publicKey: key.publicKey } }, { ...minted, current: { ...minted.current, via: "persona" } },
    { ...minted, current: { ...minted.current, extra: 1 } }, { ...minted, agentUid: mintAgentUid() },
  ];
  const { current: _, ...noCurrent } = minted as AgentIdentityRecord;
  bad.push(noCurrent, null, []);
  for (const raw of bad) refuses(() => parseAgentIdentityRecord(k, raw), "failed-precondition");
});

console.log(`agent identity: ${cases} cases passed, ${failed.length} failed`);
if (failed.length) process.exit(1);
