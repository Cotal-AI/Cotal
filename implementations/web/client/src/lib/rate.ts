// A rolling count of recent messages, for the "messages per second" figure. It holds a bounded list of
// recent hit times, so memory follows the rate and never the age of the page.

/** The most hit times kept. At the cap the oldest is dropped, so a burst cannot grow memory. */
export const MAX_HITS = 10_000;

/** A counter over the last `windowMs` milliseconds (default 1000). `hit(ts)` records one event at
 *  epoch ms `ts`; a `ts` that is not finite is ignored. `perSecond(now)` counts the hits in
 *  `(now - windowMs, now]` and scales them to a per-second figure, so with the default window it is the
 *  count itself. `now` is passed in and never read from a clock, and it is assumed not to decrease from
 *  one call to the next, because each call drops the hits that have aged out of its window. Only
 *  `perSecond` drops by age, so a hit dated after `now` waits, uncounted, until `now` reaches it. Past
 *  `MAX_HITS` stored hits the oldest go. Throws on a window that is not a positive finite number. */
export function createRate(windowMs = 1000): { hit(ts: number): void; perSecond(now: number): number } {
  if (!Number.isFinite(windowMs) || windowMs <= 0) throw new Error(`createRate needs a positive number of ms, got ${windowMs}`);
  /** Hit times in ascending order. */
  let hits: number[] = [];
  return {
    hit(ts) {
      if (!Number.isFinite(ts)) return;
      const out = hits.length > 0 && ts < hits[hits.length - 1]!;
      hits.push(ts);
      if (out) hits.sort((a, b) => a - b);
      if (hits.length > MAX_HITS) hits.shift();
    },
    perSecond(now) {
      const cutoff = now - windowMs;
      let i = 0;
      while (i < hits.length && hits[i]! <= cutoff) i++;
      if (i > 0) hits = hits.slice(i);
      let inWindow = 0;
      for (const ts of hits) if (ts <= now) inWindow++;
      return (inWindow * 1000) / windowMs;
    },
  };
}
