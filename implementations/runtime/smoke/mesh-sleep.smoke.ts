/**
 * `sleep` on the real planes, end to end: mint → schedule → arm → fire → settle → the effect returns.
 *
 * The simulator resolves a sleep instantly, which is right for testing a PROGRAM and proves nothing
 * about a run that outlives its process. This is the other half: a real broker, a real timer armed by
 * the timer writer, a real fire, and the one-use settle fact that ends the wait.
 *
 * The load-bearing claim is the second cell. `ctx.requestId` is derived from (runId, stepKey,
 * inputHash, attempt) and written to the journal BEFORE the handler runs, so a crashed run re-derives
 * the same checkpoint token — and `mintCheckpoint` is idempotent-if-identical, so the resumed attempt
 * attaches to the timer the crashed one armed instead of arming a second. Nothing has to be remembered
 * across the crash, which is the point.
 *
 * Run: pnpm smoke:runtime-mesh-sleep   (needs nats-server on PATH)
 */
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect } from "@nats-io/transport-node";
import { jetstream, jetstreamManager } from "@nats-io/jetstream";
import { Kvm } from "@nats-io/kv";
import {
  isReachable,
  createEndpointStreams,
  openRecordsBucket,
  timerWriterContext,
  timerWriterConsumerConfig,
  timerWriterDurable,
  armCheckpointTimer,
  handleCheckpointFire,
  readCheckpointStatus,
  readCheckpointSettle,
  eptReqStreamName,
  eptStreamName,
  eptSubject,
  type CheckpointRef,
} from "@cotal-ai/core";
import { MeshHandler, EpfSettleWatcher } from "../src/index.js";
import { pickFreePort } from "./_free-port.js";

const SPACE = "meshsleep";
const EP = "manager";
const IID = "i".repeat(26);
const EPOCH = 3;
const HOLDER = { id: "manager", lifecycleUid: "u_meshsleep" };

let ok = 0, fail = 0;
const c = (n: string, v: boolean, extra?: unknown) => { if (v) { ok++; } else { fail++; console.log("  ✗ FAIL:", n, extra ?? ""); } };
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

const PORT = await pickFreePort();
const sd = mkdtempSync(join(tmpdir(), "cotal-meshsleep-"));
const broker = spawn("nats-server", ["-js", "-sd", sd, "-p", String(PORT), "-a", "127.0.0.1"], { stdio: "ignore" });
const done = () => {
  try { broker.kill("SIGKILL"); } catch { /* already gone */ }
  rmSync(sd, { recursive: true, force: true });
};
process.on("exit", done);

let up = false;
for (let i = 0; i < 60 && !up; i += 1) { up = await isReachable(`nats://127.0.0.1:${PORT}`); if (!up) await wait(100); }
if (!up) throw new Error(`nats-server did not come up on ${PORT}`);

const nc = await connect({ servers: `nats://127.0.0.1:${PORT}` });
const js = jetstream(nc);
const jsm = await jetstreamManager(nc);
await createEndpointStreams(jsm, new Kvm(nc), SPACE);
const kv = await openRecordsBucket(nc, SPACE);

// The timer writer, as its own loop — the mediated component that turns a `.schedule` REQUEST into an
// armed broker schedule. The driver never arms anything itself: it asks.
await jsm.consumers.add(eptReqStreamName(SPACE), timerWriterConsumerConfig(SPACE, { ackWaitMs: 5_000 }));
const writerC = await js.consumers.get(eptReqStreamName(SPACE), timerWriterDurable(SPACE));
const wctx = await timerWriterContext(nc, SPACE);
const armPending = async (expect: number): Promise<number> => {
  let armed = 0;
  for await (const m of await writerC.fetch({ max_messages: expect, expires: 2_000 })) {
    const r = await armCheckpointTimer(wctx, { subject: m.subject, headers: m.headers, data: m.data });
    if (r.armed) armed += 1;
    m.ack();
  }
  return armed;
};

/** Take the broker's FIRE for this token and expire the checkpoint it names. */
const deliverFire = async (ref: CheckpointRef, now: number): Promise<number> => {
  const subject = eptSubject(SPACE, EP, IID, EPOCH, ref.token, "fire");
  const fired = await jsm.streams.getMessage(eptStreamName(SPACE), { last_by_subj: subject }).catch(() => null);
  if (fired === null) return -1;
  const v = await handleCheckpointFire(kv, js, jsm, SPACE, {
    ref, instanceId: IID, epoch: EPOCH,
    msg: { subject, headers: fired.header, data: fired.data },
    now,
  });
  return v.acted ? 1 : 0;
};

// A REAL wall clock, because the schedules are real: the broker arms an actual timer at the deadline
// this handler computes, and a fabricated future clock would arm one that fires next year. The
// handler's clock is still pinned to one reading so the deadline is a value the cells can name.
const NOW = Date.now();
/** Sit until the broker's own timer is genuinely past due, then give it a moment to publish. */
const waitPast = async (deadline: number) => { while (Date.now() < deadline + 400) await wait(100); };
const handler = new MeshHandler(
  kv, js, jsm,
  { space: SPACE, endpoint: EP, runId: "r-sleep", instanceId: IID, epoch: EPOCH, holder: HOLDER },
  new EpfSettleWatcher(js, jsm, SPACE, 3_000),
  () => NOW,
);

// A step's identity, exactly as the interpreter would hand it over: recorded on the pending entry
// BEFORE the handler is called, which is what makes it survive a crash.
const ctx = (requestId: string) => ({ requestId, attempt: 0 } as never);
const TOKEN = "cnRlc3Rfc2xlZXBfdG9rZW5fMDAwMQ";

// ── 1) a sleep pauses durably before it waits ────────────────────────────────────────────────
{
  const sleeping = handler.sleep({ duration: "2s" }, ctx(TOKEN));
  // Give the mint time to land, then look at what exists BEFORE anything fires. A durable pause
  // that is only in memory is the defect this whole plane exists to prevent.
  await wait(300);
  const st = await readCheckpointStatus(kv, { endpoint: EP, token: TOKEN });
  c("the sleep is a durable checkpoint before it is a wait: a `waiting` status exists",
    st?.value.state === "waiting", st?.value.state);
  c("with the deadline the duration asked for, in the owner's clock",
    st?.value.deadline === NOW + 2_000, `${st?.value.deadline} vs ${NOW + 2_000}`);

  const armed = await armPending(4);
  c("and the timer writer had exactly ONE schedule request to arm: the MINT asks, the handler never does",
    armed === 1, armed);

  // Now the fire — the broker's own, not one we wrote. This is the timer expiring, which for a
  // sleep is the whole story: nobody will ever resolve this token.
  await waitPast(NOW + 2_000);
  const acted = await deliverFire({ endpoint: EP, token: TOKEN }, NOW + 2_500);
  c("the fire expires the checkpoint", acted === 1, acted);

  await sleeping;
  c("and the effect returns once the settle fact exists", true);
  const settle = await readCheckpointSettle(jsm, SPACE, { endpoint: EP, token: TOKEN });
  c("the settle fact is the expiry, not an answer: a sleep is a checkpoint nobody answers",
    settle?.settle === "expired", settle?.settle);
}

// ── 2) the same step, after a crash, ATTACHES rather than arming a second timer ───────────────
//
// The identity was recorded before the work started, so the resumed attempt derives the same token.
// If this minted a second checkpoint, a run that crashed while asleep would come back holding two
// timers and would be settled by whichever fired first — under a deadline nobody chose.
{
  const TOKEN2 = "cnRlc3RfYXR0YWNoX3Rva2VuXzAwMDI";
  const first = handler.sleep({ duration: "6s" }, ctx(TOKEN2));
  await wait(300);
  await armPending(4);
  const before = await readCheckpointStatus(kv, { endpoint: EP, token: TOKEN2 });

  // The "crash": the first wait is abandoned and the step is performed again under its recorded id.
  const second = handler.sleep({ duration: "6s" }, ctx(TOKEN2));
  await wait(300);
  const after = await readCheckpointStatus(kv, { endpoint: EP, token: TOKEN2 });

  c("the resumed attempt did not mint a second checkpoint: same token, same generation",
    before?.value.generation === after?.value.generation,
    `${before?.value.generation} -> ${after?.value.generation}`);
  c("and it kept the ORIGINAL deadline rather than pushing it out on every resume",
    before?.value.deadline === after?.value.deadline,
    `${before?.value.deadline} vs ${after?.value.deadline}`);
  c("with no second schedule request left unarmed behind it", (await armPending(4)) <= 1);

  await waitPast(NOW + 6_000);
  const acted = await deliverFire({ endpoint: EP, token: TOKEN2 }, NOW + 6_500);
  c("one fire settles it", acted === 1, acted);
  await Promise.all([first, second]);
  c("and BOTH waiters return: they were waiting on one fact, not two", true);
}

console.log(`mesh-sleep.smoke: ${ok} passed, ${fail} failed`);
done();
process.exit(fail === 0 ? 0 : 1);
