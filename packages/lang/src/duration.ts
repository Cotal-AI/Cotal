/**
 * Durations are strings: "30s", "10m", "4h", "2d". One spelling, no ambient time units, and no
 * bare numbers, so a program never leaves it to the reader to guess whether 30 meant seconds or
 * minutes.
 */

const DURATION_RE = /^(\d+)(ms|s|m|h|d)$/;

const UNIT_MS: Readonly<Record<string, number>> = Object.freeze({
  ms: 1,
  s: 1000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
});

export class DurationError extends Error {
  constructor(value: string) {
    super(
      `"${value}" is not a duration. Durations are a whole number and a unit, one of ms, s, m, h, or d: "30s", "10m", "4h", "2d".`,
    );
    this.name = "DurationError";
  }
}

/** Parse a duration to milliseconds. Throws rather than guessing: there is no fallback unit. */
export function parseDuration(value: string): number {
  const m = DURATION_RE.exec(value);
  if (m === null) throw new DurationError(value);
  const n = Number(m[1]);
  const unit = UNIT_MS[m[2] as string];
  if (!Number.isSafeInteger(n) || unit === undefined) throw new DurationError(value);
  return n * unit;
}

export function isDuration(value: unknown): value is string {
  return typeof value === "string" && DURATION_RE.test(value);
}
