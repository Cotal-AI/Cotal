/**
 * `/api/activity` MUST COST ONE READ, NOT ONE READ PER CHANNEL (Cotal #1210).
 *
 * WHAT WAS MEASURED IN THE FIELD. `cotal web` against a broker across an overlay WAN, 82ms RTT,
 * 554 KB/s: the activity fan-out asked 69 channels and a median of 2 of them answered inside the
 * 8000ms deadline (min 0, max 60, n=47), and `/api/dms` succeeded 0 times in 47 attempts. The page
 * it renders is under 100 KB. The request is small; the protocol used to satisfy it was not.
 *
 * WHERE THE COST WAS. `channelHistory` reads ONE channel by probing: a filtered subject's sequences
 * are non-contiguous, so the read finds the newest matching sequence and then widens a window
 * geometrically until it holds a page. Every widening is a full consumer lifecycle (CREATE, INFO,
 * one or more MSG.NEXT, DELETE). A sparse channel inside a busy stream widens several times. The
 * route then did that once per channel and merged, so the cost carried two independent multipliers:
 * a probe loop per channel, and a fan-out across every channel.
 *
 * WHAT THIS SUITE MEASURES, AND WHERE IT MEASURES IT. Every number below is taken ON THE WIRE, by a
 * TCP proxy sitting between the dashboard's endpoint and the broker, counting NATS protocol lines
 * and bytes in each direction. It is deliberately not an instrumented internal: an implementation
 * that moved the same work to a different private method would still have to send the same bytes
 * past this proxy. Two quantities are counted:
 *
 *   - ROUND TRIPS: every client→broker `PUB $JS.API.…` line, since each one is a request the link
 *     has to carry. The four consumer verbs are split out, because a consumer lifecycle is a CREATE
 *     plus its pulls plus a DELETE and that lifecycle is what #1210 is about; every other
 *     `$JS.API.` request, STREAM.INFO for the channel list and so on, lands in `other`. Every trips
 *     figure published below is the sum of all five counters, so it includes `other`.
 *   - BYTES: every octet in each direction, so the "transfers ~70 times what it displays" claim is
 *     comparable against the size of the page that is actually returned.
 *
 * THE BASELINE IS REBUILT HERE, NOT IMPORTED. `fanOutBackfill` below is the SHAPE that shipped
 * before #1210: `chatOnly(listChannels())`, then one `channelHistory` per channel plus the DM
 * backlog, pooled at the shipped concurrency against the shipped deadline, merged and capped. It is
 * frozen in this file so it stays fixed while the implementation moves, and so the comparison is
 * between two shapes rather than between two revisions of one function.
 *
 * AND IT IS NOT THE SHIPPED "BEFORE", WHICH IS A DIFFERENT NUMBER. This arm runs the old shape on
 * THIS build's read primitive, and #1210 changed that primitive too (the first window opens one page
 * wide instead of four). So it measures the fan-out as it would cost today, not as it cost on
 * `544a974b7`. Both are worth having and they are not interchangeable. Measured, same corpus,
 * `/api/activity` with no link cost:
 *
 *     544a974b7, the code that shipped        2524 requests   8,015,332 to 8,016,039 B   4 runs
 *     this file's frozen fan-out arm          2863 requests   7,743,782 to 7,744,228 B   8 runs
 *     the single read                          143 requests      908,410 to   908,422 B   8 runs
 *
 * The request counts and the consumer creates held in every run of each arm above. All three are
 * completed no-link arms. In §4 the fan-out arm is truncated by the deadline and its counts vary
 * with it; the single read completes there on the same 143 requests and 6 creates. The byte totals
 * did not hold, so each is the span those runs covered.
 *
 * A SPAN HERE IS NOT A BOUND. It is what the stated number of runs happened to cover on one host,
 * and a further run can fall outside it: a reviewer's four fresh runs landed below the low end of
 * both arms above, which is how the current figures got their present low ends. Do not read these
 * as an envelope the command must reproduce, and do not treat a run a few bytes outside one as a
 * regression. The counts are the reproducible part.
 *
 * The gap between the first two rows is the per-channel cost of the narrower window, which the pull
 * request states separately. To reproduce the first row, copy this file and its `package.json`
 * script onto a checkout of `544a974b7` and run it: `activityBackfill` there IS the fan-out, so both
 * arms report the same numbers and every ratio cell fails, which is the repro.
 *
 * THE INSTRUMENT IS CONTROLLED. A counter that reads zero for both arms would make every ratio here
 * look like a pass, so §2 requires the BASELINE's consumer creates to grow with the channel count
 * (which is the defect) before it accepts that the shipped arm's do not. That positive control is
 * the reason a broken counter fails this suite instead of flattering it.
 *
 * WHAT IT DOES NOT CLAIM. It claims nothing about wall-clock on any particular machine except in
 * §4 and §5, where the link is modelled at the field's own parameters and the assertion is only the
 * shape (the shipped arm answers whole and the DM read finishes inside the deadline; the fan-out
 * does neither). Round trips and bytes are properties of the protocol and the corpus, not of the
 * host, which is why the cells that gate the fix are those.
 *
 * Needs nats-server on PATH. Run: pnpm smoke:web-activity-read-cost
 */
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import net, { type AddressInfo } from "node:net";
import { CotalEndpoint, isReachable, newIdentity, setupSpaceStreams, type CotalMessage } from "@cotal-ai/core";
import { SMOKE_BROKER_TOKEN, teardownOnSignal } from "@cotal-ai/smoke-kit";
import {
  activityBackfill, AGGREGATION_CONCURRENCY, AGGREGATION_DEADLINE_MS, chatOnly,
  type ActivityPage, type ActivitySource,
} from "../src/web.js";
import { throttledWriter } from "./slow-link-throttle.js";

let cells = 0;
let failed = 0;
const ok = (name: string, cond: boolean, detail?: unknown): void => {
  cells++;
  if (cond) {
    console.log(`  ✓ ${name}`);
    return;
  }
  failed++;
  console.log(`  x FAIL  ${name}${detail === undefined ? "" : `: ${JSON.stringify(detail)}`}`);
};
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const freePort = async (): Promise<number> =>
  new Promise((res) => {
    const s = net.createServer();
    s.listen(0, "127.0.0.1", () => { const p = (s.address() as AddressInfo).port; s.close(() => res(p)); });
  });

// ── the instrument ───────────────────────────────────────────────────────────────────────────────

interface WireCost {
  create: number;
  info: number;
  next: number;
  del: number;
  /** Every other `$JS.API.…` request: STREAM.INFO for the channel list, KV reads, and so on. */
  other: number;
  bytesUp: number;
  bytesDown: number;
}
const zero = (): WireCost => ({ create: 0, info: 0, next: 0, del: 0, other: 0, bytesUp: 0, bytesDown: 0 });
const trips = (c: WireCost): number => c.create + c.info + c.next + c.del + c.other;

/** The link between the dashboard's endpoint and the broker, counting what crosses it.
 *
 *  COUNTED BY PROTOCOL LINE, NOT BY SUBSTRING. A TCP chunk boundary can split a subject in half and
 *  a message body can contain any text, so the client→broker direction is reassembled into `\r\n`
 *  terminated lines and only a line that BEGINS with `PUB $JS.API.` is counted. A payload line
 *  cannot begin that way, and a subject split across two chunks is rejoined before it is
 *  matched. That holds for the frames this corpus produces, and NOT in general: the split is on
 *  CRLF without honouring the declared payload length, so a payload carrying a CRLF can false-count
 *  a line, and only `PUB` is recognised, so an `HPUB` would go uncounted. Neither occurs here, since
 *  the seeded bodies are `x` repeated and the client publishes no headers on this path. Treat the
 *  count as exact for this corpus rather than as a general NATS framing parser.
 *
 *  `latency` is a mutable object read at each push, so one proxy on one port serves both the
 *  no-cost arms (where round trips and bytes are the measurement) and the modelled-link arm (where
 *  wall clock is), without the ports moving under a running endpoint. */
function countingLink(opts: {
  listen: number;
  target: number;
  latency: { oneWayMs: number; bytesPerSec: number };
  cost: () => WireCost;
}): { close(): void } {
  const sockets = new Set<net.Socket>();
  const srv = net.createServer((client) => {
    const upstream = net.connect(opts.target, "127.0.0.1");
    sockets.add(client);
    sockets.add(upstream);
    // COUNTED AT DELIVERY, NOT AT ARRIVAL. Both counters run from the writer's `onDeliver`, which
    // fires as the chunk is written to the receiving socket. Counting in the `data` handler instead
    // records what reached the proxy, and an arm truncated at the deadline leaves chunks queued that
    // were counted and never crossed the link. That arm is section 4's fan-out, which is cut by the
    // deadline on purpose, so its published requests and bytes were arrival counts until this
    // change. Cell 4.6 holds this property and a fixture mutation moves the increment back.
    let pending = "";
    const onUp = (chunk: Buffer) => {
      const c = opts.cost();
      c.bytesUp += chunk.length;
      pending += chunk.toString("latin1");
      const lines = pending.split("\r\n");
      pending = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.startsWith("PUB $JS.API.")) continue;
        const verb = line.slice("PUB $JS.API.".length);
        if (verb.startsWith("CONSUMER.CREATE")) c.create++;
        else if (verb.startsWith("CONSUMER.INFO")) c.info++;
        else if (verb.startsWith("CONSUMER.MSG.NEXT")) c.next++;
        else if (verb.startsWith("CONSUMER.DELETE")) c.del++;
        else c.other++;
      }
    };
    const toBroker = throttledWriter(upstream, opts.latency, undefined, onUp);
    const toClient = throttledWriter(client, opts.latency, undefined,
      (chunk: Buffer) => { opts.cost().bytesDown += chunk.length; });
    client.on("data", (chunk: Buffer) => { toBroker.push(chunk); });
    upstream.on("data", (chunk: Buffer) => { toClient.push(chunk); });
    const bye = () => { toBroker.close(); toClient.close(); client.destroy(); upstream.destroy(); };
    client.on("error", bye);
    client.on("close", bye);
    upstream.on("error", bye);
    upstream.on("close", bye);
  });
  srv.listen(opts.listen, "127.0.0.1");
  return { close: () => { for (const s of sockets) s.destroy(); srv.close(); } };
}

// ── the baseline: the shape that shipped before #1210 ────────────────────────────────────────────

const LATE = Symbol("late");
const clockOf = (ms: number) => {
  let done = () => {};
  const until = new Promise<typeof LATE>((res) => {
    const t = setTimeout(() => res(LATE), ms);
    t.unref();
    done = () => clearTimeout(t);
  });
  return { until, done };
};
const within = async <T>(work: Promise<T>, until: Promise<typeof LATE>): Promise<T | typeof LATE> => {
  work.catch(() => {});
  return Promise.race([work, until]);
};

/** ONE `channelHistory` PER CHANNEL, POOLED, THEN MERGED. Frozen copy of the pre-#1210 aggregation:
 *  same sources, same pool, same deadline, same merge and cap, so the only difference between this
 *  and `activityBackfill` is how the chat half is read. */
async function fanOutBackfill(
  ep: ActivitySource,
  limit: number,
  deadlineMs = AGGREGATION_DEADLINE_MS,
  concurrency = AGGREGATION_CONCURRENCY,
): Promise<ActivityPage> {
  const clock = clockOf(deadlineMs);
  const abort = new AbortController();
  try {
    const chans = chatOnly(await ep.listChannels());
    type Src = { name: string; read: () => Promise<ActivityPage["entries"]> };
    const sources: Src[] = [
      ...chans.map((ch) => ({
        name: `#${ch.channel}`,
        read: async () =>
          (await ep.channelHistory(ch.channel, { limit, signal: abort.signal }))
            .map((msg) => ({ mode: "chat" as const, channel: ch.channel, msg })),
      })),
      {
        name: "direct messages",
        read: async () => (await ep.dmHistory({ limit, signal: abort.signal })).map((msg) => ({ mode: "unicast" as const, msg })),
      },
    ];
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
        } catch { /* a failed source is missing, like a late one */ }
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
    abort.abort();
    clock.done();
  }
}

// ── the corpus ───────────────────────────────────────────────────────────────────────────────────

/** THE FIELD'S SHAPE, NOT A CONVENIENT ONE. 69 chat channels is the deployment's own count. The
 *  event channels carry most of the stream's volume, which is what makes each chat channel SPARSE
 *  inside it, and sparsity is what drives the widening loop the issue names. A corpus of dense chat
 *  channels alone would understate the before number by an order of magnitude. */
const CORPUS = { chat: 69, chatDepth: 60, events: 24, eventDepth: 200, dms: 2500 };
/** How many of those chat channels the NARROW arm is told about. One corpus, two channel lists: the
 *  question §2 asks is whether cost tracks the number of channels ASKED FOR, and a second broker
 *  space would only add storage, not evidence. Asking for fewer channels of the SAME stream is also
 *  the harder direction for the single read (a narrower filter set is sparser inside the stream), so
 *  a flat line there is not an artefact of a friendlier corpus. */
const NARROW = 20;
/** Above the measured create ceiling: 10,000 unbatched filters did not answer (timeout after
 *  5,023ms) while 5,000 answered in 5,345ms, both on an isolated broker with one message per
 *  channel. Section 8 asserts this count still produces MESSAGES. */
const WIDE = 10_000;
const LIMIT = 200;
const BODY = "x".repeat(400);
/** The field link: 82ms RTT, 554 KB/s, both directions. */
const FIELD = { oneWayMs: 41, bytesPerSec: 554 * 1024 };
/** What an aborted read may still leave committed to the connection, in bytes.
 *
 *  One pull batch is 32 messages and this corpus runs about 1,005 wire bytes a message (§3: 500 DMs
 *  for 502,354 to 502,359B across eight no-link runs), so a batch is roughly 32KB and this is two
 *  of them. Measured, an aborted read leaves 165B in every run; a read that asked the broker for the
 *  whole 2500-message backlog would leave close to 2MB. The ceiling sits between those by two orders of magnitude in both directions rather than
 *  hugging either, so it is not fixed to this host. */
const ABANDONED_CEILING = 64_000;
const NO_COST = { oneWayMs: 0, bytesPerSec: 1024 * 1024 * 1024 };

const SPACE = "actcost";
const PORT = await freePort();
const PROXY = await freePort();
const SERVER = `nats://127.0.0.1:${PORT}`;
const SLOW = `nats://127.0.0.1:${PROXY}`;

const latency = { ...NO_COST };
let cost = zero();

const store = mkdtempSync(join(tmpdir(), SMOKE_BROKER_TOKEN));
const broker = spawn("nats-server", ["-p", String(PORT), "-js", "-sd", store, "-a", "127.0.0.1"], { stdio: "ignore" });
const releaseBroker = teardownOnSignal(broker, store);
let link: { close(): void } | undefined;

/** Seed one space. SEQUENTIAL ON PURPOSE: the two arms select the newest N by different keys (the
 *  fan-out unions per-channel pages and then sorts by `ts`; the single read takes the newest N in
 *  the broker's own arrival order and then sorts by `ts`), and those agree exactly when arrival
 *  order and `ts` order agree. A round-robin of concurrent publishes would leave them free to
 *  disagree within a millisecond and make §1's equality cell flap for a reason that has nothing to
 *  do with the change. One writer, one message at a time, so the corpus has one true order. */
async function seed(space: string, shape: typeof CORPUS): Promise<{ chat: string[]; events: string[] }> {
  await setupSpaceStreams({ servers: SERVER, space });
  const chat = Array.from({ length: shape.chat }, (_, i) => `team${String(i).padStart(2, "0")}`);
  const events = Array.from({ length: shape.events }, (_, i) => `events.local.agent${String(i).padStart(2, "0")}`);
  const seeder = new CotalEndpoint({
    space, servers: SERVER, channels: [...chat, ...events], consume: false, registerPresence: false,
    card: { id: newIdentity().id, name: "seeder", kind: "endpoint" },
  });
  seeder.on("error", () => {});
  await seeder.start();
  for (let i = 0; i < shape.eventDepth; i++) {
    for (const ch of events) await seeder.multicast(`frame ${i} ${BODY}`, { channel: ch });
    if (i < shape.chatDepth) for (const c of chat) await seeder.multicast(`msg ${i} ${BODY}`, { channel: c });
  }
  const peer = newIdentity();
  for (let i = 0; i < shape.dms; i++) await seeder.unicast(`local.${peer.id}`, `dm ${i} ${BODY}`);
  await seeder.stop();
  return { chat, events };
}

/** A fresh observer across the proxy. Fresh per arm: a reused endpoint carries the previous arm's
 *  consumers and connection state, which is not what the comparison is about. */
const mkEp = async (space: string, tag: string): Promise<CotalEndpoint> => {
  const ep = new CotalEndpoint({
    space, servers: SLOW, channels: [], consume: false, registerPresence: false, watchPresence: false,
    card: { name: `web-${tag}`, kind: "endpoint" },
  });
  ep.on("error", () => {});
  await ep.start();
  return ep;
};

/** Run one arm on its own endpoint and return what it cost ON THE WIRE. The endpoint is started
 *  BEFORE the counters are zeroed, so connection setup, the channel-config watch and the JetStream
 *  handshake are not billed to the read. */
async function arm(
  space: string,
  tag: string,
  run: (ep: ActivitySource) => Promise<ActivityPage>,
): Promise<{ page: ActivityPage; cost: WireCost; ms: number }> {
  const ep = await mkEp(space, tag);
  await wait(250);
  cost = zero();
  const t = Date.now();
  const page = await run(ep as unknown as ActivitySource);
  const ms = Date.now() - t;
  const mine = { ...cost };
  await ep.stop();
  await wait(500);
  return { page, cost: mine, ms };
}

const idsOf = (p: ActivityPage): string[] =>
  p.entries.map((e) => `${e.mode}:${e.mode === "chat" ? e.channel : ""}:${e.msg.id}`);
const answerBytes = (p: ActivityPage): number => Buffer.byteLength(JSON.stringify(p.entries));
const row = (name: string, c: WireCost, extra = ""): string =>
  `    ${name.padEnd(22)} trips=${String(trips(c)).padStart(5)}  ` +
  `create=${String(c.create).padStart(4)} next=${String(c.next).padStart(4)} del=${String(c.del).padStart(4)} other=${String(c.other).padStart(3)}  ` +
  `down=${String(c.bytesDown).padStart(9)}B up=${String(c.bytesUp).padStart(8)}B  ${extra}`;

console.log("activity-read-cost smoke");

try {
  let up = false;
  for (let i = 0; i < 80; i++) { if (await isReachable(SERVER)) { up = true; break; } await wait(150); }
  if (!up) throw new Error("nats-server did not start");

  const seeded = await seed(SPACE, CORPUS);
  link = countingLink({ listen: PROXY, target: PORT, latency, cost: () => cost });
  /** The same endpoint, told about only the first `NARROW` chat channels. Event channels stay in the
   *  list so `chatOnly` still has something to drop. A PROXY rather than a hand-written stand-in:
   *  the arm under test must be the shipped endpoint with one answer narrowed, not a mock whose
   *  method set is whatever this file happened to know about. */
  const kept = new Set(seeded.chat.slice(0, NARROW));
  const narrow = (ep: ActivitySource): ActivitySource =>
    new Proxy(ep, {
      get(target, prop) {
        if (prop === "listChannels")
          return async () => (await target.listChannels()).filter((r) => !seeded.chat.includes(r.channel) || kept.has(r.channel));
        const v = Reflect.get(target, prop) as unknown;
        return typeof v === "function" ? v.bind(target) : v;
      },
    });

  // ── 1. the same answer, and what each shape spent to produce it ────────────────────────────────
  // No link cost here on purpose: both arms must run to COMPLETION or the fan-out's cost would be
  // truncated by the deadline and the "before" number would be an understatement of the defect.
  let shippedBig: Awaited<ReturnType<typeof arm>>;
  let baseBig: Awaited<ReturnType<typeof arm>>;
  {
    baseBig = await arm(SPACE, "fanout-big", (ep) => fanOutBackfill(ep, LIMIT, 120_000));
    shippedBig = await arm(SPACE, "shipped-big", (ep) => activityBackfill(ep, LIMIT, 120_000));
    console.log(`  ${CORPUS.chat} chat channels + ${CORPUS.events} event channels, limit ${LIMIT}, no link cost:`);
    console.log(row("fan-out shape", baseBig.cost, `page=${answerBytes(baseBig.page)}B ${baseBig.ms}ms`));
    console.log(row("single read", shippedBig.cost, `page=${answerBytes(shippedBig.page)}B ${shippedBig.ms}ms`));

    ok("1.1 both arms answered whole", !baseBig.page.partial && !shippedBig.page.partial,
      { base: baseBig.page.missing, shipped: shippedBig.page.missing });
    ok("1.2 both arms return a full page", baseBig.page.entries.length === LIMIT && shippedBig.page.entries.length === LIMIT,
      { base: baseBig.page.entries.length, shipped: shippedBig.page.entries.length });
    ok("1.3 THE SAME ENTRIES, IN THE SAME ORDER: the cost claim is about one answer, not two",
      JSON.stringify(idsOf(shippedBig.page)) === JSON.stringify(idsOf(baseBig.page)),
      { base: idsOf(baseBig.page).slice(0, 3), shipped: idsOf(shippedBig.page).slice(0, 3) });
    ok("1.4 no event-channel message reaches the page",
      shippedBig.page.entries.every((e) => e.mode !== "chat" || !e.channel.startsWith("events.local.")),
      shippedBig.page.entries.filter((e) => e.mode === "chat" && e.channel.startsWith("events.local.")).length);
    ok("1.5 the fan-out really is the ~thousand-round-trip read the issue measured", trips(baseBig.cost) > 500, trips(baseBig.cost));
    ok("1.6 the single read costs an order of magnitude fewer round trips", trips(shippedBig.cost) * 10 < trips(baseBig.cost),
      { shipped: trips(shippedBig.cost), base: trips(baseBig.cost) });
    ok("1.7 and under twenty consumer creates for the whole page", shippedBig.cost.create < 20, shippedBig.cost.create);
    // WHAT IS LEFT, NAMED. The remaining requests are PULLS - the batched delivery of the page
    // itself, whose count follows the bytes moved and the client's rolling buffer size. They are not
    // consumer lifecycles, which is the term that used to follow the channel count. A future change
    // that reintroduced per-channel probing would move `create`, not `next`, so the two are asserted
    // apart rather than as one total.
    ok("1.7b what remains is pulling the page, not opening consumers",
      shippedBig.cost.next > shippedBig.cost.create * 10, { next: shippedBig.cost.next, create: shippedBig.cost.create });
    ok("1.8 it moves at least five times less than the fan-out", shippedBig.cost.bytesDown * 5 < baseBig.cost.bytesDown,
      { shipped: shippedBig.cost.bytesDown, base: baseBig.cost.bytesDown });
    ok("1.9 and within an order of magnitude of the page it displays",
      shippedBig.cost.bytesDown < answerBytes(shippedBig.page) * 10,
      { down: shippedBig.cost.bytesDown, page: answerBytes(shippedBig.page) });
  }

  // ── 2. the cost must not scale with the channel count ─────────────────────────────────────────
  // THE POSITIVE CONTROL IS THE FIRST CELL. A counter stuck at zero would make every ratio above
  // pass, so this section refuses to accept the shipped arm's flat line until the fan-out's has
  // been seen to bend with the channel count on the very same instrument.
  {
    const baseSmall = await arm(SPACE, "fanout-narrow", (ep) => fanOutBackfill(narrow(ep), LIMIT, 120_000));
    const shippedSmall = await arm(SPACE, "shipped-narrow", (ep) => activityBackfill(narrow(ep), LIMIT, 120_000));
    console.log(`  the same stream, only ${NARROW} chat channels asked for:`);
    console.log(row("fan-out shape", baseSmall.cost));
    console.log(row("single read", shippedSmall.cost));

    ok("2.1 CONTROL: the fan-out's consumer creates grow with the channel count",
      baseBig.cost.create > baseSmall.cost.create * 2,
      { small: baseSmall.cost.create, big: baseBig.cost.create });
    ok(`2.2 the single read's do not: ${CORPUS.chat} channels costs no more creates than ${NARROW}`,
      shippedBig.cost.create <= shippedSmall.cost.create + 4,
      { small: shippedSmall.cost.create, big: shippedBig.cost.create });
    ok("2.3 nor do its round trips", trips(shippedBig.cost) <= trips(shippedSmall.cost) * 2,
      { small: trips(shippedSmall.cost), big: trips(shippedBig.cost) });
    ok("2.4 the small space answers whole too", !shippedSmall.page.partial, shippedSmall.page.missing);
  }

  // ── 3. what `/api/dms` costs on its own ───────────────────────────────────────────────────────
  // The route reads the DM backlog alone at limit 500. It shares one connection with the activity
  // route, so its field failure has two candidate causes: its own read, and the fan-out saturating
  // the link underneath it. This measures the read by itself so the two are not confused.
  {
    const ep = await mkEp(SPACE, "dms");
    await wait(250);
    cost = zero();
    const t = Date.now();
    const dms = await ep.dmHistory({ limit: 500 });
    const ms = Date.now() - t;
    const mine = { ...cost };
    await ep.stop();
    await wait(500);
    console.log(row("/api/dms alone", mine, `returned=${dms.length} ${ms}ms`));
    ok("3.1 the DM read is already ONE read of one subject: a handful of consumer lifecycles",
      mine.create <= 4 && mine.del <= 4, { create: mine.create, del: mine.del });
    ok("3.2 what it spends is pulling its own page, not probing", mine.next > mine.create * 10, { next: mine.next, create: mine.create });
    ok("3.3 and it returns the page it was asked for", dms.length === Math.min(500, CORPUS.dms), dms.length);
    console.log(`      (transferred ${mine.bytesDown}B to return ${Buffer.byteLength(JSON.stringify(dms))}B)`);
  }

  // ── 4. the field link ─────────────────────────────────────────────────────────────────────────
  // 82ms RTT and 554 KB/s, the deployment's own numbers, against the shipped 8000ms deadline. This
  // is the symptom the issue reports, and the only section whose numbers depend on the host.
  {
    Object.assign(latency, FIELD);
    const baseSlow = await arm(SPACE, "fanout-slow", (ep) => fanOutBackfill(ep, LIMIT));
    const shippedSlow = await arm(SPACE, "shipped-slow", (ep) => activityBackfill(ep, LIMIT));
    Object.assign(latency, NO_COST);
    console.log(`  across 82ms RTT / 554 KB/s, deadline ${AGGREGATION_DEADLINE_MS}ms:`);
    console.log(row("fan-out shape", baseSlow.cost, `${baseSlow.page.read}/${baseSlow.page.of} sources ${baseSlow.ms}ms`));
    console.log(row("single read", shippedSlow.cost, `${shippedSlow.page.read}/${shippedSlow.page.of} sources ${shippedSlow.ms}ms`));

    ok("4.1 CONTROL: the fan-out cannot finish on this link, which is the reported symptom",
      baseSlow.page.partial && baseSlow.page.read < baseSlow.page.of,
      { read: baseSlow.page.read, of: baseSlow.page.of });
    ok("4.2 the single read answers WHOLE on the same link", !shippedSlow.page.partial, shippedSlow.page.missing);
    ok("4.3 inside the shipped deadline", shippedSlow.ms < AGGREGATION_DEADLINE_MS, shippedSlow.ms);
    ok("4.4 and it is still a full page", shippedSlow.page.entries.length === LIMIT, shippedSlow.page.entries.length);

    // THE SAME RTT WITH BANDWIDTH TO SPARE, because the two costs answer different questions and the
    // arm above cannot separate them. At 554 KB/s the page itself is most of the wall clock: this
    // corpus's answer is 143 KB of chat plus a 346 KB DM page, so 0.88s of the result is the link
    // moving the bytes the reader asked for and no read shape can remove it. Holding the RTT and
    // lifting the cap isolates what the ROUND TRIPS cost, which is the part a read shape controls.
    Object.assign(latency, { oneWayMs: FIELD.oneWayMs, bytesPerSec: NO_COST.bytesPerSec });
    const latencyOnly = await arm(SPACE, "shipped-rtt", (ep) => activityBackfill(ep, LIMIT));
    Object.assign(latency, NO_COST);
    console.log(`  across 82ms RTT with bandwidth to spare:`);
    console.log(row("single read", latencyOnly.cost, `${latencyOnly.page.read}/${latencyOnly.page.of} sources ${latencyOnly.ms}ms`));
    ok("4.5 with the bytes free the feed still completes whole, and well inside the deadline",
      latencyOnly.ms < AGGREGATION_DEADLINE_MS && !latencyOnly.page.partial, { ms: latencyOnly.ms, missing: latencyOnly.page.missing });
    // WHERE THE REMAINING WALL CLOCK IS, since lifting the bandwidth cap barely moved it: this read
    // is round-trip bound, and almost every one of those round trips is a PULL. `drainWindow` keeps
    // a 32-message rolling buffer in flight on purpose, so an aborted read cannot leave a page's
    // worth of bytes committed to a shared connection, and the page arrives in batches rather than
    // in one request. That bound has its own measurement behind it and is deliberately not touched
    // here; it is the next lever, and this cell is what would notice if it moved.
    ok("4.6 and what it spends is pulls, not consumer lifecycles",
      latencyOnly.cost.next > (latencyOnly.cost.create + latencyOnly.cost.del) * 5,
      { next: latencyOnly.cost.next, lifecycles: latencyOnly.cost.create + latencyOnly.cost.del });

    // WHAT THE COUNTER ACTUALLY COUNTS, which every figure in this section depends on and no cell
    // held until now. The counters run from the writer's `onDeliver`, which fires once a chunk's
    // write to the receiving socket has COMPLETED. Increment on arrival instead and a truncated arm
    // reports chunks that were queued at the proxy and never crossed the link. Section 4's fan-out
    // is exactly that arm: it is cut at the deadline by design, so the error is not hypothetical and
    // it inflates the shape this change argues against, which is the direction that flatters the
    // change. A reviewer found it; it was not caught here.
    //
    // The truncation is real rather than simulated: 64 KB is pushed across a 20 KB/s link and the
    // link is destroyed after 600ms, so most of it is still queued and can never be delivered.
    // Counting on write COMPLETION rather than on write issue is what makes `counted <= received` a
    // safe invariant instead of a race against one in-flight chunk.
    {
      const SINK = PROXY + 101;
      const EDGE = PROXY + 102;
      let received = 0;
      const sink = net.createServer((sock) => { sock.on("data", (b: Buffer) => { received += b.length; }); });
      await new Promise<void>((r) => { sink.listen(SINK, "127.0.0.1", () => r()); });
      const local = zero();
      const edge = countingLink({
        listen: EDGE, target: SINK, latency: { oneWayMs: 5, bytesPerSec: 20_000 }, cost: () => local,
      });
      const c = net.connect(EDGE, "127.0.0.1");
      await new Promise<void>((r) => { c.once("connect", () => r()); });
      const CHUNK = 8_000;
      const PUSHED = CHUNK * 8;
      for (let i = 0; i < 8; i++) c.write(Buffer.alloc(CHUNK, 0x61));
      // WAIT FOR DELIVERY TO START rather than truncating at a fixed delay. TCP coalesces these
      // writes into a few large chunks, so the first delivery lands when a whole coalesced chunk has
      // been paced across the link, not after one CHUNK's worth. A fixed 600ms cut measured a window
      // where nothing had been delivered at all, which made the cell vacuous rather than red.
      for (let i = 0; i < 60 && received === 0; i++) await wait(100);
      await wait(100);
      edge.close();
      c.destroy();
      await wait(400);
      sink.close();
      ok("4.7 the link counter reports what CROSSED the link, not what queued at the proxy",
        local.bytesUp <= received && local.bytesUp < PUSHED && received > 0,
        { counted: local.bytesUp, received, pushed: PUSHED });
      ok("4.8 CONTROL: the truncation really did strand bytes, so 4.7 could have failed",
        received < PUSHED, { received, pushed: PUSHED });
    }
  }
  // ── 5. `/api/dms` ON THE FIELD LINK ───────────────────────────────────────────────────────────
  // The field log has 47 `/api/dms` attempts and 0 successes, and the first hypothesis was
  // contention: the dashboard's `refresh()` issues `/api/activity` and `/api/dms` together on one
  // endpoint connection, so the fan-out beside it was the obvious suspect. MEASURED, IT IS NOT. The
  // three timings below sit within 25% of each other, so what runs beside this read is not what
  // decides whether it finishes.
  //
  // WHAT DECIDES IT IS THE WINDOW. `/api/dms` asks for 500, and the window used to open at four
  // pages, and `drainWindow` delivers everything in the window and keeps the tail. Measured on
  // `544a974b7` at limit 500 against a 2500-message backlog: 1,995,854 to 1,995,859 bytes moved
  // across four runs to return a 346,001-byte page, 257 requests every time, and ALONE on this link
  // 8161ms to 8753ms, so ALL FOUR missed the 8000ms deadline on this host with nothing else on the
  // connection, which is the reported refusal with no contention in it at all. The cost does not
  // keep climbing with the backlog: the old span was `max(limit * 4, 64)`, so at limit 500 it is
  // 2000 messages and any backlog of 2000 or more drains that same window. What sets the cost is
  // the window, and four pages to return one already misses the deadline here.
  {
    Object.assign(latency, FIELD);
    /** The DM read's OWN elapsed time and wire cost, not the time until everything settles. */
    const dmBeside = async (
      tag: string,
      backfill?: (ep: ActivitySource) => Promise<ActivityPage>,
    ): Promise<{ ms: number; dms: number; bytes: number; page?: ActivityPage }> => {
      const ep = await mkEp(SPACE, tag);
      await wait(250);
      cost = zero();
      const t = Date.now();
      const dmRead = ep.dmHistory({ limit: 500 }).then((d) => ({ dms: d.length, ms: Date.now() - t, bytes: cost.bytesDown }));
      const page = backfill ? await backfill(ep as unknown as ActivitySource).catch(() => undefined) : undefined;
      const out = await dmRead;
      await ep.stop();
      await wait(500);
      return { ...out, page };
    };
    const solo = await dmBeside("dms-alone");
    const beforeShape = await dmBeside("dms-vs-fanout", (ep) => fanOutBackfill(ep, LIMIT));
    const after = await dmBeside("dms-vs-single", (ep) => activityBackfill(ep, LIMIT));
    Object.assign(latency, NO_COST);
    console.log("  the same /api/dms read at limit 500, 82ms RTT / 554 KB/s:");
    console.log(`    alone                  ${String(solo.ms).padStart(6)}ms  (${solo.dms} DMs, ${solo.bytes}B moved)`);
    console.log(`    beside the fan-out     ${String(beforeShape.ms).padStart(6)}ms  activity ${beforeShape.page?.read}/${beforeShape.page?.of}`);
    console.log(`    beside the single read ${String(after.ms).padStart(6)}ms  activity ${after.page?.read}/${after.page?.of}`);

    ok("5.1 the DM read finishes inside the deadline ALONE on the field link", solo.ms < AGGREGATION_DEADLINE_MS && solo.dms === 500,
      { ms: solo.ms, dms: solo.dms });
    // THE NAMED CELL for the window change: the ratio is what reliably reds when the four-page
    // window is restored, because it moves 5.8x the page here whatever the link is doing. 5.1 reds
    // with it only on the runs that land past 8000ms, which is why the clock is not the cell.
    ok("5.2 and moves less than twice the page it returns", solo.bytes < 700_000, solo.bytes);
    ok("5.3 it still finishes with the activity read beside it", after.ms < AGGREGATION_DEADLINE_MS, after.ms);
    ok("5.4 and the activity page beside it is whole", after.page !== undefined && !after.page.partial, after.page?.missing);
    // STATED AS MEASUREMENT, NOT ASSERTED. Contention is real and small on this corpus; a cell
    // fixing a ratio here would be measuring this machine's scheduler.
    console.log(`    contention: fan-out beside it costs ${(beforeShape.ms / solo.ms).toFixed(2)}x, the single read ${(after.ms / solo.ms).toFixed(2)}x`);
  }
  // ── 6. WHAT ONE CHANNEL'S READ COSTS ──────────────────────────────────────────────────────────
  // The routes above are not the only callers of the read this change touches. `/api/channels/<name>
  // /history`, the mediated `readHistory`, the console and the agent history tools all read ONE
  // channel, and the narrower first window makes that path slightly WORSE: a single channel is a
  // small fraction of its own stream, which is the case the four-page window was chosen for.
  //
  // MEASURED HERE RATHER THAN ASSERTED, and measured here rather than in a throwaway, because a
  // number in a pull request that cannot be regenerated from the tree is not a measurement. Run this
  // file on a checkout of `544a974b7` for the other column, the same way the sections above get
  // theirs. The cells assert only the shape; the regression itself is a printed number, because
  // fixing a threshold to it would be measuring this corpus.
  {
    const ep = await mkEp(SPACE, "one-channel");
    await wait(250);
    for (const [label, channel, expect] of [
      ["busiest channel", seeded.events[0], 200],
      ["typical chat channel", seeded.chat[0], CORPUS.chatDepth],
    ] as const) {
      cost = zero();
      const page = await ep.channelHistory(channel, { limit: LIMIT });
      const mine = { ...cost };
      const answer = Buffer.byteLength(JSON.stringify(page));
      console.log(row(label, mine, `returned=${page.length} answer=${answer}B`));
      ok(`6.${label === "busiest channel" ? 1 : 3} the ${label} read returns its whole page`, page.length === expect,
        { got: page.length, want: expect });
      ok(`6.${label === "busiest channel" ? 2 : 4} and it is still ONE channel's read: a handful of consumer lifecycles`,
        mine.create <= 8 && mine.del <= 8, { create: mine.create, del: mine.del });
    }
    await ep.stop();
    await wait(400);
  }

  // ── 7. what an ABORTED read leaves committed to the connection ────────────────────────────────
  // THE BOUND THE ROLLING PULL EXISTS FOR, measured on the wire instead of through a victim.
  // `drainWindow` asks the broker for at most 32 messages at a time, so a read abandoned mid-window
  // can only ever have that much in flight. Ask for the whole pending backlog in one pull and the
  // broker is committed to sending all of it down a connection whose reader has already left.
  //
  // THIS USED TO BE MEASURED BY ITS SYMPTOM and no longer can be. `bounded-aggregation` cell 6.9
  // watches the request AFTER a cancelled `/api/dms` and asserts it is not starved by the abandoned
  // work. That worked while the follow-up was a seventy-way fan-out. #1210 made it one read, cheap
  // enough to answer whatever the previous response left behind, so the symptom stopped appearing
  // and the mutation restoring the unbounded pull stopped being caught. Measured here there is no
  // victim to lose: the bytes that keep arriving after the abort ARE the defect.
  //
  // WHICH OF THE TWO CELLS BELOW ACTUALLY DISCRIMINATES, measured rather than assumed. Restoring the
  // unbounded pull does NOT change what arrives after the abort: 165B either way, because the whole
  // page is committed and delivered BEFORE the reader gets to leave. It changes what the aborted
  // read moves in total, 36,877 to 36,882B unmutated across nine runs against about 502,363B on the
  // one mutated run, so 7.3 is the cell the mutation fixture names.
  // 7.2 stays because it is the bound on the other side of the abort and nothing else asserts it.
  //
  // Three cells outside this section (1.7b, 3.2, 4.6) also redden on that mutation, through pull and
  // consumer ratios rather than through the bound. So this section is not the only detector; it is
  // the only one that measures the property the 32-message batch exists for.
  //
  // On the field link, so the read is still in flight when the abort lands.
  {
    Object.assign(latency, FIELD);
    const ep = await mkEp(SPACE, "aborted");
    await wait(250);
    const ac = new AbortController();
    cost = zero();
    const read = ep.dmHistory({ limit: 500, signal: ac.signal }).then(() => "settled" as const, () => "aborted" as const);
    await wait(600);
    const atAbort = { ...cost };
    ac.abort();
    const outcome = await read;
    // Keep the connection open and keep counting. Bytes the broker was already committed to send
    // arrive after the reader is gone, which is the whole cost this bound exists to prevent.
    await wait(3000);
    const settled = { ...cost };
    Object.assign(latency, NO_COST);
    await ep.stop();
    await wait(400);
    const after = settled.bytesDown - atAbort.bytesDown;
    console.log(row("aborted DM read", settled, `outcome=${outcome} atAbort=${atAbort.bytesDown}B after=${after}B`));
    ok("7.1 the read ends as an abort rather than settling", outcome === "aborted", outcome);
    ok("7.2 what the broker sends AFTER the reader leaves is one pull batch, not the backlog",
      after < ABANDONED_CEILING, { after, ceiling: ABANDONED_CEILING });
    ok("7.3 and the whole aborted read moves far less than the backlog it was reading",
      settled.bytesDown < ABANDONED_CEILING * 4, { moved: settled.bytesDown });
  }

  // ── 8. a channel count above the measured create ceiling still ANSWERS ─────────────────────────
  // One create names every requested channel, so the request grows with the count and the CLIENT's
  // request timeout is what gives way: the broker never refuses, it just does not answer in time.
  // Measured on this shape before the filter list was batched: 5,000 filters answered in 5,345ms,
  // and 10,000 did not answer at all, failing `timeout` after 5,023ms. The route then served a
  // correctly-marked partial page with `chat` named missing and NO chat entries at all, where the
  // per-channel fan-out it replaced had still returned thousands of messages on the same corpus.
  //
  // THE ASSERTION IS THAT ENTRIES ARE NON-EMPTY, not that the page is marked partial. An empty page
  // that says it is partial is honest and still useless, and it is what this suite would have
  // called correct: 6.3 and 6.4 in the sibling suite assert the marker and the named source, and
  // both of them PASS while the feed shows nothing. A cell that accepts the marker cannot tell the
  // fix from the defect it replaced, which is why this one looks at the messages.
  {
    const wideSpace = "actcost-wide";
    const chans = Array.from({ length: WIDE }, (_, i) => `w${String(i).padStart(5, "0")}`);
    await setupSpaceStreams({ servers: SERVER, space: wideSpace });
    const seeder = new CotalEndpoint({
      space: wideSpace, servers: SERVER, channels: chans, consume: false, registerPresence: false,
      card: { id: newIdentity().id, name: "wide-seeder", kind: "endpoint" },
    });
    seeder.on("error", () => {});
    await seeder.start();
    for (const c of chans) await seeder.multicast("w", { channel: c });
    await seeder.stop();

    const ep = new CotalEndpoint({
      space: wideSpace, servers: SERVER, channels: [], consume: false, registerPresence: false,
      watchPresence: false, card: { name: "wide-reader", kind: "endpoint" },
    });
    ep.on("error", () => {});
    await ep.start();
    try {
      // CAPTURED, NOT AWAITED BARE. Above the ceiling this read REJECTS, and a throw here would
      // leave 8.0 unprinted and take the suite down as a crash instead of as a failed assertion.
      // A mutation that removes the batching has to make a named cell go red, not make the run
      // disappear, or the proof cannot say which claim it broke.
      const t = Date.now();
      let rows: { channel: string; msg: CotalMessage }[] = [];
      let readErr: Error | undefined;
      try { rows = await ep.multiChannelHistory(chans, { limit: LIMIT }); }
      catch (e) { readErr = e as Error; }
      const ms = Date.now() - t;
      console.log(`  ${WIDE} channel filters answered in ${ms}ms with ${rows.length} messages`);
      ok(`8.0 ${WIDE} channel filters ANSWER at all, where one unbatched create timed out`,
        rows.length > 0, { rows: rows.length, ms, err: readErr?.message });
      ok("8.1 and the page is the newest LIMIT, not a truncated remnant",
        rows.length === Math.min(LIMIT, WIDE), { rows: rows.length, limit: LIMIT });
      // The route, not just the method: a kill on the method alone would not show the feed recovers.
      const page = await activityBackfill(ep as unknown as ActivitySource, LIMIT);
      ok("8.2 the activity feed itself carries chat entries at this channel count",
        page.entries.length > 0, { entries: page.entries.length, partial: page.partial, missing: page.missing });
      ok("8.3 and does not name chat missing", !page.missing.includes("chat"), page.missing);

      // ── 8.4 THE BATCHED READ SELECTS WHAT THE SINGLE CREATE SELECTED ──────────────────────────
      // Batching is only safe if re-cutting the union by stream sequence reproduces the single
      // create's answer. That is a CLAIM, so it is asserted rather than argued: the same corpus is
      // read twice, once as one create and once forced into many small batches, and the two pages
      // must agree message for message AND in order.
      //
      // WHAT THIS CELL DOES NOT CATCH, measured rather than assumed: it does not pin the key the
      // union is re-cut ON. A mutation that merges by the payload's `ts` instead of by stream
      // sequence reorders BOTH arms identically, so they still agree with each other and this cell
      // stays green. That mutation was run against this cell and SURVIVED. An equality between two
      // arms of one implementation can only see what makes the arms differ, and the sort key is not
      // that. The key is pinned in `history-recent` against a corpus published so that `ts` and
      // arrival disagree, which is an oracle outside the implementation rather than a second view
      // of it.
      let one: { channel: string; msg: CotalMessage }[] = [];
      let many: { channel: string; msg: CotalMessage }[] = [];
      try {
        one = await ep.multiChannelHistory(chans.slice(0, 300), { limit: LIMIT });
        many = await ep.multiChannelHistory(chans.slice(0, 300), { limit: LIMIT, batch: 7 });
      } catch { /* 8.4 reports it as a mismatch below rather than crashing the run */ }
      const idOf = (r: { channel: string; msg: CotalMessage }) => `${r.channel}/${r.msg.id}`;
      ok("8.4 one create and 43 batches return the SAME messages in the SAME order",
        one.length > 0 && one.length === many.length && one.every((r, i) => idOf(r) === idOf(many[i])),
        { one: one.map(idOf).slice(0, 4), many: many.map(idOf).slice(0, 4), n: [one.length, many.length] });
      ok("8.5 CONTROL: forcing the small batch really did take many creates, so 8.4 compared two shapes",
        Math.ceil(300 / 7) > 1 && one.length > 0, { batches: Math.ceil(300 / 7), rows: one.length });
    } finally {
      await ep.stop();
    }
  }
} finally {
  link?.close();
  releaseBroker();
  broker.kill("SIGKILL");
  rmSync(store, { recursive: true, force: true });
}

console.log(`activity-read-cost smoke: ${cells - failed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
