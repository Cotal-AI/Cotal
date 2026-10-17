/**
 * One agent's event plane, served on demand: the pure half.
 *
 * The live tap receives every agent's frames, because an event channel is a chat channel and the
 * observer taps `chat.>`. What this suite holds is who they reach: `classifyTap` sends a frame on a
 * principal-shaped event channel as an `agent-frame` and never as a `message`, and `SessionWatchers`
 * is the refcount that decides which feeds get it. The history read is `agentEventsPage`, which reads
 * one more than it answers so a session view knows whether to offer Load earlier, answers a broker
 * refusal as data, and is bounded by a deadline.
 *
 * Everything here is called directly. `agent-session-live.smoke.ts` drives the same code through the
 * shipped server against a broker.
 *
 * Run: pnpm smoke:web-agent-session
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { chatSubject, spacePrefix, type CotalMessage } from "@cotal-ai/core";
import {
  AgentEventsLate,
  BadRequest,
  SessionWatchers,
  agentEventsPage,
  agentIdFromPath,
  classifyTap,
  eventsGrantFor,
  writeFeed,
} from "../src/web.js";

let cells = 0;
let failed = 0;
const ok = (name: string, cond: boolean, detail?: unknown): void => {
  cells++;
  if (cond) {
    console.log(`  ok ${name}`);
    return;
  }
  failed++;
  console.log(`  x FAIL ${name}${detail === undefined ? "" : `: ${JSON.stringify(detail)}`}`);
};
/** What a call threw, or `undefined` when it returned. */
const thrown = (f: () => unknown): unknown => {
  try {
    f();
    return undefined;
  } catch (e) {
    return e;
  }
};

const SPACE = "s";
let n = 0;
const msg = (channel?: string): CotalMessage =>
  ({
    id: `m${++n}`,
    ts: 1000 + n,
    space: SPACE,
    from: { id: "local.abc", name: "abc", role: "agent" },
    parts: [{ kind: "text", text: "hi" }],
    ...(channel === undefined ? {} : { channel }),
  }) as CotalMessage;

console.log("agent-session smoke");

// ── 1. the tap: a frame is an agent frame, everything else is a message ─────────────────────────
console.log("1. classifyTap");
{
  const frame = msg("events.local.abc");
  const onEvents = classifyTap(chatSubject(SPACE, "local", "abc", "events.local.abc"), frame);
  ok("1.1 a chat message on events.local.abc is an agent-frame for local.abc, not a message",
    onEvents?.event === "agent-frame" && onEvents.agent === "local.abc", onEvents);
  ok("1.2 the agent frame carries the agent's id and the message, nothing else",
    onEvents?.event === "agent-frame" && JSON.stringify(onEvents.data) === JSON.stringify({ id: "local.abc", msg: frame }), onEvents);

  const standup = classifyTap(chatSubject(SPACE, "local", "abc", "events.standup"), msg("events.standup"));
  ok("1.3 events.standup is not principal-shaped, so it stays a message on its channel",
    standup?.event === "message" && standup.data.channel === "events.standup" && standup.data.mode === "chat", standup);
  const notes = classifyTap(chatSubject(SPACE, "local", "abc", "events.my-team.notes"), msg("events.my-team.notes"));
  ok("1.4 events.my-team.notes has a hyphen in its owner, so it stays a message",
    notes?.event === "message" && notes.data.channel === "events.my-team.notes", notes);

  const team = msg("team");
  const chat = classifyTap(chatSubject(SPACE, "local", "abc", "team"), team);
  ok("1.5 an ordinary chat message keeps today's fields: mode, the verified sender, the policed channel and the message",
    chat?.event === "message" && JSON.stringify(chat.data) === JSON.stringify({ mode: "chat", senderId: "local.abc", channel: "team", msg: team }), chat);

  const dm = msg();
  const unicast = classifyTap(`${spacePrefix(SPACE)}.inst.local.bob.local.abc`, dm);
  ok("1.6 a unicast stays a message, with its sender and no channel",
    unicast?.event === "message" && unicast.data.mode === "unicast" && unicast.data.senderId === "local.abc"
      && unicast.data.channel === undefined && unicast.data.msg === dm, unicast);
  const task = msg();
  const anycast = classifyTap(`${spacePrefix(SPACE)}.svc.reviewer.local.abc`, task);
  ok("1.7 an anycast stays a message, with its sender and no channel",
    anycast?.event === "message" && anycast.data.mode === "anycast" && anycast.data.senderId === "local.abc"
      && anycast.data.channel === undefined && anycast.data.msg === task, anycast);

  ok("1.8 a subject with no message gives null",
    classifyTap(chatSubject(SPACE, "local", "abc", "events.local.abc"), undefined) === null);
  ok("1.9 a subject that is no delivery plane gives null", classifyTap(`${spacePrefix(SPACE)}.ctl.manager.local.abc`, msg()) === null);

  const forged = classifyTap(chatSubject(SPACE, "local", "mallory", "events.local.abc"), msg("events.local.abc"));
  ok("1.10 a frame on events.local.abc published by local.mallory comes back null: not the agent's frame, and never a message",
    forged === null, forged);
}

// ── 2. the watch map: once per feed, per agent, and gone with its last watcher ──────────────────
console.log("2. SessionWatchers");
{
  const w = new SessionWatchers<string>();
  w.watch("local.abc", "A");
  w.watch("local.abc", "A");
  ok("2.1 two watches from one feed count once", JSON.stringify(w.targets("local.abc")) === JSON.stringify(["A"]), w.targets("local.abc"));
  w.unwatch("local.abc", "A");
  ok("2.2 so one unwatch releases it", w.targets("local.abc").length === 0 && !w.agents().includes("local.abc"), w.agents());
}
{
  const w = new SessionWatchers<string>();
  w.watch("local.abc", "A");
  w.watch("local.abc", "B");
  ok("2.3 two feeds give two targets", JSON.stringify([...w.targets("local.abc")].sort()) === JSON.stringify(["A", "B"]), w.targets("local.abc"));
  w.unwatch("local.abc", "A");
  ok("2.4 unwatch of one leaves the other", JSON.stringify(w.targets("local.abc")) === JSON.stringify(["B"]), w.targets("local.abc"));
  w.unwatch("local.abc", "C");
  w.unwatch("local.zzz", "B");
  ok("2.5 unwatching what is not watched changes nothing", JSON.stringify(w.targets("local.abc")) === JSON.stringify(["B"]) && w.agents().length === 1, w.agents());
}
{
  const w = new SessionWatchers<string>();
  w.watch("local.abc", "A");
  w.watch("local.def", "A");
  w.watch("local.abc", "B");
  w.drop("A");
  ok("2.6 drop removes a feed from every agent it watched",
    JSON.stringify(w.targets("local.abc")) === JSON.stringify(["B"]) && w.targets("local.def").length === 0,
    { abc: w.targets("local.abc"), def: w.targets("local.def") });
  ok("2.7 an agent with no feeds is absent from agents(), not present at zero",
    JSON.stringify(w.agents()) === JSON.stringify(["local.abc"]), w.agents());
  w.drop("B");
  ok("2.8 after the last feed drops, no agent is watched at all", w.agents().length === 0, w.agents());
}
{
  const w = new SessionWatchers<string>(2);
  w.watch("local.a", "A");
  w.watch("local.b", "A");
  const over = thrown(() => w.watch("local.c", "A"));
  ok("2.9 a feed already at the ceiling is refused a new agent as a bad request, and holds what it held",
    over instanceof BadRequest && w.targets("local.c").length === 0 && JSON.stringify(w.agents()) === JSON.stringify(["local.a", "local.b"]),
    { over: String(over), agents: w.agents() });
  ok("2.10 an agent it already watches is not a new one, so asking again is not refused",
    thrown(() => w.watch("local.a", "A")) === undefined);
  w.watch("local.c", "B");
  ok("2.11 the ceiling is per feed: another feed still watches", JSON.stringify(w.targets("local.c")) === JSON.stringify(["B"]));
}

// ── 3. the agent id out of the path ─────────────────────────────────────────────────────────────
console.log("3. agentIdFromPath");
{
  const plain = agentIdFromPath("local.abc");
  ok("3.1 local.abc passes as its owner and actor",
    JSON.stringify(plain) === JSON.stringify({ id: "local.abc", owner: "local", actor: "abc" }), plain);
  const encoded = thrown(() => agentIdFromPath("local%2Eabc")) ?? agentIdFromPath("local%2Eabc");
  ok("3.2 local%2Eabc is decoded first, then passes", JSON.stringify(encoded) === JSON.stringify({ id: "local.abc", owner: "local", actor: "abc" }), encoded);
  for (const bad of ["abc", "a.b.c", "a-b.c", "%zz", "", ".abc", "local."]) {
    const e = thrown(() => agentIdFromPath(bad));
    ok(`3.3 ${JSON.stringify(bad)} is a bad request, not an agent`, e instanceof BadRequest, String(e));
  }
  const why = String(thrown(() => agentIdFromPath("a-b.c")));
  ok("3.4 the refusal names the id it refused", why.includes("a-b.c"), why);
}

// ── 4. the history read ─────────────────────────────────────────────────────────────────────────
console.log("4. agentEventsPage");
/** A source that records every read it was asked for and answers with `answer`. */
const source = (answer: (opts: { limit: number; signal: AbortSignal }) => Promise<CotalMessage[]>) => {
  const asked: { channel: string; limit: number; signal: AbortSignal }[] = [];
  return {
    asked,
    channelHistory(channel: string, opts: { limit: number; signal: AbortSignal }) {
      asked.push({ channel, ...opts });
      return answer(opts);
    },
  };
};
const AGENT = { owner: "local", actor: "abc" };
const noGrant = () => undefined;
/** `count` stored frames, oldest first, and the newest `limit` of them a source hands back. */
const stored = (count: number) => Array.from({ length: count }, () => msg("events.local.abc"));
const newest = (all: CotalMessage[]) => (opts: { limit: number }) => Promise.resolve(all.slice(Math.max(0, all.length - opts.limit)));
{
  const all = stored(5);
  const src = source(newest(all));
  const page = await agentEventsPage(src, AGENT, 2, noGrant);
  ok("4.1 it asks for limit + 1 on events.<owner>.<actor>, and on no other channel",
    src.asked.length === 1 && src.asked[0].channel === "events.local.abc" && src.asked[0].limit === 3, src.asked);
  ok("4.2 more is true when limit + 1 came back", "more" in page && page.more === true, page);
  ok("4.3 the frames are the newest limit, oldest first",
    "frames" in page && JSON.stringify(page.frames.map((m) => m.id)) === JSON.stringify(all.slice(3).map((m) => m.id)),
    "frames" in page ? page.frames.map((m) => m.id) : page);

  const exact = stored(2);
  const atLimit = await agentEventsPage(source(newest(exact)), AGENT, 2, noGrant);
  ok("4.4 more is false when no more than limit came back, and every frame is kept",
    "more" in atLimit && atLimit.more === false && atLimit.frames.length === 2, atLimit);
  const fewer = await agentEventsPage(source(newest(stored(1))), AGENT, 200, noGrant);
  ok("4.5 a channel with fewer than the limit answers all of it, more false",
    "more" in fewer && fewer.more === false && fewer.frames.length === 1, fewer);
  const zero = await agentEventsPage(source(newest(stored(3))), AGENT, 0, noGrant);
  ok("4.6 a limit of zero answers no frames, and says more exist", "more" in zero && zero.more === true && zero.frames.length === 0, zero);
}
{
  const DENIED = 'Permissions Violation for Subscription to "cotal.s.chat.*.*.events.local.abc"';
  const grants: [string, string][] = [];
  const page = await agentEventsPage(source(() => Promise.reject(new Error(DENIED))), AGENT, 200,
    (channel, owner) => (grants.push([channel, owner]), "the grant")).catch((e: unknown) => ({ threw: String(e) }));
  ok("4.7 a denial answers { refused } with the error's text unchanged and the grant grantFor gave",
    JSON.stringify(page) === JSON.stringify({ refused: DENIED, grant: "the grant" }), page);
  ok("4.8 grantFor is asked for this agent's channel and owner",
    JSON.stringify(grants) === JSON.stringify([["events.local.abc", "local"]]), grants);
  const open = await agentEventsPage(source(() => Promise.reject(new Error(DENIED))), AGENT, 200, noGrant)
    .catch((e: unknown) => ({ threw: String(e) }));
  ok("4.9 with no grant to give, the answer has no grant field at all",
    JSON.stringify(open) === JSON.stringify({ refused: DENIED }), open);
}
{
  let signal: AbortSignal | undefined;
  const hang = source((opts) => {
    signal = opts.signal;
    return new Promise<CotalMessage[]>(() => {});
  });
  const t0 = Date.now();
  // The deadline's own timer is unref'd, as a long-lived server wants, and the hanging read holds
  // nothing, so this keeps the suite's process alive until the deadline has had its say.
  const keepAlive = setTimeout(() => {}, 5_000);
  const late = await agentEventsPage(hang, AGENT, 200, noGrant, 50).then(() => undefined, (e: unknown) => e);
  clearTimeout(keepAlive);
  ok("4.10 a read that hangs past the deadline throws AgentEventsLate", late instanceof AgentEventsLate, String(late));
  ok("4.11 and aborts the read's signal, so the pull stops", signal?.aborted === true);
  ok("4.12 at the deadline, not later", Date.now() - t0 < 2_000, Date.now() - t0);

  const boom = new Error("stream not found");
  const plain = await agentEventsPage(source(() => Promise.reject(boom)), AGENT, 200, noGrant).then(() => undefined, (e: unknown) => e);
  ok("4.13 a failure that is not a denial rethrows as it came", plain === boom, String(plain));
}

// ── 5. the grant command for each kind of mesh ──────────────────────────────────────────────────
console.log("5. eventsGrantFor");
{
  ok("5.1 a user-auth mesh grants with cotal actor grant, for this owner and channel",
    eventsGrantFor("user")("events.acme.bot", "acme")
      === "cotal actor grant <reader> --owner acme --scope '' --allow-subscribe 'events.acme.bot' --allow-publish ''");
  ok("5.2 a static mesh mints a watcher on the agent profile for this channel",
    eventsGrantFor("static")("events.acme.bot", "acme")
      === "cotal mint watcher --profile agent --allow-subscribe 'events.acme.bot' --provision");
  ok("5.3 an open mesh has no grant to give", eventsGrantFor("open")("events.acme.bot", "acme") === undefined);
}

// ── 6. a feed that falls behind is ended, not buffered without limit ────────────────────────────
console.log("6. writeFeed");
{
  /** A response whose unsent bytes are everything written to it, as on a link that takes nothing. */
  const stalled = () => {
    const out = { chunks: [] as string[], ended: false };
    return {
      out,
      get writableEnded() { return out.ended; },
      get writableLength() { return out.chunks.join("").length; },
      write(chunk: string) { out.chunks.push(chunk); return false; },
      end() { out.ended = true; },
    };
  };
  const res = stalled();
  writeFeed(res, "agent-frame", { id: "local.abc" }, "live", 100);
  ok("6.1 under the ceiling an event is written as one SSE frame and the feed stays open",
    JSON.stringify(res.out.chunks) === JSON.stringify(['event: agent-frame\ndata: {"id":"local.abc"}\n\n']) && !res.out.ended, res.out);
  // The backlog is now under the ceiling, so this event is written and leaves the feed past it.
  writeFeed(res, "agent-frame", { id: "local.abc", pad: "x".repeat(100) }, "live", 100);
  const behind = res.out.chunks.length === 2 && !res.out.ended && res.writableLength > 100;
  writeFeed(res, "agent-frame", { id: "local.abc", n: 3 }, "live", 100);
  const last = res.out.chunks[res.out.chunks.length - 1] ?? "";
  ok("6.2 a live event over a backlog past the ceiling is not written: the feed gets one overflow event with its reason, and is ended",
    behind && res.out.ended && res.out.chunks.length === 3 && last.startsWith("event: overflow\ndata: ")
      && typeof (JSON.parse(last.slice("event: overflow\ndata: ".length)) as { reason?: unknown }).reason === "string",
    res.out);
  writeFeed(res, "message", { n: 1 }, "live", 100);
  writeFeed(res, "roster", [], "snapshot", 100);
  ok("6.3 an ended feed takes nothing more, live or snapshot", res.out.chunks.length === 3, res.out.chunks.length);

  // One event larger than the ceiling on its own, such as one long chat message, over an empty backlog.
  const big = stalled();
  writeFeed(big, "message", { pad: "x".repeat(500) }, "live", 100);
  ok("6.4 one live event larger than the ceiling, over an empty backlog, is written and the feed stays open",
    big.out.chunks.length === 1 && big.out.chunks[0].startsWith("event: message\ndata: ") && !big.out.ended, big.out);

  // A big mesh's roster on connect: larger than the ceiling, then more opening state behind it.
  const opening = stalled();
  writeFeed(opening, "hello", { feed: "f1" }, "snapshot", 100);
  writeFeed(opening, "roster", [{ pad: "x".repeat(500) }], "snapshot", 100);
  writeFeed(opening, "presence-view", { pad: "y".repeat(500) }, "snapshot", 100);
  ok("6.5 the connect snapshots are never held to the ceiling: a roster larger than it, and the state after it, are written and the feed stays open",
    JSON.stringify(opening.out.chunks.map((c) => c.slice(0, c.indexOf("\n")))) === JSON.stringify(["event: hello", "event: roster", "event: presence-view"])
      && !opening.out.ended,
    opening.out.chunks.map((c) => c.slice(0, 40)));
}
{
  // The /feed route writes its opening state as snapshots and nothing else does. Read from the
  // shipped source, since the route closes over a live endpoint and cannot be called here.
  const source = readFileSync(fileURLToPath(new URL("../src/web.ts", import.meta.url)), "utf8");
  const route = source.slice(source.indexOf('if (path === "/feed") {'), source.indexOf("if (path === READINESS_PATH)"));
  const snapshots = [...route.matchAll(/send\(res, ([^,]+),[^;]*?, "snapshot"\)/g)].map((m) => m[1]);
  ok("6.6 the /feed route writes hello, the roster, the presence view and the membership seed (or its refusal) as snapshots",
    JSON.stringify(snapshots) === JSON.stringify(['"hello"', '"roster"', '"presence-view"', '"membership"', "MEMBERSHIP_READ_FAILED"]),
    snapshots);
  ok("6.7 and no live write anywhere else is marked a snapshot",
    (source.match(/"snapshot"\)/g) ?? []).length === 5, (source.match(/"snapshot"\)/g) ?? []).length);
}

console.log(`COTAL_SMOKE_SENTINEL cells=${cells} passed=${cells - failed} failed=${failed}`);
if (failed > 0) process.exit(1);
