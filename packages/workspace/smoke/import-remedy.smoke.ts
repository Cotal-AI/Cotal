/**
 * Import-failure remedy smoke (no NATS). Run: pnpm smoke:import-remedy
 *
 * A missing peer export can come from a stale install or a mistaken import. Exercise the real
 * entry point with installed packages: identify the symbol and linked peer, and name an older
 * side only when the versions support that conclusion.
 *
 * Fixtures live under a temp cotal config home (XDG_CONFIG_HOME) inside the repo, so each one's
 * `@cotal-ai/core` resolves to the repo copy this smoke also measures against.
 */
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { readFileSync } from "node:fs";
import { registry, type ExtensionRef } from "@cotal-ai/core";
import { bindExtensionPeers, CorruptExtensionPackageError, extensionCorePeerProblem, extensionPackageDir, extensionsDir, extensionsManifestPath, extensionReinstallAdvice, hostPackageDir, importExtensionEntry, importInstalledExtension, installedExtensionPackage, installedExtensionVersion, isReleaseExtension, materializeFromManifest, resolveExtensionEntry, type InstalledExtension } from "@cotal-ai/workspace";
// Not on the package's public surface: the same module instance the entry point above loads.
import { upgradeRemedy } from "../dist/import-diagnosis.js";

const tmp = mkdtempSync(join(import.meta.dirname, ".import-remedy-"));
process.env.XDG_CONFIG_HOME = tmp;

const CORE_DIR = hostPackageDir("@cotal-ai/core");
const CORE_VERSION = (JSON.parse(readFileSync(join(CORE_DIR, "package.json"), "utf8")) as { version: string }).version;

let passed = 0;
let failed = 0;
function check(label: string, ok: boolean, detail?: unknown): void {
  if (ok) {
    passed++;
    console.log(`  ✓ ${label}`);
  } else {
    failed++;
    console.log(`✗ FAIL: ${label}${detail === undefined ? "" : ` — ${detail}`}`);
  }
}

let seq = 0;
/** Lay down a package whose import demands a symbol `@cotal-ai/core` does not export, and return the
 *  message thrown when the real materialize path tries to load it. */
async function failureFor(opts: { scope: string; version: string; peerRange?: string; body?: string }): Promise<string> {
  const pkg = `${opts.scope}/remedy-${++seq}`;
  const dir = join(extensionsDir(), "node_modules", ...pkg.split("/"));
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({
      name: pkg,
      version: opts.version,
      type: "module",
      main: "index.mjs",
      ...(opts.peerRange === undefined ? {} : { peerDependencies: { "@cotal-ai/core": opts.peerRange } }),
    }),
  );
  writeFileSync(join(dir, "index.mjs"), opts.body ?? `import { registry, notAnExportOfCore } from "@cotal-ai/core";\nvoid registry, notAnExportOfCore;\n`);
  const ref: ExtensionRef = { kind: "command", name: `remedy-${seq}` };
  const ext: InstalledExtension = { pkg, version: opts.version, spec: `${pkg}@${opts.version}`, commands: [], provides: [ref] };
  try {
    await importInstalledExtension(ext, ref);
  } catch (e) {
    return (e as Error).message;
  }
  return "<no error was thrown>";
}

try {
  // 1. The measured real-world shape: a first-party extension NEWER than the core it linked. The
  //    @cotal-ai/* group versions in lockstep, so the numbers rank, and the core is the behind side.
  {
    const m = await failureFor({ scope: "@cotal-ai", version: "99.0.0", peerRange: ">=0.1.0" });
    check("lockstep, extension newer: names the CORE as behind", m.includes("The installed @cotal-ai/core is BEHIND"), m);
    check("lockstep, extension newer: names the missing symbol", m.includes("`notAnExportOfCore`"), m);
    check("lockstep, extension newer: names the core's version and path", m.includes(CORE_VERSION) && m.includes(CORE_DIR), m);
    check("lockstep, extension newer: does NOT prescribe reinstalling the extension", !m.includes("cotal ext add"), m);
    // The repo's core is a source checkout, not an installed copy, so the remedy must be a rebuild:
    // `npm i -g` would be the wrong instruction for this path. The installed-copy wording is proven
    // below, since no fixture here can make hostPackageDir resolve into a node_modules tree.
    check("lockstep, extension newer: prescribes a rebuild for a source checkout", m.includes("source checkout") && m.includes("rebuild it at 99.0.0 or newer"), m);
    check("lockstep, extension newer: names no npm command for a source checkout", !m.includes("npm i -g"), m);
  }

  // 2. A declared floor above the linked core is the extension's OWN statement that it needs a newer
  //    peer. It ranks a third-party extension, whose version number says nothing on its own.
  {
    const m = await failureFor({ scope: "@third", version: "1.0.0", peerRange: ">=99.0.0" });
    check("declared floor above the linked core: names the CORE as behind", m.includes("The installed @cotal-ai/core is BEHIND"), m);
    check("declared floor above the linked core: quotes the declared range", m.includes(">=99.0.0"), m);
    check("declared floor above the linked core: targets the floor, not the extension's version", m.includes("99.0.0 or newer") && !m.includes("1.0.0 or newer"), m);
  }

  // 3. The fixture imports a nonexistent name. Equal versions do not tell us either build is stale.
  {
    const m = await failureFor({ scope: "@cotal-ai", version: CORE_VERSION, peerRange: ">=0.1.0" });
    check("equal versions: identifies the missing export and the linked copy", m.includes("`notAnExportOfCore`") && m.includes(CORE_DIR) && m.includes(`Both packages report ${CORE_VERSION}`), m);
    check("equal versions: advises checking the import and the peer exports", m.includes("Check the extension's import and the exports of the linked peer"), m);
    check("equal versions: does not rank the builds or prescribe reinstalling one", !/predates|behind|older side|reinstall|cotal ext add/i.test(m), m);
  }

  // 4. The one ranking where reinstalling the extension IS the remedy.
  {
    const m = await failureFor({ scope: "@cotal-ai", version: "0.0.1", peerRange: ">=0.1.0" });
    check("lockstep, extension older: names the EXTENSION as the older side", m.includes("The extension is the older side"), m);
    check("lockstep, extension older: keeps the `cotal ext add` remedy", m.includes("cotal ext add '@cotal-ai/remedy-"), m);
  }

  // 5. A third-party extension whose declared range the linked core satisfies: nothing available
  //    ranks the two, and the message must say so instead of picking a side.
  {
    const m = await failureFor({ scope: "@third", version: "1.0.0", peerRange: ">=0.1.0" });
    check("unrankable pair: refuses to name a side", m.includes("Neither side can be named as behind"), m);
    check("unrankable pair: says why it cannot rank them", m.includes("is not a @cotal-ai/* package"), m);
    check("unrankable pair: prescribes no reinstall of either side", !m.includes("cotal ext add"), m);
  }

  // 6. CONTROL. An import failure that is NOT a missing export is the extension's own file being
  //    wrong. It must keep the plain remedy and must claim no side at all — otherwise cells 1-5 would
  //    pass just as well against code that printed a skew verdict onto every failure.
  {
    const m = await failureFor({ scope: "@cotal-ai", version: "99.0.0", peerRange: ">=0.1.0", body: `import "./does-not-exist.mjs";\n` });
    check("control, non-export failure: claims no side", !/is BEHIND|older side|Same version|Neither side/.test(m), m);
    check("control, non-export failure: keeps the plain reinstall remedy", m.includes("cotal ext add '@cotal-ai/remedy-"), m);
  }
  // A package whose `main` names a directory resolves through that directory's index file, the
  // way Node's own resolution does. The add-time existence check already passes for such a package
  // (the directory exists), so only the import failed.
  {
    const pkg = "@third/directory-entry";
    const dir = join(extensionsDir(), "node_modules", ...pkg.split("/"));
    mkdirSync(join(dir, "dist"), { recursive: true });
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: pkg, version: "1.0.0", type: "module", main: "./dist", peerDependencies: { "@cotal-ai/core": "*" } }));
    writeFileSync(join(dir, "dist", "index.js"), `import { registry } from "@cotal-ai/core";\nregistry.register({ kind: "command", name: "directory-entry-example", summary: "Print a greeting", run() { console.log("Hello"); } });\n`);
    const ref: ExtensionRef = { kind: "command", name: "directory-entry-example" };
    const ext: InstalledExtension = { pkg, version: "1.0.0", spec: `${pkg}@1.0.0`, commands: [], provides: [ref] };
    await importInstalledExtension(ext, ref);
    check("directory entry: imports and registers the command", registry.has("command", "directory-entry-example"));
    // The native loader is the arbiter here: tsx resolves a directory import to its index file on
    // its own, so the check above would pass without the fix. Drive the same fixture through plain
    // node, where a directory import fails unless the entry was resolved first.
    const probeEnv: NodeJS.ProcessEnv = { ...process.env, XDG_CONFIG_HOME: tmp };
    for (const key of Object.keys(probeEnv)) if (key.startsWith("COTAL_")) delete probeEnv[key];
    const probe = spawnSync(process.execPath, ["--input-type=module", "-e",
      `import { importInstalledExtension } from ${JSON.stringify(pathToFileURL(join(import.meta.dirname, "..", "dist", "index.js")).href)};\n` +
      `import { registry } from ${JSON.stringify(pathToFileURL(join(import.meta.dirname, "..", "..", "core", "dist", "index.js")).href)};\n` +
      `await importInstalledExtension({ pkg: "@third/directory-entry", version: "1.0.0", spec: "@third/directory-entry@1.0.0", commands: [], provides: [{ kind: "command", name: "directory-entry-example" }] }, { kind: "command", name: "directory-entry-example" });\n` +
      `console.log(registry.has("command", "directory-entry-example") ? "registered" : "not-registered");\n`,
    ], { encoding: "utf8", env: probeEnv });
    check("directory entry: plain node imports and registers the command", probe.status === 0 && probe.stdout.includes("registered"), probe.stderr || probe.stdout);
    // A directory with nothing to resolve keeps the old failure instead of silently succeeding.
    // (The exact wording differs by loader: plain Node reports a directory import, tsx reports
    // the missing index file. The suite asserts the failure and its remedy, not the phrasing.)
    const emptyPkg = "@third/directory-empty";
    const emptyDir = join(extensionsDir(), "node_modules", ...emptyPkg.split("/"));
    mkdirSync(join(emptyDir, "dist"), { recursive: true });
    writeFileSync(join(emptyDir, "package.json"), JSON.stringify({ name: emptyPkg, version: "1.0.0", type: "module", main: "./dist", peerDependencies: { "@cotal-ai/core": "*" } }));
    let emptyError: unknown;
    try { await importExtensionEntry(emptyPkg, "1.0.0", "fixture remedy"); } catch (e) { emptyError = e; }
    check("directory entry: an unresolvable directory still fails", emptyError instanceof Error && emptyError.message.includes("failed to import"));
    check("directory entry: the failure keeps the plain remedy", emptyError instanceof Error && emptyError.message.includes("fixture remedy"));
  }
  // 7. The remedy's SHAPE, proven on hand-built paths because nothing in this repo can make the peer
  //    resolve into an installed tree — hostPackageDir always finds the source checkout above. Cells
  //    1-6 prove the real entry point reaches this function; these two prove the branch it takes for
  //    the path shape a customer's machine actually has, which is the one the operator must be given
  //    an exact command for.
  {
    const installed = upgradeRemedy("/home/someone/.local/share/cotal/node_modules/@cotal-ai/core", "0.18.0");
    check("installed copy: the remedy is the exact upgrade command, pinned to the version it must reach", installed.includes("`npm i -g cotal-ai@0.18.0`"), installed);
    check("installed copy: does not call an installed copy a source checkout", !installed.includes("source checkout"), installed);
    const checkout = upgradeRemedy("/home/someone/Cotal/packages/core", "0.18.0");
    check("source checkout: prescribes a rebuild, never `npm i -g`", checkout.includes("rebuild") && !checkout.includes("npm i -g"), checkout);
  }
  // 8. The import uses the same validated metadata snapshot for pin, entry, peers and diagnosis.
  //    An entry that changes its own package.json cannot make those steps describe different files.
  //    The original declared floor stays known; no diagnostic-time reread is needed.
  for (const [label, damage] of [
    ["corrupt", `writeFileSync(meta, "{corrupt");`],
    ["directory", `unlinkSync(meta); mkdirSync(meta);`],
    ["missing", `unlinkSync(meta);`],
  ] as const) {
    // The static core import makes Node read and cache the package scope before the file is
    // changed, as loading a real entry does; otherwise Node's own resolver refuses the later import.
    const body =
      `import { writeFileSync, unlinkSync, mkdirSync } from "node:fs";\n` +
      `import { registry } from "@cotal-ai/core";\n` +
      `void registry;\n` +
      `const meta = new URL("./package.json", import.meta.url); ${damage}\n` +
      `writeFileSync(new URL("./b.mjs", import.meta.url), 'import { notAnExportOfCore } from "@cotal-ai/core";\\nvoid notAnExportOfCore;\\n');\n` +
      `await import("./b.mjs");\n`;
    const m = await failureFor({ scope: "@third", version: "1.0.0", peerRange: ">=99.0.0", body });
    check(`${label} after validation: keeps the original declared floor`, m.includes("The installed @cotal-ai/core is BEHIND") && m.includes(">=99.0.0"), m);
    check(`${label} after validation: names the missing symbol`, m.includes("`notAnExportOfCore`"), m);
    check(`${label} after validation: does not reread the damaged metadata`, !m.includes("is corrupt or unreadable"), m);
    check(`${label} after validation: remedies the peer rather than reinstalling the extension`, m.includes("99.0.0 or newer") && !m.includes("cotal ext add"), m);
  }
  {
    const m = await failureFor({ scope: "@third", version: "1.0.0" });
    check("no declared range: remains an unrankable pair", m.includes("Neither side can be named as behind") && m.includes("is not a @cotal-ai/* package"), m);
    check("no declared range: is not reported as damaged metadata", !m.includes("is corrupt or unreadable"), m);
  }
  check("all import-remedy assertions ran", passed + failed === 40, { passed, failed });

  for (const name of ["no-spec-load", "no-spec-failure"]) {
    const pkg = `@third/${name}`;
    const version = "1.0.0";
    const dir = extensionPackageDir(pkg);
    const ref = { kind: "command", name };
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: pkg, version, main: "index.mjs", peerDependencies: { "@cotal-ai/core": "*" } }));
    writeFileSync(extensionsManifestPath(), JSON.stringify({ extensions: [{ pkg, version, commands: [], provides: [ref] }] }));
    const broken = name === "no-spec-failure";
    writeFileSync(join(dir, "index.mjs"), broken ? 'throw new Error("broken extension entry");\n' :
      `import { registry } from "@cotal-ai/core";\nregistry.register({ ...${JSON.stringify(ref)}, summary: "Fixture", run() {} });\n`);
    let error: unknown;
    try { await materializeFromManifest(ref); } catch (e) { error = e; }
    if (broken) {
      check("no manifest spec: a failed import keeps its cause and names the package to remove",
        error instanceof Error && error.message.includes("broken extension entry") && error.message.includes(`cotal ext remove '${pkg}'`), error);
    } else {
      check("no manifest spec: the installed extension loads and registers", !error && registry.has(ref.kind, ref.name), error);
    }
  }

  {
    const dir = extensionPackageDir("@third/entry-precedence");
    mkdirSync(join(dir, "dist"), { recursive: true });
    for (const name of ["entry", "entry.js", "export.js", "dist/index.js"]) writeFileSync(join(dir, name), "");
    const meta = { version: "1.0.0", main: "./entry" };
    check("entry resolution keeps an exact file ahead of a suffixed sibling", resolveExtensionEntry(dir, meta) === join(dir, "entry"));
    check("entry resolution keeps a root import export ahead of main", resolveExtensionEntry(dir, { ...meta, exports: { ".": { import: "./export.js" } } }) === join(dir, "export.js"));
    check("entry resolution accepts a default root export in shorthand", resolveExtensionEntry(dir, { ...meta, exports: { default: "./export.js" } }) === join(dir, "export.js"));
    check("entry resolution keeps default ahead of a later import", resolveExtensionEntry(dir, { ...meta, exports: { ".": { default: "./export.js", import: "./entry" } } }) === join(dir, "export.js"));
    check("entry resolution tries the next condition when a nested node branch does not match", resolveExtensionEntry(dir, { ...meta, exports: { ".": { node: { require: "./entry" }, default: "./export.js" } } }) === join(dir, "export.js"));
    check("entry resolution keeps main when exports declare only a subpath", resolveExtensionEntry(dir, { ...meta, exports: { "./import": "./export.js" } }) === join(dir, "entry"));
    check("entry resolution keeps an exported directory's index", resolveExtensionEntry(dir, { ...meta, exports: "./dist" }) === join(dir, "dist", "index.js"));
    check("entry resolution does not expand a missing explicit export", resolveExtensionEntry(dir, { ...meta, exports: "./export" }) === join(dir, "export"));
  }

  // The common reader's absence/corruption policy also governs peer binding and direct entry loads.
  // These are native private files, not intercepted filesystem calls.
  {
    const start = passed + failed;
    const pkg = "@third/metadata-policy";
    const dir = extensionPackageDir(pkg);
    const path = join(dir, "package.json");
    const missing = "@third/metadata-absent";
    const meta = { version: "1.0.0", main: "main.mjs", exports: { ".": "./entry.mjs" }, dependencies: { example: "1.0.0" }, peerDependencies: { "@cotal-ai/core": "*" } };
    mkdirSync(dir, { recursive: true });
    const write = () => writeFileSync(path, JSON.stringify(meta));
    const failure = (read: () => unknown): unknown => { try { read(); } catch (e) { return e; } };
    const corrupt = (e: unknown): boolean => e instanceof CorruptExtensionPackageError && e.message.includes(pkg) && e.message.includes(path);
    write();
    const snapshot = installedExtensionPackage(pkg)!;
    check("metadata: version and main are retained", snapshot.version === meta.version && snapshot.main === meta.main);
    check("metadata: exports are retained", JSON.stringify(snapshot.exports) === JSON.stringify(meta.exports));
    check("metadata: dependency declarations are retained", JSON.stringify(snapshot.dependencies) === JSON.stringify(meta.dependencies) && JSON.stringify(snapshot.peerDependencies) === JSON.stringify(meta.peerDependencies));
    check("metadata: version-only API uses the same reader", installedExtensionVersion(pkg) === meta.version);
    check("metadata: genuinely missing package remains absent", installedExtensionPackage(missing) === undefined && installedExtensionVersion(missing) === undefined);

    writeFileSync(path, "{corrupt");
    check("metadata: bad JSON names the package and file", corrupt(failure(() => installedExtensionPackage(pkg))));
    check("metadata: peer binding uses the same corruption error", corrupt(failure(() => bindExtensionPeers([pkg], pkg))));
    let entryError: unknown;
    try { await importExtensionEntry(pkg, meta.version, "fixture remedy"); } catch (e) { entryError = e; }
    check("metadata: direct entry uses the same corruption error", corrupt(entryError));
    writeFileSync(path, "{}");
    check("metadata: missing version remains corruption", corrupt(failure(() => installedExtensionPackage(pkg))));

    rmSync(path);
    mkdirSync(path);
    const directoryError = failure(() => installedExtensionPackage(pkg)) as NodeJS.ErrnoException;
    check("metadata: directory read failure is not absence", directoryError instanceof Error && directoryError.code !== "ENOENT");
    check("metadata: peer binding preserves the directory read error", (failure(() => bindExtensionPeers([pkg], pkg)) as NodeJS.ErrnoException)?.code === directoryError?.code);
    rmSync(path, { recursive: true });
    write();
    const permissions = process.platform !== "win32" && process.getuid?.() !== 0;
    if (permissions) {
      chmodSync(path, 0o000);
      try {
        check("metadata: unreadable file preserves EACCES", (failure(() => installedExtensionPackage(pkg)) as NodeJS.ErrnoException)?.code === "EACCES");
        check("metadata: peer binding preserves EACCES", (failure(() => bindExtensionPeers([pkg], pkg)) as NodeJS.ErrnoException)?.code === "EACCES");
      } finally { chmodSync(path, 0o600); }
    } else console.log("  SKIP: native EACCES checks require non-root POSIX");

    const absent: string[] = [];
    const onAbsent = (owner: string) => { absent.push(owner); };
    check("metadata: an absent sibling alone can be skipped", bindExtensionPeers([missing], pkg, { onAbsent }).length === 0 && absent.join() === missing);
    const operationError = failure(() => bindExtensionPeers([missing], missing, { onAbsent }));
    check("metadata: an absent operation package cannot be skipped", operationError instanceof Error && operationError.message.includes("not installed") && absent.length === 1);
    rmSync(path);
    check("metadata: a remaining package directory is not an absent sibling", corrupt(failure(() => bindExtensionPeers([pkg], missing, { onAbsent }))) && absent.length === 1);
    const links = process.platform !== "win32";
    if (links) {
      const dangling = "@third/metadata-dangling";
      symlinkSync(join(tmp, "missing-target"), extensionPackageDir(dangling), "dir");
      const error = failure(() => bindExtensionPeers([dangling], pkg, { onAbsent }));
      check("metadata: a dangling package link is not an absent sibling", error instanceof CorruptExtensionPackageError && absent.length === 1);
    }

    // A supplied operation snapshot must reach the binder without a second metadata read.
    writeFileSync(path, "{changed-after-read");
    const bound = bindExtensionPeers([pkg], pkg, { operationMetadata: snapshot });
    check("metadata: validated snapshot binds its declared peer without rereading", bound.length === 1 && realpathSync(bound[0]!.destination) === realpathSync(CORE_DIR));
    check("metadata: existing correct peer is not replaced by default", bindExtensionPeers([pkg], pkg, { operationMetadata: snapshot }).length === 0);
    check("metadata: force still rebinds the declared peer", bindExtensionPeers([pkg], pkg, { operationMetadata: snapshot, force: true }).length === 1);
    writeFileSync(join(dir, "entry.mjs"), 'throw new Error("snapshot-entry");\n');
    writeFileSync(join(dir, "changed.mjs"), 'throw new Error("reread-entry");\n');
    writeFileSync(path, JSON.stringify({ ...meta, main: "changed.mjs", exports: { ".": "./changed.mjs" } }));
    let snapshotError: unknown;
    try { await importExtensionEntry(pkg, meta.version, "fixture remedy", snapshot); } catch (e) { snapshotError = e; }
    check("metadata: supplied snapshot selects its original export entry", snapshotError instanceof Error && snapshotError.message.includes("snapshot-entry") && !snapshotError.message.includes("reread-entry"));
    let freshError: unknown;
    try { await importExtensionEntry(pkg, meta.version, "fixture remedy"); } catch (e) { freshError = e; }
    check("metadata: standalone entry reads its own current snapshot", freshError instanceof Error && freshError.message.includes("reread-entry"));
    check("all metadata policy assertions ran", passed + failed - start === 19 + (permissions ? 2 : 0) + (links ? 1 : 0), { checked: passed + failed - start });
  }

  // Release-extension source classification and direct workspace core-peer validation.
  {
    const releaseSpecs = [
      undefined,
      "@cotal-ai/tmux",
      "@cotal-ai/tmux@",
      "@cotal-ai/tmux@0.183.1",
      "@cotal-ai/tmux@^0.183.0",
      " @cotal-ai/tmux@latest ",
      "@cotal-ai/tmux@npm:@cotal-ai/tmux@0.183.1",
      "npm:@cotal-ai/tmux@0.183.1",
      "@cotal-ai/unlisted-pkg@1.2.3",
    ];
    for (const spec of releaseSpecs) {
      const pkg = typeof spec === "string" && spec.includes("unlisted") ? "@cotal-ai/unlisted-pkg" : "@cotal-ai/tmux";
      check(`isReleaseExtension accepts registry spec ${JSON.stringify(spec)}`, isReleaseExtension({ pkg, ...(spec === undefined ? {} : { spec }) }));
    }
    check("isReleaseExtension accepts seeded entry even with local store path", isReleaseExtension({ pkg: "@cotal-ai/web", source: "seeded", spec: "/tmp/store/0.183.1/web" }));
    const nonReleaseSpecs: Array<{ pkg: string; spec?: string }> = [
      { pkg: "third-party", spec: "third-party@1.0.0" },
      { pkg: "@other/pkg", spec: "@other/pkg@1.0.0" },
      { pkg: "@cotal-ai/local-ext", spec: "./local-ext" },
      { pkg: "@cotal-ai/local-ext", spec: "/abs/path/local-ext" },
      { pkg: "@cotal-ai/local-ext", spec: "file:../local-ext" },
      { pkg: "@cotal-ai/local-ext", spec: "@cotal-ai/local-ext@." },
      { pkg: "@cotal-ai/local-ext", spec: "@cotal-ai/local-ext@.." },
      { pkg: "@cotal-ai/local-ext", spec: "@cotal-ai/local-ext@./pkg.tgz" },
      { pkg: "@cotal-ai/local-ext", spec: "@cotal-ai/local-ext@release.tgz" },
      { pkg: "@cotal-ai/local-ext", spec: "@cotal-ai/local-ext@https://example.com/pkg.tgz" },
      { pkg: "@cotal-ai/local-ext", spec: "@cotal-ai/local-ext@github:org/repo" },
      { pkg: "@cotal-ai/local-ext", spec: "@cotal-ai/local-ext@npm:@other/pkg@1.0.0" },
      { pkg: "@cotal-ai/local-ext", spec: "npm:@cotal-ai/local-ext-other@1.0.0" },
    ];
    for (const entry of nonReleaseSpecs) {
      check(`isReleaseExtension rejects non-release spec ${JSON.stringify(entry)}`, !isReleaseExtension(entry));
    }
    for (const oddSpec of [null, 3, false, {}, []] as unknown[]) {
      check(`isReleaseExtension treats non-string spec ${JSON.stringify(oddSpec)} on @cotal-ai/* as release without throwing`, isReleaseExtension({ pkg: "@cotal-ai/tmux", spec: oddSpec }));
      check(`isReleaseExtension treats non-string spec ${JSON.stringify(oddSpec)} on third-party as non-release without throwing`, !isReleaseExtension({ pkg: "@other/pkg", spec: oddSpec }));
    }
    check("spec-less non-first-party advice still prescribes remove", extensionReinstallAdvice({ pkg: "@other/pkg", version: "1.0.0", commands: [] }).includes("cotal ext remove"));
    check("spec-less first-party release advice prescribes bare add", extensionReinstallAdvice({ pkg: "@cotal-ai/tmux", version: "1.0.0", commands: [] }).includes("cotal ext add"));
    check("non-string spec first-party advice prescribes bare add without throwing", extensionReinstallAdvice({ pkg: "@cotal-ai/tmux", version: "1.0.0", spec: null as unknown as string, commands: [] }).includes("cotal ext add"));
    check("extensionCorePeerProblem accepts wildcard and current core", extensionCorePeerProblem("@cotal-ai/local-ext", "*") === undefined && extensionCorePeerProblem("@cotal-ai/local-ext", CORE_VERSION) === undefined);
    check("extensionCorePeerProblem refuses missing, invalid, and incompatible core ranges",
      Boolean(extensionCorePeerProblem("@cotal-ai/local-ext", undefined)?.includes("does not declare @cotal-ai/core")) &&
      Boolean(extensionCorePeerProblem("@cotal-ai/local-ext", "nightly")?.includes("not a valid version range")) &&
      Boolean(extensionCorePeerProblem("@cotal-ai/local-ext", ">=99.0.0", { checkout: false })?.includes('declares @cotal-ai/core ">=99.0.0"')));
  }
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
console.log("SMOKE OK: import-remedy");
