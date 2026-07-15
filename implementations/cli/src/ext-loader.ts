import {
  registry,
  type Command,
  type Extension,
  type ExtensionRef,
  type Registry,
  type RuntimeProvider,
} from "@cotal-ai/core";
import {
  connectorInstallHint,
  extensionLocalProcesses,
  extensionProvides,
  importInstalledExtension,
  loadExtensionsManifest,
  materializeFromManifest,
  type CachedCommand,
  type InstalledExtension,
  type LocalProcess,
} from "@cotal-ai/workspace";
import { c } from "./ui.js";

/** The official first-party runtimes, name → npm package. This is NOT authority — registration is
 *  still explicit (`cotal ext add` installs the package; importing it self-registers the provider).
 *  It is the CLI's UX source of truth so an uninstalled runtime error names a REAL package, a typo
 *  says "unknown" instead of inventing `@cotal-ai/<typo>`, and `cotal runtimes` can list what's one
 *  `cotal ext add` away. A third-party runtime installs under its own package name and, once added,
 *  resolves like any other — it just isn't listed here up front. */
export const OFFICIAL_RUNTIMES: Readonly<Record<string, string>> = {
  orca: "@cotal-ai/orca",
  tmux: "@cotal-ai/tmux",
  cmux: "@cotal-ai/cmux",
};

/** Every runtime name the CLI knows about without importing anything: `pty` (built in) + the officials. */
export function knownRuntimeNames(): string[] {
  return ["pty", ...Object.keys(OFFICIAL_RUNTIMES)];
}

/** The error for a runtime that has no installed provider: name the exact package for an official
 *  runtime, else say it's unknown and list the ones the CLI knows — never invent an `@cotal-ai/<name>`
 *  package for a typo (a custom provider installs under its own package name). */
function unknownRuntimeError(name: string): string {
  const pkg = OFFICIAL_RUNTIMES[name];
  if (pkg) return `no installed extension provides runtime "${name}" - install it with \`cotal ext add ${pkg}\``;
  return `unknown runtime "${name}" (known: ${knownRuntimeNames().join(", ")}) - install a provider with \`cotal ext add <npm-package>\`, or check the name`;
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

/** Resolve a provider, lazily importing the installed package that advertised it when necessary.
 *  The registered short-circuit and the composition-root gate stay here (CLI process state); the
 *  actual manifest read + transactional import is the shared workspace primitive. */
export async function materializeExtension<T extends Extension = Extension>(ref: ExtensionRef): Promise<T> {
  const registered = registry.all().find((ext) => ext.kind === ref.kind && ext.name === ref.name);
  if (registered) return registered as T;
  if (!installedEnabled)
    throw new Error(`no ${ref.kind} registered for "${ref.name}" - import its integration in this composition root`);
  return materializeFromManifest<T>(ref, {
    hint: (r) =>
      r.kind === "runtime"
        ? unknownRuntimeError(r.name)
        : r.kind === "connector"
          ? connectorInstallHint(r.name)
          : `no installed extension provides ${r.kind} "${r.name}" - install it with \`cotal ext add <npm-package>\``,
  });
}

/** Resolve and probe an extension runtime before a manifest command mutates local or mesh state. */
export async function preflightRuntime(name: string): Promise<void> {
  if (name === "pty") return;
  const provider = await materializeExtension<RuntimeProvider>({ kind: "runtime", name });
  if (!provider.available()) throw new Error(`${name} runtime requested but it is not reachable`);
}
