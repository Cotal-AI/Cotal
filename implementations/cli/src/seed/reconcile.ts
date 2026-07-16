import { spawnSync } from "node:child_process";
import {
  OFFICIAL_CONNECTORS,
  installedExtensionVersion,
  loadExtensionsManifest,
  quarantineExtensionsManifest,
  type InstalledExtension,
} from "@cotal-ai/workspace";
import { c } from "../ui.js";
import { selfArgv } from "../lib/self-exec.js";
import { claimExtensionMutation } from "../lib/ext-mutation.js";
import { SEED_BUILTINS, seedGeneration } from "./paths.js";
import {
  acquireReconcileLock,
  clearChildMarker,
  clearCursor,
  liveSeedChildPid,
  readCursor,
  reconcileLockActive,
  writeCursor,
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
    if (cursor) {
      // A cursor + a LIVE lock holder ⇒ a reconcile is in flight: fall through and WAIT on the lock,
      // then re-check the fast path (it will have stamped). A cursor + no live holder ⇒ it crashed.
      if (!reconcileLockActive()) {
        const child = liveSeedChildPid();
        if (child !== undefined)
          throw new Error(`a connector seed child (pid ${child}) is still installing - retry once it finishes`);
        throw new Error("a previous connector seed was interrupted - run `cotal ext seed --repair`");
      }
    } else if (readWitness() && authorityIntact() && readStamp()?.generation === generation) {
      return NOOP;
    }
  }
  const lock = acquireReconcileLock();
  const releaseMutation = claimExtensionMutation();
  try {
    return await runUnderLocks(mode, generation, lock.nonce);
  } finally {
    releaseMutation();
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
  // installer) is mutating it — reclaiming the lock does not stop that process.
  const orphan = liveSeedChildPid();
  if (orphan !== undefined)
    throw new Error(`a connector seed child (pid ${orphan}) is still installing - retry once it finishes`);

  // Maintenance modes must survive a corrupt manifest / corrupt seed state: quarantine the unreadable
  // file(s) aside so the reads below (and the commit) can't wedge on them.
  if (mode === "repair" || mode === "reset") {
    prepareMaintenanceState(mode);
  }

  // Health preamble — BEFORE the stamp fast path. A cursor means a prior reconcile was interrupted.
  // In repair mode it is kept (it names the package to re-install) and cleared only at the final commit.
  const cursor = readCursor();
  if (cursor) {
    if (mode === "auto")
      throw new Error(
        `a previous connector seed was interrupted (package "${cursor.package}", phase ${cursor.phase}) - run \`cotal ext seed --repair\``,
      );
    console.error(c.dim(`recovering from an interrupted seed (package "${cursor.package}") …`));
  }

  const everSeeded = resolveEverSeeded(mode, generation);

  // Stamp fast path under the lock: a competing boot may have reconciled while we waited. Only when no
  // cursor is outstanding (an interrupted run must proceed to re-install, not short-circuit).
  if (mode === "auto" && !cursor && readWitness() && readStamp()?.generation === generation) return NOOP;

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
      // Refresh policy: any --force; and, for connectors WE seeded (source === "seeded"), a
      // strictly-newer generation. An operator-managed official entry (a manual `ext add` at a chosen
      // version, no seeded marker) is NEVER auto-refreshed on upgrade — only --force may replace it.
      const isSeeded = entry.source === "seeded";
      const refresh = mode === "force" || (isSeeded && isStrictlyNewer(generation, stampGen));
      if (refresh) {
        seedOne(name, generation, nonce, true);
        verifyInstalled(name);
        refreshed.push(name);
      }
    } else {
      removedKept.push(name); // seeded before, deliberately removed → leave removed
    }
  }

  // Commit: authority (+ backup) → witness → stamp (LAST); THEN drop the cursor and GC old stores. The
  // cursor is cleared only here, so an interruption anywhere above is still a detectable partial run.
  writeAuthority(everSeeded);
  ensureWitness(generation);
  writeStamp(generation);
  clearCursor();
  gcSeedStore(
    generation,
    loadExtensionsManifest().extensions.map((e) => e.spec),
  );
  return { noop: false, seeded, refreshed, removedKept };
}

/** Quarantine any corrupt manifest / seed-state so a maintenance run rebuilds clean instead of
 *  wedging on the same unreadable read. Third-party manifest entries in an unrecoverable manifest are
 *  lost by the quarantine — reported, not silently dropped. */
function prepareMaintenanceState(mode: Mode): void {
  try {
    loadExtensionsManifest();
  } catch {
    const aside = quarantineExtensionsManifest();
    if (aside)
      console.error(
        c.red(`quarantined a corrupt extensions manifest → ${aside}`) +
          c.dim(" (any third-party extensions it recorded must be `cotal ext add`ed again)"),
      );
  }
  if (mode === "reset") {
    for (const aside of quarantineCorruptSeedState()) console.error(c.dim(`quarantined corrupt seed state → ${aside}`));
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
  const [bin, ...argv] = selfArgv();
  const r = spawnSync(bin, [...argv, "ext", "add", storePath], {
    encoding: "utf8",
    env: { ...process.env, COTAL_EXT_SEEDING: nonce, COTAL_EXT_SEEDING_PARENT: String(process.pid) },
  });
  clearChildMarker(); // the child clears its own marker on exit; drop any stale one defensively
  if (r.stdout) process.stdout.write(r.stdout);
  if (r.status !== 0) {
    const tail = `${r.stderr ?? ""}`.trim().split("\n").slice(-8).join("\n");
    throw new Error(`failed to seed connector "${name}" from ${storePath}:\n${tail}`);
  }
}

/** Confirm a connector the reconcile claims to have (re)installed is actually recorded AND on disk —
 *  so `--repair` can never clear the cursor and stamp success over a half-installed prefix. */
function verifyInstalled(name: string): void {
  const pkg = OFFICIAL_CONNECTORS[name];
  const entry = installedEntry(name);
  if (!entry) throw new Error(`connector "${name}" (${pkg}) was expected in the manifest after seeding but is absent - rerun \`cotal ext seed --repair\``);
  if (!installedExtensionVersion(pkg))
    throw new Error(`connector "${name}" (${pkg}) is recorded but not installed on disk - rerun \`cotal ext seed --repair\``);
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
  const release = (dash >= 0 ? core.slice(0, dash) : core).split(".").map((s) => Number(s) || 0);
  const pre = dash >= 0 ? core.slice(dash + 1).split(".") : [];
  return { rel: [release[0] ?? 0, release[1] ?? 0, release[2] ?? 0], pre };
}

function compareSemver(a: string, b: string): number {
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
