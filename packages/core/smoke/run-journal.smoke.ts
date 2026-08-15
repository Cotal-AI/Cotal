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
  ActivationRaced,
  parseRunJournalRecord,
  type RunJournalActivation,
} from "../src/index.js";
import { pickFreePort } from "./_free-port.js";

const SPACE = "wfjrun";
const PORT = await pickFreePort();
const sd = mkdtempSync(join(tmpdir(), "cotal-wfj-"));
const broker = spawn("nats-server", ["-js", "-sd", sd, "-p", String(PORT), "-a", "127.0.0.1"], { stdio: "ignore" });
const servers = `nats://127.0.0.1:${PORT}`;

let ok = 0, fail = 0;
const c = (n: string, v: boolean, extra?: unknown) => { if (v) { ok++; } else { fail++; console.log("  ✗ FAIL:", n, extra ?? ""); } };

process.on("exit", (code) => {
  try { broker.kill(); } catch { /* already gone */ }
  rmSync(sd, { recursive: true, force: true });
  console.log(`run-journal.smoke: ${ok} checks passed, ${fail} failed`);
  if (code === 0 && fail > 0) process.exitCode = 1;
});

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
let up = false;
for (let i = 0; i < 60 && !up; i += 1) { up = await isReachable(servers); if (!up) await wait(100); }
if (!up) throw new Error(`nats-server did not come up on ${PORT}`);
const nc = await connect({ servers });
const jsm = await jetstreamManager(nc);
const js = jetstream(nc);
await createEndpointStreams(jsm, new Kvm(nc), SPACE);
const STREAM = wfjStreamName(SPACE);

const takeover = (runId: string, holder: string, epoch: number) => ({
  space: SPACE, runId, holder, fencingToken: `t-${holder}-${epoch}`, epoch, at: 1_700_000_000_000,
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
const step = (run: string, n: number) => ({ v: 1, kind: "step", run, at: n, entry: { n } });

// ── 1) a first activation on an empty run ─────────────────────────────────────────────────────
{
  const a = await activateRun(js, jsm, takeover("r-1", "d1", 1));
  c("a first activation claims a run that has never been appended to", a.lastSeq > 0, a.lastSeq);
  c("and it replayed nothing, because there was nothing", a.replayed.length === 0);
  await a.append({ step: "one" }, 1);
  await a.append({ step: "two" }, 2);
  const { records, lastSeq } = await replayRunJournal(js, jsm, SPACE, "r-1");
  c("the journal reads back as activation-then-steps, in order",
    records.map((r) => r.record.kind).join(",") === "activation,step,step", records.map((r) => r.record.kind));
  c("and the replay's last delivered sequence IS the subject head the next activation must expect",
    lastSeq === records[records.length - 1]!.seq && lastSeq === a.lastSeq, `${lastSeq} vs ${a.lastSeq}`);
  const act = records[0]!.record as RunJournalActivation;
  c("the activation records who took over, under which lease token and epoch",
    act.holder === "d1" && act.fencingToken === "t-d1-1" && act.epoch === 1, act);
}

// ── 2) THE HANDOFF, ordering A: the activation wins ───────────────────────────────────────────
{
  const first = await activateRun(js, jsm, takeover("r-2", "d1", 1));
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
  const after = await replayRunJournal(js, jsm, SPACE, "r-2");
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
  const first = await activateRun(js, jsm, takeover("r-3", "d1", 1));
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
  const head = (await replayRunJournal(js, jsm, SPACE, "r-3")).lastSeq;
  const late = await rawAppend("r-3", head, step("r-3", 99));
  c("the predecessor's delayed packet lands first, taking the sequence the successor read", late.landed, late);
  const stale = await rawAppend("r-3", head, {
    v: 1, kind: "activation", run: "r-3", holder: "d3", fencingToken: "t-d3-3", epoch: 3, replayedTo: head, at: 1,
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
      onReplayed: async (r) => { await rawAppend("r-3", r.lastSeq, step("r-3", 100)); },
    });
  } catch (e) { outcome = e; }
  c("a takeover whose prefix goes stale between replay and claim reports a RACED activation",
    outcome instanceof ActivationRaced, String(outcome).slice(0, 90));
  c("and never a supersession: a driver that has not activated has driven nothing to be superseded out of",
    !(outcome instanceof RunSuperseded));

  // And it is recoverable, which is the entire reason the two failures are different types: the
  // interference fires once, so the second round replays the moved journal and claims it.
  let interfered = false;
  const fourth = await activateRun(js, jsm, takeover("r-3", "d5", 5), {
    attempts: 3,
    onReplayed: async (r) => {
      if (interfered) return;
      interfered = true;
      await rawAppend("r-3", r.lastSeq, step("r-3", 101));
    },
  });
  c("a losing activation retries and wins on the next round, with the interloper's entry now in its prefix",
    fourth.replayed.some((r) => r.record.kind === "step" && JSON.stringify((r.record as { entry: unknown }).entry) === '{"n":101}'),
    fourth.replayed.length);
}

// ── 4) two branches of one scope append at once ───────────────────────────────────────────────
//
// The shape that made the first draft of this barrier wrong. Concurrency scopes append from several
// branches simultaneously; two publishes carrying one expectation cannot both land, so an appender
// that let callers hold the head would have a driver declaring ITSELF superseded while it was the
// only writer in the world.
{
  const a = await activateRun(js, jsm, takeover("r-4", "d1", 1));
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
  const back = await replayRunJournal(js, jsm, SPACE, "r-4");
  c("and all four are in the journal", back.records.filter((r) => r.record.kind === "step").length === 4);
  c("with the head where the last PubAck left it", back.lastSeq === a.lastSeq, `${back.lastSeq} vs ${a.lastSeq}`);
}

// ── 5) a refusal poisons the pump: nothing queued behind it reaches the wire ──────────────────
{
  const a = await activateRun(js, jsm, takeover("r-5", "d1", 1));
  await activateRun(js, jsm, takeover("r-5", "d2", 2)); // a takes over from a, so `a` is stale
  const results = await Promise.allSettled([a.append({ n: 1 }, 1), a.append({ n: 2 }, 2), a.append({ n: 3 }, 3)]);
  c("every queued append behind a refusal fails", results.every((r) => r.status === "rejected"),
    results.map((r) => r.status));
  c("with the same terminal supersession, not three different opinions",
    results.every((r) => r.status === "rejected" && r.reason instanceof RunSuperseded));
  const back = await replayRunJournal(js, jsm, SPACE, "r-5");
  c("and NONE of them is in the journal: a queued entry retried at the new head is the very write the barrier forbids",
    back.records.filter((r) => r.record.kind === "step").length === 0,
    back.records.map((r) => r.record.kind));
}

// ── 6) runs do not fence each other ───────────────────────────────────────────────────────────
{
  const x = await activateRun(js, jsm, takeover("r-6a", "d1", 1));
  const y = await activateRun(js, jsm, takeover("r-6b", "d1", 1));
  await y.append({ other: true }, 1);
  await y.append({ other: true }, 2);
  const seq = await x.append({ mine: true }, 3);
  c("a run's fence is its own subject: another run's appends do not invalidate it", seq > 0);
  c("and each run reads back only its own records",
    (await replayRunJournal(js, jsm, SPACE, "r-6a")).records.length === 2
    && (await replayRunJournal(js, jsm, SPACE, "r-6b")).records.length === 3);
}

// ── 7) the head cannot come from STREAM.INFO, which is why it comes from the replay ───────────
//
// The plan once said the driver would read the run subject's current sequence from `STREAM.INFO`.
// It cannot: `last_seq` is stream-WIDE and `subjects_filter` returns per-subject message COUNTS.
// This is the measurement, kept executable, because the wrong version of it is entirely plausible.
{
  const a = await activateRun(js, jsm, takeover("r-7", "d1", 1));
  await a.append({ n: 1 }, 1);
  const other = await activateRun(js, jsm, takeover("r-7b", "d1", 1));
  await other.append({ n: 1 }, 1); // moves the STREAM, not this run's subject
  const info = await jsm.streams.info(STREAM, { subjects_filter: wfjSubject(SPACE, "r-7") });
  c("STREAM.INFO's last_seq is stream-wide, so it over-reads this run's head",
    info.state.last_seq > a.lastSeq, `${info.state.last_seq} vs ${a.lastSeq}`);
  c("and its subjects_filter answers with a COUNT, which is not a sequence",
    (info.state.subjects ?? {})[wfjSubject(SPACE, "r-7")] === 2, info.state.subjects);
  const wrong = await rawAppend("r-7", info.state.last_seq, step("r-7", 1));
  c("publishing at the INFO-derived sequence is refused: it was never this subject's head",
    !wrong.landed && wrong.code === 10071, wrong);
  c("while the replay's last delivered sequence is accepted",
    (await rawAppend("r-7", (await replayRunJournal(js, jsm, SPACE, "r-7")).lastSeq, step("r-7", 2))).landed);
}

// ── 8) every takeover replays from the TOP ────────────────────────────────────────────────────
//
// The replay durable is deleted and recreated for exactly this reason: a durable remembers how far
// it delivered, so a reused one would hand the second takeover an empty tail — a resume that
// believes the run has no history and re-performs every effect it already performed.
{
  const a = await activateRun(js, jsm, takeover("r-8", "d1", 1));
  await a.append({ n: 1 }, 1);
  const first = (await replayRunJournal(js, jsm, SPACE, "r-8")).records.length;
  const second = (await replayRunJournal(js, jsm, SPACE, "r-8")).records.length;
  c("a second replay of the same run returns the same prefix, not the tail after the first",
    first === second && first === 2, `${first} then ${second}`);
}

// ── 9) the envelope is validated, and the step's payload is not ───────────────────────────────
{
  c("a record with an unknown kind is refused rather than replayed as a step",
    (() => { try { parseRunJournalRecord({ v: 1, kind: "note", run: "r", at: 0 }, "s"); return false; } catch { return true; } })());
  c("a step whose entry is an arbitrary shape is accepted: the language owns what a step means",
    parseRunJournalRecord({ v: 1, kind: "step", run: "r", at: 0, entry: { anything: [1, 2] } }, "s").kind === "step");
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
