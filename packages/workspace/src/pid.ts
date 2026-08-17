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

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

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

// ---- the manager's own record ------------------------------------------------------------------

/** `.cotal/manager.pid` — the running manager's pid. The NAME lives here, in the tier both the CLI
 *  (which reads it to decide whether to start one) and the manager daemon (which writes it on
 *  start) already depend on, because a file written under one constant and read under another is
 *  the same defect as no record at all. */
export const MANAGER_PIDFILE = "manager.pid";

/** `.cotal/manager.delivery-aware` — the sibling marker proving the live manager is a build that
 *  does NOT host Plane-3. Written and removed with the pidfile; it carries the pid it was written
 *  for, so a stale marker cannot be paired with a different manager. */
export const MANAGER_DELIVERY_AWARE_MARKER = "manager.delivery-aware";

// ---- ATTRIBUTION: is the live process behind this record actually ours? -------------------------

/** What was read about ONE pid's command line, three-valued for the same reason liveness is:
 *  "it is something else" and "I could not look" are different facts and only the first may be
 *  acted on. */
export type ProcessCommand =
  /** The process's argv, as the OS reports it. */
  | { kind: "command"; command: string }
  /** No such process — the pid died between the liveness probe and this read, or never existed. */
  | { kind: "gone" }
  /** This platform, sandbox, or permission set cannot answer. NOT "it is foreign". */
  | { kind: "unreadable"; why: string };

/** The command-line reader as a DEPENDENCY, for the same reason {@link LivenessProbe} is one: a
 *  test cannot conjure a live foreign process at a chosen pid, and `unreadable` is reachable only
 *  on platforms the test host may not be. */
export type CommandReader = (pid: number) => ProcessCommand;

/**
 * Read one pid's command line.
 *
 * `/proc` on Linux (no subprocess, no PATH dependency, NUL-separated argv); `ps -p <pid> -o
 * command=` elsewhere on POSIX. Windows has neither and is `unreadable` — deliberately, and
 * harmlessly, because of the asymmetry the callers enforce: attribution may only ever DOWNGRADE a
 * record on affirmative evidence that the live process is something else, so a platform that cannot
 * look behaves exactly as every platform did before this existed.
 */
export function readProcessCommand(pid: number): ProcessCommand {
  if (process.platform === "win32") return { kind: "unreadable", why: "no process-argv source on win32" };
  if (process.platform === "linux") {
    try {
      // argv is NUL-separated and NUL-terminated; the trailing empty field is dropped by the trim.
      return { kind: "command", command: readFileSync(`/proc/${pid}/cmdline`, "utf8").replace(/\0/g, " ").trim() };
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code === "ENOENT" || code === "ESRCH") return { kind: "gone" };
      return { kind: "unreadable", why: `/proc/${pid}/cmdline: ${code ?? (e as Error).message}` };
    }
  }
  const r = spawnSync("ps", ["-p", String(pid), "-o", "command="], { encoding: "utf8" });
  if (r.error) return { kind: "unreadable", why: `ps: ${r.error.message}` };
  const out = (r.stdout ?? "").trim();
  if (r.status === 0 && out !== "") return { kind: "command", command: out };
  if (r.status === 1) return { kind: "gone" }; // ps exits 1 when no process matches
  return { kind: "unreadable", why: `ps exited ${String(r.status)}${out ? `: ${out}` : ""}` };
}

/**
 * Does this command line belong to a Cotal manager?
 *
 * The test is the `supervise` ARGV TOKEN, which is the manager daemon's own subcommand and is
 * present however it was started — by `cotal up`'s detached re-exec, by a container entrypoint, by
 * cron, or typed by hand. Matching the token rather than a path keeps it true across a global
 * install, a `tsx bin/cotal.ts` dev run, and a bundled binary, none of which agree on argv[0].
 *
 * IT FAILS TOWARD "OURS". A process whose argv merely mentions the word reads as a manager, and the
 * cost of that is exactly today's behaviour (a live pid is trusted). The cost of the opposite error
 * — calling a real manager foreign — is a second manager launched onto a live one, so the loose
 * direction is the safe one and is chosen deliberately.
 */
export function commandIsCotalSupervisor(command: string): boolean {
  return /(^|\s)supervise(\s|$)/.test(command);
}
