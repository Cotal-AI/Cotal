/**
 * Every suite this lane touches must import the code it tests by SOURCE path, not by package name.
 *
 * WHY. A suite importing `@cotal-ai/<pkg>` resolves to that package's built `dist/`. Mutating the
 * source then changes nothing the suite executes: the run comes back fully green, and green is
 * indistinguishable from "the mutation never ran". I hit exactly that — mutated `launch.ts`,
 * verified the edit was in the source, watched the suite pass, and nearly reported a SURVIVED cell
 * for a mutation that had not executed. The guard built to prevent false coverage reports was
 * itself checking the file I edited rather than the file that ran.
 *
 * The fix was not "remember to rebuild". A protocol step is a remembered guard, and the person who
 * skipped it had written it an hour earlier. This asserts the ARRANGEMENT that makes the failure
 * impossible: source-relative imports, so a mutation cannot land on stale bytes at all.
 *
 * **THE SUITE LIST IS DERIVED FROM GIT, NOT HAND-MAINTAINED — and that is the point.** An earlier
 * version enumerated the suites by hand. It would have caught a listed suite missing from disk, and
 * been blind to the reverse: a suite ADDED to disk that nobody listed. During the cutover, when
 * suites are added fastest and attention is elsewhere, that blind spot widens silently while the
 * guard reports green. Deriving the set from the lane's own diff means a new suite is covered the
 * moment it exists, with no list to forget — the same choice as preferring an arrangement over a
 * check, one level up.
 *
 * Scope: suites in this lane's diff against `origin/main`. It deliberately does not police the whole
 * repo, where other packages may have reasons of their own.
 *
 * **WHAT THIS GUARD DOES NOT COVER, stated here because its absence was read as coverage.** It
 * checks that a suite imports its OWN package by source path. It says NOTHING about a
 * **cross-package** dependency: a suite can import its own package from `../src/`, and that source
 * can import a DIFFERENT first-party package by name, which resolves to that package's `dist/`.
 * A mutation to the other package's source then reaches nothing, and the run is green for want of
 * executing at all.
 *
 * That is not hypothetical. `event-channel.smoke.ts` imports `../src/launch.js` and passed this
 * guard, while the rule it was asserting lived in `packages/core` and was reached through
 * `@cotal-ai/core` — so deleting that rule at the source left every refusal cell green. Found by
 * fmae-rev-test, on cells written one commit after this guard's own author described the hazard.
 *
 * The remedy for that case was not to widen this guard — the relationship is legitimate and common,
 * and a check that banned it would collect exemptions until it meant nothing. It was to put the
 * rule's cells beside the rule (`packages/core/smoke/valid-name.smoke.ts`, importing `../src/`) and
 * to make the cross-package suite compare the executed rule against the source one, so a stale
 * `dist/` fails a NAMED cell instead of passing silently.
 *
 * **The general form, which is the reason this paragraph exists at all: when you scope a guard,
 * name the relationships it does not cover — inside the guard — or its coverage is read as total.**
 *
 * Run: pnpm smoke:mutation-reachable
 */
import { readFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";

let ok = 0, fail = 0;
const c = (n: string, v: boolean, extra?: unknown) => {
  if (v) ok++; else { fail++; console.log("  x FAIL:", n, extra ?? ""); }
};

const root = execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();

/**
 * Every `*.smoke.ts` this lane added or changed — TRACKED **and UNTRACKED**.
 *
 * The untracked half is not an afterthought. A first version derived the set from `git diff` alone,
 * and a brand-new suite dropped into the tree — the exact cutover case this guard is for — was
 * invisible, because it is not a *change* to a tracked file until someone stages it. The guard
 * reported green over a suite importing by package name. A derivation that misses the newest files
 * is the same blind spot as a hand-maintained list, arriving through a different door.
 */
const gitLines = (args: string[]): string[] =>
  execFileSync("git", args, { cwd: root, encoding: "utf8" }).split("\n").map((l) => l.trim()).filter(Boolean);

const suites = [
  ...gitLines(["diff", "--name-only", "origin/main...HEAD", "--", "*.smoke.ts"]),
  ...gitLines(["ls-files", "--others", "--exclude-standard", "--", "*.smoke.ts"]),
  ...gitLines(["diff", "--name-only", "--", "*.smoke.ts"]),
].filter((f, i, all) => all.indexOf(f) === i && existsSync(join(root, f)));

// An empty sweep is a broken check, not a clean surface — the lesson from a comment sweep that
// reported 0 examined and would have read as a clean result.
c("the derived suite set is non-empty (an empty sweep would be a broken check, not a clean one)",
  suites.length > 0, suites.length);

/** The package a file belongs to: walk up to the nearest package.json and read its name. */
function owningPackage(fileRel: string): string | undefined {
  let dir = join(root, dirname(fileRel));
  while (dir.startsWith(root)) {
    const pkg = join(dir, "package.json");
    if (existsSync(pkg)) {
      try { return (JSON.parse(readFileSync(pkg, "utf8")) as { name?: string }).name; } catch { return undefined; }
    }
    const up = dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return undefined;
}

const sourceImporting: string[] = [], fileReading: string[] = [], assembledOnly: string[] = [];
for (const rel of suites) {
  const own = owningPackage(rel);
  // A suite whose package cannot be resolved is a FAILURE, not a skip: skipping would quietly
  // shrink the guard's universe, which is the exact defect this derivation exists to remove.
  if (!own) { c(`${rel}: its owning package resolves`, false, "no package.json found above it"); continue; }
  const src = readFileSync(join(root, rel), "utf8");
  // Its OWN package must be imported by relative source path, never by package name — that is the
  // import a mutation has to reach. Importing a DIFFERENT first-party package is fine: that code is
  // not what this suite mutates, and a blanket ban would collect exemptions until it meant nothing.
  const byName = new RegExp(`from\\s+["']${own.replace(/[/@\\-]/g, "\\$&")}["']`).test(src);
  // ABSENCE of the bad import is only half of it, and the label used to claim the other half it did
  // not check: a suite importing NOTHING from its own package passed, because `!byName` is true of a
  // file with no production import at all. Found by fmae-rev-test, which added an untracked smoke
  // containing one `console.log` and watched the derived set grow while the guard stayed green.
  // The claim was "imports its own package by SOURCE path"; the check was "does not import it by
  // name". Same shape as every other defect this lane closed: the sentence was stronger than the
  // instrument under it.
  c(`${rel.split("/").pop()} does NOT import its own package ("${own}") by name`, !byName,
    byName ? `imports "${own}" — a mutation to its source would never reach this suite` : undefined);

  // HOW does this suite reach the code it grades? Three honest answers, and the point is that the
  // third exists rather than being quietly counted as the first.
  const bySource = /from\s+["']\.\.?\//.test(src);
  const byReading = /readFileSync|execFileSync|readdirSync/.test(src);
  if (bySource) sourceImporting.push(rel);
  else if (byReading) fileReading.push(rel);
  else assembledOnly.push(rel);
}

// The set that CANNOT be reached by a source mutation, named rather than hidden.
//
// A suite reaching its subject only through package-name imports grades the ASSEMBLED product —
// which is what `dist/` is — so a source mutation will not redden it. For `bin/` composition-root
// parity suites that is the intent, not a defect: they exist to check that the pieces agree once
// built. What is NOT acceptable is letting them be counted as source-reachable, which is what this
// guard did while its label claimed otherwise.
//
// This is reported, not failed. A permanently-red cell for something deliberate would normalise red
// and the next reader would learn to skim it — the same reason a known-open defect is kept off the
// gate rather than gated and ignored.
c("every suite is classified, so none is silently assumed source-reachable",
  sourceImporting.length + fileReading.length + assembledOnly.length === suites.length,
  { sourceImporting: sourceImporting.length, fileReading: fileReading.length, assembledOnly: assembledOnly.length });
if (assembledOnly.length)
  console.log(`  [named] ${assembledOnly.length} suite(s) grade the ASSEMBLED product and are NOT source-mutation-reachable:\n` +
    assembledOnly.map((f) => `      ${f}`).join("\n"));

console.log(`mutation-reachable smoke: ${ok} passed, ${fail} failed (${suites.length} suites derived from the lane diff)`);
if (fail > 0) process.exit(1);
