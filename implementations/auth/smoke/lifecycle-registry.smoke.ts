/**
 * D13 lifecycle-registry smoke — the §13.1 lifecycle HEAD registry against a real broker's
 * records store. Covers: virgin activation (create-only, generation 1, minted uid), one-winner
 * on concurrent same-alias activation, the already-active refusal, retirement (terminal,
 * never-deleted), re-activation of a retired alias (fresh uid + bumped generation), the
 * monotonic process-epoch advance (revision-pinned CAS; a stale advance loses; a retired
 * lifecycle refuses), the leader-served mapping reader that backs readProcessEpoch (active epoch
 * vs undefined for retired/absent), a DEL/PURGE marker refusing loudly (never absence), and
 * closed-schema / key-mismatch fail-closed parsing.
 *
 * Run: pnpm smoke:lifecycle-registry:auth   (needs nats-server on PATH; part of smoke:ci)
 */
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect } from "@nats-io/transport-node";
import { jetstreamManager } from "@nats-io/jetstream";
import { Kvm } from "@nats-io/kv";
import {
  isReachable, EpEnvelopeError, createEndpointStreams, openRecordsBucket, LIFECYCLE_HEAD, recordAtomicKey,
} from "@cotal-ai/core";
import {
  activateLifecycle, advanceProcessEpoch, retireLifecycleHead, readLifecycleHeadLeader,
  lifecycleProcessEpochReader, lifecycleRegistryManager,
} from "../src/index.js";

let ok = 0, fail = 0;
const c = (n: string, v: boolean, extra?: unknown) => { if (v) { ok++; } else { fail++; console.log("  ✗ FAIL:", n, extra ?? ""); } };
const rejects = async (n: string, fn: () => Promise<unknown> | unknown, code?: string) => {
  try { await fn(); c(n, false, "no throw"); } catch (e) {
    c(n, code === undefined || (e instanceof EpEnvelopeError && e.code === code), `code ${(e as EpEnvelopeError).code ?? (e as Error).message}`);
  }
};
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

const SPACE = "lifereg";
const enc = new TextEncoder();

const PORT = 20000 + Math.floor(Math.random() * 40000);
const sd = mkdtempSync(join(tmpdir(), "cotal-lifereg-"));
const broker = spawn("nats-server", ["-js", "-sd", sd, "-p", String(PORT), "-a", "127.0.0.1"], { stdio: "ignore" });

try {
  let up = false;
  for (let i = 0; i < 50 && !up; i++) { up = await isReachable(`nats://127.0.0.1:${PORT}`); if (!up) await wait(100); }
  if (!up) throw new Error("broker did not come up");
  const nc = await connect({ servers: `nats://127.0.0.1:${PORT}` });
  await createEndpointStreams(await jetstreamManager(nc), new Kvm(nc), SPACE);
  const kv = await openRecordsBucket(nc, SPACE);
  const jsm = await lifecycleRegistryManager(nc);
  const MGR = "mgr-1";

  console.log("A. virgin activation + concurrency");
  const h1 = await activateLifecycle(kv, { owner: "u_alice", actor: "cli", managerInstance: MGR });
  c("a virgin alias activates at generation 1 with a minted uid and epoch 1",
    h1.generation === 1 && h1.processEpoch === 1 && h1.state === "active" && /^[a-z0-9]{26,32}$/.test(h1.lifecycleUid), h1);
  await rejects("re-activating an ACTIVE alias refuses (a takeover advances the epoch, never a new incarnation)",
    () => activateLifecycle(kv, { owner: "u_alice", actor: "cli", managerInstance: MGR }), "already-exists");
  {
    // Concurrent virgin activation of a fresh alias: exactly one wins the create-only CAS.
    const results = await Promise.allSettled([
      activateLifecycle(kv, { owner: "u_bob", actor: "cli", managerInstance: MGR }),
      activateLifecycle(kv, { owner: "u_bob", actor: "cli", managerInstance: MGR }),
    ]);
    const wins = results.filter((r) => r.status === "fulfilled").length;
    const losses = results.filter((r) => r.status === "rejected" && (r.reason as EpEnvelopeError)?.code === "conflict").length;
    c("concurrent same-alias activation yields exactly ONE winner (the other loses its CAS as conflict)",
      wins === 1 && losses === 1, { wins, losses });
  }

  console.log("B. the leader-served mapping reader (readProcessEpoch backing)");
  {
    const read = await readLifecycleHeadLeader(jsm, SPACE, "u_alice", "cli");
    c("the leader-served head read returns the active incarnation's uid + epoch",
      read !== undefined && read.head.lifecycleUid === h1.lifecycleUid && read.head.processEpoch === 1, read);
    c("lifecycleProcessEpochReader returns the active epoch", (await lifecycleProcessEpochReader(jsm, SPACE, "u_alice", "cli")) === 1);
    c("…and undefined for an absent alias (an unauthorized egress)", (await lifecycleProcessEpochReader(jsm, SPACE, "u_ghost", "cli")) === undefined);
  }

  console.log("C. the monotonic process-epoch advance (takeover/restart fence)");
  {
    const adv = await advanceProcessEpoch(kv, { owner: "u_alice", actor: "cli", toEpoch: 2 });
    c("the process epoch advances to 2 (revision-pinned CAS)", adv.processEpoch === 2 && adv.generation === 1 && adv.lifecycleUid === h1.lifecycleUid, adv);
    c("…and the leader reader now returns epoch 2", (await lifecycleProcessEpochReader(jsm, SPACE, "u_alice", "cli")) === 2);
    await rejects("a non-monotonic epoch refuses (the process epoch only advances)",
      () => advanceProcessEpoch(kv, { owner: "u_alice", actor: "cli", toEpoch: 2 }), "failed-precondition");
    await rejects("advancing an ABSENT lifecycle is not-found",
      () => advanceProcessEpoch(kv, { owner: "u_ghost", actor: "cli", toEpoch: 5 }), "not-found");
  }

  console.log("D. terminal retirement + re-activation at a fresh incarnation");
  {
    const ret = await retireLifecycleHead(kv, { owner: "u_alice", actor: "cli" });
    c("retirement transitions the head terminal (durable, never deleted)", ret.retired && ret.head?.state === "retired", ret);
    c("…the leader reader now yields undefined epoch (a retired lifecycle is an unauthorized egress)",
      (await lifecycleProcessEpochReader(jsm, SPACE, "u_alice", "cli")) === undefined);
    const again = await retireLifecycleHead(kv, { owner: "u_alice", actor: "cli" });
    c("a second retire is idempotent (already retired, no transition)", !again.retired && again.head?.state === "retired");
    await rejects("a retired lifecycle refuses a process-epoch advance (a terminal incarnation gets no new epoch)",
      () => advanceProcessEpoch(kv, { owner: "u_alice", actor: "cli", toEpoch: 9 }), "failed-precondition");
    // Re-activation of the RETIRED alias mints a FRESH uid at a bumped generation.
    const h2 = await activateLifecycle(kv, { owner: "u_alice", actor: "cli", managerInstance: MGR });
    c("re-activating the retired alias mints a FRESH uid at generation 2 (the uid is never reused)",
      h2.generation === 2 && h2.state === "active" && h2.lifecycleUid !== h1.lifecycleUid, h2);
    c("…the leader reader now returns the NEW incarnation's epoch", (await lifecycleProcessEpochReader(jsm, SPACE, "u_alice", "cli")) === 1);
  }

  console.log("E. never-delete authority discipline + fail-closed parse");
  {
    // A DEL marker on the head is CORRUPTION, not absence: the reader refuses loudly.
    await activateLifecycle(kv, { owner: "u_carol", actor: "cli", managerInstance: MGR });
    await kv.delete(recordAtomicKey(LIFECYCLE_HEAD, ["u_carol", "cli"]));
    await rejects("a DEL marker on the head refuses loudly (a deletion is corruption, never absence)",
      () => readLifecycleHeadLeader(jsm, SPACE, "u_carol", "cli"), "failed-precondition");
    await rejects("…and a re-activation over the deletion marker refuses (create-only never recreates over a tombstone)",
      () => activateLifecycle(kv, { owner: "u_carol", actor: "cli", managerInstance: MGR }), "failed-precondition");
    // A key-mismatched / garbled head refuses at the read boundary.
    await kv.put(recordAtomicKey(LIFECYCLE_HEAD, ["u_dave", "cli"]), enc.encode(JSON.stringify({ owner: "u_EVIL", actor: "cli", lifecycleUid: "a".repeat(26), managerInstance: MGR, processEpoch: 1, state: "active", generation: 1 })));
    await rejects("a key-mismatched head (embedded owner ≠ key) refuses (never authorizes another alias)",
      () => readLifecycleHeadLeader(jsm, SPACE, "u_dave", "cli"), "internal");
    await kv.put(recordAtomicKey(LIFECYCLE_HEAD, ["u_erin", "cli"]), enc.encode(JSON.stringify({ owner: "u_erin", actor: "cli", lifecycleUid: "a".repeat(26), managerInstance: MGR, processEpoch: 1, state: "active", generation: 1, extra: true })));
    await rejects("an unknown head field refuses (closed schema)",
      () => readLifecycleHeadLeader(jsm, SPACE, "u_erin", "cli"), "internal");
  }

  await nc.drain().catch(() => {});
} finally {
  broker.kill("SIGKILL");
  await new Promise((r) => broker.once("exit", r));
  rmSync(sd, { recursive: true, force: true });
}

console.log(fail === 0 ? `\nLIFECYCLE REGISTRY SMOKE OK ✅  (${ok} passed, ${fail} failed)` : `\nLIFECYCLE REGISTRY SMOKE FAILED ❌  (${ok} passed, ${fail} failed)`);
if (fail > 0) process.exit(1);
