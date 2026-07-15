import { spawnSync } from "node:child_process";
import { OFFICIAL_CONNECTORS, loadExtensionsManifest } from "@cotal-ai/workspace";
import { c } from "../ui.js";
import { selfArgv } from "../lib/self-exec.js";
import { claimExtensionMutation } from "../lib/ext-mutation.js";
import { SEED_BUILTINS, seedGeneration } from "./paths.js";
import { acquireReconcileLock, clearCursor, readCursor, writeCursor } from "./lock.js";
import {
  ensureWitness,
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
 *  - ONE reconcile lock (nonce, dead-owner reclaim) + the extension mutation lock, held for the whole
 *    run, so neither a second reconcile nor an operator `ext add`/`remove` interleaves.
 *  - a crash cursor journaled before every mutation and cleared at commit, so a SIGKILL mid-run is
 *    detected on the next boot (fail loud + `--repair`), never silently half-applied.
 *  - a health preamble that runs BEFORE the stamp fast path, so a lost authority can't hide behind a
 *    current stamp.
 *  - the ever-seeded authority as the sole arbiter of removed-vs-never-seeded (mirrored to a durable
 *    backup; losing both is fail-loud, not a silent reseed).
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
  // on EVERY command and must not pay a lock acquire. The health checks still run FIRST, so a lost
  // authority or an interrupted reconcile is caught before the stamp is trusted. A reconcile that IS
  // needed falls through and re-checks under the lock (a competing boot may have just done it).
  if (mode === "auto") {
    if (readCursor())
      throw new Error("a previous connector seed was interrupted - run `cotal ext seed --repair`");
    if (readWitness() && authorityIntact() && readStamp()?.generation === generation) return NOOP;
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

/** Authority present and readable (a corrupt one is NOT intact — it routes to the fail-loud path). */
function authorityIntact(): boolean {
  try {
    return readAuthority() !== undefined;
  } catch {
    return false;
  }
}

async function runUnderLocks(mode: Mode, generation: string, nonce: string): Promise<ReconcileResult> {
  // Health preamble — BEFORE the stamp fast path. A cursor means a prior reconcile was interrupted.
  const cursor = readCursor();
  if (cursor) {
    if (mode === "auto")
      throw new Error(
        `a previous connector seed was interrupted (package "${cursor.package}", phase ${cursor.phase}) - run \`cotal ext seed --repair\``,
      );
    console.error(c.dim(`recovering from an interrupted seed (package "${cursor.package}") …`));
    clearCursor();
  }

  const everSeeded = resolveEverSeeded(mode, generation);

  // Stamp fast path under the lock: a competing boot may have reconciled while we waited. `resolveEverSeeded`
  // has already failed loud on a lost authority, so reaching here in auto mode means it is intact.
  if (mode === "auto" && readWitness() && readStamp()?.generation === generation) return NOOP;

  const stampGen = readStamp()?.generation;
  const seeded: string[] = [];
  const refreshed: string[] = [];
  const removedKept: string[] = [];

  for (const name of SEED_BUILTINS) {
    const installed = isInstalled(name);
    const wasSeeded = everSeeded.has(name) && mode !== "reset";
    if (!wasSeeded) {
      seedOne(name, generation, nonce, mode === "reset" || mode === "force");
      everSeeded.add(name);
      seeded.push(name);
    } else if (installed) {
      if (mode === "force" || isStrictlyNewer(generation, stampGen)) {
        seedOne(name, generation, nonce, true);
        refreshed.push(name);
      }
    } else {
      removedKept.push(name); // seeded before, deliberately removed → leave removed
    }
  }

  // Commit: authority (+ backup) → witness → stamp (LAST); then drop the cursor and GC old stores.
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

  let authority;
  try {
    authority = readAuthority();
  } catch {
    authority = undefined; // corrupt → treated as lost below
  }
  if (authority) return new Set(authority.everSeeded);

  // Witness present but authority lost.
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

/** Stage the payload and `ext add` it as a seed child, journaling the crash cursor around each step. */
function seedOne(name: string, generation: string, nonce: string, force: boolean): void {
  writeCursor({ nonce, package: name, phase: "copy" });
  const storePath = stageSeedPayload(generation, name, { force });
  writeCursor({ nonce, package: name, phase: "add" });
  const [bin, ...argv] = selfArgv();
  const r = spawnSync(bin, [...argv, "ext", "add", storePath], {
    encoding: "utf8",
    env: { ...process.env, COTAL_EXT_SEEDING: "1" },
  });
  if (r.stdout) process.stdout.write(r.stdout);
  if (r.status !== 0) {
    const tail = `${r.stderr ?? ""}`.trim().split("\n").slice(-8).join("\n");
    throw new Error(`failed to seed connector "${name}" from ${storePath}:\n${tail}`);
  }
}

function isInstalled(name: string): boolean {
  const pkg = OFFICIAL_CONNECTORS[name];
  return loadExtensionsManifest().extensions.some((e) => e.pkg === pkg);
}

function officialNameOfPkg(pkg: string): string | undefined {
  return SEED_BUILTINS.find((name) => OFFICIAL_CONNECTORS[name] === pkg);
}

/** Numeric-segment version compare of the seed generation (a `cotal-ai` version), pre-release tags
 *  ignored. A DOWNGRADE never rewrites installed connector code without `--force`; an absent prior
 *  stamp counts as older, so an upgrade from an un-stamped prefix refreshes. */
function isStrictlyNewer(a: string, b: string | undefined): boolean {
  const pa = versionTuple(a);
  const pb = versionTuple(b ?? "0.0.0");
  const n = Math.max(pa.length, pb.length);
  for (let i = 0; i < n; i++) {
    const x = pa[i] ?? 0;
    const y = pb[i] ?? 0;
    if (x > y) return true;
    if (x < y) return false;
  }
  return false;
}

function versionTuple(v: string): number[] {
  return v.split("+")[0].split("-")[0].split(".").map((s) => Number(s) || 0);
}
