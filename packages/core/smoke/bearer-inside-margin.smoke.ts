/**
 * A bearer source that keeps returning a token already inside its refresh margin must be treated as a
 * FAILED renewal, not adopted (#1561).
 *
 * `refreshBearer` arms the next refresh from the token it just fetched, and `armBearerRefresh` floors
 * the delay at 5s. A token inside its own 60s margin computes a non-positive delay, so the floor
 * applies, the next read returns the same near-dead token, and the loop runs at 5s for its remaining
 * life. `BEARER_RETRY_MS` (15s) is bypassed for the same reason `CREDS_RETRY_MS` was on the creds path
 * (#1523): the fetch did not fail. It succeeded and returned material that is not usable, and only the
 * `catch` reaches the backoff.
 *
 * THE DISCRIMINATING CELL counts source reads in a window longer than the 5s floor and shorter than
 * the 15s backoff: the bug reads ~2 more, the fix reads none. The sibling cells (the warning text, the
 * cache staying on the last good token) cannot grade it alone - a future change could emit the message
 * and still adopt.
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
/** A JWT-shaped bearer: only `sub`, `act.actor` and `exp` are read. */
const mintBearer = (expiresInMs: number): string => {
  const claims = { sub: OWNER, act: { actor: ACTOR }, exp: Math.floor((Date.now() + expiresInMs) / 1000) };
  const seg = (o: unknown) => Buffer.from(JSON.stringify(o), "utf8").toString("base64url");
  return `${seg({ alg: "none", typ: "JWT" })}.${seg(claims)}.sig`;
};

// Healthy first, then a token 30s from expiry — inside the 60s refresh margin, which is exactly what a
// stuck auth service re-serves.
const HEALTHY = mintBearer(10 * 60_000);
let reads = 0;
// The SAME near-dead token on every read after the first. A freshly minted 30s token would be a
// short LIFETIME, which is legitimate — `expiry-renewal` runs on 5s bearers — and refusing it makes
// renewal impossible for that deployment. The defect is a source that re-serves what is already
// held: the token does not advance, so nothing can carry the next cycle.
const STALE = mintBearer(30_000);
const source = async (): Promise<string> => { reads++; return reads === 1 ? HEALTHY : STALE; };

type Internals = { refreshBearer: (initial?: boolean) => Promise<void>; currentBearer?: string };

const ep = new CotalEndpoint({
  space: "s1561",
  card: { name: ACTOR, kind: "agent", owner: OWNER, actor: ACTOR },
  bearer: source,
  sentinelCreds: "creds",
  registerPresence: false,
  watchPresence: false,
  consume: false,
});
const warnings: Error[] = [];
ep.on("error", () => { /* recoverable notices ride `warning`; nothing to rethrow here */ });
ep.on("warning", (err: Error) => { warnings.push(err); });

const internals = ep as unknown as Internals;

// The initial fetch must succeed whatever the source has: there is no previous token to keep, and
// `start()` has to be able to come up.
await internals.refreshBearer(true);
c("the initial fetch is adopted", internals.currentBearer === HEALTHY, reads);

// The refresh: a token inside its own margin.
await internals.refreshBearer();
c("a token that does not advance the expiry is NOT adopted", internals.currentBearer === HEALTHY, internals.currentBearer?.slice(0, 24));
c(
  "the refusal is reported as a recoverable retry",
  warnings.some((e) => /expires no later than the one already held/.test(e.message) && /retrying/.test(e.message)),
  warnings.map((e) => e.message),
);

// The cadence. The 5s floor would fire twice inside this window; the 15s backoff fires not at all.
const baseline = reads;
await wait(12_000);
c("the refusal backs off past the 5s floor (no re-read in 12s)", reads - baseline === 0, { reads, baseline });

await ep.stop();
console.log(`\n${fail ? "✗" : "✓"} BEARER INSIDE MARGIN ${ok}/${ok + fail}`);
process.exit(fail ? 1 : 0);
