import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { registry, type Command, type ParsedArgs } from "@cotal-ai/core";
import {
  cacheCommand,
  extensionPackageDir,
  extensionsDir,
  extensionsManifestPath,
  installedExtensionVersion,
  loadExtensionsManifest,
  provenance,
  saveExtensionsManifest,
  type InstalledExtension,
} from "@cotal-ai/workspace";
import { c } from "../ui.js";

/**
 * `cotal ext` — operator-installed CLI extensions. `add` installs an npm package into the
 * cotal-owned prefix (never the user's project), imports it ONCE so it self-registers into the
 * live `Registry`, verifies the registration actually landed, and caches the contributed command
 * metadata into the manifest. From then on, help and <TAB> read the cache (no import), and
 * dispatch imports the package lazily to run one of its commands with LIVE specs.
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
  console.error(c.red("usage: cotal ext <add <npm-package> | remove <name> | list>"));
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
  const bin = process.platform === "win32" ? "npm.cmd" : "npm";
  const r = spawnSync(bin, args, { cwd, encoding: "utf8" });
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

async function add(spec: string): Promise<void> {
  const dir = extensionsDir();
  mkdirSync(dir, { recursive: true });
  if (!existsSync(join(dir, "package.json"))) {
    writeFileSync(join(dir, "package.json"), `${JSON.stringify({ name: "cotal-extensions", private: true }, null, 2)}\n`);
    provenance.wrote("extensions prefix", join(dir, "package.json"));
  }

  // A file:/path spec is resolved to an absolute path so the prefix install works from any cwd.
  const isPath = /^(\.|\/)/.test(spec);
  const resolved = isPath ? resolve(spec) : spec;
  // The installed NAME is known BEFORE npm runs — never recovered afterwards by diffing the prefix
  // dependencies (a heuristic that binds to the wrong key if the prefix ever drifted, and that made
  // re-adding an installed extension impossible).
  const pkg = packageNameFromSpec(resolved, isPath);
  console.error(c.dim(`installing ${resolved} into ${dir} …`));
  // --legacy-peer-deps: never auto-install the peer'd core from the registry — the add ALWAYS
  // links the running binary's copy below (one core instance is the whole point).
  // --install-links: a file:/path spec is COPIED into the prefix, not symlinked — a symlink's
  // realpath would escape the prefix and Node could no longer resolve the linked core from it.
  const r = npm(["install", "--save", "--no-audit", "--no-fund", "--legacy-peer-deps", "--install-links", resolved], dir);
  if (r.status !== 0) {
    console.error(c.red(`✗ npm install failed:\n${r.output.split("\n").slice(-8).join("\n")}`));
    process.exit(1);
  }

  // The spec's package must now be a prefix dependency — anything else is a failed install.
  const deps = (JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as { dependencies?: Record<string, string> }).dependencies ?? {};
  if (!deps[pkg]) {
    console.error(c.red(`✗ npm install succeeded but "${pkg}" is not among the prefix dependencies — remove and retry`));
    process.exit(1);
  }
  const pkgDir = extensionPackageDir(pkg);
  const pkgMeta = JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf8")) as {
    version?: string;
    dependencies?: Record<string, string>;
    peerDependencies?: Record<string, string>;
  };

  // Shared @cotal-ai/* packages must be PEER dependencies — a regular dependency vendors a second
  // copy: core's would swallow the extension's registrations into its own registry singleton, and
  // any other shared package would silently drift from the binary's. Fail with the exact reason.
  const vendored = Object.keys(pkgMeta.dependencies ?? {}).filter((d) => d.startsWith("@cotal-ai/"));
  if (vendored.length) {
    fail(pkg, `declares ${vendored.join(", ")} as a regular dependency — shared @cotal-ai/* packages must be peerDependencies, or the extension runs its own copy (core's would swallow its command registrations; any other's drifts from this CLI's)`);
  }
  if (!pkgMeta.peerDependencies?.["@cotal-ai/core"]) {
    fail(pkg, `does not declare @cotal-ai/core as a peerDependency — a cotal CLI extension must (its extension objects register into core's registry)`);
  }
  // Link every shared @cotal-ai/* peer to the RUNNING binary's copy, so the extension's imports
  // land on our singletons — core's registry above all. npm ignored the peers at install
  // (--legacy-peer-deps), so this link is the ONLY resolution they get: core is mandatory, and any
  // other @cotal-ai/* peer must be one the binary carries, else the add fails loud.
  for (const peer of Object.keys(pkgMeta.peerDependencies ?? {}).filter((d) => d.startsWith("@cotal-ai/"))) {
    let src: string;
    try {
      src = ourPackageDir(peer);
    } catch {
      fail(pkg, `peer-depends on ${peer}, which this cotal binary does not carry — the peer can't be linked, so the extension could never resolve it`);
    }
    const dest = join(dir, "node_modules", ...peer.split("/"));
    rmSync(dest, { recursive: true, force: true });
    mkdirSync(dirname(dest), { recursive: true });
    symlinkSync(src, dest, "junction");
    provenance.wrote(`${peer} link (extension → this CLI's copy)`, dest);
  }

  // Import once; the registration must LAND IN OUR REGISTRY — zero new commands is a failed add.
  const before = new Set(registry.all<Command>("command").map((cm) => cm.name));
  try {
    await importExtension(pkg);
  } catch (e) {
    fail(pkg, `failed to import: ${(e as Error).message}`);
  }
  const contributed = registry.all<Command>("command").filter((cm) => !before.has(cm.name));
  if (!contributed.length) {
    fail(pkg, `imported cleanly but registered no commands in THIS CLI's registry — if it bundles its own @cotal-ai/core, make core a peerDependency`);
  }
  // Builtin collisions can't happen here (registry.register throws on a duplicate, surfacing as
  // failed-to-import above, naming the extension). OTHER installed extensions are invisible to the
  // registry during this add (they aren't imported), so their CACHED names are checked explicitly —
  // a duplicate fails the add under the same contract, naming both sides.
  const manifest = loadExtensionsManifest();
  for (const cm of contributed) {
    const other = manifest.extensions.find((e) => e.pkg !== pkg && e.commands.some((oc) => oc.name === cm.name));
    if (other) {
      fail(pkg, `contributes "${cm.name}", already provided by installed extension ${other.pkg}@${other.version} — two extensions cannot claim one command; \`cotal ext remove ${other.pkg}\` first if you want this one`);
    }
  }
  const version = pkgMeta.version ?? "0.0.0";
  const entry: InstalledExtension = { pkg, version, spec: resolved, commands: contributed.map(cacheCommand) };
  saveExtensionsManifest({ extensions: [...manifest.extensions.filter((e) => e.pkg !== pkg), entry] });
  provenance.wrote(`extensions manifest (+${pkg}@${version})`, extensionsManifestPath());
  console.log(c.green(`✓ added ${pkg}@${version}`) + c.dim(` — commands: ${contributed.map((cm) => cm.name).join(", ")}`));

  function fail(p: string, why: string): never {
    npm(["remove", "--no-audit", "--no-fund", p], dir); // roll the prefix back
    console.error(c.red(`✗ ${p} ${why}`));
    process.exit(1);
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
  console.error(c.red(`✗ unsupported extension spec "${resolved}" — use a local path or a registry name[@version]`));
  process.exit(1);
}

async function remove(pkg: string): Promise<void> {
  const manifest = loadExtensionsManifest();
  const entry = manifest.extensions.find((e) => e.pkg === pkg);
  if (!entry) {
    console.error(c.red(`✗ no installed extension "${pkg}" — see \`cotal ext list\``));
    process.exit(1);
  }
  const r = npm(["remove", "--no-audit", "--no-fund", pkg], extensionsDir());
  if (r.status !== 0) {
    console.error(c.red(`✗ npm remove failed:\n${r.output.split("\n").slice(-6).join("\n")}`));
    process.exit(1);
  }
  saveExtensionsManifest({ extensions: manifest.extensions.filter((e) => e.pkg !== pkg) });
  provenance.wrote(`extensions manifest (−${pkg})`, extensionsManifestPath());
  console.log(c.green(`✓ removed ${pkg}`) + c.dim(` — commands gone: ${entry.commands.map((cm) => cm.name).join(", ")}`));
}

function list(): void {
  const { extensions } = loadExtensionsManifest();
  if (!extensions.length) {
    console.log(c.dim("(no extensions installed — add one with `cotal ext add <npm-package>`)"));
    return;
  }
  for (const e of extensions) {
    console.log(`${c.bold(e.pkg)}@${e.version}  ${c.dim(e.commands.map((cm) => cm.name).join(", "))}`);
  }
}
