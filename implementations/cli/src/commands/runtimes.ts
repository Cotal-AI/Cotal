import { registry, type RuntimeProvider } from "@cotal-ai/core";
import { extensionProvides, loadExtensionsManifest } from "@cotal-ai/workspace";
import { c } from "../ui.js";
import { OFFICIAL_RUNTIMES, materializeExtension } from "../ext-loader.js";

/**
 * `cotal runtimes` — the agent runtimes the manager can spawn agents through: the built-in `pty`,
 * the official providers (installed, or one `cotal ext add` away), and any custom installed provider.
 * Each installed provider is imported and probed via `available()` so the operator sees which are
 * actually reachable on this machine BEFORE selecting one with `up`/`spawn --runtime <name>` — no
 * silent fallback: an unreachable runtime is shown as such, and requesting it later fails loud.
 */
export async function runtimes(): Promise<void> {
  // name → owning package, for every runtime provider an installed extension advertises (read from
  // the manifest; no import yet). A provider already registered in core (a library build) is added
  // below with no package name.
  const providers = new Map<string, string | undefined>();
  for (const ext of loadExtensionsManifest().extensions)
    for (const ref of extensionProvides(ext)) if (ref.kind === "runtime") providers.set(ref.name, ext.pkg);
  for (const ext of registry.all()) if (ext.kind === "runtime" && !providers.has(ext.name)) providers.set(ext.name, undefined);

  interface Row {
    name: string;
    state: string;
  }
  const rows: Row[] = [{ name: "pty", state: c.dim("built in") }];

  // Officials first in a stable order, then any custom (non-official) installed/registered provider.
  // `pty` is the built-in row above; a stray extension advertising `runtime:pty` must not add a second,
  // unusable row (both preflightRuntime and the manager's createRuntime special-case pty and never
  // resolve such a provider).
  const names = [...Object.keys(OFFICIAL_RUNTIMES), ...[...providers.keys()].filter((name) => name !== "pty" && !(name in OFFICIAL_RUNTIMES))];
  for (const name of names) {
    if (providers.has(name)) {
      const pkg = providers.get(name) ?? OFFICIAL_RUNTIMES[name];
      let reach: string;
      try {
        const provider = await materializeExtension<RuntimeProvider>({ kind: "runtime", name });
        reach = provider.available() ? c.green("reachable") : c.yellow("unreachable");
      } catch (e) {
        reach = c.red(`load failed: ${(e as Error).message}`);
      }
      rows.push({ name, state: `${c.dim("installed ·")} ${reach}${pkg ? c.dim(`  ${pkg}`) : ""}` });
    } else {
      // Official but not installed: one `cotal ext add` away.
      rows.push({ name, state: `${c.dim("available ·")} ${c.dim(`cotal ext add ${OFFICIAL_RUNTIMES[name]}`)}` });
    }
  }

  const width = Math.max(...rows.map((row) => row.name.length));
  for (const row of rows) console.log(`${c.bold(row.name.padEnd(width))}  ${row.state}`);
}
