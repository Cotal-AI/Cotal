/**
 * Boundary guard. Two rails, both about which layer may depend on which, both broker-free.
 *
 * 1. Nothing under `packages/core/src/**` may import `@cotal-ai/workspace`. `@cotal-ai/core` is the
 *    wire standard; the machine-local workstation layer (`@cotal-ai/workspace`) depends on core,
 *    never the reverse. A core→workspace import would re-fuse the two faces this split exists to
 *    separate — and introduce a dependency cycle.
 *
 * 2. No shipped file may import `@cotal-ai/smoke-kit` — every `src/**` tree in the workspace, plus
 *    the two top-level entry points of the published `cotal-ai` package, which has no `src` tree of
 *    its own. The kit is test-only and private, so it is never published: a shipped file importing
 *    it would compile here and be missing at install time. That is the kind of break that shows up
 *    at a customer rather than in CI, which is why the rail is enforced here instead of written
 *    down and hoped for.
 *
 * 3. `@cotal-ai/smoke-kit` stays private and declares no dependencies. That second half is not
 *    tidiness: `private: true` on its own exempts nothing from the release train — changesets bumps
 *    dependents, so a private package that declares a first-party dependency is versioned like any
 *    other. Zero dependencies is what actually keeps it out, so it is a rail rather than a habit.
 *
 * Keeps both boundaries honest, not decorative. Runs in the `check` gate and CI.
 * Run: pnpm smoke:core-boundary
 */
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative } from "node:path";

const repo = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const coreSrc = join(repo, "packages", "core", "src");

function tsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...tsFiles(p));
    else if (e.name.endsWith(".ts")) out.push(p);
  }
  return out;
}

let failed = false;

// Rail 1: core must not reach into the workstation layer.
const coreFiles = tsFiles(coreSrc);
const coreOffenders = coreFiles.filter((f) => /["']@cotal-ai\/workspace["']/.test(readFileSync(f, "utf8")));
if (coreOffenders.length) {
  failed = true;
  console.error("✗ core must not import @cotal-ai/workspace — the dependency runs workspace → core:");
  for (const f of coreOffenders) console.error(`  - ${relative(repo, f)}`);
}

// Rail 2: the test-only kit must not reach shipped code. Every `src` tree in the workspace is
// scanned, including the kit's own, so nothing is exempt by being close to it.
const srcRoots: string[] = [];
for (const tier of ["packages", "implementations", "extensions"]) {
  const tierDir = join(repo, tier);
  if (!existsSync(tierDir)) continue;
  for (const e of readdirSync(tierDir, { withFileTypes: true })) {
    const src = join(tierDir, e.name, "src");
    if (e.isDirectory() && existsSync(src)) srcRoots.push(src);
  }
}

// A guard that scans nothing returns zero and reads as healthy. If the tiers are ever renamed this
// stops the suite rather than letting it report a clean sweep of an empty set.
if (srcRoots.length === 0) {
  console.error("✗ core-boundary scanned no src trees at all — the layout moved and this guard is measuring nothing");
  process.exit(1);
}

// Specifier-shaped, so the rail is about what the file IMPORTS, not about the package being named
// in prose. This file names it in its own docblock, and so does the kit's.
const KIT_IMPORT = /(?:^|\n)[^\n]*(?:import|export|require)[^\n]*["']@cotal-ai\/smoke-kit["']/;
// `bin` is the published `cotal-ai` package and has no `src` tree: its shipped entry points sit at
// the top level, next to `smoke/` and `scripts/`, which are not shipped. Scanning the two entry
// points by name rather than the directory keeps the exact package a customer installs in scope
// without dragging its own smokes in — the one blind spot that would have mattered most.
const binEntries = ["cotal.ts", "run.ts"].map((f) => join(repo, "bin", f)).filter((f) => existsSync(f));
if (binEntries.length !== 2) {
  console.error(`✗ core-boundary expected bin/cotal.ts and bin/run.ts, found ${binEntries.length} — the published entry points moved`);
  process.exit(1);
}
const kitFiles = [...srcRoots.flatMap(tsFiles), ...binEntries];
const kitOffenders = kitFiles.filter((f) => KIT_IMPORT.test(readFileSync(f, "utf8")));
if (kitOffenders.length) {
  failed = true;
  console.error("✗ @cotal-ai/smoke-kit is test-only and unpublished — no shipped file may import it:");
  for (const f of kitOffenders) console.error(`  - ${relative(repo, f)}`);
}

// Rail 3: the kit stays exempt from the release train, and the exemption has a REASON that has to
// hold. `private: true` alone does not exempt anything — measured: a private example package with no
// `ignore` entry is versioned anyway, because changesets bumps dependents and that example declares
// a first-party dependency. What actually keeps the kit out is that it declares no dependencies at
// all, so nothing can bump it as a dependent, plus its absence from the `fixed` allowlist. That
// makes zero-dependencies load-bearing rather than stylistic, so it is asserted here instead of
// resting on a one-time check nobody re-runs.
//
// Read with no `existsSync` guard on purpose. A missing file must stop this suite, not skip a rail:
// an `if (exists)` here would turn "the kit was moved or renamed" into a silent pass, which is the
// same reassuring zero the empty-scan check above exists to refuse.
const kitPkgPath = join(repo, "packages", "smoke-kit", "package.json");
const kitPkg = JSON.parse(readFileSync(kitPkgPath, "utf8")) as Record<string, unknown>;
const depKeys = ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"]
  .filter((k) => kitPkg[k] !== undefined);
if (depKeys.length) {
  failed = true;
  console.error(`✗ @cotal-ai/smoke-kit must declare no dependencies — it declares ${depKeys.join(", ")}:`);
  console.error("  a first-party dependency would pull it into the release train as a dependent");
}
if (kitPkg["private"] !== true) {
  failed = true;
  console.error("✗ @cotal-ai/smoke-kit must stay private: true — it is test-only and must never publish");
}

if (failed) process.exit(1);

console.log(`core-boundary smoke: ${coreFiles.length} core/src files scanned, 0 import @cotal-ai/workspace`);
console.log(`core-boundary smoke: ${kitFiles.length} shipped files across ${srcRoots.length} src trees plus the bin entry points scanned, 0 import @cotal-ai/smoke-kit`);
console.log("core-boundary smoke: @cotal-ai/smoke-kit is private and declares no dependencies of any kind");
process.exit(0);
