import { registry, type FlagSpec, type FlagValues, type ParsedArgs, type RuntimeProvider } from "@cotal-ai/core";
import { extensionProvides, jsonFlag, loadExtensionsManifest, plainFlag, presentationOf, writeResult, type Report, type Styled } from "@cotal-ai/workspace";
import { OFFICIAL_RUNTIMES, materializeExtension } from "../ext-loader.js";

export const runtimesFlags = [jsonFlag, plainFlag] as const satisfies readonly FlagSpec[];

/** One runtime the manager can spawn agents through. `reachable` is the provider's own
 *  `available()` answer, or null when it was not asked: the built-in `pty`, an official provider
 *  that is not installed, or one whose package failed to load (`error`). */
export interface RuntimeRow {
  readonly name: string;
  readonly state: "built-in" | "installed" | "not-installed";
  readonly package: string | null;
  readonly reachable: boolean | null;
  readonly error: string | null;
}

/**
 * `cotal runtimes` — the agent runtimes the manager can spawn agents through: the built-in `pty`,
 * the official providers (installed, or one `cotal ext add` away), and any custom installed provider.
 * Each installed provider is imported and probed via `available()` so the operator sees which are
 * actually reachable on this machine BEFORE selecting one with `up`/`spawn --runtime <name>` — no
 * silent fallback: an unreachable runtime is shown as such, and requesting it later fails loud.
 */
export async function runtimes(args: ParsedArgs): Promise<void> {
  const presentation = presentationOf(args.values as FlagValues<typeof runtimesFlags>);
  const providers = runtimeProviders();
  const items: RuntimeRow[] = [{ name: "pty", state: "built-in", package: null, reachable: null, error: null }];
  // Officials first in a stable order, then any custom (non-official) installed/registered provider.
  // `pty` is the built-in row above; a stray extension advertising `runtime:pty` must not add a second,
  // unusable row (both preflightRuntime and the manager's createRuntime special-case pty and never
  // resolve such a provider).
  const names = [...Object.keys(OFFICIAL_RUNTIMES), ...[...providers.keys()].filter((name) => name !== "pty" && !(name in OFFICIAL_RUNTIMES))];
  for (const name of names) {
    if (!providers.has(name)) {
      // Official but not installed: one `cotal ext add` away.
      items.push({ name, state: "not-installed", package: OFFICIAL_RUNTIMES[name] ?? null, reachable: null, error: null });
      continue;
    }
    const pkg = providers.get(name) ?? OFFICIAL_RUNTIMES[name] ?? null;
    try {
      const provider = await materializeExtension<RuntimeProvider>({ kind: "runtime", name });
      items.push({ name, state: "installed", package: pkg, reachable: provider.available(), error: null });
    } catch (e) {
      items.push({ name, state: "installed", package: pkg, reachable: null, error: (e as Error).message });
    }
  }
  const failed = items.filter((row) => row.error !== null);
  writeResult(
    presentation,
    {
      command: "runtimes",
      target: null,
      result: { items },
      completeness: failed.length ? "partial" : "complete",
      warnings: failed.map((row) => ({ code: "RUNTIME_LOAD_FAILED", target: { runtime: row.name }, message: `${row.name}: load failed: ${row.error}` })),
      ...(failed.length ? { partial: { message: `${failed.length} installed runtime provider${failed.length === 1 ? "" : "s"} could not be loaded`, remedy: "reinstall it with `cotal ext add <package>`" } } : {}),
    },
    runtimesView,
  );
}

/** Name → owning package, for every runtime provider an installed extension advertises (read from
 *  the manifest; no import yet). A provider already registered in core (a library build) has no
 *  package name. */
export function runtimeProviders(): Map<string, string | undefined> {
  const providers = new Map<string, string | undefined>();
  for (const ext of loadExtensionsManifest().extensions)
    for (const ref of extensionProvides(ext)) if (ref.kind === "runtime") providers.set(ref.name, ext.pkg);
  for (const ext of registry.all()) if (ext.kind === "runtime" && !providers.has(ext.name)) providers.set(ext.name, undefined);
  return providers;
}

function stateCell(row: RuntimeRow): Styled {
  if (row.state === "built-in") return { text: "built in", tone: "hint" };
  if (row.state === "not-installed") return { text: "not installed", tone: "hint" };
  // The load error itself follows the report as a warning, so the row keeps to the state.
  if (row.error !== null) return { text: "installed · load failed", tone: "failed" };
  return row.reachable ? { text: "installed · reachable", tone: "ok" } : { text: "installed · unreachable", tone: "waiting" };
}

function runtimesView(result: { items: readonly RuntimeRow[] }): Report {
  return {
    sections: [{
      blocks: [{
        kind: "table",
        columns: [{ key: "name", label: "RUNTIME" }, { key: "state", label: "STATE" }, { key: "package", label: "PACKAGE" }],
        rows: result.items.map((row) => ({ name: row.name, state: stateCell(row), package: row.package ? { text: row.package, tone: "hint" } : "" })),
      }, ...(result.items.some((row) => row.state === "not-installed")
        ? [{ kind: "lines" as const, lines: [{ text: "add one that is not installed with `cotal ext add <package>`", tone: "hint" as const }] }]
        : [])],
    }],
  };
}
