/**
 * Import-failure remedy smoke (no NATS). Run: pnpm smoke:import-remedy
 *
 * An installed extension that imports a symbol its linked `@cotal-ai/*` peer does not export is a
 * SKEW between two installs. The remedy depends on which of them is behind, so these cells drive the
 * real entry point (`importInstalledExtension`) with real self-registering packages and read the
 * message it throws: each of the four rankings must name the missing symbol, the peer copy it
 * resolved against (path AND version), and a side — and only the ranking where the EXTENSION is
 * older may prescribe `cotal ext add`.
 *
 * Fixtures live under a temp cotal config home (XDG_CONFIG_HOME) inside the repo, so each one's
 * `@cotal-ai/core` resolves to the repo copy this smoke also measures against.
 */
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import type { ExtensionRef } from "@cotal-ai/core";
import { bindExtensionPeers, CorruptExtensionPackageError, extensionPackageDir, extensionsDir, hostPackageDir, importExtensionEntry, importInstalledExtension, installedExtensionPackage, installedExtensionVersion, type InstalledExtension } from "@cotal-ai/workspace";
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

  // 3. Equal versions cannot be a version skew, so the remaining explanation is a stale BUILD — and
  //    the remedy is to rebuild the launcher, never to reinstall the extension.
  {
    const m = await failureFor({ scope: "@cotal-ai", version: CORE_VERSION, peerRange: ">=0.1.0" });
    check("equal versions: reports a build skew, not a version skew", m.includes("Same version, different build"), m);
    check("equal versions: prescribes rebuilding the install that owns the core", m.includes(`rebuild or reinstall the cotal that owns ${CORE_DIR}`), m);
    check("equal versions: does NOT prescribe reinstalling the extension", !m.includes("cotal ext add"), m);
  }

  // 4. The one ranking where reinstalling the extension IS the remedy.
  {
    const m = await failureFor({ scope: "@cotal-ai", version: "0.0.1", peerRange: ">=0.1.0" });
    check("lockstep, extension older: names the EXTENSION as the older side", m.includes("The extension is the older side"), m);
    check("lockstep, extension older: keeps the `cotal ext add` remedy", m.includes("cotal ext add @cotal-ai/remedy-"), m);
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
    check("control, non-export failure: keeps the plain reinstall remedy", m.includes("cotal ext add @cotal-ai/remedy-"), m);
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
  check("all import-remedy assertions ran", passed + failed === 36, { passed, failed });

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
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
console.log("SMOKE OK: import-remedy");
