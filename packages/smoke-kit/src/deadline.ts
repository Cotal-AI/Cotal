/**
 * Bound a smoke wait without recording an assertion. The caller must check its result.
 * Rejections propagate. Map a void promise to a completion marker before calling this helper
 * when successful completion must be distinguished from a timeout.
 */
export async function withDeadline<T>(p: Promise<T>, ms: number, what: string): Promise<T | undefined> {
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<undefined>((resolve) => { timer = setTimeout(() => resolve(undefined), ms); });
  try {
    const got = await Promise.race([p.then((v) => ({ v })), late]);
    if (got === undefined) {
      console.log(`  ! ${what} did not end within ${ms}ms`);
      return undefined;
    }
    return got.v;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
