/** Race `p` against a `ms` deadline, rejecting with `onTimeout()` if the deadline wins. `p` is not
 *  cancelled, so a caller that acts after it settles must fence a late result itself. The 1ms floor
 *  keeps a deadline that has already passed from tripping Node's `TimeoutNegativeWarning`. */
export async function withDeadline<T>(p: Promise<T>, ms: number, onTimeout: () => Error): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, rej) => { timer = setTimeout(() => rej(onTimeout()), Math.max(1, ms)); });
  try { return await Promise.race([p, timeout]); }
  finally { clearTimeout(timer); }
}

/** Default budget for an endpoint operation waiting on connection recovery. */
export const CONNECTION_RECOVERY_MS = 10_000;

/** The wait a `Retry-After` header names, in whole seconds. Only one to eight digits above zero, or
 *  an IMF date at most about three years ahead, counts. Anything else, including zero, is absent. */
export function retryAfterSeconds(value: string | null): number | undefined {
  if (!value) return undefined;
  if (/^[0-9]{1,8}$/.test(value)) {
    const seconds = Number(value);
    return seconds > 0 ? seconds : undefined;
  }
  // Anything else is an HTTP date or nothing at all. A value that is not an IMF date is absent:
  // Node's Date.parse reads "-5", "1.5" and "+5" as dates in 2001, which would report a wait of 0.
  if (!/^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun), \d{2} (?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{4} \d{2}:\d{2}:\d{2} GMT$/.test(value)) return undefined;
  const time = Date.parse(value);
  const seconds = Number.isFinite(time) ? Math.ceil((time - Date.now()) / 1000) : undefined;
  return seconds !== undefined && seconds > 0 && seconds <= 99_999_999 ? seconds : undefined;
}
