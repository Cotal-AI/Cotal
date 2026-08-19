import { spawn, type ChildProcess } from "node:child_process";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { closeSync, fstatSync, openSync, readFileSync, readSync, rmSync, statSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  CotalEndpoint,
  deliveryOf,
  isEventChannel,
  parseSubject,
  spacePrefix,
  mintCreds,
  newIdentity,
  clearChannel,
  type CotalMessage,
  type ParsedArgs,
} from "@cotal-ai/core";
import {
  c,
  connectOrExit,
  localProcessPath,
  userViewAuth,
  userViewAuthOrExit,
  type LocalProcess,
  type UserViewAuth,
} from "@cotal-ai/workspace";

const here = dirname(fileURLToPath(import.meta.url));

/** The dashboard's default port and its branded address. The server binds loopback
 *  (127.0.0.1) but serves any Host, so `cotal.localhost` — which Chrome/Firefox/Edge
 *  resolve to loopback with no DNS setup — just works. (Safari may not resolve
 *  `*.localhost`; plain http://127.0.0.1:7799 always does.) */
export const WEB_PORT = 7799;
export const WEB_URL = `http://cotal.localhost:${WEB_PORT}/`;
const DETACHED_READY_TIMEOUT_MS = 30_000;
const DETACHED_STOP_TIMEOUT_MS = 3_000;
const DETACHED_ROOT_ENV = "COTAL_WEB_DETACHED_ROOT";
export const webProcess: LocalProcess = {
  kind: "local-process",
  name: "web",
  label: "web dashboard",
  order: 40,
  pidFile: "web.pid",
  // The dashboard starts target-resolved from any directory and claims its pidfile under the
  // TARGET mesh's root (`conn.root` below); `cotal down web` must resolve the same mesh.
  rootedAt: "target",
};

function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Atomically claim this mesh's web pidfile so concurrent custom-port launches cannot overwrite it. */
function claimPid(path: string): void {
  let created = false;
  try {
    const fd = openSync(path, "wx", 0o600);
    created = true;
    try { writeFileSync(fd, String(process.pid)); } finally { closeSync(fd); }
  } catch (e) {
    if (created) rmSync(path, { force: true });
    if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    const raw = readFileSync(path, "utf8").trim();
    if (raw.startsWith("removing:")) {
      const owner = Number(raw.slice("removing:".length));
      throw new Error(
        pidAlive(owner)
          ? `web extension removal is in progress (pid ${owner})`
          : `web dashboard has a stale extension-removal reservation at ${path} - remove it and retry`,
      );
    }
    const prior = Number(raw);
    if (pidAlive(prior))
      throw new Error(`web dashboard is already running for this mesh (pid ${prior})`);
    throw new Error(`web dashboard has a stale pidfile at ${path} - clean it with \`cotal down web\`, then retry`);
  }
}

function releasePid(path: string): void {
  try {
    if (readFileSync(path, "utf8").trim() === String(process.pid)) rmSync(path, { force: true });
  } catch {
    // Already removed by `down` or another cleanup path.
  }
}

// Message bodies render markdown via marked + DOMPurify (parse + sanitize). Their browser builds are
// copied into dist/web/vendor at build time (scripts/copy-vendor.mjs) and served from the dashboard's
// OWN files, so a published/seeded copy is self-contained and never reaches into node_modules at
// runtime — which is what lets web ship as a bundled first-party extension, seeded like the connectors.
const jsType = "text/javascript; charset=utf-8";

/** The one condition name for "the membership read did not answer", shared by the HTTP body and the
 *  SSE event so a browser matches ONE token and a test asserts the same token the server emits.
 *  Exported for the same reason `PAGE` is: a test that restates it only agrees with itself. */
export const MEMBERSHIP_READ_FAILED = "membership-read-failed";

/** Exported so a test can resolve what the browser is actually served, rather than restating the
 *  route table in its own source and agreeing with itself. */
export const PAGE: Record<string, { path: string; type: string }> = {
  "/": { path: join(here, "web/index.html"), type: "text/html; charset=utf-8" },
  "/harness.js": { path: join(here, "web/harness.js"), type: jsType },
  // Shared message-part renderer for both pages. This map is an allow-list, so a page script that
  // depends on this file is broken until it has a row here, whatever the HTML requests.
  "/parts.js": { path: join(here, "web/parts.js"), type: jsType },
  // Registers an `ag-ui.frame` renderer into the map `parts.js` consults. Served to both pages: a
  // frame is as likely to arrive on the graph's detail row as in the console body, and a kind that
  // draws on one page and shows a marker on the other is worse than one that shows a marker on both.
  "/agui-frame.js": { path: join(here, "web/agui-frame.js"), type: jsType },
  // The shape-B bootstrap: this page taps live before it reads history, so a frame's `seq` order has
  // to be imposed by the consumer. Served to `/` only. The graph page reads the backfill into
  // transient glow and "recently active" buffers and keeps no feed a live arrival appends to, so it
  // has no merge to order; giving it the machine anyway would imply an ordering guarantee on a
  // surface where nothing consumes one.
  "/event-order.js": { path: join(here, "web/event-order.js"), type: jsType },
  // Keep-last-good + the refusal guard, shared by BOTH pages so they cannot disagree about what a
  // failed poll does to what is already on screen. Served to `/` and `/graph` alike: the wipe was
  // measured on the graph page and the corrupted feed on the console page, and one page keeping its
  // snapshot while the other drops it is the state this file exists to prevent.
  "/snapshot.js": { path: join(here, "web/snapshot.js"), type: jsType },
  "/md.js": { path: join(here, "web/md.js"), type: jsType },
  "/app.js": { path: join(here, "web/app.js"), type: jsType },
  "/graph": { path: join(here, "web/graph.html"), type: "text/html; charset=utf-8" },
  "/graph.js": { path: join(here, "web/graph.js"), type: jsType },
  "/vendor/marked.umd.js": { path: join(here, "web/vendor/marked.umd.js"), type: jsType },
  "/vendor/purify.min.js": { path: join(here, "web/vendor/purify.min.js"), type: jsType },
};

/** What the two backfill routes need from an endpoint. Narrow on purpose: it is the seam the filter
 *  is measured through, and a mock satisfying six methods it never calls would prove less. */
export interface ActivitySource {
  listChannels(): Promise<{ channel: string; messages: number; config?: unknown }[]>;
  channelHistory(channel: string, opts: { limit: number }): Promise<CotalMessage[]>;
  dmHistory(opts: { limit: number }): Promise<CotalMessage[]>;
}

/** The channels this dashboard LISTS and BACKFILLS: chat only.
 *
 * WHY AN AGENT'S EVENT CHANNEL IS NOT ONE OF THEM. `listChannels()` derives a row from every
 * retained concrete subject and the chat stream caps per subject rather than by age, so the list
 * grows by one row per agent that has ever run and those rows never age out. Unfiltered, the channel
 * sidebar is buried under machine streams, the graph page grows a hub node for each, and
 * `/api/activity` issues one `channelHistory` round trip per event channel and then merges the
 * results into a global top-N that a human reading chat did not ask for. That is a cost that scales
 * with the number of agents ever run, which is the wrong axis entirely.
 *
 * FILTERED BEFORE THE FETCH, NOT AFTER, AND THE ORDER IS THE CLAIM. Filtering the merged output
 * would still pay every round trip and then discard the bytes. The console applies the identical
 * rule at the identical point (`mesh-view.ts` filters `listChannels()` before `channelHistory`), and
 * the two surfaces share this classifier rather than each spelling the convention, so they cannot
 * disagree about what a channel is.
 *
 * WHAT IS NOT FILTERED, DELIBERATELY, IN TWO PLACES. The live SSE tap still carries frames, marked
 * rather than dropped: dropping them would delete the only traffic this release taught the surface
 * to draw, and delete it silently. And `/api/channels/<name>/history` still serves an event channel
 * when a caller names one, because that route answers a question about a channel the caller already
 * identified; a filter there would mean the dashboard could render a frame it could never fetch. */
export function chatOnly<T extends { channel: string }>(rows: readonly T[]): T[] {
  return rows.filter((row) => !isEventChannel(row.channel));
}

/** How long one aggregating request may take before it answers with what it has.
 *
 *  WHY A DEADLINE AT ALL, with the measurement that set it. `/api/activity` fans out one history
 *  read per channel, and the cost of a read is the link, not the broker. Against a local broker
 *  behind a 160ms-RTT, 128 KiB/s link with 40 channels and 12000 messages: the same aggregation
 *  finished in 125ms for a reader ON the broker host and returned 500 `timeout` after 15.94s for the
 *  reader across the link; at a less constrained 256 KiB/s it SUCCEEDED after 34491ms, which is the
 *  same defect with a different ending. An unbounded aggregation has no answer for either case.
 *
 *  WHY THIS NUMBER. It is longer than a healthy remote read of this shape (the measured
 *  `/api/channels` + a page per channel) and far shorter than a reader will sit in front of a blank
 *  panel. It is not tuned to any one link: what makes the surface honest is that it always answers
 *  and always says what it left out, not that the bound is optimal. */
export const AGGREGATION_DEADLINE_MS = 8_000;

/** How many per-source reads are in flight at once.
 *
 *  WHY NOT ALL OF THEM. Every source shares ONE connection to ONE broker, so past the point where
 *  the link is saturated extra concurrency buys no throughput: it spreads the same bytes over more
 *  unfinished reads, and a read that is 90% done when the deadline fires contributes nothing.
 *
 *  THE NUMBER IS MEASURED, NOT PREFERRED, and the measurement includes what it costs. Same corpus
 *  (40 channels, 12000 chat messages, 2000 DMs), 160ms RTT, sources answered inside the 8000ms
 *  deadline, three strategies, each arm on an idle link:
 *
 *      link          fan out all 41   pool of 8   pool of 1 widening on each completion
 *      1024 KiB/s          1             16                        3
 *       512 KiB/s          1              8                        3
 *       256 KiB/s          1              0                        3
 *       128 KiB/s          1              0                        1
 *
 *  The fan-out is the shape that shipped and it is the worst column at every speed: reading the whole
 *  set at once is why the panel was empty rather than short. A pool that starts at one and widens on
 *  each completed read was built and measured too, on the reasoning that it would adapt to a link it
 *  cannot know; it does not pay, because at a healthy link a single source is round-trip bound rather
 *  than throughput bound, so the first completion arrives too late to be useful evidence and the ramp
 *  costs more than the adaptation returns.
 *
 *  WHAT THIS BOUND DECLINES, stated rather than left to be discovered. Below roughly 500 KiB/s at
 *  this RTT and this corpus, no source completes inside the deadline, the page reports `0 of 41`, and
 *  the browser keeps what it already had and marks it stale. The fan-out returned ONE source there,
 *  so this trades a single channel's history for a response that is bounded and that says what it
 *  left out. On a link that cannot serve the request, saying so is the answer. */
export const AGGREGATION_CONCURRENCY = 8;

/** The sentinel a source resolves to when the deadline beat it. */
const LATE = Symbol("late");

/** A promise that resolves at `ms`, plus the handle to cancel its timer. `unref` alone is not
 *  enough: an 8-second timer in a long-lived server would hold a poll's worth of state per request. */
function deadline(ms: number): { until: Promise<typeof LATE>; done(): void } {
  let timer: NodeJS.Timeout;
  const until = new Promise<typeof LATE>((resolve) => {
    timer = setTimeout(() => resolve(LATE), ms);
    timer.unref();
  });
  return { until, done: () => clearTimeout(timer) };
}

/** Race one source against the request's deadline.
 *
 *  THE WORK IS ABANDONED, NOT CANCELLED, and that is stated rather than implied: a JetStream read in
 *  flight has no cancel, so a late read keeps running until it finishes and its ephemeral consumer is
 *  reclaimed by its own inactivity threshold. "Bounded" here means the RESPONSE is bounded. Claiming
 *  it bounds broker work would be the silent half of the defect this deadline exists to fix. */
async function within<T>(p: Promise<T>, until: Promise<typeof LATE>): Promise<T | typeof LATE> {
  return Promise.race([p, until]);
}

/** One aggregated page, and what it is missing. `partial` and the counts are ALWAYS present, so a
 *  page that ran out of time cannot be mistaken for a complete one by omission — the shape that made
 *  `{"error":"timeout"}` indistinguishable from data is exactly this mistake one layer up. */
export interface ActivityPage {
  entries: ({ mode: "chat"; channel: string; msg: CotalMessage } | { mode: "unicast"; msg: CotalMessage })[];
  /** True iff at least one source did not answer within the deadline. */
  partial: boolean;
  /** Sources that answered, out of sources asked (channels + the DM backlog). */
  read: number;
  of: number;
  /** Every source that did not answer, NAMED. A count alone tells a reader something is missing and
   *  not what, which on a dashboard is the difference between "one channel is slow" and "the space
   *  is empty". */
  missing: string[];
  deadlineMs: number;
}

/** The all-activity backfill: recent chat history merged with DM history, oldest-first, capped, and
 *  BOUNDED.
 *
 * WHAT CHANGED AND WHY, because the previous shape had two failure modes and no good one. It fanned
 * out under `Promise.all` and awaited the DM backlog after it, so (1) one channel's rejection
 * discarded every channel that had already answered and became the route's 500, and (2) there was no
 * upper bound at all: the caller waited for the slowest read however long that took. Measured across
 * a 160ms link, the first produced `500 {"error":"timeout"}` after 15.94s and the second produced a
 * 34-second success. Neither is an answer a dashboard can render.
 *
 * Now every source - each channel AND the DM backlog, which used to be serialized after them - races
 * one shared deadline. Sources that answered are merged; sources that refused or ran late are NAMED
 * in the page. The page is never a 500 and never silently short.
 *
 * Extracted from the route so the filter above is reachable by a test that can see WHICH channels
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
    // 128 KiB/s link it rejected with the broker's bare `timeout` after 5s, before the deadline
    // could fire, and that word travelled through the generic 500 handler to the browser as
    // `{"error":"timeout"}` - five characters of cause for a panel that went blank. A refusal the
    // reader cannot act on is the defect this change exists to remove, so the reason is wrapped in
    // the name of the read that produced it.
    const listed = await within(
      ep.listChannels().catch((e: unknown) => {
        throw new Error(`the channel list could not be read: ${e instanceof Error ? e.message : String(e)}`);
      }),
      clock.until,
    );
    if (listed === LATE)
      throw new Error(`the channel list did not arrive within ${deadlineMs}ms`);
    const chans = chatOnly(listed);

    type Src = { name: string; read: () => Promise<ActivityPage["entries"]> };
    const sources: Src[] = [
      ...chans.map((ch) => ({
        name: `#${ch.channel}`,
        // Each message is tagged with the channel this server REQUESTED, so the backfill path does
        // not depend on the payload claim either.
        read: async () =>
          (await ep.channelHistory(ch.channel, { limit })).map((msg) => ({ mode: "chat" as const, channel: ch.channel, msg })),
      })),
      {
        name: "direct messages",
        read: async () => (await ep.dmHistory({ limit })).map((msg) => ({ mode: "unicast" as const, msg })),
      },
    ];

    // A POOL, NOT A FAN-OUT. Workers pull from a shared cursor, so at most `concurrency` reads are
    // in flight and the rest wait their turn. A worker that finds the deadline already past does not
    // start another read: the page is closed, and issuing broker work for it would be waste with a
    // guaranteed-discarded result.
    const settled: (ActivityPage["entries"] | typeof LATE)[] = new Array(sources.length).fill(LATE);
    let next = 0;
    let expired = false;
    void clock.until.then(() => { expired = true; });
    const worker = async (): Promise<void> => {
      for (;;) {
        const i = next++;
        if (i >= sources.length || expired) return;
        try {
          const r = await within(sources[i].read(), clock.until);
          if (r !== LATE) settled[i] = r;
        } catch {
          // A source that FAILED is missing for the same reason a late one is: it has nothing to
          // contribute. It is named the same way, and it no longer takes the whole page with it.
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(concurrency, sources.length) }, worker));

    const entries: ActivityPage["entries"] = [];
    const missing: string[] = [];
    for (let i = 0; i < settled.length; i++) {
      const r = settled[i];
      if (r === LATE) missing.push(sources[i].name);
      else entries.push(...r);
    }
    entries.sort((a, b) => a.msg.ts - b.msg.ts);
    return {
      entries: entries.slice(-limit),
      partial: missing.length > 0,
      read: sources.length - missing.length,
      of: sources.length,
      missing,
      deadlineMs,
    };
  } finally {
    clock.done();
  }
}

/** A live observability dashboard for a space, served over HTTP + SSE. A read-only
 *  observer endpoint (invisible to peers) feeds the page presence, channel history,
 *  and a live message stream — no manager required. Bound to loopback. */
export async function web(args: ParsedArgs): Promise<void> {
  const values = args.values as { space?: string; server?: string; port?: string; "no-open"?: boolean; detach?: boolean; creds?: string };
  // Resolve WHICH running mesh + creds (admin god-view: shows DMs + anycast), then DROP the account
  // seed. The dashboard is a loopback HTTP process; holding the space signing seed (`auth` — it can
  // mint ANY identity/role) for the whole session would make a dashboard compromise = full account
  // control. Instead pre-mint ONE scoped `channel-purger` cred for the only write path (channel delete
  // = filtered CHAT purge + a channel-registry key delete), then EXPLICITLY narrow the `Connection`
  // the request handlers close over so it no longer carries `auth` (see the drop below, just after
  // the mint). `--creds` / open mode have no seed → the connection creds carry the purge rights.
  //
  // This paragraph used to say the seed "falls out of scope here". IT DID NOT: `conn` stayed in
  // scope for the whole function and the delete path referenced it inside the handler, so the seed
  // was reachable from the request handlers for as long as this comment claimed it was not. The
  // mitigation is now performed rather than described — the correction is stated instead of quietly
  // overwritten, because a comment that was wrong once is worth flagging to whoever reads it next.
  //
  // USER MODE: the god view rides an exchange-gated "admin" VIEW bearer (ledger scope "admin",
  // fresh-checked at every mint and every connect) — standing via a bearer SOURCE so the tap
  // survives the ≤5-minute token life. No pre-minted purge cred: channel delete mints a one-shot
  // "channel-purger" view per action, so each destructive click is a fresh ledger check, and
  // `cotal actor revoke` kills the dashboard live (eviction) while a scope edit bites at the next
  // refresh.
  const conn = await connectOrExit(values, "admin");
  const detachedRoot = process.env[DETACHED_ROOT_ENV];
  if (detachedRoot && conn.root !== detachedRoot)
    throw new Error(`detached web target lost its recorded mesh root (${detachedRoot}) before startup`);
  const port = values.port ? Number(values.port) : WEB_PORT;
  if (values.detach) {
    if (!conn.root)
      throw new Error("`cotal web --detach` requires a recorded mesh root; start or register the mesh with `cotal up` first");
    await launchDetachedWeb(args.raw, conn.root, conn.space, conn.server, port, Boolean(values["no-open"]));
    return;
  }
  const user = conn.bearer ? await userViewAuthOrExit(conn, "admin") : undefined;
  const { server, space } = conn;
  const pidPath = conn.root ? localProcessPath(webProcess.pidFile, { root: conn.root, space }) : undefined;
  if (pidPath) {
    claimPid(pidPath);
    process.once("exit", () => releasePid(pidPath));
  }
  const purgeCreds = !user && conn.auth ? await mintCreds(conn.auth, newIdentity(), "channel-purger") : conn.creds;

  // THE SEED IS DROPPED HERE, AND THIS IS THE LINE THAT MAKES THE CLAIM ABOVE TRUE.
  //
  // The header above has always said the account seed "isn't reachable from the request handlers".
  // It was NOT true: `conn` is bound at the top of `web()` and was referenced INSIDE
  // `handleRequest` (the `userViewAuth(conn, …)` call on the delete path), so the handler closed
  // over the whole `Connection` — including `conn.auth`, the `SpaceAuth` carrying the broker
  // operator seed and the account seed/signingSeed that can mint ANY identity or role. The
  // mitigation was described in a comment and never implemented; that gap is what D3 recorded.
  //
  // The last use of `conn.auth` is the line above, so from this point the handler needs a
  // Connection WITHOUT it. `userViewAuth` reads only `bearer`/`userAuth`/`root`/`space` and never
  // touches `auth`, so nothing downstream loses anything. `auth` is optional on `Connection`, so
  // the narrowed value is still a `Connection` and the compiler keeps it that way.
  //
  // HONEST LIMIT, so this is not read as more than it is: this is DEFENSE IN DEPTH, not a claim of
  // unexploitability. An attacker with code execution in this process can reach the heap, where
  // lexical scope means nothing. What it does buy is that the DOCUMENTED mitigation is now real,
  // and that a future edit reaching for `conn` inside the handler has to notice this line first.
  const { auth: _accountSeedIsNotForRequestHandlers, ...connForHandlers } = conn;

  // Observer: never registers presence, never consumes an inbox — invisible to peers.
  const ep = new CotalEndpoint({
    space,
    servers: server,
    // THE RESOLVED TRANSPORT, NOT A DEFAULT. `connectOrExit` already decided this from the mesh
    // record and `Connection.tls` is non-optional, so the answer was in scope and was being dropped
    // here — the same shape as `--tls-cert` being validated and then discarded at a call boundary,
    // which is the defect this branch exists to close.
    //
    // It matters more here than the omission looks. Against a TLS broker this endpoint CONNECTED
    // FINE without it, by upgrading the socket once it read `tls_required` — so nothing was visibly
    // wrong. But that INFO is unauthenticated plaintext: an on-path attacker strips `tls_required`
    // and a client with no requirement of its own carries on in the clear, with its credentials in
    // the CONNECT line. The client's own `tls` is the PRIMARY fence, not a second layer, so a
    // dashboard that omits it is protected by the server's cooperation rather than by its own
    // demand.
    tls: conn.tls,
    ...(user
      ? { bearer: user.source, sentinelCreds: user.sentinelCreds, card: { owner: user.owner, actor: user.actor, name: "web", kind: "endpoint" as const } }
      : { creds: conn.creds, card: { name: "web", kind: "endpoint" as const } }),
    channels: [],
    consume: false, // observer: reads via tap + history + presence-watch, binds no durables
    registerPresence: false,
    watchPresence: true,
  });
  ep.on("error", (e: Error) => console.error(c.red("! " + e.message)));
  await ep.start();

  const clients = new Set<ServerResponse>();
  const send = (res: ServerResponse, event: string, data: unknown) =>
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  const broadcast = (event: string, data: unknown) => {
    for (const res of clients) if (!res.writableEnded) send(res, event, data);
  };

  // Presence changes → push the whole roster; the client just re-renders it.
  ep.on("presence", () => broadcast("roster", ep.getRoster()));

  // Broker-sourced channel membership (the authoritative graph spokes): push a `membership` SSE event
  // on every feed change (debounced; the client re-reads the snapshot). Best-effort — a space without the
  // feed (no delivery daemon, or provisioned before this feature) simply never emits, and the graph
  // degrades to traffic-only. The admin cred carries the read grant; agents never do.
  let membershipWatch: { stop(): void } | undefined;
  const pushMembership = debounce(() => {
    // A swallowed rejection here left the graph showing its LAST GOOD snapshot indefinitely, which
    // is worse than the HTTP case: the display was not merely empty, it was stale and confident.
    void ep.readMembership()
      .then((m) => broadcast("membership", m))
      .catch((e) => broadcast(MEMBERSHIP_READ_FAILED, { reason: (e as Error).message }));
  }, 150);
  try {
    membershipWatch = await ep.watchMembership(pushMembership);
  } catch (e) {
    console.error(c.dim(`• membership feed unavailable - graph shows traffic only (${(e as Error).message})`));
  }
  // Every comm on the mesh (chat / unicast / anycast) → push to the live feed. The admin cred
  // allows exactly the MESSAGING plane (SPEC 13.9/13.11: chat + inst + svc, enumerated — never
  // the space-wide `>`, which would also plain-subscribe the v0.4 endpoint request rails), so
  // the tap is one subscription per plane.
  const onTap = (subject: string, msg: unknown) => {
    const mode = deliveryOf(subject);
    if (!mode || !msg) return;
    // senderId is the subject's sender token — the *verified* publisher (the server
    // policed who could publish it), vs the advisory `from` in the payload.
    const parsed = parseSubject(subject);
    const senderId = parsed?.sender;
    // The channel the broker actually POLICED, taken from the subject rather than the payload: a
    // publish grant is per-channel (`chat.<owner>.<actor>.<ch>`), so this token is covered by the
    // minted grant, while `msg.channel` is publisher-supplied and backed by nothing. The verified
    // value was already parsed on the line above and was being dropped.
    //
    // Gated on kind, and the gate is load-bearing rather than defensive: `rest` is the channel only
    // on the chat plane. On `inst` it is the RECIPIENT (`subjects.ts:599`) and on `svc` the route
    // (`:603`), so forwarding it ungated would label a DM's recipient as a channel.
    const channel = parsed?.kind === "chat" ? parsed.rest : undefined;
    broadcast("message", { mode, senderId, channel, msg });
  };
  for (const plane of ["chat", "inst", "svc"])
    ep.tap(onTap, { subject: `${spacePrefix(space)}.${plane}.>` });

  const handleRequest = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const path = (req.url ?? "/").split("?")[0];
    const query = new URLSearchParams((req.url ?? "").split("?")[1] ?? "");

    if (path === "/feed") {
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      });
      clients.add(res);
      send(res, "roster", ep.getRoster());
      // Seed this client's graph with the current membership snapshot (the live tap only carries
      // post-connect traffic; membership is state, so a fresh client needs it explicitly).
      void ep.readMembership()
        .then((m) => { if (!res.writableEnded) send(res, "membership", m); })
        .catch((e) => { if (!res.writableEnded) send(res, MEMBERSHIP_READ_FAILED, { reason: (e as Error).message }); });
      req.on("close", () => clients.delete(res));
      return;
    }
    if (path === "/api/meta") return json(res, { space, pid: process.pid });
    if (path === "/api/roster") return json(res, ep.getRoster());
    if (path === "/api/membership") {
      // Authoritative who-is-subscribed (broker-sourced); {asOf, members:[{id,live,durable,observedAt}]}.
      //
      // A FAILED READ IS NOT AN EMPTY ONE, AND THIS USED TO RETURN THE SAME BYTES FOR BOTH. The catch
      // answered `{asOf: undefined, members: []}` with a 200, which `JSON.stringify` serialises as
      // `{"members":[]}` — byte-identical to a successful read of a space where nobody is subscribed,
      // because a key whose value is `undefined` is DROPPED, so the one field that might have
      // separated them never reached the wire. The browser then had no way to tell "nobody
      // subscribed" from "I could not find out", and the graph asserted the first.
      //
      // The refusal now names its own condition and carries a non-200, so a caller that checks
      // neither still cannot mistake it for data.
      try { return json(res, await ep.readMembership()); }
      catch (e) {
        return json(res, { error: MEMBERSHIP_READ_FAILED, reason: (e as Error).message }, 503);
      }
    }
    if (path === "/api/channels") {
      // Resolve defaults at the endpoint so every web client renders the same channel policy the
      // core applies; the registry's `config` holds only per-channel overrides.
      const channels = chatOnly(await ep.listChannels());
      return json(res, channels.map(({ channel, messages, config }) => ({
        channel,
        messages,
        description: config?.description,
        replay: ep.channelReplay(channel),
        replayWindow: ep.channelReplayWindow(channel),
        deliveryClass: ep.channelDeliveryClass(channel),
      })));
    }
    if (path === "/api/activity") {
      // Backfill the all-activity feed: merge recent channel history with DM history (the live
      // SSE tap only carries messages from after a client connects). Entries are mode-tagged
      // ({mode, msg}) to match the live feed so DMs render as DMs.
      //
      // NOT OPTIMISED, DELIBERATELY. An earlier version fetched an even share per channel and
      // topped up only channels that saturated their share, to avoid moving (channels + 1) times
      // what it displays. That is WRONG for a global top-N: saturation counts messages, not
      // recency. With ten channels, limit 200 and a share of 40, if every channel holds at least 40
      // messages the top-up never fires, so a channel owning the globally newest 200 contributes
      // only its newest 40 and 160 genuinely-newer messages are dropped for 160 older ones.
      //
      // A correct cheap version needs an iterative timestamp-aware top-up: compute the provisional
      // cutoff (the ts of the limit-th newest in the union) and re-fetch only channels whose oldest
      // fetched message is still at or above it, until none can extend above the cutoff. That is
      // worth doing, with a test encoding the counterexample above, and it is not this change.
      // Correctness first: fetch a full page per channel and merge.
      const limit = query.get("limit") ? Number(query.get("limit")) : 200;
      const page = await activityBackfill(ep, limit);
      // A partial page is worth SAYING on the server too: the operator watching this log is the one
      // who can tell a slow link from a broken channel, and the browser's marker never reaches them.
      if (page.partial)
        console.error(c.yellow(`~ ${req.method ?? "GET"} ${path} partial: ${page.read}/${page.of} sources within ${page.deadlineMs}ms, missing ${page.missing.join(", ")}`));
      return json(res, page);
    }
    if (path === "/api/dms") {
      // DM history for the Direct-messages lens (god-view); the client groups it by peer/pair.
      //
      // BOUNDED LIKE THE AGGREGATION, AND A REFUSAL RATHER THAN A PARTIAL. This is ONE read of one
      // subject, so there is no subset to serve when it runs long: it either produced the page or it
      // produced nothing. Measured across a 160ms link it took 16.59s, which is a 200 nobody is still
      // waiting for. A named 503 at the deadline lets the browser keep the DM list it already has and
      // say it is stale, which is strictly more than a page that arrives after the reader gave up.
      const limit = query.get("limit") ? Number(query.get("limit")) : 500;
      const clock = deadline(AGGREGATION_DEADLINE_MS);
      try {
        const dms = await within(ep.dmHistory({ limit }), clock.until);
        if (dms === LATE)
          return json(res, { error: `direct messages: the read did not finish within ${AGGREGATION_DEADLINE_MS}ms` }, 503);
        return json(res, dms);
      } finally {
        clock.done();
      }
    }
    if (path.startsWith("/api/channels/") && path.endsWith("/history")) {
      const name = decodeURIComponent(path.slice("/api/channels/".length, -"/history".length));
      const limit = query.get("limit") ? Number(query.get("limit")) : 200;
      return json(res, await ep.channelHistory(name, { limit }));
    }
    // Delete a channel and its content. The only write path on this otherwise read-only
    // dashboard, so it's POST-gated and guarded by a confirm in the UI. Uses the manager cred
    // pre-minted at startup (auth mode) or the connection creds (open / --creds), NOT the account
    // seed (which we dropped). A wildcard / missing channel is a 400.
    if (path === "/api/channel/delete" && req.method === "POST") {
      const body = await readBody(req).catch(() => ({}) as { channel?: string });
      const channel = typeof body.channel === "string" ? body.channel : "";
      if (!channel) {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "channel required" }));
        return;
      }
      try {
        // User mode mints a one-shot channel-purger VIEW per delete — the ledger is re-checked at
        // this click, and a mid-session revoke becomes this handler's 400, never a dead dashboard.
        const result = user
          ? await userViewAuth(connForHandlers, "channel-purger").then((p: UserViewAuth) =>
              clearChannel({ servers: server, space, channel, bearer: p.bearer, sentinelCreds: p.sentinelCreds }),
            )
          : await clearChannel({ servers: server, space, channel, creds: purgeCreds });
        return json(res, { ok: true, ...result });
      } catch (e) {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: (e as Error).message }));
        return;
      }
    }

    const file = PAGE[path];
    if (file) {
      // no-cache: always revalidate so a `cotal` upgrade's new dashboard code is picked up on
      // reload — a stale cached graph.js silently runs old behavior (e.g. pre-fix filters).
      res.writeHead(200, { "content-type": file.type, "cache-control": "no-cache" });
      res.end(readFileSync(file.path));
      return;
    }
    res.writeHead(404).end("not found");
  };

  // A route handler talks to the broker, so ANY of them can reject — a JetStream request that
  // times out (a slow or briefly unreachable broker, e.g. a mesh reached over a relayed overlay
  // link) rejects inside the async handler. `createServer(async …)` does not await its listener,
  // so such a rejection became an unhandled rejection and killed the whole dashboard process on
  // the first slow request. The dashboard is a read-only observer: one failed route must degrade
  // to a 500, never take down the server. Reply only when nothing has been written yet — a /feed
  // stream (or any partially-sent response) is already committed to its status line.
  const httpServer = createServer((req, res) => {
    void handleRequest(req, res).catch((e: unknown) => {
      const why = e instanceof Error ? e.message : String(e);
      console.error(c.red(`! ${req.method ?? "GET"} ${req.url ?? "/"} failed: ${why}`));
      if (res.headersSent) return void res.end();
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: why }));
    });
  });

  // Comment ping keeps idle SSE connections alive through proxies.
  const ping = setInterval(() => {
    for (const res of clients) if (!res.writableEnded) res.write(": ping\n\n");
  }, 20_000);

  httpServer.on("error", (e: NodeJS.ErrnoException) => {
    if (e.code === "EADDRINUSE") console.error(c.red(`Port ${port} is in use. Pass --port <n>.`));
    else console.error(c.red("! " + e.message));
    process.exit(1);
  });

  await new Promise<void>((ready) => httpServer.listen(port, "127.0.0.1", ready));
  // Branded URL only when on the default port; a custom --port keeps the plain loopback address.
  const url = webUrl(port);
  console.log(`${c.bold("Cotal web")} - observing space ${c.bold(space)}`);
  console.log(c.dim("  god-view - DMs + anycast visible"));
  console.log(`  ${c.cyan(url)}  ${c.dim("(Ctrl-C to stop)")}`);
  if (!values["no-open"]) openBrowser(url);

  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    clearInterval(ping);
    membershipWatch?.stop();
    for (const res of clients) res.end();
    httpServer.close();
    await ep.stop();
    if (pidPath) releasePid(pidPath);
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
  await new Promise<void>(() => {});
}

/** Launch the dashboard through this exact Cotal entrypoint, then report success only after the
 * spawned PID proves it owns both the mesh pidfile and the HTTP listener. */
async function launchDetachedWeb(
  raw: readonly string[],
  root: string,
  space: string,
  server: string,
  port: number,
  noOpen: boolean,
): Promise<void> {
  const context = { root, space };
  const pidPath = localProcessPath(webProcess.pidFile, context);
  const logPath = localProcessPath("web.log", context);
  const logFd = openSync(logPath, "a", 0o600);
  const logOffset = fstatSync(logFd).size;
  const childArgs = detachedArgs(raw, space, server);
  let child: ChildProcess;
  try {
    child = spawn(process.execPath, [...process.execArgv, process.argv[1], "web", ...childArgs], {
      cwd: root,
      detached: true,
      env: { ...process.env, [DETACHED_ROOT_ENV]: root },
      stdio: ["ignore", logFd, logFd],
    });
  } finally {
    closeSync(logFd);
  }
  child.unref();

  const url = webUrl(port);
  try {
    await waitForDetachedWeb(child, { pidPath, url: `http://127.0.0.1:${port}/`, space, timeoutMs: DETACHED_READY_TIMEOUT_MS });
  } catch (e) {
    let cleanupError: Error | undefined;
    try { await terminateDetachedWeb(child, pidPath); }
    catch (err) { cleanupError = err as Error; }
    const tail = appendedLogTail(logPath, logOffset);
    throw new Error(`${(e as Error).message}${cleanupError ? `; ${cleanupError.message}` : ""} - see ${logPath}${tail ? `\n${tail}` : ""}`);
  }

  console.log(c.green(`✓ web dashboard ready at ${url} (pid ${child.pid})`));
  console.log(c.dim(`  log: ${logPath}`));
  console.log(c.dim("  stop: cotal down web"));
  if (!noOpen) openBrowser(url);
}

export function detachedArgs(raw: readonly string[], space: string, server: string): string[] {
  const kept: string[] = [];
  for (let i = 0; i < raw.length; i++) {
    const arg = raw[i];
    if (arg === "--detach" || arg === "--no-open") continue;
    if (arg === "--space" || arg === "--server") {
      i++;
      continue;
    }
    if (arg.startsWith("--space=") || arg.startsWith("--server=")) continue;
    kept.push(arg);
  }
  return [...kept, "--space", space, "--server", server, "--no-open"];
}

export async function waitForDetachedWeb(
  child: ChildProcess,
  opts: { pidPath: string; url: string; space: string; timeoutMs: number },
): Promise<void> {
  let spawnError: Error | undefined;
  const spawnErrorPromise = new Promise<Error>((resolve) => child.once("error", (e) => {
    spawnError = e;
    resolve(e);
  }));
  const pid = child.pid;
  if (!pid) {
    const error = await Promise.race([spawnErrorPromise, sleep(100).then(() => undefined)]);
    throw new Error(`web dashboard failed to start${error ? `: ${error.message}` : " (no process id)"}`);
  }
  const deadline = Date.now() + opts.timeoutMs;
  while (Date.now() < deadline) {
    if (spawnError) throw new Error(`web dashboard failed to start: ${spawnError.message}`);
    if (child.exitCode !== null || child.signalCode !== null || !pidAlive(pid))
      throw new Error(`web dashboard exited before becoming ready (pid ${pid})`);
    if (pidFileOwned(opts.pidPath, pid)) {
      const meta = await fetch(`${opts.url}api/meta`, { signal: AbortSignal.timeout(500) })
        .then(async (res) => res.ok ? await res.json() as { space?: unknown; pid?: unknown } : undefined)
        .catch(() => undefined);
      if (meta?.space === opts.space && meta.pid === pid) {
        if (child.exitCode !== null || child.signalCode !== null || !pidAlive(pid))
          throw new Error(`web dashboard exited during readiness (pid ${pid})`);
        return;
      }
    }
    await sleep(100);
  }
  throw new Error(`web dashboard did not become HTTP-ready within ${opts.timeoutMs}ms (pid ${pid})`);
}

export async function terminateDetachedWeb(child: ChildProcess, pidPath: string): Promise<void> {
  const pid = child.pid;
  if (!pid) return;
  if (pidAlive(pid)) {
    try { child.kill("SIGTERM"); } catch { /* verify below */ }
    if (!(await waitForDeath(child, pid, DETACHED_STOP_TIMEOUT_MS))) {
      try { child.kill("SIGKILL"); } catch { /* verify below */ }
      if (!(await waitForDeath(child, pid, DETACHED_STOP_TIMEOUT_MS)))
        throw new Error(`failed to terminate detached web dashboard (pid ${pid}); ${pidPath} was preserved`);
    }
  }
  if (pidFileOwned(pidPath, pid)) rmSync(pidPath, { force: true });
}

function pidFileOwned(path: string, pid: number): boolean {
  try { return readFileSync(path, "utf8").trim() === String(pid); }
  catch { return false; }
}

async function waitForDeath(child: ChildProcess, pid: number, timeoutMs: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null || !pidAlive(pid)) return true;
  await Promise.race([
    new Promise<void>((resolve) => child.once("exit", () => resolve())),
    sleep(timeoutMs),
  ]);
  return child.exitCode !== null || child.signalCode !== null || !pidAlive(pid);
}

export function appendedLogTail(path: string, offset: number): string {
  try {
    const size = statSync(path).size;
    if (size <= offset) return "";
    const start = Math.max(offset, size - 4096);
    const bytes = Buffer.alloc(size - start);
    const fd = openSync(path, "r");
    try { readSync(fd, bytes, 0, bytes.length, start); } finally { closeSync(fd); }
    return bytes.toString("utf8").trim();
  } catch {
    return "";
  }
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function webUrl(port: number): string {
  return port === WEB_PORT ? WEB_URL : `http://127.0.0.1:${port}/`;
}

function json(res: ServerResponse, data: unknown, status = 200): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(data));
}

/** Trailing-edge debounce — coalesces a burst of membership-feed deltas into one push. */
function debounce(fn: () => void, ms: number): () => void {
  let t: ReturnType<typeof setTimeout> | undefined;
  return () => {
    if (t) clearTimeout(t);
    t = setTimeout(fn, ms);
  };
}

async function readBody(req: IncomingMessage): Promise<{ channel?: string }> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? JSON.parse(raw) : {};
}

/** Best-effort open of the dashboard in the default browser. The URL is already
 *  printed, so a failure here is harmless — never block startup on it. */
function openBrowser(url: string): void {
  const [cmd, args] =
    process.platform === "darwin"
      ? ["open", [url]]
      : process.platform === "win32"
        ? ["cmd", ["/c", "start", "", url]]
        : ["xdg-open", [url]];
  try {
    spawn(cmd as string, args as string[], { stdio: "ignore", detached: true }).unref();
  } catch {
    /* no opener on this platform — the printed URL is the fallback */
  }
}
