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
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import type { ExtensionRef } from "@cotal-ai/core";
import { extensionsDir, hostPackageDir, importInstalledExtension, type InstalledExtension } from "@cotal-ai/workspace";

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
    check("lockstep, extension newer: points at the install that owns that core", m.includes(`upgrade the cotal that owns ${CORE_DIR}`), m);
  }

  // 2. A declared floor above the linked core is the extension's OWN statement that it needs a newer
  //    peer. It ranks a third-party extension, whose version number says nothing on its own.
  {
    const m = await failureFor({ scope: "@third", version: "1.0.0", peerRange: ">=99.0.0" });
    check("declared floor above the linked core: names the CORE as behind", m.includes("The installed @cotal-ai/core is BEHIND"), m);
    check("declared floor above the linked core: quotes the declared range", m.includes(">=99.0.0"), m);
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
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
console.log("SMOKE OK: import-remedy");
