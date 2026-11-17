import { clock, wireDate } from "../../lib/time.js";

/** A wire time as `<time>` in the reader's clock, and nothing when the wire gave none. */
export function Time({ ts }: { ts?: number }) {
  const d = wireDate(ts);
  return d ? <time dateTime={d.toISOString()}>{clock(d)}</time> : null;
}
