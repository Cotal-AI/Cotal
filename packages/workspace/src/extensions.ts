import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Command, Extension, ExtensionRef, FlagSpec } from "@cotal-ai/core";
import { globalConfigDir } from "@cotal-ai/core";
import { inspectLock } from "./advisory-lock.js";
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

/** The extension-prefix writer lock. See {@link inspectLock} for its atomic publish/reclaim rules. */
export function extensionMutationLockPath(): string {
  return join(dirname(extensionsDir()), ".extensions.lock");
}

export type ExtensionMutationLockState =
  | { readonly state: "absent" | "stale" }
  | { readonly state: "active"; readonly owner: number };

/** Inspect the extension-prefix writer lock via the shared advisory-lock primitive (PID liveness +
 *  process-start identity + torn-record handling all decided in one place). */
export function extensionMutationLockState(): ExtensionMutationLockState {
  const found = inspectLock(extensionMutationLockPath());
  return found.state === "active" ? { state: "active", owner: found.owner.pid } : { state: found.state };
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

/** Persist the manifest atomically (temp-then-rename, exclusive temp): a SIGKILL mid-write can never
 *  truncate the live manifest into corrupt JSON that would then vanish every installed extension. */
export function saveExtensionsManifest(m: ExtensionsManifest): void {
  const dir = extensionsDir();
  mkdirSync(dir, { recursive: true });
  const path = extensionsManifestPath();
  const tmp = join(dir, `.${basename(path)}.${randomBytes(6).toString("hex")}.tmp`);
  writeFileSync(tmp, `${JSON.stringify(m, null, 2)}\n`, { flag: "wx" });
  renameSync(tmp, path);
}

/** Move a corrupt/unreadable manifest aside so a `--reset`/`--repair` can rebuild a clean one instead
 *  of wedging on the same unreadable read. Returns the quarantine path, or undefined if none existed. */
export function quarantineExtensionsManifest(): string | undefined {
  const path = extensionsManifestPath();
  if (!existsSync(path)) return undefined;
  const aside = `${path}.corrupt.${randomBytes(4).toString("hex")}`;
  renameSync(path, aside);
  return aside;
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
  if (component.rootedAt !== undefined && component.rootedAt !== "target")
    throw new Error(`local-process ${component.name} declares an unknown rootedAt ${JSON.stringify(component.rootedAt)} - only "target" is defined`);
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
    rootedAt: component.rootedAt,
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

export interface BoundExtensionPeer {
  readonly owner: string;
  readonly peer: string;
  readonly source: string;
  readonly destination: string;
}

/** Locate a shared package in this host's module graph. */
function hostPackageDir(name: string): string {
  let dir = dirname(fileURLToPath(import.meta.resolve(name)));
  for (;;) {
    const pj = join(dir, "package.json");
    if (existsSync(pj) && (JSON.parse(readFileSync(pj, "utf8")) as { name?: string }).name === name) return dir;
    const parent = dirname(dir);
    if (parent === dir) throw new Error(`couldn't locate ${name}'s package root from its resolved entry`);
    dir = parent;
  }
}

/** Bind installed extensions' shared peers to the current host. Callers must hold the extension lock. */
export function bindExtensionPeers(
  owners: readonly string[],
  operationPkg: string,
  opts: { force?: boolean } = {},
): readonly BoundExtensionPeer[] {
  const planned: BoundExtensionPeer[] = [];
  for (const owner of owners) {
    let meta: { peerDependencies?: Record<string, string> };
    try {
      meta = JSON.parse(readFileSync(join(extensionPackageDir(owner), "package.json"), "utf8"));
    } catch (e) {
      throw new Error(`${operationPkg} cannot preserve installed extension ${owner}'s shared peers: ${(e as Error).message}`);
    }
    for (const peer of Object.keys(meta.peerDependencies ?? {}).filter((name) => name.startsWith("@cotal-ai/"))) {
      let source: string;
      try {
        source = realpathSync(hostPackageDir(peer));
      } catch {
        throw new Error(`${operationPkg}: ${owner} peer-depends on ${peer}, which this cotal binary does not carry - the peer can't be linked`);
      }
      planned.push({
        owner,
        peer,
        source,
        destination: join(extensionPackageDir(owner), "node_modules", ...peer.split("/")),
      });
    }
  }

  const bound: BoundExtensionPeer[] = [];
  for (const link of planned) {
    let current: string | undefined;
    try {
      current = realpathSync(link.destination);
    } catch {
      // Missing and dangling links are both repaired below.
    }
    if (!opts.force && current === link.source) continue;
    try {
      rmSync(link.destination, { recursive: true, force: true });
      mkdirSync(dirname(link.destination), { recursive: true });
      symlinkSync(link.source, link.destination, "junction");
      if (realpathSync(link.destination) !== link.source) throw new Error("the resulting link resolves to a different package");
    } catch (e) {
      throw new Error(`${operationPkg} could not link ${link.peer} for ${link.owner}: ${(e as Error).message}`);
    }
    bound.push(link);
  }
  return bound;
}

/** The installed package's CURRENT version, read from disk (undefined when not installed). */
export function installedExtensionVersion(pkg: string): string | undefined {
  const p = join(extensionPackageDir(pkg), "package.json");
  if (!existsSync(p)) return undefined;
  const v = (JSON.parse(readFileSync(p, "utf8")) as { version?: string }).version;
  return typeof v === "string" ? v : undefined;
}
