/**
 * `wait` on the real planes: an event await that survives the process waiting for it.
 *
 * The load-bearing cell is the third one. A run that is asleep on an event and whose host dies must
 * still see an event published while it was gone — which is only true if the consumer holding its
 * position on the channel is DURABLE and named from something the resumed run can re-derive. An
 * ephemeral consumer, or a durable created fresh on resume, silently starts from "now": the event
 * is not lost, it simply never happened as far as that run is concerned, and nothing anywhere goes
 * red. So this suite publishes into a wait that is not running.
 *
 * The other half is the deadline. A wait's timeout rides the checkpoint plane, so it is minted once
 * with an ABSOLUTE deadline: a wait that spans a crash resumes against the deadline it was given
 * rather than restarting the clock, because a timeout that restarts is a margin nobody chose.
 *
 * `idle` is the same plane again, extended rather than replaced — a checkpoint whose deadline is
 * pushed out by traffic, which is what `heartbeatCheckpoint` exists for. The cell that matters
 * there is a CARDINALITY one: exactly one armed schedule at the CURRENT generation. An existence
 * assertion passes while a superseded generation is quietly discarded, which is the shape that
 * produced the best finding in this package.
 *
 * Run: pnpm smoke:runtime-mesh-wait   (needs nats-server on PATH)
 */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect } from "@nats-io/transport-node";
import { jetstream, jetstreamManager } from "@nats-io/jetstream";
import { Kvm } from "@nats-io/kv";
import {
  isReachable,
  createEndpointStreams,
  createSpaceStreams,
  openRecordsBucket,
  timerWriterContext,
  timerWriterConsumerConfig,
  timerWriterDurable,
  armCheckpointTimer,
  readCheckpointStatus,
  chatStream,
  chatSubject,
  eptReqStreamName,
  eptStreamName,
  eptSubject,
  replayRunJournal,
  newTakeoverId,
  type CotalMessage,
} from "@cotal-ai/core";
import { Cancelled, journalEntryKeyString, type JournalEntry } from "@cotal-ai/lang";
import {
  MeshHandler,
  EpfSettleWatcher,
  startRun,
  driveRun,
  waitConsumerName,
  waitConsumerConfig,
} from "../src/index.js";
import { pickFreePort } from "./_free-port.js";

const SPACE = "meshwait";
const EP = "manager";
const IID = "i".repeat(26);
const EPOCH = 5;
const HOLDER = { id: "manager", lifecycleUid: "u_meshwait" };
const CALLER = { owner: "local", actor: "wf_meshsuite", uid: "a".repeat(26) };
const CHANNEL = "build";

let ok = 0, fail = 0;
const c = (n: string, v: boolean, extra?: unknown) => { if (v) { ok++; } else { fail++; console.log("  ✗ FAIL:", n, extra ?? ""); } };
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A cell whose claim is "this ENDS" must fail as a RED, not as a suite that stops: a bare `await`
 *  on a deadline nothing expires hangs the file, and `mutation-proof` grades a hang INCONCLUSIVE —
 *  "a hang is not a red" — so a guard asserted by a bare await grades nothing. */
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
const sd = mkdtempSync(join(tmpdir(), "cotal-meshwait-"));
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
await createSpaceStreams(jsm, SPACE);
const kv = await openRecordsBucket(nc, SPACE);

await jsm.consumers.add(eptReqStreamName(SPACE), timerWriterConsumerConfig(SPACE, { ackWaitMs: 5_000 }));
const writerC = await js.consumers.get(eptReqStreamName(SPACE), timerWriterDurable(SPACE));
const wctx = await timerWriterContext(nc, SPACE);
const armPending = async (expect = 8): Promise<number> => {
  let armed = 0;
  for await (const m of await writerC.fetch({ max_messages: expect, expires: 1_200 })) {
    const r = await armCheckpointTimer(wctx, { subject: m.subject, headers: m.headers, data: m.data });
    if (r.armed) armed += 1;
    m.ack();
  }
  return armed;
};
/** Whether the broker has published its own `.fire` for this token — an OBSERVATION of the timer
 *  plane, never a delivery. Calling `handleCheckpointFire` here on the handler's behalf would grade
 *  that the checkpoint plane expires a pause when somebody delivers its fire, which was never the
 *  question: the question is whether anything in the tree takes one. */
const brokerFired = async (token: string): Promise<boolean> => {
  const subject = eptSubject(SPACE, EP, IID, EPOCH, token, "fire");
  const fired = await jsm.streams.getMessage(eptStreamName(SPACE), { last_by_subj: subject }).catch(() => null);
  return fired !== null && fired !== undefined;
};

// A REAL clock, because the schedules are real: the broker arms an actual timer at the deadline the
// handler computes, and a fabricated clock would let real time cross a deadline the handler still
// thinks is in the future — which is exactly how an `idle` window that traffic is supposed to be
// pushing out fires anyway.
const now = () => Date.now();
/** Sit until this token's own schedule is genuinely past due, and answer whether the broker
 *  published its fire. Nothing is delivered: taking the fire is the handler's job. */
const pastDue = async (token: string): Promise<boolean> => {
  const st = await readCheckpointStatus(kv, { endpoint: EP, token });
  if (st === undefined) return false;
  while (Date.now() < st.value.deadline + 400) await wait(100);
  return await brokerFired(token);
};
const handler = new MeshHandler(
  nc, kv, js, jsm,
  { space: SPACE, endpoint: EP, runId: "r-wait", caller: CALLER, instanceId: IID, epoch: EPOCH, holder: HOLDER, defaultCheckpointTimeout: "1h" },
  new EpfSettleWatcher(js, jsm, SPACE, 3_000),
  now,
);

/** A step's identity plus a real `bind` and a real, cancellable signal — the full contract a
 *  handler is called under, so what it records AND what it does when its branch loses are both
 *  observable. `cancel` is the test's hand on the signal. */
const ctx = (requestId: string, resume?: Record<string, unknown>) => {
  const bound: Record<string, unknown>[] = [];
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
  const value = {
    requestId, attempt: 0, signal,
    ...(resume !== undefined ? { resume } : {}),
    bind: async (e: Record<string, unknown>) => { bound.push(e); },
  };
  return { ctx: value as never, bound, cancel };
};

const sayOn = async (channel: string, text: string, from = "ann") => {
  const msg: CotalMessage = {
    id: `m-${Date.now()}-${text.length}-${from}`, ts: now(), space: SPACE,
    from: { id: "x".repeat(26), name: from }, channel, parts: [{ kind: "text", text }],
  };
  await js.publish(chatSubject(SPACE, "o", "a", channel), new TextEncoder().encode(JSON.stringify(msg)));
};
const say = async (text: string, from = "ann") => await sayOn(CHANNEL, text, from);

const tok = (n: string) => `w${n}`.padEnd(20, "0");

// ── 1) an event await returns the message that answered it ────────────────────────────────────
{
  const { ctx: k, bound } = ctx(tok("basic"));
  const awaited = handler.wait({ event: { event: "message", channel: CHANNEL } }, k);
  await wait(300);
  await say("the build is green");
  const got = (await awaited) as CotalMessage;
  c("the wait returns the message that answered it", got?.parts?.[0]?.kind === "text", JSON.stringify(got)?.slice(0, 60));
  c("carrying its sender, so a program can tell who answered", got?.from?.name === "ann", got?.from?.name);
  c("and it BOUND the message's stream sequence before returning: the match is recoverable",
    typeof bound[0]?.chatSeq === "number", JSON.stringify(bound));
  c("the wait's consumer is gone once the wait is over",
    (await jsm.consumers.info(chatStream(SPACE), waitConsumerName(tok("basic"))).then(() => "still-there", () => "gone")) === "gone");
}

// ── 2) `from` and `matches` select; everything else is traffic ────────────────────────────────
{
  const { ctx: k } = ctx(tok("filter"));
  const awaited = handler.wait({ event: { event: "message", channel: CHANNEL, from: "bob", matches: "^.*ship it" } }, k);
  await wait(300);
  await say("ship it", "ann");        // right words, wrong sender
  await say("not yet", "bob");        // right sender, wrong words
  await wait(500);
  await say("ship it now please", "bob");
  const got = (await awaited) as CotalMessage;
  c("a message from the wrong sender does not answer the await", got?.from?.name === "bob", got?.from?.name);
  c("nor does the right sender saying something else",
    (got?.parts?.[0] as { text?: string })?.text === "ship it now please", JSON.stringify(got?.parts));
}

// ── 3) THE CLAIM: an event published while nobody was waiting still answers the resumed wait ──
//
// The consumer is created the way the handler creates it, then the wait is not running at all when
// the message lands. A run whose host died has exactly this shape. An ephemeral consumer, or one
// created on resume, would start from "now" and this message would never have happened.
{
  const id = tok("durable");
  // The consumer is created from the CONTRACT written out here, not from the function under test.
  // A fixture built with `waitConsumerConfig` moves with any mutation to the derivation, so the
  // cell would pass with the link broken.
  c("the wait durable's name is `wfw_<requestId>` — a derivation something else can reproduce",
    waitConsumerName(id) === `wfw_${id}`, waitConsumerName(id));
  c("and its filter is the channel, from any principal", 
    (waitConsumerConfig(SPACE, id, CHANNEL) as { filter_subject: string }).filter_subject === chatSubject(SPACE, "*", "*", CHANNEL));
  await jsm.consumers.add(chatStream(SPACE), {
    durable_name: `wfw_${id}`,
    filter_subject: chatSubject(SPACE, "*", "*", CHANNEL),
    ack_policy: "explicit" as never,
    deliver_policy: "new" as never,
  });
  await say("landed while the host was down");
  await wait(200);
  const { ctx: k } = ctx(id);
  // The timeout is here so a MISS ends as `null` instead of waiting forever: a cell that hangs when
  // its claim fails reddens no line, it just stops the suite.
  const awaited = handler.wait({ event: { event: "message", channel: CHANNEL }, timeout: "3s" }, k);
  await wait(300);
  await armPending();
  const got = (await Promise.race([awaited, pastDue(id).then(() => awaited)])) as CotalMessage;
  c("a message published while no waiter was running still answers the wait that comes back",
    (got?.parts?.[0] as { text?: string })?.text === "landed while the host was down", JSON.stringify(got?.parts));
}

// ── 4) but NOT one published before the program ever asked ────────────────────────────────────
//
// The other half of the same rule: a durable that started from the beginning of the channel would
// answer an await with history, and a program that asks to wait for an event is asking about the
// future. This wait must time out.
{
  await say("old news, from before the wait existed");
  await wait(200);
  const id = tok("fresh");
  const { ctx: k } = ctx(id);
  const awaited = handler.wait({ event: { event: "message", channel: CHANNEL }, timeout: "2s" }, k);
  await wait(400);
  await armPending();
  await pastDue(id);
  const got = await withDeadline(awaited, 25_000, "the wait with nothing to match");
  c("a message from before the wait began does not answer it: an await is about the future", got === null, JSON.stringify(got));
}

// ── 5) a timeout is a durable deadline, and resolves null rather than throwing ────────────────
{
  const id = tok("timeout");
  const { ctx: k } = ctx(id);
  const awaited = handler.wait({ event: { event: "message", channel: CHANNEL }, timeout: "2s" }, k);
  await wait(300);
  const st = await readCheckpointStatus(kv, { endpoint: EP, token: id });
  c("the wait's timeout is a MINTED deadline, not an in-memory timer", st?.value.state === "waiting", st?.value.state);
  c("keyed by the step's own request id, so a resume re-derives it rather than remembering it",
    st?.value.deadline !== undefined);
  c("and the timer writer had a schedule request to arm for it", (await armPending()) === 1);
  c("the broker publishes its own fire for it, and nobody hands that fire to the handler", await pastDue(id));
  // Progress mark, printed upstream of everything that touches the fire.
  console.log("• 5 — the wait's timeout is minted, armed, and past due");
  c("and the wait resolves NULL rather than throwing, so `??` is `otherwise`",
    (await withDeadline(awaited, 25_000, "the timed-out wait")) === null);
}

// ── 5b) a wait that is re-performed mid-pause attaches to the deadline it already has ─────────
//
// Block 6 covers the resume that has something recorded to answer from. This is the one that has
// NOT matched yet: the step is performed again under the id recorded before it first ran, and its
// timeout is a minted checkpoint like any other. A timeout recomputed as `now() + duration` is a
// different spec a second later, and the plane refuses a second intent under one token, so the
// resumed wait threw a conflict where it should have picked the pause back up. The clock here has
// always been the real one, so what this needed was the gap: a crash is time passing.
{
  console.log("• 5b — a pending wait, performed again after real time passed");
  const id = tok("reattach");
  const { ctx: k } = ctx(id);
  const first = handler.wait({ event: { event: "message", channel: CHANNEL }, timeout: "6s" }, k);
  first.catch(() => { /* the abandoned attempt */ });
  await wait(300);
  await armPending();
  const before = await readCheckpointStatus(kv, { endpoint: EP, token: id });
  await wait(1_200);
  const { ctx: k2 } = ctx(id);
  const second = handler.wait({ event: { event: "message", channel: CHANNEL }, timeout: "6s" }, k2);
  let refused: string | undefined;
  second.catch((e: unknown) => { refused = (e as Error).message; });
  await wait(400);
  c("the re-performed wait was not refused: it attaches to the timeout already minted for it",
    refused === undefined, refused);
  const after = await readCheckpointStatus(kv, { endpoint: EP, token: id });
  c("and the deadline is the one it was given, not one restarted by the second attempt",
    before?.value.deadline === after?.value.deadline, `${before?.value.deadline} vs ${after?.value.deadline}`);
  c("one pause, one generation: the second attempt joined it rather than opening another",
    before?.value.deadlineGeneration === after?.value.deadlineGeneration && after?.value.state === "waiting",
    `${before?.value.deadlineGeneration} -> ${after?.value.deadlineGeneration} ${after?.value.state}`);
  // BOTH ATTEMPTS ARE LEFT PENDING ON PURPOSE, and the ending is block 5's to grade. A crashed
  // attempt is gone: it deletes nothing on its way out. This one is still alive, so letting both
  // run to the deadline has them racing to tear down the durable consumer they share, and the
  // loser's in-flight fetch fails with `consumer deleted` — an artefact of a fixture that keeps the
  // corpse walking, not a fact about a resume. What this block can honestly grade is the ATTACH.
}

// ── 6) a resumed attempt returns the message it already matched, and awaits nothing new ───────
{
  const { ctx: k, bound } = ctx(tok("rebind"));
  const awaited = handler.wait({ event: { event: "message", channel: CHANNEL } }, k);
  await wait(300);
  await say("the answer");
  const first = (await awaited) as CotalMessage;
  const seq = bound[0]!.chatSeq as number;

  const { ctx: k2 } = ctx(tok("rebind"), { chatSeq: seq });
  const second = handler.wait({ event: { event: "message", channel: CHANNEL }, timeout: "3s" }, k2);
  await wait(200);
  await armPending();
  // Terminating either way again: with the re-bind in place nothing is even minted (`pastDue`
  // finds no status and returns at once), and without it the wait would otherwise sit here forever.
  const again = (await Promise.race([second, pastDue(tok("rebind")).then(() => second)])) as CotalMessage;
  c("a resumed attempt answers from the sequence it recorded, with no second event",
    again?.id === first?.id, `${again?.id} vs ${first?.id}`);
  c("and the re-bind mints no deadline at all: the wait it is completing already had one",
    (await readCheckpointStatus(kv, { endpoint: EP, token: tok("rebind") })) === undefined);
}

// ── 6b) an answered wait ends its own deadline rather than leaving a timer running ────────────
//
// The one-use settlement is also how a pause is CANCELLED: claiming it says "this is over" without
// a second mechanism. A timer left armed fires into a run that has moved on, and the fire handler
// then has to reason about a token nobody is waiting on.
{
  const id = tok("cancel");
  const { ctx: k } = ctx(id);
  const awaited = handler.wait({ event: { event: "message", channel: CHANNEL }, timeout: "1h" }, k);
  await wait(300);
  await armPending();
  await say("here you go");
  await awaited;
  const st = await readCheckpointStatus(kv, { endpoint: EP, token: id });
  c("the answered wait CLAIMS its own timeout rather than leaving the timer armed",
    st?.value.state === "resumed", st?.value.state);
}

// ── 7) `idle` is a deadline traffic pushes out — and exactly one schedule is armed for it ─────
//
// The cardinality assertion is the point. Every message CAS-advances the deadline generation and
// emits a replacement schedule; an existence assertion would pass while a superseded generation sat
// armed and its fire quietly no-opped, which is a repair path that has stopped repairing.
{
  const id = tok("idle");
  const { ctx: k } = ctx(id);
  const awaited = handler.wait({ event: { event: "idle", channel: CHANNEL, duration: "3s" } }, k);
  await wait(300);
  await armPending();
  const first = await readCheckpointStatus(kv, { endpoint: EP, token: id });
  const gen0 = first?.value.deadlineGeneration;

  // Traffic BEFORE the window closes, twice: each message must push the deadline out, and real time
  // must not overtake it — an idle window that fires while its channel is busy is the whole defect.
  await say("still working");
  await wait(1_200);
  await say("still working");
  await wait(1_200);
  await armPending();
  const live = await readCheckpointStatus(kv, { endpoint: EP, token: id });
  c("traffic pushes the idle deadline out: the generation advanced", (live?.value.deadlineGeneration ?? 0) > (gen0 ?? 0),
    `${gen0} -> ${live?.value.deadlineGeneration}`);

  const armedSubj = eptSubject(SPACE, EP, IID, EPOCH, id, "armed");
  const count = (await jsm.streams.info(eptStreamName(SPACE), { subjects_filter: armedSubj })).state.subjects?.[armedSubj];
  c("and EXACTLY ONE armed schedule exists for it, not one per heartbeat", count === 1, count);
  const armedBody = await jsm.streams.getMessage(eptStreamName(SPACE), { last_by_subj: armedSubj });
  const armedGen = JSON.parse(new TextDecoder().decode(armedBody!.data)) as { generation: number };
  c("armed at the CURRENT authoritative generation, not a superseded one",
    armedGen.generation === live?.value.deadlineGeneration, `${armedGen.generation} vs ${live?.value.deadlineGeneration}`);

  c("and the pushed deadline is genuinely later than the first one", (live?.value.deadline ?? 0) > (first?.value.deadline ?? 0),
    `${first?.value.deadline} -> ${live?.value.deadline}`);

  // Traffic stops. The window closes on its own, which is the event.
  c("the idle window closes on its own once the traffic stops", await pastDue(id));
  console.log("• 7 — the idle window was pushed out by traffic and is now past due");
  const got = (await withDeadline(awaited, 25_000, "the idle wait")) as { channel?: string };
  c("and when the traffic stops, the idle window closes and the wait resolves", got?.channel === CHANNEL, JSON.stringify(got));
}

// ── 7b) a wait that is over claims BOTH of its deadlines ──────────────────────────────────────
//
// An idle wait with a timeout arms two pauses: the idle window under the step's own id, and the
// outer timeout under a derived one. Each ENDING used to claim only the deadline it read, so the
// sibling stayed armed, fired into a run that had already moved on, and sat as an unclaimed settle
// until the run's own discharge swept it up (an hour later, for the `1h` here). The match path
// always claimed both; the two expiry paths did not.
{
  const id = tok("both");
  const outerTok = createHash("sha256").update(`${id}:wait-timeout`, "utf8").digest("base64url").slice(0, 43);
  const { ctx: k } = ctx(id);
  const awaited = handler.wait({ event: { event: "idle", channel: CHANNEL, duration: "2s" }, timeout: "1h" }, k);
  await wait(400);
  await armPending();
  const outerArmed = await readCheckpointStatus(kv, { endpoint: EP, token: outerTok });
  c("an idle wait with a timeout arms two deadlines: the window and the outer bound",
    outerArmed?.value.state === "waiting", JSON.stringify(outerArmed?.value.state));
  c("the idle window closes on its own with no traffic", await pastDue(id));
  const got = (await withDeadline(awaited, 25_000, "the two-deadline idle wait")) as { channel?: string };
  c("and the wait resolves on the window, not the hour-away bound", got?.channel === CHANNEL, JSON.stringify(got));
  const outerAfter = await readCheckpointStatus(kv, { endpoint: EP, token: outerTok });
  c("the outer deadline is CLAIMED by the ending, not left armed for an hour",
    outerAfter?.value.state !== "waiting", JSON.stringify(outerAfter?.value.state));
}

// ── 8) the agent-addressed event kinds: `replied` still refuses, `down` now performs ──────────
//
// `replied` and `down` both perform now (`mesh-replied` and `mesh-monitor` own them), so what
// this suite holds is the boundary: a value that is not an agent handle refuses loudly at the
// call, and a well-formed handle the run cannot observe refuses on the run roster — never a
// park either way.
{
  // BOUNDED. A refusal that stops refusing must be observable as "did not refuse", not as a suite
  // that stops: an implementation which accepts one of these would otherwise wait for an event that
  // is never coming, and a hang reddens no line.
  const refuse = async (event: unknown) => {
    const p = handler.wait({ event, timeout: "3s" } as never, ctx(tok("seam")).ctx).then(() => undefined, (e: unknown) => e);
    return await Promise.race([p, wait(6_000).then(() => new Error("DID NOT REFUSE"))]);
  };
  const replied = await refuse({ event: "replied", agent: "builder" });
  const down = await refuse({ event: "down", agent: "builder" });
  c("wait(replied(…)) on a value that is not an agent handle refuses loudly at the call",
    replied instanceof Error && replied.message.includes("not an agent handle"),
    (replied as Error)?.message?.slice(0, 90));
  const stranger = await refuse({ event: "replied", agent: `builder#${"u".repeat(26)}` });
  c("wait(replied(…)) on a handle this run never spawned or turned refuses on the roster, never parks",
    stranger instanceof Error && stranger.message.includes("roster"),
    (stranger as Error)?.message?.slice(0, 90));
  c("wait(down(…)): a value that is not an agent handle refuses loudly at the call",
    down instanceof Error && down.message.includes("not an agent handle"),
    (down as Error)?.message?.slice(0, 90));
}

// ── 9) inputs that could not be awaited safely are refused at the call ────────────────────────
{
  const refuse = async (event: unknown) => {
    const p = handler.wait({ event, timeout: "3s" } as never, ctx(tok("bad")).ctx).then(() => undefined, (e: unknown) => e as Error);
    return await Promise.race([p, wait(6_000).then(() => new Error("DID NOT REFUSE"))]);
  };
  const wild = await refuse({ event: "message", channel: "team.>" });
  c("a wildcard channel is refused: an await names one channel", wild?.message.includes("wildcard") === true, wild?.message?.slice(0, 60));
  const evil = await refuse({ event: "message", channel: CHANNEL, matches: "^(a+)+$" });
  c("and a `matches` pattern outside the bounded-regex subset is refused before it is ever run",
    evil?.message.includes("bounded regular expression") === true, evil?.message?.slice(0, 70));
}

// ── 10) A BIND THAT IS REFUSED DOES NOT THROW THE MATCH AWAY ──────────────────────────────────
//
// The residual a review seat named and could not force, and it took a harness that already existed:
// this suite has a chat stream to publish onto, which the seat's brief did not let it see.
//
// The handler says "BIND BEFORE ACK ... a crash in between redelivers it". That is true of a crash,
// which never runs the cleanup at all. It was NOT true of a `ctx.bind` that FAILS — and a bind is a
// journal append, which a journal refuses in ordinary operation (L5010, RunSuperseded). The cleanup
// ran on every exit, so the durable consumer holding this run's position on the channel was deleted
// on the way out; the retry carries no recorded sequence, because recording it is exactly what
// failed, so it created a fresh consumer at `deliver_policy: "new"` and found NOTHING. Measured
// before the repair: matched at a real sequence, bound, refused, consumer gone, message permanently
// invisible to that run with nothing anywhere red.
//
// WHAT IS ASSERTED HERE IS THE PART THIS CODE OWNS: the position survives, with the message still
// unacked. The redelivery that then consumes it is NATS's `ack_wait` (server default, 30s) and was
// measured end-to-end twice — the retry found the message again and re-bound a sequence — but is not
// re-run here, because a 45-second sleep in the gate buys a fact about the broker, not about us.
{
  const id = tok("bindfail");
  const attempted: unknown[] = [];
  const refusing = {
    requestId: id, attempt: 0,
    signal: { cancelled: false, onCancel() { /* never fires here */ } },
    bind: async (e: unknown) => { attempted.push(e); throw new Error("L5010 journal append rejected"); },
  } as never;

  const aborted = handler.wait({ event: { event: "message", channel: CHANNEL } }, refusing);
  await wait(300);
  await say("the message whose bind gets refused");
  const outcome = await aborted.then(() => null, (e: Error) => e);
  c("a refused bind comes back as the refusal, not as a match", outcome?.message.includes("L5010") === true,
    outcome?.message?.slice(0, 60));
  // The bind was REACHED, or the cell below is about a wait that never matched anything.
  c("and the wait had genuinely matched: it reached the bind with a sequence",
    typeof (attempted[0] as { chatSeq?: number })?.chatSeq === "number", JSON.stringify(attempted));

  const after = await jsm.consumers.info(chatStream(SPACE), waitConsumerName(id)).then(
    (i) => ({ exists: true, ackPending: i.num_ack_pending }),
    () => ({ exists: false, ackPending: -1 }));
  c("REPAIRED: the wait's position SURVIVES a refused bind — a throw is not the wait being over",
    after.exists, after);
  // BOTH HALVES. A consumer that survives but has already acked the message holds a position past
  // the very message the run needs, which is the same loss wearing a healthier shape.
  c("...with the matched message still unacked, which is what makes it recoverable at all",
    after.ackPending >= 1, after);
}

// ── 10b) but a wait that is genuinely OVER still cleans up after itself ────────────────────────
//
// The narrowness, and it is load-bearing: keeping the consumer on every exit would leak one per
// wait, and the reason the handler deletes rather than leaning on an inactivity threshold is that a
// threshold could reap a LIVE wait's consumer while its host was down — losing exactly the events
// the durable exists to hold. Cell 1 pins the matched ending; this pins the TIMED-OUT one, which is
// the exit the `over` flag is most easily got wrong on.
{
  const id = tok("expcleanup");
  const { ctx: k } = ctx(id);
  const awaited = handler.wait({ event: { event: "message", channel: CHANNEL }, timeout: "2s" }, k);
  await wait(400);
  await armPending();
  await pastDue(id);
  const got = await withDeadline(awaited, 25_000, "the expiring wait");
  c("a wait that reaches its deadline ends as null", got === null, JSON.stringify(got));
  c("and its consumer is gone: an ENDED wait's position is worthless and is not left behind",
    (await jsm.consumers.info(chatStream(SPACE), waitConsumerName(id)).then(() => "still-there", () => "gone")) === "gone");
}

// ── 11) A WAIT WHOSE BRANCH LOST ends within one poll, cleaned up, as `Cancelled` ─────────────
// The handler half of #532, at the seam. Before it, this wait ignored its signal: the poll loop
// ran to the timeout however the race went, the consumer stayed, and the timers stayed armed.
// The cancellation must end it on the poll cadence, reject with the class the boundary settles
// `cancelled` for, claim its timeout pause, and delete its consumer — a cancelled wait replays as
// cancelled, so its position answers nothing ever again.
{
  const id = tok("cancelled");
  const { ctx: k, cancel } = ctx(id);
  const awaited = handler
    .wait({ event: { event: "message", channel: CHANNEL }, timeout: "10m" }, k)
    .then(() => null, (e: Error) => e);
  await wait(600);
  await armPending();
  cancel("a sibling branch won the race");
  const out = await withDeadline(awaited, 10_000, "the cancelled wait");
  c("a cancelled wait rejects `Cancelled` within one poll rather than waiting out its timeout",
    out instanceof Error && out.name === "Cancelled", String(out));
  c("its consumer is deleted: a cancelled wait's position answers nothing ever again",
    (await jsm.consumers.info(chatStream(SPACE), waitConsumerName(id)).then(() => "still-there", () => "gone")) === "gone");
  const st = await readCheckpointStatus(kv, { endpoint: EP, token: id });
  c("and its timeout pause is claimed rather than left armed for a branch that is over",
    st !== undefined && st.value.state !== "waiting", JSON.stringify(st?.value.state));
}

// The driver-level blocks below run real programs; the harness is mesh-checkpoint's.
let takeovers = 0;
const lease = () => ({ holder: "m1", epoch: 1, fencingToken: takeovers + 1, takeoverId: `t${(takeovers += 1)}` });
const journalOf = async (runId: string): Promise<JournalEntry[]> => {
  const replay = await replayRunJournal(js, jsm, SPACE, runId, newTakeoverId());
  return replay.records
    .filter((r) => r.record.kind === "step")
    .map((r) => (r.record as unknown as { entry: JournalEntry }).entry);
};
/** Fold the append log by key, later record wins — the settled row, and after a discharge the
 *  re-appended one carrying `issued: true`. */
const folded = (entries: readonly JournalEntry[]): Map<string, JournalEntry> => {
  const m = new Map<string, JournalEntry>();
  for (const e of entries) m.set(journalEntryKeyString(e), e);
  return m;
};

// ── 12) A RACE'S LOSING WAIT: the run completes promptly, and the cancellation is DISCHARGED ──
// The shipped defect end to end (#532), reproduced through the real binary before this block
// existed: a decided race hung its run forever on a loser that never observed its signal, the
// loser's consumer stayed live on the broker, and the scope's `cancel.issued` stayed false on
// every completed run in the tree. This drives the same program shape through the run driver and
// grades the whole repair: prompt completion, the loser settled `cancelled` (the engine bridge
// carries the class across the port), its consumer gone, its pause claimed, and the recorded
// cancellation flipped `issued: true` by the driver's sweep.
{
  const source = `
const r = await race({
  quick: async () => await wait(message(channel("${CHANNEL}"))),
  slow: async () => await wait(message(channel("wf-lost")), { timeout: "10m" }),
}, { name: "decided" });
log("winner", r.index);
`;
  const driven = startRun(js, jsm, {
    space: SPACE, endpoint: EP, kv, runId: "race-1", source, lease: lease(), handler,
  });
  let parked: JournalEntry[] = [];
  for (let i = 0; i < 100; i += 1) {
    parked = (await journalOf("race-1")).filter(
      (e) => e.kind === "wait" && e.state === "pending" && e.requestId !== undefined);
    if (parked.length >= 2) break;
    await wait(100);
  }
  c("both arms parked durably before the decision", parked.length >= 2, parked.length);
  await armPending();
  await say("the winner");
  const outcome = await withDeadline(driven, 25_000, "the decided race");
  c("a race whose loser is a parked wait completes promptly once decided — it does not wait out the loser",
    (outcome as { status?: string } | undefined)?.status === "completed", JSON.stringify(outcome));
  const after = folded(await journalOf("race-1"));
  const slow = after.get("/race:decided#0/b:slow/wait#0");
  c("the losing wait settled `cancelled` — the class crossed the engine bridge instead of flattening to a fault",
    slow?.state === "settled" && slow.status === "cancelled",
    JSON.stringify({ state: slow?.state, status: slow?.status, error: slow?.error }));
  const scope = after.get("/race:decided#0");
  c("the recorded cancellation is DISCHARGED: `issued` reads true off the journal once the world is quiet",
    scope?.cancel?.issued === true, JSON.stringify(scope?.cancel));
  c("the loser's consumer is gone",
    slow?.requestId !== undefined &&
      (await jsm.consumers.info(chatStream(SPACE), waitConsumerName(slow.requestId)).then(() => "still-there", () => "gone")) === "gone");
  const st = slow?.requestId === undefined ? undefined : await readCheckpointStatus(kv, { endpoint: EP, token: slow.requestId });
  c("and the loser's timeout pause is not left waiting for a fire",
    st !== undefined && st.value.state !== "waiting", JSON.stringify(st?.value.state));
}

// ── 13) THE DISCHARGE IS A DURABLE BACKSTOP: a loser whose process died before its own cleanup ──
// Block 12's loser cleans up inside `wait` itself, so it cannot grade the sweep's world half.
// This one drives the same race with a loser whose handler dies DIRTY: the consumer is created for
// real under the loser's request id, and the cancellation is raised with no cleanup — exactly what
// a crash between the throw and the cleanup leaves behind. The completion sweep is then the only
// thing standing between the journal's `issued: false` and a consumer nobody will ever read: it
// must end the world state through the handler's `discharge` and flip the record.
{
  let dirtyId: string | undefined;
  const dirty = {
    now: () => handler.now(),
    discharge: (entries: readonly JournalEntry[]) => handler.discharge(entries),
    sleep: (r: never, kc: never) => handler.sleep(r, kc),
    checkpoint: (r: never, kc: never) => handler.checkpoint(r, kc),
    notify: (r: never, kc: never) => handler.notify(r, kc),
    wait: async (
      req: { event?: { channel?: string } },
      kc: { requestId: string; signal: { cancelled: boolean; reason?: string; onCancel(fn: (reason: string) => void): void } },
    ): Promise<unknown> => {
      if (req.event?.channel !== "wf-lost2") return await handler.wait(req as never, kc as never);
      dirtyId = kc.requestId;
      await jsm.consumers.add(chatStream(SPACE), waitConsumerConfig(SPACE, kc.requestId, "wf-lost2") as never);
      return await new Promise((_, reject) => {
        const die = (reason: string): void => reject(new Cancelled(reason));
        if (kc.signal.cancelled) die(kc.signal.reason ?? "cancelled");
        else kc.signal.onCancel(die);
      });
    },
  };
  const source = `
const r = await race({
  quick: async () => await wait(message(channel("${CHANNEL}"))),
  slow: async () => await wait(message(channel("wf-lost2"))),
}, { name: "decided" });
log("winner", r.index);
`;
  const driven = startRun(js, jsm, {
    space: SPACE, endpoint: EP, kv, runId: "race-2", source, lease: lease(), handler: dirty as never,
  });
  for (let i = 0; i < 100 && dirtyId === undefined; i += 1) await wait(100);
  c("the dirty loser parked with a real consumer under its request id", dirtyId !== undefined);
  await say("the winner again");
  const outcome = await withDeadline(driven, 25_000, "the race over a dirty loser");
  c("the run completes", (outcome as { status?: string } | undefined)?.status === "completed", JSON.stringify(outcome));
  c("the consumer the dead loser left behind is deleted by the discharge, not by anyone's live cleanup",
    dirtyId !== undefined &&
      (await jsm.consumers.info(chatStream(SPACE), waitConsumerName(dirtyId)).then(() => "still-there", () => "gone")) === "gone");
  const scope = folded(await journalOf("race-2")).get("/race:decided#0");
  c("and the record agrees: `issued` flipped true only after the world was swept",
    scope?.cancel?.issued === true, JSON.stringify(scope?.cancel));
}

// ── 14) THE DISCHARGE ALSO RUNS AT ADOPTION: recovery does not wait for the run to end ─────────
// Block 13 grades the completion sweep. But a resumed run can hold its lease for hours, and a
// crash that left `issued: false` would leave the dead loser's world state live that whole time.
// So the driver sweeps the replayed prefix at ADOPTION too, before the engine performs any new
// step — graded here by a takeover of a run that is still PARKED: the flip and the world sweep
// must land while the run is demonstrably not finished.
{
  let dirtyId: string | undefined;
  let holdId: string | undefined;
  const dirty = {
    now: () => handler.now(),
    discharge: (entries: readonly JournalEntry[]) => handler.discharge(entries),
    sleep: (r: never, kc: never) => handler.sleep(r, kc),
    checkpoint: (r: never, kc: never) => handler.checkpoint(r, kc),
    notify: (r: never, kc: never) => handler.notify(r, kc),
    wait: async (
      req: { event?: { channel?: string } },
      kc: { requestId: string; signal: { cancelled: boolean; reason?: string; onCancel(fn: (reason: string) => void): void } },
    ): Promise<unknown> => {
      // The hold is parked BLIND in this incarnation: the successor is who performs it for
      // real, so the two drivers never contend for one consumer's message.
      if (req.event?.channel === "wf-hold") { holdId = kc.requestId; return await new Promise(() => { /* superseded, never settles */ }); }
      if (req.event?.channel !== "wf-lost3") return await handler.wait(req as never, kc as never);
      dirtyId = kc.requestId;
      await jsm.consumers.add(chatStream(SPACE), waitConsumerConfig(SPACE, kc.requestId, "wf-lost3") as never);
      return await new Promise((_, reject) => {
        const die = (reason: string): void => reject(new Cancelled(reason));
        if (kc.signal.cancelled) die(kc.signal.reason ?? "cancelled");
        else kc.signal.onCancel(die);
      });
    },
  };
  const source = `
const r = await race({
  quick: async () => await wait(message(channel("${CHANNEL}"))),
  slow: async () => await wait(message(channel("wf-lost3"))),
}, { name: "decided" });
await wait(message(channel("wf-hold")), { name: "hold" });
log("released", r.index);
`;
  const first = startRun(js, jsm, {
    space: SPACE, endpoint: EP, kv, runId: "race-3", source, lease: lease(), handler: dirty as never,
  }).catch((e: unknown) => ({ status: "threw" as const, error: String((e as Error)?.message).slice(0, 120) }));
  for (let i = 0; i < 100 && dirtyId === undefined; i += 1) await wait(100);
  await say("the winner a third time");
  // The first driver crosses the decided race and parks on the hold — with the cancel recorded
  // and NOT yet issued, because the completion sweep is still nowhere in sight.
  let held = false;
  for (let i = 0; i < 100 && !held; i += 1) {
    held = (await journalOf("race-3")).some((e) => e.kind === "wait" && e.name === "hold" && e.state === "pending");
    if (!held) await wait(100);
  }
  const before = folded(await journalOf("race-3")).get("/race:decided#0");
  c("the parked run's recorded cancellation is still un-issued and the dead loser's consumer is live",
    held && before?.cancel?.issued === false && dirtyId !== undefined &&
      (await jsm.consumers.info(chatStream(SPACE), waitConsumerName(dirtyId)).then(() => "still-there", () => "gone")) === "still-there",
    JSON.stringify({ held, cancel: before?.cancel }));
  // The takeover: a successor lease adopts the run. The sweep must land at ADOPTION, while the
  // run is still parked on the hold — not at a completion that has not happened.
  const second = driveRun(js, jsm, {
    space: SPACE, endpoint: EP, kv, runId: "race-3", source, lease: lease(), handler,
  }).catch((e: unknown) => ({ status: "threw" as const, error: String((e as Error)?.message).slice(0, 120) }));
  let sweptAt = "never";
  for (let i = 0; i < 150; i += 1) {
    const scope = folded(await journalOf("race-3")).get("/race:decided#0");
    const consumer = dirtyId === undefined ? "?" :
      await jsm.consumers.info(chatStream(SPACE), waitConsumerName(dirtyId)).then(() => "still-there", () => "gone");
    if (scope?.cancel?.issued === true && consumer === "gone") {
      const stillParked = (await journalOf("race-3")).some(
        (e) => e.kind === "wait" && e.name === "hold" && e.state === "pending")
        && !(await journalOf("race-3")).some((e) => e.kind === "wait" && e.name === "hold" && e.state === "settled");
      sweptAt = stillParked ? "adoption" : "completion";
      break;
    }
    await wait(200);
  }
  c("the adoption sweep ends the dead loser's world state and flips the record WHILE the run is still parked",
    sweptAt === "adoption", sweptAt);
  // Release only once the SUCCESSOR is demonstrably reading the hold: its re-performed wait is
  // what creates the durable consumer (the first driver parked blind), so its existence is the
  // signal, and no message can be eaten by a superseded reader.
  for (let i = 0; i < 150; i += 1) {
    if (holdId !== undefined &&
      (await jsm.consumers.info(chatStream(SPACE), waitConsumerName(holdId)).then(() => true, () => false))) break;
    await wait(200);
  }
  await sayOn("wf-hold", "release the hold");
  const outcome = await withDeadline(second, 30_000, "the adopted run");
  c("the adopted run then completes on its own schedule",
    (outcome as { status?: string } | undefined)?.status === "completed", JSON.stringify(outcome));
  // The engine the successor seeds must see the flip its own adoption sweep just wrote: a seed
  // that lagged the store would make the completion sweep find the cancel un-issued again and
  // write a second flip record for the same scope.
  const flips = (await journalOf("race-3")).filter((e) => journalEntryKeyString(e) === "/race:decided#0" && e.cancel?.issued === true).length;
  c("the flip is written once: adoption's sweep is what the completion sweep then sees", flips === 1, { flips });
  void first; // superseded mid-park — released or parked forever; its ending is not this block's claim
}

// ---- 12) a broker error is not "the timer has not fired" ----------------------------------------
//
// `takeFire` swallowed EVERY error from the fire read as "no fire yet". A broker refusing or
// unreachable then read exactly like a deadline that has not passed, so a `wait` with a timeout
// polled past its own durable deadline in silence: the one failure the poll exists to prevent.
// Only 10037 ("no message on that subject") is that answer; everything else is the broker.
{
  console.log("• 12 — a fire read that fails is a failure, not a quiet 'not yet'");
  // ONLY the fire stream, and only the read: the settle fact lives in a different stream, so a
  // blanket fault would prove the poll notices SOMETHING rather than notices THIS.
  const brokenJsm = new Proxy(jsm, {
    get(target, prop, recv) {
      if (prop !== "streams") return Reflect.get(target, prop, recv);
      const streams = Reflect.get(target, prop, recv) as typeof jsm.streams;
      return new Proxy(streams, {
        get(st, p, r) {
          if (p !== "getMessage") return Reflect.get(st, p, r);
          return async (stream: string, opts: Parameters<typeof jsm.streams.getMessage>[1]) => {
            const bySubj = (opts as { last_by_subj?: unknown })?.last_by_subj;
            if (typeof bySubj === "string" && bySubj.endsWith(".fire"))
              throw Object.assign(new Error("nats: connection closed"), { code: 503 });
            return await (Reflect.get(st, p, r) as typeof jsm.streams.getMessage).call(st, stream, opts);
          };
        },
      });
    },
  }) as typeof jsm;
  const brokenHandler = new MeshHandler(
    nc, kv, js, brokenJsm,
    { space: SPACE, endpoint: EP, runId: "r-firefail", caller: CALLER, instanceId: IID, epoch: EPOCH, holder: HOLDER, defaultCheckpointTimeout: "1h" },
    new EpfSettleWatcher(js, jsm, SPACE, 3_000),
    now,
  );
  const k = ctx(tok("firefail"));
  const outcome = await withDeadline(
    brokenHandler.wait({ event: { event: "message", channel: "wf-nobody" }, timeout: "2s" }, k.ctx)
      .then(() => "returned quietly", (e: unknown) => `threw: ${(e as Error).message}`),
    25_000, "the wait whose fire read fails");
  c("the broker's refusal reaches the caller instead of reading as an unfired timer",
    String(outcome).startsWith("threw:") && String(outcome).includes("connection closed"),
    outcome);
}

const EXPECTED_CELLS = 60;
const ran = ok + fail;
console.log(`mesh-wait.smoke: ${ok} passed, ${fail} failed`);
if (ran !== EXPECTED_CELLS) {
  console.log(`SUITE INCOMPLETE — ran ${ran} of ${EXPECTED_CELLS} cells; a partial run is not a pass`);
  done();
  process.exit(1);
}
done();
process.exit(fail === 0 ? 0 : 1);
