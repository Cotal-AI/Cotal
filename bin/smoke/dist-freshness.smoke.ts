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
 * WHAT IT CANNOT SEE, stated before what it can. It compares the NEWEST mtime on each side, so it
 * proves an ORDERING and nothing else: a `dist` built from the wrong source passes as long as it is
 * newer, and one freshly-written output masks another that is stale. A deliberate
 * mutate-build-restore leaves `dist` NEWER than `src` and WRONG for the whole window, which is
 * exactly when it lies. Freshness is not correctness, and only a source/build identity manifest
 * would close that.
 *
 * AND IT PROVES THAT ORDERING ONLY AT THE START OF THE CHAIN. This is entry 1 of `smoke:ci`, and
 * EIGHT later entries rebuild `packages/core/dist` mid-chain — every one of them a
 * `pnpm --filter <pkg>... build` whose `...` suffix pulls core in as a dependency (entries 105, 129,
 * 159, 160, 161, 162, 163 and 205 at the time of writing, by position in this tree's chain). So a
 * green here describes the tree as it stood before entry 2, and says nothing about what any suite
 * after entry 105 is reading. The check cannot see a rebuild that happens after it; nothing in its
 * output suggests otherwise, which is the part worth fixing. Re-running the same check after the
 * last mid-chain build would close it, and is not done here.
 *
 * IF YOU WRITE THAT RE-RUN, IT GOES AFTER ENTRY 205, AND THE TRAP IS THE ENTRY NAMED `build`.
 * `smoke:build-current` does NOT build: its script body is a plain `tsx` run and it works in a
 * `mkdtemp` root. A scan for entries that build will match it anyway, because `\bbuild\b` matches
 * inside `build-current` — `-` is a word boundary. Two independent reads of this chain both landed
 * on "eight rebuilds" while disagreeing about WHICH eight, one of them counting `build-current` as a
 * builder and missing `smoke:persona-announce` at 205, which is a real one. The agreeing count is
 * what stopped the disagreement being noticed. Resolve the membership, not the total, and place the
 * re-run after the last entry you have confirmed by reading its script BODY.
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
 * WHAT IT MISSED, AND WHY THAT IS A DIFFERENT DEFECT FROM THE ONE ABOVE. Its subject list named two
 * packages while eighteen compile to a `dist/`, so for sixteen of them it was not weak evidence — it
 * was NO evidence, reported in the same green as the rest. That is how it missed a live case: a CLI
 * `src` edited at 07:50Z against a `dist` built at 07:42Z, with two suites green against `src` while
 * the shipped command printed the previous build's text. A hand-maintained subject list decays
 * silently and in the direction that looks fine, so the list's COMPLETENESS is now asserted against
 * the tree (`discoverBuiltPackages`) and an omission is a FAIL. Note the ordering limitation above
 * is unchanged and still applies to all eighteen: this widens the subject set, it does not
 * strengthen the predicate, and it still would not have caught a `dist` built from the wrong source.
 *
 * NOTE FOR THE NEXT PERSON WHO VERIFIES THIS CHECK: demonstrating it requires touching a source
 * file, which puts your own worktree into the state it detects. That is the check working, not a
 * defect. Content is unchanged, only the mtime moved, and the next build clears it.
 *
 * Run: pnpm smoke:dist-freshness
 */
import { readdirSync, readFileSync, statSync, existsSync } from "node:fs";
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

/**
 * Every package whose `src/` is compiled to a `dist/` that another package imports through
 * `exports`. The list is EXPLICIT rather than derived, so a reader can see its scope without
 * running it — but see {@link discoverBuiltPackages}: an omission from this list is asserted, not
 * trusted, because the list previously named two packages while eighteen shipped a `dist/`.
 */
const PACKAGES = [
  "packages/core",
  "packages/lang",
  "packages/workspace",
  "extensions/cmux",
  "extensions/connector-claude-code",
  "extensions/connector-codex",
  "extensions/connector-core",
  "extensions/connector-hermes",
  "extensions/connector-opencode",
  "extensions/herdr",
  "extensions/orca",
  "extensions/pi",
  "extensions/tmux",
  "implementations/auth",
  "implementations/cli",
  "implementations/delivery",
  "implementations/manager",
  "implementations/web",
];

/**
 * Every directory under the three package roots that has a `src/` and a `build` script — that is,
 * every package this check OUGHT to cover, computed from the tree rather than from memory.
 *
 * THIS EXISTS BECAUSE THE OMISSION WAS THE DEFECT, NOT THE PREDICATE. The predicate above was
 * correct and had been correct all along; it simply was not pointed at sixteen of the eighteen
 * packages that compile to a `dist/`, including `implementations/cli`. A hand-maintained list of
 * subjects fails silently and in the safe-looking direction: it goes GREEN while covering less and
 * less, and nothing in its output distinguishes "checked everything" from "checked two of
 * eighteen". So the list's COMPLETENESS is now itself a cell.
 */
function discoverBuiltPackages(): string[] {
  const found: string[] = [];
  for (const root of ["packages", "extensions", "implementations"]) {
    const abs = join(ROOT, root);
    if (!existsSync(abs)) continue;
    for (const e of readdirSync(abs, { withFileTypes: true })) {
      if (!e.isDirectory()) continue;
      const rel = `${root}/${e.name}`;
      if (!existsSync(join(ROOT, rel, "src"))) continue;
      const manifest = join(ROOT, rel, "package.json");
      if (!existsSync(manifest)) continue;
      const pkg = JSON.parse(readFileSync(manifest, "utf8")) as { scripts?: Record<string, string> };
      if (!pkg.scripts?.build) continue;
      found.push(rel);
    }
  }
  return found.sort();
}

let fail = 0;
console.log("dist freshness (a manager/CLI/delivery smoke tests the LAST BUILD, not your edit)\n");

// ── COMPLETENESS, asserted before freshness, because a freshness verdict over the wrong subject
//    set is worth nothing and reads exactly like one over the right set.
const discovered = discoverBuiltPackages();
// REFUSE on an empty or implausible discovery rather than pass. "Every discovered package is in
// PACKAGES" is VACUOUSLY TRUE when discovery finds nothing — and discovery finding nothing is
// precisely what a broken glob, a moved root, or a bad ROOT would produce, so the vacuous state is
// correlated with the instrument being broken. An empty set is a refusal here, never a pass.
if (discovered.length < PACKAGES.length) {
  fail++;
  console.log(`  ✗ FAIL: discovery found ${discovered.length} built package(s) but the list names ${PACKAGES.length}.`);
  console.log(`      This is a REFUSAL, not a pass: the completeness check below is vacuous over an`);
  console.log(`      empty or truncated discovery, and a broken discovery is what produces one.`);
} else {
  const missing = discovered.filter((p) => !PACKAGES.includes(p));
  const stale = PACKAGES.filter((p) => !discovered.includes(p));
  if (missing.length > 0) {
    fail++;
    console.log(`  ✗ FAIL: ${missing.length} package(s) compile to dist/ but are NOT checked: ${missing.join(", ")}`);
    console.log(`      Add them to PACKAGES. An unchecked package is not a passing package.`);
  }
  if (stale.length > 0) {
    fail++;
    console.log(`  ✗ FAIL: PACKAGES names ${stale.length} package(s) that no longer build: ${stale.join(", ")}`);
  }
  if (missing.length === 0 && stale.length === 0)
    console.log(`  ✓ completeness: all ${discovered.length} packages that compile to dist/ are covered\n`);
}

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
    // The limitation belongs HERE, where a reader meets the verdict, not only in the prologue: a ✓
    // that says "newer" reads as "correct" unless it says otherwise in the same breath.
    console.log(`  ✓ ${pkg}: dist/ is ${Math.abs(skewSec)}s newer than src/ (ORDERING ONLY - a newer-but-WRONG dist passes, and one freshly-written output masks another stale one)`);
  }
}

console.log(`\nDIST FRESHNESS ${fail === 0 ? "OK ✅" : "FAILED ❌"}`);
process.exit(fail === 0 ? 0 : 1);
