/**
 * D13 (3)+(2b) credential-ledger smoke — the NORMATIVE §13.1 credential ledger and the FULL
 * takeover issuance barrier against a real broker WITH a real system account, so the barrier's
 * verified-eviction step is a LIVE CONNZ-scan → KICK → re-scan (core `evictDeniedPrincipal`),
 * not a stub:
 *  - the mint protocol (observe gate → write rows → pinned touch-CAS → release): rows land
 *    closed-schema in the right families, byte-identical retries proceed, foreign content
 *    refuses, a frozen lifecycle gate or a missing/frozen source gate refuses, and the
 *    freeze-vs-finalize race loses durably (own row revoked, nothing releases);
 *  - the lineage: `bysrc.` index rows per presented handle, and the handle-revocation walk
 *    (freeze the source gate → enumerate → revoke descendants → VERIFIED live eviction);
 *  - the TAKEOVER BARRIER end-to-end over a LIVE victim connection: durable `stage.<opId>`
 *    intent, freeze, point-in-time family enumeration, revoke-all, real KICK with re-scan
 *    verification, epoch head CAS LAST, reopen at G+1 — plus resume idempotence, the
 *    fail-closed eviction path (gate STAYS frozen, epoch does NOT advance), stranger-opId
 *    refusal, and enumeration corruption probes (garbled row / DEL marker fail LOUD).
 *
 * The victims are static conf users named in principal NAME-form (`local-victim` →
 * `local.victim` via CONNZ `authorized_user`, the same attribution lane as callout users —
 * the scoped-cred + callout shape is proven in evict-live-auth.smoke.ts; the scoped
 * minting-profile confinement in lifecycle-registry.smoke.ts).
 *
 * Run: pnpm smoke:credential-ledger:auth   (needs nats-server on PATH; part of smoke:ci)
 */
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect, type NatsConnection } from "@nats-io/transport-node";
import { jetstreamManager } from "@nats-io/jetstream";
import { Kvm } from "@nats-io/kv";
import { generateKeyPair, exportJWK, calculateJwkThumbprint, type CryptoKey } from "jose";
import {
  isReachable, EpEnvelopeError, createEndpointStreams, mintLifecycleUid, epAuthBucket,
  evictDeniedPrincipal, MEMBERSHIP_INBOX_PREFIX, epsSubject, sessionLedgerKey,
  redeemSession, retrieveServingCredential, type SessionGrant,
} from "@cotal-ai/core";
import { openLifecycleRegistry, openLifecycleMappingReader, openSessionAuthStore, sessionRedemptionHooks } from "../src/index.js";
import { activateLifecycle, observeGate, freezeGate, readLifecycleHeadForOperation } from "../src/lifecycle-registry.js";
import { makeLedgerScannerOverConnection } from "../src/ledger-scanner.js";
import { writeEndpointGate, reconcileSessionForTakeover } from "../src/session-ledger.js";
import {
  stageAgentMint, finalizeAgentMint, enumerateAgentFamily,
  createSourceGateOpen, observeSourceGate, freezeSourceGate, revokeHandleSource,
  runAgentTakeoverBarrier, resumeAgentTakeover, markLedgerRowRevoked,
  credRowKey, srcgateKey, stageIntentKey,
  type EvictPrincipal, type ReconcileSessionPair,
} from "../src/credential-ledger.js";
import { pickFreePort } from "../../../packages/core/smoke/_free-port.js";
import { SMOKE_BROKER_TOKEN, teardownOnSignal } from "@cotal-ai/smoke-kit";

let ok = 0, fail = 0;
const c = (n: string, v: boolean, extra?: unknown) => { if (v) { ok++; } else { fail++; console.log("  ✗ FAIL:", n, extra ?? ""); } };
const rejects = async (n: string, fn: () => Promise<unknown> | unknown, code?: string) => {
  try { await fn(); c(n, false, "no throw"); } catch (e) {
    c(n, code === undefined || (e instanceof EpEnvelopeError && e.code === code), `code ${(e as EpEnvelopeError).code ?? (e as Error).message}`);
  }
};
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const until = async (cond: () => boolean, ms = 2500): Promise<boolean> => {
  const end = Date.now() + ms;
  while (!cond() && Date.now() < end) await wait(25);
  return cond();
};

const SPACE = "credledger";
const MGR = "mgr-1";
const NOW = 1_700_000_000_000;
const EVICT_OPTS = { maxWaitMs: 1500, settleMs: 200, maxVerifyRounds: 3 } as const;
const enc = new TextEncoder();
const dec = new TextDecoder();

const PORT = await pickFreePort();
const sd = mkdtempSync(join(tmpdir(), SMOKE_BROKER_TOKEN));
// A conf broker with a REAL system account (CONNZ + KICK live) and an APP account holding the
// trusted-auth user plus two victim users whose usernames are principal NAME-forms — CONNZ
// surfaces a static user's name as `authorized_user`, which `principalFromConnz` resolves to
// `local.victim` / `local.victim2`, the same dot-forms the ledger rows carry.
writeFileSync(join(sd, "server.conf"), `
port: ${PORT}
listen: 127.0.0.1:${PORT}
jetstream { store_dir: ${JSON.stringify(sd)} }
system_account: SYS
accounts {
  SYS: { users = [ { user: "sys", password: "pw" } ] }
  APP: {
    jetstream: enabled
    users = [
      { user: "auth", password: "pw" }
      { user: "local-victim", password: "pw", permissions: { publish: { allow: ["victim.>"] }, subscribe: { allow: ["victim.>", "_INBOX.>"] } } }
      { user: "local-victim2", password: "pw", permissions: { publish: { allow: ["victim.>"] }, subscribe: { allow: ["victim.>", "_INBOX.>"] } } }
      { user: "local-victim3", password: "pw", permissions: { publish: { allow: ["victim.>"] }, subscribe: { allow: ["victim.>", "_INBOX.>"] } } }
      { user: "local-wedge", password: "pw", permissions: { publish: { allow: ["victim.>"] }, subscribe: { allow: ["victim.>", "_INBOX.>"] } } }
    ]
  }
}
`);
const broker = spawn("nats-server", ["-c", join(sd, "server.conf")], { stdio: "ignore" });
const releaseBroker = teardownOnSignal(broker, sd);

let nc: NatsConnection | undefined, sysObserver: NatsConnection | undefined, sysEvictor: NatsConnection | undefined,
  victim1: NatsConnection | undefined, victim2: NatsConnection | undefined, servingConn: NatsConnection | undefined, wedgeConn: NatsConnection | undefined;
try {
  let up = false;
  for (let i = 0; i < 50 && !up; i++) { up = await isReachable(`nats://auth:pw@127.0.0.1:${PORT}`); if (!up) await wait(100); }
  if (!up) throw new Error("broker did not come up");
  nc = await connect({ servers: `nats://127.0.0.1:${PORT}`, user: "auth", pass: "pw" });
  // The observer connects under the CONNZ reply prefix its production cred grants; the evictor
  // is a second $SYS connection (discovery and kill are separate authorities, D5 slice 4).
  sysObserver = await connect({ servers: `nats://127.0.0.1:${PORT}`, user: "sys", pass: "pw", inboxPrefix: MEMBERSHIP_INBOX_PREFIX, maxReconnectAttempts: 0 });
  sysEvictor = await connect({ servers: `nats://127.0.0.1:${PORT}`, user: "sys", pass: "pw", maxReconnectAttempts: 0 });
  const liveEvict: EvictPrincipal = (principal) => evictDeniedPrincipal(sysObserver!, sysEvictor!, "APP", principal, EVICT_OPTS);

  await createEndpointStreams(await jetstreamManager(nc), new Kvm(nc), SPACE);
  const reg = await openLifecycleRegistry(nc, SPACE, makeLedgerScannerOverConnection(nc, SPACE));
  const authKv = await new Kvm(nc).open(epAuthBucket(SPACE));

  console.log("A. activation + the mint protocol (observe → rows → pinned touch → release)");
  const act1 = await activateLifecycle(reg, { owner: "local", actor: "victim", managerInstance: MGR });
  const uid1 = act1.mapping.lifecycleUid;
  const mint1 = await stageAgentMint(reg, { lifecycleUid: uid1, credentialId: "root0001", holderPrincipal: "local.victim", sourceChain: ["root"], exp: NOW + 60_000 });
  await finalizeAgentMint(reg, mint1);
  {
    const row = JSON.parse(dec.decode((await authKv.get(credRowKey(uid1, "root0001")))!.value)) as { state: string; sourceChain: string[]; holderPrincipal: string };
    c("a finalized root mint has its NORMATIVE ledger row (closed, active, root lineage)",
      row.state === "active" && row.sourceChain[0] === "root" && row.holderPrincipal === "local.victim", row);
  }
  {
    const gate = await observeGate(reg, uid1);
    c("the finalize touch bumped ONLY the gate revision (still open at generation 1)",
      gate !== undefined && gate.row.state === "open" && gate.row.generation === 1, gate?.row);
  }
  // Byte-identical retry proceeds (a crashed mint's own retry); foreign content refuses.
  await finalizeAgentMint(reg, await stageAgentMint(reg, { lifecycleUid: uid1, credentialId: "root0001", holderPrincipal: "local.victim", sourceChain: ["root"], exp: NOW + 60_000 }));
  c("a BYTE-IDENTICAL retry of the same mint proceeds (crash-retry over deterministic rows)", true);
  await rejects("the same credentialId with FOREIGN content refuses (a staged name never re-binds)",
    () => stageAgentMint(reg, { lifecycleUid: uid1, credentialId: "root0001", holderPrincipal: "local.victim", sourceChain: ["root"], exp: NOW + 99_000 }), "conflict");
  await rejects("a mint for a NEVER-ACTIVATED lifecycle refuses (no gate, nothing mints)",
    () => stageAgentMint(reg, { lifecycleUid: "x".repeat(26), credentialId: "root0001", holderPrincipal: "local.victim", sourceChain: ["root"], exp: NOW + 60_000 }), "permission-denied");
  await rejects("a mint whose holderPrincipal is not an evictable principal dot-form refuses",
    () => stageAgentMint(reg, { lifecycleUid: uid1, credentialId: "bad00001", holderPrincipal: "not-a-principal", sourceChain: ["root"], exp: NOW + 60_000 }), "failed-precondition");
  await rejects("an empty sourceChain refuses (the FULL lineage is required)",
    () => stageAgentMint(reg, { lifecycleUid: uid1, credentialId: "bad00002", holderPrincipal: "local.victim", sourceChain: [], exp: NOW + 60_000 }), "failed-precondition");
  // holderPrincipal is BOUND to the uid's reserved identity (the barrier evicts it, so a trusted
  // caller cannot ledger a row naming a FOREIGN principal to KICK).
  await rejects("a mint whose holderPrincipal is a valid-but-FOREIGN principal (not the uid's reserved identity) refuses",
    () => stageAgentMint(reg, { lifecycleUid: uid1, credentialId: "bad00003", holderPrincipal: "local.someoneelse", sourceChain: ["root"], exp: NOW + 60_000 }), "permission-denied");
  // A hand-assembled StagedAgentMint (an empty-pins object that would finalize proving NO gate)
  // never reaches the touch-CAS: only stageAgentMint mints a branded staged object.
  await rejects("finalizeAgentMint refuses a hand-assembled StagedAgentMint (the brand is the fence, not the field shape)",
    () => finalizeAgentMint(reg, { lifecycleUid: uid1, credentialId: "forged", pins: [], rowKey: credRowKey(uid1, "forged") } as never), "failed-precondition");

  console.log("B. source gates + lineage (bysrc) + the freeze-vs-finalize race");
  await createSourceGateOpen(reg, { issuerKeyId: "k1", id: "h1" });
  await rejects("a handle mint whose source gate does NOT exist refuses",
    () => stageAgentMint(reg, { lifecycleUid: uid1, credentialId: "hcred001", holderPrincipal: "local.victim", sourceChain: ["handle.k1.nogate"], exp: NOW + 60_000 }), "permission-denied");
  const mintH = await stageAgentMint(reg, { lifecycleUid: uid1, credentialId: "hcred001", holderPrincipal: "local.victim", sourceChain: ["handle.k1.h1"], exp: NOW + 60_000 });
  await finalizeAgentMint(reg, mintH);
  {
    const idx = await authKv.get(`bysrc.k1.h1.${uid1}.hcred001`);
    c("a handle mint writes its per-ancestor lineage index row (bysrc.<kid>.<id>.<uid>.<credId>)",
      idx !== null && idx.operation === "PUT" && (JSON.parse(dec.decode(idx.value)) as { ref: string }).ref === credRowKey(uid1, "hcred001"));
  }
  {
    // THE RACE: stage observes the gates, then the source gate freezes (a revocation's fence),
    // then finalize runs — the pinned touch MUST lose, the mint's own row is revoked, nothing
    // releases. This is the §13.1 serialization on one key, driven for real.
    await createSourceGateOpen(reg, { issuerKeyId: "k1", id: "h2" });
    const staged = await stageAgentMint(reg, { lifecycleUid: uid1, credentialId: "hcred002", holderPrincipal: "local.victim", sourceChain: ["handle.k1.h2"], exp: NOW + 60_000 });
    const src = await observeSourceGate(reg, { issuerKeyId: "k1", id: "h2" });
    await freezeSourceGate(reg, { issuerKeyId: "k1", id: "h2", revision: src!.revision });
    await rejects("a finalize whose source gate froze after observation LOSES its pinned touch (permission-denied)",
      () => finalizeAgentMint(reg, staged), "permission-denied");
    const row = JSON.parse(dec.decode((await authKv.get(credRowKey(uid1, "hcred002")))!.value)) as { state: string };
    c("…and the loser's OWN row is durably revoked (it never releases)", row.state === "revoked", row);
    await rejects("a fresh mint under the now-FROZEN source gate refuses at stage",
      () => stageAgentMint(reg, { lifecycleUid: uid1, credentialId: "hcred003", holderPrincipal: "local.victim", sourceChain: ["handle.k1.h2"], exp: NOW + 60_000 }), "permission-denied");
  }

  console.log("C. the TAKEOVER BARRIER end-to-end over a LIVE victim connection");
  // `reconnect: false`: a STATIC conf user has no ledger-backed deny-new at the auth layer (no
  // callout consults the row), so with reconnection on it would immediately come back with a
  // fresh cid — the "evict chases churn without deny-new" case the module documents. Disabling
  // reconnect models the deny-new outcome (a kicked client that cannot return), which is what
  // the barrier's verified eviction guarantees in production, where the ledger revoke IS the
  // deny-new the callout enforces. The full callout+revoke+KICK+stays-gone path is proven in
  // evict-live-auth.smoke.ts; here the barrier drives a REAL KICK, not a stub.
  victim1 = await connect({ servers: `nats://127.0.0.1:${PORT}`, user: "local-victim", pass: "pw", reconnect: false });
  let v1Closed = false;
  victim1.closed().then(() => { v1Closed = true; }, () => { v1Closed = true; });
  c("the victim principal local.victim is live before the barrier", !victim1.isClosed());
  const op1 = mintLifecycleUid();
  const res1 = await runAgentTakeoverBarrier(reg, { owner: "local", actor: "victim", lifecycleUid: uid1, opId: op1 }, { evictPrincipal: liveEvict });
  c("the barrier reports the successor coordinates (epoch 2, generation 2) and the revoked family",
    res1.toEpoch === 2 && res1.toGeneration === 2 && res1.revokedRows >= 2 && res1.evictedPrincipals.includes("local.victim"), res1);
  {
    const dropped = await until(() => v1Closed || victim1!.isClosed(), 2500);
    c("the LIVE victim connection was actually KICKed (verified by re-scan, not assumed)", dropped, { v1Closed });
    const head = await readLifecycleHeadForOperation(reg, "local", "victim");
    c("the epoch head CAS landed LAST (active head at epoch 2, same uid)",
      head !== undefined && head.mapping.processEpoch === 2 && head.mapping.state === "active" && head.mapping.lifecycleUid === uid1, head?.mapping);
    const gate = await observeGate(reg, uid1);
    c("the gate reopened at the successor generation (open, G+1 = 2)", gate !== undefined && gate.row.state === "open" && gate.row.generation === 2, gate?.row);
    const fam = await enumerateAgentFamily(reg, uid1);
    c("EVERY ledger row under the lifecycle prefix is revoked (roots and descendants alike)",
      fam.length >= 3 && fam.every((f) => f.row.state === "revoked"), fam.map((f) => `${f.key}=${f.row.state}`));
    const intent = await authKv.get(stageIntentKey(op1));
    c("the durable operation intent persists at stage.<opId> (audit; never under a ledger prefix)", intent !== null && intent.operation === "PUT");
  }
  {
    const again = await resumeAgentTakeover(reg, op1, { evictPrincipal: liveEvict });
    c("resuming the COMPLETED operation is idempotent (same coordinates, no second advance)",
      again.toEpoch === 2 && again.toGeneration === 2, again);
    const head = await readLifecycleHeadForOperation(reg, "local", "victim");
    c("…the epoch did not move again", head?.mapping.processEpoch === 2);
  }
  await rejects("a STRANGER's opId resumes nothing (no intent, not-found)",
    () => resumeAgentTakeover(reg, mintLifecycleUid(), { evictPrincipal: liveEvict }), "not-found");
  await rejects("an opId whose intent names a DIFFERENT lifecycle refuses (an opId resumes only its own operation)",
    () => runAgentTakeoverBarrier(reg, { owner: "local", actor: "victim", lifecycleUid: "y".repeat(26), opId: op1 }, { evictPrincipal: liveEvict }), "permission-denied");

  console.log("D. the FAIL-CLOSED eviction path (gate stays frozen, epoch does not advance)");
  {
    const op2 = mintLifecycleUid();
    const failingEvict: EvictPrincipal = async (principal) => ({ principal, kicked: 0, remaining: 1, verifiedGone: false, scanComplete: true, note: "simulated partial eviction" });
    await rejects("a barrier whose eviction cannot VERIFY fails loud (unavailable)",
      () => runAgentTakeoverBarrier(reg, { owner: "local", actor: "victim", lifecycleUid: uid1, opId: op2 }, { evictPrincipal: failingEvict }), "unavailable");
    const gate = await observeGate(reg, uid1);
    c("…the gate STAYS FROZEN under the failed operation (nothing mints)",
      gate !== undefined && gate.row.state === "frozen" && gate.row.op?.opId === op2, gate?.row);
    const head = await readLifecycleHeadForOperation(reg, "local", "victim");
    c("…and the epoch did NOT advance (containment before authority)", head?.mapping.processEpoch === 2);
    await rejects("a mint under the frozen gate refuses (the barrier's bar holds while unresolved)",
      () => stageAgentMint(reg, { lifecycleUid: uid1, credentialId: "root0002", holderPrincipal: "local.victim", sourceChain: ["root"], exp: NOW + 60_000 }), "permission-denied");
    const resumed = await resumeAgentTakeover(reg, op2, { evictPrincipal: liveEvict });
    c("resuming the SAME opId with working eviction completes the barrier (epoch 3, generation 3)",
      resumed.toEpoch === 3 && resumed.toGeneration === 3, resumed);
  }

  console.log("E. the handle-revocation walk with LIVE eviction across lifecycles");
  {
    // victim2 holds a credential minted under handle k1.h1 in ITS OWN lifecycle — revoking the
    // handle at the source must revoke that descendant AND verifiably evict victim2 live.
    victim2 = await connect({ servers: `nats://127.0.0.1:${PORT}`, user: "local-victim2", pass: "pw", reconnect: false });
    let v2Closed = false;
    victim2.closed().then(() => { v2Closed = true; }, () => { v2Closed = true; });
    const act2 = await activateLifecycle(reg, { owner: "local", actor: "victim2", managerInstance: MGR });
    const uid2 = act2.mapping.lifecycleUid;
    await finalizeAgentMint(reg, await stageAgentMint(reg, { lifecycleUid: uid2, credentialId: "hcred010", holderPrincipal: "local.victim2", sourceChain: ["handle.k1.h1"], exp: NOW + 60_000 }));
    const walk = await revokeHandleSource(reg, { issuerKeyId: "k1", id: "h1" }, { evictPrincipal: liveEvict });
    c("the walk froze the source gate, revoked the descendant, and verified eviction of its holder",
      walk.evictedPrincipals.includes("local.victim2"), walk);
    const dropped = await until(() => v2Closed || victim2!.isClosed(), 2500);
    c("victim2's LIVE connection was actually KICKed by the handle revocation", dropped, { v2Closed });
    const row = JSON.parse(dec.decode((await authKv.get(credRowKey(uid2, "hcred010")))!.value)) as { state: string };
    c("…the descendant row under the OTHER lifecycle is revoked (parent revocation reaches it via bysrc)", row.state === "revoked", row);
    const src = await observeSourceGate(reg, { issuerKeyId: "k1", id: "h1" });
    c("…the source gate is frozen forever (a revoked handle never mints again)", src?.row.state === "frozen", src?.row);
    const resumeWalk = await revokeHandleSource(reg, { issuerKeyId: "k1", id: "h1" }, { evictPrincipal: liveEvict });
    c("re-running the walk is idempotent (already-frozen gate resumes, rows already revoked)",
      resumeWalk.revokedRows === 0 && resumeWalk.evictedPrincipals.includes("local.victim2"), resumeWalk);
    await rejects("revoking a handle with NO source gate is not-found",
      () => revokeHandleSource(reg, { issuerKeyId: "k1", id: "never" }, { evictPrincipal: liveEvict }), "not-found");
  }

  console.log("F. enumeration corruption fails LOUD (a partial or poisoned family read never proceeds)");
  {
    // A THROWAWAY family, poisoned two ways: a garbled row and a DEL marker. Both must abort
    // the enumeration (and so any barrier over it), never be skipped.
    const uid3 = "p".repeat(26);
    await authKv.put(credRowKey(uid3, "junk0001"), enc.encode("{\"garbled\":true}"));
    await rejects("a garbled row under the enumerated prefix aborts the enumeration (internal)",
      () => enumerateAgentFamily(reg, uid3), "internal");
    const uid4 = "r".repeat(26);
    await authKv.put(credRowKey(uid4, "gone0001"), enc.encode(JSON.stringify({ credentialId: "gone0001", holderPrincipal: "local.victim", lifecycleUid: uid4, sourceChain: ["root"], state: "active", exp: NOW })));
    await authKv.delete(credRowKey(uid4, "gone0001"));
    await rejects("a DEL marker under the enumerated prefix aborts the enumeration (rows are revoked, never deleted)",
      () => enumerateAgentFamily(reg, uid4), "failed-precondition");
    const cleanRows = await enumerateAgentFamily(reg, "w".repeat(26));
    c("an empty family enumerates empty (and the throwaway consumer was deleted per run)", cleanRows.length === 0);
  }
  {
    // The stage. family is never under a ledger prefix: the takeover intents written above must
    // not appear in any cred. enumeration (structural, but prove it against the real bucket).
    const fam = await enumerateAgentFamily(reg, uid1);
    c("stage.<opId> intents never surface in a cred.<uid>.> enumeration (disjoint families)",
      fam.every((f) => f.key.startsWith(`cred.${uid1}.`)), fam.map((f) => f.key));
  }

  console.log("G. srcgate discipline probes");
  {
    await createSourceGateOpen(reg, { issuerKeyId: "k2", id: "h9" });
    await createSourceGateOpen(reg, { issuerKeyId: "k2", id: "h9" });
    c("re-creating an identical source gate is idempotent (create-only, byte-identical)", true);
    const src = await observeSourceGate(reg, { issuerKeyId: "k2", id: "h9" });
    await freezeSourceGate(reg, { issuerKeyId: "k2", id: "h9", revision: src!.revision });
    await rejects("a STALE-revision source-gate freeze loses its CAS (conflict)",
      () => freezeSourceGate(reg, { issuerKeyId: "k2", id: "h9", revision: src!.revision }), "conflict");
    await authKv.put(srcgateKey("k3", "bad"), enc.encode("{\"state\":\"open\",\"extra\":1}"));
    await rejects("a garbled source gate refuses at observe (closed schema)",
      () => observeSourceGate(reg, { issuerKeyId: "k3", id: "bad" }), "internal");
  }

  console.log("H. the two-intent takeover race (a loser never claims the winner's completion)");
  {
    // Two takeover ops both capture the SAME (fromEpoch 1, fromGeneration 1) BEFORE either
    // freezes. Persist the LOSER's intent at those coordinates FIRST, let the winner A run to
    // completion (epoch 2, gen 2), then resume the loser: it sees the gate open at G+1 and the
    // head at N+1, but the epoch stamp binds the completion to A's opId, so the loser refuses
    // with conflict instead of falsely reporting success (SPEC 13.1).
    const actR = await activateLifecycle(reg, { owner: "local", actor: "racer", managerInstance: MGR });
    const uidR = actR.mapping.lifecycleUid;
    const opA = mintLifecycleUid(), opLoser = mintLifecycleUid();
    // The loser's intent, hand-persisted at the pre-takeover coordinates it captured (epoch 1,
    // generation 1) — exactly what A also captured.
    await authKv.create(stageIntentKey(opLoser), enc.encode(JSON.stringify({ kind: "takeover", lifecycleUid: uidR, owner: "local", actor: "racer", fromEpoch: 1, fromGeneration: 1 })));
    // A wins and completes.
    const resA = await runAgentTakeoverBarrier(reg, { owner: "local", actor: "racer", lifecycleUid: uidR, opId: opA }, { evictPrincipal: liveEvict });
    c("the winner A completes the takeover (epoch 2, generation 2)", resA.toEpoch === 2 && resA.toGeneration === 2);
    // The loser resumes at the winner's captured coordinates: gate open at gen 2 (= its
    // fromGeneration+1), head epoch 2 (= its fromEpoch+1), but lastTakeoverOpId is A's.
    await rejects("the LOSER resuming at the winner's captured (epoch 1, generation 1) refuses (the epoch stamp binds completion to the winning opId, no split-brain success)",
      () => resumeAgentTakeover(reg, opLoser, { evictPrincipal: liveEvict }), "conflict");
    const headAfter = await readLifecycleHeadForOperation(reg, "local", "racer");
    c("…the head's lastTakeoverOpId is the WINNER's opId, not the loser's", headAfter?.mapping.lastTakeoverOpId === opA);
  }

  console.log("I. session-pair teardown + the epcred serving principal (SPEC 13.1: a lifecycle barrier tears down BOTH halves)");
  {
    // A holder lifecycle with a LIVE session: the barrier must revoke the caller cred row AND
    // terminalize session.<sid> AND revoke the paired serving epcred row, else the serving half
    // outlives the takeover. The serving epcred row's holderPrincipal is the CONNZ-evictable
    // serving principal (from the endpoint gate), NOT the endpoint name.
    const reader = await openLifecycleMappingReader(nc!, SPACE);
    const store = await openSessionAuthStore(nc!, SPACE);
    const { privateKey, publicKey } = await generateKeyPair("EdDSA", { extractable: true });
    const thumb = await calculateJwkThumbprint(await exportJWK(publicKey));
    const signer = { current: { kid: "k1", key: privateKey as CryptoKey }, resolve: (_k: string) => privateKey as CryptoKey, thumbprint: (_k: string) => thumb };
    const hooks = sessionRedemptionHooks({ store, registry: reg, reader, signer, now: () => NOW + 10 });
    // A fresh holder lifecycle (owner=local, actor=sessholder) + a serving endpoint instance.
    const actS = await activateLifecycle(reg, { owner: "local", actor: "sessholder", managerInstance: MGR });
    const uidH = actS.mapping.lifecycleUid;
    // The serving principal is a REAL static conf user (`local-victim3` → CONNZ `local.victim3`)
    // with a LIVE connection: the barrier must VERIFIED-evict it, not just revoke its row.
    const IID = "t".repeat(26), EP = "term", SPRIN = "local.victim3";
    await writeEndpointGate(store.kv, EP, IID, { state: "open", generation: 1, processEpoch: 5, registrationRevision: 1, nameAuthorityRevision: 1, principal: SPRIN });
    servingConn = await connect({ servers: `nats://127.0.0.1:${PORT}`, user: "local-victim3", pass: "pw", reconnect: false });
    const SID = `${"z".repeat(20)}0001`;
    const grant: SessionGrant = {
      v: 1, sessionId: SID, space: SPACE, endpoint: EP,
      subjects: { in: epsSubject(SPACE, EP, SID, 5, "in"), out: epsSubject(SPACE, EP, SID, 5, "out") },
      holder: { id: "local.sessholder", lifecycleUid: uidH, processEpoch: actS.mapping.processEpoch },
      serving: { instanceId: IID, epoch: 5 }, window: 64, iat: NOW, exp: NOW + 60_000, nonce: "n".repeat(16),
      issuer: { keyId: "k1" }, sig: "unused",
    } as SessionGrant;
    await redeemSession(grant, { id: "local.sessholder", lifecycleUid: uidH }, hooks);
    {
      const servingRow = JSON.parse(dec.decode((await store.kv.get(`epcred.term.${IID}.${SID}.s`))!.value)) as { holderPrincipal: string; endpoint: string };
      c("the serving epcred row's holderPrincipal is the CONNZ-evictable serving principal (not the endpoint name)",
        servingRow.holderPrincipal === SPRIN && servingRow.endpoint === EP, servingRow);
    }
    // A barrier over the holder with sessions but NO reconciler fails loud (and, fail-closed,
    // leaves the gate frozen under its op — nothing mints while the session pair is unresolved).
    const opTake = mintLifecycleUid();
    await rejects("a takeover of a lifecycle WITH session-derived credentials but no reconciler fails loud",
      () => runAgentTakeoverBarrier(reg, { owner: "local", actor: "sessholder", lifecycleUid: uidH, opId: opTake }, { evictPrincipal: liveEvict }), "failed-precondition");
    c("…and the gate STAYS FROZEN under the failed op (nothing mints while the pair is unresolved)",
      (await observeGate(reg, uidH))?.row.state === "frozen");
    // RESUMING the SAME op with the reconciler wired completes the barrier and tears down BOTH halves.
    const reconcile: ReconcileSessionPair = (sessionId) => reconcileSessionForTakeover(store, hooks, sessionId);
    const resH = await resumeAgentTakeover(reg, opTake, { evictPrincipal: liveEvict, reconcileSessionPair: reconcile });
    c("resuming the SAME op with the reconciler wired completes the barrier (epoch 2)", resH.toEpoch === 2);
    const sessRow = JSON.parse(dec.decode((await store.kv.get(sessionLedgerKey(SID)))!.value)) as { state: string; revoked: { caller: boolean; serving: boolean } };
    c("…the session row is TERMINAL (superseded) with both halves revoked+marked", sessRow.state === "superseded" && sessRow.revoked.caller && sessRow.revoked.serving, sessRow);
    const servingLedger = JSON.parse(dec.decode((await store.kv.get(`epcred.term.${IID}.${SID}.s`))!.value)) as { state: string };
    c("…the paired SERVING epcred row is revoked (the serving half cannot outlive the takeover)", servingLedger.state === "revoked", servingLedger);
    // The LIVE serving connection is VERIFIED-evicted by the barrier (SPEC 13.6: both
    // credentials revoked WITH eviction), not merely row-revoked.
    c("…the barrier's eviction set INCLUDES the serving principal (from the reconciler)", resH.evictedPrincipals.includes(SPRIN), resH.evictedPrincipals);
    let servingClosed = false;
    try { servingClosed = await until(() => servingConn!.isClosed(), 3000); } catch { servingClosed = servingConn!.isClosed(); }
    c("…and the LIVE serving connection is GONE after the holder takeover (verified eviction, not row-only)", servingClosed);
    // The reconciler is idempotent AND still reports the principal on a re-run (a resumed
    // barrier must still evict).
    const again = await reconcile(SID);
    c("…a re-run of the reconciler still returns the serving principal (resume must re-evict)", again.servingPrincipals.length === 1 && again.servingPrincipals[0] === SPRIN, again);
    await rejects("…and retrieveServingCredential now releases NOTHING (the session is terminal)",
      () => retrieveServingCredential(SID, { endpoint: EP, instanceId: IID, epoch: 5 }, hooks), "failed-precondition");
    // TRUE ABSENCE of a named session row is CORRUPTION, never "nothing to reconcile" (rows are
    // never deleted; treating absence as settled would silently spare a live serving half).
    await rejects("a reconciler invoked for a session with NO ledger row refuses as corruption (absence is never settled)",
      () => reconcileSessionForTakeover(store, hooks, `${"z".repeat(20)}0002`), "failed-precondition");
  }

  console.log("J. the torn-coordinate takeover wedge (a stale intent must never freeze the winner's gate)");
  {
    // The freelance BLOCKER: op B reads the head at epoch 1, a full takeover A completes
    // (epoch 2, gate reopens at generation 2), then B reads the gate at 2 and persists the TORN
    // intent (fromEpoch 1, fromGeneration 2). Pre-fix, B froze the winner's reopened gate,
    // revoked the successor family, and wedged forever on the foreign epoch stamp.
    const actW = await activateLifecycle(reg, { owner: "local", actor: "wedge", managerInstance: MGR });
    const uidW = actW.mapping.lifecycleUid;
    const opA2 = mintLifecycleUid(), opB = mintLifecycleUid(), opC = mintLifecycleUid();
    const resA2 = await runAgentTakeoverBarrier(reg, { owner: "local", actor: "wedge", lifecycleUid: uidW, opId: opA2 }, { evictPrincipal: liveEvict });
    c("the winner completes (epoch 2, generation 2)", resA2.toEpoch === 2 && resA2.toGeneration === 2);
    // B's torn intent, hand-persisted exactly as the straddled capture would have written it.
    await authKv.create(stageIntentKey(opB), enc.encode(JSON.stringify({ kind: "takeover", lifecycleUid: uidW, owner: "local", actor: "wedge", fromEpoch: 1, fromGeneration: 2 })));
    await rejects("a TORN intent (old epoch, winner's generation) refuses BEFORE the freeze (the head guard sees the foreign epoch)",
      () => resumeAgentTakeover(reg, opB, { evictPrincipal: liveEvict }), "conflict");
    const gateW = await observeGate(reg, uidW);
    c("…and the gate was NOT moved (still OPEN at the winner's generation 2 — no wedge, nothing revoked)",
      gateW?.row.state === "open" && gateW?.row.generation === 2, gateW?.row);
    // The CRASH-BOUNDARY wedged shape (freelance BLOCKER): a pre-guard op B froze the winner's
    // generation, REVOKED a family row, then crashed BEFORE evicting that row's still-LIVE
    // holder. The resume must COMPLETE containment (verified-evict every revoked holder) before
    // it aborts — reopening early would leave a revoked credential's connection live. Model it:
    // mint a successor credential under the winner's uid (gate open at gen 2), open its LIVE
    // connection, revoke its row (B's partial containment), freeze under the torn intent (B's
    // freeze), then resume.
    const succ = await stageAgentMint(reg, { lifecycleUid: uidW, credentialId: "wsucc001", holderPrincipal: "local.wedge", sourceChain: ["root"], exp: NOW + 60_000 });
    await finalizeAgentMint(reg, succ);
    wedgeConn = await connect({ servers: `nats://127.0.0.1:${PORT}`, user: "local-wedge", pass: "pw", reconnect: false });
    await markLedgerRowRevoked(authKv, credRowKey(uidW, "wsucc001")); // B revoked, then crashed before evicting
    const gateWnow = await observeGate(reg, uidW);
    await authKv.create(stageIntentKey(opC), enc.encode(JSON.stringify({ kind: "takeover", lifecycleUid: uidW, owner: "local", actor: "wedge", fromEpoch: 1, fromGeneration: 2 })));
    await freezeGate(reg, { lifecycleUid: uidW, revision: gateWnow!.revision, op: { opId: opC, kind: "takeover" } });
    await rejects("a gate ALREADY FROZEN under a torn intent COMPLETES containment then aborts by reopening (unwedge, not permafreeze, not skip-eviction)",
      () => resumeAgentTakeover(reg, opC, { evictPrincipal: liveEvict }), "conflict");
    let wedgeGone = false;
    try { wedgeGone = await until(() => wedgeConn!.isClosed(), 3000); } catch { wedgeGone = wedgeConn!.isClosed(); }
    c("…the revoked successor's LIVE connection was VERIFIED-evicted during the abort (no revoked credential left live)", wedgeGone);
    const gateW2 = await observeGate(reg, uidW);
    c("…and only THEN the aborted freeze REOPENED the gate (generation 3 — nothing permanently frozen)",
      gateW2?.row.state === "open" && gateW2?.row.generation === 3, gateW2?.row);
    const succRow = JSON.parse(dec.decode((await authKv.get(credRowKey(uidW, "wsucc001")))!.value)) as { state: string };
    c("…the successor row stays revoked (monotonic; the abort never un-revokes)", succRow.state === "revoked", succRow);
  }

  console.log("K. the staged-mint pins are deep-frozen and the finalize trusts only the module snapshot");
  {
    const actK = await activateLifecycle(reg, { owner: "local", actor: "pins", managerInstance: MGR });
    const uidK = actK.mapping.lifecycleUid;
    const stagedK = await stageAgentMint(reg, { lifecycleUid: uidK, credentialId: "pin00001", holderPrincipal: "local.pins", sourceChain: ["root"], exp: NOW + 60_000 });
    c("every staged pin OBJECT is frozen (not just the array)", stagedK.pins.every((p) => Object.isFrozen(p)));
    let mutationThrew = false;
    try {
      (stagedK.pins[0] as { key: string }).key = "gate.mutated";
    } catch {
      mutationThrew = true;
    }
    c("mutating a pin object THROWS (strict-mode write to a frozen object)", mutationThrew);
    await finalizeAgentMint(reg, stagedK);
    c("…and the untampered finalize still releases from the module-private snapshot", true);
  }

  console.log("L. the history=1 concurrent-overwrite race (the sealed fence-free LastPerSubject scan sees an active→revoked overwrite that EVICTS the pre-scan revision — the exact subject a seq/INFO fence walk drops)");
  {
    const actL = await activateLifecycle(reg, { owner: "local", actor: "raceholder", managerInstance: MGR });
    const uidL = actL.mapping.lifecycleUid;
    await finalizeAgentMint(reg, await stageAgentMint(reg, { lifecycleUid: uidL, credentialId: "root0001", holderPrincipal: "local.raceholder", sourceChain: ["root"], exp: NOW + 60_000 }));
    await finalizeAgentMint(reg, await stageAgentMint(reg, { lifecycleUid: uidL, credentialId: "sib00001", holderPrincipal: "local.raceholder", sourceChain: ["root"], exp: NOW + 60_000 }));
    const racedKey = credRowKey(uidL, "root0001");
    const siblingKey = credRowKey(uidL, "sib00001");
    let raced = false;
    // The probe fires AFTER the LastPerSubject consumer is created (root0001 still ACTIVE) and
    // BEFORE the drain: it revokes root0001, appending a new revision and — under the normative
    // history=1 store — EVICTING the active revision the consumer captured. A seq/INFO fence walk (B
    // captured at scan start) sees the revoked append ABOVE B, drops the subject, and never evicts
    // its holder (the revoker may have crashed after the row write, before eviction — simulated by
    // marking the row revoked without touching connections). The fence-free scan must still return
    // root0001 at its CURRENT (revoked) value and must not lose the untouched sibling.
    const raceScanner = makeLedgerScannerOverConnection(nc, SPACE, {
      afterCreate: async () => { if (!raced) { raced = true; await markLedgerRowRevoked(authKv, racedKey); } },
    });
    const raceReg = await openLifecycleRegistry(nc, SPACE, raceScanner);
    const fam = await enumerateAgentFamily(raceReg, uidL);
    c("the race actually fired (the overwrite happened inside the create→drain window)", raced);
    const racedRow = fam.find((r) => r.key === racedKey);
    const siblingRow = fam.find((r) => r.key === siblingKey);
    c("the fence-free scan SEES the subject overwritten mid-scan (never drops it — a fence walk would)", racedRow !== undefined, fam.map((r) => r.key));
    c("…and returns its CURRENT last (revoked), not the evicted active revision", racedRow?.row.state === "revoked", racedRow?.row);
    c("…and the untouched sibling stays enumerated (active)", siblingRow?.row.state === "active", siblingRow?.row);
  }

  console.log("L2. the mid-drain overwrite (a subject delivered old in round 1, then overwritten, is re-fetched — the drain re-reads num_pending to a fresh zero, never a stale local count)");
  {
    const actL2 = await activateLifecycle(reg, { owner: "local", actor: "midrace", managerInstance: MGR });
    const uidL2 = actL2.mapping.lifecycleUid;
    await finalizeAgentMint(reg, await stageAgentMint(reg, { lifecycleUid: uidL2, credentialId: "root0001", holderPrincipal: "local.midrace", sourceChain: ["root"], exp: NOW + 60_000 }));
    await finalizeAgentMint(reg, await stageAgentMint(reg, { lifecycleUid: uidL2, credentialId: "sib00001", holderPrincipal: "local.midrace", sourceChain: ["root"], exp: NOW + 60_000 }));
    await finalizeAgentMint(reg, await stageAgentMint(reg, { lifecycleUid: uidL2, credentialId: "sib00002", holderPrincipal: "local.midrace", sourceChain: ["root"], exp: NOW + 60_000 }));
    const overwriteKey = credRowKey(uidL2, "root0001");
    let fired = false;
    // The probe fires AFTER the first fetch (which delivers root0001@active among the family), then
    // revokes root0001 — under history=1 its active revision is evicted and a revoked revision
    // appended AFTER the drain's first round. The stale `pending -= got` bug would exit having
    // already "spent" its local count and miss the new revision; the fresh-zero re-read fetches it.
    const midScanner = makeLedgerScannerOverConnection(nc, SPACE, {
      afterFirstFetch: async () => { if (!fired) { fired = true; await markLedgerRowRevoked(authKv, overwriteKey); } },
    });
    const midReg = await openLifecycleRegistry(nc, SPACE, midScanner);
    const famM = await enumerateAgentFamily(midReg, uidL2);
    c("the mid-drain overwrite fired (after the first fetch)", fired);
    c("all three family subjects are enumerated (none dropped by the mid-drain overwrite)", famM.length === 3, famM.map((r) => r.key));
    c("the subject overwritten mid-drain reads its CURRENT last (revoked), fetched on the fresh-zero re-read", famM.find((r) => r.key === overwriteKey)?.row.state === "revoked", famM.find((r) => r.key === overwriteKey)?.row);
  }

  console.log("M. the injected scanner is BRANDED + space-bonded (a hand-assembled or foreign-space scanner never enumerates — it would silently empty a barrier's family)");
  {
    const handAssembled: Parameters<typeof openLifecycleRegistry>[2] = {
      scanCredentialFamily: async () => [],
      scanBysrc: async () => [],
      scanStageFamily: async () => [],
      scanSessions: async () => [],
      close: async () => {},
    };
    await rejects("a HAND-ASSEMBLED structural scanner is rejected at registry open (an empty-family enumeration would let a barrier advance over live holders)",
      () => openLifecycleRegistry(nc!, SPACE, handAssembled), "failed-precondition");
    const foreignScanner = makeLedgerScannerOverConnection(nc, "otherspace");
    await rejects("a FOREIGN-SPACE scanner attached to this space's registry is rejected (the scanner is bonded to its exact space)",
      () => openLifecycleRegistry(nc!, SPACE, foreignScanner), "failed-precondition");
    // HIGH 2 (capability integrity): the branded handle is FROZEN, so a post-brand method swap (the
    // silent-empty scanner the brand alone cannot catch: the WeakMap keys the reference, not the
    // behavior) THROWS instead of surviving a later assertScannerSpace.
    const liveScanner = makeLedgerScannerOverConnection(nc, SPACE);
    let swapDenied = false;
    try { (liveScanner as { scanStageFamily: unknown }).scanStageFamily = async () => []; } catch { swapDenied = true; }
    c("the branded auth scanner is FROZEN: a post-brand silent-empty method swap THROWS", swapDenied && Object.isFrozen(liveScanner));
    // HIGH 3 (fact-5 ENFORCED): two branded same-space instances share the MODULE-LEVEL per-space
    // scan chain, so CONCURRENT scans serialize instead of interleaving pre-clean/create/fetch/
    // delete on the one literal consumer name; both see the identical complete family.
    const [stA, stB] = await Promise.all([liveScanner.scanStageFamily(), makeLedgerScannerOverConnection(nc, SPACE).scanStageFamily()]);
    c("two branded same-space auth scanners scanning CONCURRENTLY return the identical stage family (module-level serialization, fact-5)",
      JSON.stringify(stA.map((r) => `${r.key}@${r.seq}`)) === JSON.stringify(stB.map((r) => `${r.key}@${r.seq}`)), { a: stA.length, b: stB.length });
  }

  await nc.drain().catch(() => {});
} catch (e) {
  fail++;
  console.error("  ✗ scenario threw:", (e as Error).stack ?? (e as Error).message);
} finally {
  for (const conn of [victim1, victim2, servingConn, wedgeConn, sysObserver, sysEvictor]) { try { await conn?.close(); } catch { /* closed */ } }
  broker.kill("SIGKILL"); // exact PID — never pkill nats-server
  await new Promise((r) => broker.once("exit", r));
  rmSync(sd, { recursive: true, force: true });
  releaseBroker(); // last: ownership is held until this teardown has actually finished
}

console.log(fail === 0 ? `\nCREDENTIAL LEDGER SMOKE OK ✅  (${ok} passed, ${fail} failed)` : `\nCREDENTIAL LEDGER SMOKE FAILED ❌  (${ok} passed, ${fail} failed)`);
process.exit(fail > 0 ? 1 : 0);
