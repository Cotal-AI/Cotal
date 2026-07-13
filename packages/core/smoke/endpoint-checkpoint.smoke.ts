/**
 * v0.4 §13.6 AWAITABLE CHECKPOINT smoke — the one durable pause primitive against a real
 * broker with REAL message schedules: mint (spec + waiting status + `.schedule` request), the
 * timer writer's arm (ADR-51 header rejection; subject-derived target; same-generation
 * idempotence), heartbeat generation supersede (the superseded deadline's fire NO-OPS), the
 * broker-authored fire origin check (forged fires discard), the ONE-USE settle CAS (resume
 * and expiry race; duplicate resume is conflict; expiry fails closed), holder-bound resume,
 * and the durable reconciler's harmless over-emission.
 *
 * Run: pnpm smoke:ep-checkpoint   (needs nats-server ≥2.12 on PATH; part of smoke:ci)
 */
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect, headers } from "@nats-io/transport-node";
import { jetstream, jetstreamManager } from "@nats-io/jetstream";
import { Kvm } from "@nats-io/kv";
import {
  isReachable, EpEnvelopeError,
  createEndpointStreams, openRecordsBucket, eptSubject, eptReqStreamName, eptStreamName,
  timerWriterDurable, timerWriterConsumerConfig,
  mintCheckpoint, heartbeatCheckpoint, readCheckpointStatus, readCheckpointSettle,
  armCheckpointTimer, handleCheckpointFire, resumeCheckpoint, reconcileCheckpointSchedule,
  checkpointStatusResolver, checkpointSettleSubject, epfStreamName,
  type CheckpointRef,
} from "../src/index.js";

let ok = 0, fail = 0;
const c = (n: string, v: boolean, extra?: unknown) => { if (v) { ok++; } else { fail++; console.log("  ✗ FAIL:", n, extra ?? ""); } };
const rejects = async (n: string, fn: () => Promise<unknown> | unknown, code?: string) => {
  try { await fn(); c(n, false, "no throw"); return undefined; } catch (e) {
    c(n, code === undefined || (e instanceof EpEnvelopeError && e.code === code), `code ${(e as EpEnvelopeError).code ?? (e as Error).message}`);
    return e;
  }
};
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

const SPACE = "epcp";
const IID = "i".repeat(26);
const EPOCH = 1;
const ref = (token: string): CheckpointRef => ({ endpoint: "manager", token });
const holderA = { id: "u_abc.worker", lifecycleUid: "u".repeat(26) };
const holderB = { id: "u_abc.other", lifecycleUid: "v".repeat(26) };

const PORT = 20000 + Math.floor(Math.random() * 40000);
const sd = mkdtempSync(join(tmpdir(), "cotal-epcp-"));
const broker = spawn("nats-server", ["-js", "-sd", sd, "-p", String(PORT), "-a", "127.0.0.1"], { stdio: "ignore" });

try {
  let up = false;
  for (let i = 0; i < 50 && !up; i++) { up = await isReachable(`nats://127.0.0.1:${PORT}`); if (!up) await wait(100); }
  if (!up) throw new Error("broker did not come up");
  const nc = await connect({ servers: `nats://127.0.0.1:${PORT}` });
  const js = jetstream(nc);
  const jsm = await jetstreamManager(nc);
  await createEndpointStreams(jsm, new Kvm(nc), SPACE);
  const kv = await openRecordsBucket(nc, SPACE);
  await jsm.consumers.add(eptReqStreamName(SPACE), timerWriterConsumerConfig(SPACE, { ackWaitMs: 5_000 }));
  const writerC = await js.consumers.get(eptReqStreamName(SPACE), timerWriterDurable(SPACE));
  // The smoke's timer-writer loop: fetch each .schedule request and arm it via the writer seam.
  const resolveStatus = checkpointStatusResolver(kv);
  const drainAndArm = async (expect: number) => {
    const armed: { generation?: number }[] = [];
    for await (const m of await writerC.fetch({ max_messages: expect, expires: 2000 })) {
      const r = await armCheckpointTimer(js, { subject: m.subject, headers: m.headers, data: m.data }, resolveStatus);
      if (r.armed) armed.push({ generation: r.generation });
      m.ack();
    }
    return armed;
  };
  const NOW = Date.now(); // real schedules need real wall-clock deadlines; the OWNER clock probes use offsets from this

  // ── mint: mandatory future deadline + mandatory holder; spec + waiting@gen1 + .schedule ──
  await rejects("a checkpoint without a FUTURE deadline refuses (deadlines are mandatory, §13.6)",
    () => mintCheckpoint(kv, js, SPACE, { ref: ref("cp1"), instanceId: IID, epoch: EPOCH, holder: holderA, deadline: NOW, now: NOW }), "failed-precondition");
  await rejects("a checkpoint WITHOUT a holder refuses (resume is holder-bound, never a bearer token, §13.6/§13.10)",
    () => mintCheckpoint(kv, js, SPACE, { ref: ref("cp-nh"), instanceId: IID, epoch: EPOCH, holder: undefined as never, deadline: NOW + 1_000, now: NOW }), "failed-precondition");
  await mintCheckpoint(kv, js, SPACE, { ref: ref("cp1"), instanceId: IID, epoch: EPOCH, holder: holderA, deadline: NOW + 1_200, now: NOW });
  const s1 = await readCheckpointStatus(kv, ref("cp1"));
  c("mint records waiting at generation 1 with the deadline", s1?.value.state === "waiting" && s1?.value.deadlineGeneration === 1 && s1?.value.deadline === NOW + 1_200);

  // ── the timer writer: ADR-51 header rejection + subject-derived arm ──
  await rejects("a .schedule request CARRYING a scheduling header is rejected by the writer (ADR-51: request headers are inert and refused)",
    () => {
      const h = headers();
      h.set("Nats-Schedule-Target", eptSubject(SPACE, "manager", IID, EPOCH, "victim", "fire"));
      return armCheckpointTimer(js, { subject: eptSubject(SPACE, "manager", IID, EPOCH, "cp1", "schedule"), headers: h, data: new TextEncoder().encode(JSON.stringify({ v: 1, timerId: "cp1", generation: 1, deadline: NOW + 1_200 })) }, resolveStatus);
    }, "permission-denied");
  await rejects("a .schedule body whose timerId DISAGREES with the authenticated subject token refuses (subject wins)",
    () => armCheckpointTimer(js, { subject: eptSubject(SPACE, "manager", IID, EPOCH, "cp1", "schedule"), data: new TextEncoder().encode(JSON.stringify({ v: 1, timerId: "other", generation: 1, deadline: NOW + 1_200 })) }, resolveStatus), "failed-precondition");
  const armed1 = await drainAndArm(1);
  c("the writer arms the minted request (generation 1, target derived from the subject)", armed1.length === 1 && armed1[0].generation === 1);

  // ── heartbeat: status generation FIRST, then the replacement schedule ──
  const hb = await heartbeatCheckpoint(kv, js, jsm, SPACE, { ref: ref("cp1"), instanceId: IID, epoch: EPOCH, deadline: NOW + 2_600, now: NOW + 200 });
  c("the heartbeat CAS-advances the deadline generation and the deadline", hb.deadlineGeneration === 2 && hb.deadline === NOW + 2_600);
  const armed2 = await drainAndArm(1);
  c("the writer arms the replacement (generation 2; same-subject rollup replaces gen1's schedule)", armed2.length === 1 && armed2[0].generation === 2);
  {
    const armedSubj = eptSubject(SPACE, "manager", IID, EPOCH, "cp1", "armed");
    const count = (await jsm.streams.info(eptStreamName(SPACE), { subjects_filter: armedSubj })).state.subjects?.[armedSubj];
    c("EXACTLY ONE armed schedule exists after the replacement (server rollup)", count === 1);
  }

  // ── the fire: origin check, stale-generation no-op, due expiry via the one-use CAS ──
  await wait(3_200); // past gen2's real deadline — the broker fires onto .fire
  const fireSubj = eptSubject(SPACE, "manager", IID, EPOCH, "cp1", "fire");
  const fired = await jsm.streams.getMessage(eptStreamName(SPACE), { last_by_subj: fireSubj });
  c("the broker fired the armed schedule onto the sibling .fire", fired !== null);
  const fireMsg = { subject: fireSubj, headers: fired!.header, data: fired!.data };
  {
    const forged = await handleCheckpointFire(kv, js, jsm, SPACE, { ref: ref("cp1"), instanceId: IID, epoch: EPOCH, msg: { ...fireMsg, headers: headers() }, now: NOW + 3_000 });
    c("a fire WITHOUT the broker-authored Nats-Scheduler origin is discarded as forged", forged.acted === false && forged.reason === "forged-origin");
    const stale = await handleCheckpointFire(kv, js, jsm, SPACE, { ref: ref("cp1"), instanceId: IID, epoch: EPOCH, msg: { ...fireMsg, data: new TextEncoder().encode(JSON.stringify({ v: 1, timerId: "cp1", generation: 1, deadline: NOW + 1_200 })) }, now: NOW + 3_000 });
    c("a STALE-generation fire no-ops (a heartbeat superseded that deadline)", stale.acted === false && stale.reason === "stale-generation");
    const wrongInst = await handleCheckpointFire(kv, js, jsm, SPACE, { ref: ref("cp1"), instanceId: "z".repeat(26), epoch: EPOCH, msg: fireMsg, now: NOW + 2_600 });
    c("a fire whose instance/epoch does not match the expected coordinate is discarded (full-coordinate binding, not token-only)", wrongInst.acted === false && wrongInst.reason === "forged-origin");
    const early = await handleCheckpointFire(kv, js, jsm, SPACE, { ref: ref("cp1"), instanceId: IID, epoch: EPOCH, msg: fireMsg, now: NOW + 2_599 });
    c("a genuine fire before the authoritative deadline RE-ARMS the current generation (clock skew never silently drops the deadline)", early.acted === false && early.reason === "re-armed");
    await drainAndArm(1); // consume the re-emitted schedule
    const due = await handleCheckpointFire(kv, js, jsm, SPACE, { ref: ref("cp1"), instanceId: IID, epoch: EPOCH, msg: fireMsg, now: NOW + 2_600 });
    c("the due, origin-verified, current-generation fire EXPIRES the checkpoint (wins the one-use settle)", due.acted === true && due.won === true && due.settle.settle === "expired");
    c("the expiry is projected (status expired, fail closed)", (await readCheckpointStatus(kv, ref("cp1")))?.value.state === "expired");
  }
  await rejects("a resume AFTER expiry refuses (expiry fails the checkpoint closed)",
    () => resumeCheckpoint(kv, js, jsm, SPACE, { ref: ref("cp1"), presenter: holderA, now: NOW + 3_500 }), "failed-precondition");

  // ── resume: holder-bound + one-use; a late fire observes it ──
  await mintCheckpoint(kv, js, SPACE, { ref: ref("cp2"), instanceId: IID, epoch: EPOCH, holder: holderA, deadline: NOW + 60_000, now: NOW });
  await drainAndArm(1);
  await rejects("a resume by a NON-holder refuses (holder-bound, §13.10)",
    () => resumeCheckpoint(kv, js, jsm, SPACE, { ref: ref("cp2"), presenter: holderB, now: NOW + 100 }), "permission-denied");
  const resumed = await resumeCheckpoint(kv, js, jsm, SPACE, { ref: ref("cp2"), presenter: holderA, now: NOW + 200 });
  c("the holder's resume claims the one-use settle", resumed.settle === "resumed" && resumed.holder?.id === holderA.id);
  c("the resume is projected", (await readCheckpointStatus(kv, ref("cp2")))?.value.state === "resumed");
  await rejects("a DUPLICATE resume is conflict (resume authorization is one-use)",
    () => resumeCheckpoint(kv, js, jsm, SPACE, { ref: ref("cp2"), presenter: holderA, now: NOW + 300 }), "conflict");
  c("the recorded settlement is readable", (await readCheckpointSettle(jsm, SPACE, ref("cp2")))?.settle === "resumed");
  await rejects("a resume of an UNKNOWN token refuses",
    () => resumeCheckpoint(kv, js, jsm, SPACE, { ref: ref("cp-none"), presenter: holderA, now: NOW }), "failed-precondition");
  await rejects("a heartbeat on a settled checkpoint refuses (only waiting extends)",
    () => heartbeatCheckpoint(kv, js, jsm, SPACE, { ref: ref("cp2"), instanceId: IID, epoch: EPOCH, deadline: NOW + 90_000, now: NOW + 400 }), "failed-precondition");

  // ── the reconciler: re-emit at the current generation; over-emission is harmless ──
  await mintCheckpoint(kv, js, SPACE, { ref: ref("cp3"), instanceId: IID, epoch: EPOCH, holder: holderA, deadline: NOW + 60_000, now: NOW });
  await drainAndArm(1);
  const rec = await reconcileCheckpointSchedule(kv, js, jsm, SPACE, { ref: ref("cp3"), instanceId: IID, epoch: EPOCH });
  c("the reconciler re-emits the CURRENT generation for a waiting checkpoint", rec.reEmitted === true && rec.generation === 1);
  const armedRec = await drainAndArm(1);
  c("the re-emission arms idempotently (same generation, rollup no-op)", armedRec.length === 1 && armedRec[0].generation === 1);
  {
    const armedSubj = eptSubject(SPACE, "manager", IID, EPOCH, "cp3", "armed");
    const count = (await jsm.streams.info(eptStreamName(SPACE), { subjects_filter: armedSubj })).state.subjects?.[armedSubj];
    c("still exactly one armed schedule for the reconciled token", count === 1);
  }
  c("the reconciler leaves settled checkpoints alone", (await reconcileCheckpointSchedule(kv, js, jsm, SPACE, { ref: ref("cp2"), instanceId: IID, epoch: EPOCH })).reEmitted === false);

  // ── the STATUS is the settlement ARBITER; the EPF fact is its derived, recoverable copy.
  //    Manufacture the crash window (status settled, EPF fact purged) and prove settledOrConverge
  //    RE-PUBLISHES the fact and heartbeat/reconcile refuse + do not re-arm. ──
  await mintCheckpoint(kv, js, SPACE, { ref: ref("cp4"), instanceId: IID, epoch: EPOCH, holder: holderA, deadline: NOW + 60_000, now: NOW });
  await drainAndArm(1);
  await resumeCheckpoint(kv, js, jsm, SPACE, { ref: ref("cp4"), presenter: holderA, now: NOW + 100 }); // status → resumed + derives the fact
  await jsm.streams.purge(epfStreamName(SPACE), { filter: checkpointSettleSubject(SPACE, ref("cp4")) }); // manufacture: settled status, missing fact
  c("the manufactured crash window is in place (status settled, EPF fact purged)",
    (await readCheckpointStatus(kv, ref("cp4")))?.value.state === "resumed" && (await readCheckpointSettle(jsm, SPACE, ref("cp4"))) === undefined);
  await rejects("a heartbeat on the settled checkpoint REFUSES (status is the arbiter) and RE-PUBLISHES the derived fact",
    () => heartbeatCheckpoint(kv, js, jsm, SPACE, { ref: ref("cp4"), instanceId: IID, epoch: EPOCH, deadline: NOW + 120_000, now: NOW + 200 }), "failed-precondition");
  c("…and the derived one-use fact was reconstructed from the settled status", (await readCheckpointSettle(jsm, SPACE, ref("cp4")))?.settle === "resumed");
  c("the reconciler does NOT re-arm a settled checkpoint (no timer leak)",
    (await reconcileCheckpointSchedule(kv, js, jsm, SPACE, { ref: ref("cp4"), instanceId: IID, epoch: EPOCH })).reEmitted === false);

  // ── HIGH 1: the timer writer FRESH-CHECKS the authoritative generation — a delayed stale-gen
  //    request is DISCARDED (arming it would roll `.armed` back to a superseded deadline). ──
  await mintCheckpoint(kv, js, SPACE, { ref: ref("cp5"), instanceId: IID, epoch: EPOCH, holder: holderA, deadline: NOW + 60_000, now: NOW });
  await drainAndArm(1);
  await heartbeatCheckpoint(kv, js, jsm, SPACE, { ref: ref("cp5"), instanceId: IID, epoch: EPOCH, deadline: NOW + 90_000, now: NOW + 100 }); // → gen 2
  await drainAndArm(1);
  {
    const staleReq = { subject: eptSubject(SPACE, "manager", IID, EPOCH, "cp5", "schedule"), data: new TextEncoder().encode(JSON.stringify({ v: 1, timerId: "cp5", generation: 1, deadline: NOW + 60_000 })) };
    const r = await armCheckpointTimer(js, staleReq, resolveStatus);
    c("a delayed STALE-generation .schedule request is DISCARDED, not armed (no rollback of the live deadline)", r.armed === false && r.reason === "stale");
    const unknownReq = { subject: eptSubject(SPACE, "manager", IID, EPOCH, "cp-ghost", "schedule"), data: new TextEncoder().encode(JSON.stringify({ v: 1, timerId: "cp-ghost", generation: 1, deadline: NOW + 60_000 })) };
    c("a .schedule request for an UNKNOWN checkpoint is discarded", (await armCheckpointTimer(js, unknownReq, resolveStatus)).armed === false);
  }

  // ── HIGH 3: the deadline is a live fence. A heartbeat at/after the deadline refuses (a due
  //    checkpoint expires, not extends); a resume at/after the deadline drives EXPIRED (fails
  //    closed), never claims resumed, even with no fire yet processed. ──
  await mintCheckpoint(kv, js, SPACE, { ref: ref("cp6"), instanceId: IID, epoch: EPOCH, holder: holderA, deadline: NOW + 5_000, now: NOW });
  await drainAndArm(1);
  await rejects("a heartbeat AT/AFTER the current deadline refuses (a due checkpoint expires, never extends)",
    () => heartbeatCheckpoint(kv, js, jsm, SPACE, { ref: ref("cp6"), instanceId: IID, epoch: EPOCH, deadline: NOW + 99_000, now: NOW + 5_000 }), "failed-precondition");
  await rejects("a resume AT/AFTER the deadline (no fire yet) fails CLOSED — it drives EXPIRED, never resumed",
    () => resumeCheckpoint(kv, js, jsm, SPACE, { ref: ref("cp6"), presenter: holderA, now: NOW + 5_000 }), "failed-precondition");
  c("…and the deadline-passed resume settled the checkpoint EXPIRED (fail closed)", (await readCheckpointStatus(kv, ref("cp6")))?.value.state === "expired");

  // ── fail-closed storage read ──
  await kv.delete("cp.manager.cp3.status");
  await rejects("a DEL marker on the checkpoint status refuses (a deletion never erases a pause)",
    () => readCheckpointStatus(kv, ref("cp3")), "failed-precondition");

  await nc.close();
} finally {
  broker.kill("SIGKILL");
  await new Promise<void>((resolve) => { broker.once("exit", () => resolve()); broker.once("error", () => resolve()); });
  rmSync(sd, { recursive: true, force: true });
}

console.log(`\nENDPOINT CHECKPOINT SMOKE ${fail === 0 ? "OK ✅ " : "FAILED ❌ "} (${ok} passed, ${fail} failed)`);
if (fail > 0) process.exit(1);
