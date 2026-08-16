/**
 * `checkpoint` on the real planes: a program pauses, a person answers through the run driver, and
 * the answer the program reads is the one the arbiter accepted.
 *
 * The load-bearing cell is the RACE. A workflow checkpoint's holder is the run driver, and every
 * resolver reaches it through `resolveCheckpoint`, so every presenter is the SAME principal — which
 * means an answer cannot be matched back to the winning settlement by who presented it. Two
 * resolvers answering at once must therefore end with the program reading the winner's value and
 * not the last one written, and that property is exactly what the `(token, answerId)` key and the
 * `answerId` on the settle fact exist to provide. A suite that only ever resolved a checkpoint once
 * would pass with the rejected first draft of this shape.
 *
 * Everything else here is about honesty at the edges: an expiry returns an expiry rather than an
 * empty answer, a late resolver is told it was late rather than told it succeeded, and a resume
 * that named no answer at all raises instead of inventing a value.
 *
 * Run: pnpm smoke:runtime-mesh-checkpoint   (needs nats-server on PATH)
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
  readCheckpointSettle,
  readCheckpointAnswer,
  readCheckpointStatus,
  resumeCheckpoint,
  mintCheckpoint,
  activateRun,
  checkpointAnswerId,
  eptReqStreamName,
  eptStreamName,
  eptSubject,
  type CheckpointRef,
} from "@cotal-ai/core";
import {
  MeshHandler,
  EpfSettleWatcher,
  CheckpointAnswerMissing,
  resolveCheckpoint,
  openCheckpointToken,
  CheckpointNotOpen,
  outstandingPauseTokens,
  rearmOutstandingPauses,
  startRun,
} from "../src/index.js";
import { pickFreePort } from "./_free-port.js";

const SPACE = "meshcp";
const EP = "manager";
const IID = "i".repeat(26);
const EPOCH = 4;
const HOLDER = { id: "manager", lifecycleUid: "u_meshcp" };

let ok = 0, fail = 0;
const c = (n: string, v: boolean, extra?: unknown) => { if (v) { ok++; } else { fail++; console.log("  ✗ FAIL:", n, extra ?? ""); } };
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

const PORT = await pickFreePort();
const sd = mkdtempSync(join(tmpdir(), "cotal-meshcp-"));
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

// The mediated timer writer as its own loop: the driver publishes `.schedule` REQUESTS and never
// arms anything itself.
await jsm.consumers.add(eptReqStreamName(SPACE), timerWriterConsumerConfig(SPACE, { ackWaitMs: 5_000 }));
const writerC = await js.consumers.get(eptReqStreamName(SPACE), timerWriterDurable(SPACE));
const wctx = await timerWriterContext(nc, SPACE);
const armPending = async (expect: number): Promise<number> => {
  let armed = 0;
  for await (const m of await writerC.fetch({ max_messages: expect, expires: 1_500 })) {
    const r = await armCheckpointTimer(wctx, { subject: m.subject, headers: m.headers, data: m.data });
    if (r.armed) armed += 1;
    m.ack();
  }
  return armed;
};

/** Take the broker's own FIRE for a token and expire the checkpoint it names. */
const deliverFire = async (ref: CheckpointRef, now: number, epoch = EPOCH): Promise<number> => {
  const subject = eptSubject(SPACE, EP, IID, epoch, ref.token, "fire");
  const fired = await jsm.streams.getMessage(eptStreamName(SPACE), { last_by_subj: subject }).catch(() => null);
  if (fired === null) return -1;
  const v = await handleCheckpointFire(kv, js, jsm, SPACE, {
    ref, instanceId: IID, epoch,
    msg: { subject, headers: fired.header, data: fired.data },
    now,
  });
  return v.acted ? 1 : 0;
};

const NOW = Date.now(); // real schedules need real wall-clock deadlines
const binding = {
  space: SPACE, endpoint: EP, runId: "r-cp", instanceId: IID, epoch: EPOCH, holder: HOLDER,
  defaultCheckpointTimeout: "1h",
};
const handler = new MeshHandler(kv, js, jsm, binding, new EpfSettleWatcher(js, jsm, SPACE, 3_000), () => NOW);
const deps = { kv, js, jsm, space: SPACE, endpoint: EP, holder: HOLDER };

const PROGRAM = `
const a = await checkpoint("approve", "Ship it?", { timeout: "1h", onExpiry: "proceed" });
`;
const STEP = "/checkpoint:approve#0";

let takeovers = 0;
const lease = (holder: string, epoch: number, fencingToken: number) =>
  ({ holder, epoch, fencingToken, takeoverId: `t${(takeovers += 1)}` });

/** Start a run that will pause, and wait until its pause is actually durable. */
const startPaused = async (runId: string) => {
  const driven = startRun(js, jsm, {
    space: SPACE, endpoint: EP, kv, runId, source: PROGRAM, lease: lease("m1", 1, takeovers + 1), handler,
  });
  for (let i = 0; i < 100; i += 1) {
    const token = await tokenOf(runId);
    if (token !== undefined && (await readCheckpointStatus(kv, { endpoint: EP, token })) !== undefined) {
      return { driven, token };
    }
    await wait(50);
  }
  throw new Error(`run ${runId} never reached its checkpoint`);
};
/** The token the run is waiting on, read the way a resolver reads it: out of the journal. */
const tokenOf = async (runId: string): Promise<string | undefined> => {
  try {
    // openCheckpointToken is exercised for real below; here it is only the probe.
    const { replayRunJournal, newTakeoverId } = await import("@cotal-ai/core");
    const replay = await replayRunJournal(js, jsm, SPACE, runId, newTakeoverId());
    const entries = replay.records.filter((r) => r.record.kind === "step").map((r) => (r.record as { entry: unknown }).entry);
    return openCheckpointToken(entries as never, runId, STEP);
  } catch {
    return undefined;
  }
};

// ── 1) a checkpoint pauses, is answered through the driver, and the program reads the answer ──
{
  const { driven, token } = await startPaused("cp-1");
  await armPending(4);
  const st = await readCheckpointStatus(kv, { endpoint: EP, token });
  c("the pause is durable before anybody answers: a `waiting` status exists", st?.value.state === "waiting", st?.value.state);

  const r = await resolveCheckpoint(deps, { runId: "cp-1", stepKey: STEP, by: "david", value: { ship: true }, now: NOW + 1_000 });
  c("the resolve settles the checkpoint as RESUMED", r.settle.settle === "resumed", r.settle.settle);
  c("and the settle NAMES the answer it accepted", r.settle.answerId === r.answerId, `${r.settle.answerId} vs ${r.answerId}`);

  const filed = await readCheckpointAnswer(kv, EP, r.token, r.answerId);
  c("the answer itself is a record, keyed (token, answerId), carrying the value and the answerer",
    filed?.by === "david" && JSON.stringify(filed?.value) === JSON.stringify({ ship: true }), JSON.stringify(filed));

  const out = await driven;
  c("the run completes", out.status === "completed", out.status === "completed" ? "" : out.reason?.name);
  const entry = out.status === "completed"
    ? out.result.journal.entries().find((e) => e.kind === "checkpoint")
    : undefined;
  // The journal holds the RAW outcome, not the program's `CheckpointResult`: whether an expiry
  // throws or returns is `onExpiry`, recomputed from today's source on every replay, and recording
  // the policy's answer would bake one reading of it into the record.
  const rec = entry?.result as { outcome?: string; value?: unknown; by?: string; answerId?: string } | undefined;
  c("and the program's checkpoint resolved with the value that was answered",
    rec?.outcome === "resolved" && JSON.stringify(rec?.value) === JSON.stringify({ ship: true }), JSON.stringify(rec));
  c("the recorded outcome names the answer it came from, so the journal is readable back to the record",
    rec?.answerId === r.answerId, `${rec?.answerId} vs ${r.answerId}`);
  c("attributed to the ANSWERER, not to the driver that presented the token", rec?.by === "david", rec?.by);
}

// ── 2) two resolvers race: the program reads the WINNER, not the last write ──────────────────
//
// This is the cell the record's key exists for. Both answers are filed — they are different values,
// so they are different ids — and exactly one settlement happens. If the answer were one slot per
// token, or if the settle did not name its choice, the program would read whichever write landed
// last, which is a different answer from the one that won.
{
  const { driven, token } = await startPaused("cp-2");
  await armPending(4);

  const yes = resolveCheckpoint(deps, { runId: "cp-2", stepKey: STEP, by: "ann", value: "yes", now: NOW + 1_000 });
  const no = resolveCheckpoint(deps, { runId: "cp-2", stepKey: STEP, by: "bob", value: "no", now: NOW + 1_000 });
  const results = await Promise.allSettled([yes, no]);
  const won = results.filter((r) => r.status === "fulfilled");
  const lost = results.filter((r) => r.status === "rejected");
  c("exactly one resolver wins the one-use settlement", won.length === 1 && lost.length === 1, `${won.length}/${lost.length}`);

  const winner = (won[0] as PromiseFulfilledResult<Awaited<typeof yes>>).value;
  const bothFiled = await Promise.all([
    readCheckpointAnswer(kv, EP, token, checkpointAnswerId({ token, by: "ann", value: "yes" })),
    readCheckpointAnswer(kv, EP, token, checkpointAnswerId({ token, by: "bob", value: "no" })),
  ]);
  c("BOTH answers are filed: the loser's record is orphaned, never overwritten",
    bothFiled[0] !== undefined && bothFiled[1] !== undefined, bothFiled.map((a) => a?.by).join(","));

  const out = await driven;
  const rec = out.status === "completed"
    ? (out.result.journal.entries().find((e) => e.kind === "checkpoint")?.result as { value?: unknown; by?: string })
    : undefined;
  const winnerAnswer = await readCheckpointAnswer(kv, EP, token, winner.answerId);
  c("and the program reads the WINNER's answer, matched by the id the settle named",
    rec?.value === winnerAnswer?.value && rec?.by === winnerAnswer?.by,
    `${JSON.stringify(rec)} vs ${JSON.stringify(winnerAnswer)}`);
}

// ── 3) nobody answers: the deadline settles it, and a late answer is told it was late ─────────
{
  const source = `
const a = await checkpoint("approve", "Ship it?", { timeout: "2s", onExpiry: "proceed" });
`;
  const driven = startRun(js, jsm, {
    space: SPACE, endpoint: EP, kv, runId: "cp-3", source, lease: lease("m1", 1, takeovers + 1), handler,
  });
  let token: string | undefined;
  for (let i = 0; i < 100 && token === undefined; i += 1) { token = await tokenOf("cp-3"); if (token === undefined) await wait(50); }
  await armPending(4);
  while (Date.now() < NOW + 2_400) await wait(100);
  const acted = await deliverFire({ endpoint: EP, token: token! }, NOW + 2_500);
  c("the deadline fires and expires the checkpoint", acted === 1, acted);

  const out = await driven;
  const rec = out.status === "completed"
    ? (out.result.journal.entries().find((e) => e.kind === "checkpoint")?.result as { outcome?: string })
    : undefined;
  c("the program sees an EXPIRY, not an empty answer", rec?.outcome === "expired", JSON.stringify(rec));

  // A late resolver meets TWO refusals, and both are worth pinning because they are reached by
  // different routes: once the run has recorded the expiry the journal itself says the step is over,
  // and if nobody drove the run at all the plane's own fail-closed expiry is what refuses.
  let late: unknown;
  try {
    await resolveCheckpoint(deps, { runId: "cp-3", stepKey: STEP, by: "david", value: "too late", now: NOW + 3_000 });
  } catch (e) { late = e; }
  c("a resolver arriving after the run recorded the expiry is refused at the journal, by name",
    late instanceof CheckpointNotOpen && late.why === "settled", (late as Error)?.message?.slice(0, 70));

  let closed: unknown;
  try {
    await resumeCheckpoint(kv, js, jsm, SPACE, { ref: { endpoint: EP, token: token! }, presenter: HOLDER, now: NOW + 3_000, answerId: "zzz" });
  } catch (e) { closed = e; }
  c("and the plane refuses the token itself: expiry fails the checkpoint CLOSED, answer or no answer",
    (closed as { code?: string })?.code === "failed-precondition", (closed as Error)?.message?.slice(0, 70));
}

// ── 4) addressing a step that is not an open checkpoint ───────────────────────────────────────
{
  const entries = [
    { v: 1, seq: 0, run: "r", scope: "", kind: "checkpoint", name: "approve", occurrence: 0, inputHash: "h", requestId: "tok", state: "settled", status: "ok", startedAt: 0 },
    { v: 1, seq: 1, run: "r", scope: "", kind: "sleep", name: "nap", occurrence: 0, inputHash: "h", requestId: "tok2", state: "pending", startedAt: 0 },
  ] as never;
  const why = (fn: () => unknown) => { try { fn(); return "no-throw"; } catch (e) { return (e as CheckpointNotOpen).why; } };
  c("an unknown step key refuses by name", why(() => openCheckpointToken(entries, "r", "/checkpoint:nope#0")) === "unknown");
  c("a settled step refuses as settled, never re-answered", why(() => openCheckpointToken(entries, "r", "/checkpoint:approve#0")) === "settled");
  c("a step that is not a checkpoint refuses as that", why(() => openCheckpointToken(entries, "r", "/sleep:nap#0")) === "not-a-checkpoint");
}

// ── 5) the answer id is derived, so a resolver's own retry files one answer and not two ───────
{
  const { driven, token } = await startPaused("cp-5");
  await armPending(4);
  const a = checkpointAnswerId({ token, by: "david", value: 42 });
  const b = checkpointAnswerId({ token, by: "david", value: 42 });
  c("the same answer derives the same id: a retry after a crash lands on its own record", a === b, `${a} ${b}`);
  c("a different answer derives a different id: two resolvers are never one slot",
    a !== checkpointAnswerId({ token, by: "david", value: 43 }));
  const r = await resolveCheckpoint(deps, { runId: "cp-5", stepKey: STEP, by: "david", value: 42, now: NOW + 1_000 });
  c("and the id the resolve filed is exactly that derivation", r.answerId === a, `${r.answerId} vs ${a}`);
  await driven;
}

// ── 6) a resume that named no answer is a loud refusal, never an invented value ───────────────
//
// The only way to reach this is to present the token WITHOUT going through resolveCheckpoint, which
// means the run's own command was bypassed. There is no honest value to return: something released
// the pause and what it answered is not recoverable.
{
  const { driven, token } = await startPaused("cp-6");
  // Take the rejection NOW: this run is going to fail, and the cells below do real awaits in
  // between — an unattached rejected promise would kill the process instead of failing a cell.
  const outcome = driven.then(() => undefined, (e: unknown) => e);
  await armPending(4);
  await resumeCheckpoint(kv, js, jsm, SPACE, { ref: { endpoint: EP, token }, presenter: HOLDER, now: NOW + 1_000 });
  const settled = await readCheckpointSettle(jsm, SPACE, { endpoint: EP, token });
  c("the bypassing resume settles with NO answerId", settled?.settle === "resumed" && settled?.answerId === undefined, JSON.stringify(settled));

  const raised = await outcome;
  // The interpreter turns a handler's throw into an L4000 handler-fault — the effect FAILED, which
  // is the honest record. What matters is that nothing returned a `resolved` checkpoint carrying a
  // value nobody gave.
  c("and the effect FAILS rather than returning a resolved checkpoint with an empty value",
    (raised as { kind?: string })?.kind === "handler-fault"
    && (raised as Error)?.message?.includes("settled as resumed"), (raised as Error)?.message?.slice(0, 70));
  c("naming the class the driver raises, so the failure is diagnosable rather than generic",
    new CheckpointAnswerMissing("t", undefined).name === "CheckpointAnswerMissing");
}

// ── 6b) the answer is written BEFORE the token is presented ──────────────────────────────────
//
// A resolver whose PRESENTATION is refused must still have filed its answer, because the record is
// the payload and the settle is the fact that releases the run: in this order a refusal (or a
// crash) between the two leaves an answer nobody accepted, which is harmless, and in the other
// order it leaves a run released with its answer nowhere.
//
// The journal here is BUILT rather than driven, and deliberately: the window this cell needs — a
// step still pending while its checkpoint is already settled — closes the moment a live driver
// notices, so a cell that raced for it would be flaky about the thing it is trying to prove.
// That `openCheckpointToken` is reached through a real replay is proven by every other cell here.
{
  const RUN = "cp-6b";
  const TOKEN = "cnRlc3RfcHJlc2VudGF0aW9uX29yZGVy";
  const appender = await activateRun(js, jsm, {
    space: SPACE, runId: RUN, holder: "m1", fencingToken: 1, epoch: 1,
    takeoverId: `t${(takeovers += 1)}`, at: NOW, expect: "new",
  });
  await appender.append({
    v: 1, seq: 0, run: RUN, scope: "", kind: "checkpoint", name: "approve", occurrence: 0,
    inputHash: "sha256:built", requestId: TOKEN, attempt: 0, state: "pending", startedAt: NOW,
  }, NOW);
  await mintCheckpoint(kv, js, SPACE, {
    ref: { endpoint: EP, token: TOKEN }, instanceId: IID, epoch: EPOCH, holder: HOLDER,
    deadline: NOW + 3_600_000, now: NOW,
  });
  await armPending(4);
  // Somebody else settles it first — an expiry would do just as well; what matters is that the
  // presentation this resolver is about to make cannot win.
  await resumeCheckpoint(kv, js, jsm, SPACE, { ref: { endpoint: EP, token: TOKEN }, presenter: HOLDER, now: NOW + 500 });

  const lateId = checkpointAnswerId({ token: TOKEN, by: "carol", value: "mine" });
  let refused: unknown;
  try {
    await resolveCheckpoint(deps, { runId: RUN, stepKey: STEP, by: "carol", value: "mine", now: NOW + 1_100 });
  } catch (e) { refused = e; }
  c("a resolver whose presentation is refused is told so, not told it succeeded",
    (refused as { code?: string })?.code === "conflict", (refused as Error)?.message?.slice(0, 60));
  c("and its answer is on disk anyway: the payload is written BEFORE the fact that releases the run",
    (await readCheckpointAnswer(kv, EP, TOKEN, lateId))?.by === "carol");
}

// ── 7) a run adopted at a new epoch re-arms its pauses, or its timers fire where nobody reads ──
{
  const { driven, token } = await startPaused("cp-7");
  await armPending(4);
  const entries = [
    { v: 1, seq: 0, run: "cp-7", scope: "", kind: "checkpoint", name: "approve", occurrence: 0, inputHash: "h", requestId: token, state: "pending", startedAt: 0 },
    { v: 1, seq: 1, run: "cp-7", scope: "", kind: "sleep", name: "over", occurrence: 0, inputHash: "h", requestId: "settled-tok", state: "settled", status: "ok", startedAt: 0 },
  ] as never;
  const open = outstandingPauseTokens(entries);
  c("the outstanding pauses are the PENDING ones: a settled step is not re-armed", open.length === 1 && open[0] === token, open.join(","));

  const NEXT = EPOCH + 1;
  const rearmed = await rearmOutstandingPauses({ kv, js, jsm }, { ...binding, epoch: NEXT }, entries);
  c("a takeover at a new epoch re-emits the pause's schedule", rearmed.length === 1 && rearmed[0] === token, rearmed.join(","));
  c("and the writer arms it onto the NEW epoch's own subjects", (await armPending(4)) === 1);
  const armedAtNext = await jsm.streams
    .getMessage(eptStreamName(SPACE), { last_by_subj: eptSubject(SPACE, EP, IID, NEXT, token, "armed") })
    .catch(() => null);
  c("so an armed schedule now exists at the successor's coordinates, where it will actually be read",
    armedAtNext !== null);

  await resolveCheckpoint(deps, { runId: "cp-7", stepKey: STEP, by: "david", value: "done", now: NOW + 1_000 });
  await driven;
}

// ── 8) a checkpoint with no timeout of its own gets the driver's PINNED one ───────────────────
//
// There is no such thing as a pause that waits forever on this plane: `mintCheckpoint` refuses a
// deadline that is not in the future, and an unbounded pause would be a run nothing can reconcile.
// So the default is a value the host states, not a constant hidden in the handler.
{
  const source = `
const a = await checkpoint("approve", "Ship it?", { onExpiry: "proceed" });
`;
  const driven = startRun(js, jsm, {
    space: SPACE, endpoint: EP, kv, runId: "cp-8", source, lease: lease("m1", 1, takeovers + 1), handler,
  });
  let token: string | undefined;
  for (let i = 0; i < 100 && token === undefined; i += 1) { token = await tokenOf("cp-8"); if (token === undefined) await wait(50); }
  await armPending(4);
  const st = await readCheckpointStatus(kv, { endpoint: EP, token: token! });
  c("an unnamed timeout takes the binding's pinned default, not a constant of the handler's own",
    st?.value.deadline === NOW + 3_600_000, `${st?.value.deadline} vs ${NOW + 3_600_000}`);
  await resolveCheckpoint(deps, { runId: "cp-8", stepKey: STEP, by: "david", value: "ok", now: NOW + 1_000 });
  await driven;
}

console.log(`mesh-checkpoint.smoke: ${ok} passed, ${fail} failed`);
done();
process.exit(fail === 0 ? 0 : 1);
