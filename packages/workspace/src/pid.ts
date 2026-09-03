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
import { readFileSync, rmSync, writeFileSync } from "node:fs";

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

// `MANAGER_PIDFILE` and `MANAGER_DELIVERY_AWARE_MARKER` moved to `local-process.ts`. They became
// `{space}` TEMPLATES rather than bare names, and a template is a local-process concept (that module
// owns the expansion, the pre-upgrade spellings and the byte-exact resolution) rather than a
// pid-parsing one. Both are still exported from the package index, so no importer changed.

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

// ---- CREATION IDENTITY: one stable scheme across launch, record, status and teardown (#969) ----

/**
 * A process identity record, as a pidfile's CONTENT. The pid alone is not a stable identity on any
 * OS: PIDs are recycled (aggressively on Windows, eventually on POSIX), and a teardown that signals
 * a recorded pid therefore signals "whatever holds that number now". The record pins the pid to the
 * process START that claimed it, which is the strongest identity a fresh process can establish
 * without holding a kernel capability (#969 design shape (a)): the start time of a pid is fixed for
 * the life of that pid and changes the moment the number is reused.
 *
 * FORMAT: two whitespace-separated fields, `pid` and `token`. The token is opaque here (see
 * {@link ProcessStartTokenReader} for what produces it); a record carrying only a pid is a LEGACY
 * record (pre-identity build) and every consumer must treat it as such, loud.
 */
export type ProcessIdentityRecord = { pid: number; token: string };

/** What a pidfile's content resolves to. `legacy` is a bare pid (a pre-identity build's record);
 *  `husk` is an empty pre-protocol file; `unattributable` is anything parsePid rejects — the same
 *  three-valued rule the rest of this module applies, so "cannot read the record" is never folded
 *  into "nothing recorded". */
export type ReadRecord = { kind: "record"; record: ProcessIdentityRecord } | { kind: "legacy"; pid: number } | { kind: "husk" } | { kind: "unattributable"; raw: string };

export function parseRecord(raw: string): ReadRecord {
  const trimmed = raw.trim();
  if (trimmed === "") return { kind: "husk" };
  // FIELD SPLIT, not a substring: the token may itself contain digits (it is a timestamp), so
  // anything other than exactly two fields cannot name both a pid and its start.
  const fields = trimmed.split(/\s+/);
  if (fields.length === 1) {
    const pid = parsePid(fields[0]!);
    return pid === undefined ? { kind: "unattributable", raw: trimmed } : { kind: "legacy", pid };
  }
  if (fields.length === 2 && parsePid(fields[0]!) !== undefined && fields[1] !== "")
    return { kind: "record", record: { pid: parsePid(fields[0]!)!, token: fields[1] } };
  return { kind: "unattributable", raw: trimmed };
}

/** Serialize a record. Exactly the inverse of {@link parseRecord}; writing is centralized so a
 *  future format change is one edit, not a fifth copy of `String(pid)`. */
export function formatRecord(record: ProcessIdentityRecord): string {
  return `${record.pid} ${record.token}`;
}

/**
 * The creation-identity token of a live pid: on Linux `/proc/<pid>/stat` field 22 (starttime —
 * ticks since boot, fixed for the life of the pid); on macOS/BSD `ps -o lstart=`; on Windows
 * `undefined`, because no cheap STABLE token exists there (see the Windows note in
 * `advisory-lock.ts`'s `processStartToken` for why a `ps` on PATH is worse than none). A pid whose
 * token is `undefined` can still be recorded — the record then carries no start pin, and teardown
 * warns that it is proceeding without the identity check.
 */
export type ProcessStartTokenReader = (pid: number) => string | undefined;

/** The start token for a pid THIS PROCESS is about to record. Prefer the reader passed by the
 *  caller (tests inject divergence), fall back to the same `/proc`/`ps` read the advisory lock
 *  uses, so the token written at launch and the token compared at teardown come from ONE
 *  implementation. `undefined` (Windows, or a ps-less host) records a pid-only LEGACY record —
 *  visible as such to every reader, never silently. */
export function identityRecord(pid: number, tokenAt: ProcessStartTokenReader = defaultStartToken): ProcessIdentityRecord | { pid: number } {
  const token = tokenAt(pid);
  return token === undefined ? { pid } : { pid, token };
}

/** The start-token reader shared with the advisory lock, so launch and teardown agree on the token
 *  for the same live pid. Imported here rather than reimplemented: two token readers that drift
 *  would make the SAME process look like a stranger at teardown. */
import { processStartToken as defaultStartToken } from "./advisory-lock.js";
export { defaultStartToken };

/** The verdict of {@link assertRecordIdentity}: does the live process behind `pid` still carry the
 *  start this record pinned? `unreadable` is deliberately NOT a variant: the reader signature
 *  returns `undefined` for "cannot look" and that folds into `unpinned` (refuse). This differs from
 *  a legacy record with no pin at all: legacy records warn and proceed for upgrade compatibility,
 *  while a pin that exists but cannot be checked is preserved rather than silently weakened. */
export type IdentityVerdict =
  | { kind: "match" }
  | { kind: "mismatch"; liveToken: string }
  | { kind: "gone" }
  | { kind: "unpinned" };

/**
 * THE identity check a teardown must pass before signalling (#969). This is the "open, verify,
 * terminate" step: verify BEFORE any signal. A record pins a start token; if the pid's CURRENT
 * start differs, the pid was REUSED and the live process is a stranger — refuse, never signal.
 *
 * FAILS CLOSED ON THE CHECK ITSELF: `gone` (the pid is ESRCH-dead; the record is stale and
 * clearable) and `unpinned` (no token could be established for a live pid - a platform that
 * cannot pin, or the process died between the token read and the liveness probe) are both
 * distinct from `match`, and it is the CALLER's rule which of them may clear a record. Only
 * `gone` is ever a safe clear here, because only ESRCH-equivalent evidence proves the recorded
 * process itself gone.
 */
export function assertRecordIdentity(record: ProcessIdentityRecord, tokenAt: ProcessStartTokenReader = defaultStartToken): IdentityVerdict {
  const live = tokenAt(record.pid);
  if (live === undefined) {
    // Distinguish "cannot look" from "looked and it is gone": the token readers return undefined
    // BOTH when the platform cannot answer and when the process does not exist, and those must not
    // share a verdict — a platform that cannot pin must refuse, a dead pid may be cleared.
    const liveness = probeLiveness(record.pid);
    if (liveness === "dead") return { kind: "gone" };
    return { kind: "unpinned" };
  }
  return live === record.token ? { kind: "match" } : { kind: "mismatch", liveToken: live };
}

/** One shared refusal message, so every teardown names the same rule in the same words (#969
 *  acceptance: manager, delivery, auth and broker teardown use the SAME identity rule). */
export function identityRefusal(label: string, path: string, record: ProcessIdentityRecord, live: string): Error {
  return new Error(
    `refusing to stop ${label} (pid ${record.pid}) at ${path}: the pid has been reused (recorded start ${record.token}, the live process started ${live}). Signalling it would kill an unrelated process. The record is preserved.\n` +
    `NEXT: inspect pid ${record.pid} with \`ps -p ${record.pid}\`. If that process should be stopped, stop it, then rerun this command; once the pid is dead the stale record clears automatically.`,
  );
}

/** Warning for the one deliberately reduced-guarantee path: a live pre-pin record. Upgrades must be
 * able to stop the stack that was launched by the previous version. The next launch writes a pin,
 * after which mismatch and torn-pin protection applies in full. */
export function identityLegacyWarning(label: string, pidfilePath: string): string {
  return `! ${label} at ${pidfilePath} predates process identity pinning; signalling it without an identity check. A relaunch will pin the process identity.`;
}

// ---- THE SIBLING IDENTITY PIN: launch writes it, teardown verifies it (#969) ---------------------

/**
 * The pidfile format stays a BARE PID. Every reader of `.cotal/*.pid` across the tree - status,
 * clean, meshes, the web dashboard, smoke suites, and any operator script - keeps working, and a
 * bare-pid pidfile remains a LEGACY record this change must handle with a loud warning, not break. The creation
 * identity therefore lives in a SIBLING file `<pidfile>.identity` (the `manager.delivery-aware`
 * marker pattern), holding the {@link formatRecord} two-field pin. Missing sibling = legacy record;
 * present-but-garbled = torn write, refuse; pid mismatch inside the sibling = torn pairing, refuse.
 */
export function identityPinPath(pidfilePath: string): string {
  return `${pidfilePath}.identity`;
}

/** Write the sibling pin for a pid this launch just spawned. Called AFTER the pidfile write, with
 *  the same pid, so a reader that sees a pidfile with no pin yet is reading either a legacy record
 *  or a launch mid-pairing - both are visible below, never silent. `undefined` token (Windows,
 *  ps-less host) writes NO pin, which is the honest legacy shape for that platform rather than a
 *  pin that cannot be checked. */
export function writeIdentityPin(pidfilePath: string, pid: number, tokenAt: ProcessStartTokenReader = defaultStartToken): void {
  const rec = identityRecord(pid, tokenAt);
  if (!("token" in rec)) return; // platform cannot pin: leave the legacy bare-pid shape, loud
  writeFileSync(identityPinPath(pidfilePath), formatRecord(rec));
}

/** What {@link verifyIdentityPin} found for one pidfile. */
export type PinVerdict =
  | { kind: "legacy" }        // no sibling: a pre-identity record (or a platform that cannot pin)
  | { kind: "match" }         // pinned, and the live process carries the recorded start
  | { kind: "gone" }          // pinned, and the pid is ESRCH-dead: the recorded process is gone
  | { kind: "mismatch"; record: ProcessIdentityRecord; liveToken: string } // PID REUSE: refuse
  | { kind: "torn-pin"; raw: string }        // sibling exists but is not a record
  | { kind: "torn-pairing"; pinPid: number } // sibling names a DIFFERENT pid than the pidfile holds
  | { kind: "unpinned" };     // live pid, but no start token could be established for it

/**
 * THE open-verify step every teardown runs BEFORE signalling (#969). Read the pidfile's bare pid,
 * then the sibling pin, and adjudicate the pairing:
 *   - legacy              -> the caller warns and signals for upgrade compatibility
 *   - match               -> safe to signal; the process behind the pid is the recorded one
 *   - gone                -> ESRCH-proven dead; the caller may clear the record
 *   - mismatch            -> PID REUSE: the pid now fronts a DIFFERENT start; NEVER signal
 *   - torn-pin/torn-pairing/unpinned -> cannot establish identity on a live pid; refuse, preserve
 *
 * The pidfile argument is the SIBLING'S base path (the pidfile itself), and the bare pid is read
 * from it here so the pairing check cannot drift from however the caller read the pid.
 */
export function verifyIdentityPin(pidfilePath: string, tokenAt: ProcessStartTokenReader = defaultStartToken): PinVerdict {
  let rawPid: string;
  try {
    rawPid = readFileSync(pidfilePath, "utf8");
  } catch {
    return { kind: "legacy" }; // no pidfile at all: nothing is pinned; callers treat as absent
  }
  const pidRead = parsePid(rawPid);
  if (pidRead === undefined) return { kind: "legacy" }; // husk/unattributable: existing callers own it
  let rawPin: string;
  try {
    rawPin = readFileSync(identityPinPath(pidfilePath), "utf8");
  } catch {
    // No pin: a LEGACY record. A live one warns and is signalable for upgrade compatibility; a pid
    // that is ESRCH-dead needs no identity proof, so it reports `gone` and the caller clears the
    // stale record. kill(pid, 0) only: this probe signals nothing.
    return probeLiveness(pidRead) === "dead" ? { kind: "gone" } : { kind: "legacy" };
  }
  // The TORN shapes below refuse when the pid is live or unknown - identity cannot be proven.
  // When the pid is ESRCH-dead there is nothing to signal, so the record is clearable whatever
  // state the pin is in: a torn pin must not wedge the cleanup of a process that no longer exists.
  const dead = probeLiveness(pidRead) === "dead";
  const parsed = parseRecord(rawPin);
  if (parsed.kind !== "record") return dead ? { kind: "gone" } : { kind: "torn-pin", raw: parsed.kind === "unattributable" ? parsed.raw : "" };
  if (parsed.record.pid !== pidRead) return dead ? { kind: "gone" } : { kind: "torn-pairing", pinPid: parsed.record.pid };
  const verdict = assertRecordIdentity(parsed.record, tokenAt);
  if (verdict.kind === "match") return { kind: "match" };
  if (verdict.kind === "gone") return { kind: "gone" };
  if (verdict.kind === "mismatch") return { kind: "mismatch", record: parsed.record, liveToken: verdict.liveToken };
  return { kind: "unpinned" };
}

/** Remove the sibling pin together with a pidfile whose process is PROVEN gone. Never called on a
 *  refused stop: the preserved record keeps its pin so the next attempt re-adjudicates. */
export function removeIdentityPin(pidfilePath: string): void {
  rmSync(identityPinPath(pidfilePath), { force: true });
}

/** The loud torn/unpinned refusal, in the same shape as {@link identityRefusal}: name the component,
 *  the file, what was found, and the operator's next step. Legacy records do not reach this helper:
 *  callers emit {@link identityLegacyWarning} and proceed. */
export function identityUncertaintyRefusal(label: string, pidfilePath: string, verdict: PinVerdict): Error {
  const pin = identityPinPath(pidfilePath);
  if (verdict.kind === "torn-pin")
    return new Error(
      `refusing to stop ${label} at ${pidfilePath}: its identity pin ${pin} holds unattributable content ${JSON.stringify(verdict.raw)} - a torn or tampered write. The record is preserved.\n` +
      `NEXT: inspect the recorded process with \`ps\`. If it should be stopped, stop it, then rerun this command; once the pid is dead the stale record clears automatically.`,
    );
  if (verdict.kind === "torn-pairing")
    return new Error(
      `refusing to stop ${label} at ${pidfilePath}: its identity pin ${pin} names pid ${verdict.pinPid}, not the pidfile's pid. The record is preserved.\n` +
      `NEXT: inspect the recorded process with \`ps\`. If it should be stopped, stop it, then rerun this command; once the pid is dead the stale record clears automatically.`,
    );
  if (verdict.kind === "unpinned")
    return new Error(
      `refusing to stop ${label} at ${pidfilePath}: its process is live but no creation identity could be established for it, so target identity cannot be proven. The record is preserved.\n` +
      `NEXT: stop the process, then rerun this command; once the pid is dead the stale record clears automatically.`,
    );
  return new Error(
    `refusing to stop ${label} at ${pidfilePath}: the identity state is unsupported (${verdict.kind}). The record is preserved.\n` +
    `NEXT: stop the process, then rerun this command; once the pid is dead the stale record clears automatically.`,
  );
}
