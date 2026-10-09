/** Race `p` against a `ms` deadline, rejecting with `onTimeout()` if the deadline wins. `p` is not
 *  cancelled, so a caller that acts after it settles must fence a late result itself. The 1ms floor
 *  keeps a deadline that has already passed from tripping Node's `TimeoutNegativeWarning`. */
export async function withDeadline<T>(p: Promise<T>, ms: number, onTimeout: () => Error): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, rej) => { timer = setTimeout(() => rej(onTimeout()), Math.max(1, ms)); });
  try { return await Promise.race([p, timeout]); }
  finally { clearTimeout(timer); }
}
