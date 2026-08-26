import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { registry, type Extension, type ExtensionRef } from "@cotal-ai/core";
import {
  bindExtensionPeers,
  extensionPackageDir,
  extensionProvides,
  installedExtensionVersion,
  loadExtensionsManifest,
  type InstalledExtension,
} from "./extensions.js";
import { claimExtensionMutationLock } from "./extension-mutation.js";
import { diagnosePeerSkew, upgradeRemedy } from "./import-diagnosis.js";

/**
 * The generic manifest-materialize primitive: verify an installed package's version pin, resolve
 * its entry, and dynamic-`import()` it (which self-registers its extensions into the shared core
 * {@link registry}). It lives here — below `@cotal-ai/cli` — because both the CLI dispatcher and the
 * manager supervisor must materialize manifest extensions, and neither the manager nor this package
 * may import the CLI. It knows nothing about connectors or any other kind; callers supply the
 * name→package hint used to phrase a not-found error.
 */

/** The range the installed extension declares for a shared peer (undefined when it declares none). */
function declaredPeerRange(pkg: string, peer: string): string | undefined {
  try {
    const meta = JSON.parse(readFileSync(join(extensionPackageDir(pkg), "package.json"), "utf8")) as {
      peerDependencies?: Record<string, string>;
    };
    return meta.peerDependencies?.[peer];
  } catch {
    return undefined;
  }
}

/**
 * A missing-export failure is a SKEW between two installs, and the remedy depends on which of them is
 * behind. `bindExtensionPeers` linked this host's peer into the extension a few lines above the
 * import, so the copy that failed is nameable — path and version — and rankable against the extension.
 * Prescribing `cotal ext add` without ranking them tells the operator to reinstall whichever side is
 * CURRENT, and no reinstall of an extension can add an export to an older core.
 */
function importFailure(pkg: string, ext: InstalledExtension, e: unknown): Error {
  const message = e instanceof Error ? e.message : String(e);
  const reinstall = `reinstall it: \`cotal ext add ${ext.spec}\``;
  const missing = /The requested module '([^']+)' does not provide an export named '([^']+)'/.exec(message);
  // Any other import failure (a syntax error, an unresolvable specifier) is the extension's own file
  // being wrong, not a skew: reinstalling it is the remedy, and no side claim is warranted.
  if (!missing) return new Error(`extension ${pkg}@${ext.version} failed to import: ${message} - ${reinstall}`);

  const [, peer, symbol] = missing;
  const head = `extension ${pkg}@${ext.version} failed to import: it needs \`${symbol}\` from ${peer}`;
  const skew = diagnosePeerSkew(pkg, ext.version, peer, declaredPeerRange(pkg, peer));
  if (!skew) {
    return new Error(
      `${head}, which the linked ${peer} does not export. This cotal cannot locate its own ${peer} to compare against, ` +
        `so neither side can be named as behind - compare the two installs before reinstalling either.`,
    );
  }
  const at = `the linked ${peer} ${skew.peerVersion} at ${skew.peerPath} does not export it`;
  switch (skew.side) {
    case "peer-behind":
      return new Error(
        `${head}, and ${at}. The installed ${peer} is BEHIND: ${skew.because} - ` +
          `${upgradeRemedy(skew.peerPath, skew.needsAtLeast)}. Reinstalling the extension cannot add an export to an ` +
          `older ${peer}.`,
      );
    case "same-version":
      return new Error(
        `${head}, and ${at}. Same version, different build (${skew.because}): the installed ${peer} predates this ` +
          `extension's source - rebuild or reinstall the cotal that owns ${skew.peerPath}.`,
      );
    case "extension-behind":
      return new Error(`${head}, and ${at}. The extension is the older side: ${skew.because} - ${reinstall}`);
    case "unrankable":
      return new Error(
        `${head}, and ${at}. Neither side can be named as behind: ${skew.because} - compare the two installs before ` +
          `reinstalling either.`,
      );
  }
}

/** Process-wide single-flight serializer: two `import()`s must not share a staging/validation window,
 *  so their advertised-key checks can't interleave. */
let loadChain: Promise<void> = Promise.resolve();

function enqueueLoad(load: () => Promise<void>): Promise<void> {
  const run = loadChain.then(load);
  loadChain = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

async function withExtensionLock(load: () => Promise<void>): Promise<void> {
  const release = claimExtensionMutationLock({
    label: "extension materialization",
    waitMs: 0,
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
 * import's self-registrations are STAGED (never resolvable while it runs); they publish atomically
 * only after `advertised` is confirmed present among them. A package that registers a key then throws
 * (a rejected top-level await) commits NOTHING; a package that imports cleanly but never advertises
 * the requested provider commits NONE of its registrations. Serialized so concurrent loads never
 * share a validation window.
 */
export async function importInstalledExtension(ext: InstalledExtension, advertised: ExtensionRef): Promise<void> {
  if (registry.has(advertised.kind, advertised.name)) return;
  return enqueueLoad(async () => {
    if (registry.has(advertised.kind, advertised.name)) return;
    await withExtensionLock(() => loadOne(ext, advertised));
  });
}

async function loadOne(ext: InstalledExtension, advertised: ExtensionRef): Promise<void> {
  // Idempotent: if a prior load (a concurrent first call now serialized ahead of us on loadChain, or an
  // earlier one) already published the advertised provider, we're done. Re-import()ing an
  // already-evaluated module is a cache hit with NO registration side effects, so its stage would be
  // empty and wrongly read as "did not register"; the live check short-circuits that. commitStaged
  // publishes ALL of a package's keys, so a sibling ref requested concurrently is live here too.
  if (registry.has(advertised.kind, advertised.name)) return;
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
  // The prefix is machine-global, but global installs, npx, and source worktrees are distinct hosts.
  // Rebind before the first import in this process so registration lands in this host's core registry.
  bindExtensionPeers([pkg], pkg);
  const dir = extensionPackageDir(pkg);
  const meta = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as { main?: string; exports?: unknown };
  let entry = meta.main ?? "index.js";
  const dot = (meta.exports as Record<string, unknown> | undefined)?.["."];
  if (typeof dot === "string") entry = dot;
  else if (dot && typeof dot === "object") {
    const d = dot as Record<string, string>;
    entry = d.import ?? d.default ?? entry;
  } else if (typeof meta.exports === "string") entry = meta.exports;
  let staged: Extension[];
  try {
    // The import self-registers into OUR registry (core is linked); runStaged keeps those
    // registrations invisible until we've validated them, so a throw discards the stage untouched.
    ({ staged } = await registry.runStaged(() => import(pathToFileURL(join(dir, entry)).href)));
  } catch (e) {
    throw importFailure(pkg, ext, e); // stage discarded; nothing reached the live registry
  }
  // Publish ONLY if the package advertised the requested provider. Otherwise commit NONE of its
  // registrations (never leave a package's other keys live when its advertised one is absent).
  if (!staged.some((r) => r.kind === advertised.kind && r.name === advertised.name)) {
    throw new Error(
      `extension ${pkg}@${ext.version} imported but did not register ${advertised.kind} "${advertised.name}" - re-add it: \`cotal ext add ${ext.spec}\``,
    );
  }
  registry.commitStaged(staged);
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
  await enqueueLoad(() =>
    withExtensionLock(async () => {
      const ext = loadExtensionsManifest().extensions.find((candidate) =>
        extensionProvides(candidate).some((provided) => provided.kind === ref.kind && provided.name === ref.name),
      );
      if (!ext) {
        throw new Error(
          opts.hint?.(ref) ?? `no installed extension provides ${ref.kind} "${ref.name}" - install it with \`cotal ext add <npm-package>\``,
        );
      }
      await loadOne(ext, ref);
    }),
  );
  return registry.resolve<T>(ref.kind, ref.name);
}
