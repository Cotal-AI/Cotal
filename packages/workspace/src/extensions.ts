import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Command, FlagSpec } from "@cotal-ai/core";
import { globalConfigDir } from "@cotal-ai/core";

/**
 * Operator-installed CLI extensions (`cotal ext add <npm-package>`): the workstation state.
 *
 * Extensions install into a cotal-owned npm prefix (`$XDG_CONFIG_HOME/cotal/extensions/`, with
 * its own package.json) — never the user's project. A MANIFEST records each installed package
 * plus a CACHE of the command metadata it contributed. Two hard rules from the design review:
 *
 *  - The manifest is a DISPLAY/TAB cache ONLY. Help and `__complete` read it (so a <TAB> never
 *    imports an extension), but at dispatch the freshly-imported command's LIVE specs are
 *    authoritative — cached specs never drive parsing (version skew would corrupt `run`'s input).
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
  readonly commands: readonly CachedCommand[];
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

/** Load the manifest. Missing file → no extensions. A CORRUPT file is a loud error (never treat
 *  installed extensions as absent — commands would silently vanish from help). */
export function loadExtensionsManifest(): ExtensionsManifest {
  const p = extensionsManifestPath();
  if (!existsSync(p)) return { extensions: [] };
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(p, "utf8"));
  } catch (e) {
    throw new Error(`corrupt extensions manifest ${p}: ${(e as Error).message} — fix or delete it, then \`cotal ext add\` again`);
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
