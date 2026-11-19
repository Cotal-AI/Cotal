export const RESTART_WORK_EXIT_MS = 10_000;

/** Reject `p` with `Error(msg)` if it hasn't settled within `ms`; clears the timer when `p` settles so it
 *  never keeps the loop alive. Used to bound the detached deprovision so its fail-loud log is guaranteed. */
export function withTimeout<T>(p: Promise<T>, ms: number, msg: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(msg)), ms);
  });
  return Promise.race([p.finally(() => clearTimeout(timer)), timeout]);
}
