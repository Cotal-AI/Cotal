/**
 * AN AGENT'S SESSION IS HELD ONLY WHILE A VIEW OF IT IS OPEN, AND HELD BOUNDED.
 *
 * The owner's rule for the session view: subscribe per agent on demand, refcounted, at most 2,000
 * events per agent in the browser. The server forwards an agent's frames only to the feeds that
 * watch it, so the page watches when the first view of an agent opens and unwatches when the last
 * one closes. These cells drive the shipped controller over a fake `Api` (`controller-harness.ts`)
 * and read what it asked the server for and what it wrote to the store.
 *
 * WHAT THIS DOES NOT CLAIM. No server, no broker, no rendering. The routes are `smoke:web-http-api`,
 * the server's forwarding is `smoke:web-agent-session-live`, and the fold of frames into steps is
 * `smoke:web-session`. The frames here are built as the emitter publishes them and folded by the
 * shipped `framesOf`, so no cell depends on how a frame's id is spelled.
 *
 * Run: pnpm smoke:web-session-store
 */
import type { AgentEventsPage, CotalMessage, FeedMessage, RosterEntry } from "../client/src/api/types.js";
import { rosterRows } from "../client/src/lib/roster.js";
import { eventCount } from "../client/src/lib/session.js";
import type { Api } from "../client/src/state/controller.js";
import type { StoredMessage } from "../client/src/state/types.js";
import { gate, harness } from "./controller-harness.js";

let cells = 0;
let failed = 0;
const ok = (name: string, cond: boolean, detail?: unknown): void => {
  cells++;
  if (cond) return;
  failed++;
  console.log(`  x FAIL  ${name}${detail === undefined ? "" : `: ${JSON.stringify(detail)}`}`);
};

const A = "local.abc";
const B = "local.def";

/** Lets every pending request and the store writes after it run. */
const flush = async () => {
  for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
};

/** A frame message as the connector's emitter publishes it on `events.<owner>.<actor>`. */
const frameMsg = (id: string, ts: number, events: unknown[] = [{ type: "RUN_STARTED", runId: "r" }]): CotalMessage =>
  ({
    id,
    ts,
    space: "main",
    from: { id: A },
    channel: "events.local.abc",
    parts: [{ kind: "ag-ui.frame", protocol: "ag-ui/1", threadId: "t", runId: "r", epoch: 1, seq: 1, events }],
  }) as unknown as CotalMessage;

/** A chat message from `from`. */
const chat = (id: string, ts: number, from = A): CotalMessage =>
  ({ id, ts, space: "main", from: { id: from }, channel: "team", parts: [{ kind: "text", text: "hi" }] }) as unknown as CotalMessage;

const card = (id: string, meta?: Record<string, unknown>): RosterEntry =>
  ({ card: { id, name: id.split(".")[1], kind: "agent", ...(meta ? { meta } : {}) }, status: "working", ts: 1 }) as unknown as RosterEntry;

/** A fake of the three session routes that records each call, in order. `read` answers each read. */
function sessionApi(read: (id: string, limit: number) => Promise<AgentEventsPage> | AgentEventsPage = () => ({ frames: [], more: false })) {
  const calls: string[] = [];
  const api: Partial<Api> = {
    agentEvents: async (id, limit) => {
      calls.push(`read ${id} ${limit}`);
      return read(id, limit);
    },
    watch: async (id, feed) => void calls.push(`watch ${id} ${feed}`),
    unwatch: async (id, feed) => void calls.push(`unwatch ${id} ${feed}`),
  };
  return { calls, api };
}

// ── 1. ONE WATCH AND ONE READ PER AGENT, HOWEVER MANY VIEWS ──────────────────────────────────────
{
  const { calls, api } = sessionApi();
  const h = harness(api);
  h.ctl.onHello("feed-1");
  h.ctl.openSession(A);
  h.ctl.openSession(A);
  await flush();
  ok("1.1 two openSession calls for one agent watch once and read once",
    JSON.stringify(calls) === JSON.stringify([`watch ${A} feed-1`, `read ${A} 200`]) && h.store.get().sessions[A]?.views === 2, { calls, s: h.store.get().sessions[A] });
  h.ctl.closeSession(A);
  await flush();
  ok("1.2 one closeSession of two views keeps the session and unwatches nothing",
    h.store.get().sessions[A]?.views === 1 && !calls.some((c) => c.startsWith("unwatch")), { calls, s: h.store.get().sessions[A] });
  h.ctl.closeSession(A);
  await flush();
  ok("1.3 the second closeSession unwatches the agent and deletes its session",
    !(A in h.store.get().sessions) && calls.at(-1) === `unwatch ${A} feed-1`, { calls, sessions: Object.keys(h.store.get().sessions) });
  h.ctl.onAgentFrame({ id: A, msg: frameMsg("late", 9) });
  ok("1.4 a frame that arrives after the close does not bring the session back", !(A in h.store.get().sessions), Object.keys(h.store.get().sessions));
}

// ── 2. THE WATCH GOES FIRST, so no frame falls between the read and the watch ────────────────────
{
  const watched = gate<void>();
  const { calls, api } = sessionApi();
  const h = harness({ ...api, watch: async (id, feed) => { calls.push(`watch ${id} ${feed}`); await watched.promise; } });
  h.ctl.onHello("feed-1");
  h.ctl.openSession(A);
  await flush();
  const whileWatching = calls.slice();
  watched.resolve();
  await flush();
  ok("2.1 the watch is issued before the read, and the read waits for the watch to be answered",
    JSON.stringify(whileWatching) === JSON.stringify([`watch ${A} feed-1`])
      && JSON.stringify(calls) === JSON.stringify([`watch ${A} feed-1`, `read ${A} 200`]),
    { whileWatching, calls });
  ok("2.2 and the session reads loading until the read lands, then ok", h.store.get().sessions[A]?.load === "ok", h.store.get().sessions[A]);
}
{
  const { calls, api } = sessionApi();
  const h = harness(api);
  h.ctl.openSession(A);
  await flush();
  ok("2.3 with no feed id yet the session is read without a watch", JSON.stringify(calls) === JSON.stringify([`read ${A} 200`]), calls);
  h.ctl.closeSession(A);
  await flush();
  ok("2.4 and closing it unwatches nothing, since nothing was watched", calls.length === 1, calls);
}
{
  const watched = gate<void>();
  const { calls, api } = sessionApi();
  const h = harness({ ...api, watch: async (id, feed) => { calls.push(`watch ${id} ${feed}`); await watched.promise; } });
  h.ctl.onHello("feed-1");
  h.ctl.openSession(A);
  await flush();
  h.ctl.closeSession(A);
  await flush();
  const beforeAnswer = calls.slice();
  watched.resolve();
  await flush();
  ok("2.5 a close while the watch is in flight sends its unwatch only after the watch is answered, and reads nothing",
    JSON.stringify(beforeAnswer) === JSON.stringify([`watch ${A} feed-1`])
      && JSON.stringify(calls) === JSON.stringify([`watch ${A} feed-1`, `unwatch ${A} feed-1`]),
    { beforeAnswer, calls });
}

// ── 3. AN AGENT WITH NO EVENT PLANE IS NEITHER WATCHED NOR READ ──────────────────────────────────
{
  const { calls, api } = sessionApi();
  const h = harness(api);
  h.ctl.onRoster([card(A, { "ai.cotal.events": "off" })]);
  h.ctl.onHello("feed-1");
  h.ctl.openSession(A);
  await flush();
  const s = h.store.get().sessions[A];
  ok("3.1 an agent whose row says off is neither watched nor read and ends ok", calls.length === 0 && s?.load === "ok" && s.more === false, { calls, s });
  await h.ctl.reloadSession(A);
  await h.ctl.loadEarlier(A);
  h.ctl.onHello("feed-2");
  h.ctl.closeSession(A);
  await flush();
  ok("3.2 nor does a reload, Load earlier, a reconnect or the close ask the server anything about it", calls.length === 0, calls);
}

// ── 4. LIVE FRAMES ───────────────────────────────────────────────────────────────────────────────
{
  const { api } = sessionApi(() => ({ frames: [frameMsg("h1", 10)], more: false }));
  const h = harness(api);
  h.ctl.onHello("feed-1");
  h.ctl.openSession(A);
  await flush();
  const held = h.store.get().sessions[A]!.frames.length;
  h.ctl.onAgentFrame({ id: A, msg: frameMsg("f1", 20) });
  const after = h.store.get().sessions[A]!.frames;
  ok("4.1 a live frame for a watched agent is appended with live: true",
    held > 0 && after.length > held && after.at(-1)!.live === true && after.at(-1)!.ts === 20 && after.slice(0, held).every((f) => f.live === false),
    { held, after });
  h.ctl.onAgentFrame({ id: B, msg: frameMsg("f2", 21) });
  ok("4.2 a live frame for an agent with no session is dropped", !(B in h.store.get().sessions), Object.keys(h.store.get().sessions));
  const before = h.store.get().sessions[A]!.frames;
  h.ctl.onAgentFrame({ id: A, msg: frameMsg("h1", 10) });
  ok("4.3 a frame already held from history is not added twice", h.store.get().sessions[A]!.frames === before, h.store.get().sessions[A]!.frames.length);
}
{
  let answer: CotalMessage[] = [];
  const { api } = sessionApi(() => ({ frames: answer, more: false }));
  const h = harness(api);
  h.ctl.onHello("feed-1");
  h.ctl.openSession(A);
  await flush();
  h.ctl.onAgentFrame({ id: A, msg: frameMsg("c", 30) });
  answer = [frameMsg("a", 10), frameMsg("b", 20), frameMsg("c", 30)];
  await h.ctl.reloadSession(A);
  const frames = h.store.get().sessions[A]!.frames;
  ok("4.4 a history read unions with what is held, in time order, and the frame held live keeps its live copy",
    JSON.stringify(frames.map((f) => [f.ts, f.live])) === JSON.stringify([[10, false], [20, false], [30, true]]), frames);
}

// ── 5. A RECONNECT WATCHES EVERY OPEN SESSION AGAIN ──────────────────────────────────────────────
{
  let answer: CotalMessage[] = [frameMsg("a", 10)];
  const { calls, api } = sessionApi(() => ({ frames: answer, more: true }));
  const h = harness(api);
  h.ctl.onHello("feed-1");
  h.ctl.openSession(A);
  h.ctl.openSession(B);
  await flush();
  await h.ctl.loadEarlier(A);
  calls.length = 0;
  answer = [frameMsg("a", 10), frameMsg("missed", 15)];
  h.ctl.onHello("feed-2");
  await flush();
  ok("5.1 onHello after a reconnect watches every open session on the new feed and re-reads each at its limit",
    JSON.stringify(calls.slice().sort()) === JSON.stringify([`read ${A} 400`, `read ${B} 200`, `watch ${A} feed-2`, `watch ${B} feed-2`])
      && calls.indexOf(`watch ${A} feed-2`) < calls.indexOf(`read ${A} 400`),
    calls);
  ok("5.2 and the re-read merges in a frame the old feed missed", h.store.get().sessions[A]!.frames.map((f) => f.ts).join() === "10,15", h.store.get().sessions[A]!.frames);
  h.ctl.closeSession(A);
  await flush();
  ok("5.3 a session closed after the reconnect unwatches on the new feed", calls.at(-1) === `unwatch ${A} feed-2`, calls);
}

// ── 6. LOAD EARLIER AND TRY AGAIN ────────────────────────────────────────────────────────────────
{
  let more = true;
  const { calls, api } = sessionApi((_id, limit) => ({ frames: [frameMsg(`m${limit}`, limit)], more }));
  const h = harness(api);
  h.ctl.onHello("feed-1");
  h.ctl.openSession(A);
  await flush();
  calls.length = 0;
  await h.ctl.loadEarlier(A);
  ok("6.1 loadEarlier reads at 400 after the first read at 200", JSON.stringify(calls) === JSON.stringify([`read ${A} 400`]) && h.store.get().sessions[A]?.limit === 400, calls);
  for (let i = 0; i < 12; i++) await h.ctl.loadEarlier(A);
  const limits = calls.map((c) => Number(c.split(" ")[2]));
  ok("6.2 loadEarlier steps by 200 and never reads above 2000",
    JSON.stringify(limits) === JSON.stringify([400, 600, 800, 1000, 1200, 1400, 1600, 1800, 2000]) && h.store.get().sessions[A]?.limit === 2000, limits);
  calls.length = 0;
  await h.ctl.reloadSession(A);
  ok("6.3 reloadSession reads again at the session's current limit, watching first", JSON.stringify(calls) === JSON.stringify([`watch ${A} feed-1`, `read ${A} 2000`]), calls);
  more = false;
  const h2 = harness(api);
  h2.ctl.openSession(B);
  await flush();
  calls.length = 0;
  await h2.ctl.loadEarlier(B);
  ok("6.4 loadEarlier reads nothing when the channel holds no more", calls.length === 0 && h2.store.get().sessions[B]?.more === false, calls);
}
{
  const full = Array.from({ length: 2000 }, (_, i) => frameMsg(`e${i}`, i));
  const { calls, api } = sessionApi(() => ({ frames: full, more: true }));
  const h = harness(api);
  h.ctl.openSession(A);
  await flush();
  calls.length = 0;
  await h.ctl.loadEarlier(A);
  ok("6.5 loadEarlier reads nothing once the session holds 2,000 events", calls.length === 0 && eventCount(h.store.get().sessions[A]!.frames) === 2000, calls);
}

// ── 7. THE BOUND: at most 2,000 events per agent ─────────────────────────────────────────────────
{
  const many = Array.from({ length: 2001 }, (_, i) => frameMsg(`e${i}`, i));
  const { api } = sessionApi(() => ({ frames: many, more: false }));
  const h = harness(api);
  h.ctl.openSession(A);
  await flush();
  const s = h.store.get().sessions[A]!;
  ok("7.1 2,001 events drop the oldest frame and set more",
    eventCount(s.frames) === 2000 && s.frames[0]?.ts === 1 && s.frames.at(-1)?.ts === 2000 && s.more === true,
    { events: eventCount(s.frames), first: s.frames[0]?.ts, last: s.frames.at(-1)?.ts, more: s.more });
}
{
  const full = Array.from({ length: 2000 }, (_, i) => frameMsg(`e${i}`, i));
  const { api } = sessionApi(() => ({ frames: full, more: false }));
  const h = harness(api);
  h.ctl.openSession(A);
  await flush();
  const at = h.store.get().sessions[A]!;
  h.ctl.onAgentFrame({ id: A, msg: frameMsg("live", 5000) });
  const s = h.store.get().sessions[A]!;
  ok("7.2 a live frame past the cap drops the oldest frame too and sets more",
    at.more === false && eventCount(s.frames) === 2000 && s.frames[0]?.ts === 1 && s.frames.at(-1)?.ts === 5000 && s.more === true,
    { events: eventCount(s.frames), first: s.frames[0]?.ts, more: s.more });
}

// ── 8. A REFUSAL AND A FAILURE KEEP THE LAST GOOD DATA ───────────────────────────────────────────
{
  let read: () => AgentEventsPage = () => ({ frames: [frameMsg("a", 10)], more: false });
  const { api } = sessionApi(() => read());
  const h = harness(api);
  h.ctl.onHello("feed-1");
  h.ctl.openSession(A);
  await flush();
  read = () => ({ refused: "Permissions Violation for Subscription to \"cotal.main.chat.local.abc.events.local.abc\"", grant: "cotal mint watcher --profile agent --allow-subscribe 'events.local.abc' --provision" });
  await h.ctl.reloadSession(A);
  const s = h.store.get().sessions[A]!;
  ok("8.1 a refusal keeps the held frames and sets the broker's reason and the grant",
    s.load === "refused" && s.frames.length === 1 && s.reason?.startsWith("Permissions Violation") === true && s.grant?.startsWith("cotal mint watcher") === true, s);
  read = () => { throw new Error("local.abc events refused with HTTP 503: local.abc events: the read failed: boom"); };
  await h.ctl.reloadSession(A);
  const f = h.store.get().sessions[A]!;
  ok("8.2 a thrown read sets failed with its error, keeps the held frames and drops the grant",
    f.load === "failed" && f.frames.length === 1 && f.reason?.includes("the read failed: boom") === true && f.grant === undefined, f);
  read = () => ({ frames: [frameMsg("a", 10)], more: false });
  await h.ctl.reloadSession(A);
  const g = h.store.get().sessions[A]!;
  ok("8.3 a read that lands again clears the failure", g.load === "ok" && g.reason === undefined && g.grant === undefined, g);
}
{
  const { calls, api } = sessionApi();
  const h = harness({ ...api, watch: async (id, feed) => { calls.push(`watch ${id} ${feed}`); throw new Error(`watch ${id} refused with HTTP 400: unknown feed ${feed}`); } });
  h.ctl.onHello("feed-1");
  h.ctl.openSession(A);
  await flush();
  const s = h.store.get().sessions[A]!;
  ok("8.4 a refused watch fails the session with its reason and reads nothing",
    s.load === "failed" && s.reason?.includes("unknown feed feed-1") === true && !calls.some((c) => c.startsWith("read")), { calls, s });
}

// ── 9. THE AGENT'S OWN POSTS ─────────────────────────────────────────────────────────────────────
{
  const { api } = sessionApi();
  const h = harness(api);
  const verified: FeedMessage = { mode: "chat", channel: "team", senderId: A, msg: chat("p0", 5) };
  const historyRow: StoredMessage = { msg: chat("h0", 6) };
  const openVerified: StoredMessage = { msg: chat("p1", 7), senderId: A };
  const other: StoredMessage = { msg: chat("o1", 8, B), senderId: B };
  h.store.set({ activity: [verified, { mode: "chat", channel: "team", msg: chat("h1", 4) }], open: { channel: "team", messages: [historyRow, openVerified, other] } });
  h.ctl.openSession(A);
  await flush();
  const seeded = h.store.get().sessions[A]!.posts.map((p) => p.msg.id);
  ok("9.1 a session opens with the agent's verified chat posts the page already holds, oldest first", seeded.join() === "p0,p1", seeded);
  h.ctl.onMessage({ mode: "chat", channel: "team", senderId: A, msg: chat("p2", 9) });
  const posts = h.store.get().sessions[A]!.posts;
  ok("9.2 a verified chat row from the agent lands in posts", posts.at(-1)?.msg.id === "p2" && posts.at(-1)?.senderId === A, posts.map((p) => p.msg.id));
  h.ctl.onMessage({ mode: "chat", channel: "team", msg: chat("p3", 10) });
  ok("9.3 a history row from the agent (no senderId) does not land in posts, seeded or live",
    !h.store.get().sessions[A]!.posts.some((p) => p.msg.id === "h0" || p.msg.id === "h1" || p.msg.id === "p3"), h.store.get().sessions[A]!.posts.map((p) => p.msg.id));
  h.ctl.onMessage({ mode: "unicast", senderId: A, msg: { ...chat("d1", 11), to: "local.op" } as unknown as CotalMessage });
  ok("9.4 a DM from the agent does not land in posts", !h.store.get().sessions[A]!.posts.some((p) => p.msg.id === "d1"), h.store.get().sessions[A]!.posts.map((p) => p.msg.id));
  h.ctl.onMessage({ mode: "chat", channel: "team", senderId: A, msg: chat("p2", 9) });
  ok("9.5 a post delivered twice is kept once", h.store.get().sessions[A]!.posts.filter((p) => p.msg.id === "p2").length === 1);
  for (let i = 0; i < 520; i++) h.ctl.onMessage({ mode: "chat", channel: "team", senderId: A, msg: chat(`n${i}`, 100 + i) });
  const capped = h.store.get().sessions[A]!.posts;
  ok("9.6 posts keep the newest 500", capped.length === 500 && capped.at(-1)?.msg.id === "n519" && capped[0]?.msg.id === "n20", { n: capped.length, first: capped[0]?.msg.id });
  h.ctl.onMessage({ mode: "chat", channel: "team", senderId: B, msg: chat("b1", 1000, B) });
  ok("9.7 a post from an agent with no session opens none", !(B in h.store.get().sessions));
}

// ── 10. THE CARD'S EVENT PLANE FLAG ──────────────────────────────────────────────────────────────
{
  const rows = rosterRows([
    card("local.on", { "ai.cotal.events": "on" }),
    card("local.off", { "ai.cotal.events": "off" }),
    card("local.bool", { "ai.cotal.events": true }),
    card("local.yes", { "ai.cotal.events": "yes" }),
    card("local.none", {}),
    card("local.nometa"),
  ]);
  const by = (id: string) => rows.find((r) => r.id === id);
  ok("10.1 rosterRows reads on and off from the card's ai.cotal.events", by("local.on")?.events === "on" && by("local.off")?.events === "off", rows);
  ok("10.2 and leaves events absent for true, \"yes\", or no key",
    ["local.bool", "local.yes", "local.none", "local.nometa"].every((id) => by(id) !== undefined && !("events" in by(id)!)), rows);
}

console.log(failed === 0 ? `web session store: ${cells} cells OK` : `web session store: ${failed}/${cells} FAILED`);
process.exit(failed === 0 ? 0 : 1);
