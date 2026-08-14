/**
 * THE pid-attribution contract for machine-local pidfiles, in ONE place.
 *
 * Two copies of "parse a pid" + "is it alive" had drifted (a bounded parser in `auth-proc`, an
 * unbounded `Number.isInteger` parser plus a two-state `isAlive` in `down`), and the gap between a
 * guard's validity predicate and what `process.kill` actually accepts is exactly where a live
 * process gets misread as dead and its pidfile deleted under a clean-stop report. One parser, one
 * tri-state probe, so every surface that decides "is this record a live process, a dead one, or
 * unattributable" decides it the same way.
 *
 * WHO CAN ACTUALLY CONSUME IT, because "consumed everywhere" was never reachable and claiming it
 * hid the gap. This lives in `workspace` (machine-local operator tooling), the widest tier that may
 * hold a local-process concept: the CLI, the manager, the auth service and the web surface all
 * depend on it. `extensions/*` peer-depend `core` ONLY, and a pid probe is not a wire concept, so
 * moving it into core to reach them would leak a local concern into the standard. The two
 * extension-side probes (`connector-opencode`, `connector-hermes`) therefore keep their own copies
 * BY CONSTRUCTION, not by oversight; if they need this contract, the fix is a shared local-process
 * module they may depend on, never a core export.
 */

/** A Node/POSIX-signalable pid: a positive INTEGER within the signed 32-bit range `process.kill`
 *  accepts (it throws `ERR_INVALID_ARG_TYPE`/`ERR_OUT_OF_RANGE` outside it). Anything else -
 *  fractional, non-numeric, non-positive, oversized - is undefined: UNATTRIBUTABLE, never a pid to
 *  probe or delete a record against. */
export function parsePid(raw: string): number | undefined {
  const n = Number(raw.trim());
  return Number.isInteger(n) && n > 0 && n <= 0x7fffffff ? n : undefined;
}

/** The errno-to-state MAPPING, split out from the syscall so it can be tested exhaustively without
 *  an environment in the loop. The whole contract turns on one rule: only an actual `ESRCH` proves a
 *  process gone. `EPERM` (it exists, it is just another user's, so we cannot signal it) is ALIVE.
 *  Anything else - argument/range errors, unfamiliar errnos, a missing code - is UNKNOWN, never dead.
 *
 *  This is exported because the old suite could only reach the EPERM rule by probing pid 1 and
 *  hoping the process was unprivileged, so as root or in some containers that cell SKIPPED and the
 *  suite still printed a passing banner: a wrong implementation reading green. A pure mapping has
 *  no fixture to skip. Found by review, not by me. */
export function livenessFromErrno(code: string | undefined): "alive" | "dead" | "unknown" {
  if (code === "ESRCH") return "dead";
  if (code === "EPERM") return "alive"; // exists, just not ours to signal
  return "unknown"; // ERR_INVALID_ARG_TYPE / ERR_OUT_OF_RANGE / anything else - cannot attribute
}

/** Tri-state liveness against the real kernel.
 *
 *  CALLERS MUST PICK A DIRECTION, because the two questions pull opposite ways:
 *    destructive ("may I delete this record?")      -> preserve on doubt: `!== "dead"`
 *    presence    ("is it up, may I skip starting?") -> require proof:    `=== "alive"`
 *  A presence check written as `!== "dead"` turns an `unknown` into a permanent, silent, retry-proof
 *  false-up. Reviewed against a repro that wedged three control-plane retries against an
 *  unreachable manager. */
/** The liveness probe as a DEPENDENCY. `unknown` is only producible by kernel policy (a seccomp
 *  `SECCOMP_RET_ERRNO` filter, an LSM answering `security_task_kill`), so no test input can reach it
 *  and the branch that handles it would otherwise be guarded by nothing executable. Callers take
 *  this so that branch can be driven directly. Production passes nothing and gets the real one. */
export type LivenessProbe = (pid: number) => "alive" | "dead" | "unknown";

export function probeLiveness(pid: number): "alive" | "dead" | "unknown" {
  try {
    process.kill(pid, 0);
    return "alive";
  } catch (e) {
    return livenessFromErrno((e as NodeJS.ErrnoException).code);
  }
}
