/**
 * The activation barrier, against a real broker.
 *
 * The claim under test is not "JetStream has optimistic concurrency" — it does — but that the
 * handoff between two drivers of one run is decided by the SERVER in every ordering, including the
 * orderings that are inconvenient. So every cell here is a live race with real publishes, and the
 * two that matter most are the two directions of the same handoff:
 *
 *   - the successor's ACTIVATION lands first, and the predecessor's still-in-flight append is
 *     refused by the stream rather than by anyone's goodwill;
 *   - the predecessor's append lands first, and the successor's ACTIVATION is refused — which is
 *     NOT a supersession, because a driver that has not activated has driven nothing. It re-reads
 *     and activates again.
 *
 * A barrier proved only in the favourable ordering is a barrier proved in the case that never fails.
 *
 * Run: pnpm smoke:run-journal   (needs nats-server on PATH; part of smoke:ci)
 */
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect, headers as natsHeaders } from "@nats-io/transport-node";
import { jetstream, jetstreamManager } from "@nats-io/jetstream";
import { Kvm } from "@nats-io/kv";
import {
  isReachable,
  createEndpointStreams,
  wfjStreamName,
  wfjSubject,
  activateRun,
  replayRunJournal,
  RunSuperseded,
  RunJournalStalled,
  RunJournalReplayRaced,
  RunJournalPrefixTruncated,
  StaleLeaseToken,
  RunNotResumable,
  RunAlreadyStarted,
  ActivationNotAuthorized,
  assertReplayConsumerFresh,
  isConsumerNotFound,
  runJournalConsumerConfig,
  ActivationRaced,
  parseRunJournalRecord,
  type RunJournalActivation,
  type RunJournalRecord,
} from "../src/index.js";
import { pickFreePort } from "./_free-port.js";

const SPACE = "wfjrun";
const PORT = await pickFreePort();
const sd = mkdtempSync(join(tmpdir(), "cotal-wfj-"));
const broker = spawn("nats-server", ["-js", "-sd", sd, "-p", String(PORT), "-a", "127.0.0.1"], { stdio: "ignore" });
const servers = `nats://127.0.0.1:${PORT}`;

let ok = 0, fail = 0;
const c = (n: string, v: boolean, extra?: unknown) => { if (v) { ok++; } else { fail++; console.log("  ✗ FAIL:", n, extra ?? ""); } };

/** The broker is a child process, so it holds the event loop open: the suite has to end itself, and
 *  an EXIT trap is what makes a THROWN failure clean up too rather than leaking a server. */
const done = () => {
  try { broker.kill("SIGKILL"); } catch { /* already gone */ }
  rmSync(sd, { recursive: true, force: true });
};
process.on("exit", done);

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
let up = false;
for (let i = 0; i < 60 && !up; i += 1) { up = await isReachable(servers); if (!up) await wait(100); }
if (!up) throw new Error(`nats-server did not come up on ${PORT}`);
const nc = await connect({ servers });
const jsm = await jetstreamManager(nc);
const js = jetstream(nc);
await createEndpointStreams(jsm, new Kvm(nc), SPACE);
const STREAM = wfjStreamName(SPACE);

/** A takeover that STARTS a run, and one that RESUMES it: an activation states which, because an
 *  empty journal cannot tell a run that never began from one whose records were purged away. */
let takeovers = 0;
/** Every takeover names its own replay consumer, and the name is what its credential is minted for.
 *  The suite mints a fresh one per call for the same reason production does: two attempts sharing a
 *  consumer is the race this design removes. */
const tid = () => `t${(takeovers += 1)}`;
const startRun = (runId: string, holder: string, epoch: number) => ({
  space: SPACE, runId, holder, fencingToken: epoch, epoch, at: 1_700_000_000_000,
  expect: "new" as const, takeoverId: tid(),
});
const takeover = (runId: string, holder: string, epoch: number) => ({
  space: SPACE, runId, holder, fencingToken: epoch, epoch, at: 1_700_000_000_000,
  expect: "existing" as const, takeoverId: tid(),
});
/** Publish straight to the run's subject with a chosen expectation: a driver the barrier does not
 *  know about, which is what a superseded process IS from the stream's point of view. */
const rawAppend = async (runId: string, expected: number, body: unknown) => {
  const h = natsHeaders();
  h.set("Nats-Expected-Last-Subject-Sequence", String(expected));
  try {
    const pa = await js.publish(wfjSubject(SPACE, runId), new TextEncoder().encode(JSON.stringify(body)), { headers: h });
    return { landed: true as const, seq: pa.seq };
  } catch (e) {
    return { landed: false as const, code: (e as { code?: unknown }).code };
  }
};
/** Read a run's records without the replay's own integrity checks: the cell has to be able to
 *  describe the prefix it is asking the guard about. */
const replayRunJournalRaw = async (runId: string) => {
  const name = `raw_${runId.replace(/[^a-zA-Z0-9_-]/g, "_")}`;
  await jsm.consumers.add(STREAM, { durable_name: name, filter_subject: wfjSubject(SPACE, runId), ack_policy: "explicit" as never });
  const con = await js.consumers.get(STREAM, name);
  const pending = (await con.info(true)).num_pending;
  const out: RunJournalRecord[] = [];
  if (pending === 0) return out;
  const it = await con.fetch({ max_messages: pending, expires: 5_000 });
  for await (const m of it) { out.push(parseRunJournalRecord(m.json(), wfjSubject(SPACE, runId))); m.ack(); if (out.length >= pending) break; }
  return out;
};
/** A raw step record. `ord` is the journal ordinal the chain check will demand: these are written
 *  straight to the wire, so the cell has to place them in the chain itself. */
const step = (run: string, n: number, ord: number) => ({ v: 1, kind: "step", run, n: ord, at: n, entry: { n } });

// ── 1) a first activation on an empty run ─────────────────────────────────────────────────────
{
  const a = await activateRun(js, jsm, startRun("r-1", "d1", 1));
  c("a first activation claims a run that has never been appended to", a.lastSeq > 0, a.lastSeq);
  c("and it replayed nothing, because there was nothing", a.replayed.length === 0);
  await a.append({ step: "one" }, 1);
  await a.append({ step: "two" }, 2);
  // Read RAW first, without the replay's own guards: the chain is only worth checking if it is
  // actually written, and a replay that throws on a torn chain cannot show you an intact one.
  const chain = (await replayRunJournalRaw("r-1")).map((r) => r.n);
  c("every record carries its journal ordinal, contiguous from 0 — activation included",
    chain.join(",") === "0,1,2", chain);
  const { records, lastSeq } = await replayRunJournal(js, jsm, SPACE, "r-1", tid());
  c("the journal reads back as activation-then-steps, in order",
    records.map((r) => r.record.kind).join(",") === "activation,step,step", records.map((r) => r.record.kind));
  c("and the replay's last delivered sequence IS the subject head the next activation must expect",
    lastSeq === records[records.length - 1]!.seq && lastSeq === a.lastSeq, `${lastSeq} vs ${a.lastSeq}`);
  const act = records[0]!.record as RunJournalActivation;
  c("the activation records who took over, under which lease token and epoch",
    act.holder === "d1" && act.fencingToken === 1 && act.epoch === 1, act);
}

// ── 2) THE HANDOFF, ordering A: the activation wins ───────────────────────────────────────────
{
  const first = await activateRun(js, jsm, startRun("r-2", "d1", 1));
  await first.append({ step: "one" }, 1);
  const staleHead = first.lastSeq;

  const second = await activateRun(js, jsm, takeover("r-2", "d2", 2));
  c("a successor activates over a live run", second.lastSeq > staleHead, `${staleHead} -> ${second.lastSeq}`);
  // The prefix a successor holds is the journal AS OF BEFORE ITS OWN ACTIVATION: the predecessor's
  // activation and its one step. Its own activation record is the line it crossed, not prefix.
  c("and its replay carries everything the predecessor wrote, and nothing of its own",
    second.replayed.length === 2 && second.replayed.every((r) => r.seq < second.lastSeq),
    second.replayed.map((r) => `${r.record.kind}@${r.seq}`));

  let refused: unknown;
  try { await first.append({ step: "late" }, 2); } catch (e) { refused = e; }
  c("the predecessor's next append is refused BY THE STREAM, not by its own bookkeeping",
    refused instanceof RunSuperseded, String(refused).slice(0, 90));
  c("and it knows it is superseded rather than merely unlucky", first.isSuperseded);
  // The rule the barrier lives or dies by: no retry at the refreshed head.
  let again: unknown;
  try { await first.append({ step: "later-still" }, 3); } catch (e) { again = e; }
  c("a superseded appender refuses every later append without touching the wire",
    again instanceof RunSuperseded, String(again).slice(0, 60));
  const after = await replayRunJournal(js, jsm, SPACE, "r-2", tid());
  c("so nothing the superseded driver wrote after the takeover is in the journal",
    after.records.filter((r) => r.record.kind === "step").length === 1,
    after.records.map((r) => r.record.kind));
  c("and the successor can still append", (await second.append({ step: "two" }, 3)) > after.lastSeq);
}

// ── 3) THE HANDOFF, ordering B: the predecessor's packet wins ─────────────────────────────────
//
// Nothing orders a takeover ahead of the outgoing driver's last packet. The successor's replay is
// then stale by the time it activates, and the ONLY correct reading of that refusal is "read
// again": it has performed no work, so there is nothing it could be superseded out of.
{
  const first = await activateRun(js, jsm, startRun("r-3", "d1", 1));
  await first.append({ step: "one" }, 1);

  // A takeover that is made stale between its replay and its activation, deterministically: the
  // predecessor appends inside `beforeRetry`, which runs after the first round's replay.
  let rounds = 0;
  let raced = false;
  const second = await activateRun(js, jsm, takeover("r-3", "d2", 2), {
    attempts: 3,
    beforeRetry: async (attempt) => {
      rounds = attempt;
      raced = true;
    },
  });
  // Round 1's replay is honest, so it wins; to force ordering B the predecessor has to land BETWEEN
  // the replay and the publish, which the appender does not expose. So the race is staged directly
  // against the wire below, where the two publishes are explicit.
  c("a takeover with no interference activates on its first round", !raced && rounds === 0, rounds);

  // Stage it explicitly: read the head the way a successor would, let the predecessor land, then
  // activate at the head that was true a moment ago.
  const staged = await replayRunJournal(js, jsm, SPACE, "r-3", tid());
  const head = staged.lastSeq;
  const late = await rawAppend("r-3", head, step("r-3", 99, staged.records.length));
  c("the predecessor's delayed packet lands first, taking the sequence the successor read", late.landed, late);
  const stale = await rawAppend("r-3", head, {
    v: 1, kind: "activation", run: "r-3", n: staged.records.length + 1, holder: "d3", fencingToken: 3, epoch: 3,
    replayedTo: head, at: 1,
  });
  c("so the successor's ACTIVATION at that same head is refused by the stream", !stale.landed && stale.code === 10071, stale);

  // And that refusal is recoverable, which is the whole point of separating it from supersession.
  const third = await activateRun(js, jsm, takeover("r-3", "d3", 3));
  c("re-replaying and activating again succeeds, because the successor had driven nothing",
    third.lastSeq > head, `${head} -> ${third.lastSeq}`);
  c("and its prefix now includes the packet that beat it",
    third.replayed.some((r) => r.record.kind === "step" && JSON.stringify((r.record as { entry: unknown }).entry) === '{"n":99}'),
    third.replayed.map((r) => r.record.kind));
  c("the earlier driver is superseded only now, by the activation that actually won",
    await (async () => { try { await second.append({ step: "x" }, 9); return false; } catch (e) { return e instanceof RunSuperseded; } })());

  // ORDERING B THROUGH THE API, deterministically. `onReplayed` is the last point before the
  // activation is published — the window a driver uses to re-check its lease — so interfering there
  // reproduces "the predecessor's packet landed while I was reading" exactly, with no timing luck.
  let outcome: unknown;
  try {
    await activateRun(js, jsm, takeover("r-3", "d4", 4), {
      attempts: 1,
      onReplayed: async (r) => { await rawAppend("r-3", r.lastSeq, step("r-3", 100, r.records.length)); },
    });
  } catch (e) { outcome = e; }
  c("a takeover whose prefix goes stale between replay and claim reports a RACED activation",
    outcome instanceof ActivationRaced, String(outcome).slice(0, 90));
  c("and never a supersession: a driver that has not activated has driven nothing to be superseded out of",
    !(outcome instanceof RunSuperseded));

  // And it is recoverable, which is the entire reason the two failures are different types: the
  // interference fires once, so the second round replays the moved journal and claims it.
  let interfered = false;
  let fourth: Awaited<ReturnType<typeof activateRun>> | undefined;
  let retryError: unknown;
  try {
    fourth = await activateRun(js, jsm, takeover("r-3", "d5", 5), {
      attempts: 3,
      onReplayed: async (r) => {
        if (interfered) return;
        interfered = true;
        await rawAppend("r-3", r.lastSeq, step("r-3", 101, r.records.length));
      },
    });
  } catch (e) { retryError = e; }
  c("a losing activation retries and wins on the next round, with the interloper's entry now in its prefix",
    retryError === undefined
    && fourth!.replayed.some((r) => r.record.kind === "step" && JSON.stringify((r.record as { entry: unknown }).entry) === '{"n":101}'),
    String(retryError ?? fourth!.replayed.length));
}

// ── 4) two branches of one scope append at once ───────────────────────────────────────────────
//
// The shape that made the first draft of this barrier wrong. Concurrency scopes append from several
// branches simultaneously; two publishes carrying one expectation cannot both land, so an appender
// that let callers hold the head would have a driver declaring ITSELF superseded while it was the
// only writer in the world.
{
  const a = await activateRun(js, jsm, startRun("r-4", "d1", 1));
  const results = await Promise.allSettled([
    a.append({ branch: "a" }, 1),
    a.append({ branch: "b" }, 2),
    a.append({ branch: "c" }, 3),
    a.append({ branch: "d" }, 4),
  ]);
  c("four concurrent branch appends all land", results.every((r) => r.status === "fulfilled"),
    results.map((r) => (r.status === "rejected" ? String(r.reason).slice(0, 60) : "ok")));
  c("the only writer never declares itself superseded", !a.isSuperseded);
  const seqs = results.map((r) => (r.status === "fulfilled" ? r.value : -1));
  c("each got its own stream sequence, in queue order", new Set(seqs).size === 4 && seqs.every((s, i) => i === 0 || s > seqs[i - 1]!), seqs);
  const back = await replayRunJournal(js, jsm, SPACE, "r-4", tid());
  c("and all four are in the journal", back.records.filter((r) => r.record.kind === "step").length === 4);
  c("with the head where the last PubAck left it", back.lastSeq === a.lastSeq, `${back.lastSeq} vs ${a.lastSeq}`);
}

// ── 5) a refusal poisons the pump: nothing queued behind it reaches the wire ──────────────────
{
  const a = await activateRun(js, jsm, startRun("r-5", "d1", 1));
  await activateRun(js, jsm, takeover("r-5", "d2", 2)); // a takes over from a, so `a` is stale
  const results = await Promise.allSettled([a.append({ n: 1 }, 1), a.append({ n: 2 }, 2), a.append({ n: 3 }, 3)]);
  c("every queued append behind a refusal fails", results.every((r) => r.status === "rejected"),
    results.map((r) => r.status));
  c("with the same terminal supersession, not three different opinions",
    results.every((r) => r.status === "rejected" && r.reason instanceof RunSuperseded));
  const back = await replayRunJournal(js, jsm, SPACE, "r-5", tid());
  c("and NONE of them is in the journal: a queued entry retried at the new head is the very write the barrier forbids",
    back.records.filter((r) => r.record.kind === "step").length === 0,
    back.records.map((r) => r.record.kind));
}

// ── 5b) the refusal is REMEMBERED, not re-derived from the broker each time ───────────────────
//
// "Refuses without touching the wire" is not decoration. A superseded driver must be terminal on
// its own account: if the only thing stopping it is the server answering no again, then a broker
// that is slow, partitioned, or momentarily agreeable is a driver back on a run it has lost. This
// runs the appender on its OWN connection and takes the connection away after the refusal — the
// answer must still be "superseded", not a transport error.
{
  const nc2 = await connect({ servers });
  const jsm2 = await jetstreamManager(nc2);
  const js2 = jetstream(nc2);
  const stale = await activateRun(js2, jsm2, startRun("r-5b", "d1", 1));
  await activateRun(js, jsm, takeover("r-5b", "d2", 2));
  let first: unknown;
  try { await stale.append({ n: 1 }, 1); } catch (e) { first = e; }
  c("the stale driver is refused while it still has a connection", first instanceof RunSuperseded);
  await nc2.close();
  let afterClose: unknown;
  try { await stale.append({ n: 2 }, 2); } catch (e) { afterClose = e; }
  c("and it is STILL superseded with no broker to ask: the refusal is its own state, not a round trip",
    afterClose instanceof RunSuperseded, `${(afterClose as Error)?.name}: ${String((afterClose as Error)?.message).slice(0, 60)}`);
}

// ── 5c) an append that ends without a PubAck is terminal too — once it has reached the wire ───
//
// The first barrier poisoned the pump only on a CAS refusal, and everything else — a timeout, a
// dropped connection, an entry that will not serialize — was rethrown with the head untouched and
// the appender still live. Measured, that is not a lost write but a HOLE: the failed entry's
// successor was published at the same expectation, landed, and the journal read back {n:0},{n:2}
// with no indication anything was missing.
//
// The rule that fixed it was "no PubAck is terminal", and it was too total by one case. A record
// that cannot be SERIALIZED never reached the wire: the head is not unknown, it is exactly where it
// was, and nothing landed. Retiring the run for it would end a run over a bad payload — and it would
// also read as a supersession, because `isCasLoss` inspects a `code` and a thrown object can carry
// one. So the boundary is the wire: bytes are made first, and only what happens after them poisons.
{
  const a = await activateRun(js, jsm, startRun("r-5c", "d1", 1));
  await a.append({ n: 0 }, 0);
  // Two appends issued together: the first cannot be serialized (a bigint), the second is ordinary.
  const results = await Promise.allSettled([a.append({ n: 1, bad: 1n }, 1), a.append({ n: 2 }, 2)]);
  c("an entry that cannot be serialized fails as itself: this process's bug, reported as one",
    results[0]!.status === "rejected"
    && !((results[0] as PromiseRejectedResult).reason instanceof RunJournalStalled)
    && (results[0] as PromiseRejectedResult).reason instanceof TypeError,
    String((results[0] as PromiseRejectedResult)?.reason).slice(0, 80));
  c("and it is NOT read as the stream refusing the append: a local throw can carry a CAS code",
    !((results[0] as PromiseRejectedResult).reason instanceof RunSuperseded));
  c("the appender is untouched, because nothing was sent and nothing moved", !a.isFinished);
  c("so the next append lands, at the expectation the failed one never spent",
    results[1]!.status === "fulfilled",
    results[1]!.status === "rejected" ? String((results[1] as PromiseRejectedResult).reason).slice(0, 60) : "ok");
  const back = await replayRunJournal(js, jsm, SPACE, "r-5c", tid());
  const steps = back.records.filter((r) => r.record.kind === "step");
  // The property the earlier rule was protecting, and the one that actually matters: the ORDINAL
  // chain is unbroken. The entry that could not be written is simply not there — which is what an
  // unwritten entry is — and its successor did not land over its gap.
  c("and the journal has no hole: the ordinals are contiguous across the failure",
    steps.every((r, i) => r.record.n === i + 1), steps.map((r) => r.record.n));
  c("with the unserializable entry absent rather than half-written",
    steps.map((r) => (r.record as { entry: { n: number } }).entry.n).join(",") === "0,2",
    steps.map((r) => (r.record as { entry: unknown }).entry));
}

// ── 5d) the same, when the connection is what went away ───────────────────────────────────────
//
// The ambiguous case, and the reason this is terminal rather than retryable: a publish that dies in
// flight may already be on disk. The appender cannot tell, so it must not guess — the only thing
// that re-establishes a true head is replaying and activating again.
{
  const nc3 = await connect({ servers });
  const jsm3 = await jetstreamManager(nc3);
  const js3 = jetstream(nc3);
  const a = await activateRun(js3, jsm3, startRun("r-5d", "d1", 1));
  await a.append({ n: 0 }, 0);
  await nc3.close();
  let lost: unknown;
  try { await a.append({ n: 1 }, 1); } catch (e) { lost = e; }
  c("an append into a dead connection stalls the appender", lost instanceof RunJournalStalled,
    `${(lost as Error)?.name}`);
  c("and it stays stalled without asking anyone", a.isFinished);
  // Recovery is the ordinary takeover path, by the SAME holder: replay, learn the real head, activate.
  const again = await activateRun(js, jsm, takeover("r-5d", "d1", 2));
  c("a fresh activation recovers the run and knows the prefix", again.steps().length === 1);
  const seq = await again.append({ n: 2 }, 2);
  c("and it can write again", seq > 0 && !again.isFinished);
}

// ── 5e) a replay refuses a consumer that has already fed someone else ─────────────────────────
//
// The durable's name is derived from the run, so every contender asks for the same one — and `add`
// on an existing durable RETURNS it rather than refusing. Measured on this broker: a rival that had
// drained 3 of 6 records left `add` answering `delivered=3, pending=3`, a count that is perfectly
// self-consistent for the SECOND HALF of the journal. Counting cannot catch that; only asking
// whether the consumer is genuinely new can.
{
  const a = await activateRun(js, jsm, startRun("r-5e", "d1", 1));
  for (let n = 0; n < 5; n += 1) await a.append({ n }, n);
  const cfg = runJournalConsumerConfig(SPACE, "r-5e", "rival");
  await jsm.consumers.add(STREAM, cfg);
  const rival = await js.consumers.get(STREAM, cfg.durable_name!);
  const iter = await rival.fetch({ max_messages: 3, expires: 2_000 });
  let held = 0;
  for await (const m of iter) { m.ack(); if (++held >= 3) break; }
  await wait(150);
  const info = await (await js.consumers.get(STREAM, cfg.durable_name!)).info(true);
  c("a rival's shared durable is left holding a self-consistent count of the TAIL",
    info.delivered.consumer_seq === 3 && info.num_pending === 3,
    `delivered=${info.delivered.consumer_seq} pending=${info.num_pending}`);
  // The delete inside replay clears it, so to see what an inherited consumer does, ask `add` the
  // same question replay asks — this is the state replay would have adopted had its delete lost.
  const inherited = await jsm.consumers.add(STREAM, cfg);
  c("and `add` hands that very consumer back rather than refusing",
    inherited.delivered.consumer_seq === 3, inherited.delivered.consumer_seq);
  // The guard replay applies to whatever `add` returns, put to the consumer that really was
  // inherited — the same call, the same live ConsumerInfo, without pretending the delete lost.
  let raced: unknown;
  try { assertReplayConsumerFresh("r-5e", cfg.durable_name!, inherited); } catch (e) { raced = e; }
  c("so a replay that finds one refuses it by name instead of resuming from half a run",
    raced instanceof RunJournalReplayRaced, `${(raced as Error)?.name}`);
  let fresh: unknown;
  try { assertReplayConsumerFresh("r-5e", cfg.durable_name!, { delivered: { consumer_seq: 0 }, num_ack_pending: 0 }); } catch (e) { fresh = e; }
  c("and passes a consumer that has fed nobody", fresh === undefined);
  const back = await replayRunJournal(js, jsm, SPACE, "r-5e", tid());
  c("while an uncontended replay still reads the whole run", back.records.length === 6, back.records.length);
}

// ── 5e2) the replay's delete swallows ONE error and no others ────────────────────────────────
//
// A catch-all there is how the consumer above survives to be inherited: any failure to delete
// leaves a rival's consumer standing and the `add` adopts it.
{
  let missing: unknown;
  try { await jsm.consumers.delete(STREAM, "wfj_never-existed"); } catch (e) { missing = e; }
  c("deleting a consumer that was never there is the ordinary case", isConsumerNotFound(missing),
    `${(missing as Error)?.name}/${(missing as { code?: unknown })?.code}`);
  c("and nothing else passes for it", !isConsumerNotFound(new Error("permissions violation")));
}

// ── 5f) a prefix that does not begin at the run's genesis is not a prefix ─────────────────────
//
// The counting check proves the consumer delivered what it promised, never that what it promised
// was the whole run. A subject purge that retires an old run leaves a tail whose LAST sequence is
// still the true head, so an activation on it succeeds and the run resumes from a middle it has no
// record of ever reaching. The anchor is the genesis activation: the only record in a run published
// into an empty subject, and so the only one whose `replayedTo` is 0.
{
  const a = await activateRun(js, jsm, startRun("r-5f", "d1", 1));
  for (let n = 0; n < 4; n += 1) await a.append({ n }, n);
  const before = await replayRunJournal(js, jsm, SPACE, "r-5f", tid());
  c("the run replays whole while its head is there", before.records.length === 5);
  await jsm.streams.purge(STREAM, { filter: wfjSubject(SPACE, "r-5f"), keep: 3 });
  let truncated: unknown;
  try { await replayRunJournal(js, jsm, SPACE, "r-5f", tid()); } catch (e) { truncated = e; }
  c("once the head is purged the replay refuses, though its counts still agree",
    truncated instanceof RunJournalPrefixTruncated, `${(truncated as Error)?.name}`);
  let cannotActivate: unknown;
  try { await activateRun(js, jsm, takeover("r-5f", "d2", 2)); } catch (e) { cannotActivate = e; }
  c("and no driver can take the run over on a truncated prefix",
    cannotActivate instanceof RunJournalPrefixTruncated, `${(cannotActivate as Error)?.name}`);
}

// ── 5g) …and "starts with an activation" is not the same test ────────────────────────────────
//
// A run that has been taken over has activations in its middle, so a purge can leave one of THEM
// at the front — a prefix that begins with an activation and still misses everything before it.
// Only `replayedTo === 0` says "this record was published into an empty subject".
{
  const d1 = await activateRun(js, jsm, startRun("r-5g", "d1", 1));
  await d1.append({ n: 0 }, 0);
  const d2 = await activateRun(js, jsm, takeover("r-5g", "d2", 2));
  await d2.append({ n: 1 }, 1);
  await jsm.streams.purge(STREAM, { filter: wfjSubject(SPACE, "r-5g"), keep: 2 });
  const head = (await replayRunJournalRaw("r-5g"))[0];
  c("the purge leaves a mid-run ACTIVATION at the front", head?.kind === "activation" && head.replayedTo > 0,
    `${head?.kind}/${(head as RunJournalActivation)?.replayedTo}`);
  let truncated: unknown;
  try { await replayRunJournal(js, jsm, SPACE, "r-5g", tid()); } catch (e) { truncated = e; }
  c("and the replay still refuses it: an activation is not the genesis activation",
    truncated instanceof RunJournalPrefixTruncated, `${(truncated as Error)?.name}`);
}

// ── 5h) the lease token ORDERS takeovers; the barrier alone does not ─────────────────────────
//
// The barrier fences knowledge of the head, and knowledge is free: anyone who replays has it. So a
// driver whose lease expired long ago could activate over the current holder just by reading first
// — measured, before this check, as activations [2, 1] on one run with the token-1 driver's append
// landing afterwards. The replayed prefix is the answer, and it is current as of the CAS.
{
  const cur = await activateRun(js, jsm, startRun("r-5h", "d2", 2));
  await cur.append({ n: 0 }, 0);
  let stale: unknown;
  try { await activateRun(js, jsm, takeover("r-5h", "d1", 1)); } catch (e) { stale = e; }
  c("a takeover under an older lease token is refused", stale instanceof StaleLeaseToken,
    `${(stale as Error)?.name}`);
  c("and it names who actually holds the run",
    (stale as StaleLeaseToken)?.held === 2 && (stale as StaleLeaseToken)?.holder === "d2");
  c("the current holder is untouched and still driving", !cur.isFinished);
  c("and can still append", (await cur.append({ n: 1 }, 1)) > 0);
  const back = await replayRunJournal(js, jsm, SPACE, "r-5h", tid());
  c("nothing of the stale driver reached the journal",
    back.records.filter((r) => r.record.kind === "activation").length === 1,
    back.records.map((r) => r.record.kind));
  // Equal is allowed: a lease is renewed under the SAME token, and the holder that lost its
  // appender to a stalled publish recovers by activating again under the lease it still has.
  const again = await (async () => {
    try { return await activateRun(js, jsm, takeover("r-5h", "d2", 2)); } catch { return undefined; }
  })();
  c("the same token can activate again: that is one holder recovering, not two drivers",
    again?.steps().length === 2, again === undefined ? "refused" : again.steps().length);
  const newer = await activateRun(js, jsm, takeover("r-5h", "d3", 3));
  c("and a NEWER token takes the run over as before", newer.lastSeq > (again?.lastSeq ?? 0));
  // Which activation the prefix is judged against matters: this run's FIRST is token 2 and its
  // last is token 3, so a token-2 takeover is stale only if the LAST one is what answers.
  let overtaken: unknown;
  try { await activateRun(js, jsm, takeover("r-5h", "d2", 2)); } catch (e) { overtaken = e; }
  c("a holder that has since been overtaken cannot re-activate on its old token",
    overtaken instanceof StaleLeaseToken && (overtaken as StaleLeaseToken).held === 3,
    `${(overtaken as Error)?.name}/${(overtaken as StaleLeaseToken)?.held}`);
}

// ── 5i) a record missing from the MIDDLE is caught, which no front anchor can do ─────────────
//
// Measured before the chain existed: deleting one interior message left a replay of stream
// sequences [1,2,4] carrying steps 0 and 2, which passed the count, passed the freshness check and
// passed the genesis anchor — and a successor activated on it. The run would then have re-performed
// the effect whose record was gone, which is the one thing a journal exists to prevent.
{
  const a = await activateRun(js, jsm, startRun("r-5i", "d1", 1));
  for (let n = 0; n < 3; n += 1) await a.append({ n }, n);
  const before = await replayRunJournal(js, jsm, SPACE, "r-5i", tid());
  c("the run replays whole while every record is there", before.records.length === 4);
  await jsm.streams.deleteMessage(STREAM, before.records[2]!.seq);
  let torn: unknown;
  try { await replayRunJournal(js, jsm, SPACE, "r-5i", tid()); } catch (e) { torn = e; }
  c("one interior record removed is refused, though the front and the count both still agree",
    torn instanceof RunJournalPrefixTruncated, `${(torn as Error)?.name}`);
  c("and it says which entry is missing rather than that something is wrong",
    (torn as RunJournalPrefixTruncated)?.expectedN === 2 && (torn as RunJournalPrefixTruncated)?.foundN === 3,
    `expected ${(torn as RunJournalPrefixTruncated)?.expectedN}, found ${(torn as RunJournalPrefixTruncated)?.foundN}`);
  let cannot: unknown;
  try { await activateRun(js, jsm, takeover("r-5i", "d2", 2)); } catch (e) { cannot = e; }
  c("so no successor can take a torn run over", cannot instanceof RunJournalPrefixTruncated);
}

// ── 5j) a retired run is not a new run, and only the caller can say so ───────────────────────
//
// Purging a run's subject is the retirement §7.6 asks the subject range for, and it leaves a
// journal that reads back exactly like a run that never started: zero records. Measured before
// this, a purged run activated again as if new, at `replayedTo: 0`. The stream cannot answer it —
// the record that says a run EXISTS is not in the stream — so the activation states which it means.
{
  const a = await activateRun(js, jsm, startRun("r-5j", "d1", 1));
  await a.append({ n: 0 }, 0);
  await jsm.streams.purge(STREAM, { filter: wfjSubject(SPACE, "r-5j") });
  const empty = await replayRunJournal(js, jsm, SPACE, "r-5j", tid());
  c("a purged run replays as nothing at all: indistinguishable from never-started", empty.records.length === 0);
  let retired: unknown;
  try { await activateRun(js, jsm, takeover("r-5j", "d2", 2)); } catch (e) { retired = e; }
  c("resuming it is refused rather than silently restarting a run that already ran",
    retired instanceof RunNotResumable, `${(retired as Error)?.name}`);
  let twice: unknown;
  try { await activateRun(js, jsm, startRun("r-1", "d9", 9)); } catch (e) { twice = e; }
  c("and the mismatch is refused in the other direction too: a live run cannot be started again",
    twice instanceof RunAlreadyStarted, `${(twice as Error)?.name}`);
}

// ── 5k) what a refused append means when the run was retired under it ────────────────────────
//
// A purge moves the head out from under a LIVE appender, so it is refused exactly as a superseded
// driver is — with no successor in existence. The refusal is honest ("the stream refused my
// expectation"); what it is NOT is a reliable answer to "did someone take my run", and a driver
// that needs that answer replays for it.
{
  const a = await activateRun(js, jsm, startRun("r-5k", "d1", 1));
  await a.append({ n: 0 }, 0);
  await jsm.streams.purge(STREAM, { filter: wfjSubject(SPACE, "r-5k") });
  let refused: unknown;
  try { await a.append({ n: 1 }, 1); } catch (e) { refused = e; }
  c("a retired run refuses its own driver's next append", refused instanceof RunSuperseded);
  c("and the appender is finished, which is the part a driver may act on", a.isFinished);
  const after = await replayRunJournal(js, jsm, SPACE, "r-5k", tid());
  c("the journal is what distinguishes retirement from a takeover: nobody activated, there is nothing there",
    after.records.length === 0, after.records.map((r) => r.record.kind));
}

// ── 5l) an equal token stays bound to the identity that holds it ─────────────────────────────
//
// "Equal is allowed" was written for one case: a holder whose appender stalled recovering under the
// lease it still has. Measured, it allowed far more — holder A at epoch 1, then B at epoch 2, then A
// at epoch 1 again, all on token 7, after which A appended and B was superseded. That is the
// retry-at-a-refreshed-head the barrier forbids, performed through activateRun rather than through
// the appender. Three directions, because getting one right is not getting the rule right.
{
  const tok = (runId: string, holder: string, epoch: number, expect: "new" | "existing") => ({
    space: SPACE, runId, holder, fencingToken: 7, epoch, at: 1_700_000_000_000, expect, takeoverId: tid(),
  });
  const A = await activateRun(js, jsm, tok("r-5l", "A", 1, "new"));
  await A.append({ by: "A" }, 1);

  // Direction one, and the step that breaks the whole sequence: two holders never legitimately
  // carry the same token — a lease that moves carries a higher one — so this is refused outright,
  // and A can never be "returned to" because B was never there.
  let otherHolder: unknown;
  try { await activateRun(js, jsm, tok("r-5l", "B", 2, "existing")); } catch (e) { otherHolder = e; }
  c("a DIFFERENT holder cannot activate on the token another holder is using",
    otherHolder instanceof ActivationNotAuthorized, `${(otherHolder as Error)?.name}`);
  c("and the holder that actually has the run is untouched", !A.isFinished);
  c("so nothing the intruder wanted is in the journal: still one activation",
    (await replayRunJournal(js, jsm, SPACE, "r-5l", tid())).records.filter((r) => r.record.kind === "activation").length === 1);

  // Direction two: the same holder at a DIFFERENT epoch, both ways. This used to allow the newer
  // one through, on the reasoning that a restart should reclaim its own run. The pool disagrees, and
  // it is the authority: within one attempt the lease comes back verbatim, a redelivery advances the
  // token, and the commit gate binds the epoch EXACTLY — so (equal token, newer epoch) is a tuple no
  // lease issues, and a driver holding it could drive a run it could never settle.
  let newEpoch: unknown;
  try { await activateRun(js, jsm, tok("r-5l", "A", 2, "existing")); } catch (e) { newEpoch = e; }
  c("a NEWER process of the same holder cannot activate on the epoch the lease did not bind",
    newEpoch instanceof ActivationNotAuthorized, `${(newEpoch as Error)?.name}`);
  let oldEpoch: unknown;
  try { await activateRun(js, jsm, tok("r-5l", "A", 0, "existing")); } catch (e) { oldEpoch = e; }
  c("and an OLDER one cannot either: the direction does not matter, the binding does",
    oldEpoch instanceof ActivationNotAuthorized, `${(oldEpoch as Error)?.name}`);
  c("neither attempt is in the journal: still one activation",
    (await replayRunJournal(js, jsm, SPACE, "r-5l", tid())).records.filter((r) => r.record.kind === "activation").length === 1);

  // Direction three, the case the rule was relaxed for and which must still work: same token, same
  // holder, same epoch — one process picking its own run back up after its appender stalled. A
  // restart reaches this by re-leasing: its attempt's lease returns with the epoch it was bound at.
  const recovered = await activateRun(js, jsm, tok("r-5l", "A", 1, "existing"));
  c("exact-tuple recovery still works: that is one process resuming itself, not two drivers",
    (await recovered.append({ by: "A-again" }, 2)) > 0);
}

// ── 5m) two takeovers replaying at the same instant ──────────────────────────────────────────
//
// The replay consumer used to be named after the RUN, so contenders shared it: `add` returned the
// other's half-read consumer, and each one's delete tore down the other's live fetch. Measured on
// the shared form, two concurrent takeovers on a six-record run left one holding 1 record and then a
// terminal incomplete-replay error — never reaching the retry path that was supposed to cover it —
// and eight produced raw `consumer deleted` and `ConsumerNotFoundError` from the API. A consumer
// nobody else names has none of that to race with.
{
  const a = await activateRun(js, jsm, startRun("r-5m", "d1", 1));
  for (let n = 0; n < 4; n += 1) await a.append({ n }, n);
  const both = await Promise.allSettled([
    replayRunJournal(js, jsm, SPACE, "r-5m", tid()),
    replayRunJournal(js, jsm, SPACE, "r-5m", tid()),
  ]);
  c("two concurrent replays both read the WHOLE run, rather than halves of it",
    both.every((r) => r.status === "fulfilled" && r.value.records.length === 5),
    both.map((r) => r.status === "fulfilled" ? r.value.records.length : (r.reason as Error).name));

  const eight = await Promise.allSettled(Array.from({ length: 8 }, () => replayRunJournal(js, jsm, SPACE, "r-5m", tid())));
  c("and eight of them do too: no API errors, no consumer deleted out from under a fetch",
    eight.every((r) => r.status === "fulfilled" && r.value.records.length === 5),
    eight.map((r) => r.status === "fulfilled" ? r.value.records.length : (r.reason as Error).name).join(","));

  // Two full takeovers at once: the stream still admits exactly one, and the loser's failure is the
  // recoverable kind rather than a torn read.
  const race = await Promise.allSettled([
    activateRun(js, jsm, { ...takeover("r-5m", "d2", 2), attempts: 1 } as never),
    activateRun(js, jsm, takeover("r-5m", "d3", 3), { attempts: 1 }),
  ]);
  const winners = race.filter((r) => r.status === "fulfilled").length;
  c("two concurrent takeovers produce exactly one activation", winners === 1,
    race.map((r) => r.status === "fulfilled" ? "won" : (r.reason as Error).name).join(","));
  const loser = race.find((r) => r.status === "rejected") as PromiseRejectedResult | undefined;
  c("and the loser is told to read again, not that the journal is broken",
    loser?.reason instanceof ActivationRaced || loser?.reason instanceof StaleLeaseToken ||
    loser?.reason instanceof ActivationNotAuthorized, `${(loser?.reason as Error)?.name}`);
}

// ── 5n) `expect` is CHECKED, not merely typed ────────────────────────────────────────────────
//
// A type says nothing at a boundary a caller can reach with a value the compiler never saw — a
// journal read back from the wire, a config parsed from JSON, JavaScript. A missing or bogus value
// would fall through BOTH guards and reactivate a purged run as if it were new, which is precisely
// what the field exists to make impossible.
{
  for (const bogus of [undefined, "", "yes", "New"]) {
    let refused: unknown;
    try {
      await activateRun(js, jsm, { ...startRun("r-5n", "d1", 1), expect: bogus as never });
    } catch (e) { refused = e; }
    c(`a takeover stating expect ${JSON.stringify(bogus)} is refused rather than defaulted`,
      refused instanceof Error && /must state expect/.test((refused as Error).message),
      `${(refused as Error)?.name}: ${String((refused as Error)?.message).slice(0, 60)}`);
  }
  const good = await activateRun(js, jsm, startRun("r-5n", "d1", 1));
  c("and a stated one still works", good.lastSeq > 0);
}

// ── 5o) the chain proves consecutive; the ANCHOR proves it starts at a start ──────────────────
//
// Ordinals are contiguous from 0 in a forged prefix just as easily as in a real one — a step
// numbered 0 is a journal that begins in the middle of a story with its page numbers rewritten. The
// genesis anchor is the other half and it stays alongside the chain rather than being replaced by
// it: only an activation that replayed NOTHING can be a run's first record.
{
  const forged = await rawAppend("r-5o", 0, { v: 1, kind: "step", run: "r-5o", n: 0, at: 1, entry: { forged: true } });
  c("a step can be written as journal entry 0 — the chain has no objection to it", forged.landed, forged);
  let anchored: unknown;
  try { await replayRunJournal(js, jsm, SPACE, "r-5o", tid()); } catch (e) { anchored = e; }
  c("but the replay refuses it: entry 0 of a run is the activation that replayed nothing",
    anchored instanceof RunJournalPrefixTruncated, `${(anchored as Error)?.name}`);
}

// ── 5p) the tuple that was AUTHORIZED is the tuple that lands ────────────────────────────────
//
// `activateRun` awaits inside the window between checking the takeover and publishing it. Anything
// that runs in that window — the caller's own hook, or any concurrent task on this loop — can
// mutate an ordinary JS object after it passed authorization, so one tuple is checked and a
// different one is written. The subject was captured before the await, which makes the runId case
// worse rather than better: a mutated runId would label a foreign run on THIS run's subject, which
// is a record the barrier itself would then believe. The repo's WorkLease seams snapshot caller
// input before awaiting for exactly this reason (`endpoint-work.ts:98-118`); this one now does too.
{
  const d1 = await activateRun(js, jsm, startRun("r-5p", "d1", 1));
  await d1.append({ marker: "as-recorded" }, 1);
  const t = { ...takeover("r-5p", "d2", 2) };
  const app = await activateRun(js, jsm, t, {
    onReplayed: async (replay) => {
      t.holder = "impostor";
      t.fencingToken = 99;
      t.epoch = 7;
      t.runId = "r-other";
      t.at = 999;
      // Reach INTO the prefix, not just at the array around it: this is the journal the interpreter
      // is about to resume from, and a mutated record here would make the run replay a history that
      // is not the one WFJ stores.
      (replay.records as { record: RunJournalRecord; seq: number }[]).push(replay.records[0]!);
      const inner = replay.records[0]!.record as RunJournalActivation;
      inner.holder = "impostor";
      inner.n = 99;
      const step0 = replay.records[1]!.record as { entry: { marker: string } };
      step0.entry.marker = "rewritten";
    },
  });
  const seen = await replayRunJournalRaw("r-5p");
  const landed = seen[seen.length - 1] as RunJournalActivation;
  c("a takeover mutated after authorization lands as the tuple that was AUTHORIZED, not the mutated one",
    landed.holder === "d2" && landed.fencingToken === 2 && landed.epoch === 2 && landed.at === 1_700_000_000_000,
    landed);
  c("and the run it labels is the run whose subject it was published on",
    landed.run === "r-5p", landed.run);
  c("and the ordinal is the prefix that was VALIDATED, not one the hook grew after the fact",
    landed.n === 2, landed.n);
  // The one that matters: `steps()` IS the journal the interpreter resumes from. A shared reference
  // here would make the run replay a history that is not the one on the wire — and be believed,
  // because nothing downstream re-reads the subject.
  c("the journal the appender hands the interpreter carries the entry as RECORDED, not as rewritten",
    (app.steps()[0] as { marker: string })?.marker === "as-recorded", app.steps());
  c("and the prefix the hook reached into is untouched on the wire too: it never had the real one",
    (seen[0] as RunJournalActivation).holder === "d1" && (seen[0] as RunJournalActivation).n === 0,
    seen[0]);
}

// ── 5p2) …and the window is not only the hook ────────────────────────────────────────────────
//
// The cell above uses `onReplayed` because a hook is a deterministic way to run code inside the
// window. The window is not the hook: `activateRun` awaits a replay from the network before it
// validates anything, and any task on the loop can reassign the caller's takeover while that await
// is outstanding — no test seam involved. `subject` is computed from `runId` before that await, so
// an unsnapshotted runId produces the same foreign-label record with nothing hooked at all.
{
  await activateRun(js, jsm, startRun("r-5p2", "d1", 1));
  const t = { ...takeover("r-5p2", "d2", 2) };
  const pending = activateRun(js, jsm, t);
  // Synchronously, before the replay's first await can resolve: this is the ordinary case of a
  // caller reusing a mutable object, not an adversary.
  t.runId = "r-elsewhere";
  t.holder = "someone-else";
  await pending;
  const landed = (await replayRunJournalRaw("r-5p2")).at(-1) as RunJournalActivation;
  c("a takeover reassigned while its replay is in flight still lands as the tuple that was read",
    landed.run === "r-5p2" && landed.holder === "d2", landed);
}

// ── 5q) a record missing from the TAIL, which the chain cannot see either ────────────────────
//
// The chain catches an interior hole because the ordinals stop being contiguous. Delete the NEWEST
// record and they stay contiguous — the run simply replays as a shorter, intact one. And the head
// the fence compares against comes back rolled to the surviving message, because a delete marks the
// subject's last as needing recalculation and the per-subject state is recomputed from what
// survives. So the CAS accepts an append at a head the run already moved past.
//
// This cell RECORDS the hazard rather than claiming a fix: no anchor inside the journal can detect
// its own truncated tail, because every record it could check against is the part that is gone. The
// answer is an anchor OUTSIDE the journal — the run record's high-water ordinal — and that is filed
// as its own slice item, not smuggled in here.
{
  const a = await activateRun(js, jsm, startRun("r-5q", "d1", 1));
  for (let n = 0; n < 3; n += 1) await a.append({ n }, n);
  const before = await replayRunJournal(js, jsm, SPACE, "r-5q", tid());
  c("the run replays whole while every record is there", before.records.length === 4, before.records.length);

  await jsm.streams.deleteMessage(STREAM, before.records[before.records.length - 1]!.seq);
  const after = await replayRunJournal(js, jsm, SPACE, "r-5q", tid());
  c("with its newest record deleted the run replays SHORT — and intact, which is the problem",
    after.records.length === 3 && after.records.every((r, i) => r.record.n === i),
    after.records.map((r) => r.record.n));
  c("and the head the fence compares against rolled back with it",
    after.lastSeq < before.lastSeq, `${after.lastSeq} vs ${before.lastSeq}`);

  // The consequence, stated as an outcome rather than as an argument: a successor activates over a
  // run whose last recorded step is gone, and the effect that step recorded will be performed again.
  const successor = await activateRun(js, jsm, takeover("r-5q", "d2", 2));
  c("a successor activates on the rolled-back head: nothing in the journal can refuse this",
    successor.lastSeq > 0, successor.lastSeq);
  c("and it resumes from a prefix that is missing the work the run really did",
    successor.steps().length === 2, successor.steps().length);
}

// ── 5r) a local failure is not the stream saying no ──────────────────────────────────────────
//
// `isCasLoss` reads a `code` off whatever was thrown. Serialization used to happen INSIDE that
// catch, so an entry whose `toJSON` threw an object carrying `code: 10071` was classified as a
// refused append — and a refused append is the one answer a driver acts on by standing down, for
// good. A bug in this process would have retired the run.
{
  const a = await activateRun(js, jsm, startRun("r-5r", "d1", 1));
  const poison = { get entry() { throw Object.assign(new Error("toJSON blew up"), { code: 10071 }); } };
  let local: unknown;
  try { await a.append(poison as never, 1); } catch (e) { local = e; }
  c("an entry that cannot be serialized fails as ITSELF, not as a supersession",
    local instanceof Error && !(local instanceof RunSuperseded) && /toJSON blew up/.test((local as Error).message),
    `${(local as Error)?.name}: ${(local as Error)?.message}`);
  // And the run is still this driver's: nothing was refused, so nothing was lost.
  c("and the appender is NOT retired by it: a local bug does not end a run",
    !a.isFinished, a.isFinished);
  c("it can still append", (await a.append({ ok: true }, 2)) > 0);
}

// ── 5s) the replay consumer cleans up, and says so when it cannot ────────────────────────────
//
// The delete used to swallow every error, resting on the stream's limits to reap what was left.
// They do not: WFJ sets neither `max_consumers` nor `consumer_limits`, which normalize to unlimited
// and to an inactive threshold of zero, and a durable at zero is given no delete timer. One failed
// delete per takeover would have been permanent. Two halves: the consumer carries its own reaper,
// and a delete that fails for a reason we did not name is raised rather than hidden.
{
  const cfg = runJournalConsumerConfig(SPACE, "r-5s", "tk1");
  c("the replay consumer carries an inactivity threshold, so the server reaps it even if we cannot",
    typeof cfg.inactive_threshold === "number" && cfg.inactive_threshold > 0, cfg.inactive_threshold);

  const a = await activateRun(js, jsm, startRun("r-5s", "d1", 1));
  await a.append({ n: 0 }, 1);
  const before = (await jsm.consumers.list(STREAM).next()).length;
  await replayRunJournal(js, jsm, SPACE, "r-5s", tid());
  const after = (await jsm.consumers.list(STREAM).next()).length;
  c("an ordinary replay leaves no consumer behind at all", after === before, `${before} -> ${after}`);
}

// ── 6) runs do not fence each other ───────────────────────────────────────────────────────────
{
  const x = await activateRun(js, jsm, startRun("r-6a", "d1", 1));
  const y = await activateRun(js, jsm, startRun("r-6b", "d1", 1));
  await y.append({ other: true }, 1);
  await y.append({ other: true }, 2);
  // The SECOND append is the one that discriminates: a head advanced by counting locally rather
  // than from the PubAck agrees with reality only while a run's sequences happen to be contiguous,
  // which they are not the moment any other run shares the stream. Caught, because the way that
  // breaks is a throw, and a throw outside every assertion reads as a crashed suite rather than as
  // this rule failing.
  let seq = 0, seq2 = 0, crossErr: unknown;
  try {
    seq = await x.append({ mine: true }, 3);
    await y.append({ other: true }, 4);
    seq2 = await x.append({ mine: true }, 5);
  } catch (e) { crossErr = e; }
  c("a run's fence is its own subject: another run's appends neither invalidate it nor renumber it",
    crossErr === undefined && seq > 0 && seq2 > seq && !x.isSuperseded,
    `${seq} then ${seq2}${crossErr === undefined ? "" : ` — ${String(crossErr).slice(0, 70)}`}`);
  c("and each run reads back only its own records",
    (await replayRunJournal(js, jsm, SPACE, "r-6a", tid())).records.length === 3
    && (await replayRunJournal(js, jsm, SPACE, "r-6b", tid())).records.length === 4);
}

// ── 7) the head cannot come from STREAM.INFO, which is why it comes from the replay ───────────
//
// The plan once said the driver would read the run subject's current sequence from `STREAM.INFO`.
// It cannot: `last_seq` is stream-WIDE and `subjects_filter` returns per-subject message COUNTS.
// This is the measurement, kept executable, because the wrong version of it is entirely plausible.
{
  const a = await activateRun(js, jsm, startRun("r-7", "d1", 1));
  await a.append({ n: 1 }, 1);
  const other = await activateRun(js, jsm, startRun("r-7b", "d1", 1));
  await other.append({ n: 1 }, 1); // moves the STREAM, not this run's subject
  const info = await jsm.streams.info(STREAM, { subjects_filter: wfjSubject(SPACE, "r-7") });
  c("STREAM.INFO's last_seq is stream-wide, so it over-reads this run's head",
    info.state.last_seq > a.lastSeq, `${info.state.last_seq} vs ${a.lastSeq}`);
  c("and its subjects_filter answers with a COUNT, which is not a sequence",
    (info.state.subjects ?? {})[wfjSubject(SPACE, "r-7")] === 2, info.state.subjects);
  const wrong = await rawAppend("r-7", info.state.last_seq, step("r-7", 1, 2));
  c("publishing at the INFO-derived sequence is refused: it was never this subject's head",
    !wrong.landed && wrong.code === 10071, wrong);
  c("while the replay's last delivered sequence is accepted",
    (await rawAppend("r-7", (await replayRunJournal(js, jsm, SPACE, "r-7", tid())).lastSeq, step("r-7", 2, 2))).landed);
}

// ── 8) every takeover replays from the TOP ────────────────────────────────────────────────────
//
// The replay durable is deleted and recreated for exactly this reason: a durable remembers how far
// it delivered, so a reused one would hand the second takeover an empty tail — a resume that
// believes the run has no history and re-performs every effect it already performed.
{
  const a = await activateRun(js, jsm, startRun("r-8", "d1", 1));
  await a.append({ n: 1 }, 1);
  const first = (await replayRunJournal(js, jsm, SPACE, "r-8", tid())).records.length;
  const second = (await replayRunJournal(js, jsm, SPACE, "r-8", tid())).records.length;
  c("a second replay of the same run returns the same prefix, not the tail after the first",
    first === second && first === 2, `${first} then ${second}`);
}

// ── 9) the envelope is validated, and the step's payload is not ───────────────────────────────
{
  c("a record with an unknown kind is refused rather than replayed as a step",
    (() => { try { parseRunJournalRecord({ v: 1, kind: "note", run: "r", at: 0 }, "s"); return false; } catch { return true; } })());
  c("a step whose entry is an arbitrary shape is accepted: the language owns what a step means",
    parseRunJournalRecord({ v: 1, kind: "step", run: "r", n: 0, at: 0, entry: { anything: [1, 2] } }, "s").kind === "step");
  c("an activation missing its fencing token is refused",
    (() => { try { parseRunJournalRecord({ v: 1, kind: "activation", run: "r", at: 0, holder: "d", epoch: 1, replayedTo: 0 }, "s"); return false; } catch { return true; } })());
}

// ── 10) the deviation's evidence: a per-entry subject COULD be fenced ─────────────────────────
//
// Kept executable because the plan states this as a CHOICE, and a choice justified by a claim
// nobody re-runs decays into folklore. `Nats-Expected-Last-Subject-Sequence-Subject` evaluates the
// expectation against a wildcard comparator, so `wfj.<runId>.<entryId>` could carry a run-wide
// fence on this broker floor. What it also shows is the failure mode: WITHOUT the comparator, the
// same publish is compared against its own fresh subject, is therefore a create at 0, and always
// lands. The fence disappears silently, which is why the run subject carries it instead.
{
  const sub = (e: string) => `cotal.${SPACE}.wfjprobe.r.${e}`;
  await jsm.streams.add({ name: "WFJPROBE", subjects: [`cotal.${SPACE}.wfjprobe.>`] });
  const pub = async (e: string, expected: number, comparator?: string) => {
    try {
      const pa = await js.publish(sub(e), new TextEncoder().encode("x"), {
        expect: comparator === undefined
          ? { lastSubjectSequence: expected }
          : { lastSubjectSequence: expected, lastSubjectSequenceSubject: comparator },
      });
      return { landed: true as const, seq: pa.seq };
    } catch (err) { return { landed: false as const, code: (err as { code?: unknown }).code }; }
  };
  const cmp = `cotal.${SPACE}.wfjprobe.r.*`;
  const e1 = await pub("e1", 0, cmp);
  const e2 = await pub("e2", e1.landed ? e1.seq : 0, cmp);
  const stale = await pub("e3", e1.landed ? e1.seq : 0, cmp);
  c("a comparator subject fences per-entry subjects run-wide on this broker floor",
    e1.landed && e2.landed && !stale.landed && stale.code === 10071, { e1, e2, stale });
  // And the failure mode. Without the comparator the expectation is evaluated against the publish
  // subject, and the natural expectation for a brand-new entry subject is 0 — which is exactly what
  // a driver would compute from that subject's own (empty) history. It lands unconditionally, however
  // far the run has moved: the fence is simply not there, and nothing about the publish says so.
  const unfenced = await pub("e5", 0);
  c("but WITHOUT the comparator, a per-entry publish at its own subject's head (0) always lands, however far the RUN has moved — a fence that vanishes silently when the second header is missing",
    unfenced.landed, unfenced);
  const stillStale = await pub("e6", e1.landed ? e1.seq : 0, cmp);
  c("while the comparator form refuses that same driver, which is the difference the extra header is carrying",
    !stillStale.landed && stillStale.code === 10071, stillStale);
}

await nc.drain();
done();
console.log(`run-journal.smoke: ${ok} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
