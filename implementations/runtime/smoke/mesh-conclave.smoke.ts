/**
 * `conclave` on the real planes: a scoped sub-team as durable membership rows.
 *
 * The load-bearing property is again RECOVERY BY DERIVATION: the channel derives from the step's
 * own request id, the plan — resolved principals, generations, created-by-us facts — is bound as
 * the entry's external state BEFORE a single row is written, and everything after (the execute,
 * the close, the discharge) acts on the recorded plan rather than on the world's current shape.
 * The suite stages each half: a re-entered open that converges with the members' presence GONE, a
 * re-execute that must not roll a landed row's join cursor forward, a close that releases exactly
 * what the open created (a pre-existing membership on a pinned channel survives), and a cancelled
 * conclave whose release travels the driver's discharge sweep.
 *
 * Members resolve through presence — the seat's own self-published witness, the same source DM
 * name-resolution reads — so the member handles here are literal records over identities whose
 * presence rows the suite writes. The spawn→conclave flow-through over a REAL manager and real
 * seats is bin/smoke's fidelity ride.
 *
 * Run: pnpm smoke:runtime-mesh-conclave   (needs nats-server on PATH)
 */
import { spawn as spawnProc } from "node:child_process";
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
  eptReqStreamName,
  chatSubject,
  presenceBucket,
  openMembersRegistry,
  openChannelRegistry,
  readMember,
  commitMember,
  tombstoneMember,
  writeChannelConfig,
  readChannelConfig,
  replayRunJournal,
  newTakeoverId,
  type EpCaller,
  type MembershipRecord,
  type Presence,
} from "@cotal-ai/core";
import type { JournalEntry } from "@cotal-ai/lang";
import { MeshHandler, EpfSettleWatcher, startRun } from "../src/index.js";
import { pickFreePort } from "./_free-port.js";

const SPACE = "meshconclave";
const EP = "manager";
const HOLDER = { id: "manager", lifecycleUid: "u_meshconclave" };
const CALLER: EpCaller = { owner: "local", actor: "wf_meshconclave", uid: "a".repeat(26) };

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
const sd = mkdtempSync(join(tmpdir(), "cotal-meshconclave-"));
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
// The three registries a conclave touches. The handler OPENS them (a provisioned mesh has them);
// the suite is the provisioner here.
const presenceKv = await new Kvm(nc).create(presenceBucket(SPACE));
const membersKv = await openMembersRegistry(nc, SPACE, { create: true });
const channelsKv = await openChannelRegistry(nc, SPACE, { create: true });

// The timer pump, for the block that races a conclave against a `sleep` (expiries ride the
// mediated timer plane, and no delivery daemon runs here).
await jsm.consumers.add(eptReqStreamName(SPACE), timerWriterConsumerConfig(SPACE, { ackWaitMs: 5_000 }));
const writerC = await js.consumers.get(eptReqStreamName(SPACE), timerWriterDurable(SPACE));
const wctx = await timerWriterContext(nc, SPACE);
const armPending = async (expect = 4): Promise<void> => {
  for await (const m of await writerC.fetch({ max_messages: expect, expires: 1_200 })) {
    await armCheckpointTimer(wctx, { subject: m.subject, headers: m.headers, data: m.data });
    m.ack();
  }
};

// ── the members: identities whose presence rows the suite writes ───────────────────────────────
const uid = (s: string) => s.repeat(26).slice(0, 26);
const seat = (name: string, actor: string, u: string): { name: string; actor: string; uid: string; principal: string; handle: string } =>
  ({ name, actor, uid: u, principal: `local.${actor}`, handle: `${name}#${u}` });
const putPresence = async (s: { name: string; uid: string; principal: string }): Promise<void> => {
  const row: Presence = {
    card: { id: s.principal, name: s.name, kind: "agent" },
    lifecycleUid: s.uid, status: "idle", ts: Date.now(),
  };
  await presenceKv.put(s.principal, JSON.stringify(row));
};
/** A literal member handle, as a program source fragment. */
const handleSrc = (s: { name: string; uid: string }, persona = "dev") =>
  `{ agent: "${s.name}#${s.uid}", persona: "${persona}" }`;

const mk = (runId: string): MeshHandler => new MeshHandler(
  nc, kv, js, jsm,
  { space: SPACE, endpoint: EP, runId, caller: CALLER, instanceId: "i".repeat(26), epoch: 1, holder: HOLDER, defaultCheckpointTimeout: "1h" },
  new EpfSettleWatcher(jsm, SPACE, 3_000),
  () => Date.now(),
);
/** A step context as the interpreter hands it over, with the suite's hand on the cancel signal. */
const stepCtx = (requestId: string, resume?: Record<string, unknown>) => {
  const listeners: ((reason: string) => void)[] = [];
  const signal = {
    cancelled: false, reason: undefined as string | undefined,
    onCancel(fn: (reason: string) => void) { listeners.push(fn); },
  };
  const bound: Record<string, unknown> = {};
  const ctx = {
    key: { scope: [], kind: "conclave", name: "huddle", occurrence: 0 },
    requestId, attempt: 0, signal,
    ...(resume !== undefined ? { resume } : {}),
    bind: async (facts: Record<string, unknown>) => { Object.assign(bound, facts); },
  };
  return {
    ctx: ctx as never,
    bound,
    cancel(reason: string) { signal.cancelled = true; signal.reason = reason; for (const fn of listeners) fn(reason); },
  };
};
const token = (tag: string) => (tag.repeat(43)).slice(0, 43);
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
const derivedChannel = (requestId: string) => `conclave-${createHash("sha256").update(requestId).digest("hex").slice(0, 12)}`;

// ── 1) a driven conclave end to end: rows in, rows out, one entry with the closed fact ─────────
{
  console.log("• 1 — a driven conclave joins, runs, and releases");
  const a = seat("dev-1", "seat1", uid("b"));
  const b = seat("dev-2", "seat2", uid("c"));
  await putPresence(a);
  await putPresence(b);
  const out = await withDeadline(driven({
    space: SPACE, endpoint: EP, kv, runId: "cv-1", lease: lease(),
    source: `const a = ${handleSrc(a)};\nconst b = ${handleSrc(b)};\n`
      + `const r = await conclave([a, b], async (room) => { log("room", room.channel); return 42; }, { name: "huddle" });\nlog("value", r);`,
    handler: mk("cv-1"),
  }), 30_000, "the conclave run");
  c("the run completes", out?.status === "completed", JSON.stringify(out));

  const entries = await journalEntries("cv-1", "conclave");
  const bound = entries.filter((e) => e.state === "pending").at(-1);
  const settled = entries.find((e) => e.state === "settled");
  c("the one conclave entry settles ok with the closed fact TRUE",
    settled?.status === "ok" && settled?.closed === true, { status: settled?.status, closed: settled?.closed });
  c("the body's value rides the scope result",
    (settled?.result as { value?: unknown } | undefined)?.value === 42, JSON.stringify(settled?.result));
  const plan = bound?.external as { channel?: string; registered?: boolean; members?: Array<Record<string, unknown>> } | undefined;
  c("the plan is bound as the entry's external state before a row is written",
    plan !== undefined && plan.registered === true && plan.members?.length === 2
      && plan.members?.every((m) => m.joined === true && m.generation === 1),
    JSON.stringify(plan));
  c("the channel derives from the step's own request id",
    bound?.requestId !== undefined && plan?.channel === derivedChannel(bound.requestId), { channel: plan?.channel });
  c("the plan resolved each member to its presence-published principal",
    plan?.members?.[0]?.principal === a.principal && plan?.members?.[1]?.principal === b.principal,
    JSON.stringify(plan?.members));

  const ch = plan?.channel ?? "";
  const ra = await readMember(membersKv, ch, a.principal, a.uid);
  const rb = await readMember(membersKv, ch, b.principal, b.uid);
  c("both membership rows were committed and then tombstoned by the close",
    ra?.record.leaveCursor !== undefined && rb?.record.leaveCursor !== undefined
      && ra.record.generation === 1 && rb.record.generation === 1,
    { a: ra?.record, b: rb?.record });
  c("each row's join precedes its leave on the chat stream's own sequence",
    ra !== undefined && ra.record.joinCursor <= (ra.record.leaveCursor ?? -1), { join: ra?.record.joinCursor, leave: ra?.record.leaveCursor });
  c("the rows were committed activated: no catch-up is owed from the join cursor forward",
    ra?.record.activated === true && rb?.record.activated === true, { a: ra?.record.activated, b: rb?.record.activated });
  c("the minted channel's registry row is deleted by the close",
    (await readChannelConfig(channelsKv, ch)) === undefined);
}

// ── 2) mid-conclave, at the handler: rows live while the room is open ──────────────────────────
{
  console.log("• 2 — between open and close the membership is live");
  const a = seat("dev-open", "seat3", uid("d"));
  await putPresence(a);
  const handler = mk("cv-2");
  const T = token("b");
  const s = stepCtx(T);
  const room = await withDeadline(
    handler.openConclave({ members: [{ agent: a.handle, persona: "dev" }] }, s.ctx)
      .then((v) => v, (e: unknown) => { console.log("  ! open rejected:", (e as Error)?.message?.slice(0, 120)); return undefined; }),
    20_000, "the open");
  c("the open returns the derived channel handle", room?.channel === derivedChannel(T), room?.channel);
  const live = await readMember(membersKv, room?.channel ?? "", a.principal, a.uid);
  c("the membership row is open, durable-active and activated while the room is",
    live?.record.state === "durable-active" && live.record.leaveCursor === undefined && live.record.activated === true,
    JSON.stringify(live?.record));
  c("the minted channel's registry row exists while the room is open, and names the run",
    (await readChannelConfig(channelsKv, room?.channel ?? ""))?.description?.includes("cv-2") === true);
  await withDeadline(handler.closeConclave({ members: [{ agent: a.handle, persona: "dev" }] }, s.ctx), 20_000, "the close");
  const after = await readMember(membersKv, room?.channel ?? "", a.principal, a.uid);
  c("the close tombstones the row it created", after?.record.leaveCursor !== undefined, JSON.stringify(after?.record));
}

// ── 3) a pinned channel is borrowed, and a pre-existing membership survives the close ──────────
{
  console.log("• 3 — a program-named channel: joined members leave, residents stay");
  const a = seat("dev-res", "seat4", uid("e"));
  const b = seat("dev-vis", "seat5", uid("f"));
  await putPresence(a);
  await putPresence(b);
  await writeChannelConfig(channelsKv, "war-room", { description: "the operators' room" });
  // The resident: durably in the channel before any conclave, at its own generation.
  const resident: MembershipRecord = {
    channel: "war-room", owner: a.principal, lifecycleUid: a.uid, state: "durable-active",
    joinCursor: 0, generation: 3, activated: true, writerIdentity: "suite", updatedAt: Date.now(),
  };
  await commitMember(membersKv, resident);
  const out = await withDeadline(driven({
    space: SPACE, endpoint: EP, kv, runId: "cv-3", lease: lease(),
    source: `const a = ${handleSrc(a)};\nconst b = ${handleSrc(b)};\n`
      + `await conclave([a, b], async (room) => { log("room", room.channel); return null; }, { name: "sync", channel: "war-room" });`,
    handler: mk("cv-3"),
  }), 30_000, "the pinned-channel run");
  c("the run completes on the pinned channel", out?.status === "completed", JSON.stringify(out));
  const bound = (await journalEntries("cv-3", "conclave")).filter((e) => e.state === "pending").at(-1);
  const plan = bound?.external as { registered?: boolean; members?: Array<Record<string, unknown>> } | undefined;
  c("the plan records the channel as borrowed and the resident as not-joined-by-us",
    plan?.registered === false && plan.members?.find((m) => m.agent === a.handle)?.joined === false
      && plan.members?.find((m) => m.agent === b.handle)?.joined === true,
    JSON.stringify(plan));
  const ra = await readMember(membersKv, "war-room", a.principal, a.uid);
  const rb = await readMember(membersKv, "war-room", b.principal, b.uid);
  c("the close left the resident's membership open at its own generation",
    ra?.record.leaveCursor === undefined && ra?.record.generation === 3, JSON.stringify(ra?.record));
  c("and tombstoned exactly the membership the conclave created",
    rb?.record.leaveCursor !== undefined && rb.record.generation === 1, JSON.stringify(rb?.record));
  c("a borrowed channel's registry row is not the conclave's to touch",
    (await readChannelConfig(channelsKv, "war-room"))?.description === "the operators' room");
}

// ── 4) a member that is not present is the effect's own catchable failure ──────────────────────
{
  console.log("• 4 — an absent member is catchable L4002, and the wrong incarnation is absent");
  // The name IS present — under a DIFFERENT incarnation. The handle pins one lifecycle, and a
  // presence row for the name alone must not resolve it: that seat is not the one the run holds.
  const stale = seat("dev-stale", "seat6", uid("g"));
  await putPresence({ ...stale, uid: uid("z") });
  const out = await withDeadline(driven({
    space: SPACE, endpoint: EP, kv, runId: "cv-4", lease: lease(),
    source: `const a = ${handleSrc(stale)};\n`
      + `try {\n  await conclave([a], async (room) => { return 1; }, { name: "huddle" });\n  log("reached", true);\n} catch (e) {\n  log("caught", e.code);\n}`,
    handler: mk("cv-4"),
  }), 30_000, "the absent-member run");
  c("the program catches the failure and the run completes", out?.status === "completed", JSON.stringify(out));
  const settled = (await journalEntries("cv-4", "conclave")).find((e) => e.state === "settled");
  c("the entry settles as the conclave effect's own catchable L4002",
    settled?.status === "failed" && settled?.error?.code === "L4002" && settled?.error?.kind === "conclave",
    JSON.stringify(settled?.error));
  c("a failed resolve bound no plan and wrote no row",
    settled?.external === undefined
      && (await readMember(membersKv, derivedChannel(settled?.requestId ?? ""), stale.principal, stale.uid)) === undefined,
    JSON.stringify(settled?.external));
}

// ── 5) a cancelled conclave does not close itself: the discharge releases the membership ───────
{
  console.log("• 5 — a race-lost conclave is released by the driver's own sweep");
  const a = seat("dev-doomed", "seat7", uid("h"));
  await putPresence(a);
  const drv = driven({
    space: SPACE, endpoint: EP, kv, runId: "cv-5", lease: lease(),
    source: `const a = ${handleSrc(a)};\n`
      + `const r = await race({\n`
      + `  fast: () => sleep("2s", { name: "quick" }),\n`
      + `  room: () => conclave([a], async (room) => { await sleep("30s", { name: "long-park" }); return 1; }, { name: "doomed" }),\n`
      + `}, { name: "decide" });\nlog("winner", r.index);`,
    handler: mk("cv-5"),
  });
  await armPending(2);
  await armPending(1); // sweep a mint that landed after the first fetch window
  const out = await withDeadline(drv, 45_000, "the racing run");
  c("the run completes with the sleep the winner", out?.status === "completed", JSON.stringify(out));
  // The sweep's flip to `issued: true` is a SECOND settled append for the same key — read the
  // last, which is what a replay resolves to.
  const race = (await journalEntries("cv-5", "race")).filter((e) => e.state === "settled").at(-1);
  c("the race records the winner and the discharged cancellation",
    (race?.result as { value?: { index?: string } } | undefined)?.value?.index === "fast"
      && race?.cancel?.losers?.includes("room") === true && race?.cancel?.issued === true,
    JSON.stringify({ result: race?.result, cancel: race?.cancel }));
  const entries = await journalEntries("cv-5", "conclave");
  const bound = entries.filter((e) => e.state === "pending").at(-1);
  const settled = entries.find((e) => e.state === "settled");
  c("the cancelled conclave settles cancelled with the closed fact FALSE",
    settled?.status === "cancelled" && settled?.closed === false, { status: settled?.status, closed: settled?.closed });
  const plan = bound?.external as { channel?: string } | undefined;
  const row = await readMember(membersKv, plan?.channel ?? "", a.principal, a.uid);
  c("the discharge tombstoned the loser's membership row", row?.record.leaveCursor !== undefined, JSON.stringify(row?.record));
  c("and deleted the minted channel's registry row",
    (await readChannelConfig(channelsKv, plan?.channel ?? "")) === undefined);
}

// ── 6) an empty conclave is a room with nobody in it, and it still opens and closes ────────────
{
  console.log("• 6 — conclave([]) performs: a channel, no rows");
  const out = await withDeadline(driven({
    space: SPACE, endpoint: EP, kv, runId: "cv-6", lease: lease(),
    source: `const r = await conclave([], async (room) => { return room.channel; }, { name: "empty" });\nlog("room", r);`,
    handler: mk("cv-6"),
  }), 30_000, "the empty conclave run");
  c("the run completes", out?.status === "completed", JSON.stringify(out));
  const settled = (await journalEntries("cv-6", "conclave")).find((e) => e.state === "settled");
  const value = (settled?.result as { value?: unknown } | undefined)?.value;
  c("the body received the derived channel and the entry closed",
    settled?.closed === true && settled?.requestId !== undefined && value === derivedChannel(settled.requestId),
    { value, closed: settled?.closed });
  c("the minted registry row is gone after the close",
    typeof value === "string" && (await readChannelConfig(channelsKv, value)) === undefined);
}

// ── 7) recovery: the recorded plan is the input, not the world ─────────────────────────────────
{
  console.log("• 7 — a re-entered open converges from the recorded plan alone");
  const a = seat("dev-re", "seat8", uid("j"));
  await putPresence(a);
  const T = token("c");
  const req = { members: [{ agent: a.handle, persona: "dev" }] };

  // (a) first entry: plan bound, row committed.
  const h1 = mk("cv-7");
  const s1 = stepCtx(T);
  const room = await withDeadline(h1.openConclave(req, s1.ctx).then((v) => v, (e: unknown) => { console.log("  ! open rejected:", (e as Error)?.message?.slice(0, 120)); return undefined; }), 20_000, "the first open");
  const ch = room?.channel ?? "";
  const first = await readMember(membersKv, ch, a.principal, a.uid);
  c("the first open committed the row", first?.record.leaveCursor === undefined, JSON.stringify(first?.record));

  // (b) the world moves — chat traffic advances the frontier — and the process "crashes". A fresh
  // handler re-enters with the recorded plan; the landed row's join cursor must not roll forward:
  // the member was mid-conversation, and a moved cursor erases its eligibility for that window.
  for (let i = 0; i < 3; i += 1) {
    await js.publish(chatSubject(SPACE, "local", "seat8", "general"), JSON.stringify({ i }));
  }
  // The member is GONE from presence: recovery must not need it — the plan is the recorded truth.
  await presenceKv.delete(a.principal);
  const h2 = mk("cv-7");
  const s2 = stepCtx(T, { ...s1.bound });
  const again = await withDeadline(h2.openConclave(req, s2.ctx).then((v) => v, (e: unknown) => { console.log("  ! re-open rejected:", (e as Error)?.message?.slice(0, 120)); return undefined; }), 20_000, "the re-entered open");
  c("the re-entered open returns the same channel with the member's presence gone",
    again?.channel === ch, { again: again?.channel, ch });
  const after = await readMember(membersKv, ch, a.principal, a.uid);
  c("the landed row is untouched: same join cursor, same generation",
    after?.record.joinCursor === first?.record.joinCursor && after?.record.generation === first?.record.generation,
    { before: first?.record, after: after?.record });

  // (c) the close on the re-entered handler releases; (d) a second close is a no-op.
  await withDeadline(h2.closeConclave(req, s2.ctx), 20_000, "the close");
  const closed = await readMember(membersKv, ch, a.principal, a.uid);
  c("the re-entered handler's close tombstones the row", closed?.record.leaveCursor !== undefined, JSON.stringify(closed?.record));
  const h3 = mk("cv-7");
  const s3 = stepCtx(T, { ...s1.bound });
  const reclose = await withDeadline(
    h3.closeConclave(req, s3.ctx).then(() => null, (e: unknown) => e as Error), 20_000, "the re-close");
  const still = await readMember(membersKv, ch, a.principal, a.uid);
  c("a retried close converges: no error, the leave cursor unmoved",
    reclose === null && still?.record.leaveCursor === closed?.record.leaveCursor,
    { err: reclose?.message?.slice(0, 90), leave: still?.record.leaveCursor });
}

// ── 8) a member's own newer membership is not the conclave's to evict ──────────────────────────
{
  console.log("• 8 — an independent rejoin at a newer generation survives the close");
  const a = seat("dev-rejoin", "seat9", uid("k"));
  await putPresence(a);
  const T = token("d");
  const req = { members: [{ agent: a.handle, persona: "dev" }] };
  const handler = mk("cv-8");
  const s = stepCtx(T);
  const room = await withDeadline(handler.openConclave(req, s.ctx).then((v) => v, (e: unknown) => { console.log("  ! open rejected:", (e as Error)?.message?.slice(0, 120)); return undefined; }), 20_000, "the open");
  const ch = room?.channel ?? "";
  // The member leaves and rejoins ON ITS OWN while the room is open: a NEWER generation.
  await tombstoneMember(membersKv, ch, a.principal, a.uid, 999, "the-member", 1);
  await commitMember(membersKv, {
    channel: ch, owner: a.principal, lifecycleUid: a.uid, state: "durable-active",
    joinCursor: 1000, generation: 2, activated: true, writerIdentity: "the-member", updatedAt: Date.now(),
  });
  const err = await withDeadline(
    handler.closeConclave(req, s.ctx).then(() => null, (e: unknown) => e as Error), 20_000, "the close");
  const after = await readMember(membersKv, ch, a.principal, a.uid);
  c("the close tolerates the stale-write verdict rather than failing the scope",
    err === null, err?.message?.slice(0, 120));
  c("and the member's newer membership is still open",
    after?.record.generation === 2 && after.record.leaveCursor === undefined, JSON.stringify(after?.record));
}

// ── 9) a wildcard pinned channel is refused loudly, before anything is written ─────────────────
{
  console.log("• 9 — a wildcard channel is a program defect, named");
  const out = await withDeadline(driven({
    space: SPACE, endpoint: EP, kv, runId: "cv-9", lease: lease(),
    source: `await conclave([], async (room) => { return 1; }, { name: "wild", channel: "war.>" });`,
    handler: mk("cv-9"),
  }), 30_000, "the wildcard run");
  c("the run fails rather than joining anything", out?.status === "threw", JSON.stringify(out)?.slice(0, 160));
  const settled = (await journalEntries("cv-9", "conclave")).find((e) => e.state === "settled");
  c("the entry records the handler fault naming the channel",
    settled?.status === "failed" && settled?.error?.code === "L4000" && settled?.error?.message?.includes("war.>") === true,
    JSON.stringify(settled?.error)?.slice(0, 160));
}

console.log(`mesh-conclave.smoke: ${ok} passed, ${fail} failed`);
await nc.close();
done();
process.exit(fail === 0 ? 0 : 1);
