// The tri-state liveness probe of the pid-attribution contract in `pid.ts`, in a module with no
// imports so a process that must not load the package root can probe a pid. The
// `@cotal-ai/workspace/liveness` subpath is this module: `cotal agent-bearer` runs with it, because a
// seat execs that command for every bearer.

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

/** The liveness probe as a DEPENDENCY. `unknown` is only producible by kernel policy (a seccomp
 *  `SECCOMP_RET_ERRNO` filter, an LSM answering `security_task_kill`), so no test input can reach it
 *  and the branch that handles it would otherwise be guarded by nothing executable. Callers take
 *  this so that branch can be driven directly. Production passes nothing and gets the real one. */
export type LivenessProbe = (pid: number) => "alive" | "dead" | "unknown";

/** Tri-state liveness against the real kernel.
 *
 *  CALLERS MUST PICK A DIRECTION, because the two questions pull opposite ways:
 *    destructive ("may I delete this record?")      -> preserve on doubt: `!== "dead"`
 *    presence    ("is it up, may I skip starting?") -> require proof:    `=== "alive"`
 *  A presence check written as `!== "dead"` turns an `unknown` into a permanent, silent, retry-proof
 *  false-up. Reviewed against a repro that wedged three control-plane retries against an
 *  unreachable manager. */
export function probeLiveness(pid: number): "alive" | "dead" | "unknown" {
  try {
    process.kill(pid, 0);
    return "alive";
  } catch (e) {
    return livenessFromErrno((e as NodeJS.ErrnoException).code);
  }
}
