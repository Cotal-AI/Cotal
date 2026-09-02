/**
 * `monitor` + `wait(down)` on the real planes: the liveness pair over presence.
 *
 * The load-bearing property is that DOWN IS A STATE, NOT A MESSAGE. The handle pins one
 * incarnation (`<name>#<lifecycleUid>`), the mesh's liveness witness is the presence row that
 * incarnation heartbeats, and a lifecycle uid never heartbeats again once its row is gone — so a
 * death is re-observable at any later time, nothing needs to bind, and a resumed run's
 * `wait(down)` observes a death that happened while its host was down by simply looking. That is
 * also why `monitor` performs no wire work: the registration IS the journal entry, and the wait
 * reads the same fact whenever it is asked.
 *
 * The suite stages each half of the contract: the design's rescue idiom driven end to end (race
 * work against `wait(down)`, kill the seat, the died branch wins), the immediate down of an
 * already-dead incarnation, the two reasons (`lapsed` vs `superseded`) split by what the name
 * shows now, the timeout resolving null on the recorded absolute deadline, a re-entrant call
 * attaching to that deadline rather than restarting it, and cancellation claiming the armed
 * pause. Presence rows are the suite's to write and delete — the seat-real flow-through over a
 * live manager is bin/smoke's fidelity ride.
 *
 * Run: pnpm smoke:runtime-mesh-monitor   (needs nats-server on PATH)
 */
import { spawn as spawnProc } from "node:child_process";
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
  eptReqStreamName,
  presenceBucket,
  readCheckpointSettle,
  replayRunJournal,
  newTakeoverId,
  type EpCaller,
  type Presence,
} from "@cotal-ai/core";
import type { JournalEntry } from "@cotal-ai/lang";
import { MeshHandler, EpfSettleWatcher, startRun } from "../src/index.js";
import { pickFreePort } from "./_free-port.js";

const SPACE = "meshmonitor";
const EP = "manager";
const HOLDER = { id: "manager", lifecycleUid: "u_meshmonitor" };
const CALLER: EpCaller = { owner: "local", actor: "wf_meshmonitor", uid: "a".repeat(26) };

let ok = 0, fail = 0;
const c = (n: string, v: boolean, extra?: unknown) => { if (v) { ok++; } else { fail++; console.log("  ✗ FAIL:", n, extra ?? ""); } };
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
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

// ── broker + planes ────────────────────────────────────────────────────────────────────────────
const PORT = await pickFreePort();
const sd = mkdtempSync(join(tmpdir(), "cotal-meshmonitor-"));
const broker = spawnProc("nats-server", ["-js", "-sd", sd, "-p", String(PORT), "-a", "127.0.0.1"], { stdio: "ignore" });
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
// The one registry the pair reads. The handler OPENS it (a provisioned mesh has it); the suite is
// the provisioner here, and the seats' rows are the suite's to write and delete.
const presenceKv = await new Kvm(nc).create(presenceBucket(SPACE));

// The timer pump: down-wait timeouts ride the mediated timer plane, and no delivery daemon runs
// here. Drain WIDE before a block that needs its own arm — every earlier armed pause queued a
// schedule request the writer has not consumed.
await jsm.consumers.add(eptReqStreamName(SPACE), timerWriterConsumerConfig(SPACE, { ackWaitMs: 5_000 }));
const writerC = await js.consumers.get(eptReqStreamName(SPACE), timerWriterDurable(SPACE));
const wctx = await timerWriterContext(nc, SPACE);
const armPending = async (expect = 4): Promise<void> => {
  for await (const m of await writerC.fetch({ max_messages: expect, expires: 1_200 })) {
    await armCheckpointTimer(wctx, { subject: m.subject, headers: m.headers, data: m.data });
    m.ack();
  }
};

// ── the seats: identities whose presence rows the suite writes ─────────────────────────────────
const uid = (s: string) => s.repeat(26).slice(0, 26);
const seat = (name: string, actor: string, u: string): { name: string; uid: string; principal: string; handle: string } =>
  ({ name, uid: u, principal: `local.${actor}`, handle: `${name}#${u}` });
const putPresence = async (s: { name: string; uid: string; principal: string }): Promise<void> => {
  const row: Presence = {
    card: { id: s.principal, name: s.name, kind: "agent" },
    lifecycleUid: s.uid, status: "idle", ts: Date.now(),
  };
  await presenceKv.put(s.principal, JSON.stringify(row));
};
/** A literal agent handle, as a program source fragment. */
const handleSrc = (s: { name: string; uid: string }, persona = "dev") =>
  `{ agent: "${s.name}#${s.uid}", persona: "${persona}" }`;

const mk = (runId: string): MeshHandler => new MeshHandler(
  nc, kv, js, jsm,
  { space: SPACE, endpoint: EP, runId, caller: CALLER, instanceId: "i".repeat(26), epoch: 1, holder: HOLDER, defaultCheckpointTimeout: "1h" },
  new EpfSettleWatcher(js, jsm, SPACE, 3_000),
  () => Date.now(),
);
/** A step context as the interpreter hands it over, with the suite's hand on the cancel signal. */
const stepCtx = (requestId: string) => {
  const listeners: ((reason: string) => void)[] = [];
  const signal = {
    cancelled: false, reason: undefined as string | undefined,
    onCancel(fn: (reason: string) => void) { listeners.push(fn); },
  };
  const ctx = {
    key: { scope: [], kind: "wait", name: "vigil", occurrence: 0 },
    requestId, attempt: 0, signal,
    bind: async () => { /* a down-wait binds nothing; a bind here would be a defect */ },
  };
  return {
    ctx: ctx as never,
    cancel(reason: string) { signal.cancelled = true; signal.reason = reason; for (const fn of listeners) fn(reason); },
  };
};
const token = (tag: string) => (tag.repeat(43)).slice(0, 43);
/** A direct handler call graded rather than fatal: a mutant that makes a wait REJECT must red
 *  cells, never kill the process before the suite's own exit line (the bare-call trap). */
const safe = (p: Promise<unknown>): Promise<unknown> =>
  p.catch((e: unknown) => ({ threw: `${(e as Error)?.name}: ${(e as Error)?.message?.slice(0, 120)}` }));
const lease = (() => { let n = 0; return () => ({ holder: "m1", epoch: 1, fencingToken: (n += 1), takeoverId: newTakeoverId() }); })();
/** A drive that FAILS as a graded cell rather than a process kill (the bare-call trap). */
const driven = (args: Parameters<typeof startRun>[2]) =>
  startRun(js, jsm, args).catch((e: unknown) => ({ status: "threw" as const, error: `${(e as Error)?.name}: ${(e as Error)?.message?.slice(0, 140)}` }));

/** The run's journal entries of one kind, in append order (pending first, settled after). */
const journalEntries = async (runId: string, kind: string): Promise<JournalEntry[]> => {
  const back = await replayRunJournal(js, jsm, SPACE, runId, newTakeoverId());
  return back.records
    .map((r) => r.record)
    .filter((r) => r.kind === "step")
    .map((r) => (r as { entry: unknown }).entry as JournalEntry)
    .filter((e) => e.kind === kind);
};
/** Poll until the run's journal shows a PENDING entry of this kind — the park the block acts on. */
const pendingEntry = async (runId: string, kind: string, ms = 15_000): Promise<JournalEntry | undefined> => {
  const until = Date.now() + ms;
  for (;;) {
    const found = (await journalEntries(runId, kind)).find((e) => e.state === "pending");
    if (found !== undefined) return found;
    if (Date.now() > until) return undefined;
    await wait(300);
  }
};

// ── 1) the rescue idiom, driven end to end: monitor, race work against the death, seat dies ────
{
  console.log("• 1 — the §5.9 rescue idiom: the died branch wins when the seat's presence lapses");
  const a = seat("builder", "seat1", uid("b"));
  await putPresence(a);
  const drv = driven({
    space: SPACE, endpoint: EP, kv, runId: "mo-1", lease: lease(),
    source: `const d = ${handleSrc(a)};\n`
      + `await monitor(d, { name: "watch" });\n`
      + `const r = await race({\n`
      + `  died: () => wait(down(d), { name: "died" }),\n`
      + `  work: () => sleep("2m", { name: "work" }),\n`
      + `}, { name: "scope" });\nlog("outcome", r.index);`,
    handler: mk("mo-1"),
  });
  // The park first, then the death: deleting the row before the wait begins would prove only the
  // immediate-down path, which block 2 owns.
  const parked = await pendingEntry("mo-1", "wait");
  c("the run parks on the down-wait while the seat is alive", parked !== undefined);
  await presenceKv.delete(a.principal);
  const out = await withDeadline(drv, 30_000, "the rescue run");
  c("the run completes", out?.status === "completed", JSON.stringify(out));

  const race = (await journalEntries("mo-1", "race")).filter((e) => e.state === "settled").at(-1);
  c("the died branch wins the race",
    (race?.result as { value?: { index?: string } } | undefined)?.value?.index === "died"
      && race?.cancel?.losers?.includes("work") === true,
    JSON.stringify({ result: race?.result, cancel: race?.cancel }));
  const settledWait = (await journalEntries("mo-1", "wait")).find((e) => e.state === "settled");
  const down = settledWait?.result as { agent?: string; reason?: string; at?: number } | undefined;
  c("the down value names the monitored handle", down?.agent === a.handle, JSON.stringify(down));
  c("the reason is lapsed: nothing live holds the name any more", down?.reason === "lapsed", down?.reason);
  c("the at is the observation clock, not an invented time of death",
    typeof down?.at === "number" && down.at > 0, down?.at);
  const mon = (await journalEntries("mo-1", "monitor")).find((e) => e.state === "settled");
  c("monitor settled ok with a null result: the registration is the journal entry",
    mon?.status === "ok" && mon?.result === null, JSON.stringify({ status: mon?.status, result: mon?.result }));
  const work = (await journalEntries("mo-1", "sleep")).filter((e) => e.state === "settled").at(-1);
  c("the losing work branch is cancelled by the scope", work?.status === "cancelled", work?.status);
}

// ── 2) an incarnation that is ALREADY dead resolves at the first look ──────────────────────────
{
  console.log("• 2 — the immediate down: no presence row was ever there");
  const ghost = seat("ghost", "seat2", uid("c"));
  const h = mk("mo-2");
  const T = token("d");
  const s = stepCtx(T);
  const got = await withDeadline(
    safe(h.wait({ event: { event: "down", agent: ghost.handle }, timeout: "1h" } as never, s.ctx) as Promise<unknown>),
    8_000, "the immediate down-wait",
  ) as { agent?: string; reason?: string } | undefined;
  c("an already-dead incarnation resolves without waiting for anything",
    got?.agent === ghost.handle && got?.reason === "lapsed", JSON.stringify(got));
  const settle = await readCheckpointSettle(jsm, SPACE, { endpoint: EP, token: T });
  c("the down claims its armed timeout: the pause is settled, so no timer fires into the run",
    settle !== undefined, settle?.settle);
}

// ── 3) the two reasons: a live successor under the name is `superseded` ────────────────────────
{
  console.log("• 3 — superseded: the name lives on under a different incarnation");
  const dead = seat("alias", "seat3a", uid("e"));
  const successor = seat("alias", "seat3b", uid("f"));
  await putPresence(successor);
  const h = mk("mo-3");
  const got = await withDeadline(
    safe(h.wait({ event: { event: "down", agent: dead.handle } } as never, stepCtx(token("e")).ctx) as Promise<unknown>),
    8_000, "the superseded down-wait",
  ) as { reason?: string } | undefined;
  c("a live successor under the name reads as superseded: this incarnation is dead",
    got?.reason === "superseded", JSON.stringify(got));
}

// ── 4) a live incarnation is NOT down: the wait runs to its deadline and resolves null ─────────
{
  console.log("• 4 — the timeout: alive means null on the recorded absolute deadline");
  const alive = seat("steady", "seat4", uid("g"));
  await putPresence(alive);
  const h = mk("mo-4");
  const T = token("f");
  const p = safe(h.wait({ event: { event: "down", agent: alive.handle }, timeout: "2s" } as never, stepCtx(T).ctx) as Promise<unknown>);
  await wait(400);           // the mint's schedule request must be queued before the pump looks
  await armPending(10);      // the backlog first: earlier blocks' pauses each queued a request
  await armPending(2);
  const got = await withDeadline(p, 20_000, "the timed-out down-wait");
  c("a live incarnation is not down: the wait resolves null on its timeout, never a throw",
    got === null, JSON.stringify(got));
  const settle = await readCheckpointSettle(jsm, SPACE, { endpoint: EP, token: T });
  c("the timeout pause settled expired on the plane", settle?.settle === "expired", settle?.settle);
}

// ── 5) a re-entrant call ATTACHES to the recorded deadline instead of restarting the clock ─────
{
  console.log("• 5 — resume: the deadline is absolute, the re-entry attaches");
  const alive = seat("patient", "seat5", uid("h"));
  await putPresence(alive);
  const T = token("g");
  const first = safe(mk("mo-5").wait(
    { event: { event: "down", agent: alive.handle }, timeout: "4s" } as never, stepCtx(T).ctx,
  ) as Promise<unknown>);
  await wait(400);
  await armPending(4);
  // The "crash": one second into the pause a second handler re-enters under the SAME request id —
  // which is all a resume is here, because a down-wait binds nothing.
  await wait(1_000);
  const t0 = Date.now();
  const second = safe(mk("mo-5").wait(
    { event: { event: "down", agent: alive.handle }, timeout: "4s" } as never, stepCtx(T).ctx,
  ) as Promise<unknown>);
  await armPending(2); // an attach re-emits no second schedule, but an idempotent re-mint may
  const got = await withDeadline(second, 20_000, "the re-entrant down-wait");
  const elapsed = Date.now() - t0;
  c("a re-entered down-wait attaches to the recorded pause rather than re-minting", got === null, JSON.stringify(got));
  c("the deadline is absolute: the re-entry resolves on the ORIGINAL clock",
    elapsed < 3_600, `${elapsed}ms from re-entry (a restarted clock would take ~4000ms)`);
  await withDeadline(first, 20_000, "the first down-wait, sharing the settle");
}

// ── 6) cancellation claims the armed timeout ───────────────────────────────────────────────────
{
  console.log("• 6 — a cancelled down-wait ends its own timer");
  const alive = seat("bystander", "seat6", uid("j"));
  await putPresence(alive);
  const T = token("h");
  const s = stepCtx(T);
  const h = mk("mo-6");
  const p = (h.wait({ event: { event: "down", agent: alive.handle }, timeout: "1h" } as never, s.ctx) as Promise<unknown>)
    .then((v) => ({ v }), (e: unknown) => ({ e: e as Error }));
  await wait(400);
  await armPending(4);
  s.cancel("raced out");
  const got = await withDeadline(p, 15_000, "the cancelled down-wait");
  c("a cancelled down-wait throws Cancelled, not a value",
    got !== undefined && "e" in got && got.e?.name === "Cancelled", JSON.stringify(got));
  const settle = await readCheckpointSettle(jsm, SPACE, { endpoint: EP, token: T });
  c("its armed timeout is claimed: the pause is settled, so no timer fires into a run that moved on",
    settle !== undefined, settle?.settle);
}

// ── 7) the registration's own contract: handles refuse loudly, a dead agent registers fine ─────
{
  console.log("• 7 — monitor: loud on a non-handle, quiet on a dead agent");
  const h = mk("mo-7");
  const bad = await h.monitor(
    { agent: { agent: "not-a-handle", persona: "dev" } } as never,
    stepCtx(token("j")).ctx,
  ).then(() => null, (e: unknown) => e as Error);
  c("monitor of a value that is not an agent handle refuses loudly, naming the form",
    bad !== null && bad.message.includes("not an agent handle"),
    bad?.message?.slice(0, 120));
  const deadOk = await h.monitor(
    { agent: { agent: `long-gone#${uid("k")}`, persona: "dev" } } as never,
    stepCtx(token("k")).ctx,
  ).then((v) => v, (e: unknown) => e as Error);
  c("monitor of a dead agent registers rather than failing: the death is the wait's to observe",
    deadOk === null, JSON.stringify(deadOk));
  const badWait = await (h.wait(
    { event: { event: "down", agent: "also-not-a-handle" } } as never,
    stepCtx(token("l")).ctx,
  ) as Promise<unknown>).then(() => null, (e: unknown) => e as Error);
  c("wait(down) on a value that is not an agent handle refuses the same way",
    badWait !== null && (badWait as Error).message.includes("not an agent handle"),
    (badWait as Error)?.message?.slice(0, 120));
}

// ── 8) the driven timeout: null crosses the boundary and `??` is otherwise ─────────────────────
{
  console.log("• 8 — a driven program rides the timeout to its ?? recovery");
  const alive = seat("watched", "seat8", uid("m"));
  await putPresence(alive);
  const drv = driven({
    space: SPACE, endpoint: EP, kv, runId: "mo-8", lease: lease(),
    source: `const d = ${handleSrc(alive)};\n`
      + `await monitor(d, { name: "watch" });\n`
      + `const v = await wait(down(d), { name: "vigil", timeout: "2s" }) ?? { reason: "still-up" };\n`
      + `log("reason", v.reason);`,
    handler: mk("mo-8"),
  });
  const parked = await pendingEntry("mo-8", "wait");
  c("the driven run parks on its down-wait", parked !== undefined);
  await armPending(4);
  await armPending(2);
  const out = await withDeadline(drv, 30_000, "the driven timeout run");
  c("the run completes through the ?? recovery", out?.status === "completed", JSON.stringify(out));
  const settled = (await journalEntries("mo-8", "wait")).find((e) => e.state === "settled");
  c("the wait entry settles ok with the recorded null",
    settled?.status === "ok" && settled?.result === null,
    JSON.stringify({ status: settled?.status, result: settled?.result }));
}

console.log(`mesh-monitor.smoke: ${ok} passed, ${fail} failed`);
done();
process.exit(fail === 0 ? 0 : 1);
