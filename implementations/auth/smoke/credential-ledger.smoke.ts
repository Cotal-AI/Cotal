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
import {
  isReachable, EpEnvelopeError, createEndpointStreams, mintLifecycleUid, epAuthBucket,
  evictDeniedPrincipal, MEMBERSHIP_INBOX_PREFIX,
} from "@cotal-ai/core";
import { openLifecycleRegistry } from "../src/index.js";
import { activateLifecycle, observeGate, readLifecycleHeadForOperation } from "../src/lifecycle-registry.js";
import {
  stageAgentMint, finalizeAgentMint, enumerateAgentFamily,
  createSourceGateOpen, observeSourceGate, freezeSourceGate, revokeHandleSource,
  runAgentTakeoverBarrier, resumeAgentTakeover,
  credRowKey, srcgateKey, stageIntentKey,
  type EvictPrincipal,
} from "../src/credential-ledger.js";

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

const PORT = 20000 + Math.floor(Math.random() * 40000);
const sd = mkdtempSync(join(tmpdir(), "cotal-credledger-"));
// A conf broker with a REAL system account (CONNZ + KICK live) and an APP account holding the
// trusted-auth user plus two victim users whose usernames are principal NAME-forms — CONNZ
// surfaces a static user's name as `authorized_user`, which `principalFromConnz` resolves to
// `local.victim` / `local.victim2`, the same dot-forms the ledger rows carry.
writeFileSync(join(sd, "server.conf"), `
port: ${PORT}
listen: 127.0.0.1:${PORT}
jetstream { store_dir: "${sd}" }
system_account: SYS
accounts {
  SYS: { users = [ { user: "sys", password: "pw" } ] }
  APP: {
    jetstream: enabled
    users = [
      { user: "auth", password: "pw" }
      { user: "local-victim", password: "pw", permissions: { publish: { allow: ["victim.>"] }, subscribe: { allow: ["victim.>", "_INBOX.>"] } } }
      { user: "local-victim2", password: "pw", permissions: { publish: { allow: ["victim.>"] }, subscribe: { allow: ["victim.>", "_INBOX.>"] } } }
    ]
  }
}
`);
const broker = spawn("nats-server", ["-c", join(sd, "server.conf")], { stdio: "ignore" });

let nc: NatsConnection | undefined, sysObserver: NatsConnection | undefined, sysEvictor: NatsConnection | undefined,
  victim1: NatsConnection | undefined, victim2: NatsConnection | undefined;
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
  const reg = await openLifecycleRegistry(nc, SPACE);
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
  const res1 = await runAgentTakeoverBarrier(reg, { owner: "local", actor: "victim", lifecycleUid: uid1, opId: op1 }, liveEvict);
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
    const again = await resumeAgentTakeover(reg, op1, liveEvict);
    c("resuming the COMPLETED operation is idempotent (same coordinates, no second advance)",
      again.toEpoch === 2 && again.toGeneration === 2, again);
    const head = await readLifecycleHeadForOperation(reg, "local", "victim");
    c("…the epoch did not move again", head?.mapping.processEpoch === 2);
  }
  await rejects("a STRANGER's opId resumes nothing (no intent, not-found)",
    () => resumeAgentTakeover(reg, mintLifecycleUid(), liveEvict), "not-found");
  await rejects("an opId whose intent names a DIFFERENT lifecycle refuses (an opId resumes only its own operation)",
    () => runAgentTakeoverBarrier(reg, { owner: "local", actor: "victim", lifecycleUid: "y".repeat(26), opId: op1 }, liveEvict), "permission-denied");

  console.log("D. the FAIL-CLOSED eviction path (gate stays frozen, epoch does not advance)");
  {
    const op2 = mintLifecycleUid();
    const failingEvict: EvictPrincipal = async (principal) => ({ principal, kicked: 0, remaining: 1, verifiedGone: false, scanComplete: true, note: "simulated partial eviction" });
    await rejects("a barrier whose eviction cannot VERIFY fails loud (unavailable)",
      () => runAgentTakeoverBarrier(reg, { owner: "local", actor: "victim", lifecycleUid: uid1, opId: op2 }, failingEvict), "unavailable");
    const gate = await observeGate(reg, uid1);
    c("…the gate STAYS FROZEN under the failed operation (nothing mints)",
      gate !== undefined && gate.row.state === "frozen" && gate.row.op?.opId === op2, gate?.row);
    const head = await readLifecycleHeadForOperation(reg, "local", "victim");
    c("…and the epoch did NOT advance (containment before authority)", head?.mapping.processEpoch === 2);
    await rejects("a mint under the frozen gate refuses (the barrier's bar holds while unresolved)",
      () => stageAgentMint(reg, { lifecycleUid: uid1, credentialId: "root0002", holderPrincipal: "local.victim", sourceChain: ["root"], exp: NOW + 60_000 }), "permission-denied");
    const resumed = await resumeAgentTakeover(reg, op2, liveEvict);
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
    const walk = await revokeHandleSource(reg, { issuerKeyId: "k1", id: "h1" }, liveEvict);
    c("the walk froze the source gate, revoked the descendant, and verified eviction of its holder",
      walk.evictedPrincipals.includes("local.victim2"), walk);
    const dropped = await until(() => v2Closed || victim2!.isClosed(), 2500);
    c("victim2's LIVE connection was actually KICKed by the handle revocation", dropped, { v2Closed });
    const row = JSON.parse(dec.decode((await authKv.get(credRowKey(uid2, "hcred010")))!.value)) as { state: string };
    c("…the descendant row under the OTHER lifecycle is revoked (parent revocation reaches it via bysrc)", row.state === "revoked", row);
    const src = await observeSourceGate(reg, { issuerKeyId: "k1", id: "h1" });
    c("…the source gate is frozen forever (a revoked handle never mints again)", src?.row.state === "frozen", src?.row);
    const resumeWalk = await revokeHandleSource(reg, { issuerKeyId: "k1", id: "h1" }, liveEvict);
    c("re-running the walk is idempotent (already-frozen gate resumes, rows already revoked)",
      resumeWalk.revokedRows === 0 && resumeWalk.evictedPrincipals.includes("local.victim2"), resumeWalk);
    await rejects("revoking a handle with NO source gate is not-found",
      () => revokeHandleSource(reg, { issuerKeyId: "k1", id: "never" }, liveEvict), "not-found");
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

  await nc.drain().catch(() => {});
} catch (e) {
  fail++;
  console.error("  ✗ scenario threw:", (e as Error).stack ?? (e as Error).message);
} finally {
  for (const conn of [victim1, victim2, sysObserver, sysEvictor]) { try { await conn?.close(); } catch { /* closed */ } }
  broker.kill("SIGKILL"); // exact PID — never pkill nats-server
  await new Promise((r) => broker.once("exit", r));
  rmSync(sd, { recursive: true, force: true });
}

console.log(fail === 0 ? `\nCREDENTIAL LEDGER SMOKE OK ✅  (${ok} passed, ${fail} failed)` : `\nCREDENTIAL LEDGER SMOKE FAILED ❌  (${ok} passed, ${fail} failed)`);
process.exit(fail > 0 ? 1 : 0);
