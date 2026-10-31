/**
 * What a bearer source hands back on a REFRESH, which of those answers the endpoint is allowed to
 * adopt (#1561, #1572), and when the next read is armed.
 *
 * The endpoint renews at a random point between 50% and 80% of the held token's lifetime, never
 * sooner than 5s. Past 80% the held token is overdue. A source that hands back the SAME bytes then
 * has not renewed anything, and adopting them would arm the next read at the 5s floor for the rest
 * of that token's life (#1561). The same bytes earlier in the window are a source that caches, and
 * they are adopted.
 *
 * So two refusals, and they are different questions:
 *
 *   - ALREADY EXPIRED, whatever else is true of it. An advance-only rule adopts a candidate dying at
 *     now-5s over a held one that died at now-60s, because it does advance (#1572).
 *   - THE SAME BYTES BACK past the held token's renewal window. Byte identity, not advancement:
 *     `exp` has one second of resolution, so key rotation and a same-second re-read both hand back
 *     a token whose `exp` has not moved, and that material IS new (#1572).
 *
 * A refusal or a failed fetch retries on a jittered backoff that doubles from 5s, drawn from the
 * upper half of each step, and the run of failures is reported once. A HEALTHY short-TTL source
 * still renews at the 5s floor, which is what stops the refusal from being widened into a blanket
 * backoff that would strand `expiry-renewal` on dead tokens.
 *
 * THE WINDOW EDGE and the armed delays are graded on a pinned clock: `Date.now` and `setTimeout`
 * are wrapped for one refresh, so the delay it arms is read directly.
 *
 * No broker and no auth service: the bearer is a JWT-shaped string, which is all the endpoint's
 * bearer decode reads. Imported from `../src/` so a mutation on source is visible without a dist
 * rebuild.
 *
 * Run: pnpm smoke:bearer-inside-margin
 */
import { CotalEndpoint } from "../src/index.js";

let ok = 0, fail = 0;
const c = (n: string, v: boolean, extra?: unknown) => {
  if (v) { ok++; console.log(`  ✓ ${n}`); }
  else { fail++; console.log(`  x FAIL: ${n}`, extra ?? ""); }
};
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

const OWNER = "local", ACTOR = "probe";
const seg = (o: unknown) => Buffer.from(JSON.stringify(o), "utf8").toString("base64url");
/** A JWT-shaped bearer: only `sub`, `act.actor`, `iat` and `exp` are read. `sig` varies the BYTES
 *  without touching a claim, which is what a key rotation does to an otherwise identical token. */
const mintAt = (expSec: number, sig = "sig", iatSec?: number): string =>
  `${seg({ alg: "none", typ: "JWT" })}.${seg({ sub: OWNER, act: { actor: ACTOR }, exp: expSec, ...(iatSec === undefined ? {} : { iat: iatSec }) })}.${sig}`;
const mintBearer = (expiresInMs: number, sig = "sig"): string =>
  mintAt(Math.floor((Date.now() + expiresInMs) / 1000), sig);

type Internals = { refreshBearer: (initial?: boolean) => Promise<void>; currentBearer?: string };

const endpoints: CotalEndpoint[] = [];
/** One endpoint per source, each in its own space: `currentBearer` is the state under test, and
 *  renewals armed in one space are spaced from each other. */
const armed = (space: string, bearer: () => Promise<string>) => {
  const ep = new CotalEndpoint({
    space,
    card: { name: ACTOR, kind: "agent", owner: OWNER, actor: ACTOR },
    bearer,
    sentinelCreds: "creds",
    registerPresence: false,
    watchPresence: false,
    consume: false,
  });
  const warnings: Error[] = [];
  ep.on("error", () => { /* recoverable notices ride `warning`; nothing to rethrow here */ });
  ep.on("warning", (err: Error) => { warnings.push(err); });
  endpoints.push(ep);
  return { internals: ep as unknown as Internals, warnings };
};

/** One refresh at a pinned `now`. Returns every delay it passed to `setTimeout`. */
const refreshAt = async (ep: Internals, nowMs: number, initial = false): Promise<number[]> => {
  const realNow = Date.now;
  const realSetTimeout = globalThis.setTimeout;
  const delays: number[] = [];
  Date.now = () => nowMs;
  globalThis.setTimeout = ((fn: () => void, ms?: number) => {
    delays.push(ms ?? 0);
    return realSetTimeout(fn, ms);
  }) as unknown as typeof setTimeout;
  try {
    await ep.refreshBearer(initial);
  } finally {
    Date.now = realNow;
    globalThis.setTimeout = realSetTimeout;
  }
  return delays;
};

// ── New material is adopted, whatever its lifetime ────────────────────────────────────────────────
const HEALTHY = mintBearer(10 * 60_000);
const SHORT = mintBearer(30_000);
let shortReads = 0;
const fresh = armed("s1561", async () => { shortReads++; return shortReads === 1 ? HEALTHY : SHORT; });
await fresh.internals.refreshBearer(true);
c("the initial fetch is adopted", fresh.internals.currentBearer === HEALTHY, shortReads);
await fresh.internals.refreshBearer();
c("a token that is new material is adopted even with little life left", fresh.internals.currentBearer === SHORT);

// ── #1561 and the window edge, on a pinned clock ──────────────────────────────────────────────────
// A 600s token issued at EDGE_IAT is overdue from 80% of its life, 480s in.
const EDGE_IAT = Math.floor(Date.now() / 1000);
const EDGE = mintAt(EDGE_IAT + 600, "edge", EDGE_IAT);
const OVERDUE_AT = (EDGE_IAT + 480) * 1000;

const overdue = armed("s1561b", async () => EDGE);
await overdue.internals.refreshBearer(true);
const overdueDelays = await refreshAt(overdue.internals, OVERDUE_AT);
c(
  "the SAME token back past its renewal window is refused (the edge is inclusive)",
  overdue.warnings.some((e) => /re-served the token already held/.test(e.message) && /retrying/.test(e.message)),
  overdue.warnings.map((e) => e.message),
);
c(
  "that refusal arms the first jittered retry, 2.5s to 5s, not the renewal window",
  overdueDelays.length === 1 && overdueDelays[0]! >= 2_500 && overdueDelays[0]! <= 5_000,
  overdueDelays,
);

// The other side of the edge, same token: one millisecond earlier the refusal must not fire. This
// is also what shows the cells above refuse because of the window and not because of the pinning.
const inside = armed("s1561c", async () => EDGE);
await inside.internals.refreshBearer(true);
const insideDelays = await refreshAt(inside.internals, OVERDUE_AT - 1);
c(
  "the same token 1ms inside its window is adopted, with no warning, and re-armed at the 5s floor",
  inside.warnings.length === 0 && insideDelays.length === 1 && insideDelays[0] === 5_000,
  { warnings: inside.warnings.map((e) => e.message), insideDelays },
);

// A source that caches: the same bytes on every read while the token still has most of its life.
const CACHED = mintBearer(10 * 60_000, "cached");
const cache = armed("s1572f", async () => CACHED);
await cache.internals.refreshBearer(true);
await cache.internals.refreshBearer();
c("a re-served token with most of its life left is adopted, with no warning", cache.warnings.length === 0, cache.warnings.map((e) => e.message));

// ── The renewal point is drawn from 50% to 80% of the lifetime ────────────────────────────────────
const points: number[] = [];
for (let i = 0; i < 8; i++) {
  const ep = armed(`s-window-${i}`, async () => EDGE);
  const delays = await refreshAt(ep.internals, EDGE_IAT * 1000, true);
  points.push(...delays);
}
c(
  "a fresh token's renewal is armed between 50% and 80% of its lifetime",
  points.length === 8 && points.every((d) => d >= 300_000 && d <= 480_000),
  points,
);
c("and not at one fixed point", new Set(points.map((d) => Math.round(d / 1000))).size > 1, points);

// Endpoints in one space, issued in the same second, renew at least a second apart.
const spaced: number[] = [];
for (let i = 0; i < 10; i++) {
  const ep = armed("s-shared", async () => EDGE);
  spaced.push(...(await refreshAt(ep.internals, EDGE_IAT * 1000, true)));
}
const sorted = [...spaced].sort((a, b) => a - b);
c(
  "ten endpoints of one space issued in the same second renew at least 1s apart",
  sorted.length === 10 && sorted.every((d, i) => i === 0 || d - sorted[i - 1]! >= 1_000),
  sorted,
);

// ── #1572, too narrow: an advancing candidate that is already dead ────────────────────────────────
const DEAD_OLD = mintBearer(-60_000);
const DEAD_NEW = mintBearer(-5_000);
let deadReads = 0;
const dead = armed("s1572a", async () => { deadReads++; return deadReads === 1 ? DEAD_OLD : DEAD_NEW; });

// The first fetch adopts whatever the source has: there is no cache to protect, and `bindConnection`
// holds the pre-dial guard that refuses to present it. Caught rather than awaited bare, because
// "does not throw" is half of what this cell claims - `refreshBearer` rethrows on the initial fetch,
// so a refusal that reached here would take the process down instead of naming itself.
let initialRefusal: unknown;
try { await dead.internals.refreshBearer(true); } catch (e) { initialRefusal = e; }
c(
  "the initial fetch is adopted even when it is already expired",
  initialRefusal === undefined && dead.internals.currentBearer === DEAD_OLD,
  initialRefusal ?? dead.internals.currentBearer?.slice(0, 24),
);
await dead.internals.refreshBearer();
c("an expired candidate is refused even though it ADVANCES the held one", dead.internals.currentBearer === DEAD_OLD, dead.internals.currentBearer?.slice(0, 24));
c(
  "the expiry refusal is reported as a recoverable retry",
  dead.warnings.some((e) => /has already expired/.test(e.message) && /retrying/.test(e.message)),
  dead.warnings.map((e) => e.message),
);

// ── #1572, too wide: re-issued material whose `exp` has not moved ─────────────────────────────────
const ROTATE_EXP = Math.floor((Date.now() + 30_000) / 1000);
const BEFORE_ROTATION = mintAt(ROTATE_EXP, "oldkey");
const AFTER_ROTATION = mintAt(ROTATE_EXP, "newkey");
let rotateReads = 0;
const rotated = armed("s1572b", async () => { rotateReads++; return rotateReads === 1 ? BEFORE_ROTATION : AFTER_ROTATION; });
await rotated.internals.refreshBearer(true);
await rotated.internals.refreshBearer();
c("a re-signed token carrying the same exp IS adopted", rotated.internals.currentBearer === AFTER_ROTATION, rotated.internals.currentBearer?.slice(0, 24));
c("and it is not reported as a failure", rotated.warnings.length === 0, rotated.warnings.map((e) => e.message));

// The same re-signing past the held token's renewal window, where the re-serve refusal applies. Only
// byte identity tells this new material from the same token back: an advancement test refuses it,
// because its `exp` has not moved.
const EDGE_RESIGNED = mintAt(EDGE_IAT + 600, "edge-newkey", EDGE_IAT);
let resignReads = 0;
const resigned = armed("s1572d", async () => { resignReads++; return resignReads === 1 ? EDGE : EDGE_RESIGNED; });
await resigned.internals.refreshBearer(true);
await refreshAt(resigned.internals, OVERDUE_AT);
c(
  "a re-signed token carrying the same exp past its renewal window IS adopted, with no warning",
  resigned.internals.currentBearer === EDGE_RESIGNED && resigned.warnings.length === 0,
  { adopted: resigned.internals.currentBearer === EDGE_RESIGNED, warnings: resigned.warnings.map((e) => e.message) },
);

// ── A run of failures: one warning, growing jittered retries, and a new run warns again ───────────
let down = true;
const flaky = armed("s-flaky", async () => { if (down) throw new Error("exchange down"); return mintBearer(10 * 60_000, `f${Date.now()}`); });
down = false;
await flaky.internals.refreshBearer(true);
down = true;
const retries: number[] = [];
for (let i = 0; i < 4; i++) retries.push(...(await refreshAt(flaky.internals, Date.now())));
c("a run of four failed renewals is reported once", flaky.warnings.length === 1 && /exchange down/.test(flaky.warnings[0]!.message), flaky.warnings.map((e) => e.message));
c(
  "its retries grow from 2.5-5s through 5-10s, 10-20s and 20-40s",
  retries.length === 4 && [[2_500, 5_000], [5_000, 10_000], [10_000, 20_000], [20_000, 40_000]].every(([lo, hi], i) => retries[i]! >= lo! && retries[i]! <= hi!),
  retries,
);
down = false;
await flaky.internals.refreshBearer();
down = true;
await flaky.internals.refreshBearer();
c("after a renewal works, the next failure is reported again", flaky.warnings.length === 2, flaky.warnings.map((e) => e.message));

// ── The cadence of a healthy short-TTL source, on the live clock ──────────────────────────────────
// For it the 5s floor is the renewal cadence: a blanket backoff would leave its 5s token dead most
// of the time.
let fiveReads = 0;
const five = armed("s1572c", async () => { fiveReads++; return mintBearer(5_000, `s${fiveReads}`); });
await five.internals.refreshBearer(true);
const fiveBaseline = fiveReads;
await wait(12_000);
c("a healthy short-TTL source still renews at the floor (>= 2 reads in 12s)", fiveReads - fiveBaseline >= 2, { fiveReads, fiveBaseline });
c("and none of its renewals is reported as a failure", five.warnings.length === 0, five.warnings.map((e) => e.message));

for (const ep of endpoints) await ep.stop();
console.log(`\n${fail ? "✗" : "✓"} BEARER INSIDE MARGIN ${ok}/${ok + fail}`);
process.exit(fail ? 1 : 0);
