/**
 * A FAILED MEMBERSHIP READ MUST NOT BE SERVED AS A SUCCESSFUL EMPTY ONE.
 *
 * The observer's `/api/membership` route answered a read failure with
 * `{asOf: undefined, members: []}` and a 200. `JSON.stringify` DROPS a key whose value is
 * `undefined`, so those bytes are `{"members":[]}` — byte-identical to a successful read of a space
 * where nobody is subscribed. The one field that might have separated the two never reached the
 * wire. Downstream, the graph's pill read that as `membership: traffic-only`, which is a CLAIM
 * ABOUT THE MESH (no membership feed is being published) standing in for a fact about US (we could
 * not find out). The operator's own viewer reported traffic-only against a mesh that had a feed and
 * nothing on the page could have revealed the difference.
 *
 * FOUR silences fed the same display, and each has cells here: the HTTP route; the two server-sent-
 * event paths, which swallowed the rejection with `.catch(() => {})`; and the browser's own
 * `.catch(() => ({members: []}))` at boot, which manufactured the same empty snapshot when the fetch
 * itself failed. This sentence said "two" while three of the four were uncovered — see the passes
 * recorded at the end of this comment.
 *
 * WHAT IS DRIVEN. The server half is EXTRACTED from `web.ts` and EXECUTED: the route block, `json`,
 * the SSE encoder and broadcaster. `web.ts` cannot be imported whole (the route closes over a live
 * endpoint), so this follows the extraction precedent already in this directory. The client half is
 * IMPORTED, as the bundle imports it: `pillState` and `feedAuthoritative` (lib/membership.ts), the
 * controller (state/controller.ts) over `httpApi` (api/http.ts) and the feed (api/feed.ts). A
 * substring check would prove a line was TYPED; it goes red on a reformat and stays green on a
 * statement that stopped doing what its name says.
 *
 * The HTTP status and the response bytes are read off a recording `ServerResponse`, not off the
 * arguments passed to a stubbed helper — the shipped `json` sets the status, so stubbing it would
 * have left the 503 unmeasured.
 *
 * NOT DRIVEN, and no cell implies it: that a live broker with no membership stream makes
 * `readMembership` reject. These cells stand on the narrower fact that WHEN it rejects, the refusal
 * is distinguishable from data at every surface that carries it.
 *
 * WHAT THIS FILE MISSED ON ITS FIRST PASS, kept here because the shape recurs. The original 18 cells
 * covered the HTTP route and the pill and claimed to cover the boot path and the events too. They did
 * not: `pillText` hand-injects `{unreadable: true}`, which proves the pill RENDERS that state and says
 * nothing about anything PRODUCING it. Two mutations therefore survived with every cell green —
 * dropping the boot status gate, and restoring `.catch(() => {})` on the event push — and both were
 * confirmed by execution (rc=0, 18/18) before the cells below were written. **A cell that stops one
 * step short of the surface under test is the same defect this file exists to fix: it reports success
 * for a path it never reached.** Found by an adversarial reviewer, not by the author.
 *
 * AND THEN A THIRD TIME, in the fix for the first two. The new boot cells took a RESPONSE and stubbed
 * `fetch` as something that always resolves, so the shipped `.catch` arm — the one for no answer at
 * all — was still never executed, and restoring `{members: []}` there survived all 31 cells. The
 * harness now supplies the fetch. **A stub that cannot fail cannot test a failure path, and it looks
 * exactly like one that can.**
 *
 * AND A FOURTH, at the wire. The event cells stubbed `send` and `broadcast` and asserted the event
 * NAME handed to the stub. A `send` that returned early for this one event then left both refusal
 * paths calling the right helper with the right token and writing NOTHING, and all 32 cells stayed
 * green. **Asserting what a function was CALLED WITH is not asserting what it DID.** The cells now
 * drive the shipped encoder and broadcaster over a recording response and assert the bytes.
 *
 * AND A FIFTH, in the assertion rather than the fixture. The wire cells used `.includes()`, which is
 * satisfied by `xevent: membership-read-failed` — and that one character is the difference between a
 * NAMED event and the DEFAULT `message` event, which `onMessage` drops for having no `msg`. The
 * refusal goes silent again with every cell green. **A substring match establishes neither a field
 * boundary nor a complete frame.** The frames are now asserted byte for byte.
 *
 * Five passes, five variants of one mistake: the assertion reached one step less far than the
 * sentence describing it. Each was found by a reader who could not run the suite at all.
 */
import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createContext, runInContext } from "node:vm";
import ts from "typescript";
import { httpApi } from "../client/src/api/http.js";
import { openFeed, type FeedHandlers, type FeedSource } from "../client/src/api/feed.js";
import { feedAuthoritative, pillState, type Pill } from "../client/src/lib/membership.js";
import { createController } from "../client/src/state/controller.js";
import { createStore } from "../client/src/state/store.js";
import { initialState, type DashboardState } from "../client/src/state/types.js";
// `writeFeed` is what the lifted `send` calls, so it goes into the context as the module exports it.
import { MEMBERSHIP_READ_FAILED, writeFeed } from "../src/web.js";

let pass = 0;
const check = (name: string, cond: boolean, extra?: unknown) => {
  assert.ok(cond, `${name}${extra !== undefined ? ` — ${JSON.stringify(extra)}` : ""}`);
  pass++;
  console.log(`  ✓ ${name}`);
};
const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");

/** Lift a braced construct out of shipped source by matching braces from an anchor. Returns null
 *  when the anchor is absent — see the positive control below, which proves that miss is real. */
const lift = (src: string, anchor: string): string | null => {
  const start = src.indexOf(anchor);
  if (start === -1) return null;
  let i = src.indexOf("{", start), depth = 0;
  if (i === -1) return null;
  for (let j = i; j < src.length; j++) {
    if (src[j] === "{") depth++;
    else if (src[j] === "}" && --depth === 0) return src.slice(start, j + 1);
  }
  return null;
};

/** Lift a STATEMENT — anchor through the first terminator at paren/brace depth zero. The chained
 *  expressions this file drives are not braced constructs, so `lift` cannot reach them, which is
 *  how two whole paths came to be uncovered while the suite read as complete. `nth` selects among
 *  repeated anchors (the two server-sent-event calls are spelled identically). */
const liftStmt = (src: string, anchor: string, terminator: string, nth = 0): string | null => {
  let start = -1;
  for (let k = 0; k <= nth; k++) {
    start = src.indexOf(anchor, start + 1);
    if (start === -1) return null;
  }
  let depth = 0;
  for (let j = start; j < src.length; j++) {
    const ch = src[j];
    if (ch === "(" || ch === "{" || ch === "[") depth++;
    else if (ch === ")" || ch === "}" || ch === "]") depth--;
    else if (ch === terminator && depth === 0) return src.slice(start, j);
  }
  return null;
};

const webTs = read("../src/web.ts");

const routeBlock = lift(webTs, 'if (path === "/api/membership")');
const jsonHelper = lift(webTs, "function json(res: ServerResponse");

// ── NON-VACUITY, before anything executes ───────────────────────────────────────────────────────
check("the /api/membership route block was lifted out of web.ts", Boolean(routeBlock), { len: routeBlock?.length });
check("the json helper was lifted out of web.ts", Boolean(jsonHelper), { len: jsonHelper?.length });

// POSITIVE CONTROL on the lifter: an anchor that is not in the file must come back null, so the
// three successes above are matches rather than a lifter that cannot miss.
check("CONTROL: an absent anchor lifts nothing (the miss is reachable)",
  lift(webTs, 'if (path === "/api/definitely-not-a-route")') === null);

// ── The server surface, executed ────────────────────────────────────────────────────────────────
type Recorded = { status: number; body: string };

/** Run the SHIPPED route block against a readMembership of our choosing and record what a browser
 *  would actually receive: the status line and the response bytes. */
const serve = async (readMembership: () => Promise<unknown>): Promise<Recorded> => {
  const rec: Recorded = { status: 0, body: "" };
  const res = {
    writeHead: (status: number) => { rec.status = status; },
    end: (body: string) => { rec.body = body; },
  };
  const source = ts.transpileModule(
    `${jsonHelper}\nglobalThis.__run = async () => { ${routeBlock} };`,
    { compilerOptions: { target: ts.ScriptTarget.ES2022 } },
  ).outputText;
  const ctx: Record<string, unknown> = {
    path: "/api/membership",
    res,
    ep: { readMembership },
    MEMBERSHIP_READ_FAILED,
    globalThis: undefined,
    console,
  };
  ctx.globalThis = ctx;
  runInContext(source, createContext(ctx), { filename: "web.ts (route)" });
  await (ctx.__run as () => Promise<void>)();
  return rec;
};

const okFull = await serve(async () => ({ asOf: 1700000000000, members: [{ id: "a", live: true }] }));
check("a successful read is served 200", okFull.status === 200, okFull.status);
check("a successful read carries its members", okFull.body.includes('"id":"a"'), okFull.body);

const okEmpty = await serve(async () => ({ members: [] }));
check("a successful EMPTY read is still 200", okEmpty.status === 200, okEmpty.status);
check('a successful EMPTY read is the bytes {"members":[]}', okEmpty.body === '{"members":[]}', okEmpty.body);

const failed = await serve(async () => { throw new Error("membership stream not found"); });
check("a FAILED read is not served 200", failed.status !== 200, failed.status);
check("a FAILED read is served 503", failed.status === 503, failed.status);
check("a FAILED read NAMES its condition, using the exported token rather than a restated string",
  JSON.parse(failed.body).error === MEMBERSHIP_READ_FAILED, failed.body);

// THE CELL THE DEFECT IS ABOUT. Everything above could hold while the two responses were still
// indistinguishable to a client that reads only the body — which is exactly what shipped.
check("THE REFUSAL AND THE EMPTY SUCCESS ARE DIFFERENT BYTES (the defect, stated directly)",
  failed.body !== okEmpty.body, { failed: failed.body, empty: okEmpty.body });
check("…and different statuses, so a client that checks only the status also cannot confuse them",
  failed.status !== okEmpty.status, { failed: failed.status, empty: okEmpty.status });

// ── The browser surface, executed ───────────────────────────────────────────────────────────────
/** The pill's clock, and a snapshot stamped on it. */
const NOW = 1700000000000;
type Membership = DashboardState["membership"];
const pill = (m: Membership): Pill => pillState(m, NOW);

check("an unreadable feed says so", pill({ unreadable: "x" }) === "unreadable", pill({ unreadable: "x" }));
check("a mesh with no feed still reads traffic-only (the honest use of that phrase is preserved)",
  pill({}) === "traffic-only" && pill({ snapshot: { members: [] } }) === "traffic-only",
  [pill({}), pill({ snapshot: { members: [] } })]);
check("a fresh feed still reads live (the pill's other states are not collateral damage)",
  pill({ snapshot: { asOf: NOW, members: [] } }) === "live", pill({ snapshot: { asOf: NOW, members: [] } }));
check("an old feed reads stale, and the boundary is the last tick that is still live",
  pill({ snapshot: { asOf: NOW - 45_000, members: [] } }) === "stale" && pill({ snapshot: { asOf: NOW - 44_999, members: [] } }) === "live");

check("THE PILL DISTINGUISHES 'could not read' FROM 'nothing to read' (the display half of the defect)",
  pill({ unreadable: "x" }) !== pill({}));
// Order matters: `unreadable` arrives with no members, so a pill testing `available` first would
// report traffic-only for it and this cell is what holds that ordering in place.
check("an unreadable feed reports unreadable EVEN THOUGH it is also unavailable (ordering is load-bearing)",
  pill({ unreadable: "x", snapshot: undefined }) === "unreadable" && pill({ unreadable: "x", snapshot: { members: [] } }) === "unreadable",
  [pill({ unreadable: "x" }), pill({ unreadable: "x", snapshot: { members: [] } })]);
// An unreadable feed that HAS a snapshot is still unreadable, not live: the last reading is what we
// knew, and the pill must not call it what IS.
check("an unreadable feed with a fresh snapshot still reads unreadable, not live",
  pill({ unreadable: "x", snapshot: { asOf: NOW, members: [] } }) === "unreadable");

// ── THE PATHS THIS SUITE ORIGINALLY MISSED ──────────────────────────────────────────────────────
// Both were found by an adversarial reviewer and CONFIRMED BY EXECUTION before these cells existed:
// each mutation left all 18 earlier cells green, rc=0. They are named here because the cells above
// look like they cover them and do not: injecting `{unreadable}` by hand proves the pill RENDERS
// the state and says nothing about anything ever PRODUCING it.
//
//   M4  the boot read: drop the status gate  -> a 503 body parses as a snapshot -> traffic-only
//   M5  web.ts SSE push: restore `.catch(() => {})` -> the rejection vanishes again
//
// A cell that stops one step short of the surface under test is the same defect as the one being
// fixed: it reports success for a path it never reached.

/** The healthy answer to every route but membership, which a cell supplies. */
const healthy = (url: string): unknown => {
  if (url === "/api/meta") return { space: "s", pid: 1, post: { mode: "participant" } };
  if (url.startsWith("/api/activity")) return { entries: [], partial: false, read: 1, of: 1, missing: [], reasons: {}, deadlineMs: 8000 };
  return [];
};
type FakeResponse = { ok: boolean; status: number; body: unknown };

/** Drive the SHIPPED boot read end to end: the controller's `refresh()` over `httpApi` over a fetch of
 *  our choosing, then the SHIPPED pill over the state it wrote. Nothing is hand-seeded.
 *
 *  The harness supplies the FETCH, not a response. A fixture that could only resolve left the
 *  network-failure arm unexecuted, and restoring `{members: []}` there survived every cell. A stub
 *  that cannot fail cannot test a failure path, and it looks identical to one that can. */
const bootDashboard = async (membership: () => Promise<FakeResponse>) => {
  const store = createStore<DashboardState>(structuredClone(initialState));
  const fetchImpl = (async (url: string) => {
    if (url === "/api/membership") {
      const r = await membership();
      return { ok: r.ok, status: r.status, json: async () => r.body } as unknown as Response;
    }
    return { ok: true, status: 200, json: async () => healthy(url) } as unknown as Response;
  }) as typeof fetch;
  const ctl = createController(store, httpApi(fetchImpl));
  await ctl.refresh();
  return { store, ctl, pill: () => pill(store.get().membership) };
};
const bootPill = async (membership: () => Promise<FakeResponse>): Promise<Pill> => (await bootDashboard(membership)).pill();

const refusalBody = JSON.parse(failed.body) as unknown;
const answers = (ok: boolean, body: unknown): (() => Promise<FakeResponse>) => async () => ({ ok, status: ok ? 200 : 503, body });

check("M4: a 503 refusal reaching the boot path renders 'unreadable', not 'traffic-only'",
  (await bootPill(answers(false, refusalBody))) === "unreadable",
  await bootPill(answers(false, refusalBody)));
check("M4: a 200 empty snapshot still renders traffic-only through the same path",
  (await bootPill(answers(true, { members: [] }))) === "traffic-only");
check("M4: a 200 populated snapshot still renders live through the same path",
  (await bootPill(answers(true, { asOf: NOW, members: [{ id: "a" }] }))) === "live");

// M7. The arm above is reached when the server ANSWERS with a refusal. This one is reached when
// there is no answer at all: the daemon died, the socket dropped, the page is offline. The old
// `.catch(() => ({members: []}))` manufactured a snapshot out of that, which is the same defect as
// the server's, on the client, and it survived every cell until the fixture could reject.
check("M7: a REJECTED boot fetch renders 'unreadable', not 'traffic-only' (no answer is not an empty answer)",
  (await bootPill(async () => { throw new Error("network down"); })) === "unreadable",
  await bootPill(async () => { throw new Error("network down"); }));

// THE ORDERING RULE, from the membership side. A refusal the feed announced is NEWER than a read
// issued before it, so a late bootstrap `membership()` that resolves with a snapshot must not clear
// `unreadable`. The mirror (a good live snapshot, a late refused read) is held in the same place.
// The rule's own two directions at the dashboard level are graded in `smoke:web-graph-boot`.
{
  let resolveRead!: (r: FakeResponse) => void;
  const late = new Promise<FakeResponse>((res) => (resolveRead = res));
  const store = createStore<DashboardState>(structuredClone(initialState));
  const fetchImpl = (async (url: string) => {
    if (url === "/api/membership") {
      const r = await late;
      return { ok: r.ok, status: r.status, json: async () => r.body } as unknown as Response;
    }
    return { ok: true, status: 200, json: async () => healthy(url) } as unknown as Response;
  }) as typeof fetch;
  const ctl = createController(store, httpApi(fetchImpl));
  const boot = ctl.refresh();
  ctl.onMembershipFailed("membership stream not found");
  check("the live refusal reaches the pill at once", pill(store.get().membership) === "unreadable");
  resolveRead({ ok: true, status: 200, body: { asOf: NOW, members: [{ id: "a", live: [], durable: [] }] } });
  await boot;
  check("a LATE bootstrap membership() resolve does not clear `unreadable` (the feed spoke after that read was issued)",
    pill(store.get().membership) === "unreadable" && store.get().membership.unreadable === "membership stream not found",
    store.get().membership);
}

const ssePush = liftStmt(webTs, "void ep.readMembership()", ";", 0);
const sseSeed = liftStmt(webTs, "void ep.readMembership()", ";", 1);
check("the SSE push statement was lifted out of web.ts", Boolean(ssePush), { len: ssePush?.length });
check("the SSE seed statement was lifted out of web.ts (a DIFFERENT one from the push)",
  Boolean(sseSeed) && sseSeed !== ssePush);
check("CONTROL: liftStmt on an absent anchor returns null (its miss is reachable)",
  liftStmt(webTs, 'fetch("/api/not-a-route")', ",") === null);

const sseSend = liftStmt(webTs, "const send = (res: ServerResponse", ";");
const sseBroadcast = lift(webTs, "const broadcast = (event: string");
check("the SSE encoder was lifted out of web.ts", Boolean(sseSend), { len: sseSend?.length });
check("the SSE broadcaster was lifted out of web.ts", Boolean(sseBroadcast), { len: sseBroadcast?.length });

/** Drive a SHIPPED event statement against a rejecting read, THROUGH the shipped encoder and
 *  broadcaster, and return the bytes a browser would actually receive.
 *
 *  An earlier version stubbed `send` and `broadcast` and asserted the event NAME handed to the stub.
 *  That measured the argument, not the wire: a `send` that returned early for this one event left
 *  both refusal paths calling the right helper with the right token and writing nothing, and every
 *  cell stayed green. **Asserting what a function was CALLED WITH is not asserting what it DID.** */
const REASON = "membership stream not found";
const sseWire = async (stmt: string, ctxOverrides: Record<string, unknown> = {}): Promise<string> => {
  let bytes = "";
  const client = { writableEnded: false, writableLength: 0, write: (chunk: string) => { bytes += chunk; }, end: () => {} };
  const source = ts.transpileModule(
    `${sseSend};\n${sseBroadcast}\nlet membershipWatch;\nglobalThis.__run = async () => { ${stmt}; };`,
    { compilerOptions: { target: ts.ScriptTarget.ES2022 } },
  ).outputText;
  const ctx: Record<string, unknown> = {
    ep: { readMembership: async () => { throw new Error(REASON); } },
    clients: new Set([client]),
    res: client,
    MEMBERSHIP_READ_FAILED,
    writeFeed,
    globalThis: undefined,
    console,
    ...ctxOverrides,
  };
  ctx.globalThis = ctx;
  runInContext(source, createContext(ctx), { filename: "web.ts (sse wire)" });
  // Awaited INSIDE, so no caller can read the buffer before the rejection has settled. Reading it
  // synchronously would return "" for the fixed code as well — a cell that passes for M5 too.
  await (ctx.__run as () => Promise<void>)();
  return bytes;
};

const pushBytes = await sseWire(ssePush!);
const seedBytes = await sseWire(sseSeed!);

// THE WHOLE FRAME, byte for byte — not a substring of it. `.includes("event: …")` was satisfied by
// `xevent: membership-read-failed`, and that one character is the difference between a named event
// and the DEFAULT `message` event: EventSource would hand the payload to `onMessage`, which drops it
// for having no `msg`, and the refusal goes silent again while the cells stay green. A substring
// match establishes neither the field boundary nor a complete frame.
const REFUSAL_FRAME = `event: ${MEMBERSHIP_READ_FAILED}\ndata: ${JSON.stringify({ reason: REASON })}\n\n`;
check("M5: the SSE push writes EXACTLY the refusal frame (field at byte 0, one data line, blank terminator)",
  pushBytes === REFUSAL_FRAME, { pushBytes });
check("M5: the SSE seed writes exactly the same frame for a client connecting while the feed is broken",
  seedBytes === REFUSAL_FRAME, { seedBytes });
// Named separately from the equality above because it is a different claim: the reason must be the
// THROWN message reaching the wire, not a constant the encoder could supply on its own.
check("M5: the frame carries the thrown reason, so the operator sees WHY rather than only THAT",
  pushBytes.includes(`"reason":${JSON.stringify(REASON)}`), { pushBytes });
// POSITIVE CONTROL, now on the wire too: the same harness, with a read that SUCCEEDS, must produce
// the ordinary membership frame. Without it, a harness that wrote nothing at all would fail the two
// cells above for a reason that has nothing to do with the code under test.
const okBytes = await (async () => {
  let bytes = "";
  const client = { writableEnded: false, writableLength: 0, write: (chunk: string) => { bytes += chunk; }, end: () => {} };
  const src = ts.transpileModule(
    `${sseSend};\n${sseBroadcast}\nglobalThis.__run = async () => { ${ssePush}; };`,
    { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  const c: Record<string, unknown> = {
    ep: { readMembership: async () => ({ members: [] }) },
    clients: new Set([client]), res: client,
    MEMBERSHIP_READ_FAILED, writeFeed, globalThis: undefined, console,
  };
  c.globalThis = c;
  runInContext(src, createContext(c), { filename: "web.ts (sse control)" });
  await (c.__run as () => Promise<void>)();
  return bytes;
})();
check("CONTROL: a SUCCESSFUL read writes exactly the ordinary membership frame through the same encoder",
  okBytes === `event: membership\ndata: {"members":[]}\n\n`, { okBytes });
check("CONTROL: and that frame is NOT the refusal frame (the two are distinguishable on the wire)",
  okBytes !== REFUSAL_FRAME && !okBytes.includes(MEMBERSHIP_READ_FAILED));

// ── A watch that closes AFTER setup must reach the browser too, not just a read that rejects ─────
// The seam added for #485: `ep.watchMembership`'s second argument is invoked when the live iterator
// closes under a live connection, and the caller broadcasts the existing refusal frame with it.
const membershipWatchStmt = liftStmt(webTs, "membershipWatch = await ep.watchMembership(", ";");
check("the membershipWatch statement was lifted out of web.ts", Boolean(membershipWatchStmt), { len: membershipWatchStmt?.length });

const closedWireBytes = await sseWire(membershipWatchStmt!, {
  pushMembership: () => {},
  ep: { watchMembership: async (_onChange: () => void, onClosed: (e: Error) => void) => { onClosed(new Error(REASON)); return { stop: async () => {} }; } },
});
check("a closed watch reaches the browser as the membership-read-failed frame, byte for byte",
  closedWireBytes === REFUSAL_FRAME, { closedWireBytes });

const noCloseWireBytes = await sseWire(membershipWatchStmt!, {
  pushMembership: () => {},
  ep: { watchMembership: async (_onChange: () => void, _onClosed: (e: Error) => void) => ({ stop: async () => {} }) },
});
check("CONTROL: a watch that never closes writes nothing",
  noCloseWireBytes === "", { noCloseWireBytes });

// ── The client listens on the name the server emits, and nothing checked that before ───────────
// The client restates the literal rather than importing it (it imports nothing from core at runtime),
// so the two can drift silently: rename the constant and the browser stops listening, with every
// other cell still green. The feed is driven over a fake source that records what is registered and
// then delivers the refusal through the registered listener.
{
  const listeners = new Map<string, (e: { data: string }) => void>();
  const source: FeedSource = {
    addEventListener: (type, fn) => { listeners.set(type, fn as (e: { data: string }) => void); },
    readyState: 1, onopen: null, onerror: null, close: () => {},
  };
  const failures: string[] = [];
  const noop = () => {};
  const handlers: FeedHandlers = { open: noop, error: noop, closed: noop, roster: noop, presenceView: noop, membership: noop, message: noop, membershipFailed: (r) => { failures.push(r); } };
  openFeed(handlers, () => source);
  check("the feed registers a listener for the refusal event", listeners.has(MEMBERSHIP_READ_FAILED), [...listeners.keys()]);
  check("the listener's event name IS the server's exported constant (a restated literal can drift)",
    [...listeners.keys()].includes(MEMBERSHIP_READ_FAILED), { registered: [...listeners.keys()], exported: MEMBERSHIP_READ_FAILED });
  listeners.get(MEMBERSHIP_READ_FAILED)?.({ data: JSON.stringify({ reason: REASON }) });
  check("and the event's `reason` is what reaches the handler, so the operator sees WHY", failures.length === 1 && failures[0] === REASON, failures);
  // CONTROL: the ordinary membership event does not take the refusal path.
  const seen: unknown[] = [];
  const h2: FeedHandlers = { ...handlers, membership: (m) => { seen.push(m); }, membershipFailed: (r) => { failures.push(`wrong:${r}`); } };
  const l2 = new Map<string, (e: { data: string }) => void>();
  openFeed(h2, () => ({ ...source, addEventListener: (t, f) => { l2.set(t, f as (e: { data: string }) => void); } }));
  l2.get("membership")?.({ data: JSON.stringify({ members: [] }) });
  check("CONTROL: a `membership` event reaches the snapshot handler and not the refusal handler",
    seen.length === 1 && failures.length === 1, { seen, failures });
}

// ── The dashboard stops ACTING on a reading it has just disowned ────────────────────────────────
// The pill telling the truth was only half of it. `hide empty` collapses a hub with no visible
// member, and it was gated on the feed being available, which an unreadable feed leaves TRUE, so the
// pill read "unreadable" while the layout went on asserting a hub is empty NOW, from a snapshot the
// dashboard had just said it could no longer read. Internally inconsistent with one honest half is
// a strict improvement on consistently false, and a bad place to stop. `feedAuthoritative` is the
// predicate the graph's hide-empty gate reads; the gate itself arrives with the topology model.
check("CONTROL: an authoritative feed is authoritative (the toggle is not collateral damage)",
  feedAuthoritative({ snapshot: { asOf: NOW, members: [] } }) === true);
check("CONTROL: with no feed at all nothing is authoritative (traffic-only is unchanged)",
  feedAuthoritative({}) === false && feedAuthoritative({ snapshot: { members: [] } }) === false);
// THE DEFECT, STATED DIRECTLY. A stale snapshot is what we last KNEW, never what IS, and `hide empty`
// is a claim about now. This is the cell a revert reddens.
check("AN UNREADABLE FEED IS NOT AUTHORITATIVE: nothing is asserted empty while the feed cannot be read",
  feedAuthoritative({ snapshot: { asOf: NOW, members: [] }, unreadable: "x" }) === false);

// The over-correction this could invite is discarding the snapshot, which would throw away a true
// fact: `asOf` means "when we last read successfully", and that is exactly what it should keep
// meaning. The same trap the read path already passes, one layer up.
{
  const store = createStore<DashboardState>(structuredClone(initialState));
  const ctl = createController(store, httpApi((async () => { throw new Error("not expected"); }) as typeof fetch));
  ctl.onMembership({ asOf: NOW, members: [] });
  ctl.onMembershipFailed(REASON);
  check("an unreadable feed still records WHEN it was last read successfully (asOf is not discarded)",
    store.get().membership.snapshot?.asOf === NOW, store.get().membership);
  check("...and it does say it is unreadable, so the state is marked rather than erased",
    store.get().membership.unreadable === REASON, store.get().membership);
}

console.log(`\nMEMBERSHIP REFUSAL SMOKE OK ✅  (${pass} passed, 0 failed)`);
