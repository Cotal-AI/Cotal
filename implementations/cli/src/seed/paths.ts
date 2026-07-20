import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { basename, dirname, join } from "node:path";
import { globalConfigDir } from "@cotal-ai/core";
import { OFFICIAL_CONNECTORS } from "@cotal-ai/workspace";

/**
 * Filesystem layout + version identity for the connector seeding engine. Everything the reconcile
 * writes lives under `<config>/cotal/seed/`, a sibling of the `extensions/` npm prefix — the prefix
 * is npm-owned (a stray dir there would confuse `npm install`), the seed state is ours.
 *
 * The seed store is DURABLE by design: `npm install --install-links <dir>` normalizes a `file:` dep
 * pointing at `<dir>`, so a volatile source (an `npx` `_npx` cache) would later fail to reify. We
 * copy each shipped connector payload into `store/<generation>/<name>` and `ext add` from THAT stable
 * path, keyed by the binary's version so a `cotal-ai` upgrade lands a fresh generation.
 */

/** The four first-party connectors, in a stable seed order. Keys of {@link OFFICIAL_CONNECTORS}. */
export const SEED_BUILTINS: readonly string[] = Object.keys(OFFICIAL_CONNECTORS);

/** `<config>/cotal/seed` — the seed engine's own state root (NOT inside the npm prefix). */
export function seedDir(): string {
  return join(globalConfigDir(), "seed");
}

/** The monotonic ever-seeded authority: which built-ins were ever seeded (never shrinks). */
export function authorityPath(): string {
  return join(seedDir(), "authority.json");
}

/** The durable append-only backup of the authority — the ONLY source `ext seed --repair` can
 *  recover a lost {@link authorityPath} from (a witness alone can't tell removed from never-seeded). */
export function authorityBackupPath(): string {
  return join(seedDir(), "authority.bak.json");
}

/** The initialization witness: proof the seeder ever ran here (distinguishes a pristine prefix from
 *  one whose authority was lost). Written after the authority, before the stamp. */
export function witnessPath(): string {
  return join(seedDir(), "witness.json");
}

/** The version stamp, written LAST: the generation the last reconcile completed for. A boot whose
 *  stamp equals the current generation short-circuits (after the health preamble). */
export function stampPath(): string {
  return join(seedDir(), "stamp.json");
}

/** The reconcile-wide lock (shared advisory-lock primitive: atomic hard-link publish, PID +
 *  process-start liveness, bounded wait, dead-owner reclaim). */
export function reconcileLockPath(): string {
  return join(seedDir(), "reconcile.lock");
}

/** The durable reconcile cursor `{nonce, package, phase}`: a partial-reconcile journal a crashed
 *  (SIGKILL) run leaves behind, so the next boot fails loud instead of silently proceeding. */
export function reconcileCursorPath(): string {
  return join(seedDir(), "reconcile.cursor.json");
}

/** The seed-child liveness marker `{pid, start, ts}`: a validated `ext add` seed child writes it
 *  before it mutates the prefix and clears it on exit, so a reclaim/repair after a parent SIGKILL can
 *  refuse to race an orphaned child that is still installing. */
export function reconcileChildPath(): string {
  return join(seedDir(), "reconcile.child.json");
}

/** The durable maintenance-recovery obligation `{rebuildFromDisk?, repairAllSeeded?}`: a `--repair`/
 *  `--reset` writes it BEFORE it destructively quarantines a corrupt manifest/cursor, so a SIGKILL
 *  after the quarantine but before the reinstalls doesn't forget that the built-ins must be rebuilt
 *  from disk (or all reinstalled). Cleared only at the final commit. */
export function reconcileRecoveryPath(): string {
  return join(seedDir(), "reconcile.recovery.json");
}

/** The durable seed store root: `<config>/cotal/seed/store`. */
export function seedStoreDir(): string {
  return join(seedDir(), "store");
}

/** A seeded connector's stable copy for one generation: `store/<generation>/<name>`. */
export function seedStorePath(generation: string, name: string): string {
  return join(seedStoreDir(), generation, name);
}

/** Resolve package-manager bin symlinks before looking for package-owned files. */
function entryScript(): string {
  const entry = process.argv[1];
  if (!entry) throw new Error("cannot resolve the cotal entry script: no entry script (process.argv[1])");
  try {
    return realpathSync(entry);
  } catch (e) {
    throw new Error(`cannot resolve the cotal entry script ${entry}: ${(e as Error).message}`);
  }
}

/**
 * The seed generation: this `cotal-ai` binary's version. Ties a reconcile-refresh to the shipped
 * payload changing — including the bundled `connector-core`, so a `cotal-ai` upgrade re-seeds the
 * connectors that carry version-coupled behavior (e.g. the v0.4 lifecycle parse). Read from the
 * nearest `package.json` above the {@link entryScript} (`cotal-ai` published, or `bin/package.json` in
 * a dev `tsx bin/cotal.ts` run). Fails loud if unreadable — a generation-less seed can't gate refresh.
 */
export function seedGeneration(): string {
  const entry = entryScript();
  let dir = dirname(entry);
  for (;;) {
    const pj = join(dir, "package.json");
    if (existsSync(pj)) {
      const version = (JSON.parse(readFileSync(pj, "utf8")) as { version?: string }).version;
      if (typeof version === "string" && version) return version;
    }
    const parent = dirname(dir);
    if (parent === dir) throw new Error(`cannot determine the seed generation: no versioned package.json above ${entry}`);
    dir = parent;
  }
}

/** This module's repo root in a source checkout: `implementations/cli/{src,dist}/seed` → up 4. Only
 *  meaningful in dev; a published `@cotal-ai/cli` resolves to `node_modules`, where the `extensions/`
 *  probe below simply misses and the published `seeded-connectors/` path wins. */
function repoRootFromHere(): string {
  return join(import.meta.dirname, "..", "..", "..", "..");
}

/**
 * The shipped payload directory for one built-in connector — the source the reconcile copies into the
 * durable store. Dev resolves `extensions/<pkg-dir>` from this module's location (NEVER `cwd`);
 * published resolves `<cotal-ai>/seeded-connectors/<name>` beside the {@link entryScript} (the `bin`
 * prepublish copy). Fails loud if neither carries a `package.json` — a build missing its seeded
 * connectors.
 */
export function shippedSourceDir(name: string): string {
  const pkg = OFFICIAL_CONNECTORS[name];
  if (!pkg) throw new Error(`"${name}" is not a first-party connector; only ${SEED_BUILTINS.join(", ")} are seeded`);
  const devDir = join(repoRootFromHere(), "extensions", pkg.split("/")[1]);
  if (existsSync(join(devDir, "package.json"))) return devDir;
  const pubDir = join(dirname(entryScript()), "..", "seeded-connectors", name);
  if (existsSync(join(pubDir, "package.json"))) return pubDir;
  throw new Error(
    `no shipped payload for connector "${name}" (looked in ${devDir} and ${pubDir}) - this cotal-ai build is missing its seeded connectors`,
  );
}

/** Atomically write JSON (temp-then-rename, exclusive temp — never follows a pre-planted symlink),
 *  the same durability `writeLaunchSpec`/manifest writes use. Creates the parent dir. */
export function writeJsonAtomic(path: string, value: unknown, mode = 0o600): void {
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true });
  const tmp = join(dir, `.${basename(path)}.${randomBytes(6).toString("hex")}.tmp`);
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode, flag: "wx" });
  renameSync(tmp, path);
}

/** Read + parse a JSON state file. Returns undefined when absent; throws (loud) on corrupt JSON — a
 *  seed-state file is never silently treated as missing (that would resurrect removed connectors). */
export function readJsonFile<T>(path: string): T | undefined {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw e;
  }
  try {
    return JSON.parse(raw) as T;
  } catch (e) {
    throw new Error(`corrupt seed state ${path}: ${(e as Error).message} - repair with \`cotal ext seed --repair\` (or --reset)`);
  }
}
