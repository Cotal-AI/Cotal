import { readdirSync, readFileSync, rmSync } from "node:fs";
import { isAbsolute, join, normalize, dirname, basename } from "node:path";
import type { Extension } from "@cotal-ai/core";
import { spaceKey } from "./auth-paths.js";
import { parsePid, probeLiveness } from "./pid.js";

/** Context supplied to local process providers by workstation commands such as `down` and `status`. */
export interface LocalProcessContext {
  readonly root: string;
  readonly space: string;
  readonly userAuth?: boolean;
}

/** A workstation-owned process recorded by a pidfile under a mesh root. Optional packages register
 *  these beside their commands so lifecycle commands stay ignorant of package-specific processes.
 *  Metadata is declarative and cached at install time: status/down never import package code. An
 *  extension-provided process must claim its pidfile with an exclusive create and refuse an existing
 *  file; extension removal reserves the same path so startup and uninstall cannot cross. */
export interface LocalProcess extends Extension {
  readonly kind: "local-process";
  readonly name: string;
  readonly label: string;
  /** Lower orders stop first; the broker should remain last so dependants can shut down cleanly. */
  readonly order?: number;
  /** Path relative to `<root>/.cotal`; `{space}` expands to the injective hex space key
   *  (`spaceKey` — case-safe, so two case-differing spaces can never share a pid/log file). */
  readonly pidFile: string;
  /** Files removed only after the process is confirmed gone. Same template rules as `pidFile`. */
  readonly artifacts?: readonly string[];
  /** Refuse selective shutdown while any unselected registered process is still live. */
  readonly stopLast?: boolean;
  /** Removing this process also clears transient run state and the machine mesh registry entry. */
  readonly clearsMesh?: boolean;
  /** Hide this process from status unless the selected mesh uses per-user auth. */
  readonly visibleWhen?: "user-auth";
  /** Which mesh root a selective stop resolves this process's pidfile under. Absent: the folder the
   *  command runs in (the broker stack `up` started there). `"target"`: the machine mesh-target
   *  resolution (registry current mesh first, then the folder) — for a process whose START is
   *  target-resolved from any directory and records its pidfile under the TARGET mesh's root; a
   *  cwd-only stop would miss the live process. Bare whole-stack sweeps stay folder-scoped. */
  readonly rootedAt?: "target";
}

// ---- the runtime records, per space -------------------------------------------------------------

/** `.cotal/manager.<spaceKey>.pid` — the running manager's record, KEYED BY SPACE.
 *
 *  The NAME lives in this tier because both the CLI (which reads it to decide whether to start one)
 *  and the manager daemon (which writes it on start) already depend on it, and a file written under
 *  one constant and read under another is the same defect as no record at all.
 *
 *  It is a `{space}` TEMPLATE rather than a bare name because the record is per-tenant in meaning: a
 *  root-scoped `manager.pid` gave one workspace root exactly one manager BY FILENAME, so a second
 *  space booting in that root overwrote the first space's record and every reader then answered
 *  about the wrong process. `auth-service.{space}.pid` was already templated; these were not. */
export const MANAGER_PIDFILE = "manager.{space}.pid";

/** `.cotal/manager.<spaceKey>.log` — where a detached manager's output goes. Per-space for the same
 *  reason the pidfile is: two spaces' managers sharing one log interleave two meshes' console URLs
 *  (each a standing credential) into one 0600 file that neither tenant alone owns. */
export const MANAGER_LOGFILE = "manager.{space}.log";

/** `.cotal/manager.<spaceKey>.delivery-aware` — the sibling marker proving the live manager is a
 *  build that does NOT host Plane-3. Written and removed with the pidfile; it carries the pid it was
 *  written for, so a stale marker cannot be paired with a different manager. Per-space because the
 *  pid it names is, and a marker that could be paired with ANOTHER space's manager would answer the
 *  delivery cutover preflight about the wrong process. */
export const MANAGER_DELIVERY_AWARE_MARKER = "manager.{space}.delivery-aware";

/** `.cotal/delivery.<spaceKey>.pid` — the Plane-3 delivery daemon's record. Per-space: the daemon is
 *  minted a space-scoped cred and binds that space's durables, so two spaces need two daemons. */
export const DELIVERY_PIDFILE = "delivery.{space}.pid";

/** `.cotal/delivery.<spaceKey>.log` — the delivery daemon's output. See {@link MANAGER_LOGFILE}. */
export const DELIVERY_LOGFILE = "delivery.{space}.log";

/**
 * The ROOT-SCOPED name each per-space RECORD was written under before segmentation — the one place
 * that history is spelled.
 *
 * WHY A READ SHIM AND NOT A MIGRATION. `space-segmentation.ts` moves legacy material on first touch
 * because those kinds have absent-means-mint writers, so a canonical read on an unmigrated root
 * would mint a SECOND live credential. A pidfile has no such writer: it fronts a process that is
 * either running or not. What an upgrade must not do is stop FINDING that process — a `cotal down`
 * that skips a pre-upgrade record exits 0 leaving a live manager and a live delivery daemon behind,
 * which is the customer-update-path invariant AGENTS.md calls load-bearing. So the pre-upgrade name
 * is ADMITTED for reading; nothing is moved, and the start paths always WRITE the canonical name
 * (a degraded write mode would keep minting the very records this ends).
 *
 * RECORDS ONLY — no logs. A log holds text, not a pid, so a pre-upgrade `manager.log` sitting beside
 * the new `manager.<hex>.log` is an ordinary state rather than a contradiction, and the ambiguity
 * rule below must never fire on it. Nothing sweeps the old log, which is what `clean` already did
 * with logs before this change.
 */
export const PRE_SEGMENTATION_RUNTIME_RECORDS: ReadonlyMap<string, string> = new Map([
  [MANAGER_PIDFILE, "manager.pid"],
  [MANAGER_DELIVERY_AWARE_MARKER, "manager.delivery-aware"],
  [DELIVERY_PIDFILE, "delivery.pid"],
]);

/** The location a start WRITES: the canonical, space-keyed path, whatever else is on disk. Rejects
 *  absolute/traversal templates. Every writer takes this; readers take {@link localProcessPath}. */
export function canonicalLocalProcessPath(template: string, context: LocalProcessContext): string {
  if (!template.trim()) throw new Error("local-process path must not be empty");
  const expanded = template.replaceAll("{space}", spaceKey(context.space));
  const normalized = normalize(expanded);
  if (normalized === "." || isAbsolute(expanded) || normalized === ".." || normalized.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`))
    throw new Error(`local-process path must stay under .cotal: ${JSON.stringify(template)}`);
  return join(context.root, ".cotal", normalized);
}

/**
 * Every name this record has been written under, CANONICAL FIRST, whether or not each exists.
 *
 * Two pre-upgrade spellings are possible and both are historical fact rather than guesswork:
 *  - the PRE-HEX one, for a `{space}` template written before the hex re-key
 *    (`auth-service.<encodeURIComponent(space)>.pid`);
 *  - the PRE-SEGMENTATION root-scoped one, for the runtime records above.
 *
 * Exported for the SWEEPERS (`clean`, the `down` inventory), which must name every spelling they are
 * about to remove and must NOT go through {@link localProcessPath} — a deleter that resolved through
 * the ambiguity rule would refuse on exactly the half-upgraded root it exists to tidy.
 */
export function localProcessPathCandidates(template: string, context: LocalProcessContext): string[] {
  const paths = [canonicalLocalProcessPath(template, context)];
  const add = (name: string): void => {
    const p = join(context.root, ".cotal", normalize(name));
    if (!paths.includes(p)) paths.push(p);
  };
  if (template.includes("{space}")) add(template.replaceAll("{space}", encodeURIComponent(context.space)));
  const preSegmentation = PRE_SEGMENTATION_RUNTIME_RECORDS.get(template);
  if (preSegmentation !== undefined) add(preSegmentation);
  return paths;
}

/**
 * The record to READ: the canonical space-keyed path, or a pre-upgrade one when that is the only
 * spelling present.
 *
 * `down`/`status`/`up` read this to FIND and stop a live process, so a pre-upgrade record must stay
 * findable across the upgrade or the daemon behind it is silently orphaned. BYTE-EXACT (a bare
 * `existsSync` case-folds on macOS/Windows and would match another space's file); both spellings
 * present is ambiguous and fails LOUD rather than picking one, mirroring the state-dir and registry
 * legacy shims. The start paths reclaim a provably dead pre-upgrade record before writing the
 * canonical one, so an ordinary upgrade never reaches that refusal.
 */
export function localProcessPath(template: string, context: LocalProcessContext): string {
  const [canonical, ...legacy] = localProcessPathCandidates(template, context);
  const present = legacy.filter(existsByteExact);
  if (present.length === 0) return canonical;
  if (existsByteExact(canonical))
    throw new Error(
      `both ${canonical} and the pre-upgrade ${present.join(" and ")} exist for space "${context.space}" - ambiguous process record; remove the stale one`,
    );
  if (present.length > 1)
    throw new Error(
      `several pre-upgrade records (${present.join(", ")}) exist for space "${context.space}" - ambiguous process record; remove the stale one`,
    );
  return present[0];
}

/**
 * Reclaim a provably DEAD pre-upgrade record before a start claims the canonical slot.
 *
 * Without this an ordinary upgrade wedges the root: a pre-segmentation crash leaves `manager.pid`,
 * the next start writes `manager.<hex>.pid`, BOTH then exist, and {@link localProcessPath} correctly
 * refuses every later status/down as ambiguous.
 *
 * It reclaims ONLY what a canonical claim would: an empty slot (a pre-protocol crash) or a pid
 * proven dead by ESRCH. It NEVER deletes an unattributable record, a still-LIVE holder, or one whose
 * liveness the kernel would not answer — those are precisely the live pre-upgrade daemon this path
 * exists not to orphan, so they THROW and the start aborts loud rather than deleting the record and
 * launching a competitor. Byte-exact, no case-fold. RECORDS only: a log holds text, not a pid.
 */
export function reclaimDeadPreUpgradeRecord(template: string, context: LocalProcessContext): void {
  const [, ...legacy] = localProcessPathCandidates(template, context);
  for (const path of legacy) {
    if (!existsByteExact(path)) continue;
    const raw = readFileSync(path, "utf8").trim();
    if (raw === "") {
      rmSync(path, { force: true }); // empty husk: nothing is behind it, as the canonical claim treats it
      continue;
    }
    const pid = parsePid(raw);
    if (pid === undefined)
      throw new Error(
        `the pre-upgrade record ${path} holds unattributable content ${JSON.stringify(raw)} - refusing to reclaim it or start a competing process; inspect or remove it manually`,
      );
    const state = probeLiveness(pid);
    if (state === "alive")
      throw new Error(
        `a pre-upgrade process is already running (pid ${pid}) at ${path} - refusing to start a second; run \`cotal down\` to stop it, then retry`,
      );
    if (state === "unknown")
      throw new Error(
        `cannot determine whether pid ${pid} in ${path} is alive - refusing to reclaim an unattributable record or start a competing process; inspect or remove it manually`,
      );
    rmSync(path, { force: true }); // ESRCH-proven dead
  }
}

/** A space this root holds a runtime record for, with the one fact a caller has to act on. */
export interface RecordedRuntimeSpace {
  readonly space: string;
  /** False only when EVERY record for this space is provably not a process (empty husk, or a pid
   *  ESRCH-proven dead). An unparsable record or a pid the kernel will not answer for counts as
   *  possibly running: the same fail-closed direction `down`'s dependant guard takes, because the
   *  cost of the other reading is walking past a live daemon. */
  readonly mayBeRunning: boolean;
}

/**
 * The spaces whose runtime daemons THIS ROOT has recorded, read off the record filenames.
 *
 * A root's space is otherwise derived from its `.cotal/auth` account records, and an OPEN mesh
 * (`broker: { auth: false }`) has none — so that derivation answers with the default space while the
 * mesh runs under its own name. A root-scoped `manager.pid` was space-blind and hid that; a
 * per-space record does not, and a `cotal down` that cannot name the space walks past a live manager
 * and exits 0. The records themselves are the one source that always knows: `spaceKey` is injective
 * UTF-8 hex, so the name a start wrote decodes back to the space it wrote it for.
 *
 * THE PID RECORDS ONLY. They are what "a daemon is running here" means; the log and the
 * delivery-aware marker are siblings of a record rather than evidence of their own. A
 * PRE-SEGMENTATION root-scoped record names no space and contributes none — the folder's own space
 * still resolves it, through the candidate list in {@link localProcessPath}.
 */
export function recordedRuntimeSpaces(root: string): RecordedRuntimeSpace[] {
  const dir = join(root, ".cotal");
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return []; // no `.cotal` → nothing is recorded here
  }
  const found = new Map<string, boolean>();
  for (const name of names)
    for (const template of [MANAGER_PIDFILE, DELIVERY_PIDFILE]) {
      const space = spaceFromRecordName(template, name);
      if (space === undefined) continue;
      found.set(space, (found.get(space) ?? false) || recordMayBeRunning(join(dir, name)));
    }
  return [...found].map(([space, mayBeRunning]) => ({ space, mayBeRunning })).sort((a, b) => a.space.localeCompare(b.space));
}

/** The space a canonical record filename encodes, or undefined when the name is not one
 *  {@link canonicalLocalProcessPath} wrote for this template (wrong fixed parts, non-hex body, or a
 *  body that does not round-trip back to the same name). Same predicate as the account-file and
 *  path-segment decoders: enumeration must never read a stray as a tenant. */
function spaceFromRecordName(template: string, name: string): string | undefined {
  const at = template.indexOf("{space}");
  if (at < 0) return undefined;
  const prefix = template.slice(0, at), suffix = template.slice(at + "{space}".length);
  if (!name.startsWith(prefix) || !name.endsWith(suffix) || name.length <= prefix.length + suffix.length) return undefined;
  const key = name.slice(prefix.length, name.length - suffix.length);
  if (key.length % 2 !== 0 || !/^[0-9a-f]+$/.test(key)) return undefined;
  const space = Buffer.from(key, "hex").toString("utf8");
  return space.length > 0 && spaceKey(space) === key ? space : undefined;
}

/** Whether a record file might still front a process. See {@link RecordedRuntimeSpace.mayBeRunning}
 *  for the direction and why it is that one. */
function recordMayBeRunning(path: string): boolean {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8").trim();
  } catch {
    return false; // removed under us → nothing to address
  }
  if (raw === "") return false; // pre-protocol husk: no process behind it
  const pid = parsePid(raw);
  if (pid === undefined) return true; // unattributable: cannot prove it gone
  return probeLiveness(pid) !== "dead"; // alive OR unknown; only ESRCH clears it
}

/** Byte-exact existence: an entry named exactly `basename(p)` in its parent dir. `existsSync` on a
 *  case-insensitive filesystem reports a case-folded sibling as present, which for a legacy pidfile
 *  lookup would match a DIFFERENT space's file; this matches only the exact name. */
function existsByteExact(p: string): boolean {
  try {
    return readdirSync(dirname(p)).includes(basename(p));
  } catch {
    return false; // parent absent → not present
  }
}

export function localProcessVisible(process: LocalProcess, context: LocalProcessContext): boolean {
  return process.visibleWhen !== "user-auth" || context.userAuth === true;
}
