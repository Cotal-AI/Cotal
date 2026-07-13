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
  const drainAndArm = async (expect: number) => {
    const armed: { generation: number }[] = [];
    for await (const m of await writerC.fetch({ max_messages: expect, expires: 2000 })) {
      armed.push(await armCheckpointTimer(js, { subject: m.subject, headers: m.headers, data: m.data }));
      m.ack();
    }
    return armed;
  };
  const NOW = Date.now(); // real schedules need real wall-clock deadlines; the OWNER clock probes use offsets from this

  // ── mint: mandatory future deadline; spec + waiting@gen1 + the .schedule request ──
  await rejects("a checkpoint without a FUTURE deadline refuses (deadlines are mandatory, §13.6)",
    () => mintCheckpoint(kv, js, SPACE, { ref: ref("cp1"), instanceId: IID, epoch: EPOCH, deadline: NOW, now: NOW }), "failed-precondition");
  await mintCheckpoint(kv, js, SPACE, { ref: ref("cp1"), instanceId: IID, epoch: EPOCH, holder: holderA, deadline: NOW + 1_200, now: NOW });
  const s1 = await readCheckpointStatus(kv, ref("cp1"));
  c("mint records waiting at generation 1 with the deadline", s1?.value.state === "waiting" && s1?.value.deadlineGeneration === 1 && s1?.value.deadline === NOW + 1_200);

  // ── the timer writer: ADR-51 header rejection + subject-derived arm ──
  await rejects("a .schedule request CARRYING a scheduling header is rejected by the writer (ADR-51: request headers are inert and refused)",
    () => {
      const h = headers();
      h.set("Nats-Schedule-Target", eptSubject(SPACE, "manager", IID, EPOCH, "victim", "fire"));
      return armCheckpointTimer(js, { subject: eptSubject(SPACE, "manager", IID, EPOCH, "cp1", "schedule"), headers: h, data: new TextEncoder().encode(JSON.stringify({ v: 1, timerId: "cp1", generation: 1, deadline: NOW + 1_200 })) });
    }, "permission-denied");
  await rejects("a .schedule body whose timerId DISAGREES with the authenticated subject token refuses (subject wins)",
    () => armCheckpointTimer(js, { subject: eptSubject(SPACE, "manager", IID, EPOCH, "cp1", "schedule"), data: new TextEncoder().encode(JSON.stringify({ v: 1, timerId: "other", generation: 1, deadline: NOW + 1_200 })) }), "failed-precondition");
  const armed1 = await drainAndArm(1);
  c("the writer arms the minted request (generation 1, target derived from the subject)", armed1.length === 1 && armed1[0].generation === 1);

  // ── heartbeat: status generation FIRST, then the replacement schedule ──
  const hb = await heartbeatCheckpoint(kv, js, SPACE, { ref: ref("cp1"), instanceId: IID, epoch: EPOCH, deadline: NOW + 2_600, now: NOW + 200 });
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
    const forged = await handleCheckpointFire(kv, js, jsm, SPACE, { ref: ref("cp1"), msg: { ...fireMsg, headers: headers() }, now: NOW + 3_000 });
    c("a fire WITHOUT the broker-authored Nats-Scheduler origin is discarded as forged", forged.acted === false && forged.reason === "forged-origin");
    const stale = await handleCheckpointFire(kv, js, jsm, SPACE, { ref: ref("cp1"), msg: { ...fireMsg, data: new TextEncoder().encode(JSON.stringify({ v: 1, timerId: "cp1", generation: 1, deadline: NOW + 1_200 })) }, now: NOW + 3_000 });
    c("a STALE-generation fire no-ops (a heartbeat superseded that deadline)", stale.acted === false && stale.reason === "stale-generation");
    const early = await handleCheckpointFire(kv, js, jsm, SPACE, { ref: ref("cp1"), msg: fireMsg, now: NOW + 2_599 });
    c("a fire before the authoritative deadline is not due (owner clock decides)", early.acted === false && early.reason === "not-due");
    const due = await handleCheckpointFire(kv, js, jsm, SPACE, { ref: ref("cp1"), msg: fireMsg, now: NOW + 2_600 });
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
    () => heartbeatCheckpoint(kv, js, SPACE, { ref: ref("cp2"), instanceId: IID, epoch: EPOCH, deadline: NOW + 90_000, now: NOW + 400 }), "failed-precondition");

  // ── the reconciler: re-emit at the current generation; over-emission is harmless ──
  await mintCheckpoint(kv, js, SPACE, { ref: ref("cp3"), instanceId: IID, epoch: EPOCH, deadline: NOW + 60_000, now: NOW });
  await drainAndArm(1);
  const rec = await reconcileCheckpointSchedule(kv, js, SPACE, { ref: ref("cp3"), instanceId: IID, epoch: EPOCH });
  c("the reconciler re-emits the CURRENT generation for a waiting checkpoint", rec.reEmitted === true && rec.generation === 1);
  const armedRec = await drainAndArm(1);
  c("the re-emission arms idempotently (same generation, rollup no-op)", armedRec.length === 1 && armedRec[0].generation === 1);
  {
    const armedSubj = eptSubject(SPACE, "manager", IID, EPOCH, "cp3", "armed");
    const count = (await jsm.streams.info(eptStreamName(SPACE), { subjects_filter: armedSubj })).state.subjects?.[armedSubj];
    c("still exactly one armed schedule for the reconciled token", count === 1);
  }
  c("the reconciler leaves settled checkpoints alone", (await reconcileCheckpointSchedule(kv, js, SPACE, { ref: ref("cp2"), instanceId: IID, epoch: EPOCH })).reEmitted === false);

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
