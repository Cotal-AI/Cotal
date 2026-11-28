import { closeSync, openSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  CorruptExtensionPackageError,
  claimExtensionMutationLock,
  claimUpdateClosureAccess,
  extensionMutationLockPath,
  inspectLock,
  extensionPackageDir,
  installedExtensionPackage,
  isExtensionPathSpec,
  resolveExtensionEntry,
  SEEDED_EXTENSIONS,
  extensionsDir,
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
  if (!await admit()) return finishRefused(current, rt, builtIns, report);
  const release: (() => void)[] = [];
  try {
    // Same order as the online reconcile: closure, then the reconcile lock, then the mutation lock.
    // The mutation claim counts the closure it finds already held. A lock that cannot be had is one line.
    release.push(claimUpdateClosureAccess());
    release.push(acquireReconcileLock().release);
    if (inspectLock(extensionMutationLockPath()).state === "active") rt.err("another extension mutation is in progress");
    release.push(claimExtensionMutationLock({
      waitMs: 300000,
      timeoutMessage: (pid) => `another extension mutation has held the lock for over 5 minutes (pid ${pid}) - retry once it finishes`,
      label: "an extension mutation",
    }));
    // The stage copy reads the whole prefix, and it skips a file it cannot read. Name that package
    // here, because the install that follows only reports the package it was asked to add.
    for (const pkg of installedPackages()) {
      const unread = unreadablePackage(pkg);
      if (unread !== undefined) report(pkg, message(unread));
    }
    for (const name of SEED_BUILTINS) {
      const pkg = SEEDED_EXTENSIONS[name].pkg;
      let request: ExtensionInstallRequest | undefined;
      try {
        request = stagedSeedRepair(current, rt, report, name);
      } catch (error) {
        if (error instanceof ExtensionAddInterrupted) throw error;
        report(pkg, message(error));
        continue;
      }
      if (request === undefined) continue;
      try {
        await installExtensionSet([request], line => rt.err(line), { offline: true });
      } catch (error) {
        if (error instanceof ExtensionAddInterrupted) throw error;
        report(request.pkg, message(error));
      }
    }
    // Admission is checked again after the built-ins. A healthy operator is not named for a refusal that came too late for it.
    if (!await admit()) {
      finishRefused(current, rt, builtIns, report);
    } else {
      for (const request of operatorRepairs(current, rt, builtIns)) {
        try {
          await installExtensionSet([request], line => rt.err(line), { offline: true });
        } catch (error) {
          if (error instanceof ExtensionAddInterrupted) throw error;
          report(request.pkg, message(error));
        }
      }
    }
  } catch (error) {
    if (error instanceof ExtensionAddInterrupted) throw error;
    report("extensions", message(error));
  } finally {
    for (const unlock of release.reverse()) unlock();
  }
}

/** Name what is still unhealthy when admission refuses. The first read can include a package the built-in repair has since restored. */
function finishRefused(current: string, rt: UpdateRuntime, builtIns: ReadonlySet<string>, report: (pkg: string, detail: string) => void): void {
  for (const pkg of repairNames(current, rt, builtIns)) report(pkg, "continuity or installation checks did not permit changes.");
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

/** Copy one torn built-in's shipped payload and return its install request. A missing payload or a package that cannot be read is named and does not stop the others. */
function stagedSeedRepair(current: string, rt: UpdateRuntime, report: (pkg: string, detail: string) => void, name: string): ExtensionInstallRequest | undefined {
  const pkg = SEEDED_EXTENSIONS[name].pkg;
  const entry = rt.extensions().find(item => item.pkg === pkg);
  if (entry === undefined) return undefined;
  try {
    // A package that cannot be read throws here. Catching it keeps the other built-ins and the operator repairs going.
    if (!bundledInstallTorn(pkg, entry, current)) return undefined;
    return { pkg, version: current, spec: stageSeedPayload(current, name, { force: true }), source: "seeded" as const };
  } catch (error) {
    report(pkg, message(error));
    return undefined;
  }
}

/** Package directories under the extensions prefix. A directory that cannot be listed is itself unreadable. */
function installedPackages(): string[] {
  const root = join(extensionsDir(), "node_modules");
  const scope = (dir: string, prefix: string): string[] => {
    let names: string[];
    try { names = readdirSync(dir); }
    catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT") return [];
      throw error;
    }
    return names.flatMap(name => name.startsWith("@") && prefix === ""
      ? scope(join(dir, name), `${name}/`)
      : [`${prefix}${name}`]);
  };
  return scope(root, "");
}

/** The first file in this package the stage copy cannot read, or undefined when the package can be staged. */
function unreadablePackage(pkg: string): NodeJS.ErrnoException | undefined {
  const visit = (path: string): NodeJS.ErrnoException | undefined => {
    let stat: ReturnType<typeof statSync>;
    try { stat = statSync(path); }
    catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT") return undefined;
      if (code === "EACCES" || code === "EPERM") return error as NodeJS.ErrnoException;
      throw error;
    }
    if (stat.isDirectory()) {
      let names: string[];
      try { names = readdirSync(path); }
      catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === "EACCES" || code === "EPERM") return error as NodeJS.ErrnoException;
        throw error;
      }
      for (const name of names) {
        const found = visit(join(path, name));
        if (found) return found;
      }
      return undefined;
    }
    // stat succeeds on a file this process cannot read. The stage copy opens it, so this does too.
    try { closeSync(openSync(path, "r")); }
    catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "EACCES" || code === "EPERM") return error as NodeJS.ErrnoException;
      throw error;
    }
    return undefined;
  };
  return visit(join(extensionsDir(), "node_modules", pkg));
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
