/**
 * When a long-lived client renews the credential its connection authenticates with.
 *
 * A fixed point (a margin before `exp`, or one fraction of the lifetime) keeps every client that
 * was issued in the same second renewing in the same second, and each renewal is a reconnect
 * through the auth callout. A fleet restarted together, or one service's connections opened at
 * boot, then rebind together for the rest of their lives. So the point is drawn at random from
 * the middle of the lifetime, and two renewals this process has armed for the same space are kept
 * at least {@link RENEWAL_SPACING_MS} apart.
 */

/** The share of a credential's lifetime the renewal point is drawn from. */
const RENEWAL_WINDOW = Object.freeze({ from: 0.5, to: 0.8 });

/** The least distance between two renewals one process arms for the same space. */
const RENEWAL_SPACING_MS = 1_000;

/** Node fires a delay above 2^31-1 ms after 1 ms, so a later point is waited for in steps. */
const MAX_TIMER_MS = 2_147_483_647;

/** The renewal points armed in this process, by space. */
const armed = new Map<string, Set<number>>();

/** A point in `[from, to]` at least {@link RENEWAL_SPACING_MS} from every `taken` one, uniform over
 *  what is free. A window with no free point gets a uniform one: it cannot be spaced. */
function pickFree(taken: readonly number[], from: number, to: number): number {
  const free: Array<[number, number]> = [];
  let lo = from;
  for (const t of [...taken].sort((a, b) => a - b)) {
    if (t - RENEWAL_SPACING_MS > lo) free.push([lo, Math.min(to, t - RENEWAL_SPACING_MS)]);
    lo = Math.max(lo, t + RENEWAL_SPACING_MS);
    if (lo >= to) break;
  }
  if (lo <= to) free.push([lo, to]);
  const total = free.reduce((sum, [a, b]) => sum + (b - a), 0);
  if (free.length === 0) return from + Math.random() * (to - from);
  let r = Math.random() * total;
  for (const [a, b] of free) {
    if (r <= b - a) return a + r;
    r -= b - a;
  }
  return free[free.length - 1]![1];
}

/**
 * Arm `renew` at a random point between {@link RENEWAL_WINDOW} `from` and `to` of the lifetime
 * `issuedAtMs`..`expiresAtMs`, never sooner than `minDelayMs` from now, and spaced from the other
 * renewals armed for `space` in this process. Returns the cancel, which also frees the point.
 */
export function armRenewal(space: string, issuedAtMs: number, expiresAtMs: number, renew: () => void, minDelayMs = 0): () => void {
  const now = Date.now();
  const life = Math.max(0, expiresAtMs - issuedAtMs);
  const from = Math.max(issuedAtMs + RENEWAL_WINDOW.from * life, now + minDelayMs);
  const to = Math.max(issuedAtMs + RENEWAL_WINDOW.to * life, from);
  const taken = armed.get(space) ?? new Set<number>();
  armed.set(space, taken);
  const at = pickFree([...taken], from, to);
  taken.add(at);
  const release = (): void => {
    taken.delete(at);
    if (taken.size === 0 && armed.get(space) === taken) armed.delete(space);
  };
  let timer: ReturnType<typeof setTimeout>;
  const wait = (): void => {
    const left = at - Date.now();
    timer = setTimeout(left > MAX_TIMER_MS ? wait : () => { release(); renew(); }, Math.min(Math.max(0, left), MAX_TIMER_MS));
    timer.unref?.();
  };
  wait();
  return () => {
    clearTimeout(timer);
    release();
  };
}

/** The latest point {@link armRenewal} draws from for this lifetime. Past it, a held credential is
 *  overdue: a renewal should already have replaced it. */
export function renewalDeadlineMs(issuedAtMs: number, expiresAtMs: number): number {
  return issuedAtMs + RENEWAL_WINDOW.to * Math.max(0, expiresAtMs - issuedAtMs);
}

/** The wait before retry `attempt` (0-based) of a failed renewal or cleanup: `baseMs` doubling to
 *  `capMs`, drawn from the upper half of that step so clients that failed together retry apart. */
export function jitteredBackoffMs(attempt: number, baseMs: number, capMs: number): number {
  const step = Math.min(capMs, baseMs * 2 ** attempt);
  return step / 2 + Math.random() * (step / 2);
}
