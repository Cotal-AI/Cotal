import { existsSync, readFileSync, renameSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import {
  OFFICIAL_CONNECTORS,
  extensionPackageDir,
  installedExtensionVersion,
  loadExtensionsManifest,
  quarantineExtensionsManifest,
  type InstalledExtension,
} from "@cotal-ai/workspace";
import { c } from "../ui.js";
import { selfArgv } from "../lib/self-exec.js";
import { claimExtensionMutation } from "../lib/ext-mutation.js";
import { SEED_BUILTINS, seedGeneration, stampPath } from "./paths.js";
import {
  acquireReconcileLock,
  clearChildMarker,
  clearCursor,
  clearRecovery,
  readCursor,
  readRecovery,
  reconcileLockActive,
  recoveryPending,
  sanitizeCorruptCrashState,
  seedChildStatus,
  writeCursor,
  writePendingChildMarker,
  writeRecovery,
} from "./lock.js";
import {
  ensureWitness,
  everSeededUnion,
  quarantineCorruptSeedState,
  readAuthority,
  readStamp,
  readWitness,
  recoverAuthorityFromBackup,
  writeAuthority,
  writeStamp,
} from "./authority.js";
import { gcSeedStore, stageSeedPayload } from "./store.js";

/**
 * The connector seeding reconcile: makes the four first-party connectors present on a fresh install
 * (and re-present after a version bump) through the SAME `ext add` path a third party uses, while
 * honoring deliberate removals. It runs on the first real command of a boot (never `postinstall`),
 * and on `cotal ext seed`.
 *
 * Safety spine:
 *  - ONE reconcile lock (shared crash-safe advisory lock) + the extension mutation lock, held for the
 *    whole run, so neither a second reconcile nor an operator `ext add`/`remove` interleaves. A live
 *    reconcile is WAITED on (bounded), never mistaken for a crash.
 *  - a crash cursor journaled before every mutation and kept until the FINAL commit, so a SIGKILL
 *    mid-run is detected on the next boot (fail loud + `--repair`) and `--repair` actually re-installs
 *    the interrupted connector before it clears the evidence — never a success reported over torn files.
 *  - a seed-child liveness marker, so a reclaim/repair after a parent SIGKILL refuses to race an
 *    orphaned installer still mutating the prefix.
 *  - a health preamble BEFORE the stamp fast path, so a lost authority can't hide behind a current
 *    stamp; the ever-seeded authority (unioned with its monotonic backup on read) is the sole arbiter
 *    of removed-vs-never-seeded.
 *  - refresh gated on the manifest entry's `source`: only connectors WE seeded auto-refresh on an
 *    upgrade; an operator-managed official entry (a manual `ext add` at a chosen version) is left alone.
 */

type Mode = "auto" | "force" | "repair" | "reset";

export interface SeedFlags {
  readonly repair?: boolean;
  readonly reset?: boolean;
  readonly force?: boolean;
}

export interface ReconcileResult {
  readonly noop: boolean;
  readonly seeded: string[];
  readonly refreshed: string[];
  readonly removedKept: string[];
}

/** Auto reconcile for the boot gate: silent no-op when the stamp is current and healthy. */
export async function reconcileSeededConnectors(): Promise<void> {
  await reconcile("auto");
}

/** `cotal ext seed [--repair|--reset|--force]`: the maintenance entry. Prints a summary. */
export async function runSeed(flags: SeedFlags): Promise<void> {
  const mode: Mode = flags.reset ? "reset" : flags.repair ? "repair" : flags.force ? "force" : "auto";
  const result = await reconcile(mode);
  if (result.noop) {
    console.log(c.green("✓ built-in connectors up to date"));
    return;
  }
  const parts: string[] = [];
  if (result.seeded.length) parts.push(`seeded ${result.seeded.join(", ")}`);
  if (result.refreshed.length) parts.push(`refreshed ${result.refreshed.join(", ")}`);
  if (result.removedKept.length) parts.push(`kept removed ${result.removedKept.join(", ")}`);
  console.log(c.green(`✓ connectors reconciled`) + (parts.length ? c.dim(` - ${parts.join("; ")}`) : ""));
}

const NOOP: ReconcileResult = { noop: true, seeded: [], refreshed: [], removedKept: [] };

async function reconcile(mode: Mode): Promise<ReconcileResult> {
  const generation = seedGeneration();
  // Cheap lock-free pre-check: the steady state (stamp current, authority intact) is the common case
  // on EVERY command and must not pay a lock acquire. Health checks run FIRST so a lost authority or a
  // crashed reconcile is caught before the stamp is trusted.
  if (mode === "auto") {
    const cursor = readCursor();
    // A crash cursor OR an outstanding maintenance-recovery obligation means a seed/repair was
    // interrupted. A LIVE lock holder ⇒ it is in flight: fall through and WAIT on the lock, then
    // re-check the fast path (it will have stamped). No live holder ⇒ it crashed → fail loud.
    if (cursor || recoveryPending()) {
      if (!reconcileLockActive()) {
        const child = seedChildStatus();
        if (child.kind === "live")
          throw new Error(`a connector seed child (pid ${child.pid}) is still installing - retry once it finishes`);
        if (child.kind === "ambiguous")
          throw new Error(`a connector seed may be mid-flight (marker ${child.path}) - if no cotal process is running, remove it, then run \`cotal ext seed --repair\``);
        throw new Error("a previous connector seed or repair was interrupted - run `cotal ext seed --repair`");
      }
    } else if (readWitness() && authorityIntact() && readStamp()?.generation === generation && !reconcileLockActive()) {
      // Steady state AND no reconcile in flight. The lock check is LAST (immediately before NOOP) so
      // it is the linearization point: a `--force` that link-publishes the lock during the slower
      // health/stamp reads is still caught here, and we fall through to acquire/wait rather than
      // racing past into the command while it mutates the prefix.
      return NOOP;
    }
  }
  const lock = acquireReconcileLock();
  try {
    // Claim the mutation lock INSIDE the reconcile lock's finally: if it throws (an operator `cotal
    // ext` op holds it past the wait), the reconcile lock is still released, not leaked. The reconcile
    // takes a modest bounded wait (a brief operator op shouldn't fail the boot-gate); operators
    // themselves fail fast.
    const releaseMutation = claimExtensionMutation({ waitMs: 30000 });
    try {
      return await runUnderLocks(mode, generation, lock.nonce);
    } finally {
      releaseMutation();
    }
  } finally {
    lock.release();
  }
}

/** Authority present, readable, and structurally valid (a corrupt one is NOT intact — it routes to
 *  the fail-loud path). */
function authorityIntact(): boolean {
  try {
    return readAuthority() !== undefined;
  } catch {
    return false;
  }
}

async function runUnderLocks(mode: Mode, generation: string, nonce: string): Promise<ReconcileResult> {
  // Refuse to touch the prefix while an orphaned seed child (a crashed parent's still-running
  // installer) is mutating it — reclaiming the lock does not stop that process. An ambiguous marker
  // (pending with a dead parent, or corrupt) is fail-loud: we cannot prove no installer is running.
  const child = seedChildStatus();
  if (child.kind === "live")
    throw new Error(`a connector seed child (pid ${child.pid}) is still installing - retry once it finishes`);
  if (child.kind === "ambiguous")
    throw new Error(`a connector seed may be mid-flight (marker ${child.path}) - if no cotal process is running, remove it and retry`);

  // Maintenance modes must survive a corrupt manifest / corrupt seed state: quarantine the unreadable
  // file(s) aside so the reads below (and the commit) can't wedge on them. `manifestRebuilt` ⇒ reconcile
  // against ON-DISK truth (a quarantined manifest has no reliable "removed" record); `repairAllSeeded`
  // ⇒ an unidentifiable interrupted install → reinstall every seeded built-in. Both obligations are
  // journaled durably by prepareMaintenanceState (recovery marker) so a repair SIGKILL after the
  // quarantine still honors them on the next run.
  let manifestRebuilt = false;
  let repairAllSeeded = false;
  if (mode === "repair" || mode === "reset") {
    ({ manifestRebuilt, repairAllSeeded } = prepareMaintenanceState(mode));
  }

  // Health preamble — BEFORE the stamp fast path. A cursor OR a recovery obligation means a prior
  // seed/repair was interrupted. In maintenance mode they are kept and cleared only at the final commit.
  const cursor = readCursor();
  if (cursor) {
    if (mode === "auto")
      throw new Error(
        `a previous connector seed was interrupted (package "${cursor.package}", phase ${cursor.phase}) - run \`cotal ext seed --repair\``,
      );
    console.error(c.dim(`recovering from an interrupted seed (package "${cursor.package}") …`));
  }
  if (mode === "auto" && !cursor && recoveryPending())
    throw new Error("a previous connector repair was interrupted - run `cotal ext seed --repair`");

  const everSeeded = resolveEverSeeded(mode, generation);

  // Stamp fast path under the lock: a competing boot may have reconciled while we waited. Only when no
  // cursor or recovery obligation is outstanding (an interrupted run must proceed, not short-circuit).
  if (mode === "auto" && !cursor && !recoveryPending() && readWitness() && readStamp()?.generation === generation) return NOOP;

  const stampGen = readStamp()?.generation;
  const repairTarget = mode === "repair" ? cursor?.package : undefined;
  const seeded: string[] = [];
  const refreshed: string[] = [];
  const removedKept: string[] = [];

  for (const name of SEED_BUILTINS) {
    const entry = installedEntry(name);
    const wasSeeded = everSeeded.has(name) && mode !== "reset";
    if (name === repairTarget) {
      // The interrupted package (the cursor only ever names an ADD in progress — removals never write
      // it): re-install it regardless of current manifest state, whether the crash tore the files or
      // died before the manifest commit. Verified below before the cursor is cleared.
      seedOne(name, generation, nonce, true);
      verifyInstalled(name);
      everSeeded.add(name);
      refreshed.push(name);
    } else if (!wasSeeded) {
      seedOne(name, generation, nonce, mode === "reset" || mode === "force");
      everSeeded.add(name);
      seeded.push(name);
    } else if (entry) {
      // Refresh policy: any --force; for connectors WE seeded (source === "seeded") a strictly-newer
      // generation; on an unknown-cursor --repair (repairAllSeeded) every seeded built-in; and on an
      // ordinary --repair a seeded entry that is not fully intact on disk (a partial tear — main may
      // survive while a required file is gone). An operator-managed official entry (no seeded marker)
      // is never auto-refreshed on upgrade — only --force may replace it.
      const isSeeded = entry.source === "seeded";
      const torn = mode === "repair" && isSeeded && (repairAllSeeded || !isIntact(name));
      const refresh = mode === "force" || torn || (isSeeded && isStrictlyNewer(generation, stampGen));
      if (refresh) {
        seedOne(name, generation, nonce, true);
        verifyInstalled(name);
        refreshed.push(name);
      }
    } else if (manifestRebuilt && installedExtensionVersion(OFFICIAL_CONNECTORS[name])) {
      // The manifest was corrupt and quarantined, but this connector is STILL on disk: its entry was
      // lost with the manifest, not removed. Re-seed it to rebuild the record (a quarantined manifest
      // carries no reliable "removed" fact — only on-disk presence can distinguish the two).
      seedOne(name, generation, nonce, true);
      verifyInstalled(name);
      refreshed.push(name);
    } else {
      removedKept.push(name); // seeded before, deliberately removed (or absent on disk) → leave removed
    }
  }

  // Commit: authority (+ backup) → witness → stamp (LAST); THEN drop the cursor + recovery obligation
  // and GC old stores. The cursor and recovery marker are cleared only here, so an interruption
  // anywhere above (including a repair that quarantined then died mid-reinstall) is still a detectable,
  // recoverable partial run on the next boot.
  writeAuthority(everSeeded);
  ensureWitness(generation);
  writeStamp(generation);
  clearCursor();
  clearRecovery();
  gcSeedStore(
    generation,
    loadExtensionsManifest().extensions.map((e) => e.spec),
  );
  return { noop: false, seeded, refreshed, removedKept };
}

/** Quarantine any corrupt manifest / seed-state so a maintenance run rebuilds clean instead of wedging
 *  on the same unreadable read, and DURABLY journal the resulting obligation BEFORE the destructive
 *  quarantine — so a repair SIGKILL'd after the quarantine but before the reinstalls doesn't forget it.
 *  `manifestRebuilt` ⇒ reconcile the built-ins against ON-DISK truth; `repairAllSeeded` ⇒ reinstall +
 *  verify every seeded built-in (an unidentifiable interrupted install). Both are UNIONED with any
 *  obligation a prior crashed maintenance already recorded. Third-party entries in an unrecoverable
 *  manifest are lost — reported, not silently dropped. */
function prepareMaintenanceState(mode: Mode): { manifestRebuilt: boolean; repairAllSeeded: boolean } {
  // Re-derive from BOTH a prior crashed maintenance's durable obligation and the current on-disk state.
  const prior = (() => {
    try {
      return readRecovery();
    } catch {
      return { rebuildFromDisk: true, repairAllSeeded: true }; // corrupt marker ⇒ recover conservatively
    }
  })();
  let manifestRebuilt = prior?.rebuildFromDisk ?? false;
  let repairAllSeeded = prior?.repairAllSeeded ?? false;

  const manifestCorrupt = (() => {
    try {
      loadExtensionsManifest();
      return false;
    } catch {
      return true;
    }
  })();
  const cursorCorrupt = (() => {
    try {
      readCursor();
      return false;
    } catch {
      return true;
    }
  })();
  manifestRebuilt = manifestRebuilt || manifestCorrupt;
  repairAllSeeded = repairAllSeeded || cursorCorrupt;

  // Persist the obligation BEFORE any destructive quarantine below, so a crash in between still leaves
  // a durable record the next run honors.
  if (manifestRebuilt || repairAllSeeded) writeRecovery({ rebuildFromDisk: manifestRebuilt, repairAllSeeded });

  if (manifestCorrupt) {
    const aside = quarantineExtensionsManifest();
    if (aside)
      console.error(
        c.red(`quarantined a corrupt extensions manifest → ${aside}`) +
          c.dim(" (any third-party extensions it recorded must be `cotal ext add`ed again)"),
      );
  }
  for (const aside of sanitizeCorruptCrashState()) console.error(c.dim(`quarantined a corrupt seed cursor → ${aside}`));
  // A stamp that is corrupt JSON, OR parses but is not valid semver (e.g. `0.bad.0`), makes the refresh
  // comparison throw — an auto boot then prescribes `--repair` and `--repair`/`--reset` re-throw the
  // SAME error forever (readStamp itself throws on corrupt JSON). Detect BOTH here, BEFORE any semver
  // use, and move the stamp aside so repair treats the prior generation as unknown (older), refreshes
  // and verifies, and writes a fresh valid stamp.
  let stampBad = false;
  try {
    const stamp = readStamp();
    stampBad = stamp !== undefined && !isValidSemver(stamp.generation);
  } catch {
    stampBad = true; // corrupt JSON
  }
  if (stampBad && existsSync(stampPath())) {
    const aside = `${stampPath()}.corrupt.${randomBytes(4).toString("hex")}`;
    renameSync(stampPath(), aside);
    console.error(c.dim(`quarantined an invalid version stamp → ${aside}`));
  }
  if (mode === "reset") {
    for (const aside of quarantineCorruptSeedState()) console.error(c.dim(`quarantined corrupt seed state → ${aside}`));
  }
  return { manifestRebuilt, repairAllSeeded };
}

/** True iff `v` parses as a numeric-core semver (the only thing the refresh comparison can order). */
function isValidSemver(v: string): boolean {
  try {
    parseSemver(v);
    return true;
  } catch {
    return false;
  }
}

/**
 * The ever-seeded set to reconcile against, per the prefix state and the mode. Pristine/legacy
 * prefixes initialize it; a witnessed prefix with a lost authority is fail-loud in auto/force,
 * recoverable via `--repair`, and reset-to-defaults via `--reset`.
 */
function resolveEverSeeded(mode: Mode, generation: string): Set<string> {
  if (mode === "reset") return new Set(); // recreate defaults: every built-in becomes never-seeded

  const witness = readWitness();
  if (!witness) {
    // No witness: a pristine prefix (nothing installed) or a legacy one (extensions predating the
    // seeder). Mark any OFFICIAL connector already in the manifest as seeded so a manually-added one
    // is not re-seeded; a static-import-era prefix has none, so all four seed fresh.
    return new Set(
      loadExtensionsManifest()
        .extensions.map((e) => officialNameOfPkg(e.pkg))
        .filter((n): n is string => !!n),
    );
  }

  // Union the live authority with its monotonic backup: a live set that lost ids (a truncated write
  // that still parsed) can only shrink, and the backup is a superset, so a removed connector is never
  // resurrected by such a loss.
  let merged: Set<string> | undefined;
  try {
    merged = everSeededUnion();
  } catch {
    merged = undefined; // corrupt → treated as lost below
  }
  if (merged) return merged;

  // Witness present but authority (and backup) lost.
  if (mode === "repair") {
    const recovered = recoverAuthorityFromBackup();
    if (!recovered)
      throw new Error(
        "connector seed authority is lost and no backup remains - removed-vs-never-seeded is unrecoverable; `cotal ext seed --reset` recreates defaults (this resurrects any deliberately-removed connector)",
      );
    console.error(c.dim("recovered the seed authority from its backup"));
    return recovered;
  }
  throw new Error(
    "connector seed authority is missing or corrupt - `cotal ext seed --repair` recovers it from the durable backup, or `--reset` recreates defaults (resurrecting removed connectors)",
  );
}

/** Stage the payload and `ext add` it as a seed child, journaling the crash cursor around each step.
 *  The child is authenticated: it carries the live reconcile lock's nonce + this parent's PID so a
 *  forged `COTAL_EXT_SEEDING` can't skip the mutation lock for an arbitrary `ext add`. */
function seedOne(name: string, generation: string, nonce: string, force: boolean): void {
  writeCursor({ nonce, package: name, phase: "copy" });
  const storePath = stageSeedPayload(generation, name, { force });
  writeCursor({ nonce, package: name, phase: "add" });
  // Record intent to spawn BEFORE the spawn, so the orphan window never opens ownerless: a repair
  // after a parent SIGKILL sees this pending marker and fails loud rather than racing the installer.
  writePendingChildMarker(nonce);
  const [bin, ...argv] = selfArgv();
  const r = spawnSync(bin, [...argv, "ext", "add", storePath], {
    encoding: "utf8",
    env: { ...process.env, COTAL_EXT_SEEDING: nonce, COTAL_EXT_SEEDING_PARENT: String(process.pid) },
  });
  clearChildMarker(); // parent survived the child: the marker's job is done (child also clears its own)
  if (r.stdout) process.stdout.write(r.stdout);
  if (r.status !== 0) {
    const tail = `${r.stderr ?? ""}`.trim().split("\n").slice(-8).join("\n");
    throw new Error(`failed to seed connector "${name}" from ${storePath}:\n${tail}`);
  }
}

/** Confirm a connector the reconcile claims to have (re)installed is recorded AND on disk with its
 *  entry file resolvable — so `--repair` can never clear the cursor and stamp success over a
 *  half-installed prefix (a surviving package.json with a missing main is still broken). */
function verifyInstalled(name: string): void {
  const pkg = OFFICIAL_CONNECTORS[name];
  const entry = installedEntry(name);
  if (!entry) throw new Error(`connector "${name}" (${pkg}) was expected in the manifest after seeding but is absent - rerun \`cotal ext seed --repair\``);
  if (!installedExtensionVersion(pkg))
    throw new Error(`connector "${name}" (${pkg}) is recorded but not installed on disk - rerun \`cotal ext seed --repair\``);
  if (!mainEntryPresent(pkg))
    throw new Error(`connector "${name}" (${pkg}) is installed but its entry file is missing (a torn install) - rerun \`cotal ext seed --repair\``);
}

/** The package's declared main entry file exists on disk (`main`, else the CommonJS default). Used to
 *  detect a torn install where package.json survived a partial npm copy but the built dist did not. */
function mainEntryPresent(pkg: string): boolean {
  const dir = extensionPackageDir(pkg);
  let main = "index.js";
  try {
    const declared = (JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as { main?: string }).main;
    if (typeof declared === "string" && declared) main = declared;
  } catch {
    return false; // package.json unreadable ⇒ not intact
  }
  return existsSync(join(dir, main));
}

/** A seeded built-in is fully intact: recorded on disk (package.json + version) AND its main entry
 *  file present. A partial tear (main gone, package.json kept) is NOT intact. */
function isIntact(name: string): boolean {
  const pkg = OFFICIAL_CONNECTORS[name];
  return installedExtensionVersion(pkg) !== undefined && mainEntryPresent(pkg);
}

function installedEntry(name: string): InstalledExtension | undefined {
  const pkg = OFFICIAL_CONNECTORS[name];
  return loadExtensionsManifest().extensions.find((e) => e.pkg === pkg);
}

function officialNameOfPkg(pkg: string): string | undefined {
  return SEED_BUILTINS.find((name) => OFFICIAL_CONNECTORS[name] === pkg);
}

/** A DOWNGRADE never rewrites installed connector code without `--force`; an absent prior stamp counts
 *  as older, so an upgrade from an un-stamped prefix refreshes. Semver 2.0 precedence (prerelease
 *  ordering included), so `1.0.0-rc.1` < `1.0.0` and `1.0.10` > `1.0.9`. */
function isStrictlyNewer(a: string, b: string | undefined): boolean {
  return compareSemver(a, b ?? "0.0.0") > 0;
}

interface Semver {
  readonly rel: [number, number, number];
  readonly pre: string[];
}

function parseSemver(v: string): Semver {
  const core = v.split("+")[0];
  const dash = core.indexOf("-");
  const pre = dash >= 0 ? core.slice(dash + 1).split(".") : [];
  // Fail loud on a non-numeric release segment rather than coercing it to 0 (which would silently
  // mis-order versions). The generation is a real package.json version and the stamp is one we wrote,
  // so a non-semver core here means corrupt state → `cotal ext seed --repair`/`--reset`.
  const release = (dash >= 0 ? core.slice(0, dash) : core).split(".").map((s) => {
    if (!/^\d+$/.test(s)) throw new Error(`invalid version "${v}" (release segment "${s}" is not numeric) - repair with \`cotal ext seed --repair\` (or --reset)`);
    return Number(s);
  });
  return { rel: [release[0] ?? 0, release[1] ?? 0, release[2] ?? 0], pre };
}

export function compareSemver(a: string, b: string): number {
  const pa = parseSemver(a);
  const pb = parseSemver(b);
  for (let i = 0; i < 3; i++) {
    if (pa.rel[i] !== pb.rel[i]) return pa.rel[i] > pb.rel[i] ? 1 : -1;
  }
  // A release (no prerelease) outranks a prerelease of the same core version.
  if (!pa.pre.length && pb.pre.length) return 1;
  if (pa.pre.length && !pb.pre.length) return -1;
  const n = Math.max(pa.pre.length, pb.pre.length);
  for (let i = 0; i < n; i++) {
    const x = pa.pre[i];
    const y = pb.pre[i];
    if (x === undefined) return -1; // fewer prerelease fields ⇒ lower precedence
    if (y === undefined) return 1;
    const xn = /^\d+$/.test(x);
    const yn = /^\d+$/.test(y);
    if (xn && yn) {
      const d = Number(x) - Number(y);
      if (d !== 0) return d > 0 ? 1 : -1;
    } else if (xn) return -1; // numeric identifiers rank below alphanumeric
    else if (yn) return 1;
    else if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}
