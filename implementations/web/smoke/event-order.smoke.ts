/**
 * The shape-B bootstrap: what this surface does when the live tap is delivering frames before the
 * backfill it should follow has arrived.
 *
 * WHY THIS SUITE IS THE ONLY PLACE GAP DETECTION MAY BE CLAIMED FROM. The claim "the dashboard can
 * tell that a frame is missing" is a claim about ORDER, and every part of the machinery that could
 * make it true is in `event-order.js`. Until these cells run, nothing in this tree is entitled to say
 * a gap would be noticed, and the build order this lane follows says so explicitly.
 *
 * WHAT IT DRIVES. `event-order.js` is READ OFF DISK and evaluated in a `vm` context with a stub
 * `window`, exactly as the classic `<script>` runs in the page, and the route table it is served
 * through is the REAL `PAGE` export. Nothing is restated here, so no cell can pass against a version
 * that no longer ships.
 *
 * THE SHAPE OF THE RACE, since it decides every assertion below. The transport arms its watermark,
 * goes live, and only then surfaces retained history (`SPEC.md` orders the join that way, and the
 * page follows it: `connect()` opens the feed and its `open` handler calls `refresh()`). So the FIRST
 * frame the page sees can be a live one that belongs AFTER frames it has not received yet. Two
 * consequences are asserted repeatedly and in both directions:
 *
 *   · the baseline is the settled history batch's MINIMUM, never the first frame observed
 *   · gap checking is not armed until the batch settles
 *
 * A first-arrival baseline is not merely different, it is wrong in a specific measurable way, so
 * §5 asserts what it WOULD have produced rather than only what the machine does produce. A cell that
 * says "no gap was reported" is worthless without a sibling proving this suite can see a gap at all,
 * so every negative here has a positive control beside it.
 *
 * WHAT IT DOES NOT CLAIM. No DOM, no browser, no `MD.render`. It measures the machine and its seam,
 * not the pixels. It also does not claim the RETAINED arm is reachable from the dashboard's current
 * UI: with event channels filtered out of `/api/channels`, the sidebar offers no event channel to
 * select, so the retained-minimum path is reached today by `/api/channels/<name>/history` for a
 * caller that names one, and by these cells. That gap is stated, not implied.
 *
 * Run: pnpm smoke:event-order
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createContext, runInContext } from "node:vm";
import ts from "typescript";
import { PAGE } from "../src/web.js";

const here = dirname(fileURLToPath(import.meta.url));
const webSrc = join(here, "..", "src", "web");

let cells = 0;
let failed = 0;
const ok = (name: string, cond: boolean, detail?: unknown) => {
  cells++;
  if (cond) return;
  failed++;
  console.log(`  x FAIL  ${name}${detail === undefined ? "" : `: ${JSON.stringify(detail)}`}`);
};

const KIND = "ag-ui.frame";

type Note = { type: string; key?: string; baseline?: number; expected?: number; got?: number; missing?: number };
type Result = { emit: unknown[]; held?: boolean; notes: Note[] };
interface Order {
  live(entry: unknown): Result;
  backfill(batch: unknown): Result;
  readonly settled: boolean;
  readonly pendingCount: number;
  state(key: string): { baseline?: number; next?: number; prefixIncomplete: boolean; faulted: boolean } | undefined;
  readonly chainKeys: string[];
}
interface Api {
  KIND: string;
  FIRST_SEQ: number;
  frameOf(entry: unknown): unknown;
  chainKey(entry: unknown, frame: unknown): string;
  create(): Order;
}

/** The file as the page runs it: a classic script against a bare `window`. */
function load(): Api {
  const ctx: { window: Record<string, unknown> } = { window: {} };
  const c = createContext(ctx);
  runInContext(readFileSync(join(webSrc, "event-order.js"), "utf8"), c, { filename: "event-order.js" });
  const api = ctx.window.COTAL_EVENT_ORDER as Api | undefined;
  assert.ok(api, "event-order.js must register window.COTAL_EVENT_ORDER");
  return api;
}

const API = load();

let idSeq = 0;
/** A feed entry carrying one frame, in the all-activity shape. */
const frame = (
  seq: number,
  opts: { from?: string; epoch?: string; thread?: string; channel?: string } = {},
) => ({
  mode: "chat" as const,
  channel: opts.channel ?? "events.local.alice",
  msg: {
    id: `m${++idSeq}`,
    ts: 1000 + seq,
    from: { id: opts.from ?? "ID_ALICE", name: "alice", role: "agent" },
    channel: opts.channel ?? "events.local.alice",
    parts: [
      {
        kind: KIND,
        protocol: "ag-ui/0.0.57",
        threadId: opts.thread ?? "T1",
        runId: "R1",
        epoch: opts.epoch ?? "E1",
        seq,
        events: [{ type: "RUN_STARTED", threadId: opts.thread ?? "T1", runId: "R1" }],
      },
    ],
  },
});

/** An ordinary chat entry, which this machine must never delay or reorder. */
const chat = (text: string) => ({
  mode: "chat" as const,
  channel: "general",
  msg: {
    id: `c${++idSeq}`,
    ts: 1,
    from: { id: "ID_HUMAN", name: "dave", role: "human" },
    channel: "general",
    parts: [{ kind: "text", text }],
  },
});

const seqsOf = (rows: unknown[]): (number | string)[] =>
  rows.map((r) => {
    const f = API.frameOf(r) as { seq: number } | undefined;
    return f ? f.seq : "chat";
  });
const gaps = (notes: Note[]) => notes.filter((n) => n.type === "gap");
const prefixNotes = (notes: Note[]) => notes.filter((n) => n.type === "prefix-incomplete");
const straddles = (notes: Note[]) => notes.filter((n) => n.type === "boundary-hole");

console.log("event-order smoke");

// ── 1. the seam: served, loaded, registered, and loaded before its consumer ───────────────────────
{
  const row = PAGE["/event-order.js"];
  ok("1.1 the machine is served by the real route table", row !== undefined);
  ok("1.2 the served path is the file this suite drove", row?.path === join(webSrc, "event-order.js"));
  ok("1.3 served as javascript", typeof row?.type === "string" && row.type.includes("javascript"));

  const html = readFileSync(join(webSrc, "index.html"), "utf8");
  const orderAt = html.indexOf("/event-order.js");
  const appAt = html.indexOf("/app.js");
  ok("1.4 the page loads the machine", orderAt !== -1);
  // A classic script that loads AFTER its consumer is an absent script as far as the consumer's
  // module-scope initialisation is concerned, and `app.js` calls `create()` at module scope.
  ok("1.5 loaded BEFORE app.js, which calls create() at module scope", orderAt !== -1 && appAt !== -1 && orderAt < appAt);

  ok("1.6 the wire kind is the frame kind", API.KIND === KIND);
  ok("1.7 the first published seq is 1", API.FIRST_SEQ === 1);
}

// ── 2. chat is never held, never reordered ───────────────────────────────────────────────────────
{
  const o = API.create();
  const r = o.live(chat("hello"));
  ok("2.1 a chat entry emits immediately, before any boundary", r.emit.length === 1);
  ok("2.2 and is not held", r.held === false && o.pendingCount === 0);
  ok("2.3 and produces no notes", r.notes.length === 0);

  // The latency claim: a held frame must not block the chat behind it.
  const o2 = API.create();
  o2.live(frame(7));
  const after = o2.live(chat("still flowing"));
  ok("2.4 chat behind a HELD frame still passes straight through", after.emit.length === 1);
  ok("2.5 while the frame is still held", o2.pendingCount === 1);
}

// ── 3. before the boundary a frame is held, and NOTHING is graded ────────────────────────────────
{
  const o = API.create();
  const r = o.live(frame(1003));
  ok("3.1 a live frame before the boundary is held", r.emit.length === 0 && r.held === true);
  ok("3.2 held count is 1", o.pendingCount === 1);
  ok("3.3 not settled", o.settled === false);
  ok("3.4 no note is produced while holding", r.notes.length === 0);

  // Gap checking is NOT armed yet: 1003 then 1005 is a hole, and it must not be reported here.
  const r2 = o.live(frame(1005));
  ok("3.5 a hole between two HELD frames reports nothing before the boundary", gaps(r2.notes).length === 0);
  ok("3.6 both are still held", o.pendingCount === 2);
  ok("3.7 no chain has been graded yet", o.chainKeys.length === 0);
}

// ── 4. THE REQUIRED ROW: live ahead of the retained range ────────────────────────────────────────
// The tap is open and the fetch is in flight. A live frame at seq 1003 arrives BEFORE retained
// 1000-1002. Baseline must be the retained minimum, the live frame must be released in seq order,
// and no gap may be reported.
{
  const o = API.create();
  const live = o.live(frame(1003));
  ok("4.1 the live frame is held rather than emitted first", live.emit.length === 0);

  const settled = o.backfill([frame(1000), frame(1001), frame(1002)]);
  ok("4.2 released in seq order, retained first", JSON.stringify(seqsOf(settled.emit)) === JSON.stringify([1000, 1001, 1002, 1003]));
  ok("4.3 NO gap is reported", gaps(settled.notes).length === 0, settled.notes);
  ok("4.4 nothing is left held", o.pendingCount === 0);
  ok("4.5 the boundary has passed", o.settled === true);

  const key = o.chainKeys[0];
  const st = o.state(key);
  ok("4.6 the baseline is the RETAINED minimum, not the first frame observed", st?.baseline === 1000, st);
  ok("4.7 prefix-incomplete, because the baseline is above the first seq", st?.prefixIncomplete === true);
  ok("4.8 and it is a marker, NOT a fault", st?.faulted === false);
  ok("4.9 the prefix note names its baseline", prefixNotes(settled.notes)[0]?.baseline === 1000);
  ok("4.10 next is one past the highest applied", st?.next === 1004);

  // THE POSITIVE CONTROL for 4.3 and 4.6, and the reason this row is worth asserting. Had the
  // baseline been the first frame OBSERVED (1003), the retained range would have read as three
  // frames arriving below the baseline and 1003 would have been the only thing applied. Asserting
  // "no gap" without showing the wrong answer differs is asserting that nothing happened.
  ok("4.11 CONTROL: a first-arrival baseline would have differed", 1003 !== st?.baseline);
}

// ── 4b. the batch is sorted by `ts`, and `ts` is not `seq` ───────────────────────────────────────
// The server merges channels and sorts the union by timestamp, and a frame's timestamp is set by its
// producer. So the batch's FIRST frame is not necessarily its lowest `seq`, and a baseline taken from
// the first row rather than the minimum would be wrong in exactly the direction that manufactures a
// gap under it.
{
  const o = API.create();
  const settled = o.backfill([frame(1002), frame(1000), frame(1001)]);
  const st = o.state(o.chainKeys[0]);
  ok("4.12 the baseline is the batch MINIMUM, not its first row", st?.baseline === 1000, st);
  ok("4.13 CONTROL: the batch's first row was NOT its minimum", (API.frameOf(settled.emit[0]) as { seq: number }).seq === 1002);
  ok("4.14 no gap is reported for a batch that is complete but unsorted", gaps(settled.notes).length === 0, settled.notes);
  ok("4.15 next is past the highest, not past the last", st?.next === 1003);
}

// ── 5. the empty-history arm: the baseline is the earliest BUFFERED frame ────────────────────────
{
  const o = API.create();
  o.live(frame(5)); // arrives first
  o.live(frame(3)); // arrives second, belongs first
  const settled = o.backfill([]);
  ok("5.1 an empty history batch baselines on the earliest buffered frame", o.state(o.chainKeys[0])?.baseline === 3);
  ok("5.2 released in seq order, not arrival order", JSON.stringify(seqsOf(settled.emit)) === JSON.stringify([3, 5]));
  // 3 is the baseline and 5 is two above it, so the hole at 4 is above the baseline and IS a fault.
  ok("5.3 a hole above the baseline is reported", gaps(settled.notes).length === 1, settled.notes);
  ok("5.4 the gap names both ends", gaps(settled.notes)[0]?.expected === 4 && gaps(settled.notes)[0]?.got === 5);
  ok("5.5 prefix-incomplete too, since 3 > 1", o.state(o.chainKeys[0])?.prefixIncomplete === true);
}

// ── 6. a baseline at the first seq is complete from origin ───────────────────────────────────────
{
  const o = API.create();
  const settled = o.backfill([frame(1), frame(2)]);
  const st = o.state(o.chainKeys[0]);
  ok("6.1 baseline 1 is NOT prefix-incomplete", st?.prefixIncomplete === false, st);
  ok("6.2 and produces no prefix note", prefixNotes(settled.notes).length === 0);
  ok("6.3 both frames are emitted", settled.emit.length === 2);

  // seq 0 is structurally valid (the validator admits any non-negative safe integer) and no emitter
  // produces it. It must not be reported as an evicted prefix.
  const o2 = API.create();
  o2.backfill([frame(0)]);
  ok("6.4 a seq 0 baseline is not reported as an evicted prefix", o2.state(o2.chainKeys[0])?.prefixIncomplete === false);
}

// ── 7. after the boundary, a discontinuity is a fault ────────────────────────────────────────────
{
  const o = API.create();
  o.backfill([frame(10)]);
  const good = o.live(frame(11));
  ok("7.1 the contiguous successor reports nothing", gaps(good.notes).length === 0);
  ok("7.2 and is emitted", good.emit.length === 1);

  const hole = o.live(frame(14));
  ok("7.3 a post-baseline discontinuity IS reported", gaps(hole.notes).length === 1, hole.notes);
  ok("7.4 naming what is missing, not merely that something is", gaps(hole.notes)[0]?.expected === 12 && gaps(hole.notes)[0]?.got === 14 && gaps(hole.notes)[0]?.missing === 2);
  ok("7.5 the chain is faulted", o.state(o.chainKeys[0])?.faulted === true);
  // DETECTION IS NOT RECOVERY. Holding 14 back until 12 and 13 turn up would hold it forever when
  // they are genuinely gone, turning a visible gap into the silent loss this lane exists to remove.
  ok("7.6 and the frame is still DRAWN, not withheld", hole.emit.length === 1);

  // One gap must report once. Reporting on every later frame would bury the event that matters.
  const next = o.live(frame(15));
  ok("7.7 the frame after a gap does not re-report it", gaps(next.notes).length === 0, next.notes);
  ok("7.8 and is emitted", next.emit.length === 1);
}

// ── 8. duplicates: the backfill and the tap both carry one frame ─────────────────────────────────
{
  const o = API.create();
  const dup = frame(21);
  o.live(dup);
  const settled = o.backfill([dup]);
  ok("8.1 a frame in BOTH the batch and the buffer is emitted once", seqsOf(settled.emit).filter((s) => s === 21).length === 1, seqsOf(settled.emit));

  const again = o.live(frame(21));
  ok("8.2 a re-delivered seq after the boundary is dropped, not re-drawn", again.emit.length === 0);
  ok("8.3 and is not mistaken for a gap", gaps(again.notes).length === 0);
}

// ── 9. chains are separate, and the key is what keeps them apart ─────────────────────────────────
{
  // Same runId, same threadId, same seq, DIFFERENT epoch: two writers' (runId, seq) pairs collide by
  // construction, so epoch is the only thing that makes a stream its own.
  const o = API.create();
  o.backfill([frame(50, { epoch: "E1" }), frame(50, { epoch: "E2" })]);
  ok("9.1 two epochs are two chains", o.chainKeys.length === 2, o.chainKeys);
  const a = o.live(frame(51, { epoch: "E1" }));
  const b = o.live(frame(51, { epoch: "E2" }));
  ok("9.2 each advances independently, no cross-chain gap", gaps(a.notes).length === 0 && gaps(b.notes).length === 0);

  const o2 = API.create();
  o2.backfill([frame(50, { from: "ID_A" }), frame(50, { from: "ID_B" })]);
  ok("9.3 two senders are two chains", o2.chainKeys.length === 2);

  const o3 = API.create();
  o3.backfill([frame(50, { thread: "T1" }), frame(50, { thread: "T2" })]);
  ok("9.4 two threads are two chains", o3.chainKeys.length === 2);

  // A thread id is a producer-supplied string. If the key were built by joining with a separator,
  // an id containing that separator could fuse two chains, and a fused chain HIDES a gap.
  const o4 = API.create();
  o4.backfill([frame(50, { thread: 'x","E1","y' }), frame(50, { thread: "z" })]);
  ok("9.5 a thread id containing the key's own punctuation does not fuse two chains", o4.chainKeys.length === 2, o4.chainKeys);
}

// ── 10. what is not orderable passes through, and nothing here throws ───────────────────────────
{
  const o = API.create();
  const bad = (seq: unknown) => {
    const e = frame(1);
    (e.msg.parts[0] as unknown as { seq: unknown }).seq = seq;
    return e;
  };
  for (const [label, value] of [
    ["absent", undefined],
    ["a string", "3"],
    ["negative", -1],
    ["fractional", 1.5],
    ["NaN", Number.NaN],
    ["unsafe", Number.MAX_SAFE_INTEGER + 2],
  ] as [string, unknown][]) {
    const r = o.live(bad(value));
    ok(`10.1 a frame whose seq is ${label} passes through rather than being held`, r.emit.length === 1 && r.held === false);
  }
  ok("10.2 none of them were buffered", o.pendingCount === 0);

  // `frameOf` answers a ROUTING question, so it must survive anything the page can hand it.
  const hostile: unknown[] = [
    null,
    undefined,
    42,
    "frame",
    true,
    {},
    { msg: null },
    { msg: { parts: null } },
    { msg: { parts: "nope" } },
    { msg: { parts: [null, undefined, 7] } },
    { msg: { get parts() { throw new Error("boom"); } } },
    new Proxy({}, { get() { throw new Error("hostile"); } }),
  ];
  let threw: string | undefined;
  for (const h of hostile) {
    try {
      API.frameOf(h);
      o.live(h);
    } catch (e) {
      threw = `${String((e as Error).message)} on ${JSON.stringify(h)}`;
    }
  }
  ok("10.3 no hostile input makes the machine throw", threw === undefined, threw);
  // CONTROL: the hostile list must actually be reaching a property read, or 10.3 passes vacuously.
  let controlThrew = false;
  try {
    (hostile[10] as { msg: { parts: unknown } }).msg.parts;
  } catch {
    controlThrew = true;
  }
  ok("10.4 CONTROL: the throwing-getter input really does throw when read directly", controlThrew);
}

// ── 11. a mixed batch: chat and frames settle together ──────────────────────────────────────────
{
  const o = API.create();
  o.live(frame(101));
  const settled = o.backfill([chat("older"), frame(100), chat("newer")]);
  ok("11.1 chat rows in the batch are preserved", settled.emit.filter((r) => API.frameOf(r) === undefined).length === 2);
  ok("11.2 and the frames still order among themselves", JSON.stringify(seqsOf(settled.emit).filter((s) => s !== "chat")) === JSON.stringify([100, 101]));
  ok("11.3 the batch's own order is not disturbed", API.frameOf(settled.emit[0]) === undefined);
}

// ── 12. THE BOUNDARY PASSES EVEN WHEN THE FETCH FAILS, driven through the SHIPPED functions ──────
// Every cell above builds its own inputs, so none of them can see this: `pending` is drained only by
// `backfill()`, so a rejected history request means the machine never settles and every frame held
// during it is invisible for the life of the page. That was introduced by the buffering itself, since
// the code this replaced simply left the live arrivals in place on a failed fetch. So this section
// runs the REAL `refresh()` and `select()` out of `app.js`, with a fetch that rejects.
//
// The harness this builds is shared with §13, §14 and §15, which need the same thing: the shipped
// bootstrap, driven, rather than a restatement of it.
{
  const appSrc = readFileSync(join(webSrc, "app.js"), "utf8");
  const sf = ts.createSourceFile("app.js", appSrc, ts.ScriptTarget.ESNext, true, ts.ScriptKind.JS);
  const wanted = new Set(["refresh", "onMessage", "noteOrder", "select", "orderNoticeHtml", "setStale"]);
  // The single-flight state the shipped functions read. TAKEN FROM THE FILE, not restated: a
  // hand-written `let refreshing = null` here would let the harness keep passing after the real
  // declaration changed, and a bootstrap that coalesces is the whole of blocker 1.
  const wantedState = new Set(["refreshing", "selecting"]);
  const fns: string[] = [];
  const state: string[] = [];
  sf.forEachChild((n) => {
    if (ts.isFunctionDeclaration(n) && n.name && wanted.has(n.name.text)) fns.push(appSrc.slice(n.getStart(sf), n.end));
    if (ts.isVariableStatement(n))
      for (const d of n.declarationList.declarations)
        if (ts.isIdentifier(d.name) && wantedState.has(d.name.text)) state.push(appSrc.slice(n.getStart(sf), n.end));
  });
  // Pinned first: a short extraction would make every cell below vacuous.
  ok("12.1 all six shipped functions are extractable", fns.length === 6, fns.length);
  ok("12.1b and the in-flight state they coalesce on", state.length === 2, state);

  type Ctx = Record<string, unknown> & {
    activity: unknown[];
    channelMsgs: unknown[];
    orderNotes: { type: string }[];
    feedOrder: Order;
    channelOrder: Order;
    __p?: Promise<void>;
  };
  /** A page-like context running the shipped functions, with `/api/activity` and the per-channel
   *  history either answering or rejecting. */
  const page = (mode: "reject" | "resolve"): Ctx => {
    const ctx = {
      console,
      fetch: async (u: string) => {
        const isBackfill = u.includes("/api/activity") || u.includes("/history");
        if (isBackfill && mode === "reject") throw new Error("network down");
        // `/api/activity` answers a BOUNDED PAGE, not a bare array, and the stub says so: a stub
        // that still served the old shape would keep these cells green against a client that could
        // no longer read what the server sends.
        if (u.includes("/api/activity"))
          return { ok: true, json: async () => ({ entries: [], partial: false, read: 1, of: 1, missing: [], deadlineMs: 8000 }) };
        return { ok: true, json: async () => [] };
      },
      // The stale pill's element, so the shipped `setStale` runs rather than being stubbed out: it is
      // on the same path as the note this section measures and a missing stub would throw there.
      $: (id: string) => (id === "stale" ? { hidden: true, title: "", querySelector: () => ({ textContent: "" }) } : null),
      refreshDerived() {}, renderSidebarNav() {}, renderCenter() {}, renderChannels() {},
      renderDMs() {}, renderRoster() {}, renderRail() {}, rosterRows: () => [],
      roster: [], channels: new Map(), dms: [], activity: [] as unknown[], agentSel: null,
      dmSel: null, selected: "*", unread: new Map(), channelMsgs: [] as unknown[],
      orderNotes: [] as { type: string }[], isDemo: false, loadSeq: 0,
      window: {} as Record<string, unknown>,
      feedOrder: undefined as unknown, channelOrder: undefined as unknown,
      __p: undefined as Promise<void> | undefined, __E: undefined as unknown,
    };
    const c = createContext(ctx);
    runInContext(readFileSync(join(webSrc, "event-order.js"), "utf8"), c, { filename: "event-order.js" });
    // Keep-last-good + the refusal guard, READ OFF DISK like the order machine beside it: `refresh()`
    // reads every source through it, so a restatement here would let these cells pass against a
    // version that no longer ships.
    runInContext(readFileSync(join(webSrc, "snapshot.js"), "utf8"), c, { filename: "snapshot.js" });
    runInContext("feedOrder = window.COTAL_EVENT_ORDER.create(); channelOrder = window.COTAL_EVENT_ORDER.create();", c);
    runInContext([...state, ...fns].join("\n"), c, { filename: "app.js" });
    (ctx as Record<string, unknown>).__ctx = c;
    return ctx as unknown as Ctx;
  };
  const drive = async (ctx: Ctx, call: string, entry: unknown) => {
    const c = (ctx as unknown as { __ctx: ReturnType<typeof createContext> }).__ctx;
    (ctx as Record<string, unknown>).__E = entry;
    runInContext(`__p = ${call};`, c);
    runInContext("onMessage(__E);", c); // a frame arrives live while the request is in flight
    await (ctx.__p as Promise<void>).catch(() => undefined);
  };

  // The all-activity feed, backfill REJECTING.
  {
    const ctx = page("reject");
    await drive(ctx, "refresh()", frame(1));
    ok("12.2 a frame held during a FAILED backfill still reaches the feed", ctx.activity.length === 1, ctx.activity.length);
    ok("12.3 nothing is left held", ctx.feedOrder.pendingCount === 0, ctx.feedOrder.pendingCount);
    ok("12.4 the boundary passed", ctx.feedOrder.settled === true);
    ok("12.5 and the failure is SURFACED rather than swallowed", ctx.orderNotes.some((n) => n.type === "backfill-failed"), ctx.orderNotes);
    ok("12.6 the baseline came from the buffered frame", ctx.feedOrder.state(ctx.feedOrder.chainKeys[0])?.baseline === 1);
  }
  // CONTROL: the same harness with the fetch RESOLVING. Without this, 12.2 could be passing because
  // the harness never held the frame in the first place.
  {
    const ctx = page("resolve");
    await drive(ctx, "refresh()", frame(1));
    ok("12.7 CONTROL: the same harness with a working fetch also delivers the frame", ctx.activity.length === 1, ctx.activity.length);
    ok("12.8 CONTROL: and reports no failure note", !ctx.orderNotes.some((n) => n.type === "backfill-failed"));
  }
  // The selected-channel view, history REJECTING.
  {
    const ctx = page("reject");
    ctx.selected = "events.local.alice";
    await drive(ctx, 'select("events.local.alice")', frame(1));
    ok("12.9 a frame held during a FAILED channel history still reaches that channel's view", ctx.channelMsgs.length === 1, ctx.channelMsgs.length);
    ok("12.10 nothing is left held on that path either", ctx.channelOrder.pendingCount === 0);
    ok("12.11 and it too surfaces the failure", ctx.orderNotes.some((n) => n.type === "backfill-failed"));
  }

  // ── 13. TWO BOOTSTRAPS AT ONCE, which the stock startup performs on every load ──────────────────
  // Arming a machine and settling it are the two ends of ONE bootstrap. When `refresh()` could be
  // re-entered between them, the second call rebound `feedOrder` and the first machine, holding
  // whatever the tap had delivered in that window, became unreachable: its buffer was never drained
  // and never merged. This is not a hypothetical schedule. The page ends with `refresh(); connect();`
  // and `connect()`'s open handler calls `refresh()` again, so the second call is the norm, and a
  // reconnect flap repeats it.
  {
    // The structural half: the two call sites this race needs both exist in the shipped file.
    const startup = /\n\s*refresh\(\);\n\s*connect\(\);/.test(appSrc);
    const onOpen = /addEventListener\("open",[\s\S]{0,120}?refresh\(\);/.test(appSrc);
    ok("13.1 the shipped startup calls refresh() and then connect()", startup);
    ok("13.2 and connect()'s open handler calls refresh() again", onOpen);
  }
  {
    const ctx = page("resolve");
    const c = (ctx as unknown as { __ctx: ReturnType<typeof createContext> }).__ctx;
    // Both calls are in flight together, with a frame arriving in between, exactly as the tap would
    // deliver one between the startup call and the open handler's.
    (ctx as Record<string, unknown>).__E = frame(7);
    runInContext("__p = refresh();", c);
    const first = ctx.feedOrder; // the machine the FIRST call armed, captured while it is in flight
    runInContext("onMessage(__E);", c);
    runInContext("__p2 = refresh();", c);
    await (ctx.__p as Promise<void>).catch(() => undefined);
    await ((ctx as Record<string, unknown>).__p2 as Promise<void>).catch(() => undefined);
    ok("13.3 the second call did NOT arm a rival machine", ctx.feedOrder === first);
    ok("13.4 so the frame held by the first one still reaches the feed", ctx.activity.length === 1, seqsOf(ctx.activity));
    ok("13.5 and nothing is left held", ctx.feedOrder.pendingCount === 0, ctx.feedOrder.pendingCount);
  }
  {
    // The same race on the channel view, which `refresh()` drives itself: it calls `select(selected)`
    // on every poll, so two bootstraps for the SAME open channel overlap routinely.
    const ctx = page("resolve");
    const c = (ctx as unknown as { __ctx: ReturnType<typeof createContext> }).__ctx;
    ctx.selected = "events.local.alice";
    (ctx as Record<string, unknown>).__E = frame(7);
    runInContext('__p = select("events.local.alice");', c);
    const first = ctx.channelOrder; // armed by the first selection, captured while it is in flight
    runInContext("onMessage(__E);", c);
    runInContext('__p2 = select("events.local.alice");', c);
    await (ctx.__p as Promise<void>).catch(() => undefined);
    await ((ctx as Record<string, unknown>).__p2 as Promise<void>).catch(() => undefined);
    ok("13.6 a second selection of the same channel shares the bootstrap", ctx.channelOrder === first);
    ok("13.7 so its held frame reaches the channel view", ctx.channelMsgs.length === 1, ctx.channelMsgs.length);
    ok("13.8 and nothing is left held there either", ctx.channelOrder.pendingCount === 0);
    ok("13.9 CONTROL: the refresh path is what calls select on a poll", /\n\s*select\(selected\);/.test(appSrc));
  }

  // ── 14. THE BOUNDARY PASSES ON EVERY BRANCH, not only on all-activity ──────────────────────────
  // `feedOrder` is re-armed at the top of `refresh()` unconditionally, and the settle used to live
  // inside the `selected === "*"` branch. So for a reader sitting on a channel, a DM or an agent
  // drill-down, every live frame was held by a machine that would never settle: absent from the feed,
  // then discarded wholesale by the next poll's re-arm. A `finally` is the only placement that covers
  // all four branches AND a throw from anything the function calls between the arm and the settle.
  for (const branch of ["channel", "dm", "agent"] as const) {
    const ctx = page("resolve");
    if (branch === "channel") ctx.selected = "team.backend";
    if (branch === "dm") ctx.dmSel = { peer: "p", with: "q" };
    if (branch === "agent") ctx.agentSel = "p";
    await drive(ctx, "refresh()", frame(9));
    ok(`14.${branch === "channel" ? 1 : branch === "dm" ? 3 : 5} the boundary passes with a ${branch} open`, ctx.feedOrder.settled === true);
    ok(`14.${branch === "channel" ? 2 : branch === "dm" ? 4 : 6} and the held frame is not stranded`, ctx.feedOrder.pendingCount === 0, ctx.feedOrder.pendingCount);
  }
  {
    // A THROW BETWEEN THE ARM AND THE SETTLE. This cell used to drive it by rejecting `/api/roster`,
    // the function's first fetch, which was unguarded. Every source read now goes through the
    // keep-last-good helper, which REPORTS a refusal instead of propagating it, so that stimulus no
    // longer throws at all and the cell it fed became vacuous: it passed whether the settle ran on
    // every path or only on the normal tail. That is not a reason to drop the rule, because the
    // renders this function calls once its reads are in can still throw, and the consequence is
    // unchanged: the frames held during the poll are stranded for the life of the page. So the
    // stimulus moves to a throw that the current code can actually produce, and 14.7b proves the
    // stimulus fired rather than leaving the cell to pass on a call that never happened.
    const ctx = page("resolve");
    let threw = false;
    (ctx as Record<string, unknown>).renderSidebarNav = () => { threw = true; throw new Error("render blew up"); };
    await drive(ctx, "refresh()", frame(9));
    ok("14.7 a throw between the arm and the settle still settles the boundary", ctx.feedOrder.settled === true);
    ok("14.7b CONTROL: the stimulus really threw (a cell whose throw never fires grades nothing)", threw === true);
    ok("14.8 and the frame held during it still reaches the feed", ctx.activity.length === 1, seqsOf(ctx.activity));
  }
  {
    // THE PATH THAT REPLACED IT, kept as its own cells because it is a DIFFERENT claim: a source read
    // that refuses is absorbed and reported, and the boundary still passes. Nothing throws here, so
    // this pair cannot stand in for 14.7 and is not written as though it could.
    const ctx = page("resolve");
    (ctx as Record<string, unknown>).fetch = async (u: string) => {
      if (u.includes("/api/roster")) throw new Error("network down");
      if (u.includes("/api/activity"))
        return { ok: true, json: async () => ({ entries: [], partial: false, read: 1, of: 1, missing: [], deadlineMs: 8000 }) };
      return { ok: true, json: async () => [] };
    };
    await drive(ctx, "refresh()", frame(9));
    ok("14.9 a REFUSED source read still settles the boundary", ctx.feedOrder.settled === true);
    ok("14.10 and the frame held during it still reaches the feed", ctx.activity.length === 1, seqsOf(ctx.activity));
  }

  // ── 15. THE NOTES ARE DRAWN, which is a different claim from computing them ─────────────────────
  // The notes were collected into an array nothing read: the machine detected a missing frame and the
  // page said nothing. A gap that reaches only an unused variable is the same silence this lane exists
  // to remove, one layer up, and it is also what decides whether treating a failed read as an empty
  // history is an honest degrade or a quiet one.
  {
    const c = createContext({ orderNotes: [] as Note[] });
    runInContext(fns.find((f) => f.startsWith("function orderNoticeHtml")) as string, c);
    const html = (notes: Note[]) => {
      (c as unknown as { orderNotes: Note[] }).orderNotes = notes;
      return runInContext("orderNoticeHtml()", c) as string;
    };
    ok("15.1 an ordinary feed draws no notice", html([]) === "");
    const gapHtml = html([{ type: "gap", expected: 4, got: 7, missing: 3 }]);
    ok("15.2 a gap is drawn, and says how many frames are missing", /\b3\b/.test(gapHtml) && /missing/.test(gapHtml), gapHtml);
    const prefixHtml = html([{ type: "prefix-incomplete", baseline: 900 }]);
    ok("15.3 an evicted prefix is drawn too", prefixHtml !== "" && /not retained/.test(prefixHtml), prefixHtml);
    // THE ONE THAT ALWAYS HAPPENS ON A LATE JOIN MUST NOT READ LIKE THE ONE THAT MUST NEVER BE
    // IGNORED. Collapsing them into one banner would spend the reader's attention on retention.
    ok("15.4 and the two are not the same statement", gapHtml !== prefixHtml && !/missing/.test(prefixHtml));
    const straddleHtml = html([{ type: "boundary-hole", expected: 4, got: 5, missing: 1 }]);
    ok("15.5 an unattributable start-up hole is drawn as unconfirmed, not as loss", /unconfirmed/.test(straddleHtml) && !/missing/.test(straddleHtml), straddleHtml);
    const failHtml = html([{ type: "backfill-failed" } as Note]);
    ok("15.6 a failed history read is drawn, so the empty-batch settle is not a silent degrade", /history unavailable/.test(failHtml), failHtml);
    ok("15.7 a fault is marked as one, and not by colour alone", /order-notice fault/.test(gapHtml) && !/fault/.test(prefixHtml));

    // The rendering half: the feed views actually call it. Without this the function could be dead.
    const drawn = new Set<string>();
    sf.forEachChild((n) => {
      if (ts.isFunctionDeclaration(n) && n.name && /^render(AllActivity|Channel)$/.test(n.name.text))
        if (appSrc.slice(n.getStart(sf), n.end).includes("orderNoticeHtml()")) drawn.add(n.name.text);
    });
    ok("15.8 the all-activity view draws it", drawn.has("renderAllActivity"), [...drawn]);
    ok("15.9 the channel view draws it", drawn.has("renderChannel"), [...drawn]);
    ok("15.10 and the page styles it", readFileSync(join(webSrc, "index.html"), "utf8").includes(".order-notice"));
  }
}

// ── 16. A HOLE INSIDE THE RETAINED BATCH, which no live arrival will ever reveal ─────────────────
// The minimum, the maximum and the membership set place the baseline and dedupe, and they are not
// enough to notice that the middle is missing. A batch of 1, 2, 5 has baseline 1 and frontier 6, and
// every frame after it follows contiguously, so the chain reads healthy forever while two frames are
// gone. It is the one discontinuity the live path cannot expose, because nothing after it is out of
// order.
{
  const o = API.create();
  const settled = o.backfill([frame(1), frame(2), frame(5)]);
  ok("16.1 a hole inside the batch IS reported", gaps(settled.notes).length === 1, settled.notes);
  ok("16.2 naming both ends and the count", gaps(settled.notes)[0]?.expected === 3 && gaps(settled.notes)[0]?.got === 5 && gaps(settled.notes)[0]?.missing === 2);
  ok("16.3 and the chain is faulted", o.state(o.chainKeys[0])?.faulted === true);
  ok("16.4 every retained frame is still drawn", seqsOf(settled.emit).join(",") === "1,2,5");
  ok("16.5 the frontier is still past the highest", o.state(o.chainKeys[0])?.next === 6);

  // CONTROL: the same walk over a complete batch reports nothing, so 16.1 is not a check that fires
  // on everything.
  const o2 = API.create();
  ok("16.6 CONTROL: a complete batch reports no gap", gaps(o2.backfill([frame(1), frame(2), frame(3)]).notes).length === 0);
  // A run of one, and two runs, so the report is per BREAK and not per missing number: losing a
  // thousand frames must be one note naming both ends, not a thousand notes burying it.
  const o3 = API.create();
  ok("16.7 a single missing frame is one note", gaps(o3.backfill([frame(1), frame(3)]).notes).length === 1);
  const o4 = API.create();
  const two = gaps(o4.backfill([frame(1), frame(3), frame(5)]).notes);
  ok("16.8 two breaks are two notes", two.length === 2, two);
  ok("16.9 each naming its own ends", two[0]?.expected === 2 && two[0]?.got === 3 && two[1]?.expected === 4 && two[1]?.got === 5);
  // Below the baseline is retention, not loss, and must never be reported as a break.
  const o5 = API.create();
  const late = o5.backfill([frame(900), frame(901)]);
  ok("16.10 nothing below the baseline is reported", gaps(late.notes).length === 0, late.notes);
  ok("16.11 that arm reports the evicted prefix instead", prefixNotes(late.notes).length === 1);
  // The batch is ts-sorted, so the walk must not depend on row order.
  const o6 = API.create();
  ok("16.12 an unsorted batch is walked by seq, not by row", gaps(o6.backfill([frame(5), frame(1), frame(2)]).notes).length === 1);
}

// ── 17. THE ONE HOLE THIS PAGE CANNOT ATTRIBUTE, and the one it can ─────────────────────────────
// The live tap and the history read are two reads with no shared cut, and on this page the fetch is
// issued before the tap is open. So the FIRST buffered frame of a chain can sit above the retained
// top by more than one with nothing lost at all. Reported as a fault it latched forever on healthy
// traffic, and the frame that filled the hole did not clear it. Reported as nothing, the page would be
// claiming an answer it does not have. It is reported as its own kind, and only for the frame that
// straddles the seam.
{
  const o = API.create();
  o.live(frame(1004)); // buffered while the fetch is in flight
  const settled = o.backfill([frame(1000), frame(1001), frame(1002)]);
  ok("17.1 the straddling hole is NOT a gap", gaps(settled.notes).length === 0, settled.notes);
  ok("17.2 it is reported as its own kind", straddles(settled.notes).length === 1, settled.notes);
  ok("17.3 naming both ends, so it is not a vague warning", straddles(settled.notes)[0]?.expected === 1003 && straddles(settled.notes)[0]?.got === 1004);
  ok("17.4 and it does NOT latch the chain as faulted", o.state(o.chainKeys[0])?.faulted === false, o.state(o.chainKeys[0]));
  // The frame that fills it arrives a moment later. Under the fault reading this cleared nothing.
  const fill = o.live(frame(1003));
  ok("17.5 the frame that fills it is admitted", fill.emit.length === 1);
  ok("17.6 without reporting a gap", gaps(fill.notes).length === 0, fill.notes);
  ok("17.7 and the chain is still not faulted", o.state(o.chainKeys[0])?.faulted === false);
  ok("17.8 the stream continues clean", gaps(o.live(frame(1005)).notes).length === 0);

  // ONLY THE FRAME THAT STRADDLES THE SEAM. Every later buffered frame arrived through the SAME tap
  // as the one before it, and a subscription delivers a subject in order, so a number missing between
  // two buffered frames was never delivered while the page was listening: a real loss.
  const o2 = API.create();
  o2.live(frame(1004));
  o2.live(frame(1006));
  const s2 = o2.backfill([frame(1000), frame(1002)]);
  ok("17.9 a hole between two BUFFERED frames is a gap", gaps(s2.notes).some((g) => g.expected === 1005 && g.got === 1006), s2.notes);
  ok("17.10 the straddling one is still only unconfirmed", straddles(s2.notes).length === 1, straddles(s2.notes));
  ok("17.11 and the batch-internal one is a gap too", gaps(s2.notes).some((g) => g.expected === 1001 && g.got === 1002));
  ok("17.12 so that chain IS faulted", o2.state(o2.chainKeys[0])?.faulted === true);
  // CONTROL: after the boundary there is no such window, so a hole in live traffic is a hard fault.
  const o3 = API.create();
  o3.backfill([frame(10)]);
  ok("17.13 CONTROL: a post-boundary hole is a gap, not an unconfirmed one", gaps(o3.live(frame(12)).notes).length === 1 && straddles(o3.live(frame(20)).notes).length === 0);
}

console.log(`event-order smoke: ${cells - failed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
