/**
 * THE LIMIT IS ONE PARAMETER, SO IT GETS ONE PARSE, AND THE SINGLE-CHANNEL READ GETS THE SAME BOUND
 * AS ITS SIBLINGS.
 *
 * WHAT WAS MEASURED BEFORE THIS EXISTED (Cotal #699), against a local nats-server with 12 channels
 * of 60 chat plus 40 DMs, read by the SHIPPED `web` process across a delaying proxy:
 *
 *   ?limit=abc       Number("abc") is NaN. Every comparison against NaN is false, so core's
 *                    `limit <= 0` guard never fires and the widening search's two exits can never
 *                    be true: `page.length >= NaN` is false forever, and `start === 1` compares
 *                    against a NaN start. NO ANSWER after 30s. Worse, the ABANDONED request kept
 *                    running: 0% of a core idle, 58% with the request in flight, and still 53%,
 *                    51% and 46% at five, fifteen and twenty seconds AFTER the caller aborted,
 *                    while the process kept serving every other route, so nothing announced it.
 *                    One GET burns half a core until the dashboard is restarted.
 *   ?limit=Infinity  passes the same guard from the other end, `start` collapses to 1, and
 *                    slice(-Infinity) is the whole array: 31971B, the channel's entire retained
 *                    history, identical to asking for all of it. `1e999` is the same value.
 *   ?limit=2.5       silently truncated to 2, so the page read was not the page requested.
 *   /api/channels/<n>/history took 11360ms on a link where /api/dms already refused at 8005ms,
 *                    because the aggregate routes were given a per-request deadline and this one,
 *                    a single read, was not. The console page re-reads it every poll.
 *
 * WHAT DID **NOT** REPRODUCE, recorded so nobody re-litigates it. #699 argued `?limit=0` returns
 * everything via `slice(-0)`. Measured: `?limit=0` returns 0 entries on all three routes, and so
 * does `?limit=-3`, because `streamHistory` opens with `if (limit <= 0) return []` and the slice the
 * issue reasons about is never reached with a full array. The issue's CONCLUSION (a malformed limit
 * yields an unbounded response) is real; its trigger value was wrong. §1.9 pins 0 at zero so a
 * future change cannot quietly make the original claim true.
 *
 * THE CELLS RUN AGAINST A REAL BROKER AND THE REAL SERVER. A hand-built request object would prove
 * a helper returns what it returns; it would not prove the routes agree, which is the whole defect.
 *
 * Needs nats-server on PATH. Run: pnpm smoke:web-history-limit
 */
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import net, { type AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { CotalEndpoint, isReachable, newIdentity, setupSpaceStreams } from "@cotal-ai/core";
import { SMOKE_BROKER_TOKEN, teardownOnSignal } from "@cotal-ai/smoke-kit";
import { AGGREGATION_DEADLINE_MS } from "../src/web.js";

let cells = 0, failed = 0;
const ok = (name: string, cond: boolean, detail?: unknown): void => {
  cells++;
  if (cond) return;
  failed++;
  console.log(`  x FAIL  ${name}${detail === undefined ? "" : `: ${JSON.stringify(detail)}`}`);
};
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const freePort = async (): Promise<number> => new Promise((res) => {
  const s = net.createServer();
  s.listen(0, "127.0.0.1", () => { const p = (s.address() as AddressInfo).port; s.close(() => res(p)); });
});

/** The link: delay and a throughput cap each way, so the deadline cells are about a slow link and
 *  not about a broken broker. The broker stays local and healthy throughout. */
function slowLink(o: { listen: number; target: number; oneWayMs: number; bytesPerSec: number }): { close(): void } {
  const socks = new Set<net.Socket>();
  const pipe = (from: net.Socket, to: net.Socket) => {
    let clear = 0;
    from.on("data", (c) => {
      const now = Date.now();
      const at = Math.max(now + o.oneWayMs, clear) + (c.length / o.bytesPerSec) * 1000;
      clear = at;
      setTimeout(() => { if (!to.destroyed) to.write(c); }, Math.max(0, at - now)).unref();
    });
    from.on("error", () => to.destroy());
  };
  const srv = net.createServer((cl) => {
    const up = net.connect(o.target, "127.0.0.1");
    socks.add(cl); socks.add(up);
    cl.on("close", () => socks.delete(cl)); up.on("close", () => socks.delete(up));
    pipe(cl, up); pipe(up, cl);
  });
  srv.listen(o.listen, "127.0.0.1");
  return { close: () => { for (const s of socks) s.destroy(); srv.close(); } };
}

/** EVERY REQUEST IN THIS SUITE IS BOUNDED, because a cell whose subject is "this comes back" must
 *  not hang when it does not. With the fix mutated away the unbounded shapes never answer at all,
 *  and a run that dies on the harness timeout reports an unknown instead of reddening the assertion
 *  that names the rule. `null` here means "did not answer", which is the finding, not an error. */
type Answer = { status: number; body: string; ms: number } | null;
const get = async (url: string, ms: number): Promise<Answer> => {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), ms);
  const t0 = Date.now();
  try {
    const r = await fetch(url, { signal: ac.signal });
    return { status: r.status, body: await r.text(), ms: Date.now() - t0 };
  } catch { return null; } finally { clearTimeout(t); }
};
const CEILING_MS = AGGREGATION_DEADLINE_MS * 3;
const len = (a: Answer): number => {
  if (!a) return -1;
  try { const j = JSON.parse(a.body); return Array.isArray(j) ? j.length : Array.isArray(j?.entries) ? j.entries.length : -1; }
  catch { return -1; }
};

const PORT = await freePort(), PROXY = await freePort(), FAST = await freePort(), SLOW = await freePort();
const SERVER = `nats://127.0.0.1:${PORT}`;
const SPACE = "historylimit";
const CHANNELS = 6, PER = 60, BODY = "x".repeat(300);
const store = mkdtempSync(join(tmpdir(), SMOKE_BROKER_TOKEN));
const broker = spawn("nats-server", ["-p", String(PORT), "-js", "-sd", store, "-a", "127.0.0.1"], { stdio: "ignore" });
const release = teardownOnSignal(broker, store);
let link: { close(): void } | undefined;
let fastWeb: ReturnType<typeof spawn> | undefined, slowWeb: ReturnType<typeof spawn> | undefined;
try {
  let up = false;
  for (let i = 0; i < 80; i++) { if (await isReachable(SERVER)) { up = true; break; } await wait(150); }
  if (!up) throw new Error("nats-server did not start");
  await setupSpaceStreams({ servers: SERVER, space: SPACE });

  const names = Array.from({ length: CHANNELS }, (_, i) => `ch${i}`);
  const seed = new CotalEndpoint({ space: SPACE, servers: SERVER, channels: names, consume: false,
    registerPresence: false, card: { id: newIdentity().id, name: "seed", kind: "endpoint" } });
  seed.on("error", () => {});
  await seed.start();
  for (let i = 0; i < PER; i++) await Promise.all(names.map((c) => seed.multicast(`m${i} ${BODY}`, { channel: c })));
  const peer = newIdentity();
  for (let i = 0; i < 40; i++) await seed.unicast(`local.${peer.id}`, `dm${i} ${BODY}`);
  await seed.stop();

  const runWeb = fileURLToPath(new URL("./run-web.mts", import.meta.url));
  const bootWeb = async (port: number, broker: string): Promise<ReturnType<typeof spawn>> => {
    const ch = spawn(process.execPath, ["--import", "tsx", runWeb, "--space", SPACE, "--server", broker,
      "--port", String(port), "--no-open"], { stdio: ["ignore", "pipe", "pipe"] });
    ch.stdout?.on("data", () => {}); ch.stderr?.on("data", () => {});
    for (let i = 0; i < 200; i++) { const r = await fetch(`http://127.0.0.1:${port}/api/meta`).catch(() => undefined); if (r?.ok) break; await wait(250); }
    return ch;
  };
  fastWeb = await bootWeb(FAST, SERVER);
  const F = `http://127.0.0.1:${FAST}`;

  // ── 1. ONE PARSE, AND ALL THREE ROUTES OBEY IT ───────────────────────────────────────────────
  console.log("1. the limit is parsed once, and a value that is not a whole number is refused");
  const ROUTES = ["/api/activity", "/api/dms", "/api/channels/ch0/history"];
  // "99999999999999999999" is the one value here that reaches the SAFE INTEGER check: it is all
  // digits, so the shape test passes it through, and it exceeds what a double counts exactly.
  // Without it that branch has no cell and a mutation of it cannot be graded.
  const BAD = ["abc", "Infinity", "1e999", "2.5", "-3", " 5", "5abc", "1e3", "99999999999999999999"];
  for (const bad of BAD) {
    const answers = await Promise.all(ROUTES.map((r) => get(`${F}${r}?limit=${encodeURIComponent(bad)}`, CEILING_MS)));
    ok(`1.1 ?limit=${JSON.stringify(bad)} is refused by ALL THREE routes, and every one of them ANSWERS`,
      answers.every((a) => a !== null && a.status === 400), { bad, got: answers.map((a) => a?.status ?? "no answer") });
    ok(`1.2 the refusal of ${JSON.stringify(bad)} NAMES the parameter and the value it received`,
      answers.every((a) => !!a && a.body.includes("limit") && a.body.includes(bad)), answers[0]?.body);
    ok(`1.3 the refusal of ${JSON.stringify(bad)} carries no data`, answers.every((a) => len(a) <= 0), answers.map(len));
  }
  const five = await get(`${F}/api/channels/ch0/history?limit=5`, CEILING_MS);
  ok("1.4 a whole number is honoured exactly", five?.status === 200 && len(five) === 5, { status: five?.status, n: len(five) });
  const zero = await get(`${F}/api/channels/ch0/history?limit=0`, CEILING_MS);
  ok("1.5 ZERO STILL MEANS ZERO: the value #699 claimed returns everything returns an empty page",
    zero?.status === 200 && len(zero) === 0, { status: zero?.status, n: len(zero) });
  const absent = await get(`${F}/api/channels/ch0/history`, CEILING_MS);
  const empty = await get(`${F}/api/channels/ch0/history?limit=`, CEILING_MS);
  ok("1.6 an absent limit is the route's own default, and an EMPTY limit is the same as absent",
    absent?.status === 200 && empty?.status === 200 && len(absent) === PER && len(empty) === PER,
    { absent: len(absent), empty: len(empty), expected: PER });
  // A caller error and a server fault are different facts; before the split they shared a status.
  ok("1.7 a malformed request is a 400, NEVER the 500 that means the dashboard broke",
    (await get(`${F}/api/dms?limit=abc`, CEILING_MS))?.status === 400);

  // The core guard that protects every OTHER caller is graded in `smoke:core-history-limit`.
  // It cannot be graded here: the routes above refuse a malformed limit before it can reach
  // core, and this package resolves core through `dist`, where a mutation of core's source has
  // no effect at all. A cell here would have been green either way.

  // ── 3. THE SINGLE-CHANNEL READ IS BOUNDED LIKE ITS SIBLINGS ──────────────────────────────────
  console.log("3. the single-channel read answers within the same deadline the aggregates use");
  // CALIBRATED, AND THE CALIBRATION IS PART OF THE EXPERIMENT. At 24 KiB/s this read finished in
  // 5607ms, comfortably INSIDE the deadline, so the arm answered 200 and every cell below it passed
  // without the rule ever being exercised. The link has to make the read genuinely unfinishable for
  // the refusal to be the correct ending. Slowing it further costs no wall clock: once the deadline
  // fires the arm returns at the deadline whatever the link does, so the margin is free.
  link = slowLink({ listen: PROXY, target: PORT, oneWayMs: 80, bytesPerSec: 6 * 1024 });
  slowWeb = await bootWeb(SLOW, `nats://127.0.0.1:${PROXY}`);
  const S = `http://127.0.0.1:${SLOW}`;
  const slowRead = await get(`${S}/api/channels/ch0/history?limit=${PER}`, CEILING_MS);
  console.log(`   the slow arm answered ${slowRead?.status ?? "not at all"} in ${slowRead?.ms ?? CEILING_MS}ms`);
  ok("3.1 it ANSWERS on a link where it used to run past the deadline unbounded", slowRead !== null,
    "no answer within three deadlines");
  // THE CELL MUST NOT ACCEPT BOTH ENDINGS. An earlier draft passed on a 200 OR a well formed 503,
  // which is a cell that cannot tell the deadline firing from the link being fast, and its 1.5x
  // ceiling would have accepted the 11360ms this change exists to remove. The arm is calibrated so
  // the read CANNOT finish in time, so the refusal is the only correct ending and the assertion
  // says so. If a future machine makes this link fast, 3.2 fails loudly rather than passing empty.
  ok("3.2 THE DEADLINE FIRED: a read that cannot finish in time refuses instead of running on",
    slowRead?.status === 503, { status: slowRead?.status, ms: slowRead?.ms });
  ok("3.3 and the refusal NAMES the channel and the deadline it exceeded, not just a status",
    !!slowRead && slowRead.body.includes("ch0") && slowRead.body.includes(String(AGGREGATION_DEADLINE_MS)),
    slowRead?.body?.slice(0, 160));
  ok("3.3b the refusal lands AT the deadline, not whenever the read happened to give up",
    !!slowRead && slowRead.ms >= AGGREGATION_DEADLINE_MS * 0.9 && slowRead.ms <= AGGREGATION_DEADLINE_MS + 2_500,
    { ms: slowRead?.ms, deadline: AGGREGATION_DEADLINE_MS });
  // The arm is only meaningful if the link is genuinely the cost, so prove the same read is fine
  // without it. Without this, a 503 could be a broken route and the cell would call it a success.
  const fastRead = await get(`${F}/api/channels/ch0/history?limit=${PER}`, CEILING_MS);
  ok("3.4 control: the identical read with no link cost returns the full page, so 3.3 is the link",
    fastRead?.status === 200 && len(fastRead) === PER, { status: fastRead?.status, n: len(fastRead) });
} finally {
  fastWeb?.kill("SIGKILL"); slowWeb?.kill("SIGKILL");
  link?.close(); release(); broker.kill("SIGKILL");
  rmSync(store, { recursive: true, force: true });
}
console.log(failed === 0 ? `web history limit: ${cells} cells OK` : `web history limit: ${failed}/${cells} FAILED`);
process.exit(failed === 0 ? 0 : 1);
