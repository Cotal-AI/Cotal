// Read paths, moved verbatim from web.ts: client assets, activity aggregation, the session feed and its
// watchers, agent events and activity backfill. web.ts re-exports the public names.
import { existsSync, readdirSync } from "node:fs";
import { extname, join } from "node:path";
import {
  eventChannel,
  isEventChannel,
  isPermissionDenied,
  type CotalMessage,
} from "@cotal-ai/core";
import { BadRequest, classifyTap } from "./web-request.js";

/** The one condition name for "the membership read did not answer", shared by the HTTP body and the
 *  SSE event so a browser matches ONE token and a test asserts the same token the server emits.
 *  Exported so a test asserts the token the server emits rather than a restated copy. */
export const MEMBERSHIP_READ_FAILED = "membership-read-failed";

/** Content types for the files a client build contains. A file of any other type is not served,
 *  so a stray file dropped into the build directory never becomes a route. */
const CLIENT_TYPES: Record<string, string> = {
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".woff2": "font/woff2",
  ".svg": "image/svg+xml",
  ".png": "image/png",
};

/** One servable file of the client build. `immutable` marks a content-hashed asset, which a
 *  browser may cache forever because a new build gives it a new name. */
interface ClientFile { path: string; type: string; immutable: boolean }

/** The answer when the client build is missing: the server keeps serving the API and says what to
 *  do instead of serving nothing. It speaks to both readers who can meet it: in a source checkout
 *  the page has not been built yet, while an installed package always ships its page, so there the
 *  install itself is broken. */
export const CLIENT_NOT_BUILT =
  "the dashboard client is not built. In a source checkout, run `pnpm --filter @cotal-ai/web build`. " +
  "An installed @cotal-ai/web always ships its client, so this is a broken install: reinstall it with `cotal ext seed --force`.";

/** The classic script the page loads in its head, before the stylesheet, to put the saved theme on
 *  the root element before anything is drawn (`client/src/lib/themeBoot.ts`, written by the build). */
export const THEME_BOOT = "theme-boot.js";

/** The client build as an allow-list, read once at startup: the page at `/` (and `/graph`, so an
 *  old link opens the app), the theme boot script at `/theme-boot.js`, and the files directly inside
 *  `assets/`. Nothing else under `dir` is reachable, and no request path is ever joined onto the
 *  filesystem. The boot script's name carries no hash, so unlike the assets it is not cached for good. */
export function clientAssets(dir: string): Map<string, ClientFile> {
  const routes = new Map<string, ClientFile>();
  const index = join(dir, "index.html");
  if (!existsSync(index)) return routes;
  const page: ClientFile = { path: index, type: "text/html; charset=utf-8", immutable: false };
  routes.set("/", page);
  routes.set("/graph", page);
  const boot = join(dir, THEME_BOOT);
  if (existsSync(boot)) routes.set(`/${THEME_BOOT}`, { path: boot, type: CLIENT_TYPES[".js"], immutable: false });
  const assets = join(dir, "assets");
  if (!existsSync(assets)) return routes;
  for (const entry of readdirSync(assets, { withFileTypes: true })) {
    const type = entry.isFile() ? CLIENT_TYPES[extname(entry.name)] : undefined;
    if (type) routes.set(`/assets/${entry.name}`, { path: join(assets, entry.name), type, immutable: true });
  }
  return routes;
}

/** The answer to a static request: the file when the build has it, a 503 naming the build command
 *  when the build is missing and the page is asked for, otherwise a 404. A pure function of the
 *  route map and the path, so the 503 is testable without a server. */
export function clientResponse(
  routes: Map<string, ClientFile>,
  path: string,
): { status: 200; file: ClientFile } | { status: 503; body: { error: string } } | { status: 404 } {
  const file = routes.get(path);
  if (file) return { status: 200, file };
  if (routes.size === 0 && (path === "/" || path === "/graph")) return { status: 503, body: { error: CLIENT_NOT_BUILT } };
  return { status: 404 };
}

/** What the two backfill routes need from an endpoint. Narrow on purpose: it is the seam the filter
 *  is measured through, and a mock satisfying six methods it never calls would prove less. */
export interface ActivitySource {
  listChannels(): Promise<{ channel: string; messages: number; config?: unknown }[]>;
  multiChannelHistory(
    channels: readonly string[],
    opts: { limit: number; signal?: AbortSignal },
  ): Promise<{ channel: string; msg: CotalMessage }[]>;
  dmHistory(opts: { limit: number; signal?: AbortSignal }): Promise<CotalMessage[]>;
}

/** The channels this dashboard LISTS and BACKFILLS: chat only.
 *
 * WHY AN AGENT'S EVENT CHANNEL IS NOT ONE OF THEM. `listChannels()` derives a row from every
 * retained concrete subject and the chat stream caps per subject rather than by age, so the list
 * grows by one row per agent that has ever run and those rows never age out. Unfiltered, the channel
 * sidebar is buried under machine streams, the client's graph grows a hub node for each, and
 * `/api/activity` merges every event channel into a global top-N that a human reading chat did not
 * ask for, and pays to move those messages across the link first. That is a cost that scales with
 * the number of agents ever run, which is the wrong axis entirely.
 *
 * FILTERED BEFORE THE FETCH, NOT AFTER, AND THE ORDER IS THE CLAIM. Filtering the merged output
 * would still move every byte and then discard it. The activity backfill reads all of chat in
 * ONE stream read, and this classifier decides that read's FILTER SET, so an event channel is
 * dropped by the broker and never crosses the link at all. The console applies the identical rule at
 * the identical point (`mesh-view.ts` filters `listChannels()` before `channelHistory`), and the two
 * surfaces share this classifier rather than each spelling the convention, so they cannot disagree
 * about what a channel is.
 *
 * WHAT IS NOT FILTERED, DELIBERATELY, IN TWO PLACES. The live SSE tap still receives frames, and
 * sends each one as an `agent-frame` only to the feeds watching that agent (see {@link classifyTap}
 * and {@link SessionWatchers}), never as a `message` to every browser and never dropped for a
 * watcher. And `/api/channels/<name>/history` still serves an event channel
 * when a caller names one, because that route answers a question about a channel the caller already
 * identified; a filter there would mean the dashboard could render a frame it could never fetch. */
export function chatOnly<T extends { channel: string }>(rows: readonly T[]): T[] {
  return rows.filter((row) => !isEventChannel(row.channel));
}

/** How long one aggregating request may take before it answers with what it has.
 *
 *  WHY A DEADLINE AT ALL, with the measurement that set it. The cost of a history read is the link,
 *  not the broker. Against a local broker behind a 160ms-RTT, 128 KiB/s link with 40 channels and
 *  12000 messages, an unbounded aggregation reading one source per channel finished in 125ms for a
 *  reader ON the broker host and returned 500 `timeout` after 15.94s for the reader across the link;
 *  at a less constrained 256 KiB/s it SUCCEEDED after 34491ms, which is the same defect with a
 *  different ending. An unbounded aggregation has no answer for either case.
 *
 *  WHY ONE READ FOR ALL OF CHAT STILL NEEDS IT. A bound is not a repair for a read that is too
 *  expensive; it is what makes the surface answer at all when a link cannot serve a request in a
 *  useful time. Any read across any link can still be too slow, and a page that says what it is
 *  missing beats one that never arrives.
 *
 *  WHY THIS NUMBER. It is longer than a healthy remote read of this shape and far shorter than a
 *  reader will sit in front of a blank panel. It is not tuned to any one link: what makes the surface
 *  honest is that it always answers and always says what it left out, not that the bound is
 *  optimal. */
export const AGGREGATION_DEADLINE_MS = 8_000;

/** How many per-source reads are in flight at once.
 *
 *  WHY NOT ALL OF THEM. Every source shares ONE connection to ONE broker, so past the point where
 *  the link is saturated extra concurrency buys no throughput: it spreads the same bytes over more
 *  unfinished reads, and a read that is 90% done when the deadline fires contributes nothing.
 *
 *  THE NUMBER IS MEASURED, NOT PREFERRED, and the measurement includes what it costs. Corpus of 40
 *  channels, 12000 chat messages and 2000 DMs at 160ms RTT, sources answered inside the 8000ms
 *  deadline, three strategies, each arm on an idle link, one source per channel plus the DMs:
 *
 *      link          fan out all 41   pool of 8   pool of 1 widening on each completion
 *      1024 KiB/s          1             16                        3
 *       512 KiB/s          1              8                        3
 *       256 KiB/s          1              0                        3
 *       128 KiB/s          1              0                        1
 *
 *  The fan-out is the worst column at every speed: reading the whole set at once leaves the panel
 *  empty rather than short. A pool that starts at one and widens on each completed read was built and
 *  measured too, on the reasoning that it would adapt to a link it cannot know; it does not pay,
 *  because at a healthy link a single source is round-trip bound rather than throughput bound, so the
 *  first completion arrives too late to be useful evidence and the ramp costs more than the
 *  adaptation returns.
 *
 *  WITH TWO SOURCES IT DOES NOT BIND. The aggregation reads chat and DMs, so the pool never fills
 *  and this number chooses nothing for that source list. The bound is on the SHAPE (a cursor the
 *  workers pull from) rather than on a source count, so a third or a tenth source is pooled at this
 *  width instead of fanned out, the worst column above. */
export const AGGREGATION_CONCURRENCY = 8;

/** The sentinel a source resolves to when the deadline beat it. */
export const LATE = Symbol("late");

/** A promise that resolves at `ms`, plus the handle to cancel its timer. `unref` alone is not
 *  enough: an 8-second timer in a long-lived server would hold a poll's worth of state per request. */
export function deadline(ms: number): { until: Promise<typeof LATE>; signal: AbortSignal; done(): void } {
  const controller = new AbortController();
  let timer: NodeJS.Timeout;
  const until = new Promise<typeof LATE>((resolve) => {
    timer = setTimeout(() => {
      resolve(LATE);
      controller.abort(new DOMException(`history read deadline exceeded after ${ms}ms`, "AbortError"));
    }, ms);
    timer.unref();
  });
  return { until, signal: controller.signal, done: () => clearTimeout(timer) };
}

/** Race one source against the request's deadline. History sources receive the deadline signal, so
 *  a late JetStream read stops its pull iterator and deletes its ephemeral consumer instead of keeping
 *  the shared link busy after this response has moved on. */
export async function within<T>(p: Promise<T>, until: Promise<typeof LATE>): Promise<T | typeof LATE> {
  return Promise.race([p, until]);
}

/** The most bytes a feed may have waiting to be sent before the server gives up on it. A browser on
 *  a slow link, watching a busy agent, cannot take frames as fast as the tap produces them, and
 *  every byte it has not taken waits in this process. Past this the feed is told why and ended, and
 *  the browser's own reconnect opens a fresh one, watches again and reads the gap from history. */
const MAX_FEED_BUFFER_BYTES = 1_048_576;

/** What a feed write is. A `live` event is traffic the feed may fall behind on, so it is held to the
 *  ceiling. A `snapshot` is the state a feed is opened with (its hello, the roster, the presence view
 *  and the membership seed), written once on connect: a mesh whose roster alone is larger than the
 *  ceiling must still open, or every new feed would end at once and reconnect into the same end. */
export type FeedWrite = "live" | "snapshot";

/** The parts of a feed's response that `writeFeed` uses. `once` is the stream's own, used to learn
 *  when the opening state has drained; a response without it is warmed by the zero-backlog check. */
interface FeedResponse {
  readonly writableEnded: boolean;
  readonly writableLength: number;
  write(chunk: string): unknown;
  end(): unknown;
  once?(event: "drain", listener: () => void): unknown;
}

/** Each cold feed and the unsent bytes its opening snapshots left behind. A feed is cold from a
 *  snapshot write that leaves bytes unsent until its response emits `drain`, or a live write finds
 *  nothing unsent, and is warm after. A feed that has gone is dropped with its response. */
const coldFeeds = new WeakMap<object, number>();

/** The feed's opening state has drained: from here on a live event is held to the ceiling alone. */
function warmFeed(res: object): void {
  coldFeeds.delete(res);
}

/** Writes one SSE event to a feed. A feed that has ended takes nothing more.
 *
 *  A live event is checked against the backlog the feed already holds, measured BEFORE the write:
 *  when more than `ceiling` bytes are still unsent, the feed is told so with one `overflow` event
 *  `{ reason }` and ended, and the event is not written. Measuring after the write would end a feed
 *  for one event larger than the ceiling on its own, such as a single long chat message, which would
 *  disconnect every dashboard at once. So one large event over an empty backlog is written, and the
 *  feed ends only when it is in fact behind.
 *
 *  A snapshot is never checked. Its unsent bytes are not live traffic the feed fell behind on, so
 *  while they drain (the feed is cold) a live event is allowed them on top of the ceiling: on a slow
 *  link a roster over the ceiling would otherwise end the feed at its first live event, and every
 *  reconnect would end the same way. The allowance goes when the opening state has drained, so a
 *  cold feed still has a bound, its opening bytes plus the ceiling plus one event. */
export function writeFeed(
  res: FeedResponse,
  event: string,
  data: unknown,
  kind: FeedWrite = "live",
  ceiling: number = MAX_FEED_BUFFER_BYTES,
): void {
  if (res.writableEnded) return;
  const frame = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  if (kind === "snapshot") {
    res.write(frame);
    if (res.writableLength > 0) {
      if (!coldFeeds.has(res)) res.once?.("drain", () => warmFeed(res));
      coldFeeds.set(res, res.writableLength);
    }
    return;
  }
  if (res.writableLength === 0) warmFeed(res);
  const allowance = coldFeeds.get(res) ?? 0;
  if (res.writableLength > ceiling + allowance) {
    const reason = `this feed fell more than ${ceiling} bytes behind, so the server closed it; reconnect to resume`;
    res.write(`event: overflow\ndata: ${JSON.stringify({ reason })}\n\n`);
    res.end();
    return;
  }
  res.write(frame);
}

/** The state a feed opens with, in the order a browser needs it. */
interface FeedOpening {
  /** The feed's id, which every watch request names. */
  feed: string;
  roster: unknown;
  presenceView: unknown;
  /** Reads the current membership snapshot. The live tap carries only post-connect traffic, and
   *  membership is state, so a fresh feed needs it read for it. */
  membership(): Promise<unknown>;
}

/** Writes a new feed's opening state through `send`, every write a snapshot: `hello` first, so a
 *  browser can watch an agent before the roster arrives, then the roster and the presence view, then
 *  the membership seed once it is read, or its refusal when the read fails. Resolves when the seed
 *  is written. */
export function writeOpening(send: (event: string, data: unknown, kind: FeedWrite) => void, state: FeedOpening): Promise<void> {
  send("hello", { feed: state.feed }, "snapshot");
  send("roster", state.roster, "snapshot");
  send("presence-view", state.presenceView, "snapshot");
  return state.membership()
    .then((m) => send("membership", m, "snapshot"))
    .catch((e) => send(MEMBERSHIP_READ_FAILED, { reason: (e as Error).message }, "snapshot"));
}

/** The most agents one feed may watch at once. A watch is a row in a map this process holds for as
 *  long as the feed is open, and the id is the caller's, so without a ceiling one browser could
 *  grow that map without bound by asking for ids nobody runs. The dashboard watches the agent whose
 *  session is open, in the panel and the centre, so it never comes near this. */
const MAX_WATCHES_PER_FEED = 64;

/** Which feeds watch which agent. A feed is counted once per agent however many times it asks.
 *
 *  This is the refcount behind "subscribe on demand": the tap already receives every frame, so an
 *  agent with no watcher costs no browser anything, and an agent leaves the map with its last
 *  watcher. Both directions are kept so `drop` touches only the agents its feed held, and so the
 *  per-feed ceiling is a lookup rather than a scan. */
export class SessionWatchers<F> {
  private readonly byAgent = new Map<string, F[]>();
  private readonly byFeed = new Map<F, Set<string>>();

  constructor(private readonly perFeed: number = MAX_WATCHES_PER_FEED) {}

  /** Throws a BadRequest when the feed already watches `perFeed` other agents. */
  watch(agent: string, feed: F): void {
    const held = this.byFeed.get(feed) ?? new Set<string>();
    if (!held.has(agent) && held.size >= this.perFeed)
      throw new BadRequest(`this feed already watches ${this.perFeed} agents, the most one feed may watch at once`);
    const feeds = this.byAgent.get(agent) ?? [];
    if (!feeds.includes(feed)) feeds.push(feed);
    this.byAgent.set(agent, feeds);
    held.add(agent);
    this.byFeed.set(feed, held);
  }

  unwatch(agent: string, feed: F): void {
    const feeds = this.byAgent.get(agent);
    if (feeds !== undefined) {
      const rest = feeds.filter((f) => f !== feed);
      if (rest.length === 0) this.byAgent.delete(agent);
      else this.byAgent.set(agent, rest);
    }
    const held = this.byFeed.get(feed);
    if (held !== undefined) {
      held.delete(agent);
      if (held.size === 0) this.byFeed.delete(feed);
    }
  }

  /** A feed closed: forget every watch it held. */
  drop(feed: F): void {
    for (const agent of [...(this.byFeed.get(feed) ?? [])]) this.unwatch(agent, feed);
  }

  targets(agent: string): readonly F[] {
    return [...(this.byAgent.get(agent) ?? [])];
  }

  /** Agents with at least one watcher. An agent with none is absent, not zero. */
  agents(): string[] {
    return [...this.byAgent.keys()];
  }
}

/** The events read ran past its deadline. Its own type, so the route can tell it from a refusal
 *  (an answer) and from any other failure (a 503 with the reason). */
export class AgentEventsLate extends Error {}

/** A payload-only read failure leaves the independently read metadata available. */
export interface PayloadReadFailure {
  status: "timeout" | "refused" | "failed";
  reason: string;
}

/** One agent's newest frames within the deadline. Reads `limit + 1` from `events.<owner>.<actor>`
 *  with `channelHistory` and answers the newest `limit`, oldest first, with `more` when one more
 *  existed. A permission denial (`isPermissionDenied` from core) is an answer, `{ refused }` with the
 *  broker's own text and the grant command for this mesh. The deadline throws `AgentEventsLate`; any
 *  other failure rethrows.
 *
 *  SENDER-CHECKED LIKE THE LIVE FEED. The read names the agent as `publisher`, so it filters on the
 *  agent's own subject, `chat.<owner>.<actor>.events.<owner>.<actor>`, and a frame whose subject
 *  names another sender is never read. That is the check `classifyTap` makes on a live frame, so a
 *  session's history and its live frames hold the same frames. Like that check, it is as strong as
 *  the mesh's publish permissions: on an open mesh any raw NATS client can publish on this subject.
 *
 *  BOUNDED TWICE. The caller's `limit` is already capped at {@link MAX_HISTORY_LIMIT}, so one read
 *  holds at most one more message than that, and the read races the same deadline its siblings do,
 *  with the signal handed down so a late read stops its pull and drops its consumer.
 *
 *  `channelHistory`, not the mediated `readHistory`: the mediated read caps a page at 200 and has
 *  no cursor, and this is the same credential the channel history route already reads with. */
export async function agentEventsPage(
  source: {
    eventPayloadHistory?(owner: string, actor: string, opts: { limit: number; signal: AbortSignal }): Promise<CotalMessage[]>;
    channelHistory(channel: string, opts: { limit: number; signal: AbortSignal; publisher: { owner: string; actor: string } }): Promise<CotalMessage[]>;
  },
  agent: { owner: string; actor: string },
  limit: number,
  grantFor: (channel: string, owner: string) => string | undefined,
  deadlineMs: number = AGGREGATION_DEADLINE_MS,
): Promise<{ frames: CotalMessage[]; more: boolean; payloadRead?: PayloadReadFailure } | { refused: string; grant?: string }> {
  const channel = eventChannel(agent);
  const clock = deadline(deadlineMs);
  try {
    const publisher = { owner: agent.owner, actor: agent.actor };
    const page = await within(source.channelHistory(channel, { limit: limit + 1, signal: clock.signal, publisher }), clock.until);
    if (page === LATE) throw new AgentEventsLate(`${channel}: the read did not finish within ${deadlineMs}ms`);
    let payloads: CotalMessage[] = [];
    let payloadRead: PayloadReadFailure | undefined;
    if (source.eventPayloadHistory) {
      try {
        const result = await within(source.eventPayloadHistory(agent.owner, agent.actor, { limit: limit + 1, signal: clock.signal }), clock.until);
        if (result !== LATE) payloads = result;
        else payloadRead = { status: "timeout", reason: "Tool payload read timed out. Try again." };
      } catch (e) {
        payloadRead = clock.signal.aborted
          ? { status: "timeout", reason: "Tool payload read timed out. Try again." }
          : isPermissionDenied(e)
            ? { status: "refused", reason: "Tool payload read refused. Ask the mesh owner to check payload access." }
            : { status: "failed", reason: "Tool payload read failed. Try again." };
      }
    }
    const seen = new Set<string>();
    const tail = (rows: CotalMessage[]) => limit === 0 ? [] : rows.slice(-limit);
    const merged = [...tail(page), ...tail(payloads)].filter(msg => {
      if (seen.has(msg.id)) return false;
      seen.add(msg.id);
      return true;
    }).sort((a, b) => a.ts - b.ts);
    const more = page.length > limit || payloads.length > limit;
    return { frames: merged, more, ...(payloadRead === undefined ? {} : { payloadRead }) };
  } catch (e) {
    if (e instanceof AgentEventsLate) throw e;
    if (isPermissionDenied(e)) {
      const grant = grantFor(channel, agent.owner);
      return { refused: e instanceof Error ? e.message : String(e), ...(grant === undefined ? {} : { grant }) };
    }
    throw e;
  } finally {
    clock.done();
  }
}

/** The command that lets a reader see one agent's event channel, as `docs/connect-claude.md` gives
 *  it for each kind of mesh, or nothing on an open mesh, where there is no grant to give. */
export function eventsGrantFor(mode: "user" | "static" | "open"): (channel: string, owner: string) => string | undefined {
  if (mode === "user")
    return (channel, owner) => `cotal actor grant <reader> --owner ${owner} --scope '' --allow-subscribe '${channel}' --allow-publish ''`;
  if (mode === "static")
    return (channel) => `cotal auth mint watcher --profile agent --allow-subscribe '${channel}' --provision`;
  return () => undefined;
}

/** One aggregated page, and what it is missing. `partial` and the counts are ALWAYS present, so a
 *  page that ran out of time cannot be mistaken for a complete one by omission. */
export interface ActivityPage {
  entries: ({ mode: "chat"; channel: string; msg: CotalMessage } | { mode: "unicast"; msg: CotalMessage })[];
  /** True iff at least one source did not answer within the deadline. */
  partial: boolean;
  /** Sources that answered, out of sources asked. There are two of them: all of chat in one stream
   *  read, and the DM backlog. */
  read: number;
  of: number;
  /** Every source that did not answer, NAMED. A count alone tells a reader something is missing and
   *  not what, which on a dashboard is the difference between "the chat half of the feed is late"
   *  and "the space is empty". The names are those two sources rather than individual channels: one
   *  read either arrived or it did not, and {@link activityBackfill} says why at its source list. */
  missing: string[];
  /** Why each source in `missing` did not answer, keyed by its name. A read that ran out of time and
   *  a read that was refused (the client refusing a consumer create over `max_payload`, say) are
   *  different things for an operator to act on, and a name alone would make them the same bytes. */
  reasons: Record<string, string>;
  deadlineMs: number;
}

/** The all-activity backfill: recent chat history merged with DM history, oldest-first by `ts`,
 *  capped, and BOUNDED.
 *
 * Both sources, all of chat in one stream read and the DM backlog, race one shared deadline, so the
 * caller never waits on the slower read past it and one source's rejection never discards the
 * other's rows. Sources that answered are merged; sources that refused or ran late are NAMED in the
 * page. The page is never a 500 and never silently short.
 *
 * Separate from the route so the filter above is reachable by a test that can see WHICH channels
 * were asked for, which is the only evidence that separates filtering before the fetch from
 * filtering after it. The route is a thin caller. */
export async function activityBackfill(
  ep: ActivitySource,
  limit: number,
  deadlineMs: number = AGGREGATION_DEADLINE_MS,
  concurrency: number = AGGREGATION_CONCURRENCY,
): Promise<ActivityPage> {
  const clock = deadline(deadlineMs);
  try {
    // The channel list is inside the deadline too: it is a broker read like any other, and a request
    // that could hang here would be bounded everywhere except its first step. There is no partial
    // page to serve without it, so this one is a refusal rather than a partial: `0 of 0` would claim
    // the space has no channels, which is a different answer and the wrong one.
    //
    // BOTH ENDINGS ARE NAMED, and the second is why this is not just a `within` call. The registry
    // read has its OWN timeout inside the client, shorter than this deadline: measured across a
    // 128 KiB/s link it rejects with the broker's bare `timeout` after 5s, before the deadline can
    // fire, and unwrapped that word reaches the browser through the generic 500 handler as
    // `{"error":"timeout"}` - five characters of cause for a blank panel. A reader cannot act on a
    // refusal that does not say what failed, so the reason is wrapped in the name of the read that
    // produced it.
    const listed = await within(
      ep.listChannels().catch((e: unknown) => {
        throw new Error(`the channel list could not be read: ${e instanceof Error ? e.message : String(e)}`);
      }),
      clock.until,
    );
    if (listed === LATE)
      throw new Error(`the channel list did not arrive within ${deadlineMs}ms`);
    const chans = chatOnly(listed);

    // TWO SOURCES, NOT ONE PER CHANNEL. The chat half is ONE read of the CHAT stream filtered to
    // every chat channel at once (see `multiChannelHistory`), so the number of channels multiplies
    // no reads: it only lengthens the filter list the broker matches against, next to the data.
    // Each message is tagged with the channel the BROKER delivered it on, so the backfill path
    // still does not depend on the payload's own `channel` claim.
    //
    // WHAT THIS COSTS THE PARTIAL ENVELOPE, STATED RATHER THAN LEFT TO BE FOUND. `read`/`of` and
    // `missing` count and name these two sources, never individual channels: no channel can fail
    // separately, because one read either arrived or it did not. Naming fifty-three channels when a
    // single read ran late would be a fiction, so a reader is told which HALF of the feed is missing.
    type Src = { name: string; read: (signal: AbortSignal) => Promise<ActivityPage["entries"]> };
    const sources: Src[] = [
      {
        name: "chat",
        read: async (signal: AbortSignal) =>
          (await ep.multiChannelHistory(chans.map((ch) => ch.channel), { limit, signal }))
            .map(({ channel, msg }) => ({ mode: "chat" as const, channel, msg })),
      },
      {
        name: "direct messages",
        read: async (signal: AbortSignal) => (await ep.dmHistory({ limit, signal })).map((msg) => ({ mode: "unicast" as const, msg })),
      },
    ];

    // A POOL, NOT A FAN-OUT. Workers pull from a shared cursor, so at most `concurrency` reads are
    // in flight and the rest wait their turn. A worker that finds the deadline already past does not
    // start another read: the page is closed, and issuing broker work for it would be waste with a
    // guaranteed-discarded result.
    const settled: (ActivityPage["entries"] | typeof LATE)[] = new Array(sources.length).fill(LATE);
    const failed: (string | undefined)[] = new Array(sources.length);
    let next = 0;
    let expired = false;
    void clock.until.then(() => { expired = true; });
    const worker = async (): Promise<void> => {
      for (;;) {
        const i = next++;
        if (i >= sources.length || expired) return;
        try {
          const r = await within(sources[i].read(clock.signal), clock.until);
          if (r !== LATE) settled[i] = r;
        } catch (e) {
          // A source that FAILED is missing for the same reason a late one is: it has nothing to
          // contribute. It is named the same way, and the other source's rows still reach the page.
          // Its reason is kept, because a refusal and a timeout ask different things of an operator.
          failed[i] = e instanceof Error ? e.message : String(e);
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(concurrency, sources.length) }, worker));

    const entries: ActivityPage["entries"] = [];
    const missing: string[] = [];
    const reasons: Record<string, string> = {};
    for (let i = 0; i < settled.length; i++) {
      const r = settled[i];
      if (r === LATE) {
        missing.push(sources[i].name);
        reasons[sources[i].name] = failed[i] === undefined
          ? `the read did not finish within ${deadlineMs}ms`
          : `the read failed: ${failed[i]}`;
      } else entries.push(...r);
    }
    // THE PAGE IS ORDERED BY `ts`, AND THE CHAT HALF WAS CHOSEN BY ARRIVAL. The chat rows are the
    // newest `limit` by CHAT stream sequence, the order the broker stored them in, and the DM rows
    // are the newest `limit` of the DM stream. The two streams number their messages independently,
    // so the sender's `ts` is the only key both halves carry: it orders the merged page and makes the
    // final cut to `limit` across both. Where a sender's clock disagrees with arrival, two chat rows
    // can show in an order their arrival did not imply. The sort is stable, so rows with equal `ts`
    // keep the order the reads returned: chat in stream sequence, then DMs in stream sequence.
    entries.sort((a, b) => a.msg.ts - b.msg.ts);
    return {
      entries: entries.slice(-limit),
      partial: missing.length > 0,
      read: sources.length - missing.length,
      of: sources.length,
      missing,
      reasons,
      deadlineMs,
    };
  } finally {
    clock.done();
  }
}
