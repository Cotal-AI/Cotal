import { closeSync, constants, existsSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { basename, dirname, isAbsolute, join } from "node:path";
import { shellPath } from "./local-record-source.js";
import { codeSpan, windowsShellWord } from "./text-wrap.js";
import { CommandFailure } from "./output.js";
import { fileURLToPath } from "node:url";
import type { Command, CommandExample, Connector, Extension, ExtensionRef, FlagSpec, HarnessInstall, OutputMode, Subcommand } from "@cotal-ai/core";
import { checkedHarnessInstall } from "./harness-install.js";
import { connectorConfigDir } from "./connector-retention.js";
import { inspectLock } from "./advisory-lock.js";
import { globalConfigDirProblem } from "./cotal-config.js";
import { canonicalLocalProcessPath, localProcessPath, type LocalProcess } from "./local-process.js";
import type { ServicePreset } from "./service-preset.js";
import { serviceAdapterDeclaration } from "./service-adapter.js";

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

/** Serializable command declarations for help, completion and read-only boot policy. The `run` and
 *  `complete` callbacks stay in their package; command arguments are parsed against the live specs. */
export interface CachedCommand {
  readonly name: string;
  readonly summary: string;
  readonly aliases?: readonly string[];
  readonly group?: string;
  readonly usage?: string;
  readonly hidden?: boolean;
  readonly flags?: readonly FlagSpec[];
  readonly flagNames?: readonly string[];
  readonly positionals?: string;
  readonly subcommands?: readonly Subcommand[];
  readonly outputs?: readonly OutputMode[];
  readonly examples?: readonly CommandExample[];
  /** The bare command opts out of connector seeding before materialization. */
  readonly reads?: true;
}

/** One registry contribution of an installed package, with the aliases it claims in its kind. */
export interface ProvidedRef extends ExtensionRef {
  readonly aliases?: readonly string[];
}

/** Connector boot metadata cached at install time so the manager can inspect harness availability
 * without importing every connector package and defeating lazy materialization. */
export interface CachedConnector {
  readonly name: string;
  readonly requires: readonly string[];
  /** Whether the connector publishes the AG-UI event plane. Cached explicitly so a manager can
   *  report the fact before importing the connector. Never inferred true from its name. */
  readonly eventPlane: boolean;
  /** Whether a session the connector launches serves its harness's tool permissions on the agent
   *  endpoint. Absent in a manifest written before this was cached, which reads as false: no launch
   *  menu offers prompts on a guess. */
  readonly prompts?: boolean;
  /** Whether the connector honors `askPermissions` and `reasoningEvents` at launch. Absent in a
   *  manifest written before these were cached, which reads as false. */
  readonly askPermissions?: boolean;
  readonly reasoningEvents?: boolean;
  /** The connector's declared setup provider, `null` when it declares none. Absent only in a
   *  manifest written before this was cached. */
  readonly setup?: ExtensionRef | null;
  /** How a person installs what `requires` names, from its maker. Absent when the connector declares
   *  none, and in a manifest written before this was cached: no app offers an install on a guess. */
  readonly install?: HarnessInstall;
}

export interface InstalledExtension {
  /** The npm package name (the import + `node_modules` key). */
  readonly pkg: string;
  /** Exact installed version, pinned at add time and verified at run-import. */
  readonly version: string;
  /** The original install spec, when recorded. */
  readonly spec?: string;
  /** `"seeded"` iff installed by the built-in-connector reconcile (not an operator `ext add`). Keys
   *  refresh-gating and import-failure hints on the marker rather than trusting the spec path. */
  readonly source?: "seeded";
  /** Every registry contribution made by the package. Older command-only manifests omit this; the
   *  loader derives `command:<name>` entries from `commands` for compatibility. */
  readonly provides?: readonly ProvidedRef[];
  readonly commands: readonly CachedCommand[];
  /** Declarative connector harness metadata used at manager boot without importing package code. */
  readonly connectors?: readonly CachedConnector[];
  /** Declarative process metadata used without importing package code. */
  readonly localProcesses?: readonly LocalProcess[];
  readonly servicePresets?: readonly ServicePreset[];
  /** Cached service declaration fingerprints, bound to the installed package metadata. */
  readonly serviceMetadata?: { readonly schemaVersion: 1; readonly packageJsonSha256: string; readonly declarationsSha256: string };
}

export interface ExtensionsManifest {
  readonly extensions: readonly InstalledExtension[];
}

/** A dot-relative or native absolute package path, including drive and UNC paths on Windows. */
export function isExtensionPathSpec(spec: string, absolute: (p: string) => boolean = isAbsolute): boolean {
  return spec.startsWith(".") || absolute(spec);
}

const FIRST_PARTY_PACKAGE = /^@cotal-ai\/[a-zA-Z0-9._~-]+$/;
const REGISTRY_SELECTOR = /^[a-z0-9._~^*<>=|+ -]+$/i;

/** Whether an inventory entry is a registry-managed first-party release package rather than a local, tarball, Git, or URL install. */
export function isReleaseExtension(entry: { readonly pkg: string; readonly source?: "seeded"; readonly spec?: unknown }): boolean {
  if (!FIRST_PARTY_PACKAGE.test(entry.pkg)) return false;
  if (entry.source === "seeded" || typeof entry.spec !== "string") return true;
  const spec = entry.spec.trim();
  if (spec === entry.pkg || spec === `${entry.pkg}@`) return true;
  const aliasTail = spec.startsWith(`${entry.pkg}@npm:${entry.pkg}`)
    ? spec.slice(`${entry.pkg}@npm:${entry.pkg}`.length)
    : spec.startsWith(`npm:${entry.pkg}`)
      ? spec.slice(`npm:${entry.pkg}`.length)
      : undefined;
  if (aliasTail !== undefined && aliasTail !== "" && !aliasTail.startsWith("@")) return false;
  const rawSelector = aliasTail !== undefined
    ? aliasTail.replace(/^@/, "").trim()
    : spec.startsWith(`${entry.pkg}@`)
      ? spec.slice(entry.pkg.length + 1).trim()
      : undefined;
  if (rawSelector === undefined) return false;
  if (!rawSelector) return true;
  return rawSelector !== "." && rawSelector !== ".." && REGISTRY_SELECTOR.test(rawSelector) && !/\.(?:tgz|tar(?:\.gz)?)$/i.test(rawSelector);
}

/** Recovery for a recorded extension. Do not echo a registry URL or opaque selector in advice. */
export function extensionReinstallAdvice(entry: InstalledExtension): string {
  if (entry.source === "seeded") return "Run `cotal ext seed --repair` to reinstall it.";
  const { spec } = entry;
  if (typeof spec !== "string" && /^@cotal-ai\/[a-zA-Z0-9._~-]+$/.test(entry.pkg)) {
    const pkg = process.platform === "win32" ? windowsShellWord(entry.pkg) : shellPath(entry.pkg);
    if (pkg) return `Run ${codeSpan(`cotal ext add ${pkg}`)} to reinstall it.`;
  }
  if (typeof spec === "string" && (isExtensionPathSpec(spec) || /^(?:@[a-z0-9._~-]+\/)?[a-z0-9._~-]+(?:@[a-z0-9._~^*<>=|+ -]+)?$/i.test(spec)))
    return `Run ${codeSpan(`cotal ext add ${shellPath(spec)}`)} to reinstall it.`;
  return `Run ${codeSpan(`cotal ext remove ${shellPath(entry.pkg)}`)} to drop the record, or reinstall with the original spec.`;
}

/** The extensions prefix: `<config>/cotal/extensions` — its own npm installation root. */
export function extensionsDir(): string {
  return join(connectorConfigDir(), "extensions");
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

export class CorruptExtensionsManifestError extends Error {
  readonly diagnosis: string;
  readonly remedy: string;

  constructor(path: string, reason: string) {
    const diagnosis = `corrupt extensions manifest ${path}: ${reason}`;
    const remedy = "run `cotal ext seed --repair` to preserve the damaged file and rebuild the built-in inventory";
    super(`${diagnosis}. ${remedy}`);
    this.diagnosis = diagnosis;
    this.remedy = remedy;
  }
}

/** Load the manifest. Missing file → no extensions, and so is a config folder that is a file, which
 *  can hold none (every command that would use that folder is refused, naming it). A CORRUPT or
 *  unreachable file is a loud error (never treat installed extensions as absent — commands would
 *  silently vanish from help). */
export function loadExtensionsManifest(): ExtensionsManifest {
  const p = extensionsManifestPath();
  let parsed: unknown;
  try {
    if (!statSync(p).isFile()) throw new Error("not a regular file");
    const fd = openSync(p, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0));
    try {
      if (!fstatSync(fd).isFile()) throw new Error("not a regular file");
      parsed = JSON.parse(readFileSync(fd, "utf8"));
    } finally {
      closeSync(fd);
    }
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "EACCES" || code === "EPERM") throw new CommandFailure("refused", "PERMISSION_DENIED", `cannot read the extensions manifest at ${p} (${code})`, {
      target: { path: p }, remedy: "restore this account's read access to the extensions manifest and its path, then retry", cause: e,
    });
    if (code === "ENOENT" && !lstatSync(p, { throwIfNoEntry: false })) return { extensions: [] };
    if (code === "ENOTDIR" && globalConfigDirProblem()) return { extensions: [] };
    throw new CorruptExtensionsManifestError(p, (e as Error).message);
  }
  const m = parsed as ExtensionsManifest | null;
  if (!Array.isArray(m?.extensions)) throw new CorruptExtensionsManifestError(p, 'no "extensions" array');
  const invalid = m.extensions.findIndex((entry) => {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) return true;
    const record = entry as { pkg?: unknown; commands?: unknown };
    return typeof record.pkg !== "string" || record.pkg.length === 0 || !Array.isArray(record.commands)
      || record.commands.some((command) => command === null || typeof command !== "object" || Array.isArray(command) || typeof (command as { name?: unknown }).name !== "string");
  });
  if (invalid !== -1) throw new CorruptExtensionsManifestError(p, `invalid extension inventory entry at index ${invalid}`);
  return m;
}

/** Persist the manifest atomically (temp-then-rename, exclusive temp): a SIGKILL mid-write can never
 *  truncate the live manifest into corrupt JSON that would then vanish every installed extension. */
export function saveExtensionsManifest(m: ExtensionsManifest): void {
  const dir = extensionsDir();
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = extensionsManifestPath();
  const tmp = join(dir, `.${basename(path)}.${randomBytes(6).toString("hex")}.tmp`);
  writeFileSync(tmp, `${JSON.stringify(m, null, 2)}\n`, { flag: "wx" });
  renameSync(tmp, path);
}

/** Move a corrupt/unreadable manifest aside so a `--reset`/`--repair` can rebuild a clean one instead
 *  of wedging on the same unreadable read. Returns the quarantine path, or undefined if none existed. */
export function quarantineExtensionsManifest(): string | undefined {
  const path = extensionsManifestPath();
  if (!lstatSync(path, { throwIfNoEntry: false })) return undefined;
  const aside = `${path}.corrupt.${randomBytes(4).toString("hex")}`;
  renameSync(path, aside);
  return aside;
}

/** Cache a command's serializable help and read-only boot declarations. */
export function cacheCommand(cmd: Command): CachedCommand {
  return {
    name: cmd.name,
    summary: cmd.summary,
    aliases: cmd.aliases,
    group: cmd.group,
    usage: cmd.usage,
    hidden: cmd.hidden,
    flags: cmd.flags,
    flagNames: cmd.flagNames,
    positionals: cmd.positionals,
    subcommands: cmd.subcommands,
    outputs: cmd.outputs,
    examples: cmd.examples,
    reads: cmd.reads,
  };
}

export function cacheConnector(connector: Connector): CachedConnector {
  return {
    name: connector.name,
    requires: [...(connector.requires ?? [])],
    eventPlane: connector.eventChannel !== undefined,
    prompts: connector.prompts === true,
    askPermissions: connector.supportsAskPermissions === true,
    reasoningEvents: connector.supportsReasoningEvents === true,
    setup: connector.setup ? { kind: connector.setup.kind, name: connector.setup.name } : null,
    ...(connector.install === undefined ? {} : { install: checkedHarnessInstall(connector.name, connector.requires ?? [], connector.install) }),
  };
}

/** True when an entry's connector metadata predates what `cacheConnector` records now: an advertised
 *  connector with no cached entry, or one cached before setup providers or event-plane facts were.
 *  Never throws. */
export function connectorMetadataStale(ext: InstalledExtension): boolean {
  return extensionProvides(ext).some((ref) => {
    if (ref.kind !== "connector") return false;
    const connector = ext.connectors?.find((candidate) => candidate.name === ref.name);
    return connector?.setup === undefined || connector.eventPlane === undefined;
  });
}

/** Connector boot metadata from one installed package. An older manifest that advertised a
 * connector but lacks this cache is loud and repairable, never silently treated as requirement-free. */
export function extensionConnectors(ext: InstalledExtension): readonly CachedConnector[] {
  const advertised = extensionProvides(ext).filter((ref) => ref.kind === "connector");
  if (!advertised.length) return [];
  if (!ext.connectors)
    throw new Error(`installed extension ${ext.pkg}@${ext.version} has no cached connector requirements - re-run \`cotal ext add ${ext.pkg}\``);
  for (const ref of advertised)
    if (!ext.connectors.some((connector) => connector.name === ref.name))
      throw new Error(`installed extension ${ext.pkg}@${ext.version} advertises connector ${ref.name} without cached requirements - re-run \`cotal ext add ${ext.pkg}\``);
  for (const connector of ext.connectors)
    if (typeof connector.eventPlane !== "boolean")
      throw new Error(`installed extension ${ext.pkg}@${ext.version} connector ${connector.name} has no cached event-plane fact - re-run \`cotal ext add ${ext.pkg}\``);
  return ext.connectors;
}

/** Stable, serializable registry keys contributed by one imported package. */
export function cacheExtension(ext: Extension): ProvidedRef {
  return { kind: ext.kind, name: ext.name, ...(ext.aliases?.length ? { aliases: [...ext.aliases] } : {}) };
}

export function cacheLocalProcess(component: LocalProcess): LocalProcess {
  if (component.controllerOnly !== undefined && (component.controllerOnly !== true || component.service === undefined)) throw new Error("controller-only local processes must declare their service ABI");
  if (typeof component.pidFile !== "string") throw new Error(`local-process ${component.name} must declare a string pidFile template`);
  (component.controllerOnly ? canonicalLocalProcessPath : localProcessPath)(component.pidFile, { root: process.cwd(), space: "validation" });
  for (const artifact of component.artifacts ?? []) {
    if (typeof artifact !== "string") throw new Error(`local-process ${component.name} artifacts must be string templates`);
    localProcessPath(artifact, { root: process.cwd(), space: "validation" });
  }
  if (component.cooperativeStop !== undefined && typeof component.cooperativeStop !== "boolean")
    throw new Error(`local-process ${component.name} cooperativeStop must be a boolean`);
  if (component.isOwnCommand !== undefined)
    throw new Error(`local-process ${component.name} declares isOwnCommand, which an installed extension's cached descriptor cannot carry`);
  return {
    kind: "local-process",
    name: component.name,
    label: component.label,
    ...(component.controllerOnly === true ? { controllerOnly: true as const } : {}),
    ...(component.service === undefined ? {} : { service: serviceAdapterDeclaration(component.service) }),
    order: component.order,
    pidFile: component.pidFile,
    cooperativeStop: component.cooperativeStop,
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
export function extensionProvides(ext: InstalledExtension): readonly ProvidedRef[] {
  return ext.provides ?? ext.commands.map((command) => ({ kind: "command", name: command.name, aliases: command.aliases }));
}

/** Every word a contribution claims in its kind: its name, then its aliases. */
export function providedWords(ref: ProvidedRef): string[] {
  return [ref.name, ...(ref.aliases ?? [])];
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

/** Locate a shared package in this host's module graph. Exported so a failed import can name the
 *  EXACT peer copy the binder linked, rather than a second resolution that might not be the same one. */
export function hostPackageDir(name: string): string {
  let dir = dirname(fileURLToPath(import.meta.resolve(name)));
  for (;;) {
    const pj = join(dir, "package.json");
    if (existsSync(pj) && (JSON.parse(readFileSync(pj, "utf8")) as { name?: string }).name === name) return dir;
    const parent = dirname(dir);
    if (parent === dir) throw new Error(`couldn't locate ${name}'s package root from its resolved entry`);
    dir = parent;
  }
}

/** Bind installed extensions' shared peers to the current host. Callers must hold the extension lock.
 *  `onAbsent` receives another owner whose package directory does not exist, which has no links to
 *  keep, instead of the bind failing on it. Without it, or for `operationPkg` itself, an absent
 *  package throws like any other unreadable one. `operationMetadata` reuses the operation's already
 *  validated package read; other owners are read through {@link installedExtensionPackage}. */
export function bindExtensionPeers(
  owners: readonly string[],
  operationPkg: string,
  opts: { force?: boolean; onAbsent?: (owner: string) => void; operationMetadata?: InstalledExtensionPackage } = {},
): readonly BoundExtensionPeer[] {
  const planned: BoundExtensionPeer[] = [];
  for (const owner of owners) {
    const meta = owner === operationPkg && opts.operationMetadata !== undefined
      ? opts.operationMetadata
      : installedExtensionPackage(owner);
    if (!meta) {
      // Only a directory that does not exist is absent. A dangling link, or a directory left without
      // its package.json, is a damaged install and still fails.
      const dir = extensionPackageDir(owner);
      if (!lstatSync(dir, { throwIfNoEntry: false })) {
        if (opts.onAbsent && owner !== operationPkg) {
          opts.onAbsent(owner);
          continue;
        }
        throw new Error(`extension ${owner} is not installed at ${dir} - re-add it with \`cotal ext add\``);
      }
      throw new CorruptExtensionPackageError(owner, join(dir, "package.json"), "file is missing from the installed package");
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

/** An installed extension's package.json is present but is not JSON or names no version: the package
 *  is installed and damaged, so it must never read as not installed. */
export class CorruptExtensionPackageError extends Error {
  constructor(pkg: string, path: string, reason: string) {
    super(`extension ${pkg} has a corrupt package.json ${path}: ${reason} - re-add it with \`cotal ext add\`, or \`cotal ext seed --repair\` for a built-in`);
  }
}

/** One installed package metadata read, shared by version checks, peer binding and entry loading. */
export interface InstalledExtensionPackage {
  version: string;
  main: string | undefined;
  exports?: unknown;
  dependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
}

/** The installed package's CURRENT metadata from one read of its package.json (undefined when not
 *  installed; `main` is undefined when the package declares none). Only a missing package.json means
 *  not installed; one that cannot be reached or read throws, and one that is not JSON or has no version
 *  throws {@link CorruptExtensionPackageError}. Pass this snapshot through one load or add. */
export function installedExtensionPackage(pkg: string): InstalledExtensionPackage | undefined {
  const path = join(extensionPackageDir(pkg), "package.json");
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw e;
  }
  let version: unknown;
  let main: unknown;
  let meta: Record<string, unknown>;
  try {
    meta = JSON.parse(raw) as Record<string, unknown>;
    ({ version, main } = meta);
  } catch (e) {
    throw new CorruptExtensionPackageError(pkg, path, (e as Error).message);
  }
  if (typeof version !== "string" || !version) throw new CorruptExtensionPackageError(pkg, path, 'no "version" string');
  return {
    version,
    main: typeof main === "string" && main ? main : undefined,
    ...(meta.exports === undefined ? {} : { exports: meta.exports }),
    ...(meta.dependencies === undefined ? {} : { dependencies: meta.dependencies as Record<string, string> }),
    ...(meta.peerDependencies === undefined ? {} : { peerDependencies: meta.peerDependencies as Record<string, string> }),
  };
}

/** The installed package's CURRENT version, as {@link installedExtensionPackage} reads it. */
export function installedExtensionVersion(pkg: string): string | undefined {
  return installedExtensionPackage(pkg)?.version;
}
