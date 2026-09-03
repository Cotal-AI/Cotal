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
 *   - ROUND TRIPS: client→broker `PUB $JS.API.CONSUMER.…` lines, split by verb. A consumer lifecycle
 *     is a CREATE plus its pulls plus a DELETE, and each is one request the link has to carry.
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
 *     544a974b7, the code that shipped        2524 requests   8,015,723 B
 *     this file's frozen fan-out arm          2863 requests   7,744,207 B
 *     the single read                          143 requests     908,420 B
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
 * §4, where the link is modelled at the field's own parameters and the assertion is only the shape
 * (the shipped arm answers whole; the fan-out does not). Round trips and bytes are properties of the
 * protocol and the corpus, not of the host, which is why the cells that gate the fix are those.
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
 *  terminated lines and only a line that BEGINS with `PUB $JS.API.CONSUMER.` is counted. A payload
 *  line cannot begin that way, and a subject split across two chunks is rejoined before it is
 *  matched, so neither over- nor under-counts.
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
    const toBroker = throttledWriter(upstream, opts.latency);
    const toClient = throttledWriter(client, opts.latency);
    let pending = "";
    client.on("data", (chunk: Buffer) => {
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
      toBroker.push(chunk);
    });
    upstream.on("data", (chunk: Buffer) => { opts.cost().bytesDown += chunk.length; toClient.push(chunk); });
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
const LIMIT = 200;
const BODY = "x".repeat(400);
/** The field link: 82ms RTT, 554 KB/s, both directions. */
const FIELD = { oneWayMs: 41, bytesPerSec: 554 * 1024 };
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
  // `544a974b7` at limit 500 against a 2500-message backlog: 1,995,859 bytes moved to return a
  // 346,001-byte page, 257 requests, and ALONE on this link 8852ms and 7857ms across two runs, so it
  // straddles the 8000ms deadline on this host with nothing else on the connection. A deployment
  // whose backlog is larger sits on the wrong side of it every time, which is the reported refusal,
  // with no contention in it at all.
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
    // THE NAMED CELL for the window change. A four-page window moves 5.8x the page here and takes
    // 8852ms, so restoring it turns this red on the ratio and 5.1 red on the clock.
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
} finally {
  link?.close();
  releaseBroker();
  broker.kill("SIGKILL");
  rmSync(store, { recursive: true, force: true });
}

console.log(`activity-read-cost smoke: ${cells - failed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
