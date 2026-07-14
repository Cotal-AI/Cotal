import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { registry, type Extension, type ExtensionRef } from "@cotal-ai/core";
import {
  extensionPackageDir,
  extensionMutationLockState,
  extensionProvides,
  installedExtensionVersion,
  loadExtensionsManifest,
  type InstalledExtension,
} from "./extensions.js";

/**
 * The generic manifest-materialize primitive: verify an installed package's version pin, resolve
 * its entry, and dynamic-`import()` it (which self-registers its extensions into the shared core
 * {@link registry}). It lives here — below `@cotal-ai/cli` — because both the CLI dispatcher and the
 * manager supervisor must materialize manifest extensions, and neither the manager nor this package
 * may import the CLI. It knows nothing about connectors or any other kind; callers supply the
 * name→package hint used to phrase a not-found error.
 */

function importFailure(pkg: string, ext: InstalledExtension, e: unknown): Error {
  const message = e instanceof Error ? e.message : String(e);
  const compatibility = /does not provide an export named/.test(message) && /@cotal-ai\/(core|workspace)/.test(message)
    ? " (the extension is not compatible with this cotal binary's linked @cotal-ai/* packages; update the binary and extension together)"
    : "";
  return new Error(`extension ${pkg}@${ext.version} failed to import: ${message}${compatibility} - reinstall it: \`cotal ext add ${ext.spec}\``);
}

/** Process-wide single-flight serializer: two `import()`s must not run against a shared registry
 *  before-image, or a rolled-back load would discard the other's registrations. */
let loadChain: Promise<void> = Promise.resolve();

/**
 * Verify the pin, resolve the entry, and import the package TRANSACTIONALLY: a package that
 * registers a key and then throws (e.g. a rejected top-level await) leaves NO resolvable keys — the
 * registry is restored to its pre-import snapshot. Serialized so concurrent loads never share a
 * before-image.
 */
export async function importInstalledExtension(ext: InstalledExtension): Promise<void> {
  const run = loadChain.then(() => loadOne(ext));
  loadChain = run.then(
    () => undefined,
    () => undefined, // keep the chain alive so one load's failure doesn't wedge the next
  );
  return run;
}

async function loadOne(ext: InstalledExtension): Promise<void> {
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
  const snap = registry.snapshot();
  try {
    await import(pathToFileURL(join(dir, entry)).href); // self-registers into OUR registry (core is linked)
  } catch (e) {
    registry.restore(snap);
    throw importFailure(pkg, ext, e);
  }
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
  for (const ext of loadExtensionsManifest().extensions)
    for (const ref of extensionProvides(ext)) if (ref.kind === kind) names.add(ref.name);
  return [...names].sort();
}

/**
 * Resolve a provider from the installed manifest, importing the package that advertised it. The
 * "already registered" short-circuit and any composition-root gating stay with the caller — this
 * ALWAYS consults the machine manifest. `hint(ref)` phrases the not-found error (the CLI names the
 * exact `cotal ext add <pkg>` for an official name; a bare caller gets the generic form).
 */
export async function materializeFromManifest<T extends Extension = Extension>(
  ref: ExtensionRef,
  opts: { hint?: (ref: ExtensionRef) => string } = {},
): Promise<T> {
  const ext = loadExtensionsManifest().extensions.find((candidate) =>
    extensionProvides(candidate).some((provided) => provided.kind === ref.kind && provided.name === ref.name),
  );
  if (!ext) {
    throw new Error(
      opts.hint?.(ref) ?? `no installed extension provides ${ref.kind} "${ref.name}" - install it with \`cotal ext add <npm-package>\``,
    );
  }
  await importInstalledExtension(ext);
  try {
    return registry.resolve<T>(ref.kind, ref.name);
  } catch {
    throw new Error(`extension ${ext.pkg} imported but did not register ${ref.kind} "${ref.name}" - re-add it: \`cotal ext add ${ext.spec}\``);
  }
}
