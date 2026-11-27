import { existsSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { commitPlugin, registry, stagePlugin, type Extension, type ExtensionRef } from "@cotal-ai/core";
import {
  extensionPackageDir,
  extensionProvides,
  extensionReinstallAdvice,
  hostPackageDir,
  installedExtensionPackage,
  loadExtensionsManifest,
  type InstalledExtension,
  type InstalledExtensionPackage,
} from "./extensions.js";
import { claimExtensionMutationLockAsync } from "./extension-mutation.js";
import { SEEDED_EXTENSIONS } from "./official-connectors.js";
import { connectorConfigDir } from "./connector-retention.js";
import { matchesInstalledPluginDeclaration, readPluginDeclaration, samePluginDeclaration } from "./plugin-declaration.js";
import { checkPluginCore } from "./plugin-core.js";
import { pluginDeclaration } from "./plugin-manifest.js";
import { BUILT_IN_PACKAGES } from "./built-in-packages.js";

/** Whether this process is running from the desktop app's bundled runtime (`desktop-runtime.json`). */
export function isBundledDesktopRuntime(): boolean {
  try {
    let dir = hostPackageDir("@cotal-ai/workspace");
    for (let i = 0; i < 4; i++) {
      if (existsSync(join(dir, "desktop-runtime.json"))) return true;
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  } catch { /* Non-installed host or unresolvable peer root is not a bundled desktop runtime. */ }
  return false;
}

/** Select the first entry matching the Node ESM conditions in declaration order. */
function conditionalEntry(target: unknown): string | undefined {
  if (typeof target === "string") return target;
  if (!target || typeof target !== "object" || Array.isArray(target)) return undefined;
  for (const [condition, value] of Object.entries(target)) {
    if (condition !== "node" && condition !== "import" && condition !== "default") continue;
    const entry = conditionalEntry(value);
    if (entry !== undefined) return entry;
  }
  return undefined;
}

/** Select the package's explicit export, if it has one. */
function exportedEntry(meta: InstalledExtensionPackage): string | undefined {
  const exports = meta.exports;
  if (exports && typeof exports === "object" && Object.keys(exports).some((key) => key.startsWith("."))) {
    return conditionalEntry((exports as Record<string, unknown>)["."]);
  }
  return conditionalEntry(exports);
}

/**
 * Resolve the entry for both on-disk checks and import. Node allows `main` to omit the file
 * extension. Directory entries use their own main or index file. Keep the declared path when
 * neither resolves so the caller can report it as missing or unimportable.
 */
export function resolveExtensionEntry(dir: string, meta: InstalledExtensionPackage): string {
  const exported = exportedEntry(meta);
  const path = join(dir, exported ?? meta.main ?? "index.js");
  const entry = statSync(path, { throwIfNoEntry: false });
  if (entry && !entry.isDirectory()) return path;
  if (!entry && (exported !== undefined || meta.main === undefined)) return path;
  try {
    return createRequire(join(dir, "package.json")).resolve(path);
  } catch {
    return path;
  }
}

/** Serialize staging and validation so concurrent loads do not interleave registry writes. */
let loadChain: Promise<void> = Promise.resolve();

function enqueueLoad(load: () => Promise<void>): Promise<void> {
  const run = loadChain.then(load);
  loadChain = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

/** How long a load queues behind another process's live extension locks before refusing, in total for
 *  the pass and writer locks together. Another CLI process mid-install/load holds them for seconds, not
 *  minutes; a bounded wait lets this load follow it instead of failing a command that would have
 *  succeeded a moment later. The wait is asynchronous so the caller's event loop keeps running. */
const EXTENSION_LOCK_WAIT_MS = 5_000;

async function withExtensionLock(load: () => Promise<void>): Promise<void> {
  const release = await claimExtensionMutationLockAsync({
    label: "extension materialization",
    waitMs: EXTENSION_LOCK_WAIT_MS,
    timeoutMessage: (pid) => `extension install/remove is in progress (pid ${pid}) - retry after the active \`cotal ext\` command finishes`,
  });
  try {
    await load();
  } finally {
    release();
  }
}

/**
 * Verify the pin, resolve the entry, and import the package TRANSACTIONALLY and INVISIBLY. The
 * factory's registrations stay private until they agree with the declaration and installed inventory.
 */
export async function importInstalledExtension(ext: InstalledExtension, advertised: ExtensionRef): Promise<void> {
  return enqueueLoad(() => withExtensionLock(async () => {
    const entries = loadExtensionsManifest().extensions;
    reconcileExtensionScopes(entries);
    const current = entries.find((entry) => entry.pkg === ext.pkg);
    if (!current || !sameInstall(current, ext))
      throw new Error(`extension ${ext.pkg} changed while the command was selected; retry the command`);
    await loadOne(current, advertised);
  }));
}

const loadedPlugins = new Map<string, { entry: InstalledExtension; scope?: { dispose(): void }; invalidImport?: Error }>();

function sameInstall(a: InstalledExtension, b: InstalledExtension): boolean {
  return a.version === b.version && a.installId === b.installId;
}

/** Dispose scopes whose published manifest entry has changed, without taking the writer lock. */
export function reconcileExtensionScopes(entries?: readonly InstalledExtension[]): boolean {
  if (!loadedPlugins.size) return false;
  const snapshot = entries ?? loadExtensionsManifest().extensions;
  const journal = join(connectorConfigDir(), ".extensions-promotion.json");
  if (!snapshot.length && existsSync(journal)) return false;
  const installed = new Map(snapshot.map((item) => [item.pkg, item]));
  let changed = false;
  for (const [pkg, loaded] of loadedPlugins) {
    const current = installed.get(pkg);
    if (!loaded.scope || (current && sameInstall(current, loaded.entry))) continue;
    loaded.scope.dispose();
    loaded.scope = undefined;
    changed = true;
  }
  return changed;
}

/** Why an already imported package cannot be activated at the manifest's current install ID. */
export function extensionRestartReason(entry: InstalledExtension, manager = false): string | undefined {
  const loaded = loadedPlugins.get(entry.pkg);
  if (!loaded || sameInstall(loaded.entry, entry)) return undefined;
  return manager
    ? `installed ${entry.pkg}@${entry.version}, this Manager loaded ${loaded.entry.version}; stop its seats and restart the Manager to use that plugin`
    : `installed ${entry.pkg}@${entry.version}, this process loaded ${loaded.entry.version}; restart the process to use that plugin`;
}

async function loadFactory(ext: InstalledExtension, onDisk: InstalledExtensionPackage, advertised: ExtensionRef): Promise<void> {
  const { pkg } = ext;
  const entry = resolveExtensionEntry(extensionPackageDir(pkg), onDisk);
  const declared = readPluginDeclaration(onDisk.cotal);
  if (!matchesInstalledPluginDeclaration(declared, ext))
    throw new Error(`the plugin declaration does not match the installed manifest. ${extensionReinstallAdvice(ext)}`);
  checkPluginCore(pkg, onDisk, declared, entry);
  // Record any attempted import. Node can retain evaluated dependencies even when an entry throws.
  const loaded = loadedPlugins.get(pkg) ?? { entry: ext };
  loadedPlugins.set(pkg, loaded);
  if (loaded.invalidImport) throw loaded.invalidImport;
  const imported = await registry.runStaged(() => import(pathToFileURL(entry).href)).catch((error: unknown) => {
    throw new Error(`failed to import: ${error instanceof Error ? error.message : String(error)} - ${extensionReinstallAdvice(ext)}`, { cause: error });
  });
  const { value: { default: factory }, staged: importWrites } = imported;
  if (importWrites.length) {
    loaded.invalidImport = new Error("the plugin entry registered outside its factory");
    throw loaded.invalidImport;
  }
  if (typeof factory !== "function") throw new Error("the plugin entry must export a default factory");
  const staged = await stagePlugin(registry, factory);
  const actual = pluginDeclaration(staged, declared.core);
  if (!samePluginDeclaration(actual, declared) || !declared.provides.some((item) => item.kind === advertised.kind && item.name === advertised.name))
    throw new Error(`the plugin factory does not match its cotal declaration. ${extensionReinstallAdvice(ext)}`);
  loaded.scope = commitPlugin(registry, staged);
}

async function loadOne(ext: InstalledExtension, advertised: ExtensionRef, manager = false): Promise<void> {
  // A successful factory publishes its complete scope. Reuse it for any sibling provider.
  const pkg = ext.pkg;
  const restart = extensionRestartReason(ext, manager);
  if (restart) throw new Error(restart);
  if (registry.has(advertised.kind, advertised.name)) return;
  const onDisk = installedExtensionPackage(pkg);
  if (!onDisk) {
    throw new Error(`extension ${pkg} is in the manifest but not installed at ${extensionPackageDir(pkg)} - ${extensionReinstallAdvice(ext)}`);
  }
  if (onDisk.version !== ext.version) {
    throw new Error(
      `extension ${pkg} is ${onDisk.version} on disk but the manifest pinned ${ext.version} (its cached command surface may be stale). ${extensionReinstallAdvice(ext)}`,
    );
  }
  if (onDisk.cotal === undefined) {
    const remedy = pkg.startsWith("@cotal-ai/") ? extensionReinstallAdvice(ext) : `run \`cotal ext add ${pkg}@latest\`, or \`cotal ext remove ${pkg}\` to remove it`;
    throw new Error(`extension ${pkg}@${ext.version} was built for the old contract. ${remedy}`);
  }
  try { await loadFactory(ext, onDisk, advertised); }
  catch (error) { throw new Error(`extension ${pkg}@${ext.version}: ${(error as Error).message}`, { cause: error }); }
}

/**
 * Names an extension of `kind` is available under from the installed MANIFEST alone — no import, no
 * CLI process state. The manager and the seeding engine read this directly (the CLI's own
 * `extensionNames` additionally folds in registered names behind its `installedEnabled` gate). A
 * spawn/models path gating on this honors a live `cotal ext remove`, since a removed connector
 * leaves the manifest even while an earlier import keeps it in the registry.
 */
export function manifestExtensionNames(kind: string): string[] {
  const names = new Set<string>();
  for (const ext of loadExtensionsManifest().extensions.filter((entry) => !Object.hasOwn(BUILT_IN_PACKAGES, entry.pkg)))
    for (const ref of extensionProvides(ext)) if (ref.kind === kind) names.add(ref.name);
  return [...names].sort();
}

/**
 * Resolve a provider from the installed manifest, importing the package that advertised it. The
 * "already registered" short-circuit and any composition-root gating stay with the caller — this
 * ALWAYS consults the machine manifest. `hint(ref)` phrases the not-found error (the CLI names the
 * exact `cotal ext add <pkg>` for an official name; a bare caller gets the generic form).
 * `expectedGeneration` checks first-party manifest pins under the extension lock, even on a cache hit.
 */
export async function materializeFromManifest<T extends Extension = Extension>(
  ref: ExtensionRef,
  opts: { hint?: (ref: ExtensionRef) => string; expectedGeneration?: string } = {},
): Promise<T> {
  await enqueueLoad(() =>
    withExtensionLock(async () => {
      const extensions = loadExtensionsManifest().extensions;
      reconcileExtensionScopes(extensions);
      const ext = extensions.find((candidate) =>
        !Object.hasOwn(BUILT_IN_PACKAGES, candidate.pkg) && extensionProvides(candidate).some((provided) => provided.kind === ref.kind && provided.name === ref.name),
      );
      if (!ext) {
        throw new Error(
          opts.hint?.(ref) ?? `no installed extension provides ${ref.kind} "${ref.name}" - install it with \`cotal ext add <npm-package>\``,
        );
      }
      if (opts.expectedGeneration !== undefined && ext.pkg.startsWith("@cotal-ai/") && ext.version !== opts.expectedGeneration) {
        const seeded = Object.values(SEEDED_EXTENSIONS).some((item) => item.pkg === ext.pkg);
        throw new Error(
          seeded
            ? `connector ${ext.pkg}@${ext.version} differs from this Manager's loaded generation ${opts.expectedGeneration}; stop its seats and restart the Manager from the installed CLI before launching new agents`
            : isBundledDesktopRuntime()
              ? `this Cotal app runs ${opts.expectedGeneration}, and another Cotal install on this account moved the shared extension ${ext.pkg} to ${ext.version}`
              : `extension ${ext.pkg}@${ext.version} differs from this Manager's loaded generation ${opts.expectedGeneration}; run \`cotal update --self\` to reconcile this installation, then stop its seats and restart the Manager from the installed CLI`,
        );
      }
      await loadOne(ext, ref, opts.expectedGeneration !== undefined);
    }),
  );
  return registry.resolve<T>(ref.kind, ref.name);
}
