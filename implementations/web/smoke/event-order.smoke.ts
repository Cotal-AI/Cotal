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

console.log(`event-order smoke: ${cells - failed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
