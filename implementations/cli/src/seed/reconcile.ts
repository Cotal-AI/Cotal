import { existsSync, readdirSync, renameSync } from "node:fs";
import { spawn, spawnSync, type SpawnSyncReturns } from "node:child_process";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import {
  CommandFailure,
  claimUpdateClosureAccess,
  waitForUpdateClosure,
  CorruptExtensionPackageError,
  CorruptExtensionsManifestError,
  BUILT_IN_PACKAGES,
  SEEDED_EXTENSIONS,
  connectorConfigDir,
  connectorMetadataStale,
  extensionPackageDir,
  extensionsDir,
  installedExtensionPackage,
  resolveExtensionEntry,
  inheritConnectorConfig,
  isBundledDesktopRuntime,
  loadExtensionsManifest,
  logicalExecutionEntry,
  quarantineExtensionsManifest,
  repairConnectorSelection,
  type InstalledExtension,
  type InstalledExtensionPackage,
} from "@cotal-ai/workspace";
import { c } from "../ui.js";
import { selfArgv, verifiedCotalExecutables } from "../lib/self-exec.js";
import { claimExtensionMutation } from "../lib/ext-mutation.js";
import { recoverExtensionPromotion } from "../lib/extension-stage.js";
import { assertConfigAncestorProtected } from "../lib/update-connector-config.js";
import { builtInRetirementsCurrent, builtInRetirementSpecs, retireBuiltInPackages } from "./builtin-retire.js";
import { exitInterrupted, handOverStartupNotice, INTERRUPT_SIGNALS, type InterruptSignal } from "../lib/interrupt-notice.js";
import { assertReleasedSeedWriter, entryScript, isValidSemver, parseSemver, SEED_BUILTINS, seedDir, seedGeneration, seedStoreDir, seedStorePath, stampPath } from "./paths.js";
import {
  acquireReconcileLock,
  clearChildMarker,
  clearCursor,
  clearRecovery,
  markCursorFailed,
  readCursor,
  readRecovery,
  reconcileLockActive,
  recoveryPending,
  sanitizeCorruptCrashState,
  seedChildStatus,
  type ReconcileCursor,
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
  type Stamp,
} from "./authority.js";
import { gcSeedStore, stageSeedPayload } from "./store.js";
import { installedDeclarationDiffers, prefixLockDiffers, seededInstallDiffers, operatorInstallDiffers, operatorUpdateSpec } from "./verify.js";
import { assertAutomaticSeedManagers } from "./manager-guard.js";

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
 *  - every still-installed first-party extension (`@cotal-ai/*`) is brought to the running generation
 *    on upgrade, or the reconcile refuses loud naming `cotal update --self`.
 */

/** `verify` is `cotal update`'s mode: every built-in is reconciled under the locks like `force`, but a
 *  seeded entry at the running generation whose installed copy is proven identical to the shipped
 *  payload ({@link seededInstallDiffers}) is kept rather than reinstalled. */
type Mode = "auto" | "force" | "repair" | "reset" | "verify";

export interface SeedFlags {
  readonly repair?: boolean;
  readonly reset?: boolean;
  readonly force?: boolean;
  /** Reinstall only a built-in whose installed copy differs from the shipped payload. */
  readonly verify?: boolean;
}

export interface ReconcileResult {
  readonly noop: boolean;
  readonly seeded: string[];
  readonly refreshed: string[];
  readonly verified: string[];
  readonly removedKept: string[];
}

export class SeedChildFailure extends Error {
  constructor(readonly summary: string, readonly lines: readonly string[]) {
    super(`${summary}: ${lines.join("\n")}`);
  }
}

/** Auto reconcile for the boot gate: silent no-op when the stamp is current and healthy. */
export async function reconcileSeededConnectors(resumeFirstSeed = false): Promise<void> {
  await reconcile("auto", true, resumeFirstSeed);
}

/** Whether the seed journal, authority and installed payloads need no repair. */
export function seedInstallationCurrent(): boolean {
  try {
    const generation = seedGeneration();
    if (readCursor() || readRecovery() || seedChildStatus().kind !== "none" || reconcileLockActive()) return false;
    if (!readWitness() || !authorityIntact() || !builtinsAccounted() || !builtinsMetadataCurrent() || !builtInRetirementsCurrent() || readStamp()?.generation !== generation) return false;
    const entries = SEED_BUILTINS.map(name => ({ name, entry: installedEntry(name) }));
    if (entries.some(({ entry }) => entry !== undefined) && prefixLockDiffers() !== undefined) return false;
    return entries.every(({ name, entry }) => entry === undefined ||
      seededInstallDiffers(name, generation, entry) === undefined);
  } catch {
    return false;
  }
}

/** Validate persisted seed journals without repairing them or rejecting valid recovery obligations. */
export function assertReadableSeedState(): void {
  readCursor();
  readRecovery();
}

/** Read the refusal for an unfinished seed that needs manual repair, without running reconcile. */
export function readSeedRepairRefusal(generation: string): Error | undefined {
  const cursor = readCursor();
  if ((!cursor && !readRecovery()) || reconcileLockActive()) return;
  const child = seedChildStatus();
  if (child.kind === "ambiguous") return ambiguousSeedChild(child.path);
  if (child.kind !== "none") return;
  if (cursor && interruptedUpgrade(cursor, generation)) return;
  return seedRepairRefusal(cursor, generation);
}

/** `cotal ext seed [--repair|--reset|--force]`: the maintenance entry. Prints a summary. */
export async function runSeed(flags: SeedFlags, selfUpdate = false): Promise<void> {
  const mode: Mode = flags.reset ? "reset" : flags.repair ? "repair" : flags.force ? "force" : flags.verify ? "verify" : "auto";
  const result = await reconcile(mode, false, false, selfUpdate);
  if (result.noop) {
    console.log(c.green("✓ built-in connectors up to date"));
    return;
  }
  const parts: string[] = [];
  if (result.seeded.length) parts.push(`seeded ${result.seeded.join(", ")}`);
  if (result.refreshed.length) parts.push(`refreshed ${result.refreshed.join(", ")}`);
  if (result.verified.length) parts.push(`verified ${result.verified.join(", ")}`);
  if (result.removedKept.length) parts.push(`kept removed ${result.removedKept.join(", ")}`);
  console.log(c.green(`✓ connectors reconciled`) + (parts.length ? c.dim(` - ${parts.join("; ")}`) : ""));
}

const NOOP: ReconcileResult = { noop: true, seeded: [], refreshed: [], verified: [], removedKept: [] };

async function reconcile(mode: Mode, automatic = false, resumeFirstSeed = false, selfUpdate = false): Promise<ReconcileResult> {
  if (waitForUpdateClosure()) {
    if (process.env.COTAL_UPDATE_REEXEC === "1") throw new Error("another Cotal update finished while this command waited; run the command again");
    console.error("Cotal update finished; restarting command with the installed CLI");
    const child = spawn(process.execPath, process.argv.slice(1), { env: { ...process.env, COTAL_UPDATE_REEXEC: "1" }, stdio: "inherit", windowsHide: true });
    const forward = (signal: NodeJS.Signals) => child.kill(signal);
    const onInt = () => forward("SIGINT"), onTerm = () => forward("SIGTERM");
    process.on("SIGINT", onInt); process.on("SIGTERM", onTerm);
    const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", (code, signal) => resolve({ code, signal }));
    });
    process.off("SIGINT", onInt); process.off("SIGTERM", onTerm);
    if (result.signal) { process.kill(process.pid, result.signal); await new Promise(() => {}); }
    process.exit(result.code ?? 1);
  }
  return reconcileUnderClosure(mode, automatic, resumeFirstSeed, selfUpdate);
}

async function reconcileUnderClosure(mode: Mode, automatic: boolean, resumeFirstSeed: boolean, selfUpdate: boolean): Promise<ReconcileResult> {
  const generation = seedGeneration();
  const downgrade = seedDowngradeRefusal(generation);
  if (downgrade) throw downgrade;
  if (!automatic && mode !== "verify") assertConfigAncestorProtected();
  if (mode === "repair" && !automatic) {
    assertReleasedSeedWriter(generation, "reconcile");
    const release = claimUpdateClosureAccess();
    try {
      repairConnectorSelection(() => {
        const sourceDowngrade = seedDowngradeRefusal(generation);
        if (sourceDowngrade) throw sourceDowngrade;
      });
      recoverExtensionPromotion();
    } finally { release(); }
  }
  inheritConnectorConfig();
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
          throw ambiguousSeedChild(child.path);
        const migration = cursor ? interruptedUpgrade(cursor, generation) : undefined;
        if (child.kind === "stale") {
          await reconcile("repair", automatic);
          return NOOP;
        }
        if (migration && cursor) {
          if (!automatic) console.error(
            c.dim(
              `resuming ${cursor.failed ? "a failed" : "an interrupted"} connector upgrade (seed store ${migration.from} -> ${generation}; ` +
                `package "${cursor.package}", phase ${cursor.phase}) …`,
            ),
          );
          await reconcile("repair", automatic);
          return NOOP;
        }
        if (!resumeFirstSeed || !interruptedFirstSeed(cursor, generation)) throw seedRepairRefusal(cursor, generation);
      }
    } else if (readWitness() && authorityIntact() && builtinsAccounted() && builtinsMetadataCurrent() && officialExtensionsCurrent(generation) && builtInRetirementsCurrent() && readStamp()?.generation === generation && !reconcileLockActive()) {
      // Steady state AND no reconcile in flight. The lock check is LAST (immediately before NOOP) so
      // it is the linearization point: a `--force` that link-publishes the lock during the slower
      // health/stamp reads is still caught here, and we fall through to acquire/wait rather than
      // racing past into the command while it mutates the prefix.
      return NOOP;
    }
  }
  if (automatic) assertConfigAncestorProtected();
  const releaseClosure = claimUpdateClosureAccess();
  let interrupted: InterruptSignal | undefined;
  const onInterrupt = (signal: InterruptSignal): void => { interrupted ??= signal; };
  const cancelled = new Error("connector seed interrupted");
  let retryMode = mode;
  const checkInterrupted = async (verifiedInstall = false): Promise<void> => {
    if (automatic || mode === "verify") return;
    // spawnSync cannot dispatch a signal. Poll before looking at it or starting another install.
    for (let turn = 0; turn < 2; turn++) await new Promise((resolve) => setImmediate(resolve));
    if (interrupted === undefined) return;
    // A verified ordinary install needs no crash recovery. Maintenance can have an earlier
    // recovery obligation, so keep its journals for a retry of that maintenance command.
    if (mode === "auto") {
      if (verifiedInstall) clearCursor();
      else retryMode = "repair";
    }
    throw cancelled;
  };
  try {
  assertReleasedSeedWriter(generation, "reconcile");
  if ((mode === "auto" || automatic) && readStamp()?.generation !== undefined && readStamp()?.generation !== generation) {
    // Validate the selected prefix before treating a Manager observation failure as a hold.
    connectorConfigDir();
    try { await assertAutomaticSeedManagers(generation); }
    catch (error) {
      if (!automatic) throw error;
      const detail = (error instanceof Error ? error.message : String(error)).split(/[\r\n;]/, 1)[0]!.trim();
      console.error(`${detail || "A local Manager could not be identified"}; its connectors stay at their existing version until the Manager is restarted`);
      return NOOP;
    }
  }
  const lock = acquireReconcileLock();
  try {
    // Claim the mutation lock INSIDE the reconcile lock's finally: if it throws (an operator `cotal
    // ext` op holds it past the wait), the reconcile lock is still released, not leaked. The reconcile
    // takes a modest bounded wait (a brief operator op shouldn't fail the boot-gate); operators
    // themselves fail fast.
    let releaseMutation = claimExtensionMutation({ waitMs: 30000 });
    try {
      if (!automatic && mode !== "verify") {
        for (const signal of INTERRUPT_SIGNALS) process.on(signal, onInterrupt);
        handOverStartupNotice();
      }
      return await runUnderLocks(mode, generation, lock.nonce, async () => {
        // Provider imports take their own extension lock. Keep the reconcile lock and unfinished
        // cursor, but release our writer while the harness refresh uses the normal loader.
        const before = JSON.stringify(loadExtensionsManifest());
        releaseMutation();
        releaseMutation = () => {};
        const { refreshConnectorInstalls } = await import("../commands/setup.js");
        for (const line of await refreshConnectorInstalls(undefined, selfUpdate)) console.error(c.dim(`→ ${line}`));
        releaseMutation = claimExtensionMutation({ waitMs: 30000 });
        if (JSON.stringify(loadExtensionsManifest()) !== before)
          throw new Error("installed extensions changed during connector refresh; retry the upgrade before committing its generation");
      }, checkInterrupted, resumeFirstSeed);
    } catch (e) {
      // This process is alive to see the failure, so the cursor it leaves says so: the next run
      // reports why the seed failed, not an interruption. Failing to note it leaves that cursor as an
      // interruption, and the seed's own error is still the one reported.
      if (e !== cancelled) {
        try { markCursorFailed(lock.nonce, e instanceof Error ? e.message : String(e)); } catch { /* reported below */ }
      }
      throw e;
    } finally {
      releaseMutation();
    }
  } finally {
    lock.release();
  }
  } catch (e) {
    if (e !== cancelled || interrupted === undefined) throw e;
  } finally {
    for (const signal of INTERRUPT_SIGNALS) process.off(signal, onInterrupt);
    releaseClosure();
  }
  const retry = retryMode === "auto" ? "cotal ext seed" : `cotal ext seed --${retryMode}`;
  exitInterrupted(interrupted, `Connector seed interrupted. Run \`${retry}\` to finish seeding.`);
}

/** A cursor left while the durable stamp still names an older generation is evidence that this
 * running generation began the ordinary upgrade refresh and did not reach its final commit. The
 * cursor identifies the exact package to reinstall, the child marker proves no installer remains,
 * and the reconcile/extension locks serialize the recovery, so the same verified repair used by the
 * maintenance command is safe to resume unattended. A same-generation (or unstamped/corrupt-stamp)
 * cursor is not attributed to an upgrade and remains fail-loud. */
function interruptedUpgrade(cursor: ReconcileCursor, generation: string): { readonly from: string } | undefined {
  const stamp = readStamp();
  if (!stamp || !isValidSemver(stamp.generation) || !isStrictlyNewer(generation, stamp.generation)) return undefined;
  return { from: stamp.generation };
}

/** An absent stamp is not enough: look for the current staged add and rule out a prior seed or repair. */
function interruptedFirstSeed(cursor: ReconcileCursor | undefined, generation: string): boolean {
  if (!cursor || cursor.phase !== "add" || cursor.failed !== undefined ||
      readStamp() || readWitness() || everSeededUnion() || recoveryPending() ||
      !existsSync(join(seedStorePath(generation, cursor.package), "package.json"))) return false;
  return readdirSync(seedStoreDir()).every((entry) => entry === generation) &&
    loadExtensionsManifest().extensions.every((entry) => {
      const name = officialNameOfPkg(entry.pkg);
      return name !== undefined && entry.source === "seeded" && entry.version === generation &&
        entry.spec === seedStorePath(generation, name);
    });
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

/** The steady-state fast paths may NOOP only when every CURRENT built-in is accounted for in the
 *  authority. Without this, a built-in ADDED at an unchanged generation (a source checkout, or a
 *  prefix stamped before the built-in set grew) would stay never-seeded forever: the stamp says
 *  "current" while the set it stamped no longer matches. A deliberately-removed built-in still
 *  counts as accounted — the authority is monotonic (removed ids never leave it) — so
 *  removed-stays-removed is unaffected. */
function builtinsAccounted(): boolean {
  try {
    const ever = everSeededUnion();
    if (!ever) return false;
    return SEED_BUILTINS.every((name) => ever.has(name));
  } catch {
    return false;
  }
}

/** A package can add a registry provider without changing the seed generation in a source checkout.
 * The fast path must not preserve an older manifest that advertises only a subset of what the packed
 * built-in now registers, or lazy materialization of the new provider can never find its owner. An
 * entry whose connector metadata predates the cached setup ref is that older manifest. */
function builtinsMetadataCurrent(generation: string = seedGeneration()): boolean {
  for (const name of SEED_BUILTINS) {
    const entry = installedEntry(name);
    if (entry && (entry.source !== "seeded" || entry.version !== generation || !entry.installId || connectorMetadataStale(entry))) return false;
  }
  return true;
}

/** Why an operator-installed official extension needs to be brought to `generation`, or undefined when
 *  it is recorded and installed on disk at `generation` with its entry present. */
function operatorPackageDiffers(entry: InstalledExtension, generation: string): string | undefined {
  if (entry.version !== generation) return `recorded at ${entry.version}, not ${generation}`;
  let installed: ReturnType<typeof installedExtensionPackage>;
  try {
    installed = installedExtensionPackage(entry.pkg);
  } catch {
    return "corrupt package metadata on disk";
  }
  if (!installed) return "not installed on disk";
  if (installed.version !== generation) return `installed at ${installed.version}, not ${generation}`;
  if (!entryPresent(entry.pkg, installed)) return "entry file is missing";
  return installedDeclarationDiffers(entry, installed, generation);
}

/** Whether every operator-installed official `@cotal-ai/*` extension is recorded and on disk at `generation`. */
function officialExtensionsCurrent(generation: string): boolean {
  try {
    const builtIns = new Set(Object.values(SEEDED_EXTENSIONS).map((entry) => entry.pkg));
    return loadExtensionsManifest().extensions.every(
      (entry) => !entry.pkg.startsWith("@cotal-ai/") || builtIns.has(entry.pkg) || Object.hasOwn(BUILT_IN_PACKAGES, entry.pkg) || operatorPackageDiffers(entry, generation) === undefined,
    );
  } catch {
    return false;
  }
}

async function runUnderLocks(mode: Mode, generation: string, nonce: string, refreshInstalls: () => Promise<void>, checkInterrupted: (verifiedInstall?: boolean) => Promise<void>, resumeFirstSeed: boolean): Promise<ReconcileResult> {
  // Refuse to touch the prefix while an orphaned seed child (a crashed parent's still-running
  // installer) is mutating it. Reclaiming the lock does not stop that process. An unprovable
  // pending marker or corrupt record stays fail-loud.
  const child = seedChildStatus();
  if (child.kind === "live")
    throw new Error(`a connector seed child (pid ${child.pid}) is still installing - retry once it finishes`);
  if (child.kind === "ambiguous")
    throw new Error(`a connector seed may be mid-flight (marker ${child.path}) - if no cotal process is running, remove it and retry`);
  if (child.kind === "stale") {
    clearChildMarker();
    console.error(c.dim("cleared an interrupted connector seed child marker: parent and installer are gone"));
  }

  // REFUSE TO WRITE A GENERATION OLDER THAN THE STORE'S. An older binary run against a store stamped
  // newer misses the fast path (its generation is not the stamp), refreshes NOTHING (the refresh below
  // fires only when the running binary is strictly newer), and then writes its own older generation
  // over the stamp at the commit. The store is left claiming a generation whose payloads are not the
  // ones installed, and the next command from the newer binary sees the skew and reinstalls every
  // connector to stamp it back. Two binaries alternating flap the store and pay a full reseed each way.
  //
  // Reproduced live before this guard existed: seed a home with 0.18.0, then run `cotal ext list` from
  // a 0.16.0 build against the same home. A READ command, not a seed. The stamp went 0.18.0 -> 0.16.0
  // with the 213 payload files byte-identical, and the next 0.18.0 command re-added all six connectors.
  //
  // Every mode refuses a backward migration, including force/reset. A shadowed older executable
  // must not replace a newer machine-wide generation. Check before any maintenance quarantine.
  const downgrade = seedDowngradeRefusal(generation);
  if (downgrade) throw downgrade;

  // A competing writer may have changed the cursor or committed while setup waited for the locks.
  if (mode === "auto" && resumeFirstSeed && interruptedFirstSeed(readCursor(), generation)) mode = "repair";

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
    if (mode === "auto" && cursor.failed) throw failedSeed(cursor);
    if (mode === "auto")
      throw new Error(
        `a previous connector seed was interrupted (package "${cursor.package}", phase ${cursor.phase}) - run \`cotal ext seed --repair\``,
      );
    console.error(c.dim(`recovering from ${cursor.failed ? "a failed" : "an interrupted"} seed (package "${cursor.package}") …`));
  }
  if (mode === "auto" && !cursor && recoveryPending())
    throw new Error("a previous connector repair was interrupted - run `cotal ext seed --repair`");

  const everSeeded = resolveEverSeeded(mode, generation);

  // Stamp fast path under the lock: a competing boot may have reconciled while we waited. Only when no
  // cursor or recovery obligation is outstanding (an interrupted run must proceed, not short-circuit),
  // and only when every current built-in is accounted for (same rule as the lock-free fast path — a
  // built-in added at an unchanged generation must fall through to the never-seeded branch below).
  if (
    mode === "auto" &&
    !cursor &&
    !recoveryPending() &&
    readWitness() &&
    builtinsMetadataCurrent() &&
    officialExtensionsCurrent(generation) &&
    builtInRetirementsCurrent() &&
    readStamp()?.generation === generation &&
    SEED_BUILTINS.every((name) => everSeeded.has(name))
  )
    return NOOP;

  await retireBuiltInPackages();
  const stampGen = readStamp()?.generation;
  const migrationFrom =
    mode !== "reset" &&
    stampGen !== undefined &&
    isValidSemver(stampGen) &&
    isStrictlyNewer(generation, stampGen)
      ? stampGen
      : undefined;
  const repairTarget = mode === "repair" ? cursor?.package : undefined;
  const seeded: string[] = [];
  const refreshed: string[] = [];
  const verified: string[] = [];
  const removedKept: string[] = [];
  const staged: { name: string; pkg: string; spec: string; version: string; source: "seeded" }[] = [];
  const install = async (name: string, force: boolean): Promise<void> => {
    if (mode !== "verify") {
      try {
        seedOne(name, generation, nonce, force);
        verifyInstalled(name, generation);
      } catch (error) {
        await checkInterrupted();
        throw error;
      }
      await checkInterrupted(true);
      return;
    }
    console.error(c.dim(`Reconciling built-in ${name}@${generation}`));
    writeCursor({ nonce, package: name, phase: "copy" });
    const spec = stageSeedPayload(generation, name, { force });
    staged.push({ name, pkg: SEEDED_EXTENSIONS[name].pkg, spec, version: generation, source: "seeded" });
  };
  // A verify run keeps a built-in only on proof. An interrupted or failed earlier run and a prefix
  // that is not the tree its lock records each void that proof for every built-in at once, so the run
  // reinstalls all of them the way `--force` does, and says why. Read when the first installed
  // built-in asks, so a first boot with nothing installed yet reports no prefix at all.
  let voided: string | undefined;
  let voidedRead = false;
  const unverifiable = (): string | undefined => {
    if (!voidedRead) {
      voidedRead = true;
      voided = cursor ? `a previous seed of "${cursor.package}" did not finish`
        : recoveryPending() ? "a previous repair did not finish"
        : prefixLockDiffers();
      if (voided) console.error(c.dim(`reinstalling every built-in: ${voided}`));
    }
    return voided;
  };

  for (const name of SEED_BUILTINS) {
    const entry = installedEntry(name);
    const wasSeeded = everSeeded.has(name) && mode !== "reset";
    if (name === repairTarget) {
      // The interrupted package (the cursor only ever names an ADD in progress — removals never write
      // it): re-install it regardless of current manifest state, whether the crash tore the files or
      // died before the manifest commit. Verified below before the cursor is cleared.
      await install(name, true);
      everSeeded.add(name);
      refreshed.push(name);
    } else if (!wasSeeded) {
      await install(name, mode === "reset" || mode === "force");
      everSeeded.add(name);
      seeded.push(name);
    } else if (entry) {
      // Refresh policy: any --force; a strictly-newer generation; an entry whose version or seeded
      // provenance differs from the running generation; on an unknown-cursor --repair (repairAllSeeded)
      // every seeded built-in; and on an ordinary --repair a seeded entry that is not fully intact on
      // disk (a partial tear can leave package.json while a required file is gone).
      const isSeeded = entry.source === "seeded";
      const torn = mode === "repair" && isSeeded && (repairAllSeeded || typeof entry.spec !== "string" || installState(name) !== "intact");
      const metadataStale = !isSeeded || entry.version !== generation || !entry.installId || connectorMetadataStale(entry);
      let refresh = mode === "force" || torn || metadataStale || isStrictlyNewer(generation, stampGen);
      if (mode === "auto" && refresh && !torn && !metadataStale && entry.version === generation && seededInstallDiffers(name, generation, entry) === undefined) {
        refresh = false;
      }
      if (mode === "verify" && !refresh) {
        const differs = unverifiable() ?? seededInstallDiffers(name, generation, entry);
        if (differs === undefined) {
          verified.push(name);
        } else {
          if (!voided) console.error(c.dim(`${name}: ${differs}; reinstalling`));
          refresh = true;
        }
      }
      if (refresh) {
        await install(name, true);
        refreshed.push(name);
      }
    } else if (manifestRebuilt && installState(name) !== "absent") {
      // The manifest was corrupt and quarantined, but this connector is STILL on disk: its entry was
      // lost with the manifest, not removed. Re-seed it to rebuild the record (a quarantined manifest
      // carries no reliable "removed" fact — only on-disk presence can distinguish the two).
      await install(name, true);
      refreshed.push(name);
    } else {
      removedKept.push(name); // seeded before, deliberately removed (or absent on disk) → leave removed
    }
  }

  const builtIns = new Set(Object.values(SEEDED_EXTENSIONS).map((entry) => entry.pkg));
  const operators = mode === "reset" ? [] : loadExtensionsManifest().extensions.filter((entry) =>
    entry.pkg.startsWith("@cotal-ai/") && !builtIns.has(entry.pkg) && !Object.hasOwn(BUILT_IN_PACKAGES, entry.pkg) && (
      mode === "verify"
        ? operatorInstallDiffers(entry, generation) !== undefined
        : mode === "force" || (mode === "repair" && repairAllSeeded) || operatorPackageDiffers(entry, generation) !== undefined
    ),
  ).map((entry) => ({ pkg: entry.pkg, spec: operatorUpdateSpec(entry, generation), version: generation }));

  if (mode === "verify") {
    const { installExtensionSet } = await import("../commands/ext.js");
    await installExtensionSet([...staged, ...operators]);
    for (const entry of staged) verifyInstalled(entry.name, generation);
    for (const entry of operators) verifyOperatorInstalled(entry.pkg, generation);
  } else if (operators.length) {
    clearCursor();
    const { installExtensionSet } = await import("../commands/ext.js");
    for (const entry of operators) console.error(c.dim(`Reconciling extension ${entry.pkg}@${generation}`));
    try {
      await installExtensionSet(operators, console.error, { isolate: true });
      for (const entry of operators) {
        verifyOperatorInstalled(entry.pkg, generation);
        refreshed.push(entry.pkg);
      }
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      const desktop = isBundledDesktopRuntime();
      throw new CommandFailure(
        "refused",
        "DEPENDENCY_UNAVAILABLE",
        desktop
          ? `failed to reconcile ${operators.map((entry) => `${entry.pkg}@${generation}`).join(", ")}: ${detail}`
          : `failed to reconcile ${operators.map((entry) => `${entry.pkg}@${generation}`).join(", ")}: ${detail} - run \`cotal update --self\` to reconcile this installation`,
        { cause: error, ...(desktop ? {} : { remedy: "run `cotal update --self` to reconcile this installation" }) },
      );
    }
  }

  // An npm upgrade reaches this path before the command runs. Refresh harness-owned copies before
  // stamping the generation: a failed refresh must remain an incomplete upgrade on the next boot.
  if (migrationFrom) await refreshInstalls();
  await checkInterrupted(true);

  // Commit: authority (+ backup) → witness → stamp (LAST); THEN drop the cursor + recovery obligation
  // and GC old stores. A crash above (including a repair that quarantined then died mid-reinstall)
  // remains detectable and recoverable on the next boot.
  writeAuthority(everSeeded);
  ensureWitness(generation);
  const committedStamp = writeStamp(generation, entryScript());
  if (stampGen !== generation) moved = { ...(stampGen === undefined ? {} : { from: stampGen }), to: generation };
  if (migrationFrom) announceSeedMigration(migrationFrom, committedStamp);
  clearCursor();
  clearRecovery();
  gcSeedStore(
    generation,
    [...loadExtensionsManifest().extensions.map((e) => e.spec), ...builtInRetirementSpecs()],
  );
  return { noop: false, seeded, refreshed, verified, removedKept };
}

/** What refuses an `up` at the boot gate, where it defers its seed to its first launch, in the order
 *  {@link reconcile} would refuse: a writer that may not write a store that is not current, then an
 *  executable older than the store. Neither check writes anything. */
export function deferredSeedRefusal(): Error | undefined {
  const generation = seedGeneration();
  let current = false;
  try {
    current = !readCursor() && !recoveryPending() && !!readWitness() && authorityIntact() && builtinsAccounted() && builtinsMetadataCurrent() && officialExtensionsCurrent(generation) && builtInRetirementsCurrent() && readStamp()?.generation === generation;
  } catch {
    current = false; // unreadable seed state: the deferred reconcile reports it
  }
  if (current) return undefined;
  try {
    assertReleasedSeedWriter(generation, "reconcile");
  } catch (error) {
    return error as Error;
  }
  return seedDowngradeRefusal(generation);
}

/** The refusal an executable older than the seed store's generation meets before it writes anything,
 *  or undefined when the store is not newer than `generation`. It names the store, because restoring
 *  that store is what lets this executable run, and gives the versions as context. */
export function seedDowngradeRefusal(generation: string = seedGeneration()): Error | undefined {
  let storeGeneration: string | undefined;
  try {
    storeGeneration = readStamp()?.generation;
  } catch {
    storeGeneration = undefined; // corrupt JSON: the maintenance path quarantines it
  }
  if (
    storeGeneration !== undefined &&
    isValidSemver(storeGeneration) &&
    isStrictlyNewer(storeGeneration, generation)
  ) {
    const newerExecutable = verifiedCotalExecutables().find(
      (candidate) => compareSemver(candidate.version, storeGeneration) >= 0,
    );
    const newer = newerExecutable
      ? `; the cotal-ai ${newerExecutable.version} executable at ${JSON.stringify(newerExecutable.path)} uses the store as it is`
      : "";
    const stampProvenance = describeStampProvenance(readStamp());
    return new Error(
      `the connector seed store ${seedDir()} is at generation ${storeGeneration}${stampProvenance}, and this cotal ${generation} does not move it back to an older one - ` +
        `run \`cotal update --self\` to upgrade the CLI; to run this cotal, restore that store and the extensions folder ${extensionsDir()} from a backup taken before the store moved to ${storeGeneration}${newer}`,
    );
  }
  return undefined;
}

/** The seed store generation this process moved, from the one its stamp named (absent on a first
 *  seed) to its own; undefined while it moved none. */
let moved: { readonly from?: string; readonly to: string } | undefined;

export function seedStoreMoved(): { readonly from?: string; readonly to: string } | undefined {
  return moved;
}

function describeStampProvenance(stamp: Stamp | undefined): string {
  if (!stamp?.writtenBy || !stamp.writtenAt) return "";
  return `, written by ${stamp.writtenBy} at ${stamp.writtenAt}`;
}

function announceSeedMigration(from: string, stamp: Stamp): void {
  process.stderr.write(
    `→ migrated operator-global seed store generation ${from} -> ${stamp.generation}, written by ${stamp.writtenBy} at ${stamp.writtenAt}: ${stampPath()}\n`,
  );
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
    } catch (error) {
      if (!(error instanceof CorruptExtensionsManifestError)) throw error;
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
  // The re-exec entry is validated BEFORE anything is journaled (#1629). Asked after the cursor, the
  // staged payload and the pending child marker, a refusal left all three with no child to clear the
  // marker, and every later boot, `cotal ext seed --repair` included, refused as a seed that may be
  // mid-flight until the marker was removed by hand.
  //
  // The pending marker records intent to spawn BEFORE the spawn, so the orphan window never opens
  // ownerless: a repair after a parent SIGKILL sees it and fails loud rather than racing the installer.
  const [bin, ...argv] = selfArgv();
  // A seed child must mutate the same installed selection as its parent, not one
  // keyed by the immutable retained entry that the bootstrap loaded.
  const logical = logicalExecutionEntry();
  if (logical) argv[argv.length - 1] = logical;
  const started = Date.now();
  console.error(c.dim(`Reconciling built-in ${name}@${generation}`));
  writeCursor({ nonce, package: name, phase: "copy" });
  const storePath = stageSeedPayload(generation, name, { force });
  writeCursor({ nonce, package: name, phase: "add" });
  writePendingChildMarker(nonce);
  const r = spawnSync(bin, [...argv, "ext", "add", storePath], {
    encoding: "utf8", windowsHide: true,
    env: { ...process.env, COTAL_TELEMETRY_DISABLED: "1", COTAL_EXT_SEEDING: nonce, COTAL_EXT_SEEDING_PARENT: String(process.pid) },
  });
  clearChildMarker(); // parent survived the child: the marker's job is done (child also clears its own)
  // The child's `✓ added …` line is seeding progress, not the invoking command's output: the boot gate
  // runs this ahead of whatever command was typed, so on stdout it would land in front of that
  // command's result (a first-boot `cotal meshes --json` printed seven non-JSON lines).
  if (r.stdout) process.stderr.write(r.stdout);
  if (r.status !== 0) throw new SeedChildFailure(`failed to seed connector "${name}" from ${storePath}`, childFailure(r).split("\n"));
  console.error(`✓ built-in ${name} reconciled (${((Date.now() - started) / 1000).toFixed(1)} s)`);
}

/** Why a seed child failed. It writes its progress and then its `✗` failure to stderr: the progress
 *  is relayed as progress and the failure is the reason. A child that printed no failure is
 *  described by its last lines, or by how it ended. */
function childFailure(r: SpawnSyncReturns<string>): string {
  const plain = (text: string) => text.replace(/\x1b\[[0-9;]*m/g, "");
  const lines = `${r.stderr ?? ""}`.trimEnd().split("\n");
  const at = lines.findLastIndex((line) => plain(line).startsWith("✗ "));
  if (at < 0) {
    const tail = lines.slice(-8).join("\n").trim();
    return tail || (r.error?.message ?? (r.signal ? `the seed child ended on ${r.signal}` : `the seed child exited with status ${r.status}`));
  }
  if (at > 0) process.stderr.write(`${lines.slice(0, at).join("\n")}\n`);
  return plain(lines.slice(at).join("\n")).slice(2);
}

/** The refusal after a seed that failed: what failed, and that `--repair` finishes it. */
function failedSeed(cursor: ReconcileCursor): Error {
  return new Error(`a previous connector seed failed (package "${cursor.package}", phase ${cursor.phase}): ${cursor.failed} - fix that, then run \`cotal ext seed --repair\``);
}

function ambiguousSeedChild(path: string): Error {
  return new Error(`a connector seed may be mid-flight (marker ${path}) - if no cotal process is running, remove it, then run \`cotal ext seed --repair\``);
}

function seedRepairRefusal(cursor: ReconcileCursor | undefined, generation: string): Error {
  if (cursor?.failed) return failedSeed(cursor);
  if (!cursor) return new Error(
    "a previous connector repair was interrupted (recovery journal present; no live reconcile or seed child found) - " +
      "run `cotal ext seed --repair`",
  );
  const storeGeneration = readStamp()?.generation ?? "absent";
  return new Error(
    `a previous connector seed was interrupted (package "${cursor.package}", phase ${cursor.phase}; ` +
      `seed store generation ${storeGeneration}, running generation ${generation}; ` +
      "no live reconcile or seed child found) - run `cotal ext seed --repair`",
  );
}

/** Confirm a connector the reconcile claims to have (re)installed is recorded AND on disk at the
 *  seed generation with its entry file resolvable — so `--repair` can never clear the cursor and stamp
 *  success over a half-installed prefix (a surviving package.json with a missing entry is still broken)
 *  or a version-skewed payload (installed version != generation) that would silently mismatch core. */
function verifyInstalled(name: string, generation: string): void {
  const pkg = SEEDED_EXTENSIONS[name].pkg;
  const entry = installedEntry(name);
  if (!entry) throw new Error(`connector "${name}" (${pkg}) was expected in the manifest after seeding but is absent - rerun \`cotal ext seed --repair\``);
  const installed = installedExtensionPackage(pkg);
  if (!installed)
    throw new Error(`connector "${name}" (${pkg}) is recorded but not installed on disk - rerun \`cotal ext seed --repair\``);
  if (installed.version !== generation)
    throw new Error(`connector "${name}" (${pkg}) installed at version ${installed.version} but the seed generation is ${generation} (a version-skewed payload) - rerun \`cotal ext seed --repair\``);
  if (!entryPresent(pkg, installed))
    throw new Error(`connector "${name}" (${pkg}) is installed but its entry file is missing (a torn install) - rerun \`cotal ext seed --repair\``);
  const declarationProblem = installedDeclarationDiffers(entry, installed, generation);
  if (declarationProblem)
    throw new Error(`connector "${name}" (${pkg}): ${declarationProblem} - rerun \`cotal ext seed --repair\``);
}

function verifyOperatorInstalled(pkg: string, generation: string): void {
  const entry = loadExtensionsManifest().extensions.find((e) => e.pkg === pkg);
  if (!entry) throw new Error(`extension ${pkg} was expected in the manifest after reconciliation but is absent`);
  const differs = operatorPackageDiffers(entry, generation);
  if (differs) throw new Error(`extension ${pkg} after reconciliation is ${differs}`);
}

/** The package's resolved entry file exists on disk. Used to
 *  detect a torn install where package.json survived a partial npm copy but the built dist did not. */
function entryPresent(pkg: string, installed: InstalledExtensionPackage): boolean {
  return existsSync(resolveExtensionEntry(extensionPackageDir(pkg), installed));
}

/** A seeded built-in's install on disk. It is intact only with a package.json carrying a version AND
 *  its entry file present; a partial tear (entry gone, package.json kept) or a corrupt package.json
 *  is torn, which a maintenance run reinstalls rather than stopping on. */
function installState(name: string): "absent" | "torn" | "intact" {
  const pkg = SEEDED_EXTENSIONS[name].pkg;
  let installed: ReturnType<typeof installedExtensionPackage>;
  try {
    installed = installedExtensionPackage(pkg);
  } catch (e) {
    if (e instanceof CorruptExtensionPackageError) return "torn";
    throw e;
  }
  if (!installed) return "absent";
  return entryPresent(pkg, installed) ? "intact" : "torn";
}

function installedEntry(name: string): InstalledExtension | undefined {
  const pkg = SEEDED_EXTENSIONS[name].pkg;
  return loadExtensionsManifest().extensions.find((e) => e.pkg === pkg);
}

function officialNameOfPkg(pkg: string): string | undefined {
  return SEED_BUILTINS.find((name) => SEEDED_EXTENSIONS[name].pkg === pkg);
}

/** A DOWNGRADE never rewrites installed connector code without `--force`; an absent prior stamp counts
 *  as older, so an upgrade from an un-stamped prefix refreshes. Semver 2.0 precedence (prerelease
 *  ordering included), so `1.0.0-rc.1` < `1.0.0` and `1.0.10` > `1.0.9`. */
function isStrictlyNewer(a: string, b: string | undefined): boolean {
  return compareSemver(a, b ?? "0.0.0") > 0;
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
