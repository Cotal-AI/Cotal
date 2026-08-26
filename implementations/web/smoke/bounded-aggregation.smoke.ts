/**
 * `/api/activity` MUST ANSWER, AND MUST SAY WHAT IT LEFT OUT.
 *
 * WHAT WAS MEASURED BEFORE THIS EXISTED. A real `cotal web` observing a LOCAL, healthy broker across
 * a latency+bandwidth proxy (160ms RTT, 128 KiB/s), 40 channels, 12000 chat messages, 2000 DMs:
 * `/api/activity?limit=100` answered **500 `{"error":"timeout"}` after 15.94s**, with
 * `! GET /api/activity?limit=100 failed: timeout` in the server log. The same reads for a client ON
 * the broker host finished in 125ms, so the broker was never the cost. At a less constrained
 * 256 KiB/s the identical call SUCCEEDED after 34491ms, which is the same defect with a different
 * ending: nobody is still looking at a panel after half a minute.
 *
 * TWO CAUSES, BOTH IN THE AGGREGATION. It fanned out under `Promise.all`, so ONE channel's rejection
 * discarded every channel that had already answered and became the route's 500. And it had no upper
 * bound at all, so the caller waited for the slowest read however long that took.
 *
 * THIS SUITE RUNS AGAINST A REAL BROKER BEHIND A REAL SLOW LINK. A hand-written stub can be made to
 * hang on command, which proves the deadline fires and proves nothing about whether a page reads in
 * time on a link like the one in the issue. So the link is modelled with a TCP proxy that delays and
 * rate-limits both directions, and the assertions are about what the SHIPPED `activityBackfill`
 * returns through it. The counterpart control - the same corpus read by a client with NO link cost -
 * runs in the same process, because "the aggregation is slow" is only a claim about the link if
 * something proves the broker is fast.
 *
 * WHAT IT DOES NOT CLAIM. It does not claim a number of sources: that depends on the link, and the
 * cell that fixed one would be measuring this machine. It claims the SHAPE - bounded wall time, a
 * page rather than a throw, and a partial that names what is missing and counts what is not.
 *
 * Needs nats-server on PATH. Run: pnpm smoke:web-bounded-aggregation
 */
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import net, { type AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { CotalEndpoint, isReachable, newIdentity, setupSpaceStreams } from "@cotal-ai/core";
import { SMOKE_BROKER_TOKEN, teardownOnSignal } from "@cotal-ai/smoke-kit";
import {
  activityBackfill, AGGREGATION_CONCURRENCY, AGGREGATION_DEADLINE_MS, type ActivitySource,
} from "../src/web.js";

let cells = 0;
let failed = 0;
const ok = (name: string, cond: boolean, detail?: unknown): void => {
  cells++;
  if (cond) return;
  failed++;
  console.log(`  x FAIL  ${name}${detail === undefined ? "" : `: ${JSON.stringify(detail)}`}`);
};
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const freePort = async (): Promise<number> =>
  new Promise((res) => {
    const s = net.createServer();
    s.listen(0, "127.0.0.1", () => { const p = (s.address() as AddressInfo).port; s.close(() => res(p)); });
  });

/** The link between the dashboard process and the broker: `oneWayMs` of delay each way plus a
 *  throughput cap each way. A single TCP flow at a high RTT is bandwidth-delay-product limited and
 *  history reads move pages rather than packets, so BOTH parameters are needed for the cost to be the
 *  one the issue describes. The broker itself stays local and healthy, which is the whole point. */
function slowLink(opts: { listen: number; target: number; oneWayMs: number; bytesPerSec: number }): { close(): void } {
  const sockets = new Set<net.Socket>();
  const pipe = (from: net.Socket, to: net.Socket) => {
    let clear = 0;
    from.on("data", (chunk) => {
      const now = Date.now();
      const at = Math.max(now + opts.oneWayMs, clear) + (chunk.length / opts.bytesPerSec) * 1000;
      clear = at;
      setTimeout(() => { if (!to.destroyed) to.write(chunk); }, Math.max(0, at - now)).unref();
    });
    from.on("error", () => to.destroy());
  };
  const srv = net.createServer((client) => {
    const up = net.connect(opts.target, "127.0.0.1");
    sockets.add(client); sockets.add(up);
    client.on("close", () => sockets.delete(client));
    up.on("close", () => sockets.delete(up));
    pipe(client, up);
    pipe(up, client);
  });
  srv.listen(opts.listen, "127.0.0.1");
  return { close: () => { for (const s of sockets) s.destroy(); srv.close(); } };
}

/** How long the link is left idle between arms. A deadline stops the response, not the broker work:
 *  a read that was abandoned at the deadline keeps moving bytes, and an arm measured on top of the
 *  previous arm's leftovers is measuring the leftovers. */
const SETTLE_MS = 15_000;
const LATE = Symbol("late");

/** The source set `activityBackfill` builds, as reads that resolve to a count. Rebuilt here rather
 *  than imported so a baseline stays fixed while the implementation changes. */
const sourcesOf = async (ep: CotalEndpoint): Promise<(() => Promise<number>)[]> => {
  const chans = await ep.listChannels();
  return [
    ...chans.map((ch) => async () => (await ep.channelHistory(ch.channel, { limit: 100 })).length),
    async () => (await ep.dmHistory({ limit: 100 })).length,
  ];
};
const clockOf = (ms: number) => {
  let done = () => {};
  const until = new Promise<typeof LATE>((res) => { const t = setTimeout(() => res(LATE), ms); t.unref(); done = () => clearTimeout(t); });
  return { until, done };
};

/** A CELL THAT ASSERTS A BOUND MUST NOT ITSELF WAIT WITHOUT ONE. Every call below is one whose whole
 *  subject is that it comes back in time. With the deadline mutated away the same call comes back
 *  only once the link has moved the entire corpus, which on this link is minutes, so the run dies on
 *  the harness timeout and reports an unknown instead of reddening the assertion that names the rule.
 *  The ceiling is three times the deadline: a build that honours the deadline never reaches it, so no
 *  cell here is measuring this constant, and reaching it IS the failure the cell is looking for. The
 *  cells read a LATE result as "did not answer", which is what it is. */
const CEILING_MS = AGGREGATION_DEADLINE_MS * 3;
const within = async <T>(work: Promise<T>, ms: number): Promise<T | typeof LATE> => {
  const clock = clockOf(ms);
  // The abandoned work keeps running: a read in flight has no cancel (#661). Swallowing its later
  // rejection keeps a mutant's failure on the cell that names it rather than on an unhandled reject.
  work.catch(() => {});
  try { return await Promise.race([work, clock.until]); } finally { clock.done(); }
};

/** BASELINE: every source started at once. The shape that shipped. */
async function floodArm(ep: CotalEndpoint): Promise<number> {
  const srcs = await sourcesOf(ep);
  const clock = clockOf(AGGREGATION_DEADLINE_MS);
  try {
    const out = await Promise.all(srcs.map(async (r) => {
      try { return await Promise.race([r(), clock.until]); } catch { return LATE; }
    }));
    return out.filter((x) => x !== LATE).length;
  } finally { clock.done(); await ep.stop(); }
}

const CHANNELS = 40;
const PER_CHANNEL = 120;
const DMS = 1200;
const ONE_WAY_MS = 80;
// CALIBRATED, and the calibration is part of the experiment. Too slow and NOTHING completes inside
// the deadline, which makes the pooled and flood arms both zero and §3 unable to distinguish them;
// too fast and everything completes, which makes §2's partial unreachable. This pair puts the corpus
// astride the deadline: a bounded pool finishes some sources whole, a fan-out finishes almost none.
// §3 asserts the pooled arm is non-zero FIRST, so a machine or a future corpus that drifts out of
// that window fails loudly here instead of comparing two zeroes.
const BYTES_PER_SEC = 512 * 1024;
const BODY = "x".repeat(400);

const PORT = await freePort();
const PROXY = await freePort();
const SERVER = `nats://127.0.0.1:${PORT}`;
const SLOW = `nats://127.0.0.1:${PROXY}`;
const SPACE = "boundedagg";

/** A fresh observer endpoint across the slow link. Fresh per arm: a reused endpoint carries the
 *  previous arm's consumers and connection state, which is state the comparison is not about. */
const mkEp = async (tag: string): Promise<CotalEndpoint> => {
  const ep = new CotalEndpoint({
    space: SPACE, servers: SLOW, channels: [], consume: false, registerPresence: false,
    watchPresence: true, card: { name: `web-${tag}`, kind: "endpoint" },
  });
  ep.on("error", () => {});
  await ep.start();
  return ep;
};

const store = mkdtempSync(join(tmpdir(), SMOKE_BROKER_TOKEN));
const broker = spawn("nats-server", ["-p", String(PORT), "-js", "-sd", store, "-a", "127.0.0.1"], { stdio: "ignore" });
const releaseBroker = teardownOnSignal(broker, store);
let link: { close(): void } | undefined;
let link2: { close(): void } | undefined;
let webChild: ReturnType<typeof spawn> | undefined;
try {
  let up = false;
  for (let i = 0; i < 80; i++) { if (await isReachable(SERVER)) { up = true; break; } await wait(150); }
  if (!up) throw new Error("nats-server did not start");
  await setupSpaceStreams({ servers: SERVER, space: SPACE });

  const names = Array.from({ length: CHANNELS }, (_, i) => `team${String(i).padStart(2, "0")}`);
  const seeder = new CotalEndpoint({
    space: SPACE, servers: SERVER, channels: names, consume: false, registerPresence: false,
    card: { id: newIdentity().id, name: "seeder", kind: "endpoint" },
  });
  seeder.on("error", () => {});
  await seeder.start();
  for (let i = 0; i < PER_CHANNEL; i++)
    await Promise.all(names.map((ch) => seeder.multicast(`msg ${i} ${BODY}`, { channel: ch })));
  const peer = newIdentity();
  for (let i = 0; i < DMS; i++) await seeder.unicast(`local.${peer.id}`, `dm ${i} ${BODY}`);
  await seeder.stop();

  // ── 1. THE CONTROL: the same corpus with no link cost ─────────────────────────────────────────
  // Without this every number below is a claim about a broker rather than about a link, and the
  // repair would be aimed at the wrong thing.
  {
    const ep = new CotalEndpoint({
      space: SPACE, servers: SERVER, channels: [], consume: false, registerPresence: false,
      watchPresence: true, card: { name: "web-local", kind: "endpoint" },
    });
    ep.on("error", () => {});
    await ep.start();
    const t = Date.now();
    const page = await activityBackfill(ep as unknown as ActivitySource, 100);
    const ms = Date.now() - t;
    ok("1.1 CONTROL: on the broker host every source answers", page.read === page.of && page.of === CHANNELS + 1, { read: page.read, of: page.of });
    ok("1.2 CONTROL: and the page is NOT partial", page.partial === false, page.missing);
    ok("1.3 CONTROL: nothing is named missing", page.missing.length === 0, page.missing);
    ok("1.4 CONTROL: well inside the deadline (the broker is not the cost)", ms < AGGREGATION_DEADLINE_MS / 2, ms);
    ok("1.5 CONTROL: and it carries a full page", page.entries.length === 100, page.entries.length);
    await ep.stop();
  }

  // ── 2. THE SAME READS ACROSS THE LINK ─────────────────────────────────────────────────────────
  link = slowLink({ listen: PROXY, target: PORT, oneWayMs: ONE_WAY_MS, bytesPerSec: BYTES_PER_SEC });
  await wait(200);
  {
    const ep = await mkEp("wan");
    const t = Date.now();
    const answered = await within(activityBackfill(ep as unknown as ActivitySource, 100), CEILING_MS);
    const ms = Date.now() - t;
    const page = answered === LATE ? undefined : answered;

    // THE HEADLINE. The shipped version answered 500 after 15.94s on a link of this shape; this one
    // must ANSWER, and must answer inside its own bound. The slack is for the channel list, which is
    // read before the clock's sources start.
    ok("2.0 the suite's own ceiling sits well above the deadline, so a cell that reaches it is a cell about the code and not about this constant", CEILING_MS > AGGREGATION_DEADLINE_MS + 3000, { ceiling: CEILING_MS, deadline: AGGREGATION_DEADLINE_MS });
    ok("2.1 the aggregation ANSWERS rather than throwing, on the link that used to 500 it", typeof page?.partial === "boolean");
    ok("2.2 and it answers inside its own deadline", ms < AGGREGATION_DEADLINE_MS + 3000, { ms, deadline: AGGREGATION_DEADLINE_MS, ceiling: CEILING_MS });
    ok("2.3 the answer says it is PARTIAL rather than looking complete", page?.partial === true, page);
    ok("2.4 it counts what it read, out of what it asked for", page !== undefined && page.read < page.of && page.of === CHANNELS + 1, { read: page?.read, of: page?.of });
    ok("2.5 and NAMES every source that did not answer", page !== undefined && page.missing.length === page.of - page.read, { missing: page?.missing.length, read: page?.read, of: page?.of });
    ok("2.6 the names are the sources, not a count dressed as one", page !== undefined && page.missing.every((m) => m === "direct messages" || names.some((n) => m === `#${n}`)), page?.missing.slice(0, 3));
    ok("2.7 the page carries its own deadline, so a reader can tell WHY it is short", page?.deadlineMs === AGGREGATION_DEADLINE_MS, page?.deadlineMs);
    // A partial that dropped the sources it DID read would be a slower way of returning nothing.
    ok("2.8 every source that answered contributed", page !== undefined && (page.read === 0 || page.entries.length > 0), { read: page?.read, entries: page?.entries.length });
    await ep.stop();
  }

  // ── 3. THE POOL IS WHAT MAKES THE PARTIAL WORTH HAVING ───────────────────────────────────────
  // Starting every source at once over one saturated connection finishes almost none of them: the
  // bytes are spread over reads that all miss the deadline together. That is the shape that shipped,
  // and the baseline is built HERE rather than by passing a wide `concurrency`, so it cannot move
  // when the implementation does. An arm the implementation controls is an arm a regression mutates
  // along with the thing it is supposed to catch.
  //
  // ORDER AND SETTLING ARE PART OF THE EXPERIMENT. A deadline bounds the RESPONSE, not the broker
  // work: an arm's abandoned reads keep moving bytes after it has answered, and the next arm on the
  // same link inherits them. So the baseline runs FIRST and the implementation runs LAST, which
  // biases the comparison AGAINST the claim being made, and the link is left idle in between.
  {
    // §2 abandoned reads of its own and they are still on the link. Settling first means the flood
    // arm is not handed a head start it did not earn.
    await wait(SETTLE_MS);
    const floodRead = await floodArm(await mkEp("flooded"));
    await wait(SETTLE_MS);
    const ep = await mkEp("pooled");
    const pooled = await within(activityBackfill(ep as unknown as ActivitySource, 100), CEILING_MS);
    await ep.stop();
    const page = pooled === LATE ? undefined : pooled;

    ok("3.0 the pooled arm read something at all (two zeroes would compare equal and prove nothing)",
      (page?.read ?? 0) > 0, { pooled: page?.read ?? "did not answer", of: page?.of });
    ok("3.1 the bounded pool reads MORE sources than starting every source at once",
      page !== undefined && page.read > floodRead, { pooled: page?.read ?? "did not answer", flood: floodRead, of: page?.of });
    ok("3.2 and starting them all at once cannot finish the set, which is why the panel was empty rather than short",
      floodRead < CHANNELS + 1, floodRead);
    ok("3.3 the pool is not the whole set (a pool equal to the set is no pool)",
      AGGREGATION_CONCURRENCY < CHANNELS + 1, AGGREGATION_CONCURRENCY);
  }

  // ── 4. ONE BAD SOURCE DOES NOT TAKE THE PAGE ──────────────────────────────────────────────────
  // The `Promise.all` shape turned a single channel's rejection into the route's 500. Driven here
  // with a source that THROWS rather than one that is slow, because they used to have the same
  // catastrophic ending and now must have the same ordinary one.
  {
    const listed = [{ channel: "good", messages: 1 }, { channel: "bad", messages: 1 }];
    const src: ActivitySource = {
      listChannels: async () => listed,
      channelHistory: async (channel) => {
        if (channel === "bad") throw new Error("history: read 3 of 20 messages before the stream ended early");
        return [{ id: "m1", ts: 1, space: SPACE, from: { id: "a", name: "a" }, parts: [{ kind: "text", text: "hi" }] } as never];
      },
      dmHistory: async () => [],
    };
    // The shipped shape made ONE rejection the whole response, so the first assertion is that the
    // call RETURNS at all. Asserted separately from what it returns: a throw here would skip every
    // cell below it and read as an aborted suite rather than as the defect it is.
    let threw: Error | undefined;
    let page: Awaited<ReturnType<typeof activityBackfill>> | undefined;
    try { page = await activityBackfill(src, 100); } catch (e) { threw = e as Error; }
    ok("4.0 one failing channel does not make the whole aggregation throw", threw === undefined, threw?.message);
    if (!page) throw new Error("4.0 failed: nothing to assert on");
    ok("4.1 a channel that THROWS does not discard the channels that answered", page.entries.length === 1, page.entries.length);
    ok("4.2 the failed channel is named missing", page.missing.includes("#bad"), page.missing);
    ok("4.3 the page is marked partial because of it", page.partial === true);
    ok("4.4 and the ones that worked are counted", page.read === 2 && page.of === 3, { read: page.read, of: page.of });
  }
  // CONTROL: the identical harness with nothing failing, so 4.1 cannot be passing on an empty page.
  {
    const src: ActivitySource = {
      listChannels: async () => [{ channel: "good", messages: 1 }],
      channelHistory: async () => [{ id: "m1", ts: 1, space: SPACE, from: { id: "a", name: "a" }, parts: [{ kind: "text", text: "hi" }] } as never],
      dmHistory: async () => [],
    };
    const page = await activityBackfill(src, 100);
    ok("4.5 CONTROL: with nothing failing the page is complete and names nothing", page.partial === false && page.missing.length === 0 && page.entries.length === 1, page);
  }
  // The channel list is a broker read too. With no list there is no partial page to serve, so this
  // one is a REFUSAL and must say so rather than answer `0 of 0` as though the space were empty.
  {
    const src: ActivitySource = {
      listChannels: () => new Promise(() => {}),
      channelHistory: async () => [],
      dmHistory: async () => [],
    };
    let threw: Error | undefined;
    const t = Date.now();
    try { await activityBackfill(src, 100, 300); } catch (e) { threw = e as Error; }
    ok("4.6 a channel list that never arrives is a REFUSAL, not an empty space", threw !== undefined);
    ok("4.7 and the refusal names the deadline it exceeded", /300ms/.test(threw?.message ?? ""), threw?.message);
    ok("4.8 bounded by that deadline rather than by the caller giving up", Date.now() - t < 3000, Date.now() - t);
  }
  // THE LIVE SHAPE OF THE SAME REFUSAL, and the one that actually reached a browser. The registry
  // read has its own timeout inside the client, shorter than this deadline, so on a constrained link
  // it REJECTS before the deadline can fire: measured at 128 KiB/s it rejected with the broker's bare
  // `timeout` after 5s and the browser received `{"error":"timeout"}`. A stub that never resolves
  // exercises the deadline and never exercises this ending, so both are driven.
  {
    const src: ActivitySource = {
      listChannels: async () => { throw new Error("timeout"); },
      channelHistory: async () => [],
      dmHistory: async () => [],
    };
    let threw: Error | undefined;
    try { await activityBackfill(src, 100); } catch (e) { threw = e as Error; }
    ok("4.9 a channel list that REJECTS names the read that failed, not just the broker's bare word",
      /channel list could not be read/.test(threw?.message ?? ""), threw?.message);
    ok("4.10 and it carries the underlying reason rather than replacing it", /timeout/.test(threw?.message ?? ""), threw?.message);
  }

  // ── 5. THE ROUTE, NOT JUST THE FUNCTION ───────────────────────────────────────────────────────
  // Everything above calls `activityBackfill` directly. That proves the aggregation behaves. It does
  // NOT prove the dashboard's ROUTE reaches it, and what the issue reports is a route answering 500.
  // So this section boots the SHIPPED `web()` entry point in its own process and reads its HTTP
  // surface: the bytes a browser actually receives.
  //
  // ON A SLOWER LINK, DELIBERATELY, AND HERE IS WHY. `/api/dms` is ONE read of one subject, so it has
  // no subset to serve and its bound is a REFUSAL rather than a partial. Reaching that bound needs a
  // read that misses the deadline, and this corpus's DM backlog fits inside 8s at the link above.
  // Rather than inflate the corpus until it does not, the server child gets its own link with a lower
  // cap and the DM request asks for the whole backlog. The shape under test is what the route DOES
  // when a read does not finish, not the speed at which it stops finishing: on the link in the issue
  // the same route took 16.59s against a real backlog, which is a 200 nobody is still waiting for.
  {
    const WEB_PORT = await freePort();
    const SLOWER = await freePort();
    link2 = slowLink({ listen: SLOWER, target: PORT, oneWayMs: ONE_WAY_MS, bytesPerSec: 48 * 1024 });
    await wait(200);
    let log = "";
    webChild = spawn(process.execPath, [
      "--import", "tsx", fileURLToPath(new URL("./run-web.mts", import.meta.url)),
      "--server", `nats://127.0.0.1:${SLOWER}`, "--space", SPACE, "--port", String(WEB_PORT), "--no-open",
    ], { stdio: ["ignore", "pipe", "pipe"] });
    webChild.stdout?.on("data", (d: Buffer) => { log += d.toString(); });
    webChild.stderr?.on("data", (d: Buffer) => { log += d.toString(); });

    // Readiness is a real 200 from a CHEAP route, so "the server is up" is never inferred from a
    // process that started and then failed to connect. No skip if it never comes up: the cells below
    // fail, loudly, which is the correct reading of a dashboard that cannot serve.
    let up = false;
    for (let i = 0; i < 200; i++) {
      const r = await fetch(`http://127.0.0.1:${WEB_PORT}/api/roster`).catch(() => undefined);
      if (r?.status === 200) { up = true; break; }
      await wait(250);
    }
    ok("5.0 the shipped `web` entry point serves across the link at all", up, log.slice(-400));

    // CONTROL FIRST, on an idle link: a small route answers. Everything below is about what happens
    // to a LARGE read on this link, and none of it means anything if the link cannot serve the
    // dashboard at all. It runs before the big reads because their abandoned work outlives them.
    const cRes = await fetch(`http://127.0.0.1:${WEB_PORT}/api/channels`).catch((e) => e as Error);
    const cBody = cRes instanceof Error ? undefined : await cRes.json().catch(() => undefined);
    ok("5.1 CONTROL: a small route answers 200 across this link", !(cRes instanceof Error) && cRes.status === 200 && Array.isArray(cBody),
      cRes instanceof Error ? cRes.message : cRes.status);

    const t0 = Date.now();
    const aRes = await fetch(`http://127.0.0.1:${WEB_PORT}/api/activity?limit=100`, { signal: AbortSignal.timeout(CEILING_MS) }).catch((e) => e as Error);
    const aMs = Date.now() - t0;
    const aBody = aRes instanceof Error ? undefined : await aRes.json().catch(() => undefined);
    const status = aRes instanceof Error ? 0 : aRes.status;
    ok("5.2 `/api/activity` ANSWERS 200 where the shipped route answered 500", status === 200, { status, aMs });
    ok("5.3 the body the browser receives is the aggregation's page, MARKED PARTIAL", aBody?.partial === true && aBody?.of === CHANNELS + 1,
      { partial: aBody?.partial, read: aBody?.read, of: aBody?.of });
    ok("5.4 and it NAMES the sources it left out, in the response itself", Array.isArray(aBody?.missing) && aBody.missing.length > 0
      && aBody.missing.every((m: string) => m === "direct messages" || names.some((n) => m === `#${n}`)), aBody?.missing?.slice(0, 3));
    ok("5.5 the route answers inside the deadline it reports", aMs < AGGREGATION_DEADLINE_MS + 5000 && aBody?.deadlineMs === AGGREGATION_DEADLINE_MS,
      { aMs, deadlineMs: aBody?.deadlineMs });

    // The single read. It cannot be partial, so its bound is a named refusal the browser can hold its
    // last good list against - the whole reason `readJson` refuses a non-200 instead of storing it.
    const t1 = Date.now();
    const dRes = await fetch(`http://127.0.0.1:${WEB_PORT}/api/dms?limit=${DMS}`, { signal: AbortSignal.timeout(CEILING_MS) }).catch((e) => e as Error);
    const dMs = Date.now() - t1;
    const dBody = dRes instanceof Error ? undefined : await dRes.json().catch(() => undefined);
    const dStatus = dRes instanceof Error ? 0 : dRes.status;
    ok("5.6 `/api/dms` REFUSES at its deadline rather than answering long after the reader left", dStatus === 503, { dStatus, dMs });
    ok("5.7 and the refusal names the deadline it exceeded", /did not finish within 8000ms/.test(String(dBody?.error)), dBody);
    ok("5.8 bounded in wall time, not just in words", dMs < AGGREGATION_DEADLINE_MS + 5000, dMs);

    // A NAMED LIMIT, DRIVEN RATHER THAN DESCRIBED. The deadline bounds the RESPONSE, not the broker
    // work: a JetStream read in flight has no cancel, so the read abandoned above keeps moving bytes
    // and the NEXT request on this link can be starved by it. Measured: at 128 KiB/s the poll right
    // after a refused DM read was itself refused. This suite does not assert that it fails, because
    // that would pin a defect in place; it asserts the part that must hold either way - whatever the
    // route answers, a reader can act on it. A bare `{"error":"timeout"}`, which is what the shipped
    // build sent, is the thing being forbidden.
    const nRes = await fetch(`http://127.0.0.1:${WEB_PORT}/api/activity?limit=100`, { signal: AbortSignal.timeout(CEILING_MS) }).catch((e) => e as Error);
    const nBody = nRes instanceof Error ? undefined : await nRes.json().catch(() => undefined);
    const nStatus = nRes instanceof Error ? 0 : nRes.status;
    ok("5.9 the request following a refused read either answers or REFUSES LEGIBLY, never with a bare broker word",
      nStatus === 200
        ? nBody?.partial !== undefined
        : typeof nBody?.error === "string" && /channel list|did not finish|deadline/.test(nBody.error),
      { nStatus, body: nBody?.error ?? `partial=${nBody?.partial} read=${nBody?.read}` });

    // The operator watching the server log is the one who can tell a slow link from a broken channel,
    // and the browser's marker never reaches them.
    ok("5.10 the server SAYS in its own log that the page was short, and what it left out",
      /partial: \d+\/\d+ sources within \d+ms, missing /.test(log), log.split("\n").filter((l) => l.includes("partial")).slice(0, 2));
  }
} finally {
  webChild?.kill("SIGKILL");
  link?.close();
  link2?.close();
  releaseBroker();
  broker.kill("SIGKILL");
  rmSync(store, { recursive: true, force: true });
}

console.log(`\nweb bounded-aggregation smoke: ${cells - failed} passed, ${failed} failed`);
if (failed) process.exit(1);
