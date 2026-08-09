/**
 * Fail when a package's built `dist/` is older than its `src/`.
 *
 * In this repo a passing smoke means different things depending on where it lives, and nothing in
 * the output says which:
 *   - CORE smokes import `../src/index.js`. They read SOURCE and test your edit immediately.
 *   - MANAGER, CLI and DELIVERY smokes import `@cotal-ai/core`. That resolves through a relative
 *     symlink to `packages/core`, whose `exports` point at `dist/`. They test THE LAST BUILD.
 *
 * So "I edited core and the manager smoke passed" is not evidence about your edit unless you
 * rebuilt in between — and it reads exactly like evidence. That is not hypothetical: it is a claim
 * I made and had to retract tonight, having run a manager suite and a contract-import check against
 * a core that did not contain the change I was verifying. The conclusion happened to survive
 * because the full gate rebuilds first, but the intermediate evidence was worthless and looked
 * fine.
 *
 * BE HONEST ABOUT WHERE THIS BITES. In `smoke:ci` it is nearly inert, because the gate builds
 * before it runs — it can only catch a build that silently produced nothing for a package. Its real
 * use is the ad-hoc case: run it after editing core and before trusting a manager-side suite. That
 * makes it a better instruction, not yet a ratchet, and the distinction matters because instructions
 * are the form that leaks — the person who most needs one is the person not thinking about it.
 *
 * THE VERSION THAT WOULD ACTUALLY RATCHET is a startup assertion inside every suite that reads
 * `dist`, so the check runs whether or not anyone remembered. 104 suites import `@cotal-ai/core`,
 * and there is no chokepoint to hang it on: the most-shared test helper reaches 16 of them. The one
 * universal path is core's own entry module, and that is the SHIPPED artifact (`files: ["dist"]`),
 * so a development-time check there would ride into every customer install. It would even no-op
 * safely, since a published install has no `src/` — which is exactly why it is tempting and exactly
 * why it does not go there. Recorded as a residual: the real fix is a shared smoke harness that
 * creates the chokepoint, which is a project rather than a patch.
 *
 * NOTE FOR THE NEXT PERSON WHO VERIFIES THIS CHECK: demonstrating it requires touching a source
 * file, which puts your own worktree into the state it detects. That is the check working, not a
 * defect. Content is unchanged, only the mtime moved, and the next build clears it.
 *
 * Run: pnpm smoke:dist-freshness
 */
import { readdirSync, statSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** Newest mtime under a directory, or null when it does not exist. Ignores sourcemaps and
 *  buildinfo: `.tsbuildinfo` is rewritten on a no-op build and would make a stale `dist` look
 *  fresh, which is the one error this check must not make. */
function newestMtime(dir: string, exts: string[]): { path: string; ms: number } | null {
  if (!existsSync(dir)) return null;
  let best: { path: string; ms: number } | null = null;
  const walk = (d: string): void => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) { walk(p); continue; }
      if (!exts.some((x) => e.name.endsWith(x))) continue;
      const ms = statSync(p).mtimeMs;
      if (!best || ms > best.ms) best = { path: p, ms };
    }
  };
  walk(dir);
  return best;
}

const PACKAGES = ["packages/core", "packages/workspace"];

let fail = 0;
console.log("dist freshness (a manager/CLI/delivery smoke tests the LAST BUILD, not your edit)\n");

for (const pkg of PACKAGES) {
  const src = newestMtime(join(ROOT, pkg, "src"), [".ts"]);
  const dist = newestMtime(join(ROOT, pkg, "dist"), [".js"]);
  if (!src) { console.log(`  - ${pkg}: no src/, skipped`); continue; }
  if (!dist) {
    fail++;
    console.log(`  ✗ FAIL: ${pkg} has src/ but NO BUILT dist/. Any suite importing it tests nothing. Run: pnpm -r build`);
    continue;
  }
  const skewSec = Math.round((src.ms - dist.ms) / 1000);
  if (src.ms > dist.ms) {
    fail++;
    console.log(`  ✗ FAIL: ${pkg} dist/ is ${skewSec}s OLDER than src/.`);
    console.log(`      newest src:  ${src.path.replace(ROOT + "/", "")}`);
    console.log(`      newest dist: ${dist.path.replace(ROOT + "/", "")}`);
    console.log(`      A suite importing this package would test the previous build. Run: pnpm -r build`);
  } else {
    console.log(`  ✓ ${pkg}: dist/ is ${Math.abs(skewSec)}s newer than src/`);
  }
}

console.log(`\nDIST FRESHNESS ${fail === 0 ? "OK ✅" : "FAILED ❌"}`);
process.exit(fail === 0 ? 0 : 1);
