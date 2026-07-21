/**
 * THE pid-attribution contract for the CLI's pidfile subsystem, in ONE place.
 *
 * Two copies of "parse a pid" + "is it alive" had drifted (a bounded parser in `auth-proc`, an
 * unbounded `Number.isInteger` parser plus a two-state `isAlive` in `down`), and the gap between a
 * guard's validity predicate and what `process.kill` actually accepts is exactly where a live
 * process gets misread as dead and its pidfile deleted under a clean-stop report. One parser, one
 * tri-state probe, consumed everywhere - so every surface that decides "is this record a live
 * process, a dead one, or unattributable" decides it the same way.
 */

/** A Node/POSIX-signalable pid: a positive INTEGER within the signed 32-bit range `process.kill`
 *  accepts (it throws `ERR_INVALID_ARG_TYPE`/`ERR_OUT_OF_RANGE` outside it). Anything else -
 *  fractional, non-numeric, non-positive, oversized - is undefined: UNATTRIBUTABLE, never a pid to
 *  probe or delete a record against. */
export function parsePid(raw: string): number | undefined {
  const n = Number(raw.trim());
  return Number.isInteger(n) && n > 0 && n <= 0x7fffffff ? n : undefined;
}

/** Tri-state liveness. The whole contract turns on one rule: only an actual `ESRCH` proves a
 *  process gone. A successful `kill(pid,0)` or an EPERM (it exists but is another user's, so we
 *  cannot signal it) means alive; ANY other outcome - argument/range errors, unknown errnos - is
 *  UNKNOWN, never dead. A two-state boolean collapses `unknown` into `dead`, which is the defect:
 *  a value the kernel will not accept then has its record deleted and a replacement launched.
 *  Callers reclaim/remove ONLY on `dead`; `alive` and `unknown` both preserve. */
export function probeLiveness(pid: number): "alive" | "dead" | "unknown" {
  try {
    process.kill(pid, 0);
    return "alive";
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "ESRCH") return "dead";
    if (code === "EPERM") return "alive"; // exists, just not ours to signal
    return "unknown"; // ERR_INVALID_ARG_TYPE / ERR_OUT_OF_RANGE / anything else - cannot attribute
  }
}
