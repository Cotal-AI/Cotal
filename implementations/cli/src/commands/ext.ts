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
 *  - `@cotal-ai/core` must be a PEER dependency of the extension, and the prefix's copy is
 *    replaced with a link to the running binary's core — otherwise the extension registers into
 *    ITS OWN module's registry singleton and the binary never sees the commands.
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
 *  and installed node_modules both work) by walking up from core's resolved ENTRY to the
 *  directory holding its package.json — core's `exports` map doesn't expose "./package.json",
 *  so the subpath can't be resolved directly. */
function ourCoreDir(): string {
  let dir = dirname(fileURLToPath(import.meta.resolve("@cotal-ai/core")));
  for (;;) {
    const pj = join(dir, "package.json");
    if (existsSync(pj) && (JSON.parse(readFileSync(pj, "utf8")) as { name?: string }).name === "@cotal-ai/core") return dir;
    const parent = dirname(dir);
    if (parent === dir) throw new Error("couldn't locate @cotal-ai/core's package root from its resolved entry");
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
  const resolved = /^(\.|\/)/.test(spec) ? resolve(spec) : spec;
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

  // Which package did that spec install? npm records it in the prefix package.json dependencies.
  const deps = (JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as { dependencies?: Record<string, string> }).dependencies ?? {};
  const known = new Set(loadExtensionsManifest().extensions.map((e) => e.pkg));
  const pkg = Object.keys(deps).find((k) => !known.has(k) && specMatches(deps[k], resolved)) ?? Object.keys(deps).find((k) => !known.has(k));
  if (!pkg) {
    console.error(c.red("✗ install succeeded but no new package appeared in the prefix — remove and retry"));
    process.exit(1);
  }
  const pkgDir = extensionPackageDir(pkg);
  const pkgMeta = JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf8")) as {
    version?: string;
    dependencies?: Record<string, string>;
    peerDependencies?: Record<string, string>;
  };

  // Core must be a PEER dependency — a regular dependency vendors a second core, whose module-level
  // registry singleton would swallow the registration invisibly. Fail the add with the exact reason.
  if (pkgMeta.dependencies?.["@cotal-ai/core"]) {
    fail(pkg, `declares @cotal-ai/core as a regular dependency — it must be a peerDependency, or its commands would register into its own core copy and never reach this CLI`);
  }
  if (!pkgMeta.peerDependencies?.["@cotal-ai/core"]) {
    fail(pkg, `does not declare @cotal-ai/core as a peerDependency — a cotal CLI extension must (its extension objects register into core's registry)`);
  }
  // Link the prefix's core to the RUNNING binary's copy, so the extension's
  // `import "@cotal-ai/core"` lands on our registry singleton.
  const prefixCore = join(dir, "node_modules", "@cotal-ai", "core");
  rmSync(prefixCore, { recursive: true, force: true });
  mkdirSync(dirname(prefixCore), { recursive: true });
  symlinkSync(ourCoreDir(), prefixCore, "junction");
  provenance.wrote("core link (extension → this CLI's core)", prefixCore);

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
  // failed-to-import above, naming the extension) — this is the belt to that suspender.
  const version = pkgMeta.version ?? "0.0.0";
  const entry: InstalledExtension = { pkg, version, spec: resolved, commands: contributed.map(cacheCommand) };
  const manifest = loadExtensionsManifest();
  saveExtensionsManifest({ extensions: [...manifest.extensions.filter((e) => e.pkg !== pkg), entry] });
  provenance.wrote(`extensions manifest (+${pkg}@${version})`, extensionsManifestPath());
  console.log(c.green(`✓ added ${pkg}@${version}`) + c.dim(` — commands: ${contributed.map((cm) => cm.name).join(", ")}`));

  function fail(p: string, why: string): never {
    npm(["remove", "--no-audit", "--no-fund", p], dir); // roll the prefix back
    console.error(c.red(`✗ ${p} ${why}`));
    process.exit(1);
  }
}

/** Loose match: is this recorded dep range plausibly the spec the user just passed? Used only to
 *  pick the NEW key out of the prefix dependencies; the fallback (any unknown key) covers ranges. */
function specMatches(range: string, spec: string): boolean {
  return range.includes(spec) || spec.includes(range.replace(/^file:/, ""));
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
