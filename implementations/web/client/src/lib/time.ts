// Wall-clock times as the dashboard prints them. Pure, so the work fold and the React parts share one
// copy.

/** A wire time as a Date, or undefined when the wire gave none a Date can hold. */
export function wireDate(ts: number | undefined): Date | undefined {
  if (typeof ts !== "number" || !Number.isFinite(ts)) return undefined;
  const d = new Date(ts);
  return Number.isNaN(d.getTime()) ? undefined : d;
}

/** `hh:mm` in the reader's own clock. */
export const clock = (d: Date): string => `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;

/** `hh:mm` for a wire time, or undefined when it has none. */
export const hhmm = (ts: number | undefined): string | undefined => {
  const d = wireDate(ts);
  return d && clock(d);
};
