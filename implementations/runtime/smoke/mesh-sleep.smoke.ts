/**
 * `sleep` on the real planes, end to end: mint → schedule → arm → fire → settle → the effect returns.
 *
 * The simulator resolves a sleep instantly, which is right for testing a PROGRAM and proves nothing
 * about a run that outlives its process. This is the other half: a real broker, a real timer armed by
 * the timer writer, a real fire, and the one-use settle fact that ends the wait.
 *
 * The load-bearing claim is the second block. `ctx.requestId` is derived from (runId, stepKey,
 * inputHash, attempt) and written to the journal BEFORE the handler runs, so a crashed run re-derives
 * the same checkpoint token, and the resumed attempt attaches to the timer the crashed one armed
 * instead of arming a second. Nothing has to be remembered across the crash, which is the point — but
 * attaching is not free, because a mint is idempotent only if the whole spec is identical and a
 * deadline recomputed from the clock is not. The handler reads the recorded one, and the block that
 * grades it lets real time pass between the attempts, since a crash is a gap in time by definition.
 *
 * Run: pnpm smoke:runtime-mesh-sleep   (needs nats-server on PATH)
 */
import { spawn } from "node:child_process";
import assert from "node:assert/strict";
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
  readCheckpointStatus,
  readCheckpointSpec,
  readCheckpointSettle,
  mintCheckpoint,
  EpEnvelopeError,
  eptReqStreamName,
  eptStreamName,
  eptSubject,
} from "@cotal-ai/core";
import { MeshHandler, EpfSettleWatcher, MeshHandler as ShippedMeshHandler } from "@cotal-ai/runtime";
import { pickFreePort } from "./_free-port.js";
import { SMOKE_BROKER_TOKEN, teardownOnSignal } from "@cotal-ai/smoke-kit";

const SPACE = "meshsleep";
const EP = "manager";
const IID = "i".repeat(26);
const EPOCH = 3;
const HOLDER = { id: "manager", lifecycleUid: "u_meshsleep" };
const CALLER = { owner: "local", actor: "wf_meshsuite", uid: "a".repeat(26) };

let ok = 0, fail = 0;
const c = (n: string, v: boolean, extra?: unknown) => { if (v) { ok++; } else { fail++; console.log("  ✗ FAIL:", n, extra ?? ""); } };
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A cell whose claim is "this ENDS" must fail as a RED, not as a suite that stops. A bare `await`
 *  on a pause that never expires hangs the whole file, which scores as a timeout — graded on the
 *  harness's patience rather than on the code, and indistinguishable from a broker that never came
 *  up. So every wait that is asserting termination carries its own deadline. */
const withDeadline = async <T>(p: Promise<T>, ms: number, what: string): Promise<T | undefined> => {
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<undefined>((r) => { timer = setTimeout(() => r(undefined), ms); });
  try {
    const got = await Promise.race([p.then((v) => ({ v })), late]);
    if (got === undefined) { fail++; console.log(`  ✗ FAIL: ${what} did not end within ${ms}ms`); return undefined; }
    return got.v;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
};

const PORT = await pickFreePort();
const sd = mkdtempSync(join(tmpdir(), `${SMOKE_BROKER_TOKEN}meshsleep-`));
const broker = spawn("nats-server", ["-js", "-sd", sd, "-p", String(PORT), "-a", "127.0.0.1"], { stdio: "ignore" });
teardownOnSignal(broker, sd);
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
// Short, and deliberately so: a fetch window that straddles a deadline collects the RE-ARM the fire
// handler emits under owner-behind clock skew, and the cell counting schedule requests would then be
// counting the pump's correct behaviour as a second arming.
const armPending = async (expect: number): Promise<number> => {
  let armed = 0;
  for await (const m of await writerC.fetch({ max_messages: expect, expires: 1_000 })) {
    const r = await armCheckpointTimer(wctx, { subject: m.subject, headers: m.headers, data: m.data });
    if (r.armed) armed += 1;
    m.ack();
  }
  return armed;
};

/** Take schedule requests off the stream and arm NOTHING: a writer that read the request and died
 *  before it armed anything. Used to open the crash-before-arm window on purpose. */
const dropPending = async (expect: number): Promise<number> => {
  let seen = 0;
  for await (const m of await writerC.fetch({ max_messages: expect, expires: 1_000 })) { seen += 1; m.ack(); }
  return seen;
};

/** Whether the broker has published its own `.fire` for this token yet — an OBSERVATION of the
 *  timer plane, never a delivery. Nothing in this suite hands the handler a fire: taking one is the
 *  handler's own job, and a suite that did it on the handler's behalf would be grading itself. */
const brokerFired = async (token: string): Promise<boolean> => {
  const subject = eptSubject(SPACE, EP, IID, EPOCH, token, "fire");
  const fired = await jsm.streams.getMessage(eptStreamName(SPACE), { last_by_subj: subject }).catch(() => null);
  return fired !== null && fired !== undefined;
};

// A REAL wall clock, because the schedules are real: the broker arms an actual timer at the deadline
// this handler computes, and a fabricated future clock would arm one that fires next year. It is
// read through a variable rather than called directly so a deadline is a value the cells can name —
// and it is ADVANCED when real time passes, because expiry is a judgement about the owner's clock
// and a clock frozen before its own deadline would judge every real fire premature.
const NOW = Date.now();
let CLOCK = NOW;
/** Sit until the broker's own timer is genuinely past due, then let the owner's clock see it. */
const waitPast = async (deadline: number) => {
  while (Date.now() < deadline + 400) await wait(100);
  CLOCK = Date.now();
};
const handler = new MeshHandler(
  nc, kv, js, jsm,
  { space: SPACE, endpoint: EP, runId: "r-sleep", caller: CALLER, instanceId: IID, epoch: EPOCH, holder: HOLDER, defaultCheckpointTimeout: "1h" },
  new EpfSettleWatcher(jsm, SPACE, 3_000),
  () => CLOCK,
);

// A step's identity, exactly as the interpreter would hand it over: recorded on the pending entry
// BEFORE the handler is called, which is what makes it survive a crash.
/** The full contract a handler is called under, signal included; `cancel` is the test's hand on
 *  it, for the cells that grade what a losing branch's pause does. */
const ctx = (requestId: string) => {
  const listeners: ((reason: string) => void)[] = [];
  const signal = {
    cancelled: false,
    reason: undefined as string | undefined,
    onCancel: (fn: (reason: string) => void) => { listeners.push(fn); },
  };
  const cancel = (reason: string) => {
    if (signal.cancelled) return;
    signal.cancelled = true;
    signal.reason = reason;
    for (const fn of listeners) fn(reason);
  };
  return { ctx: { requestId, attempt: 0, signal } as never, cancel };
};
const TOKEN = "cnRlc3Rfc2xlZXBfdG9rZW5fMDAwMQ";

// Delay the response to a real broker read, not its contents or the owner's clock.
// A 1ms relative sleep has elapsed before the first mint can be considered.
{
  const binding = { space: SPACE, endpoint: EP, runId: "r-sleep", caller: CALLER,
    instanceId: IID, epoch: EPOCH, holder: HOLDER, defaultCheckpointTimeout: "1h" };
  let reads = 0;
  let afterRead: (() => void) | undefined;
  const slowKv = new Proxy(kv, {
    get(target, property) {
      if (property === "get") return async (...args: Parameters<typeof kv.get>) => {
        const result = await target.get(...args);
        if (args[0].startsWith(`cp.${EP}.`)) {
          reads++;
          await wait(30);
          afterRead?.();
        }
        return result;
      };
      const value = Reflect.get(target, property);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const live = new ShippedMeshHandler(nc, slowKv, js, jsm, binding,
    new EpfSettleWatcher(jsm, SPACE, 3_000), Date.now);
  const elapsedToken = "c3775_elapsed_sleep";
  const elapsed = await live.sleep({ duration: "1ms" }, ctx(elapsedToken).ctx)
    .then(value => ({ value }), error => ({ error }));
  console.log(`• S3775 — first sleep returned after ${reads} real pre-mint reads`);
  try {
    assert.ok("value" in elapsed && elapsed.value === null,
      "S3775 elapsed relative sleep completes after the real broker pre-mint read");
  } finally {
    // This first predicate finished. Later controls and the suite may still be unreached.
    console.log("S3775 elapsed-sleep cell: predicate evaluated");
  }
  c("S3775 the shipped runtime reaches a real delayed checkpoint read", reads > 0, reads);
  c("S3775 an elapsed unminted sleep creates no checkpoint",
    await readCheckpointSpec(kv, { endpoint: EP, token: elapsedToken }) === undefined);
  // The same token can be re-entered after an interrupted dispatch without inventing a pause.
  const replay = await live.sleep({ duration: "1ms" }, ctx(elapsedToken).ctx)
    .then(value => ({ value }), error => ({ error }));
  c("S3775 an unminted elapsed sleep re-entry completes with the same token", "value" in replay && replay.value === null);

  const cancelled = ctx("c3775_cancelled_sleep");
  afterRead = () => cancelled.cancel("cancelled during the authorized arming read");
  const cancellation = await live.sleep({ duration: "1ms" }, cancelled.ctx)
    .then(() => undefined, error => error as Error);
  c("S3775 cancellation during pre-mint work remains Cancelled", cancellation?.name === "Cancelled", cancellation);
  afterRead = undefined;

  const expiredContext = { ...ctx("c3775_expired_checkpoint").ctx as object, bind: async () => {} } as never;
  const expiry = await live.checkpoint({ prompt: "keep checkpoint expiry", timeout: "1ms" }, expiredContext)
    .then(() => undefined, error => error as Error);
  c("S3775 checkpoint pre-mint expiry is not swallowed by relative sleep handling",
    expiry?.constructor.name === "PauseOverdue", expiry);

  const now = Date.now();
  const futureOnly = await mintCheckpoint(kv, js, SPACE, {
    ref: { endpoint: EP, token: "c3775_core_future_only" }, instanceId: IID, epoch: EPOCH,
    holder: HOLDER, deadline: now - 1, now,
  }).then(() => undefined, error => error);
  c("S3775 core still refuses a non-future checkpoint mint", futureOnly instanceof EpEnvelopeError, futureOnly);
  console.log("• S3775 — elapsed sleep, cancellation, checkpoint expiry and core future mint controls reached");
}

// ── 1) a sleep pauses durably before it waits ────────────────────────────────────────────────
{
  const sleeping = handler.sleep({ duration: "4s" }, ctx(TOKEN).ctx);
  // Give the mint time to land, then look at what exists BEFORE anything fires. A durable pause
  // that is only in memory is the defect this whole plane exists to prevent.
  await wait(300);
  const st = await readCheckpointStatus(kv, { endpoint: EP, token: TOKEN });
  c("the sleep is a durable checkpoint before it is a wait: a `waiting` status exists",
    st?.value.state === "waiting", st?.value.state);
  c("with the deadline the duration asked for, in the owner's clock",
    st?.value.deadline === NOW + 4_000, `${st?.value.deadline} vs ${NOW + 4_000}`);

  const armed = await armPending(4);
  c("and the timer writer had exactly ONE schedule request to arm: the MINT asks, the handler never does",
    armed === 1, armed);
  // A PROGRESS MARK, printed upstream of everything that touches the fire. Without one, a mutation
  // that stops the run before this point is indistinguishable from a suite that noticed nothing.
  console.log("• 1 — the pause is durable and exactly one schedule was armed");

  // Now the fire — the broker's own, and nobody hands it over. This is the timer expiring, which
  // for a sleep is the whole story: nobody will ever resolve this token.
  await waitPast(NOW + 4_000);
  c("the broker published its own fire on the token's subject", await brokerFired(TOKEN));

  // NOBODY HANDS THE FIRE OVER. A cell that calls `handleCheckpointFire` by hand grades that the
  // checkpoint plane expires a pause when somebody delivers its fire, which was never the question:
  // the question is whether the run's own watcher takes one. Without that, a sleep whose fire has
  // been published sits `waiting` with no settle fact and the effect pending, durably and forever.
  await withDeadline(sleeping, 20_000, "the sleep effect");
  c("and the effect returns on its own: taking the fire is the handler's job, not a caller's", true);
  const settle = await readCheckpointSettle(jsm, SPACE, { endpoint: EP, token: TOKEN });
  c("the settle fact is the expiry, not an answer: a sleep is a checkpoint nobody answers",
    settle?.settle === "expired", settle?.settle);
}

// ── 2) the same step, after a crash, ATTACHES rather than arming a second timer ───────────────
//
// The identity was recorded before the work started, so the resumed attempt derives the same token.
// If this minted a second checkpoint, a run that crashed while asleep would come back holding two
// timers and would be settled by whichever fired first — under a deadline nobody chose.
//
// ON ITS OWN CLOCK, AND THAT IS THE WHOLE CELL. A crash is a gap in time by definition, so a cell
// that grades a resume has to let real time pass or it is grading the arithmetic: on a held clock
// both attempts compute the same `now() + duration` and the mint agrees without anything having
// attached. On the clock a real host has, the second attempt's recomputed deadline is a DIFFERENT
// spec, and a mint is idempotent only for an identical one.
{
  console.log("• 2 — the same step after a crash");
  const TOKEN2 = "cnRlc3RfYXR0YWNoX3Rva2VuXzAwMDI";
  const live = new MeshHandler(
    nc, kv, js, jsm,
    { space: SPACE, endpoint: EP, runId: "r-sleep", caller: CALLER, instanceId: IID, epoch: EPOCH, holder: HOLDER, defaultCheckpointTimeout: "1h" },
    new EpfSettleWatcher(jsm, SPACE, 3_000),
    () => Date.now(),
  );
  const first = live.sleep({ duration: "8s" }, ctx(TOKEN2).ctx);
  await wait(300);
  await armPending(4);
  const before = await readCheckpointStatus(kv, { endpoint: EP, token: TOKEN2 });

  // The "crash": the first wait is abandoned and the step is performed again under its recorded id,
  // after real time has passed, which is what makes the recomputed deadline differ.
  await wait(1_200);
  const second = live.sleep({ duration: "8s" }, ctx(TOKEN2).ctx);
  let refused: string | undefined;
  second.catch((e: unknown) => { refused = (e as Error).message; });
  await wait(300);
  c("the resumed attempt was not refused: it attaches to the recorded pause rather than re-minting",
    refused === undefined, refused);
  const after = await readCheckpointStatus(kv, { endpoint: EP, token: TOKEN2 });

  c("the resumed attempt did not mint a second checkpoint: same token, same generation",
    before?.value.generation === after?.value.generation,
    `${before?.value.generation} -> ${after?.value.generation}`);
  c("and it kept the ORIGINAL deadline rather than pushing it out on every resume",
    before?.value.deadline === after?.value.deadline,
    `${before?.value.deadline} vs ${after?.value.deadline}`);
  c("with no second schedule request left unarmed behind it", (await armPending(4)) <= 1);

  // Read from the RECORD rather than recomputed here: the deadline is whatever the mint wrote, and
  // a test that recomputed it would be asserting against its own arithmetic.
  await waitPast(before!.value.deadline);
  c("the broker published one fire, for the one timer that was armed", await brokerFired(TOKEN2));
  await withDeadline(Promise.all([first, second]), 20_000, "both waiters");
  c("and BOTH waiters return: they were waiting on one fact, not two", true);
}

// ── 3) a resume that arrives AFTER the deadline it is resuming, with the timer never armed ────
//
// The worst of the crash windows and the one a mint cannot repair: the pause was recorded, the
// schedule request was written, nobody armed it, and the host stayed away past the deadline. A mint
// is refused here by design — a deadline in the past is not something to arm — so the repair is the
// reconciler re-emitting the schedule at the status's current generation, and the fire that follows
// is what ends the pause. Without it the run comes back to a pause that is due, unarmed, and
// permanent: nothing red, nothing wrong, and nothing ever happening.
{
  console.log("• 3 — a resume that arrives after its own deadline, never armed");
  const TOKEN3 = "cnRlc3Rfb3ZlcmR1ZV90b2tlbl8wMDAz";
  const live = new MeshHandler(
    nc, kv, js, jsm,
    { space: SPACE, endpoint: EP, runId: "r-sleep", caller: CALLER, instanceId: IID, epoch: EPOCH, holder: HOLDER, defaultCheckpointTimeout: "1h" },
    new EpfSettleWatcher(jsm, SPACE, 3_000),
    () => Date.now(),
  );
  const first = live.sleep({ duration: "2s" }, ctx(TOKEN3).ctx);
  first.catch(() => { /* the abandoned attempt */ });
  await wait(300);
  // THE REQUEST IS TAKEN AND THROWN AWAY, which is the window this block is about: a writer read it
  // and died before it armed anything. It has to be GONE, or the resume's own `armPending` arms the
  // original request, the pause ends on that timer, and the cell passes with no reconciler at all.
  const dropped = await dropPending(4);
  c("the one schedule request was consumed by a writer that armed nothing: the crash-before-arm window",
    dropped === 1, dropped);
  const armedBefore = await brokerFired(TOKEN3);
  await wait(3_000);
  c("nothing fired while the timer was never armed, so the pause is due and nobody is coming",
    !armedBefore && !(await brokerFired(TOKEN3)));

  const resumed = live.sleep({ duration: "2s" }, ctx(TOKEN3).ctx);
  let refused: string | undefined;
  resumed.catch((e: unknown) => { refused = (e as Error).message; });
  await wait(500);
  c("the overdue resume is not refused: a past deadline is reconciled, not re-minted", refused === undefined, refused);
  c("and it asked for the schedule again, which is now the only thing that can still arm it",
    (await armPending(8)) === 1);
  await withDeadline(resumed, 20_000, "the overdue sleep");
  const settle3 = await readCheckpointSettle(jsm, SPACE, { endpoint: EP, token: TOKEN3 });
  c("the pause ends as an expiry, on the deadline it recorded before the crash", settle3?.settle === "expired", settle3?.settle);
}

// ── 4 — a sleep whose branch lost stops parking NOW, and claims its pause ─────────────────────
// The other exit a durable pause has (#532). A `sleep` in a race's losing arm used to ignore its
// signal and park to its own deadline, holding the scope's `allSettled` hostage for the rest of
// the duration. The cancellation must end the park within the settle pump's poll, reject with
// `Cancelled` (the class perform.ts settles the entry `cancelled` for), and CLAIM the pause, so
// the armed schedule cannot fire into a branch that is over.
{
  const TOKEN4 = "cnRlc3RfY2FuY2VsX3Rva2VuXzA0";
  const { ctx: k, cancel } = ctx(TOKEN4);
  const parked = handler.sleep({ duration: "8m" }, k).then(() => null, (e: Error) => e);
  await wait(600);
  const before = await readCheckpointStatus(kv, { endpoint: EP, token: TOKEN4 });
  c("the pause was minted and waiting before the cancellation", before?.value.state === "waiting", before?.value.state);
  cancel("a sibling branch won the race");
  const out = await withDeadline(parked, 10_000, "the cancelled sleep");
  c("a cancelled sleep rejects `Cancelled` promptly rather than waiting out its deadline",
    out instanceof Error && out.name === "Cancelled", String(out));
  // The claim is issued on the cancellation path but not awaited by it; give it its moment.
  let claimed = false;
  for (let i = 0; i < 50 && !claimed; i += 1) {
    claimed = (await readCheckpointStatus(kv, { endpoint: EP, token: TOKEN4 }))?.value.state !== "waiting";
    if (!claimed) await wait(100);
  }
  c("and the pause is claimed: the schedule of a branch that is over has nothing left to fire into", claimed);
}

console.log(`mesh-sleep.smoke: ${ok} passed, ${fail} failed`);
done();
process.exit(fail === 0 ? 0 : 1);
