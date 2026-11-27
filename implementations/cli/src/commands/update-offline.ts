import { statSync } from "node:fs";
import {
  claimExtensionMutationLock,
  extensionPackageDir,
  installedExtensionPackage,
  isExtensionPathSpec,
  resolveExtensionEntry,
  SEEDED_EXTENSIONS,
  type InstalledExtension,
} from "@cotal-ai/workspace";
import { SEED_BUILTINS } from "../seed/paths.js";
import { operatorInstallDiffers } from "../seed/verify.js";
import { stageSeedPayload } from "../seed/store.js";
import { c } from "../ui.js";
import { installExtensionSet, type ExtensionInstallRequest } from "./ext.js";
import { message } from "./update-process.js";
import type { UpdateRuntime } from "./update.js";

/** Repair installed packages at this release from local payloads, without activating a new generation. */
export async function repairOfflineExtensions(current: string, rt: UpdateRuntime, admit: () => Promise<boolean>): Promise<void> {
  const builtIns = new Set(Object.values(SEEDED_EXTENSIONS).map(entry => entry.pkg));
  const repairs = (): ExtensionInstallRequest[] => {
    const seeded = seededRepairs(current, rt);
    const operators = rt.extensions().flatMap(entry => offlineNpmRepair(entry, current, builtIns)
      ? [{ pkg: entry.pkg, version: current, spec: `${entry.pkg}@${current}` }] : []);
    return [...seeded, ...operators];
  };
  let packages: string | undefined;
  const report = (detail: string) => rt.err(c.yellow(`Offline extension repair${packages ? ` for ${packages}` : ""} did not finish: ${detail}`));
  try {
    let requests = repairs();
    if (!requests.length) return;
    packages = requests.map(entry => `${entry.pkg}@${entry.version}`).join(", ");
    if (!await admit()) return report("continuity or installation checks did not permit changes.");
    const release = claimExtensionMutationLock();
    try {
      requests = repairs();
      if (!requests.length) return;
      packages = requests.map(entry => `${entry.pkg}@${entry.version}`).join(", ");
      await installExtensionSet(requests, line => rt.err(line), { offline: true });
    } finally { release(); }
  } catch (error) { report(message(error)); }
}

/** Bundled built-ins recorded at this release whose installed copy is missing or has no entry file. */
function seededRepairs(current: string, rt: UpdateRuntime): ExtensionInstallRequest[] {
  const entries = rt.extensions();
  return SEED_BUILTINS.flatMap(name => {
    const pkg = SEEDED_EXTENSIONS[name].pkg;
    const entry = entries.find(item => item.pkg === pkg);
    if (entry === undefined || !bundledInstallTorn(pkg, entry, current)) return [];
    return [{ pkg, version: current, spec: stageSeedPayload(current, name), source: "seeded" as const }];
  });
}

/** A recorded built-in at this release whose package or entry file is not usable. */
function bundledInstallTorn(pkg: string, entry: InstalledExtension, current: string): boolean {
  if (entry.version !== current) return false;
  try {
    const installed = installedExtensionPackage(pkg);
    if (!installed || installed.version !== current) return true;
    const file = statSync(resolveExtensionEntry(extensionPackageDir(pkg), installed), { throwIfNoEntry: false });
    return !file?.isFile() || file.size === 0;
  } catch {
    return true;
  }
}

/** A first-party npm extension recorded at this release whose install is not the one npm would restore.
 *  A path spec keeps its own source. A missing spec or a tag or range installs `pkg@version` from the cache. */
function offlineNpmRepair(entry: InstalledExtension, current: string, builtIns: ReadonlySet<string>): boolean {
  if (!entry.pkg.startsWith("@cotal-ai/") || builtIns.has(entry.pkg) || entry.version !== current) return false;
  if (typeof entry.spec === "string" && isExtensionPathSpec(entry.spec)) return false;
  return operatorInstallDiffers({ ...entry, spec: `${entry.pkg}@${current}` }, current) !== undefined;
}
