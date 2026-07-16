import { spawnSync } from "node:child_process";
import { closeSync, cpSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { registry, type Command, type ParsedArgs } from "@cotal-ai/core";
import {
  cacheCommand,
  cacheExtension,
  cacheLocalProcess,
  cmdSpawnSpec,
  extensionPackageDir,
  extensionLocalProcesses,
  extensionProvides,
  extensionsDir,
  extensionsManifestPath,
  loadMeshes,
  localProcessPath,
  installedExtensionVersion,
  loadExtensionsManifest,
  provenance,
  RESERVED_CONNECTOR_NAMES,
  saveExtensionsManifest,
  type InstalledExtension,
  type LocalProcess,
  type LocalProcessContext,
} from "@cotal-ai/workspace";
import { c } from "../ui.js";
import { cotalRoot } from "../lib/paths.js";
import { resolveSpace } from "../lib/status.js";
import { claimExtensionMutation } from "../lib/ext-mutation.js";
import { runSeed } from "../seed/reconcile.js";
import { isAuthenticSeedChild, markSeedChildLive, clearChildMarker } from "../seed/lock.js";
import { seedStoreDir } from "../seed/paths.js";

/** Classify a `cotal ext add` spec as a local path (vs a registry name). A path is a relative `.`/`./`/
 *  `.\` spec or an absolute one on the NATIVE platform — POSIX `/…`, Windows drive `C:\…` / `C:/…`, or
 *  UNC `\\…`. A POSIX-only test misclassified a Windows absolute path (it starts with a drive letter,
 *  not `/`) as a registry name, which broke first-run seeding on Windows (the seed-store spec is always
 *  absolute). `absolute` is injectable so the classification is unit-testable for both platforms. */
export function isPathSpec(spec: string, absolute: (p: string) => boolean = isAbsolute): boolean {
  return spec.startsWith(".") || absolute(spec);
}

/**
 * `cotal ext` — operator-installed extensions. `add` installs an npm package into the
 * cotal-owned prefix (never the user's project), imports it ONCE so it self-registers into the
 * live `Registry`, verifies the registration actually landed, and caches every contributed key
 * plus command display metadata. From then on, help and <TAB> read the cache (no import), and
 * dispatch/provider resolution imports the package lazily with live objects.
 *
 * Add-time guarantees (design-review conditions — each converts a silent failure into a loud one):
 *  - shared `@cotal-ai/*` packages must be PEER dependencies of the extension; each is linked to
 *    the running binary's copy (core is mandatory — otherwise the extension registers into ITS
 *    OWN module's registry singleton and the binary never sees the commands; others, e.g.
 *    `@cotal-ai/workspace`, would silently drift from the binary's).
 *  - after import, the expected commands must have appeared in OUR registry, else the add fails.
 *  - a contributed name colliding with an existing command fails the add (builtins win).
 */

export async function ext(args: ParsedArgs): Promise<void> {
  const [sub, ...rest] = args.positionals;
  if (sub === "add" && rest[0]) return add(rest[0]);
  if (sub === "remove" && rest[0]) return remove(rest[0]);
  if (sub === "list" && !rest.length) return list();
  if (sub === "seed" && !rest.length) {
    const { repair, reset, force } = args.values as { repair?: boolean; reset?: boolean; force?: boolean };
    return runSeed({ repair, reset, force });
  }
  console.error(c.red("usage: cotal ext <add <npm-package> | remove <name> | list | seed [--repair|--reset|--force]>"));
  process.exit(1);
}

/** Resolve the running binary's @cotal-ai/core package dir — the ONE core instance every
 *  extension must share. Resolved from this module's own import graph (so dev workspace links
 *  and installed node_modules both work) by walking up from the package's resolved ENTRY to the
 *  directory holding its package.json — the `exports` maps don't expose "./package.json",
 *  so the subpath can't be resolved directly. NOTE: resolution runs from @cotal-ai/cli's graph,
 *  so only shared packages the CLI itself carries (core, workspace) are linkable today; an
 *  extension peering any other @cotal-ai/* package fails its add loudly. */
function ourPackageDir(name: string): string {
  let dir = dirname(fileURLToPath(import.meta.resolve(name)));
  for (;;) {
    const pj = join(dir, "package.json");
    if (existsSync(pj) && (JSON.parse(readFileSync(pj, "utf8")) as { name?: string }).name === name) return dir;
    const parent = dirname(dir);
    if (parent === dir) throw new Error(`couldn't locate ${name}'s package root from its resolved entry`);
    dir = parent;
  }
}

function npm(args: string[], cwd: string): { status: number | null; output: string } {
  // On Windows `npm` is `npm.cmd`; Node refuses to spawn a `.cmd` without a shell (CVE-2024-27980),
  // and a naive shell re-parses cmd metachars, so run it through cmd.exe with a byte-for-byte command
  // line (shared with the manager's PtyRuntime launch).
  const { file, args: spawnArgs, windowsVerbatimArguments } = cmdSpawnSpec("npm", args);
  const r = spawnSync(file, spawnArgs, { cwd, encoding: "utf8", windowsVerbatimArguments });
  return { status: r.status, output: `${r.stdout ?? ""}${r.stderr ?? ""}`.trim() };
}

/** Import an installed extension package (its declared entry) so it self-registers. */
async function importExtension(pkg: string): Promise<void> {
  const dir = extensionPackageDir(pkg);
  const meta = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as {
    main?: string;
    exports?: unknown;
  };
  // Entry resolution: the common cases (exports["."] as string or {import|default}, else main).
  let entry = meta.main ?? "index.js";
  const dot = (meta.exports as Record<string, unknown> | undefined)?.["."];
  if (typeof dot === "string") entry = dot;
  else if (dot && typeof dot === "object") {
    const d = dot as Record<string, string>;
    entry = d.import ?? d.default ?? entry;
  } else if (typeof meta.exports === "string") entry = meta.exports;
  await import(pathToFileURL(join(dir, entry)).href);
}

/** Rebuild each installed package's private links after npm mutates the shared prefix. Keeping the
 * links inside the owning package prevents a later sibling add/remove from pruning its peers. */
function linkExtensionPeers(packages: string[], operationPkg: string): void {
  for (const owner of packages) {
    let meta: { peerDependencies?: Record<string, string> };
    try {
      meta = JSON.parse(readFileSync(join(extensionPackageDir(owner), "package.json"), "utf8"));
    } catch (e) {
      throw new Error(`${operationPkg} cannot preserve installed extension ${owner}'s shared peers: ${(e as Error).message}`);
    }
    for (const peer of Object.keys(meta.peerDependencies ?? {}).filter((name) => name.startsWith("@cotal-ai/"))) {
      let src: string;
      try {
        src = ourPackageDir(peer);
      } catch {
        throw new Error(`${operationPkg}: ${owner} peer-depends on ${peer}, which this cotal binary does not carry - the peer can't be linked`);
      }
      const dest = join(extensionPackageDir(owner), "node_modules", ...peer.split("/"));
      try {
        rmSync(dest, { recursive: true, force: true });
        mkdirSync(dirname(dest), { recursive: true });
        symlinkSync(src, dest, "junction");
      } catch (e) {
        throw new Error(`${operationPkg} could not link ${peer} for ${owner}: ${(e as Error).message}`);
      }
      provenance.wrote(`${peer} link (${owner} → this CLI's copy)`, dest);
    }
  }
}

async function add(spec: string): Promise<void> {
  const dir = extensionsDir();
  mkdirSync(dir, { recursive: true });
  if (!existsSync(join(dir, "package.json"))) {
    writeFileSync(join(dir, "package.json"), `${JSON.stringify({ name: "cotal-extensions", private: true }, null, 2)}\n`);
    provenance.wrote("extensions prefix", join(dir, "package.json"));
  }

  // A file:/path spec is resolved to an absolute path so the prefix install works from any cwd.
  const isPath = isPathSpec(spec);
  const resolved = isPath ? resolve(spec) : spec;
  // The installed NAME is known BEFORE npm runs — never recovered afterwards by diffing the prefix
  // dependencies (a heuristic that binds to the wrong key if the prefix ever drifted, and that made
  // re-adding an installed extension impossible).
  const pkg = packageNameFromSpec(resolved, isPath);
  // A seed child runs UNDER the reconcile's mutation lock (its parent already holds it for the whole
  // run); claiming again would deadlock against the parent's live PID. It skips the claim, records a
  // liveness marker (so a post-crash repair won't race it), and stamps its entry `source:"seeded"`.
  // Authenticated: only an `ext add` whose marker matches the LIVE reconcile lock AND whose spec is a
  // staged official-connector path qualifies — a forged `COTAL_EXT_SEEDING` can't skip the lock.
  const seeding = isAuthenticSeedChild() && isPath && resolved.startsWith(seedStoreDir() + sep);
  const releaseMutation = seeding ? () => {} : claimExtensionMutation();
  // Upgrade the parent's pending marker to a live one carrying this child's PID, as the first act — so
  // a repair after a parent SIGKILL sees the exact orphan identity and refuses to race it.
  if (seeding) markSeedChildLive(process.env.COTAL_EXT_SEEDING as string, Number(process.env.COTAL_EXT_SEEDING_PARENT));
  try {
    await addTransaction();
  } finally {
    if (seeding) clearChildMarker();
    releaseMutation();
  }

  async function addTransaction(): Promise<void> {
  // Validate/read workstation state before npm can mutate the prefix; this snapshot also drives the
  // final replacement entry so the manifest and installed tree commit as one logical transaction.
  const manifest = loadExtensionsManifest();
  // npm installs in-place and may replace the package plus shared dependency/lock state before we
  // can validate it. A failed update must restore the previously working prefix byte-for-byte.
  const updating = manifest.extensions.some((entry) => entry.pkg === pkg) || existsSync(extensionPackageDir(pkg));
  const rollbackRoot = updating ? mkdtempSync(join(dirname(dir), ".extensions.rollback-")) : undefined;
  const rollbackDir = rollbackRoot ? join(rollbackRoot, "extensions") : undefined;
  if (rollbackDir) {
    // Snapshot beside the prefix (same filesystem), preserving npm's relative symlinks verbatim.
    // npm mutates the live tree; rollback removes it and atomically renames this snapshot back.
    cpSync(dir, rollbackDir, { recursive: true, verbatimSymlinks: true });
    // npm otherwise treats a same-spec/same-version re-add as already current, even when the
    // installed files are stale or damaged. Remove only the disposable copy's package so install
    // must materialize it again; the untouched snapshot remains the rollback source.
    rmSync(extensionPackageDir(pkg), { recursive: true, force: true });
  }

  let committed = false;
  let restored = false;
  const restore = (): void => {
    if (restored || committed) return;
    restored = true;
    if (rollbackDir) {
      rmSync(dir, { recursive: true, force: true });
      renameSync(rollbackDir, dir);
      rmSync(rollbackRoot!, { recursive: true, force: true });
    } else {
      npm(["remove", "--no-audit", "--no-fund", pkg], dir);
      linkExtensionPeers(manifest.extensions.map((entry) => entry.pkg), pkg);
    }
  };
  const interrupted = (): void => {
    restore();
    if (seeding) clearChildMarker();
    releaseMutation();
    process.exit(130);
  };
  process.once("SIGINT", interrupted);
  process.once("SIGTERM", interrupted);
  try {
    await installCandidate();
    committed = true;
    if (rollbackRoot) rmSync(rollbackRoot, { recursive: true, force: true });
  } catch (e) {
    restore();
    throw e;
  } finally {
    process.removeListener("SIGINT", interrupted);
    process.removeListener("SIGTERM", interrupted);
  }

  async function installCandidate(): Promise<void> {
  console.error(c.dim(`installing ${resolved} into ${dir} …`));
  // --legacy-peer-deps: never auto-install the peer'd core from the registry — the add ALWAYS
  // links the running binary's copy below (one core instance is the whole point).
  // --install-links: a file:/path spec is COPIED into the prefix, not symlinked — a symlink's
  // realpath would escape the prefix and Node could no longer resolve the linked core from it.
  const r = npm(["install", "--save", "--no-audit", "--no-fund", "--legacy-peer-deps", "--install-links", resolved], dir);
  if (r.status !== 0) {
    fail(pkg, `npm install failed:\n${r.output.split("\n").slice(-8).join("\n")}`);
  }

  // The spec's package must now be a prefix dependency — anything else is a failed install.
  let deps: Record<string, string>;
  try {
    deps = (JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as { dependencies?: Record<string, string> }).dependencies ?? {};
  } catch (e) {
    fail(pkg, `left unreadable prefix metadata: ${(e as Error).message}`);
  }
  if (!deps[pkg]) {
    fail(pkg, `npm install succeeded but it is not among the prefix dependencies - remove and retry`);
  }
  const pkgDir = extensionPackageDir(pkg);
  let pkgMeta: {
    version?: string;
    dependencies?: Record<string, string>;
    peerDependencies?: Record<string, string>;
  };
  try {
    pkgMeta = JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf8"));
  } catch (e) {
    fail(pkg, `has unreadable package metadata: ${(e as Error).message}`);
  }

  // Shared @cotal-ai/* packages must be PEER dependencies — a regular dependency vendors a second
  // copy: core's would swallow the extension's registrations into its own registry singleton, and
  // any other shared package would silently drift from the binary's. Fail with the exact reason.
  const vendored = Object.keys(pkgMeta.dependencies ?? {}).filter((d) => d.startsWith("@cotal-ai/"));
  if (vendored.length) {
    fail(pkg, `declares ${vendored.join(", ")} as a regular dependency - shared @cotal-ai/* packages must be peerDependencies, or the extension runs its own copy (core's would swallow its command registrations; any other's drifts from this CLI's)`);
  }
  if (!pkgMeta.peerDependencies?.["@cotal-ai/core"]) {
    fail(pkg, `does not declare @cotal-ai/core as a peerDependency - a cotal CLI extension must (its extension objects register into core's registry)`);
  }
  // npm mutates the shared prefix, so restore every package's private shared-peer links, not only
  // the candidate's. All extensions resolve the exact same host package instances.
  try {
    linkExtensionPeers([...manifest.extensions.filter((entry) => entry.pkg !== pkg).map((entry) => entry.pkg), pkg], pkg);
  } catch (e) {
    fail(pkg, (e as Error).message);
  }

  // Import once; every registration must LAND IN OUR REGISTRY. Runtime-only and other provider
  // packages are first-class extensions too; commands are only the display/dispatch subset.
  const before = new Set(registry.all().map((ext) => `${ext.kind}:${ext.name}`));
  try {
    await importExtension(pkg);
  } catch (e) {
    fail(pkg, `failed to import: ${(e as Error).message}`);
  }
  const contributed = registry.all().filter((ext) => !before.has(`${ext.kind}:${ext.name}`));
  if (!contributed.length) {
    fail(pkg, `imported cleanly but registered no extensions in THIS CLI's registry - if it bundles its own @cotal-ai/core, make core a peerDependency`);
  }
  // `cotal` is reserved (the binary's own name — there is no runtime alias anymore); a connector must
  // never claim it, or `--agent cotal` would be ambiguous with the CLI.
  const reserved = contributed.find((ext) => ext.kind === "connector" && RESERVED_CONNECTOR_NAMES.includes(ext.name));
  if (reserved) fail(pkg, `contributes connector "${reserved.name}", which is a reserved name - a connector cannot be named ${RESERVED_CONNECTOR_NAMES.join(", ")}`);

  // Builtin collisions can't happen here (registry.register throws on a duplicate, surfacing as
  // failed-to-import above, naming the extension). OTHER installed extensions are invisible to the
  // registry during this add (they aren't imported), so their CACHED names are checked explicitly —
  // a duplicate fails the add under the same contract, naming both sides.
  for (const provided of contributed) {
    const other = manifest.extensions.find((e) =>
      e.pkg !== pkg && extensionProvides(e).some((ref) => ref.kind === provided.kind && ref.name === provided.name),
    );
    if (other) {
      fail(pkg, `contributes ${provided.kind} "${provided.name}", already provided by installed extension ${other.pkg}@${other.version} - two extensions cannot claim one registry key; \`cotal ext remove ${other.pkg}\` first if you want this one`);
    }
  }
  const commands = contributed.filter((ext): ext is Command => ext.kind === "command");
  const localProcesses = contributed.filter((ext): ext is LocalProcess => ext.kind === "local-process");
  const version = pkgMeta.version ?? "0.0.0";
  const entry: InstalledExtension = {
    pkg,
    version,
    spec: resolved,
    ...(seeding ? { source: "seeded" as const } : {}),
    provides: contributed.map(cacheExtension),
    commands: commands.map(cacheCommand),
    localProcesses: localProcesses.map(cacheLocalProcess),
  };
  try {
    saveExtensionsManifest({ extensions: [...manifest.extensions.filter((e) => e.pkg !== pkg), entry] });
  } catch (e) {
    fail(pkg, `could not update the extensions manifest: ${(e as Error).message}`);
  }
  provenance.wrote(`extensions manifest (+${pkg}@${version})`, extensionsManifestPath());
  console.log(c.green(`✓ added ${pkg}@${version}`) + c.dim(` - provides: ${contributed.map((ext) => `${ext.kind}:${ext.name}`).join(", ")}`));
  }

  function fail(p: string, why: string): never {
    throw new Error(`${p} ${why}`);
  }
  }
}

/** The package NAME a spec installs, known BEFORE npm runs: a path spec reads its package.json;
 *  a registry spec carries the name (`name`, `name@range`, `@scope/name@range`). Exotic forms
 *  (git / tarball URLs) are refused rather than guessed at — there is no reliable way to know
 *  which prefix dependency such an install bound to. */
function packageNameFromSpec(resolved: string, isPath: boolean): string {
  if (isPath) {
    let meta: { name?: string };
    try {
      meta = JSON.parse(readFileSync(join(resolved, "package.json"), "utf8")) as { name?: string };
    } catch (e) {
      console.error(c.red(`✗ can't read ${join(resolved, "package.json")}: ${(e as Error).message}`));
      process.exit(1);
    }
    if (meta.name) return meta.name;
    console.error(c.red(`✗ ${join(resolved, "package.json")} declares no "name"`));
    process.exit(1);
  }
  const m = /^(@[^/@]+\/[^/@]+|[^/@]+)(@.*)?$/.exec(resolved);
  if (m) return m[1];
  console.error(c.red(`✗ unsupported extension spec "${resolved}" - use a local path or a registry name[@version]`));
  process.exit(1);
}

async function remove(pkg: string): Promise<void> {
  const releaseMutation = claimExtensionMutation();
  try {
    await removeUnlocked(pkg);
  } finally {
    releaseMutation();
  }
}

async function removeUnlocked(pkg: string): Promise<void> {
  const manifest = loadExtensionsManifest();
  const entry = manifest.extensions.find((e) => e.pkg === pkg);
  if (!entry) throw new Error(`no installed extension "${pkg}" - see \`cotal ext list\``);
  const processes = await extensionProcesses(entry);
  const recorded = processes.filter(({ pidPath }) => existsSync(pidPath));
  if (recorded.length)
    throw new Error(`${pkg} still owns recorded local processes:\n${recorded.map(describeProcess).map((item) => `  ${item}`).join("\n")}\nStop or clean them from the listed mesh roots before removing the extension.`);

  // Reserve every provider pidfile through uninstall. A concurrent extension startup then loses
  // its own atomic pid claim instead of coming online after the liveness scan but before removal.
  const reservations: string[] = [];
  try {
    for (const { context, pidPath } of processes) {
      // Only real mesh roots participate, but reserve nested provider state directories even when
      // the process has never run so startup cannot create-and-claim them during npm removal.
      if (!existsSync(join(context.root, ".cotal"))) continue;
      mkdirSync(dirname(pidPath), { recursive: true });
      let fd: number;
      try {
        fd = openSync(pidPath, "wx", 0o600);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === "EEXIST")
          throw new Error(`${pkg} acquired process state while removal was starting - stop it and retry`);
        throw e;
      }
      try { writeFileSync(fd, `removing:${process.pid}`); } finally { closeSync(fd); }
      reservations.push(pidPath);
    }
    const r = npm(["remove", "--no-audit", "--no-fund", pkg], extensionsDir());
    if (r.status !== 0) throw new Error(`npm remove failed:\n${r.output.split("\n").slice(-6).join("\n")}`);
    const remaining = manifest.extensions.filter((e) => e.pkg !== pkg);
    linkExtensionPeers(remaining.map((entry) => entry.pkg), pkg);
    saveExtensionsManifest({ extensions: remaining });
    provenance.wrote(`extensions manifest (−${pkg})`, extensionsManifestPath());
    console.log(c.green(`✓ removed ${pkg}`) + c.dim(` - removed: ${extensionProvides(entry).map((ref) => `${ref.kind}:${ref.name}`).join(", ")}`));
  } finally {
    for (const pidPath of reservations) {
      try {
        if (readFileSync(pidPath, "utf8").trim() === `removing:${process.pid}`) rmSync(pidPath, { force: true });
      } catch {
        // A failed/racing startup may already have cleaned the reservation.
      }
    }
  }
}

interface ExtensionProcess {
  provider: LocalProcess;
  context: LocalProcessContext;
  pidPath: string;
}

/** Resolve every mesh-local pidfile owned by this extension. */
async function extensionProcesses(entry: InstalledExtension): Promise<ExtensionProcess[]> {
  const refs = extensionProvides(entry).filter((ref) => ref.kind === "local-process");
  if (!refs.length) return [];
  const providers = [...extensionLocalProcesses(entry)];
  const missing = refs.map((ref) => ref.name).filter((name) => !providers.some((provider) => provider.name === name));
  if (missing.length)
    throw new Error(`${entry.pkg} predates cached local-process metadata for ${missing.join(", ")} - re-add it before removal: \`cotal ext add ${entry.spec}\``);
  const currentRoot = cotalRoot();
  const contexts = new Map<string, LocalProcessContext>();
  contexts.set(currentRoot, { root: currentRoot, space: resolveSpace(currentRoot) });
  for (const mesh of loadMeshes()) contexts.set(mesh.root, { root: mesh.root, space: mesh.space });

  const processes: ExtensionProcess[] = [];
  for (const context of contexts.values()) {
    for (const provider of providers) {
      processes.push({ provider, context, pidPath: localProcessPath(provider.pidFile, context) });
    }
  }
  return processes;
}

function describeProcess({ provider, context, pidPath }: ExtensionProcess): string {
  const raw = readFileSync(pidPath, "utf8").trim();
  if (raw.startsWith("removing:"))
    return `${provider.name} (extension-removal reservation) in ${context.root} - clean ${pidPath} if its owner is gone`;
  const pid = Number(raw);
  let state = "stale pidfile";
  if (Number.isInteger(pid) && pid > 0) {
    try { process.kill(pid, 0); state = `pid ${pid}`; } catch { /* stale */ }
  }
  return `${provider.name} (${state}) in ${context.root} - run there: cotal down ${provider.name}`;
}

function list(): void {
  const { extensions } = loadExtensionsManifest();
  if (!extensions.length) {
    console.log(c.dim("(no extensions installed - add one with `cotal ext add <npm-package>`)"));
    return;
  }
  for (const e of extensions) {
    console.log(`${c.bold(e.pkg)}@${e.version}  ${c.dim(extensionProvides(e).map((ref) => `${ref.kind}:${ref.name}`).join(", "))}`);
  }
}
