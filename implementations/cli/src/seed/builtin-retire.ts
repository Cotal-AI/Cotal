import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { BUILT_IN_PACKAGES, extensionNpmMutationPath, extensionPackageDir, extensionsDir, isCommandFailure, loadExtensionsManifest, oneLine, saveExtensionsManifest, type InstalledExtension } from "@cotal-ai/workspace";
import { assertExtensionServiceInstancesStopped } from "../lib/service-instances.js";
import { readJsonFile, seedDir, writeJsonAtomic } from "./paths.js";

type Pending = Record<string, string | null>;
type Dependencies = Record<string, string>;
type PackageFile = { dependencies?: Dependencies; packages?: Record<string, { dependencies?: Dependencies; resolved?: string }> };
const pendingPath = () => join(seedDir(), "builtin-retire.json");

function pendingRetirements(): Pending {
  const data = readJsonFile<Pending>(pendingPath());
  if (data === undefined) return {};
  if (!data || typeof data !== "object" || Array.isArray(data) || Object.entries(data).some(([pkg, spec]) =>
    !Object.hasOwn(BUILT_IN_PACKAGES, pkg) || spec !== null && typeof spec !== "string")) throw new Error("invalid built-in retirement record");
  return data;
}

/** Keep the original store payload even when npm no longer records the path. */
export function builtInRetirementSpecs(): (string | undefined)[] {
  try { return Object.values(pendingRetirements()).map((spec) => spec ?? undefined); }
  catch { return [undefined]; }
}

function prefixPackages(prefix: string) {
  const pkg = readJsonFile<PackageFile>(join(prefix, "package.json"));
  const lock = readJsonFile<PackageFile>(join(prefix, "package-lock.json"));
  return (name: string): { present: boolean; spec?: string } => {
    const node = lock?.packages?.[`node_modules/${name}`];
    const spec = pkg?.dependencies?.[name] ?? lock?.packages?.[""]?.dependencies?.[name] ?? node?.resolved;
    return { present: spec !== undefined || node !== undefined || existsSync(extensionPackageDir(name)), spec };
  };
}

function hasLiveInstances(pkg: string): boolean {
  try { assertExtensionServiceInstancesStopped(pkg); return false; }
  catch (error) {
    if (isCommandFailure(error) && error.code === "LIFECYCLE_BLOCKED") return true;
    throw error;
  }
}

/** The next boot must retry packages without a liveness-protected pending record. */
export function builtInRetirementsCurrent(): boolean {
  try {
    if (loadExtensionsManifest().extensions.some((entry) => Object.hasOwn(BUILT_IN_PACKAGES, entry.pkg))) return false;
    const pending = pendingRetirements();
    const installed = prefixPackages(extensionsDir());
    return Object.keys(BUILT_IN_PACKAGES).every((pkg) => {
      if (!installed(pkg).present) return !Object.hasOwn(pending, pkg);
      return Object.hasOwn(pending, pkg) && hasLiveInstances(pkg);
    });
  } catch { return false; }
}

/** Called under the reconcile and prefix writer locks. Never stop a service or fail seed on a removal. */
export async function retireBuiltInPackages(note = console.error): Promise<void> {
  try {
    const prefix = extensionsDir();
    const installed = prefixPackages(prefix);
    const pending = pendingRetirements();
    const next: Pending = {};
    const manifest = loadExtensionsManifest();
    const retained: InstalledExtension[] = [...manifest.extensions];
    for (const pkg of Object.keys(BUILT_IN_PACKAGES)) {
      const index = retained.findIndex((entry) => entry.pkg === pkg);
      const disk = installed(pkg);
      if (!disk.present && index < 0) continue;
      try {
        if (hasLiveInstances(pkg)) next[pkg] = retained[index]?.spec ?? pending[pkg] ?? disk.spec ?? null;
        else if (disk.present) {
          const { runExtensionNpm } = await import("../commands/ext.js");
          const result = await runExtensionNpm(["remove", "--offline", "--update-notifier=false", "--no-audit", "--no-fund", "--ignore-scripts", "--install-links", pkg], prefix);
          if (result.status !== 0) throw new Error(result.output.split(/\r?\n/).find(Boolean) || `npm exited ${result.status}`);
        }
        if (index >= 0) retained.splice(index, 1);
      } catch (error) {
        if (Object.hasOwn(pending, pkg)) next[pkg] = pending[pkg]!;
        note(`Could not retire built-in package ${pkg}: ${oneLine(error instanceof Error ? error.message : String(error))}`);
        if (existsSync(extensionNpmMutationPath())) return;
      }
    }
    if (Object.keys(next).length) {
      if (JSON.stringify(next) !== JSON.stringify(pending)) writeJsonAtomic(pendingPath(), next);
    } else rmSync(pendingPath(), { force: true });
    if (retained.length !== manifest.extensions.length) saveExtensionsManifest({ extensions: retained });
  } catch (error) {
    note(`Could not check built-in package retirement: ${oneLine(error instanceof Error ? error.message : String(error))}`);
  }
}
