/**
 * Connect limits for the auth callout: one process's token buckets, keyed on what the callout could
 * verify about a connect. A bearer whose signature holds draws on its actor's bucket and its owner's,
 * whether or not it has expired; a bearer that does not verify draws on the bucket of the client host
 * the broker saw. A bucket holds a minute's allowance and refills at that rate, so a person's bursts
 * pass and a reconnect loop settles to the sustained rate. The exchange reads the same buckets to
 * refuse a bearer whose connects would be refused.
 */

/** Connects per minute each bucket allows, as a burst and as a sustained rate. */
export interface ConnectLimits {
  /** One actor of one owner (`owner.actor`). */
  readonly actorPerMinute: number;
  /** One owner, across all of its actors. */
  readonly ownerPerMinute: number;
  /** One client host, for bearers that do not verify. */
  readonly hostPerMinute: number;
}

export const DEFAULT_CONNECT_LIMITS: ConnectLimits = { actorPerMinute: 60, ownerPerMinute: 600, hostPerMinute: 60 };

/** Who a connect is charged to: the principal a verified signature names, or the client host. */
export type ConnectSource = { readonly owner: string; readonly actor: string } | { readonly host: string };

/** A connect the limits refuse, as the callout's denial and the exchange's 429 both carry it. Its
 *  message names the bucket that ran out and, for an owner's, the actor connecting. */
export class ConnectRateLimited extends Error {
  readonly code = "RATE_LIMITED";
  constructor(readonly retryAfterSeconds: number, message: string) {
    super(message);
  }
}

/** The limiter drops buckets that have refilled once it holds more than this many keys. */
const SWEEP_FLOOR = 4096;

export class ConnectLimiter {
  readonly limits: ConnectLimits;
  private readonly buckets = new Map<string, { tokens: number; at: number }>();
  private sweepAt = SWEEP_FLOOR;

  constructor(limits: Partial<ConnectLimits> = {}) {
    this.limits = { ...DEFAULT_CONNECT_LIMITS, ...limits };
    for (const [name, n] of Object.entries(this.limits))
      if (!Number.isSafeInteger(n) || n < 1) throw new Error(`connect limits: ${name} must be a positive integer, got ${String(n)}`);
  }

  /** Spend one connect from each bucket the source draws on, or refuse and spend none. */
  take(source: ConnectSource, now = Date.now()): void {
    const draws = this.draws(source);
    this.refuseIfShort(draws, now);
    for (const d of draws) this.buckets.set(d.key, { tokens: this.level(d.key, d.perMinute, now) - 1, at: now });
    if (this.buckets.size > this.sweepAt) this.sweep(now);
  }

  /** Refuse as {@link take} would, spending nothing. */
  check(source: ConnectSource, now = Date.now()): void {
    this.refuseIfShort(this.draws(source), now);
  }

  private draws(source: ConnectSource): Draw[] {
    const over = (subject: string, perMinute: number) => `${subject} is over its limit of ${perMinute} connects a minute`;
    if ("host" in source) {
      const perMinute = this.limits.hostPerMinute;
      return [{ key: `host:${source.host}`, perMinute, refusal: `${over(`host ${source.host}`, perMinute)} with a bearer that does not verify` }];
    }
    const { owner, actor } = source;
    const { actorPerMinute, ownerPerMinute } = this.limits;
    return [
      { key: `actor:${owner}.${actor}`, perMinute: actorPerMinute, refusal: over(`actor ${actor} of owner ${owner}`, actorPerMinute) },
      { key: `owner:${owner}`, perMinute: ownerPerMinute, refusal: `${over(`owner ${owner}`, ownerPerMinute)} (actor ${actor})` },
    ];
  }

  /** Throw for the draw that refills last, when any is short of one connect. */
  private refuseIfShort(draws: Draw[], now: number): void {
    let refused: ConnectRateLimited | undefined;
    for (const d of draws) {
      const level = this.level(d.key, d.perMinute, now);
      if (level >= 1) continue;
      const retryAfterSeconds = Math.max(1, Math.ceil(((1 - level) * 60) / d.perMinute));
      if (refused === undefined || retryAfterSeconds > refused.retryAfterSeconds) refused = new ConnectRateLimited(retryAfterSeconds, d.refusal);
    }
    if (refused !== undefined) throw refused;
  }

  private level(key: string, perMinute: number, now: number): number {
    const b = this.buckets.get(key);
    return b === undefined ? perMinute : refilled(b, perMinute, now);
  }

  /** Drop every bucket that has refilled, which is what a missing key reads as. */
  private sweep(now: number): void {
    for (const [key, b] of this.buckets) {
      const perMinute = key.startsWith("actor:") ? this.limits.actorPerMinute : key.startsWith("owner:") ? this.limits.ownerPerMinute : this.limits.hostPerMinute;
      if (refilled(b, perMinute, now) >= perMinute) this.buckets.delete(key);
    }
    this.sweepAt = Math.max(SWEEP_FLOOR, 2 * this.buckets.size);
  }
}

interface Draw {
  readonly key: string;
  readonly perMinute: number;
  readonly refusal: string;
}

/** A bucket's level now; a clock that stepped back refills nothing. */
function refilled(b: { tokens: number; at: number }, perMinute: number, now: number): number {
  return Math.min(perMinute, b.tokens + (Math.max(0, now - b.at) * perMinute) / 60_000);
}
