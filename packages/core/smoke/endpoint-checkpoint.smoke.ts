/**
 * v0.4 §13.6 AWAITABLE CHECKPOINT smoke — the one durable pause primitive against a real
 * broker with REAL message schedules: mint (spec + waiting status + `.schedule` request), the
 * timer writer's arm (ADR-51 header rejection; subject-derived target; same-generation
 * idempotence), the ARM FENCE (a delayed writer whose status proof was current when taken but
 * whose publish lands after a newer arm is rejected by the BROKER's subject-CAS, and a
 * no-competitor stale arm is repaired by the post-publish self-heal re-read — both driven
 * deterministically by holding the writer's leader-served status response mid-flight),
 * heartbeat generation supersede (the superseded deadline's fire NO-OPS), the
 * broker-authored fire origin check (forged fires discard), the ONE-USE settle CAS (resume
 * and expiry race; duplicate resume is conflict; expiry fails closed), holder-bound resume,
 * the durable reconciler's harmless over-emission, and deletion fail-closure (a DEL on the
 * spec or status never rebinds the holder or resurrects a settled checkpoint — the create
 * CAS covers the key's entire history and is the arbiter, not the client's marker check).
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
  mintCheckpoint, heartbeatCheckpoint, readCheckpointStatus, readCheckpointSettle, readCheckpointSpec,
  armCheckpointTimer, handleCheckpointFire, resumeCheckpoint, reconcileCheckpointSchedule,
  checkpointAnswerId, recordCheckpointAnswer, readCheckpointAnswer,
  timerWriterContext, checkpointSettleSubject, epfStreamName,
  type CheckpointRef,
} from "../src/index.js";
import { pickFreePort } from "./_free-port.js";

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

const PORT = await pickFreePort();
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
  const wctx = await timerWriterContext(nc, SPACE);
  const drainAndArm = async (expect: number) => {
    const armed: { generation?: number }[] = [];
    for await (const m of await writerC.fetch({ max_messages: expect, expires: 2000 })) {
      const r = await armCheckpointTimer(wctx, { subject: m.subject, headers: m.headers, data: m.data });
      if (r.armed) armed.push({ generation: r.generation });
      m.ack();
    }
    return armed;
  };
  // Fetch raw .schedule requests WITHOUT arming them (the delayed-writer probes replay them).
  const fetchRequests = async (expect: number) => {
    const msgs: { subject: string; data: Uint8Array }[] = [];
    for await (const m of await writerC.fetch({ max_messages: expect, expires: 2000 })) {
      msgs.push({ subject: m.subject, data: m.data });
      m.ack();
    }
    return msgs;
  };
  // A connection whose next records-KV STREAM.MSG.GET response can be HELD: the response is
  // materialized immediately (the status proof is taken NOW, while it is genuinely current) but
  // only handed to the awaiting writer when released — the deterministic DELAYED-WRITER
  // schedule (proof valid when taken, the publish landing after the world moved). The matcher
  // doubles as the M2 structural proof: it only fires if the writer's fresh-check rides the
  // leader-served STREAM.MSG.GET API — a kv.get/DIRECT.GET fresh-check would never be held and
  // the probes below would fail.
  const gatedConnection = () => {
    let armGate = false;
    let release: (() => void) | undefined;
    const gated = new Proxy(nc, {
      get(target, prop) {
        if (prop === "request") return async (subj: string, ...rest: unknown[]) => {
          const p = (target as unknown as { request: (...a: unknown[]) => Promise<unknown> }).request(subj, ...rest);
          if (armGate && typeof subj === "string" && subj.startsWith("$JS.API.STREAM.MSG.GET.KV_cotal_records_")) {
            armGate = false; // hold exactly ONE status read
            const result = await p;
            await new Promise<void>((r) => { release = r; });
            return result;
          }
          return p;
        };
        const v = Reflect.get(target, prop, target);
        return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(target) : v;
      },
    });
    return {
      nc: gated,
      holdNextStatusRead: () => { armGate = true; },
      whenHeld: async () => { while (release === undefined) await wait(10); },
      release: () => { release!(); release = undefined; },
    };
  };
  const lastArmedBody = async (tok: string) => {
    const m = await jsm.streams.getMessage(eptStreamName(SPACE), { last_by_subj: eptSubject(SPACE, "manager", IID, EPOCH, tok, "armed") });
    return JSON.parse(new TextDecoder().decode(m!.data)) as { generation: number };
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
      return armCheckpointTimer(wctx, { subject: eptSubject(SPACE, "manager", IID, EPOCH, "cp1", "schedule"), headers: h, data: new TextEncoder().encode(JSON.stringify({ v: 1, timerId: "cp1", generation: 1, deadline: NOW + 1_200 })) });
    }, "permission-denied");
  await rejects("a .schedule body whose timerId DISAGREES with the authenticated subject token refuses (subject wins)",
    () => armCheckpointTimer(wctx, { subject: eptSubject(SPACE, "manager", IID, EPOCH, "cp1", "schedule"), data: new TextEncoder().encode(JSON.stringify({ v: 1, timerId: "other", generation: 1, deadline: NOW + 1_200 })) }), "failed-precondition");
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
  // The DURABLE RECONCILER alone must repair the window (no heartbeat first: a heartbeat
  // reconstructing the fact would mask a reconciler that skips settled states).
  {
    const repair = await reconcileCheckpointSchedule(kv, js, jsm, SPACE, { ref: ref("cp4"), instanceId: IID, epoch: EPOCH });
    c("the durable reconciler ITSELF repairs the settled-status/missing-fact crash window (and does not re-arm)",
      repair.reEmitted === false && (await readCheckpointSettle(jsm, SPACE, ref("cp4")))?.settle === "resumed");
  }
  await jsm.streams.purge(epfStreamName(SPACE), { filter: checkpointSettleSubject(SPACE, ref("cp4")) }); // re-manufacture for the heartbeat path
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
    const r = await armCheckpointTimer(wctx, staleReq);
    c("a delayed STALE-generation .schedule request is DISCARDED, not armed (no rollback of the live deadline)", r.armed === false && r.reason === "stale");
    const unknownReq = { subject: eptSubject(SPACE, "manager", IID, EPOCH, "cp-ghost", "schedule"), data: new TextEncoder().encode(JSON.stringify({ v: 1, timerId: "cp-ghost", generation: 1, deadline: NOW + 60_000 })) };
    c("a .schedule request for an UNKNOWN checkpoint is discarded", (await armCheckpointTimer(wctx, unknownReq)).armed === false);
  }

  // ── 8dcad72 HIGH (the ARM FENCE): a DELAYED writer whose status proof was taken while gen1
  //    was GENUINELY CURRENT, but whose publish lands only after gen2 is armed, is rejected by
  //    the BROKER (Nats-Expected-Last-Subject-Sequence pinned to the pre-proof .armed read) —
  //    the fresh-check alone cannot catch this schedule, because the proof was valid when
  //    taken. Without the fence the delayed publish replaces gen2's schedule (the rollup) and
  //    the live deadline silently rolls back. ──
  {
    await mintCheckpoint(kv, js, SPACE, { ref: ref("cphf"), instanceId: IID, epoch: EPOCH, holder: holderA, deadline: NOW + 600_000, now: NOW });
    const [gen1Req] = await fetchRequests(1); // captured, NOT armed — gen1's .armed does not exist yet
    const gate = gatedConnection();
    const delayedCtx = await timerWriterContext(gate.nc as never, SPACE);
    gate.holdNextStatusRead();
    const delayedArm = armCheckpointTimer(delayedCtx, gen1Req, { statusBudgetMs: 30_000 });
    await gate.whenHeld(); // the delayed writer has read .armed seq (0) and PROVEN gen1 current — now the world moves
    await heartbeatCheckpoint(kv, js, jsm, SPACE, { ref: ref("cphf"), instanceId: IID, epoch: EPOCH, deadline: NOW + 900_000, now: NOW + 100 });
    const armedGen2 = await drainAndArm(1);
    c("the live writer arms generation 2 while the delayed writer's gen1 publish is still in flight", armedGen2.length === 1 && armedGen2[0].generation === 2);
    gate.release(); // the delayed writer now publishes its stale-but-once-valid gen1 arm
    const delayed = await delayedArm;
    c("the DELAYED gen1 arm is rejected by the broker CAS and discarded on the re-proof (armed:false, stale) — process timing never orders the fence",
      delayed.armed === false && delayed.reason === "stale");
    c("…and the live schedule is STILL generation 2 (the delayed publish never rolled the deadline back)",
      (await lastArmedBody("cphf")).generation === 2);
  }

  // ── the POST-PUBLISH SELF-HEAL: a stale-but-once-valid arm that lands with NO competitor
  //    (its CAS succeeds — nobody armed since its read) leaves a SUPERSEDED schedule live while
  //    gen2's own request is still queued. The writer's post-publish re-read catches the moved
  //    status and immediately arms the LIVE coordinate instead of waiting for that request or
  //    the reconciler. ──
  {
    await mintCheckpoint(kv, js, SPACE, { ref: ref("cpsh"), instanceId: IID, epoch: EPOCH, holder: holderA, deadline: NOW + 600_000, now: NOW });
    const [gen1Req] = await fetchRequests(1); // captured, NOT armed
    const gate = gatedConnection();
    const delayedCtx = await timerWriterContext(gate.nc as never, SPACE);
    gate.holdNextStatusRead();
    const delayedArm = armCheckpointTimer(delayedCtx, gen1Req, { statusBudgetMs: 30_000 });
    await gate.whenHeld();
    await heartbeatCheckpoint(kv, js, jsm, SPACE, { ref: ref("cpsh"), instanceId: IID, epoch: EPOCH, deadline: NOW + 900_000, now: NOW + 100 });
    // gen2's request stays QUEUED (not drained): the delayed gen1 publish has no competitor.
    gate.release();
    const delayed = await delayedArm;
    c("with NO competing arm the delayed gen1 publish wins its CAS (armed:true for the request's generation)",
      delayed.armed === true && delayed.generation === 1);
    c("…but the post-publish re-read SELF-HEALS: the live schedule is generation 2 without gen2's request having been processed",
      (await lastArmedBody("cpsh")).generation === 2);
    await drainAndArm(1); // gen2's queued request: an idempotent no-op replacement at the writer
    c("…and gen2's own delayed request remains a harmless idempotent re-arm", (await lastArmedBody("cpsh")).generation === 2);
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

  // ── re-verify 8ea3abe HIGH 2: a DEL status marker is a deletion, never absence — a re-mint
  //    over it would re-open the one-use checkpoint (KV create can recreate after DEL). ──
  await mintCheckpoint(kv, js, SPACE, { ref: ref("cp7"), instanceId: IID, epoch: EPOCH, holder: holderA, deadline: NOW + 60_000, now: NOW });
  await drainAndArm(1);
  await resumeCheckpoint(kv, js, jsm, SPACE, { ref: ref("cp7"), presenter: holderA, now: NOW + 100 });
  await kv.delete("cp.manager.cp7.status");
  await rejects("a re-mint over a DEL status marker REFUSES (a deleted one-use checkpoint is never resurrected; the same holder cannot resume twice)",
    () => mintCheckpoint(kv, js, SPACE, { ref: ref("cp7"), instanceId: IID, epoch: EPOCH, holder: holderA, deadline: NOW + 60_000, now: NOW + 200 }), "failed-precondition");

  // ── c371d62 HIGH 1: a spec DEL never rebinds the one-use resume holder — the spec create is
  //    CAS-fenced against the key's ENTIRE history, so a deleted spec is a permanent refusal. ──
  await mintCheckpoint(kv, js, SPACE, { ref: ref("cp11"), instanceId: IID, epoch: EPOCH, holder: holderA, deadline: NOW + 60_000, now: NOW });
  await drainAndArm(1);
  await kv.delete("cp.manager.cp11.spec");
  await rejects("a re-mint over a spec DEL marker refuses (a deletion never rebinds the resume holder to a NEW principal)",
    () => mintCheckpoint(kv, js, SPACE, { ref: ref("cp11"), instanceId: IID, epoch: EPOCH, holder: holderB, deadline: NOW + 60_000, now: NOW + 10 }), "failed-precondition");
  await rejects("…and resume against the deleted spec refuses for EVERY presenter (fail-closed, reconcile the store)",
    () => resumeCheckpoint(kv, js, jsm, SPACE, { ref: ref("cp11"), presenter: holderB, now: NOW + 20 }), "failed-precondition");

  // ── c371d62 HIGH 2: the status marker pre-check is only a FAST PATH — the CREATE is the
  //    arbiter. A delete landing after the pre-check read (simulated: a kv whose first status
  //    get answers ABSENT while the real tombstone sits on the broker) loses at the create's
  //    history-covering CAS and is classified fail-closed, never resurrected. ──
  await mintCheckpoint(kv, js, SPACE, { ref: ref("cp12"), instanceId: IID, epoch: EPOCH, holder: holderA, deadline: NOW + 60_000, now: NOW });
  await drainAndArm(1);
  await resumeCheckpoint(kv, js, jsm, SPACE, { ref: ref("cp12"), presenter: holderA, now: NOW + 30 });
  await kv.delete("cp.manager.cp12.status");
  {
    let lied = false;
    const racingKv = new Proxy(kv, {
      get(target, prop) {
        if (prop === "get") return async (k: string, o?: unknown) => {
          if (!lied && k === "cp.manager.cp12.status") { lied = true; return null; }
          return target.get(k, o as never);
        };
        const v = Reflect.get(target, prop, target);
        return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(target) : v;
      },
    });
    await rejects("a status DELETE racing past the mint's marker pre-check STILL refuses at the create (the CAS covers the key's history; the client check is not the arbiter)",
      () => mintCheckpoint(racingKv, js, SPACE, { ref: ref("cp12"), instanceId: IID, epoch: EPOCH, holder: holderA, deadline: NOW + 60_000, now: NOW + 40 }), "failed-precondition");
    c("…and the settlement's derived one-use fact is UNTOUCHED by the deletion (the EPF fact persists)",
      (await readCheckpointSettle(jsm, SPACE, ref("cp12")))?.settle === "resumed");
  }

  // ── re-verify 8ea3abe MEDIUM 1: a lost fact CAS requires a winner CANONICALLY EQUAL to the
  //    status arbiter — a pre-placed contradicting fact is a loud internal, never adopted. ──
  await mintCheckpoint(kv, js, SPACE, { ref: ref("cp8"), instanceId: IID, epoch: EPOCH, holder: holderA, deadline: NOW + 60_000, now: NOW });
  await drainAndArm(1);
  {
    const forged = { v: 1, token: "cp8", settle: "expired", generation: 1, ts: NOW + 50 };
    const h = headers(); h.set("Nats-Expected-Last-Subject-Sequence", "0");
    await js.publish(checkpointSettleSubject(SPACE, ref("cp8")), new TextEncoder().encode(JSON.stringify(forged)), { headers: h });
  }
  await rejects("a pre-placed CONTRADICTING settle fact makes the winning resume throw internal (the arbiter is the status; a contradicting winner is never adopted or returned as authorization)",
    () => resumeCheckpoint(kv, js, jsm, SPACE, { ref: ref("cp8"), presenter: holderA, now: NOW + 100 }), "internal");

  // ── re-verify 8ea3abe MEDIUM 2: closed schemas + exact per-state/per-settle variants ──
  const putStatus = async (token: string, v: Record<string, unknown>) => { await kv.put(`cp.manager.${token}.status`, new TextEncoder().encode(JSON.stringify(v))); };
  await putStatus("cpx1", { state: "waiting", deadlineGeneration: 1, deadline: NOW + 1_000, observedSpecRevision: 1, extra: true });
  await rejects("a status carrying an UNKNOWN field refuses (closed schema)", () => readCheckpointStatus(kv, ref("cpx1")), "internal");
  await putStatus("cpx2", { state: "waiting", deadlineGeneration: 1, deadline: NOW + 1_000, observedSpecRevision: 1, settledTs: NOW });
  await rejects("a WAITING status carrying settled coordinates refuses (cross-variant)", () => readCheckpointStatus(kv, ref("cpx2")), "internal");
  await putStatus("cpx3", { state: "resumed", deadlineGeneration: 1, deadline: NOW + 1_000, observedSpecRevision: 1, settledGeneration: 1, settledTs: NOW });
  await rejects("a RESUMED status without its settled holder refuses (no defaulted attribution)", () => readCheckpointStatus(kv, ref("cpx3")), "internal");
  await putStatus("cpx4", { state: "expired", deadlineGeneration: 1, deadline: NOW + 1_000, observedSpecRevision: 1, settledGeneration: 1, settledTs: NOW, settledHolder: holderA });
  await rejects("an EXPIRED status carrying a holder refuses (an expiry has no resuming principal)", () => readCheckpointStatus(kv, ref("cpx4")), "internal");
  {
    const h = headers(); h.set("Nats-Expected-Last-Subject-Sequence", "0");
    await js.publish(checkpointSettleSubject(SPACE, ref("cpx5")), new TextEncoder().encode(JSON.stringify({ v: 1, token: "cpx5", settle: "expired", generation: 1, holder: holderA, ts: NOW })), { headers: h });
    await rejects("an EXPIRED settle fact carrying a holder refuses (per-settle variant)", () => readCheckpointSettle(jsm, SPACE, ref("cpx5")), "internal");
  }

  // ── re-verify 8ea3abe MEDIUM 3: the timer writer is resource-attested and bounded ──
  {
    const req = (tok: string, sp: string) => ({ subject: eptSubject(sp, "manager", IID, EPOCH, tok, "schedule"), data: new TextEncoder().encode(JSON.stringify({ v: 1, timerId: tok, generation: 1, deadline: NOW + 60_000 })) });
    await rejects("a HAND-ASSEMBLED timer-writer context refuses (the WeakMap carries no resources for a look-alike)",
      () => armCheckpointTimer({ kv, js, space: SPACE } as never, req("cp5", SPACE)), "permission-denied");
    c("the context token exposes NO broker resources to rebind (js/jsm/kv are module-private, distsys 8dcad72 M1)",
      !("js" in wctx) && !("jsm" in wctx) && !("kv" in wctx) && Object.isFrozen(wctx));
    await rejects("a CROSS-SPACE .schedule request refuses (the writer's status authority answers for one space)",
      () => armCheckpointTimer(wctx, req("cp5", "otherspace")), "permission-denied");
    // A stuck status authority: the records-KV leader read never answers (the EPT sequence read
    // before it passes through untouched).
    const hangingNc = new Proxy(nc, {
      get(target, prop) {
        if (prop === "request") return (subj: string, ...rest: unknown[]) =>
          typeof subj === "string" && subj.startsWith("$JS.API.STREAM.MSG.GET.KV_cotal_records_")
            ? new Promise(() => { /* never settles */ })
            : (target as unknown as { request: (...a: unknown[]) => unknown }).request(subj, ...rest);
        const v = Reflect.get(target, prop, target);
        return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(target) : v;
      },
    });
    const hungCtx = await timerWriterContext(hangingNc as never, SPACE);
    await rejects("a STUCK status authority is a bounded unavailable refusal, never a hung writer",
      () => armCheckpointTimer(hungCtx, req("cp5", SPACE), { statusBudgetMs: 100 }), "unavailable");
    await rejects("a non-positive statusBudgetMs refuses", () => armCheckpointTimer(wctx, req("cp5", SPACE), { statusBudgetMs: 0 }), "failed-precondition");

    // M5 (distsys 6e8634d re-open): the request BYTES are COPIED at entry, so a header getter
    // invoked during the scheduling-header scan cannot mutate the body the writer decodes. Mint
    // cpm5 (gen1), heartbeat to gen2; offer a STALE gen1 body whose header getter rewrites the live
    // buffer to the live gen2 body. With the entry copy the writer decodes gen1 (stale, armed:false);
    // a reference (the pre-fix bug) would decode the mutated gen2 body and wrongly arm.
    await mintCheckpoint(kv, js, SPACE, { ref: ref("cpm5"), instanceId: IID, epoch: EPOCH, holder: holderA, deadline: NOW + 60_000, now: NOW });
    await drainAndArm(1);
    await heartbeatCheckpoint(kv, js, jsm, SPACE, { ref: ref("cpm5"), instanceId: IID, epoch: EPOCH, deadline: NOW + 70_000, now: NOW + 100 });
    await drainAndArm(1);
    const gen2Body = new TextEncoder().encode(JSON.stringify({ v: 1, timerId: "cpm5", generation: 2, deadline: NOW + 70_000 }));
    const staleData = new TextEncoder().encode(JSON.stringify({ v: 1, timerId: "cpm5", generation: 1, deadline: NOW + 60_000 }));
    let getCalls = 0;
    const mutatingHeaders = { get: (_h: string) => { getCalls++; staleData.set(gen2Body); return undefined; } };
    const armed = await armCheckpointTimer(wctx, { subject: eptSubject(SPACE, "manager", IID, EPOCH, "cpm5", "schedule"), headers: mutatingHeaders as never, data: staleData });
    c("a header getter cannot mutate the request body the writer decodes (bytes copied at entry): a stale gen1 request stays stale even after a getter rewrites the live buffer to gen2",
      armed.armed === false && getCalls > 0);
  }

  // ── re-verify 8ea3abe MEDIUM 4: full replay identity (deadline included) + entry snapshots ──
  await mintCheckpoint(kv, js, SPACE, { ref: ref("cp9"), instanceId: IID, epoch: EPOCH, holder: holderA, deadline: NOW + 60_000, now: NOW });
  await drainAndArm(1);
  await mintCheckpoint(kv, js, SPACE, { ref: ref("cp9"), instanceId: IID, epoch: EPOCH, holder: holderA, deadline: NOW + 60_000, now: NOW + 100 });
  c("an IDENTICAL mint replay is idempotent (same spec, same deadline)", (await readCheckpointStatus(kv, ref("cp9")))?.value.deadlineGeneration === 1);
  await drainAndArm(1); // the replay re-emits the current schedule (repairs the mint-crash window)
  await rejects("a mint replay with a DIFFERENT deadline is a loud conflict (the deadline is part of the mint identity)",
    () => mintCheckpoint(kv, js, SPACE, { ref: ref("cp9"), instanceId: IID, epoch: EPOCH, holder: holderA, deadline: NOW + 70_000, now: NOW + 200 }), "conflict");

  // ── distsys M1 / freelance HIGH: the OBLIGATIONS are part of the mint identity — a retry that
  //    changes the set (absent→present, or set A→set B) is a DIFFERENT intent, never a silent
  //    adopt that swaps/drops verified attenuations. ──
  {
    const gbind = { caller: { owner: "u_abc", actor: "worker", uid: "u".repeat(26) }, goalId: "g".repeat(26) };
    const obl = (rid: string) => [{ v: 1, space: SPACE, requestId: rid, signer: { keyId: "guard-1" }, attenuations: [{ maxItems: 5 }], iat: NOW - 1_000, exp: NOW + 60_000, sig: "c2ln" }];
    await mintCheckpoint(kv, js, SPACE, { ref: ref("cpo1"), instanceId: IID, epoch: EPOCH, holder: holderA, goal: gbind, obligations: obl("r-a") as never, deadline: NOW + 60_000, now: NOW });
    await drainAndArm(1);
    await mintCheckpoint(kv, js, SPACE, { ref: ref("cpo1"), instanceId: IID, epoch: EPOCH, holder: holderA, goal: gbind, obligations: obl("r-a") as never, deadline: NOW + 60_000, now: NOW + 50 });
    c("an IDENTICAL obligation-bearing mint replay is idempotent (same set, adopted)",
      (await readCheckpointSpec(kv, ref("cpo1")))?.obligations?.[0]?.requestId === "r-a");
    await drainAndArm(1);
    await rejects("a mint replay with a DIFFERENT obligation set is a loud conflict (obligations are part of the mint identity; a swap never silently adopts)",
      () => mintCheckpoint(kv, js, SPACE, { ref: ref("cpo1"), instanceId: IID, epoch: EPOCH, holder: holderA, goal: gbind, obligations: obl("r-b") as never, deadline: NOW + 60_000, now: NOW + 100 }), "conflict");
    await mintCheckpoint(kv, js, SPACE, { ref: ref("cpo2"), instanceId: IID, epoch: EPOCH, holder: holderA, goal: gbind, deadline: NOW + 60_000, now: NOW });
    await drainAndArm(1);
    await rejects("a mint retry ADDING obligations where the first had none is a loud conflict (absent→present drops nothing silently)",
      () => mintCheckpoint(kv, js, SPACE, { ref: ref("cpo2"), instanceId: IID, epoch: EPOCH, holder: holderA, goal: gbind, obligations: obl("r-a") as never, deadline: NOW + 60_000, now: NOW + 100 }), "conflict");
  }
  {
    // Entry snapshot: a ref whose getter answers differently on each read is detached ONCE at
    // entry; every internal read sees the entry-time coordinate.
    let reads = 0;
    const shifty = { endpoint: "manager", get token() { return reads++ === 0 ? "cp10" : "cp-evil"; } } as CheckpointRef;
    await mintCheckpoint(kv, js, SPACE, { ref: shifty, instanceId: IID, epoch: EPOCH, holder: holderA, deadline: NOW + 60_000, now: NOW });
    await drainAndArm(1);
    c("a seam detaches its ref at ENTRY: the shifting ref minted exactly the entry-time token",
      (await readCheckpointStatus(kv, ref("cp10"))) !== undefined && (await readCheckpointStatus(kv, ref("cp-evil"))) === undefined);
  }

  // ── re-review 8dcad72 (distsys): M3 spec-deadline crash identity, M4 admission bounds, M6
  //    reconcile re-read, M7 settled-generation equality ──
  {
    // M7: a settled status whose settledGeneration disagrees with its deadlineGeneration is
    // garbled - a settlement is of the CURRENT generation, never a contradictory coordinate pair.
    await putStatus("cpx6", { state: "expired", deadlineGeneration: 2, deadline: NOW + 1_000, observedSpecRevision: 1, settledGeneration: 1, settledTs: NOW });
    await rejects("a settled status whose settledGeneration != deadlineGeneration refuses (a settlement is of the current generation)",
      () => readCheckpointStatus(kv, ref("cpx6")), "internal");

    // M4: admission (mint AND heartbeat) rejects a deadline beyond the scheduler's representable
    // range, so a MAX_SAFE deadline never strands a waiting checkpoint the writer could not arm.
    await rejects("a mint deadline beyond the scheduler's range refuses at admission",
      () => mintCheckpoint(kv, js, SPACE, { ref: ref("cpm4"), instanceId: IID, epoch: EPOCH, holder: holderA, deadline: Number.MAX_SAFE_INTEGER, now: NOW }), "failed-precondition");
    await rejects("a heartbeat deadline beyond the scheduler's range refuses (never advances to an unarmable deadline)",
      () => heartbeatCheckpoint(kv, js, jsm, SPACE, { ref: ref("cp9"), instanceId: IID, epoch: EPOCH, deadline: Number.MAX_SAFE_INTEGER, now: NOW + 300 }), "failed-precondition");

    // M3: the crash-before-status window. A spec exists WITHOUT a status (the mint crashed after
    // the spec but before the status). A retry with a DIFFERENT deadline must conflict on the
    // spec's IMMUTABLE initialDeadline; a retry with the SAME deadline creates the missing status
    // at the ORIGINAL deadline (never silently installs a divergent one).
    await kv.put(`cp.manager.cpm3.spec`, new TextEncoder().encode(JSON.stringify({ v: 1, token: "cpm3", holder: holderA, mintedAt: NOW, initialDeadline: NOW + 60_000 })));
    await rejects("a retry of a spec-only checkpoint with a DIFFERENT deadline conflicts on the immutable spec initialDeadline",
      () => mintCheckpoint(kv, js, SPACE, { ref: ref("cpm3"), instanceId: IID, epoch: EPOCH, holder: holderA, deadline: NOW + 99_000, now: NOW + 10 }), "conflict");
    await mintCheckpoint(kv, js, SPACE, { ref: ref("cpm3"), instanceId: IID, epoch: EPOCH, holder: holderA, deadline: NOW + 60_000, now: NOW + 10 });
    c("a retry with the SAME deadline creates the missing status at the ORIGINAL deadline",
      (await readCheckpointStatus(kv, ref("cpm3")))?.value.deadline === NOW + 60_000);
    await drainAndArm(1);

    // M6: after a heartbeat advances the generation, the reconciler re-emits the CURRENT
    // generation (it re-reads the authoritative status AFTER the settle-gate, never the stale
    // first-read generation the writer would discard).
    await mintCheckpoint(kv, js, SPACE, { ref: ref("cpm6"), instanceId: IID, epoch: EPOCH, holder: holderA, deadline: NOW + 60_000, now: NOW });
    await drainAndArm(1);
    await heartbeatCheckpoint(kv, js, jsm, SPACE, { ref: ref("cpm6"), instanceId: IID, epoch: EPOCH, deadline: NOW + 120_000, now: NOW + 100 });
    await drainAndArm(1);
    const rec = await reconcileCheckpointSchedule(kv, js, jsm, SPACE, { ref: ref("cpm6"), instanceId: IID, epoch: EPOCH });
    c("the reconciler re-emits the CURRENT generation after a heartbeat advanced it", rec.reEmitted && rec.generation === 2);
    await drainAndArm(1);
  }

  // ── the ANSWER the settlement accepted (design §5.5 delta 1, §17 delta 4b) ──
  //
  // The payload of an answer lives in its own record; what the settle fact adds is the NAME of the
  // one it took. Every resolver of a workflow checkpoint presents as the run driver, so without
  // this field an answer cannot be matched back to the settlement that accepted it — the presenter
  // is the same principal for all of them and discriminates nothing.
  {
    await mintCheckpoint(kv, js, SPACE, { ref: ref("cpa1"), instanceId: IID, epoch: EPOCH, holder: holderA, deadline: NOW + 60_000, now: NOW });
    await drainAndArm(1);
    const settled = await resumeCheckpoint(kv, js, jsm, SPACE, { ref: ref("cpa1"), presenter: holderA, now: NOW + 100, answerId: "ans-1" });
    c("a resume that names an answer carries it on the one-use settle fact", settled.answerId === "ans-1", settled.answerId);
    c("and the STATUS carries it too, which is what makes the fact reconstructable",
      (await readCheckpointStatus(kv, ref("cpa1")))?.value.settledAnswerId === "ans-1");
    // The status is the arbiter and the fact is its derived copy: purge the fact and the repair
    // must rebuild the SAME answer, not a settlement that forgot which answer it accepted.
    await jsm.streams.purge(epfStreamName(SPACE), { filter: checkpointSettleSubject(SPACE, ref("cpa1")) });
    await reconcileCheckpointSchedule(kv, js, jsm, SPACE, { ref: ref("cpa1"), instanceId: IID, epoch: EPOCH });
    c("a fact rebuilt after a crash still names the answer the status recorded",
      (await readCheckpointSettle(jsm, SPACE, ref("cpa1")))?.answerId === "ans-1");

    await mintCheckpoint(kv, js, SPACE, { ref: ref("cpa2"), instanceId: IID, epoch: EPOCH, holder: holderA, deadline: NOW + 60_000, now: NOW });
    await drainAndArm(1);
    await rejects("an answerId that is not an id token is refused at the resume seam, never written",
      () => resumeCheckpoint(kv, js, jsm, SPACE, { ref: ref("cpa2"), presenter: holderA, now: NOW + 100, answerId: "not a token" }), "failed-precondition");
    c("and the refused resume settled nothing: the checkpoint is still waiting",
      (await readCheckpointStatus(kv, ref("cpa2")))?.value.state === "waiting");

    // An expiry accepts nothing, so it may never name an answer — a fact claiming the deadline took
    // somebody's answer would attribute a settlement nobody made. The resume below is PAST the
    // deadline, so the fence turns it into an expiry with an answerId in hand.
    await mintCheckpoint(kv, js, SPACE, { ref: ref("cpa3"), instanceId: IID, epoch: EPOCH, holder: holderA, deadline: NOW + 1_000, now: NOW });
    await drainAndArm(1);
    await rejects("a resume after the deadline still fails closed, answer or no answer",
      () => resumeCheckpoint(kv, js, jsm, SPACE, { ref: ref("cpa3"), presenter: holderA, now: NOW + 2_000, answerId: "ans-late" }), "failed-precondition");
    const expired = await readCheckpointSettle(jsm, SPACE, ref("cpa3"));
    c("and the EXPIRY it drove names no answer at all", expired?.settle === "expired" && expired?.answerId === undefined, JSON.stringify(expired));
  }

  // ── the ANSWER RECORD itself: create-only, content-derived id, never overwritten ──
  {
    const token = "cpa1";
    const id = checkpointAnswerId({ token, by: "david", value: { ship: true } });
    c("an answer id is an id token by construction, so it can key a record and ride a settle fact",
      /^[A-Za-z0-9_-]{1,64}$/.test(id) && id.length === 43, id);
    c("the same answer derives the same id; a different one does not",
      id === checkpointAnswerId({ token, by: "david", value: { ship: true } })
      && id !== checkpointAnswerId({ token, by: "david", value: { ship: false } })
      && id !== checkpointAnswerId({ token, by: "ann", value: { ship: true } }));

    const value = { v: 1 as const, token, answerId: id, value: { ship: true }, by: "david", at: NOW };
    const first = await recordCheckpointAnswer(kv, "manager", value);
    c("filing an answer creates its record", first.created === true);
    c("and it reads back with the payload and the ANSWERER, not the presenter",
      JSON.stringify((await readCheckpointAnswer(kv, "manager", token, id))?.value) === JSON.stringify({ ship: true })
      && (await readCheckpointAnswer(kv, "manager", token, id))?.by === "david");
    const again = await recordCheckpointAnswer(kv, "manager", value);
    c("filing the SAME answer again is this resolver's own retry, not a conflict", again.created === false);
    await rejects("different content under the same id is refused rather than overwritten (an answer is not editable)",
      () => recordCheckpointAnswer(kv, "manager", { ...value, value: { ship: false } }), "conflict");
    c("an id nobody filed reads as absent, never as an empty answer",
      (await readCheckpointAnswer(kv, "manager", token, "nobody-filed-this")) === undefined);
    await kv.delete(`answer.manager.${token}.${id}`);
    await rejects("a DEL marker on an answer refuses: an answer is something that happened",
      () => readCheckpointAnswer(kv, "manager", token, id), "failed-precondition");
  }

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
