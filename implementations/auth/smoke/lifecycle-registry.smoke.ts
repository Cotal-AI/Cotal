/**
 * D13 (1)+(2a) lifecycle-registry smoke — the amended §13.1 model against a real broker:
 * the sealed two-store registry (brand + FULL shape proofs on BOTH stores: primary,
 * un-aged, no finite global eviction cap), the space-global create-only never-deleted UID
 * reservation (collision burns, DEL is corruption), the three-state head
 * (`active | retiring | retired`) with active-ONLY currency, the activation saga in the
 * normative order (reserve → gate frozen(op) → head CAS → reopen LAST) with one-winner
 * concurrency, loser gate-terminalization, and failpoint/resume at every boundary, the
 * issuance-gate CAS primitives (create/observe/freeze/op-pinned reopen/retire, monotonic,
 * stranger-proof, and the PER-KIND transition table: born only by activation over a won
 * reservation, retirement never reopens, takeover/registration never terminalize, terminal
 * idempotence is same-op), the leader-served mapping reader run under a SCOPED credential
 * (records `STREAM.MSG.GET` + the bind-time `STREAM.INFO` shape proof, a CONNECTION-scoped
 * inbox; denials proved: no Direct Get, no auth-store read, no head write, no foreign
 * inbox), and the full minting profile run SCOPED end-to-end (never only as admin).
 *
 * The saga + gate primitives are package-internal (SPEC surface honesty), so this smoke
 * imports them from the module; the package index exports only the sealed opens + reads.
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
  readLifecycleMappingLeader, lifecycleProcessEpochReader,
  type LifecycleRegistry,
} from "../src/index.js";
import {
  tryReserveUid, reserveLifecycleUid, activateLifecycle, resumeActivation,
  observeGate, createGateFrozen, freezeGate, reopenGate, retireGate,
} from "../src/lifecycle-registry.js";

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
// A conf broker with a full ADMIN user, a SCOPED mapping-reader user (records leader read +
// the bind-time STREAM.INFO shape proof, §13.9; a CONNECTION-scoped inbox, never the
// account-wide default), and a SCOPED minting-profile WRITER user (the registry's real
// authority: store opens + shape proofs, records Direct Get candidate reads, auth leader
// reads, and the two KV write families — nothing else, no consumer create, no stream admin).
writeFileSync(join(sd, "server.conf"), `
port: ${PORT}
listen: 127.0.0.1:${PORT}
jetstream { store_dir: "${sd}" }
authorization {
  users = [
    { user: "admin", password: "pw" }
    { user: "reader", password: "pw", permissions: {
        publish: { allow: ["$JS.API.INFO", "$JS.API.STREAM.MSG.GET.KV_${RECORDS}", "$JS.API.STREAM.INFO.KV_${RECORDS}"] }
        subscribe: { allow: ["_INBOX_rdr.>"] }
      } }
    { user: "writer", password: "pw", permissions: {
        publish: { allow: [
          "$JS.API.INFO",
          "$JS.API.STREAM.INFO.KV_${RECORDS}", "$JS.API.STREAM.INFO.KV_cotal_auth_${SPACE}",
          "$JS.API.DIRECT.GET.KV_${RECORDS}", "$JS.API.DIRECT.GET.KV_${RECORDS}.>",
          "$JS.API.STREAM.MSG.GET.KV_${RECORDS}", "$JS.API.STREAM.MSG.GET.KV_cotal_auth_${SPACE}",
          "$KV.${RECORDS}.>", "$KV.cotal_auth_${SPACE}.>"
        ] }
        subscribe: { allow: ["_INBOX_wrt.>"] }
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
  {
    // The shape proofs are executable, not prose (SPEC 13.12): a store whose config can
    // silently evict a never-deleted authority row refuses at bind, on BOTH consuming seams.
    const jsm = await jetstreamManager(nc);
    const kvm = new Kvm(nc);
    await createEndpointStreams(jsm, kvm, "shapecap");
    const capRecords = (await jsm.streams.info("KV_cotal_records_shapecap")).config;
    await jsm.streams.update("KV_cotal_records_shapecap", { ...capRecords, max_msgs: 1 });
    await rejects("a records store with a finite global message cap (silent discard-old eviction) refuses at registry bind",
      () => openLifecycleRegistry(nc, "shapecap"), "failed-precondition");
    await rejects("…and at the mapping-reader bind (the reader shape-proves its store too)",
      () => openLifecycleMappingReader(nc, "shapecap"), "failed-precondition");
    await jsm.streams.update("KV_cotal_records_shapecap", { ...capRecords });
    const capAuth = (await jsm.streams.info("KV_cotal_auth_shapecap")).config;
    await jsm.streams.update("KV_cotal_auth_shapecap", { ...capAuth, max_bytes: 1024 });
    await rejects("an auth store with a finite global byte cap refuses at registry bind (BOTH stores are proved)",
      () => openLifecycleRegistry(nc, "shapecap"), "failed-precondition");
    await jsm.streams.add({ ...capRecords, name: "KV_cotal_records_shapemir", subjects: undefined, mirror: { name: "KV_cotal_records_shapecap" } } as never);
    // A VALID auth store for the mirror space, so the mirror check is the ONLY refusal cause.
    await jsm.streams.add({ ...capAuth, name: "KV_cotal_auth_shapemir", subjects: ["$KV.cotal_auth_shapemir.>"] });
    await rejects("a MIRRORED records store refuses at bind (a follower copy never serves authority)",
      () => openLifecycleRegistry(nc, "shapemir"), "failed-precondition");
    // RETENTION: an Interest/WorkQueue-retention stream deletes rows on consumer interest/ack —
    // the barrier's own throwaway enumeration consumer would trigger the deletion. Refuse at bind.
    await createEndpointStreams(jsm, kvm, "shaperet");
    const retRecords = (await jsm.streams.info("KV_cotal_records_shaperet")).config;
    await jsm.streams.update("KV_cotal_records_shaperet", { ...retRecords, retention: "interest" as never });
    await rejects("a records store with INTEREST retention refuses at bind (non-Limits deletes authority rows on ack)",
      () => openLifecycleRegistry(nc, "shaperet"), "failed-precondition");
  }

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
    await rejects("a STRANGER cannot claim the terminal as its own settlement (terminal idempotence is same-op)",
      () => resumeActivation(reg, { owner: "u_carol", actor: "cli", lifecycleUid: uid, opId: mintLifecycleUid() }), "permission-denied");
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
    const uid4 = "i".repeat(26);
    await authKv.put(`gate.${uid4}`, enc.encode(JSON.stringify({ lifecycleUid: uid4, state: "retired", generation: 1 })));
    await rejects("a RETIRED gate without its terminalizing op refuses at parse (retired retains the op as audit)",
      () => observeGate(reg, uid4), "internal");
    const uid5 = "j".repeat(26);
    await authKv.put(`gate.${uid5}`, enc.encode(JSON.stringify({ lifecycleUid: uid5, state: "frozen", generation: 0, op: { opId: "k".repeat(26), kind: "activation", successor: "x" } })));
    await rejects("an ACTIVATION op carrying a successor refuses at parse (per-kind: only takeover/registration stage successors)",
      () => observeGate(reg, uid5), "internal");
    // IMPOSSIBLE persisted state: a `retired` gate under a takeover/registration kind can never
    // be produced by any writer (only activation-orphan/retirement terminalize), so a hand-written
    // one must refuse at PARSE — never be returned as a settled terminal by the idempotence path.
    const uid6 = "l".repeat(26);
    await authKv.put(`gate.${uid6}`, enc.encode(JSON.stringify({ lifecycleUid: uid6, state: "retired", generation: 2, op: { opId: "m".repeat(26), kind: "takeover" } })));
    await rejects("a RETIRED gate under a TAKEOVER kind refuses at parse (impossible state fails closed, never a same-op terminal success)",
      () => observeGate(reg, uid6), "internal");
    await rejects("…and retireGate over that corrupt retired row refuses too (the parse guard protects the idempotence path)",
      () => retireGate(reg, { lifecycleUid: uid6, revision: 1, opId: "m".repeat(26) }), "internal");
  }
  {
    // The PER-KIND transition table (SPEC 13.1), each refused transition proved live.
    const uidT = await reserveLifecycleUid(reg, { owner: "u_kind", actor: "cli", mintedBy: MGR });
    await rejects("a gate cannot be BORN under a non-activation intent (other operations freeze an EXISTING gate)",
      () => (createGateFrozen as (r: LifecycleRegistry, a: { lifecycleUid: string; op: { opId: string; kind: string } }) => Promise<unknown>)(reg, { lifecycleUid: uidT, op: { opId: mintLifecycleUid(), kind: "takeover" } }), "failed-precondition");
    await rejects("a gate cannot be created over an UNRESERVED uid (the reservation is won BEFORE any gate write)",
      () => createGateFrozen(reg, { lifecycleUid: mintLifecycleUid(), op: { opId: mintLifecycleUid(), kind: "activation" } }), "failed-precondition");
    const opAct = mintLifecycleUid(), opRet = mintLifecycleUid(), opStr = mintLifecycleUid();
    const born = await createGateFrozen(reg, { lifecycleUid: uidT, op: { opId: opAct, kind: "activation" } });
    const opened = await reopenGate(reg, { lifecycleUid: uidT, revision: born.revision, opId: opAct });
    const retFrozen = await freezeGate(reg, { lifecycleUid: uidT, revision: opened.revision, op: { opId: opRet, kind: "retirement" } });
    await rejects("a RETIREMENT freeze never reopens, even for the OWNING op (its only exit is the terminal)",
      () => reopenGate(reg, { lifecycleUid: uidT, revision: retFrozen.revision, opId: opRet }), "failed-precondition");
    const retired = await retireGate(reg, { lifecycleUid: uidT, revision: retFrozen.revision, opId: opRet });
    await rejects("a STRANGER's retry on a TERMINAL gate refuses (terminal idempotence is same-op, never a success)",
      () => retireGate(reg, { lifecycleUid: uidT, revision: retired.revision, opId: opStr }), "permission-denied");
    const uidK = await reserveLifecycleUid(reg, { owner: "u_kind2", actor: "cli", mintedBy: MGR });
    const opAct2 = mintLifecycleUid(), opTak2 = mintLifecycleUid();
    const born2 = await createGateFrozen(reg, { lifecycleUid: uidK, op: { opId: opAct2, kind: "activation" } });
    const opened2 = await reopenGate(reg, { lifecycleUid: uidK, revision: born2.revision, opId: opAct2 });
    const takFrozen = await freezeGate(reg, { lifecycleUid: uidK, revision: opened2.revision, op: { opId: opTak2, kind: "takeover", successor: "gen-2" } });
    c("a takeover freeze may carry its successor summary (per-kind, SPEC 13.1)", takFrozen.row.op?.successor === "gen-2");
    await rejects("a TAKEOVER freeze never terminalizes (it aborts by reopening)",
      () => retireGate(reg, { lifecycleUid: uidK, revision: takFrozen.revision, opId: opTak2 }), "failed-precondition");
    const reopened2 = await reopenGate(reg, { lifecycleUid: uidK, revision: takFrozen.revision, opId: opTak2 });
    await rejects("a RETIREMENT freeze refuses a successor (a retirement has none)",
      () => freezeGate(reg, { lifecycleUid: uidK, revision: reopened2.revision, op: { opId: mintLifecycleUid(), kind: "retirement", successor: "x" } }), "failed-precondition");
    await rejects("a takeover freeze with an EMPTY successor token refuses BEFORE the CAS (never persist corruption)",
      () => freezeGate(reg, { lifecycleUid: uidK, revision: reopened2.revision, op: { opId: mintLifecycleUid(), kind: "takeover", successor: "" } }), "failed-precondition");
    const uidD = await reserveLifecycleUid(reg, { owner: "u_kind3", actor: "cli", mintedBy: MGR });
    await createGateFrozen(reg, { lifecycleUid: uidD, op: { opId: mintLifecycleUid(), kind: "activation" } });
    await authKv.delete(`gate.${uidD}`);
    await rejects("a gate is never recreated over a DEL marker (create-only over the ENTIRE history, symmetric to the uid burn)",
      () => createGateFrozen(reg, { lifecycleUid: uidD, op: { opId: mintLifecycleUid(), kind: "activation" } }), "conflict");
  }

  console.log("G. the leader reader under a SCOPED credential (not admin) + denials");
  {
    const ncReader = await connect({ servers: `nats://127.0.0.1:${PORT}`, user: "reader", pass: "pw", inboxPrefix: "_INBOX_rdr" });
    const scopedReader = await openLifecycleMappingReader(ncReader, SPACE);
    const read = await readLifecycleMappingLeader(scopedReader, "u_dan", "cli");
    c("the leader-served mapping read WORKS under the scoped reader credential (records STREAM.MSG.GET + the bind-time STREAM.INFO proof, a connection-scoped inbox)",
      read !== undefined && read.mapping.state === "active", read?.mapping);
    {
      // The inbox is CONNECTION-scoped: the same credential under a foreign inbox prefix
      // never receives an API reply, so the reader fails closed instead of serving.
      const ncForeign = await connect({ servers: `nats://127.0.0.1:${PORT}`, user: "reader", pass: "pw", inboxPrefix: "_INBOX_other", timeout: 3000 });
      await rejects("a FOREIGN inbox prefix under the reader credential fails closed at bind (the subscribe grant is inbox-exact)",
        () => openLifecycleMappingReader(ncForeign, SPACE), "failed-precondition");
      await ncForeign.close().catch(() => {});
    }
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

  console.log("H. the minting profile SCOPED end-to-end (never proved only as admin)");
  {
    const ncWriter = await connect({ servers: `nats://127.0.0.1:${PORT}`, user: "writer", pass: "pw", inboxPrefix: "_INBOX_wrt" });
    const scopedReg = await openLifecycleRegistry(ncWriter, SPACE);
    c("the registry opens under the scoped minting profile (bind-time opens + BOTH shape proofs pass scoped)", scopedReg.space === SPACE);
    const act2 = await activateLifecycle(scopedReg, { owner: "u_scoped", actor: "cli", managerInstance: MGR });
    c("the FULL activation saga runs under the scoped profile (reserve, gate create, head CAS, reopen)",
      act2.mapping.state === "active" && act2.mapping.processEpoch === 1, act2.mapping);
    const g = await observeGate(scopedReg, act2.mapping.lifecycleUid);
    c("…gate open at generation 1 (auth leader reads + writes work scoped)", g !== undefined && g.row.state === "open" && g.row.generation === 1);
    await rejects("the writer profile CANNOT create consumers (no enumeration authority exists in this slice)",
      () => ncWriter.request(`$JS.API.CONSUMER.CREATE.KV_${RECORDS}.x1.$KV.${RECORDS}.uid.>`, enc.encode("{}"), { timeout: 1500 }));
    await rejects("…and CANNOT delete or admin a stream (no stream-admin authority)",
      () => ncWriter.request(`$JS.API.STREAM.DELETE.KV_${RECORDS}`, enc.encode(""), { timeout: 1500 }));
    await ncWriter.close().catch(() => {});
  }

  await nc.drain().catch(() => {});
} finally {
  broker.kill("SIGKILL");
  await new Promise((r) => broker.once("exit", r));
  rmSync(sd, { recursive: true, force: true });
}

console.log(fail === 0 ? `\nLIFECYCLE REGISTRY SMOKE OK ✅  (${ok} passed, ${fail} failed)` : `\nLIFECYCLE REGISTRY SMOKE FAILED ❌  (${ok} passed, ${fail} failed)`);
if (fail > 0) process.exit(1);
