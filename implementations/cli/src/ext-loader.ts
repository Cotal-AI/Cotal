import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  registry,
  type Command,
  type Extension,
  type ExtensionRef,
  type Registry,
  type RuntimeProvider,
} from "@cotal-ai/core";
import {
  extensionPackageDir,
  extensionLocalProcesses,
  extensionMutationLockState,
  extensionProvides,
  installedExtensionVersion,
  loadExtensionsManifest,
  type CachedCommand,
  type InstalledExtension,
  type LocalProcess,
} from "@cotal-ai/workspace";
import { c } from "./ui.js";

function importFailure(pkg: string, ext: InstalledExtension, e: unknown): Error {
  const message = e instanceof Error ? e.message : String(e);
  const compatibility = /does not provide an export named/.test(message) && /@cotal-ai\/(core|workspace)/.test(message)
    ? " (the extension is not compatible with this cotal binary's linked @cotal-ai/* packages; update the binary and extension together)"
    : "";
  return new Error(`extension ${pkg}@${ext.version} failed to import: ${message}${compatibility} - reinstall it: \`cotal ext add ${ext.spec}\``);
}

/**
 * The installed-extensions loader — opt-in for the PUBLISHED binary only (`runCli(…, { extensions:
 * true })`); library composition roots keep the explicit-import model.
 *
 * Discipline (design-review conditions):
 *  - Help and `__complete` see extension commands as manifest-cached STUBS (display surface only;
 *    a <TAB> or `--help` never imports an extension).
 *  - Running one imports its package lazily, which self-registers the LIVE command; parsing then
 *    uses the live specs — the cache never drives `run`'s input.
 *  - The pinned `name@version` is verified before the import; skew is a loud error prescribing
 *    `cotal ext add` again.
 *  - A cached name shadowed by a builtin (a base upgrade claimed it) is dropped from the surface
 *    with a loud stderr warning naming both sides and the fix — the builtin wins; the user's typed
 *    builtin command NEVER throws over the collision.
 */

/** A display-only stub for the help/complete surface. Running it resolves the REAL command:
 *  verify pin → import (self-registers) → re-resolve → parse LIVE specs → run. */
function stubFor(ext: InstalledExtension, cached: CachedCommand): Command {
  return {
    kind: "command",
    name: cached.name,
    summary: cached.summary,
    group: cached.group ?? "Extensions",
    usage: cached.usage,
    hidden: cached.hidden,
    flags: cached.flags,
    positionals: cached.positionals,
    // Marker consumed by runCli: dispatch must swap the stub for the live command before parsing.
    extension: ext.pkg,
    async run(): Promise<void> {
      throw new Error(`extension stub for ${ext.pkg}:${cached.name} was run directly - dispatcher bug`);
    },
  } as Command & { extension: string };
}

/** The dispatch surface runCli resolved this invocation (registered commands, plus extension
 *  stubs when the root opted in). The completion dispatcher reads it so <TAB> sees the same
 *  surface help does — set once per invocation by runCli, before any command runs. */
let surface: Command[] | undefined;
let installedEnabled = false;

/** The published binary enables installed-package resolution; library roots retain explicit imports. */
export function setInstalledExtensionsEnabled(enabled: boolean): void {
  installedEnabled = enabled;
}
export function setCommandSurface(commands: Command[]): void {
  surface = commands;
}
export function commandSurface(): Command[] {
  return surface ?? registry.all<Command>("command");
}

/** Registered and installed provider names without importing packages (safe for help/completion). */
export function extensionNames(kind: string): string[] {
  const names = new Set(registry.all().filter((ext) => ext.kind === kind).map((ext) => ext.name));
  if (installedEnabled) {
    for (const ext of loadExtensionsManifest().extensions) {
      if (kind === "local-process") {
        for (const process of extensionLocalProcesses(ext)) names.add(process.name);
      } else {
        for (const ref of extensionProvides(ext)) if (ref.kind === kind) names.add(ref.name);
      }
    }
  }
  return [...names].sort();
}

/** Base + cached installed process descriptors. No extension package is imported. */
export function localProcessSurface(): LocalProcess[] {
  const processes = [...registry.all<LocalProcess>("local-process")];
  const owners = new Map(processes.map((process) => [process.name, "this CLI"]));
  if (!installedEnabled) return processes;
  for (const ext of loadExtensionsManifest().extensions) {
    for (const process of extensionLocalProcesses(ext)) {
      const owner = owners.get(process.name);
      if (owner) throw new Error(`local process "${process.name}" is provided by both ${owner} and ${ext.pkg}@${ext.version}`);
      owners.set(process.name, `${ext.pkg}@${ext.version}`);
      processes.push(process);
    }
  }
  return processes;
}

/** True when this command is a manifest stub that must be materialized before parsing/running. */
export function isExtensionStub(cmd: Command): boolean {
  return typeof (cmd as Command & { extension?: string }).extension === "string";
}

/** Overlay the manifest's cached commands onto the registered surface. Returns the combined
 *  command list for help/complete/dispatch. Loud on builtin collisions; never imports. */
export function overlayExtensions(reg: Registry): Command[] {
  const commands = [...reg.all<Command>("command")];
  const owner = new Map<string, string>(); // command name → "" for a builtin, else the owning ext pkg
  for (const cm of commands) owner.set(cm.name, "");
  for (const ext of loadExtensionsManifest().extensions) {
    for (const cached of ext.commands) {
      const holder = owner.get(cached.name);
      if (holder !== undefined) {
        // add() refuses fresh collisions, so this install predates the clash: a base upgrade
        // shipped the name (builtin case), or the sibling was added under an older base that
        // allowed it. First holder wins; the loser leaves the surface until the operator resolves.
        console.error(
          c.red(
            holder === ""
              ? `! command "${cached.name}" is provided by both this CLI and extension ${ext.pkg}@${ext.version} - the built-in wins; run \`cotal ext remove ${ext.pkg}\` (or update the extension) to clear this`
              : `! command "${cached.name}" is provided by both extensions ${holder} and ${ext.pkg}@${ext.version} - ${holder} (installed first) wins; \`cotal ext remove\` one of them to clear this`,
          ),
        );
        continue;
      }
      owner.set(cached.name, ext.pkg);
      commands.push(stubFor(ext, cached));
    }
  }
  return commands;
}

/** Swap an extension STUB for its live command: verify the version pin, import the package (it
 *  self-registers), and return the freshly-registered command. Every failure is loud and names
 *  the package. */
export async function materializeExtensionCommand(stub: Command): Promise<Command> {
  const pkg = (stub as Command & { extension?: string }).extension;
  if (!pkg) return stub; // not a stub — already live
  const ext = loadExtensionsManifest().extensions.find((e) => e.pkg === pkg);
  if (!ext) throw new Error(`extension ${pkg} vanished from the manifest - \`cotal ext add\` it again`);
  await importInstalledExtension(ext);
  const live = registry.all<Command>("command").find((cm) => cm.name === stub.name);
  if (!live) {
    throw new Error(`extension ${pkg} imported but did not register "${stub.name}" - its cache is stale; re-add it: \`cotal ext add ${ext.spec}\``);
  }
  return live;
}

/** Resolve a provider, lazily importing the installed package that advertised it when necessary. */
export async function materializeExtension<T extends Extension = Extension>(ref: ExtensionRef): Promise<T> {
  const registered = registry.all().find((ext) => ext.kind === ref.kind && ext.name === ref.name);
  if (registered) return registered as T;
  if (!installedEnabled)
    throw new Error(`no ${ref.kind} registered for "${ref.name}" - import its integration in this composition root`);
  const ext = loadExtensionsManifest().extensions.find((candidate) =>
    extensionProvides(candidate).some((provided) => provided.kind === ref.kind && provided.name === ref.name),
  );
  if (!ext) {
    const official = ref.kind === "runtime" && /^[a-z0-9-]+$/.test(ref.name)
      ? `; for the official same-named integration: \`cotal ext add @cotal-ai/${ref.name}\``
      : "";
    throw new Error(`no installed extension provides ${ref.kind} "${ref.name}" - install it with \`cotal ext add <npm-package>\`${official}`);
  }
  await importInstalledExtension(ext);
  try {
    return registry.resolve<T>(ref.kind, ref.name);
  } catch {
    throw new Error(`extension ${ext.pkg} imported but did not register ${ref.kind} "${ref.name}" - re-add it: \`cotal ext add ${ext.spec}\``);
  }
}

/** Resolve and probe an extension runtime before a manifest command mutates local or mesh state. */
export async function preflightRuntime(name: string): Promise<void> {
  if (name === "pty") return;
  const provider = await materializeExtension<RuntimeProvider>({ kind: "runtime", name });
  if (!provider.available()) throw new Error(`${name} runtime requested but it is not reachable`);
}

async function importInstalledExtension(ext: InstalledExtension): Promise<void> {
  const mutation = extensionMutationLockState();
  if (mutation.state === "active")
    throw new Error(`extension install/remove is in progress (pid ${mutation.owner}) - retry after the active \`cotal ext\` command finishes`);
  const pkg = ext.pkg;
  const onDisk = installedExtensionVersion(pkg);
  if (!onDisk) {
    throw new Error(`extension ${pkg} is in the manifest but not installed at ${extensionPackageDir(pkg)} - \`cotal ext add ${ext.spec}\` again`);
  }
  if (onDisk !== ext.version) {
    throw new Error(
      `extension ${pkg} is ${onDisk} on disk but the manifest pinned ${ext.version} (its cached command surface may be stale) - re-add it: \`cotal ext add ${ext.spec}\``,
    );
  }
  const dir = extensionPackageDir(pkg);
  const meta = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as { main?: string; exports?: unknown };
  let entry = meta.main ?? "index.js";
  const dot = (meta.exports as Record<string, unknown> | undefined)?.["."];
  if (typeof dot === "string") entry = dot;
  else if (dot && typeof dot === "object") {
    const d = dot as Record<string, string>;
    entry = d.import ?? d.default ?? entry;
  } else if (typeof meta.exports === "string") entry = meta.exports;
  try {
    await import(pathToFileURL(join(dir, entry)).href); // self-registers into OUR registry (core is linked)
  } catch (e) {
    throw importFailure(pkg, ext, e);
  }
}
