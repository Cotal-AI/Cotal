/**
 * What a bearer source hands back on a REFRESH, and which of those answers the endpoint is allowed
 * to adopt (#1561, #1572).
 *
 * `refreshBearer` arms the next refresh from the token it just fetched, and `armBearerRefresh` floors
 * the delay at 5s. A token inside its own 60s margin computes a non-positive delay, so the floor
 * applies. That floor is CORRECT for a short-TTL deployment - `expiry-renewal` mints 5s bearers
 * against the 60s margin, and 5s is exactly its renewal cadence - which is why the fix is not a
 * longer delay. What made #1561 a pointless loop is a source that returns nothing new: the same
 * token comes back, computes non-positive again, and the endpoint hits the auth service every 5s
 * for the rest of that token's life. `BEARER_RETRY_MS` (15s) is bypassed for the same reason
 * `CREDS_RETRY_MS` was on the creds path (#1523): the fetch did not fail. It succeeded and returned
 * material that cannot carry another cycle, and only the `catch` reaches the backoff.
 *
 * So two refusals, and they are different questions:
 *
 *   - ALREADY EXPIRED, whatever else is true of it. An advance-only rule adopts a candidate dying at
 *     now-5s over a held one that died at now-60s, because it does advance (#1572).
 *   - THE SAME BYTES BACK from a source whose token cannot carry the next cycle. Byte identity, not
 *     advancement: `exp` has one second of resolution, so key rotation and a same-second re-read
 *     both hand back a token whose `exp` has not moved, and that material IS new (#1572).
 *
 * THE DISCRIMINATING CELLS are the two that count source reads in a window longer than the 5s floor
 * and shorter than the 15s backoff. One says a refused source reads none; the other says a HEALTHY
 * short-TTL source still reads at the floor, which is what stops the refusal from being widened
 * into a blanket backoff that would strand `expiry-renewal` on dead tokens. The sibling cells (the
 * warning text, the cache staying on the last good token) cannot grade either alone - a future
 * change could emit the message and still adopt.
 *
 * THE MARGIN EDGE is graded on a pinned clock. On a live clock, zero margin is a one-millisecond
 * race, so those cells pin `Date.now` for one refresh and read the delay that refresh arms. The
 * delay also pins the 15s retry value, which the 12s window below only bounds from below.
 *
 * No broker and no auth service: the bearer is a JWT-shaped string, which is all `bearerExpiryMs` and
 * `decodeBearerPrincipal` read. Imported from `../src/` so a mutation on source is visible without a
 * dist rebuild.
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
/** A JWT-shaped bearer: only `sub`, `act.actor` and `exp` are read. `sig` varies the BYTES without
 *  touching a claim, which is what a key rotation does to an otherwise identical token. */
const mintAt = (expSec: number, sig = "sig"): string =>
  `${seg({ alg: "none", typ: "JWT" })}.${seg({ sub: OWNER, act: { actor: ACTOR }, exp: expSec })}.${sig}`;
const mintBearer = (expiresInMs: number, sig = "sig"): string =>
  mintAt(Math.floor((Date.now() + expiresInMs) / 1000), sig);

type Internals = { refreshBearer: (initial?: boolean) => Promise<void>; currentBearer?: string };

const endpoints: CotalEndpoint[] = [];
/** One endpoint per source: `currentBearer` is the state under test, so the arms must not share it. */
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

// ── #1561: the same token back again, from a source that cannot carry the next cycle ──────────────
// A freshly minted 30s token would be a short LIFETIME, which is legitimate - see the short-TTL arm
// below. The defect is a source that re-serves what is already held.
const HEALTHY = mintBearer(10 * 60_000);
const STALE = mintBearer(30_000);
let stuckReads = 0;
const stuck = armed("s1561", async () => { stuckReads++; return stuckReads === 1 ? HEALTHY : STALE; });

await stuck.internals.refreshBearer(true);
c("the initial fetch is adopted", stuck.internals.currentBearer === HEALTHY, stuckReads);

// Seed the cache with STALE so the next read is byte-identical to what is held, which is the shape
// the report describes: the auth service keeps serving one cached token.
await stuck.internals.refreshBearer();
c("a token that is new material is adopted even inside the margin", stuck.internals.currentBearer === STALE);

await stuck.internals.refreshBearer();
c("the SAME token back again is NOT adopted", stuck.internals.currentBearer === STALE, stuckReads);
c(
  "the re-serve refusal is reported as a recoverable retry",
  stuck.warnings.some((e) => /re-served the token already held/.test(e.message) && /retrying/.test(e.message)),
  stuck.warnings.map((e) => e.message),
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
c(
  "an expired candidate is refused even though it ADVANCES the held one",
  dead.internals.currentBearer === DEAD_OLD,
  dead.internals.currentBearer?.slice(0, 24),
);
c(
  "the expiry refusal is reported as a recoverable retry",
  dead.warnings.some((e) => /has already expired/.test(e.message) && /retrying/.test(e.message)),
  dead.warnings.map((e) => e.message),
);

// ── #1572, too wide: re-issued material whose `exp` has not moved ─────────────────────────────────
// `exp` is a whole number of seconds. A key rotation re-signs the same claims under a new key, and a
// short-TTL source read twice inside one wall-clock second answers twice from the same second, so
// both produce a token that is NEW and does not advance. An advancement test refuses these.
const ROTATE_EXP = Math.floor((Date.now() + 30_000) / 1000);
const BEFORE_ROTATION = mintAt(ROTATE_EXP, "oldkey");
const AFTER_ROTATION = mintAt(ROTATE_EXP, "newkey");
let rotateReads = 0;
const rotated = armed("s1572b", async () => { rotateReads++; return rotateReads === 1 ? BEFORE_ROTATION : AFTER_ROTATION; });

await rotated.internals.refreshBearer(true);
await rotated.internals.refreshBearer();
c(
  "a re-signed token carrying the same exp IS adopted",
  rotated.internals.currentBearer === AFTER_ROTATION,
  rotated.internals.currentBearer?.slice(0, 24),
);
c("and it is not reported as a failure", rotated.warnings.length === 0, rotated.warnings.map((e) => e.message));

// ── The margin edge, on a pinned clock ────────────────────────────────────────────────────────────
// The re-serve refusal needs the held token to have no margin left: `exp - now - 60s <= 0`. No cell
// above holds a token near zero, and on a live clock zero is a one-millisecond race. `Date.now` is
// pinned instead, as `secret-fs.smoke.ts` pins it, and put back before any timer can run: the
// refresh awaits only the source, which resolves as a microtask, so every `Date.now()` it makes
// reads the pinned value. Timers keep their own clock. `setTimeout` is wrapped for the same window,
// so the delay the refresh arms is read directly.
const EDGE_EXP = Math.floor(Date.now() / 1000) + 600;
const EDGE = mintAt(EDGE_EXP, "edge");
/** The instant at which EDGE has zero margin left. */
const EDGE_ZERO_MARGIN = EDGE_EXP * 1000 - 60_000;

/** One non-initial refresh at a pinned `now`. Returns every delay it passed to `setTimeout`. */
const refreshAt = async (ep: Internals, nowMs: number): Promise<number[]> => {
  const realNow = Date.now;
  const realSetTimeout = globalThis.setTimeout;
  const delays: number[] = [];
  Date.now = () => nowMs;
  globalThis.setTimeout = ((fn: () => void, ms?: number) => {
    delays.push(ms ?? 0);
    return realSetTimeout(fn, ms);
  }) as unknown as typeof setTimeout;
  try {
    await ep.refreshBearer();
  } finally {
    Date.now = realNow;
    globalThis.setTimeout = realSetTimeout;
  }
  return delays;
};

const zero = armed("s1572d", async () => EDGE);
await zero.internals.refreshBearer(true);
const zeroDelays = await refreshAt(zero.internals, EDGE_ZERO_MARGIN);
c(
  "a re-served token with zero margin left is refused (the margin edge is inclusive)",
  zero.warnings.some((e) => /re-served the token already held/.test(e.message)),
  zero.warnings.map((e) => e.message),
);
c(
  "that refusal arms the retry at 15s (BEARER_RETRY_MS), not at the 5s floor",
  zeroDelays.length === 1 && zeroDelays[0] === 15_000,
  zeroDelays,
);

// The other side of the edge, same token: one millisecond earlier the refusal must not fire. This
// is also what shows the cells above refuse because of the margin and not because of the pinning.
const oneMs = armed("s1572e", async () => EDGE);
await oneMs.internals.refreshBearer(true);
const oneMsDelays = await refreshAt(oneMs.internals, EDGE_ZERO_MARGIN - 1);
c(
  "the same token with 1ms of margin left is adopted, with no warning",
  oneMs.warnings.length === 0 && oneMsDelays.length === 1 && oneMsDelays[0] === 5_000,
  { warnings: oneMs.warnings.map((e) => e.message), oneMsDelays },
);

// A source that caches: the same bytes on every read while the token still has most of its life.
// That is not the #1561 loop, because the delay it arms is minutes, not the floor.
const CACHED = mintBearer(10 * 60_000, "cached");
const cache = armed("s1572f", async () => CACHED);
await cache.internals.refreshBearer(true);
await cache.internals.refreshBearer();
c(
  "a re-served token with most of its life left is adopted, with no warning",
  cache.warnings.length === 0,
  cache.warnings.map((e) => e.message),
);

// ── The cadence, both directions, measured in the same window ─────────────────────────────────────
// Longer than the 5s floor, shorter than the 15s backoff. The refused source must read NONE; the
// healthy short-TTL source must keep reading at the floor, because for it the floor is the renewal
// cadence and a blanket backoff to BEARER_RETRY_MS would leave its 5s token dead most of the time.
let shortReads = 0;
const short = armed("s1572c", async () => { shortReads++; return mintBearer(5_000, `s${shortReads}`); });
await short.internals.refreshBearer(true);

const stuckBaseline = stuckReads, shortBaseline = shortReads;
await wait(12_000);
c("the re-serve refusal backs off past the 5s floor (no re-read in 12s)", stuckReads - stuckBaseline === 0, { stuckReads, stuckBaseline });
c(
  "a healthy short-TTL source still renews at the floor (>= 2 reads in 12s)",
  shortReads - shortBaseline >= 2,
  { shortReads, shortBaseline },
);
c("and none of its renewals is reported as a failure", short.warnings.length === 0, short.warnings.map((e) => e.message));

for (const ep of endpoints) await ep.stop();
console.log(`\n${fail ? "✗" : "✓"} BEARER INSIDE MARGIN ${ok}/${ok + fail}`);
process.exit(fail ? 1 : 0);
