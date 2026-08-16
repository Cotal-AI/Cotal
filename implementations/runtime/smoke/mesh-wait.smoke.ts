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
 * produced this lane's best finding.
 *
 * Run: pnpm smoke:runtime-mesh-wait   (needs nats-server on PATH)
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
  createSpaceStreams,
  openRecordsBucket,
  timerWriterContext,
  timerWriterConsumerConfig,
  timerWriterDurable,
  armCheckpointTimer,
  handleCheckpointFire,
  readCheckpointStatus,
  chatStream,
  chatSubject,
  eptReqStreamName,
  eptStreamName,
  eptSubject,
  type CheckpointRef,
  type CotalMessage,
} from "@cotal-ai/core";
import {
  MeshHandler,
  EpfSettleWatcher,
  NotYetDurable,
  waitConsumerName,
  waitConsumerConfig,
} from "../src/index.js";
import { pickFreePort } from "./_free-port.js";

const SPACE = "meshwait";
const EP = "manager";
const IID = "i".repeat(26);
const EPOCH = 5;
const HOLDER = { id: "manager", lifecycleUid: "u_meshwait" };
const CHANNEL = "build";

let ok = 0, fail = 0;
const c = (n: string, v: boolean, extra?: unknown) => { if (v) { ok++; } else { fail++; console.log("  ✗ FAIL:", n, extra ?? ""); } };
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

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

// A REAL clock, because the schedules are real: the broker arms an actual timer at the deadline the
// handler computes, and a fabricated clock would let real time cross a deadline the handler still
// thinks is in the future — which is exactly how an `idle` window that traffic is supposed to be
// pushing out fires anyway.
const now = () => Date.now();
/** Fire a token's timer once the broker's own schedule is genuinely past due. */
const fireWhenDue = async (token: string): Promise<number> => {
  const st = await readCheckpointStatus(kv, { endpoint: EP, token });
  if (st === undefined) return -2;
  while (Date.now() < st.value.deadline + 400) await wait(100);
  return await deliverFire({ endpoint: EP, token }, Date.now());
};
const handler = new MeshHandler(
  kv, js, jsm,
  { space: SPACE, endpoint: EP, instanceId: IID, epoch: EPOCH, holder: HOLDER, defaultCheckpointTimeout: "1h" },
  new EpfSettleWatcher(js, jsm, SPACE, 3_000),
  now,
);

/** A step's identity plus a real `bind`, so what the handler records is observable. */
const ctx = (requestId: string, resume?: Record<string, unknown>) => {
  const bound: Record<string, unknown>[] = [];
  const value = {
    requestId, attempt: 0,
    ...(resume !== undefined ? { resume } : {}),
    bind: async (e: Record<string, unknown>) => { bound.push(e); },
  };
  return { ctx: value as never, bound };
};

const say = async (text: string, from = "ann") => {
  const msg: CotalMessage = {
    id: `m-${Date.now()}-${text.length}-${from}`, ts: now(), space: SPACE,
    from: { id: "x".repeat(26), name: from }, channel: CHANNEL, parts: [{ kind: "text", text }],
  };
  await js.publish(chatSubject(SPACE, "o", "a", CHANNEL), new TextEncoder().encode(JSON.stringify(msg)));
};

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
  // Building the fixture with `waitConsumerConfig` was the first version and it graded nothing: a
  // mutation to the derivation moved the fixture with it, and the cell passed with the link broken.
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
  // its claim fails reddens no line, it just stops the suite (this lane's R15-B rule).
  const awaited = handler.wait({ event: { event: "message", channel: CHANNEL }, timeout: "3s" }, k);
  await wait(300);
  await armPending();
  const got = (await Promise.race([awaited, fireWhenDue(id).then(() => awaited)])) as CotalMessage;
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
  await fireWhenDue(id);
  const got = await awaited;
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
  c("the fire expires it", (await fireWhenDue(id)) === 1);
  c("and the wait resolves NULL rather than throwing, so `??` is `otherwise`", (await awaited) === null);
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
  // Terminating either way again: with the re-bind in place nothing is even minted (fireWhenDue
  // answers -2 and does nothing), and without it the wait would otherwise sit here forever.
  const again = (await Promise.race([second, fireWhenDue(tok("rebind")).then(() => second)])) as CotalMessage;
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
  c("the idle window closes on its own once the traffic stops", (await fireWhenDue(id)) === 1);
  const got = (await awaited) as { channel?: string };
  c("and when the traffic stops, the idle window closes and the wait resolves", got?.channel === CHANNEL, JSON.stringify(got));
}

// ── 8) the two event kinds whose subject is an agent refuse, by name ──────────────────────────
//
// Gated by their INPUT rather than their mechanism: an agent handle comes from `spawn`, and `down`
// additionally needs `monitor` to have registered interest. Both ride the same seam as the durable
// actions themselves — one place to look when Lane A lands, not two.
{
  const refuse = async (event: unknown) => {
    try { await handler.wait({ event } as never, ctx(tok("seam")).ctx); return undefined; }
    catch (e) { return e; }
  };
  const replied = await refuse({ event: "replied", agent: "builder" });
  const down = await refuse({ event: "down", agent: "builder" });
  c("wait(replied(…)) refuses as NOT YET DURABLE rather than pretending", replied instanceof NotYetDurable, (replied as Error)?.name);
  c("wait(down(…)) refuses the same way, through the same seam", down instanceof NotYetDurable, (down as Error)?.name);
  c("and the refusal says what it is waiting on, so it is a seam and not a mystery",
    (replied as Error)?.message.includes("durable-action machinery"), (replied as Error)?.message?.slice(0, 60));
}

// ── 9) inputs that could not be awaited safely are refused at the call ────────────────────────
{
  const refuse = async (event: unknown) => {
    try { await handler.wait({ event } as never, ctx(tok("bad")).ctx); return undefined; }
    catch (e) { return e as Error; }
  };
  const wild = await refuse({ event: "message", channel: "team.>" });
  c("a wildcard channel is refused: an await names one channel", wild?.message.includes("wildcard"), wild?.message?.slice(0, 60));
  const evil = await refuse({ event: "message", channel: CHANNEL, matches: "^(a+)+$" });
  c("and a `matches` pattern outside the bounded-regex subset is refused before it is ever run",
    evil?.message.includes("bounded regular expression") === true, evil?.message?.slice(0, 70));
}

console.log(`mesh-wait.smoke: ${ok} passed, ${fail} failed`);
done();
process.exit(fail === 0 ? 0 : 1);
