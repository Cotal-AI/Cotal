import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Command, Extension, ExtensionRef, FlagSpec } from "@cotal-ai/core";
import { globalConfigDir } from "@cotal-ai/core";
import { localProcessPath, type LocalProcess } from "./local-process.js";

/**
 * Operator-installed extensions (`cotal ext add <npm-package>`): the workstation state.
 *
 * Extensions install into a cotal-owned npm prefix (`$XDG_CONFIG_HOME/cotal/extensions/`, with
 * its own package.json) — never the user's project. A MANIFEST records each installed package
 * plus a cache of every registry key it contributed and display metadata for commands. Two hard
 * rules from the design review:
 *
 *  - Cached command specs are DISPLAY/TAB ONLY: dispatch uses the freshly imported command's live
 *    grammar. Local-process metadata is deliberately declarative and operational, so lifecycle
 *    commands can act without importing third-party code.
 *  - `name@version` is pinned at add time and verified at run-import; a mismatch is a loud error
 *    prescribing `cotal ext add` again — never a silent re-cache.
 */

/** One cached command: the JSON-serializable display surface of a {@link Command} (its `run` /
 *  `complete` functions stay in the package — the cache can render help and offer flag names,
 *  nothing more). */
export interface CachedCommand {
  readonly name: string;
  readonly summary: string;
  readonly group?: string;
  readonly usage?: string;
  readonly hidden?: boolean;
  readonly flags?: readonly FlagSpec[];
  readonly positionals?: string;
}

export interface InstalledExtension {
  /** The npm package name (the import + `node_modules` key). */
  readonly pkg: string;
  /** Exact installed version, pinned at add time and verified at run-import. */
  readonly version: string;
  /** The spec the operator passed to `ext add` (registry range, file:, tarball…) — for re-adds. */
  readonly spec: string;
  /** `"seeded"` iff installed by the built-in-connector reconcile (not an operator `ext add`). Keys
   *  refresh-gating and import-failure hints on the marker rather than trusting the spec path. */
  readonly source?: "seeded";
  /** Every registry contribution made by the package. Older command-only manifests omit this; the
   *  loader derives `command:<name>` entries from `commands` for compatibility. */
  readonly provides?: readonly ExtensionRef[];
  readonly commands: readonly CachedCommand[];
  /** Declarative process metadata used without importing package code. */
  readonly localProcesses?: readonly LocalProcess[];
}

export interface ExtensionsManifest {
  readonly extensions: readonly InstalledExtension[];
}

/** The extensions prefix: `<config>/cotal/extensions` — its own npm installation root. */
export function extensionsDir(): string {
  return join(globalConfigDir(), "extensions");
}

export function extensionsManifestPath(): string {
  return join(extensionsDir(), "extensions.json");
}

export function extensionMutationLockPath(): string {
  return join(dirname(extensionsDir()), ".extensions.lock");
}

export type ExtensionMutationLockState =
  | { readonly state: "absent" | "stale" }
  | { readonly state: "active"; readonly owner: number };

/** Inspect the extension-prefix writer lock. Permission denial means the owner may still be live;
 * only ESRCH proves that a recorded owner is gone. */
export function extensionMutationLockState(): ExtensionMutationLockState {
  const lock = extensionMutationLockPath();
  let raw: string;
  try {
    raw = readFileSync(lock, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return { state: "absent" };
    throw new Error(`can't read extension mutation lock ${lock}: ${(e as Error).message}`);
  }

  const owner = Number(raw.trim());
  if (!Number.isInteger(owner) || owner <= 0) return { state: "stale" };
  try {
    process.kill(owner, 0);
    return { state: "active", owner };
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "ESRCH") return { state: "stale" };
    if (code === "EPERM") return { state: "active", owner };
    throw new Error(`can't check extension mutation lock owner ${owner}: ${(e as Error).message}`);
  }
}

/** Load the manifest. Missing file → no extensions. A CORRUPT file is a loud error (never treat
 *  installed extensions as absent — commands would silently vanish from help). */
export function loadExtensionsManifest(): ExtensionsManifest {
  const p = extensionsManifestPath();
  if (!existsSync(p)) return { extensions: [] };
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(p, "utf8"));
  } catch (e) {
    throw new Error(`corrupt extensions manifest ${p}: ${(e as Error).message} - fix or delete it, then \`cotal ext add\` again`);
  }
  const m = parsed as ExtensionsManifest;
  if (!Array.isArray(m.extensions)) throw new Error(`corrupt extensions manifest ${p}: no "extensions" array`);
  return m;
}

export function saveExtensionsManifest(m: ExtensionsManifest): void {
  mkdirSync(extensionsDir(), { recursive: true });
  writeFileSync(extensionsManifestPath(), `${JSON.stringify(m, null, 2)}\n`);
}

/** Strip a live {@link Command} down to its serializable display surface for the cache. */
export function cacheCommand(cmd: Command): CachedCommand {
  return {
    name: cmd.name,
    summary: cmd.summary,
    group: cmd.group,
    usage: cmd.usage,
    hidden: cmd.hidden,
    flags: cmd.flags,
    positionals: cmd.positionals,
  };
}

/** Stable, serializable registry keys contributed by one imported package. */
export function cacheExtension(ext: Extension): ExtensionRef {
  return { kind: ext.kind, name: ext.name };
}

export function cacheLocalProcess(component: LocalProcess): LocalProcess {
  if (typeof component.pidFile !== "string") throw new Error(`local-process ${component.name} must declare a string pidFile template`);
  localProcessPath(component.pidFile, { root: process.cwd(), space: "validation" });
  for (const artifact of component.artifacts ?? []) {
    if (typeof artifact !== "string") throw new Error(`local-process ${component.name} artifacts must be string templates`);
    localProcessPath(artifact, { root: process.cwd(), space: "validation" });
  }
  return {
    kind: "local-process",
    name: component.name,
    label: component.label,
    order: component.order,
    pidFile: component.pidFile,
    artifacts: component.artifacts,
    stopLast: component.stopLast,
    clearsMesh: component.clearsMesh,
    visibleWhen: component.visibleWhen,
  };
}

export function extensionLocalProcesses(ext: InstalledExtension): readonly LocalProcess[] {
  return ext.localProcesses ?? [];
}

/** Registry contributions recorded for an installed package, including old command-only entries. */
export function extensionProvides(ext: InstalledExtension): readonly ExtensionRef[] {
  return ext.provides ?? ext.commands.map((command) => ({ kind: "command", name: command.name }));
}

/** The installed package's on-disk root inside the prefix. */
export function extensionPackageDir(pkg: string): string {
  return join(extensionsDir(), "node_modules", pkg);
}

/** The installed package's CURRENT version, read from disk (undefined when not installed). */
export function installedExtensionVersion(pkg: string): string | undefined {
  const p = join(extensionPackageDir(pkg), "package.json");
  if (!existsSync(p)) return undefined;
  const v = (JSON.parse(readFileSync(p, "utf8")) as { version?: string }).version;
  return typeof v === "string" ? v : undefined;
}
