/**
 * D13 (1)+(2a) lifecycle-registry smoke — the amended §13.1 model against a real broker:
 * the sealed two-store registry (brand + shape proofs), the space-global create-only
 * never-deleted UID reservation (collision burns, DEL is corruption), the three-state head
 * (`active | retiring | retired`) with active-ONLY currency, the activation saga in the
 * normative order (reserve → gate frozen(op) → head CAS → reopen LAST) with one-winner
 * concurrency, loser gate-terminalization, and failpoint/resume at every boundary, the
 * issuance-gate CAS primitives (create/observe/freeze/op-pinned reopen/retire, monotonic,
 * stranger-proof), and the leader-served mapping reader run under a SCOPED credential that
 * holds exactly the records `STREAM.MSG.GET` (denials proved: no Direct Get, no auth-store
 * read, no head write).
 *
 * Run: pnpm smoke:lifecycle-registry:auth   (needs nats-server on PATH; part of smoke:ci)
 */
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect } from "@nats-io/transport-node";
import { jetstreamManager } from "@nats-io/jetstream";
import { Kvm } from "@nats-io/kv";
import {
  isReachable, EpEnvelopeError, createEndpointStreams, LIFECYCLE_HEAD, UID_RESERVATION,
  recordAtomicKey, mintLifecycleUid, epAuthBucket,
} from "@cotal-ai/core";
import {
  openLifecycleRegistry, openLifecycleMappingReader,
  reserveLifecycleUid, activateLifecycle, resumeActivation,
  observeGate, createGateFrozen, freezeGate, reopenGate, retireGate,
  readLifecycleMappingLeader, lifecycleProcessEpochReader,
  type LifecycleRegistry,
} from "../src/index.js";
import { tryReserveUid } from "../src/lifecycle-registry.js";

let ok = 0, fail = 0;
const c = (n: string, v: boolean, extra?: unknown) => { if (v) { ok++; } else { fail++; console.log("  ✗ FAIL:", n, extra ?? ""); } };
const rejects = async (n: string, fn: () => Promise<unknown> | unknown, code?: string) => {
  try { await fn(); c(n, false, "no throw"); } catch (e) {
    c(n, code === undefined || (e instanceof EpEnvelopeError && e.code === code), `code ${(e as EpEnvelopeError).code ?? (e as Error).message}`);
  }
};
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

const SPACE = "lifereg";
const RECORDS = `cotal_records_${SPACE}`;
const enc = new TextEncoder();
const headKey = (o: string, a: string) => recordAtomicKey(LIFECYCLE_HEAD, [o, a]);
const uidKey = (u: string) => recordAtomicKey(UID_RESERVATION, [u]);

const PORT = 20000 + Math.floor(Math.random() * 40000);
const sd = mkdtempSync(join(tmpdir(), "cotal-lifereg-"));
// A conf broker with a full ADMIN user and a SCOPED mapping-reader user holding exactly the
// records leader read (§13.9: the leader reader must work under scoped trusted credentials,
// not only as admin) — plus $JS.API.INFO for the client's API probe and its own inbox.
writeFileSync(join(sd, "server.conf"), `
port: ${PORT}
listen: 127.0.0.1:${PORT}
jetstream { store_dir: "${sd}" }
authorization {
  users = [
    { user: "admin", password: "pw" }
    { user: "reader", password: "pw", permissions: {
        publish: { allow: ["$JS.API.INFO", "$JS.API.STREAM.MSG.GET.KV_${RECORDS}"] }
        subscribe: { allow: ["_INBOX.>"] }
      } }
  ]
}
`);
const broker = spawn("nats-server", ["-c", join(sd, "server.conf")], { stdio: "ignore" });

try {
  let up = false;
  for (let i = 0; i < 50 && !up; i++) { up = await isReachable(`nats://admin:pw@127.0.0.1:${PORT}`); if (!up) await wait(100); }
  if (!up) throw new Error("broker did not come up");
  const nc = await connect({ servers: `nats://127.0.0.1:${PORT}`, user: "admin", pass: "pw" });
  const MGR = "mgr-1";

  console.log("A. sealed construction + brand");
  await rejects("an unprovisioned space refuses at open (fail-loud, never a lazy bind)",
    () => openLifecycleRegistry(nc, SPACE), "failed-precondition");
  await createEndpointStreams(await jetstreamManager(nc), new Kvm(nc), SPACE);
  const reg = await openLifecycleRegistry(nc, SPACE);
  const reader = await openLifecycleMappingReader(nc, SPACE);
  c("the registry opens over the provisioned primary stores", reg.space === SPACE);
  await rejects("a hand-assembled { space } object never authorizes (the brand is constructed, not asserted)",
    () => reserveLifecycleUid({ space: SPACE } as LifecycleRegistry, { owner: "u_x", actor: "cli", mintedBy: MGR }), "failed-precondition");
  const recordsKv = await new Kvm(nc).open(RECORDS);
  const authKv = await new Kvm(nc).open(epAuthBucket(SPACE));

  console.log("B. the space-global UID reservation (create-only, never-deleted)");
  const u1 = await reserveLifecycleUid(reg, { owner: "u_alice", actor: "cli", mintedBy: MGR });
  c("a fresh reservation wins and persists the audit value", /^[a-z0-9]{26,32}$/.test(u1) && (await recordsKv.get(uidKey(u1))) !== null);
  c("re-reserving the SAME uid burns the candidate (space-global collision detection)",
    (await tryReserveUid(reg, u1, { owner: "u_bob", actor: "cli", mintedBy: MGR })) === "burned");
  {
    const u = await reserveLifecycleUid(reg, { owner: "u_alice", actor: "cli", mintedBy: MGR });
    await recordsKv.delete(uidKey(u));
    c("a DEL marker on a reservation still burns (create-only over the ENTIRE history; deletion is corruption, never reusable absence)",
      (await tryReserveUid(reg, u, { owner: "u_alice", actor: "cli", mintedBy: MGR })) === "burned");
  }

  console.log("C. the activation saga (reserve → gate frozen → head CAS → reopen LAST)");
  const act = await activateLifecycle(reg, { owner: "u_alice", actor: "cli", managerInstance: MGR });
  c("a virgin alias activates: head active at epoch 1, no credential id yet",
    act.mapping.state === "active" && act.mapping.processEpoch === 1 && act.mapping.currentCredentialId === undefined, act.mapping);
  c("…its uid is space-globally reserved", (await recordsKv.get(uidKey(act.mapping.lifecycleUid))) !== null);
  {
    const g = await observeGate(reg, act.mapping.lifecycleUid);
    c("…and its gate ends OPEN at the first mintable generation (reopened LAST, op cleared)",
      g !== undefined && g.row.state === "open" && g.row.generation === 1 && g.row.op === undefined, g?.row);
  }
  {
    const read = await readLifecycleMappingLeader(reader, "u_alice", "cli");
    c("the leader read returns { mapping, revision } with the STORE revision as mappingRevision",
      read !== undefined && read.mapping.lifecycleUid === act.mapping.lifecycleUid && read.revision === act.revision, read);
    c("the epoch seam yields the active epoch", (await lifecycleProcessEpochReader(reader, "u_alice", "cli")) === 1);
    c("…and undefined for an absent alias", (await lifecycleProcessEpochReader(reader, "u_ghost", "cli")) === undefined);
  }
  await rejects("re-activating an ACTIVE alias refuses (a takeover advances the epoch through its barrier)",
    () => activateLifecycle(reg, { owner: "u_alice", actor: "cli", managerInstance: MGR }), "already-exists");
  {
    // Concurrent virgin activation: exactly one wins the head CAS; the loser terminalizes its
    // own orphan gate and its uid stays burned (both reservations exist forever).
    const results = await Promise.allSettled([
      activateLifecycle(reg, { owner: "u_bob", actor: "cli", managerInstance: MGR }),
      activateLifecycle(reg, { owner: "u_bob", actor: "cli", managerInstance: MGR }),
    ]);
    const wins = results.filter((r) => r.status === "fulfilled");
    const losses = results.filter((r) => r.status === "rejected" && (r.reason as EpEnvelopeError)?.code === "conflict");
    c("concurrent same-alias activation yields exactly ONE winner (the loser is a loud conflict)",
      wins.length === 1 && losses.length === 1, { wins: wins.length, losses: losses.length });
    const winnerUid = wins.length === 1 ? (wins[0] as PromiseFulfilledResult<Awaited<ReturnType<typeof activateLifecycle>>>).value.mapping.lifecycleUid : "";
    const gates: { uid: string; state: string }[] = [];
    for await (const k of await authKv.keys("gate.>")) {
      const e = await authKv.get(k);
      if (e && e.operation === "PUT") gates.push({ uid: k.slice("gate.".length), state: (JSON.parse(new TextDecoder().decode(e.value)) as { state: string }).state });
    }
    const bobGates = gates.filter((g) => g.uid !== act.mapping.lifecycleUid);
    c("the loser's orphan gate is TERMINALIZED and the winner's is open (never deleted, never reused)",
      bobGates.length === 2 && bobGates.some((g) => g.uid === winnerUid && g.state === "open") && bobGates.some((g) => g.uid !== winnerUid && g.state === "retired"), bobGates);
  }

  console.log("D. failpoint recovery (resume the SAME op; a stranger cannot advance a freeze)");
  {
    // Crash after step 2 (gate frozen, head never CASed): resume settles by terminalizing.
    const opId = mintLifecycleUid();
    const uid = await reserveLifecycleUid(reg, { owner: "u_carol", actor: "cli", mintedBy: MGR });
    await createGateFrozen(reg, { lifecycleUid: uid, op: { opId, kind: "activation" } });
    c("resume of a pre-head-CAS crash terminalizes the orphan (the uid stays burned; a fresh attempt is a NEW op)",
      (await resumeActivation(reg, { owner: "u_carol", actor: "cli", lifecycleUid: uid, opId })) === "terminalized");
    c("…idempotently", (await resumeActivation(reg, { owner: "u_carol", actor: "cli", lifecycleUid: uid, opId })) === "already-settled");
  }
  {
    // Crash after step 3 (head CASed, gate still frozen): resume COMPLETES the same op.
    const opId = mintLifecycleUid();
    const uid = await reserveLifecycleUid(reg, { owner: "u_dan", actor: "cli", mintedBy: MGR });
    const gate = await createGateFrozen(reg, { lifecycleUid: uid, op: { opId, kind: "activation" } });
    await recordsKv.put(headKey("u_dan", "cli"), enc.encode(JSON.stringify({ owner: "u_dan", actor: "cli", lifecycleUid: uid, managerInstance: MGR, processEpoch: 1, state: "active" })), { previousSeq: 0 });
    await rejects("a STRANGER's opId cannot reopen the freeze (op-pinned; the opId is not a bearer capability but the pin is exact)",
      () => resumeActivation(reg, { owner: "u_dan", actor: "cli", lifecycleUid: uid, opId: mintLifecycleUid() }), "permission-denied");
    c("resume of a post-head-CAS crash COMPLETES the activation (reopen is the last step; never a second uid)",
      (await resumeActivation(reg, { owner: "u_dan", actor: "cli", lifecycleUid: uid, opId })) === "completed");
    const g = await observeGate(reg, uid);
    c("…leaving the gate open at generation 1", g !== undefined && g.row.state === "open" && g.row.generation === 1, { gateRev: gate.revision, row: g?.row });
    c("…and the alias current", (await lifecycleProcessEpochReader(reader, "u_dan", "cli")) === 1);
  }

  console.log("E. head states + active-only currency + fail-closed parse");
  {
    // Hand-write a RETIRING head (the barrier's containment phase) and prove non-currency +
    // non-replaceability; then RETIRED and prove reactivation mints a FRESH uid.
    const cur = await recordsKv.get(headKey("u_alice", "cli"));
    const opId = mintLifecycleUid();
    await recordsKv.put(headKey("u_alice", "cli"), enc.encode(JSON.stringify({ owner: "u_alice", actor: "cli", lifecycleUid: act.mapping.lifecycleUid, managerInstance: MGR, processEpoch: 1, state: "retiring", op: { opId, kind: "retirement" } })), { previousSeq: cur!.revision });
    c("a RETIRING head still leader-reads (the mapping is visible; currency is the seam's rule)",
      (await readLifecycleMappingLeader(reader, "u_alice", "cli"))?.mapping.state === "retiring");
    c("…but yields NO current epoch (retiring is non-current for every currency seam)",
      (await lifecycleProcessEpochReader(reader, "u_alice", "cli")) === undefined);
    await rejects("…and the alias is NOT replaceable while retiring (activation refuses until the barrier completes)",
      () => activateLifecycle(reg, { owner: "u_alice", actor: "cli", managerInstance: MGR }), "failed-precondition");
    const cur2 = await recordsKv.get(headKey("u_alice", "cli"));
    await recordsKv.put(headKey("u_alice", "cli"), enc.encode(JSON.stringify({ owner: "u_alice", actor: "cli", lifecycleUid: act.mapping.lifecycleUid, managerInstance: MGR, processEpoch: 1, state: "retired" })), { previousSeq: cur2!.revision });
    c("a RETIRED head yields no current epoch either", (await lifecycleProcessEpochReader(reader, "u_alice", "cli")) === undefined);
    const re = await activateLifecycle(reg, { owner: "u_alice", actor: "cli", managerInstance: MGR });
    c("re-activating the retired alias mints a FRESH reserved uid (retired→active same-uid is impossible by construction)",
      re.mapping.lifecycleUid !== act.mapping.lifecycleUid && (await recordsKv.get(uidKey(act.mapping.lifecycleUid))) !== null, { old: act.mapping.lifecycleUid, fresh: re.mapping.lifecycleUid });
  }
  {
    const put = (o: string, v: unknown) => recordsKv.put(headKey(o, "cli"), enc.encode(JSON.stringify(v)));
    await put("u_e1", { owner: "u_e1", actor: "cli", lifecycleUid: "a".repeat(26), managerInstance: MGR, processEpoch: 1, state: "retiring" });
    await rejects("a retiring head WITHOUT its op intent refuses (retiring is op-bound)",
      () => readLifecycleMappingLeader(reader, "u_e1", "cli"), "internal");
    await put("u_e2", { owner: "u_e2", actor: "cli", lifecycleUid: "a".repeat(26), managerInstance: MGR, processEpoch: 1, state: "active", op: { opId: "b".repeat(26), kind: "retirement" } });
    await rejects("an ACTIVE head carrying an op intent refuses (only retiring is op-bound)",
      () => readLifecycleMappingLeader(reader, "u_e2", "cli"), "internal");
    await put("u_e3", { owner: "u_EVIL", actor: "cli", lifecycleUid: "a".repeat(26), managerInstance: MGR, processEpoch: 1, state: "active" });
    await rejects("a key-mismatched head (embedded owner ≠ key) never authorizes",
      () => readLifecycleMappingLeader(reader, "u_e3", "cli"), "internal");
    await put("u_e4", { owner: "u_e4", actor: "cli", lifecycleUid: "a".repeat(26), managerInstance: MGR, processEpoch: 1, state: "active", extra: true });
    await rejects("an unknown head field refuses (closed schema)",
      () => readLifecycleMappingLeader(reader, "u_e4", "cli"), "internal");
    await put("u_e5", { owner: "u_e5", actor: "cli", lifecycleUid: "a".repeat(26), managerInstance: MGR, processEpoch: 1, state: "active" });
    await recordsKv.delete(headKey("u_e5", "cli"));
    await rejects("a DEL marker on the head refuses loudly at the leader read (deletion is corruption, never absence)",
      () => readLifecycleMappingLeader(reader, "u_e5", "cli"), "failed-precondition");
    await rejects("…and refuses the activation path's candidate read too (never recreate over a tombstone)",
      () => activateLifecycle(reg, { owner: "u_e5", actor: "cli", managerInstance: MGR }), "failed-precondition");
  }

  console.log("F. the gate CAS primitives (monotonic, op-pinned, terminal)");
  {
    const uid = await reserveLifecycleUid(reg, { owner: "u_gate", actor: "cli", mintedBy: MGR });
    const opA = mintLifecycleUid(), opT = mintLifecycleUid(), opR = mintLifecycleUid();
    const g0 = await createGateFrozen(reg, { lifecycleUid: uid, op: { opId: opA, kind: "activation" } });
    c("the gate is born FROZEN at generation 0 under its op intent", g0.row.state === "frozen" && g0.row.generation === 0);
    await rejects("creating it twice refuses (create-only)", () => createGateFrozen(reg, { lifecycleUid: uid, op: { opId: opA, kind: "activation" } }), "conflict");
    await rejects("a stranger cannot reopen the freeze", () => reopenGate(reg, { lifecycleUid: uid, revision: g0.revision, opId: opT }), "permission-denied");
    const g1 = await reopenGate(reg, { lifecycleUid: uid, revision: g0.revision, opId: opA });
    c("the owning op reopens to generation 1 (op cleared)", g1.row.state === "open" && g1.row.generation === 1 && g1.row.op === undefined);
    await rejects("reopening an OPEN gate refuses (there is no freeze)", () => reopenGate(reg, { lifecycleUid: uid, revision: g1.revision, opId: opA }), "failed-precondition");
    const g2 = await freezeGate(reg, { lifecycleUid: uid, revision: g1.revision, op: { opId: opT, kind: "takeover" } });
    c("open → frozen carries the freezing op", g2.row.state === "frozen" && g2.row.op?.opId === opT);
    await rejects("freezing an already-frozen gate refuses (the freeze belongs to its own operation)",
      () => freezeGate(reg, { lifecycleUid: uid, revision: g2.revision, op: { opId: opR, kind: "retirement" } }), "failed-precondition");
    const g3 = await reopenGate(reg, { lifecycleUid: uid, revision: g2.revision, opId: opT });
    c("the takeover reopen advances the generation (1 → 2)", g3.row.generation === 2);
    await rejects("a STALE-revision freeze loses its CAS loudly (serialization on one key)",
      () => freezeGate(reg, { lifecycleUid: uid, revision: g2.revision, op: { opId: opR, kind: "retirement" } }), "conflict");
    const g4 = await freezeGate(reg, { lifecycleUid: uid, revision: g3.revision, op: { opId: opR, kind: "retirement" } });
    await rejects("a stranger cannot terminalize another op's freeze", () => retireGate(reg, { lifecycleUid: uid, revision: g4.revision, opId: opA }), "permission-denied");
    const g5 = await retireGate(reg, { lifecycleUid: uid, revision: g4.revision, opId: opR });
    c("frozen → retired is terminal and keeps the terminalizing op (audit)", g5.row.state === "retired" && g5.row.op?.opId === opR);
    c("retire is idempotent at terminal", (await retireGate(reg, { lifecycleUid: uid, revision: g5.revision, opId: opR })).row.state === "retired");
    await rejects("a retired gate never reopens (terminal; unlike takeover, retirement never reopens)",
      () => reopenGate(reg, { lifecycleUid: uid, revision: g5.revision, opId: opR }), "failed-precondition");
    await rejects("…and never re-freezes", () => freezeGate(reg, { lifecycleUid: uid, revision: g5.revision, op: { opId: opT, kind: "takeover" } }), "failed-precondition");
  }
  {
    const uid = "c".repeat(26);
    await authKv.put(`gate.${uid}`, enc.encode(JSON.stringify({ lifecycleUid: uid, state: "open", generation: 1, op: { opId: "d".repeat(26), kind: "takeover" } })));
    await rejects("an OPEN gate carrying an op intent refuses at parse (only frozen/retired are op-bound)",
      () => observeGate(reg, uid), "internal");
    const uid2 = "e".repeat(26);
    await authKv.put(`gate.${uid2}`, enc.encode(JSON.stringify({ lifecycleUid: "f".repeat(26), state: "open", generation: 1 })));
    await rejects("a key-mismatched gate (embedded uid ≠ key) never authorizes", () => observeGate(reg, uid2), "internal");
    const uid3 = "g".repeat(26);
    await authKv.put(`gate.${uid3}`, enc.encode(JSON.stringify({ lifecycleUid: uid3, state: "frozen", generation: 0, op: { opId: "h".repeat(26), kind: "activation" } })));
    await authKv.delete(`gate.${uid3}`);
    await rejects("a DEL marker on a gate refuses loudly (a gate is never deleted)", () => observeGate(reg, uid3), "failed-precondition");
  }

  console.log("G. the leader reader under a SCOPED credential (not admin) + denials");
  {
    const ncReader = await connect({ servers: `nats://127.0.0.1:${PORT}`, user: "reader", pass: "pw" });
    const scopedReader = await openLifecycleMappingReader(ncReader, SPACE);
    const read = await readLifecycleMappingLeader(scopedReader, "u_dan", "cli");
    c("the leader-served mapping read WORKS under the scoped reader credential (records STREAM.MSG.GET only)",
      read !== undefined && read.mapping.state === "active", read?.mapping);
    c("…and the epoch seam works scoped too", (await lifecycleProcessEpochReader(scopedReader, "u_dan", "cli")) === 1);
    await rejects("the scoped reader CANNOT Direct Get the head (the follower path is not granted)",
      () => ncReader.request(`$JS.API.DIRECT.GET.KV_${RECORDS}`, enc.encode(JSON.stringify({ last_by_subj: `$KV.${RECORDS}.${headKey("u_dan", "cli")}` })), { timeout: 1500 }));
    await rejects("the scoped reader CANNOT read the AUTH store (no gate visibility)",
      () => ncReader.request(`$JS.API.STREAM.MSG.GET.KV_${epAuthBucket(SPACE)}`, enc.encode(JSON.stringify({ last_by_subj: `$KV.${epAuthBucket(SPACE)}.gate.${"c".repeat(26)}` })), { timeout: 1500 }));
    {
      const before = await readLifecycleMappingLeader(reader, "u_dan", "cli");
      ncReader.publish(`$KV.${RECORDS}.${headKey("u_dan", "cli")}`, enc.encode("{}"));
      await ncReader.flush().catch(() => {});
      await wait(300);
      const after = await readLifecycleMappingLeader(reader, "u_dan", "cli");
      c("the scoped reader CANNOT write a head (the denied publish never lands; the revision is unmoved)",
        before !== undefined && after !== undefined && after.revision === before.revision, { before: before?.revision, after: after?.revision });
    }
    await ncReader.close().catch(() => {});
  }

  await nc.drain().catch(() => {});
} finally {
  broker.kill("SIGKILL");
  await new Promise((r) => broker.once("exit", r));
  rmSync(sd, { recursive: true, force: true });
}

console.log(fail === 0 ? `\nLIFECYCLE REGISTRY SMOKE OK ✅  (${ok} passed, ${fail} failed)` : `\nLIFECYCLE REGISTRY SMOKE FAILED ❌  (${ok} passed, ${fail} failed)`);
if (fail > 0) process.exit(1);
