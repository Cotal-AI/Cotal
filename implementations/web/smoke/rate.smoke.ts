/** The rolling message rate: hits inside the window ending at `now` count, scaled to per second, and
 *  in the first window after the page starts, over the time actually watched. `now` is an argument,
 *  so no cell waits on a clock. */
import { strict as assert } from "node:assert";
import { createRate, MAX_HITS } from "../client/src/lib/rate.js";

let n = 0;
const ok = (name: string, cond: unknown, detail?: unknown) => {
  assert.ok(cond, `${name}${detail === undefined ? "" : `: ${JSON.stringify(detail)}`}`);
  console.log(`  ok ${++n} ${name}`);
};
const attempt = <T>(fn: () => T): { value?: T; threw?: string } => {
  try { return { value: fn() }; } catch (e) { return { threw: String(e) }; }
};

ok("no hits gives 0", createRate().perSecond(10_000) === 0);

const four = createRate();
for (const ts of [9_100, 9_300, 9_600, 9_900]) four.hit(ts);
ok("4 hits within the last second give 4", four.perSecond(10_000) === 4, four.perSecond(10_000));
ok("asking twice gives the same answer", four.perSecond(10_000) === four.perSecond(10_000));

const aged = createRate();
aged.hit(0);
aged.hit(100);
ok("hits older than the window are dropped", aged.perSecond(5_000) === 0, aged.perSecond(5_000));
aged.hit(4_800);
ok("a fresh hit counts after old ones are dropped", aged.perSecond(5_000) === 1, aged.perSecond(5_000));
ok("the rate falls as the window slides past a hit", aged.perSecond(6_000) === 0, aged.perSecond(6_000));

const edge = createRate();
edge.hit(9_000);
edge.hit(9_001);
edge.hit(10_000);
ok("a hit exactly one window before now is out and a hit at now is in", edge.perSecond(10_000) === 2, edge.perSecond(10_000));

const future = createRate();
future.hit(10_500);
ok("a hit after now is not counted yet", future.perSecond(10_000) === 0, future.perSecond(10_000));
ok("it counts once now reaches it", future.perSecond(10_500) === 1, future.perSecond(10_500));

const late = createRate();
late.hit(9_900);
late.hit(9_200);
ok("a hit that arrives out of order still counts", late.perSecond(10_000) === 2, late.perSecond(10_000));
late.hit(20_000);
ok("an out of order hit is dropped with the rest once it ages out", late.perSecond(20_000) === 1, late.perSecond(20_000));

const stale = createRate();
stale.hit(10_000);
stale.hit(9_000);
ok("an out of order hit that is already a full window old does not count", stale.perSecond(10_000) === 1, stale.perSecond(10_000));

const wide = createRate(2_000);
for (const ts of [8_100, 8_900, 9_500, 9_900]) wide.hit(ts);
ok("a 2 second window scales 4 hits to 2 per second", wide.perSecond(10_000) === 2, wide.perSecond(10_000));
const narrow = createRate(500);
for (const ts of [9_600, 9_800]) narrow.hit(ts);
ok("a half second window scales 2 hits to 4 per second", narrow.perSecond(10_000) === 4, narrow.perSecond(10_000));

const dated = createRate();
dated.hit(9_100);
dated.hit(10_500);
ok("a hit dated after now does not evict an older hit still inside the window", dated.perSecond(10_000) === 1, dated.perSecond(10_000));

const capped = createRate(100_000);
for (let i = 1; i <= MAX_HITS + 5; i++) capped.hit(i);
ok("the oldest hits past the cap are gone", capped.perSecond(5) === 0, capped.perSecond(5));
ok("the cap holds and the newest hits are the ones counted", capped.perSecond(MAX_HITS + 5) === (MAX_HITS * 1000) / 100_000, capped.perSecond(MAX_HITS + 5));

const nan = createRate();
nan.hit(Number.NaN);
nan.hit(Number.POSITIVE_INFINITY);
nan.hit(9_500);
ok("a hit with a non-finite time is ignored", nan.perSecond(10_000) === 1 && nan.perSecond(20_000) === 0, nan.perSecond(10_000));

// The first window after the page starts: dividing by the whole window would understate the rate.
const fresh = createRate(10_000, 100_000);
for (const ts of [100_200, 100_400, 100_600]) fresh.hit(ts);
ok("three messages in the page's first second read 3 per second, not 0.3 over a ten second window", fresh.perSecond(100_900) === 3, fresh.perSecond(100_900));
ok("five seconds in, the same three read 0.6 per second: the count over the time watched", fresh.perSecond(105_000) === 0.6, fresh.perSecond(105_000));
ok("once a whole window has passed the full window is used again", fresh.perSecond(110_100) === 0.3, fresh.perSecond(110_100));
const lone = createRate(10_000, 100_000);
lone.hit(100_050);
ok("the time watched is never taken as under a second, so one early message is not a burst", lone.perSecond(100_100) === 1, lone.perSecond(100_100));
const late2 = createRate(10_000, 100_000);
late2.hit(108_000);
ok("a message after eight quiet seconds reads over the eight seconds watched, not over the time since it", late2.perSecond(108_000) === 0.125, late2.perSecond(108_000));
const bareStart = attempt(() => createRate(10_000, Number.NaN));
ok("a start time that is not finite is refused", bareStart.threw !== undefined, bareStart);

for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
  const r = attempt(() => createRate(bad));
  ok(`a window of ${bad} ms is refused`, r.threw !== undefined, r);
}
console.log(`rate: ${n} checks passed`);
