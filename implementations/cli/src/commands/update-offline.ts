import { statSync } from "node:fs";
import {
  CorruptExtensionPackageError,
  claimExtensionMutationLock,
  claimUpdateClosureAccess,
  extensionPackageDir,
  installedExtensionPackage,
  isExtensionPathSpec,
  resolveExtensionEntry,
  SEEDED_EXTENSIONS,
  type InstalledExtension,
} from "@cotal-ai/workspace";
import { SEED_BUILTINS } from "../seed/paths.js";
import { acquireReconcileLock } from "../seed/lock.js";
import { operatorInstallDiffers } from "../seed/verify.js";
import { stageSeedPayload } from "../seed/store.js";
import { c } from "../ui.js";
import { ExtensionAddInterrupted, installExtensionSet, type ExtensionInstallRequest } from "./ext.js";
import { message } from "./update-process.js";
import type { UpdateRuntime } from "./update.js";

/** Repair installed packages at this release from local payloads, without activating a new generation. */
export async function repairOfflineExtensions(current: string, rt: UpdateRuntime, admit: () => Promise<boolean>): Promise<void> {
  const builtIns = new Set(Object.values(SEEDED_EXTENSIONS).map(entry => entry.pkg));
  const report = (pkg: string, detail: string) => rt.err(c.yellow(`Offline extension repair for ${pkg}@${current} did not finish: ${detail}`));
  let names: string[];
  try {
    names = repairNames(current, rt, builtIns);
  } catch (error) {
    rt.err(c.yellow(`Offline extension repair did not finish: ${message(error)}`));
    return;
  }
  if (!names.length) return;
  if (!await admit()) {
    for (const pkg of names) report(pkg, "continuity or installation checks did not permit changes.");
    return;
  }
  const release: (() => void)[] = [];
  try {
    // Same order as the online reconcile: closure, then the reconcile lock, then the mutation lock.
    // The mutation claim counts the closure it finds already held. A lock that cannot be had is one line.
    release.push(claimUpdateClosureAccess());
    release.push(acquireReconcileLock().release);
    release.push(claimExtensionMutationLock());
    const seeded = stagedSeedRepairs(current, rt, report);
    for (const request of seeded) {
      try {
        await installExtensionSet([request], line => rt.err(line), { offline: true });
      } catch (error) {
        if (error instanceof ExtensionAddInterrupted) throw error;
        report(request.pkg, message(error));
      }
    }
    for (const request of operatorRepairs(current, rt, builtIns)) {
      try {
        await installExtensionSet([request], line => rt.err(line), { offline: true });
      } catch (error) {
        if (error instanceof ExtensionAddInterrupted) throw error;
        report(request.pkg, message(error));
      }
    }
  } catch (error) {
    if (error instanceof ExtensionAddInterrupted) throw error;
    report("extensions", message(error));
  } finally {
    for (const unlock of release.reverse()) unlock();
  }
}

/** Packages a repair would touch. This reads the installed copies and writes nothing.
 *  One built-in that cannot be read is named and skipped. The others are still listed. */
function repairNames(current: string, rt: UpdateRuntime, builtIns: ReadonlySet<string>): string[] {
  const entries = rt.extensions();
  const seeded = SEED_BUILTINS.flatMap(name => {
    const pkg = SEEDED_EXTENSIONS[name].pkg;
    const entry = entries.find(item => item.pkg === pkg);
    if (entry === undefined) return [];
    try {
      return bundledInstallTorn(pkg, entry, current) ? [pkg] : [];
    } catch (error) {
      rt.err(c.yellow(`Offline extension repair for ${pkg}@${current} did not finish: ${message(error)}`));
      return [];
    }
  });
  const operators = entries.flatMap(entry => offlineNpmRepair(entry, current, builtIns) ? [entry.pkg] : []);
  return [...seeded, ...operators];
}

/** Copy each torn built-in's shipped payload and return its install request. One missing payload does not stop the others. */
function stagedSeedRepairs(current: string, rt: UpdateRuntime, report: (pkg: string, detail: string) => void): ExtensionInstallRequest[] {
  const entries = rt.extensions();
  return SEED_BUILTINS.flatMap(name => {
    const pkg = SEEDED_EXTENSIONS[name].pkg;
    const entry = entries.find(item => item.pkg === pkg);
    if (entry === undefined || !bundledInstallTorn(pkg, entry, current)) return [];
    try {
      return [{ pkg, version: current, spec: stageSeedPayload(current, name, { force: true }), source: "seeded" as const }];
    } catch (error) {
      report(pkg, message(error));
      return [];
    }
  });
}

/** First-party npm extensions recorded at this release whose install is not the one npm would restore. */
function operatorRepairs(current: string, rt: UpdateRuntime, builtIns: ReadonlySet<string>): ExtensionInstallRequest[] {
  return rt.extensions().flatMap(entry => offlineNpmRepair(entry, current, builtIns)
    ? [{ pkg: entry.pkg, version: current, spec: `${entry.pkg}@${current}` }] : []);
}

/** A recorded built-in at this release whose package or entry file is not usable.
 *  A permission error is not damage: the online install check reports that the same way. */
function bundledInstallTorn(pkg: string, entry: InstalledExtension, current: string): boolean {
  if (entry.version !== current) return false;
  let installed: ReturnType<typeof installedExtensionPackage>;
  try {
    installed = installedExtensionPackage(pkg);
  } catch (error) {
    if (error instanceof CorruptExtensionPackageError) return true;
    throw error;
  }
  if (!installed || installed.version !== current) return true;
  const file = statSync(resolveExtensionEntry(extensionPackageDir(pkg), installed), { throwIfNoEntry: false });
  return !file?.isFile() || file.size === 0;
}

/** A path spec keeps its own source. A missing spec or a tag or range installs `pkg@version` from the cache. */
function offlineNpmRepair(entry: InstalledExtension, current: string, builtIns: ReadonlySet<string>): boolean {
  if (!entry.pkg.startsWith("@cotal-ai/") || builtIns.has(entry.pkg) || entry.version !== current) return false;
  if (typeof entry.spec === "string" && isExtensionPathSpec(entry.spec)) return false;
  return operatorInstallDiffers({ ...entry, spec: `${entry.pkg}@${current}` }, current) !== undefined;
}
