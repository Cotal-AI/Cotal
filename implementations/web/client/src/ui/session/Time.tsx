import { clock } from "../MessageRow.tsx";

/** A wire time as a Date, or undefined when the wire gave none a Date can hold. */
export function wireDate(ts: number | undefined): Date | undefined {
  if (typeof ts !== "number" || !Number.isFinite(ts)) return undefined;
  const d = new Date(ts);
  return Number.isNaN(d.getTime()) ? undefined : d;
}

/** `hh:mm` for a wire time, or undefined when it has none. */
export const hhmm = (ts: number | undefined): string | undefined => {
  const d = wireDate(ts);
  return d && clock(d);
};

/** A wire time as `<time>` in the reader's clock, and nothing when the wire gave none. */
export function Time({ ts }: { ts?: number }) {
  const d = wireDate(ts);
  return d ? <time dateTime={d.toISOString()}>{clock(d)}</time> : null;
}
