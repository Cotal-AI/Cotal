/**
 * Cells for the stale-build refusal. BOTH directions characterised, because an instrument
 * controlled in one direction is validated in one direction — and the uncontrolled direction is
 * where it gets believed anyway, since nobody re-derives a negative.
 *
 * A guard that never fires would pass every tree silently, which is the exact shape of defect it is
 * built to stop. So: a positive arm proving it CAN refuse, a negative arm proving it does not refuse
 * a current build, and a vacuity arm proving an empty package set is refused rather than passed.
 *
 * Fixtures are built in a scratch dir so the repo is never mutated to make a cell fire.
 * The real-package arm then runs against this repo, so the fixtures cannot be the whole story.
 *
 * Run: pnpm exec tsx bin/smoke/build-current.smoke.ts
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { assertBuildCurrent, buildStaleness } from "./_build-current.js";

let pass = 0, fail = 0;
const check = (name: string, cond: boolean): void => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ FAIL: ${name}`); }
};
/** Did it refuse, and with WHICH condition named? A bare "it threw" would not distinguish a stale
 *  build from a bug in the guard. */
const refusedWith = (fn: () => void, needle: string): boolean => {
  try { fn(); return false; } catch (e) { return (e as Error).message.includes(needle); }
};

const root = mkdtempSync(join(tmpdir(), "cotal-buildcur-"));
const mk = (name: string, srcMs: number, distMs?: number): string => {
  const dir = join(root, name);
  mkdirSync(join(dir, "src"), { recursive: true });
  writeFileSync(join(dir, "src", "a.ts"), "export const a = 1;\n");
  utimesSync(join(dir, "src", "a.ts"), new Date(srcMs), new Date(srcMs));
  if (distMs !== undefined) {
    mkdirSync(join(dir, "dist"), { recursive: true });
    writeFileSync(join(dir, "dist", "a.js"), "export const a = 1;\n");
    utimesSync(join(dir, "dist", "a.js"), new Date(distMs), new Date(distMs));
  }
  return dir;
};

const T = 1_700_000_000_000;
console.log("\nbuild-current — the stale-build refusal, controlled in both directions\n");

// POSITIVE ARM: it must actually fire, and name `stale`.
const stale = mk("stale-pkg", T + 60_000, T);
const s = buildStaleness(stale);
check("POSITIVE: a source newer than the build is classified `stale`", s.condition === "stale");
check("POSITIVE: the stale verdict carries the offending source path", s.condition === "stale" && s.srcPath.endsWith("a.ts"));
check("POSITIVE: the stale verdict carries how far behind the build is", s.condition === "stale" && s.behindMs === 60_000);
check("POSITIVE: assertBuildCurrent REFUSES a stale package, naming the condition", refusedWith(() => assertBuildCurrent([stale]), "(stale)"));

// NEGATIVE ARM: it must NOT fire on a current build, or the positive arm proves nothing.
const current = mk("current-pkg", T, T + 60_000);
check("NEGATIVE: a build newer than its source is classified `current`", buildStaleness(current).condition === "current");
let threw = false;
try { assertBuildCurrent([current]); } catch { threw = true; }
check("NEGATIVE: assertBuildCurrent does NOT refuse a current package", !threw);

// A never-built package is its own condition, not folded into `stale`: "never run" and "run an old
// version" are different facts and a surface that collapses them cannot say which failed.
const unbuilt = mk("unbuilt-pkg", T);
check("never-built is its OWN condition, not collapsed into `stale`", buildStaleness(unbuilt).condition === "never-built");
check("assertBuildCurrent REFUSES a never-built package, naming that condition", refusedWith(() => assertBuildCurrent([unbuilt]), "(never-built)"));

// VACUITY ARM: a check over an empty set must refuse, not pass. `.every()` over an empty set is
// true; that is how a guard becomes decoration.
check("VACUITY: an empty package list is REFUSED, not vacuously passed", refusedWith(() => assertBuildCurrent([]), "no packages"));

// REAL-PACKAGE ARM: the fixtures above prove the function; this proves it is pointed at something
// real. `implementations/cli` is the package whose `main` resolves to dist/ and which every live
// CLI suite actually executes.
const repo = resolve(import.meta.dirname, "..", "..");
const cliPkg = join(repo, "implementations", "cli");
const real = buildStaleness(cliPkg);
console.log(`  · implementations/cli → ${real.condition}${real.condition === "stale" ? ` (${real.behindMs}ms behind)` : ""}`);
check("REAL: the cli package is classified with a known condition, not silently skipped",
  ["current", "stale", "never-built"].includes(real.condition));

// PARTIAL BUILD — the fail-open found in review, kept as a named regression cell.
// The original guard compared the newest source against the NEWEST output, so one fresh unrelated
// output masked a stale one: precisely what an interrupted or errored build leaves on disk. Every
// synthetic package above has ONE source and ONE output, which is why they all missed it.
const partial = join(root, "partial-pkg");
mkdirSync(join(partial, "src"), { recursive: true });
mkdirSync(join(partial, "dist"), { recursive: true });
const stamp = (p: string, ms: number): void => { writeFileSync(p, "x\n"); utimesSync(p, new Date(ms), new Date(ms)); };
stamp(join(partial, "dist", "a.js"), T);            // stale output …
stamp(join(partial, "src", "a.ts"), T + 60_000);    // … behind its source
stamp(join(partial, "src", "b.ts"), T + 120_000);
stamp(join(partial, "dist", "b.js"), T + 180_000);  // an unrelated FRESH output, newest overall
const part = buildStaleness(partial);
check("PARTIAL BUILD: one fresh output does NOT mask a stale one", part.condition === "stale");
check("PARTIAL BUILD: the verdict names the OUTPUT that is behind, not just the source",
  part.condition === "stale" && part.distPath.endsWith("a.js"));
check("PARTIAL BUILD: assertBuildCurrent REFUSES it", refusedWith(() => assertBuildCurrent([partial]), "(stale)"));
// INVERSE: a package whose outputs are ALL newer than every source must still pass, or the stricter
// rule has simply broken the guard into refusing everything.
const allFresh = join(root, "allfresh-pkg");
mkdirSync(join(allFresh, "src"), { recursive: true });
mkdirSync(join(allFresh, "dist"), { recursive: true });
stamp(join(allFresh, "src", "a.ts"), T);
stamp(join(allFresh, "src", "b.ts"), T + 1_000);
stamp(join(allFresh, "dist", "a.js"), T + 60_000);
stamp(join(allFresh, "dist", "b.js"), T + 61_000);
check("INVERSE: a fully rebuilt multi-file package is still `current`", buildStaleness(allFresh).condition === "current");

// A MISSING package must not be dressed up as a build fact. Before this split, a typo'd path
// returned `no-source` and refused with "run pnpm build" — an instruction that cannot fix it, while
// the package the caller meant to check went unexamined and unmentioned.
const missing = join(root, "no-such-pkg");
check("a nonexistent package dir is `no-package`, NOT `no-source`", buildStaleness(missing).condition === "no-package");
check("the no-package refusal does NOT claim to be a build verdict",
  refusedWith(() => assertBuildCurrent([missing]), "NOT a verdict about any build"));
check("the no-package refusal does NOT tell the caller to run pnpm build",
  !refusedWith(() => assertBuildCurrent([missing]), "pnpm build"));
// INVERSE CONTROL for the line above: the phrase IS present on a genuine stale verdict, so its
// absence above is a property of the no-package arm and not of the matcher.
check("INVERSE: a genuine stale refusal DOES tell the caller to run pnpm build",
  refusedWith(() => assertBuildCurrent([stale]), "pnpm build"));

// ---- the CLI front end: exit codes read from a real spawn, never inferred -----------------------
// 94 (a build verdict) and 95 (the guard could not run) are separate because the first inline
// version of this guard failed to load and its caller printed "REFUSING TO MEASURE: stale build" —
// a confident claim about a build that had never been examined.
const guard = join(import.meta.dirname, "assert-build-current.ts");
const rcOf = (...argv: string[]): number =>
  spawnSync(process.execPath, ["--import", "tsx", guard, ...argv], { encoding: "utf8" }).status ?? -1;

check("EXIT 0: a current package exits 0", rcOf(cliPkg) === 0);
check("EXIT 94: a stale package exits 94 (a build verdict)", rcOf(stale) === 94);
check("EXIT 94: a never-built package exits 94 (also a build verdict)", rcOf(unbuilt) === 94);
check("EXIT 95: a MISSING package exits 95, not 94 — the guard could not run", rcOf(missing) === 95);
check("EXIT 95: no arguments exits 95, not 0 — a guard called with nothing must not pass", rcOf() === 95);

console.log(`\nbuild-current: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
