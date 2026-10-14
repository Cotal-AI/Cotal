// A rolling count of recent messages, for the "messages per second" figure. It holds only the hits
// still inside the window, so memory follows the rate and not the age of the page.

/** A counter over the last `windowMs` milliseconds (default 1000). `hit(ts)` records one event at
 *  epoch ms `ts`. `perSecond(now)` counts the hits in `(now - windowMs, now]` and scales them to a
 *  per-second figure, so with the default window it is the count itself. `now` is passed in and never
 *  read from a clock. Hits that have aged out are dropped as calls arrive. Throws on a window that is
 *  not a positive finite number. */
export function createRate(windowMs = 1000): { hit(ts: number): void; perSecond(now: number): number } {
  if (!Number.isFinite(windowMs) || windowMs <= 0) throw new Error(`createRate needs a positive number of ms, got ${windowMs}`);
  /** Hit times in ascending order. */
  let hits: number[] = [];
  const dropUpTo = (cutoff: number) => {
    let i = 0;
    while (i < hits.length && hits[i]! <= cutoff) i++;
    if (i > 0) hits = hits.slice(i);
  };
  return {
    hit(ts) {
      const out = hits.length > 0 && ts < hits[hits.length - 1]!;
      hits.push(ts);
      if (out) hits.sort((a, b) => a - b);
      dropUpTo(hits[hits.length - 1]! - windowMs);
    },
    perSecond(now) {
      dropUpTo(now - windowMs);
      let inWindow = 0;
      for (const ts of hits) if (ts <= now) inWindow++;
      return (inWindow * 1000) / windowMs;
    },
  };
}
