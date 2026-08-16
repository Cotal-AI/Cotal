#!/usr/bin/env node
/**
 * Self-test for `mutation-proof.mjs`.
 *
 * The tool exists because a check that cannot fail is indistinguishable, in every log, from a check
 * that passed. That applies to the tool. **A mutation harness that can never report SURVIVED is the
 * undiscriminating instrument it was built to detect**, so this drives it against a throwaway fixture
 * where the right answer is known in advance, including the answers that are supposed to be bad.
 *
 * Fast on purpose: a temp git repo, a two-line "implementation", and a "suite" that is a shell exit
 * code. Seconds, not the minutes a real smoke costs — so there is no reason to skip it.
 *
 * Run: node scripts/mutation-proof.selftest.mjs
 */
import { mkdtempSync, writeFileSync, rmSync, readFileSync, mkdirSync } from "node:fs";
import { execSync, spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const TOOL = join(dirname(fileURLToPath(import.meta.url)), "mutation-proof.mjs");
const root = mkdtempSync(join(tmpdir(), "mutation-selftest-"));
let pass = 0;
const check = (name, cond, extra) => {
  if (!cond) {
    console.error(`\n  ✗ ${name}${extra !== undefined ? ` — ${JSON.stringify(extra)}` : ""}`);
    rmSync(root, { recursive: true, force: true });
    process.exit(1);
  }
  pass++;
  console.log(`  ✓ ${name}`);
};

// ---- a fixture repo: one guard, one suite that depends on it, one that does not ----------------
mkdirSync(join(root, "src"), { recursive: true });
writeFileSync(
  join(root, "src/impl.js"),
  [
    "export function admit(n) {",
    "  // the guard under test; the compiled shape puts the statement on its own line",
    "  if (n > 10)",
    "    return false;",
    "  return true;",
    "}",
    "export const unrelated = () => 'untouched';",
    "",
  ].join("\n"),
);
// A "suite": prints progress marks, exits non-zero with a named assertion when the guard is gone.
writeFileSync(
  join(root, "suite.mjs"),
  [
    "import { admit } from './src/impl.js';",
    "console.log('  ✓ admits a small value');",
    "if (admit(5) !== true) { console.error('AssertionError: small values are admitted'); process.exit(1); }",
    "console.log('  ✓ the guard refuses an oversized value');",
    "if (admit(50) !== false) { console.error('AssertionError: oversized values are refused'); process.exit(1); }",
    "console.log('  ✓ done');",
    "",
  ].join("\n"),
);
execSync("git init -q && git add -A && git -c user.email=a@b -c user.name=c commit -qm fixture", { cwd: root });

const runTool = (args) =>
  spawnSync(process.execPath, [TOOL, ...args], { cwd: root, encoding: "utf8", timeout: 120_000 });

// 1. A mutation the suite DOES catch, named. The everyday case.
let r = runTool([
  "--command", `${process.execPath} suite.mjs`,
  "--file", "src/impl.js",
  "--find", "if (n > 10)\n    return false;",
  "--replace", "if (false)\n    return false;",
  "--expect-red", "oversized values are refused",
]);
check("a killed mutation exits 0 and reports KILLED", r.status === 0 && r.stdout.includes("KILLED"), r.stdout.slice(-300));
check("...and a multi-line target matches (the compiled shape of a guard)", !r.stdout.includes("not found"));

// 2. THE ONE THAT MATTERS: a mutation the suite does NOT catch must be reported, not passed.
r = runTool([
  "--command", `${process.execPath} suite.mjs`,
  "--file", "src/impl.js",
  "--find", "'untouched'",
  "--replace", "'mutated'",
  "--expect-red", "never printed",
]);
check("a SURVIVED mutation is reported and exits non-zero", r.status !== 0 && r.stdout.includes("SURVIVED"), r.stdout.slice(-300));

// 3. A target that does not exist must ERROR, never silently grade.
r = runTool([
  "--command", `${process.execPath} suite.mjs`,
  "--file", "src/impl.js",
  "--find", "this string is not in the file",
  "--replace", "x",
]);
// This cell went red silently when the preflight landed and nothing told me, because nothing runs
// this file: it moved the refusal from a per-mutation ERROR line to an upfront refusal, which is
// the better behaviour and a different surface. So the cell now asserts the INTENT — an absent
// target never grades anything — rather than the word the old surface happened to print.
check("an absent target is refused, not graded", r.status !== 0 && r.stdout.includes("not found"), r.stdout.slice(-300));
check("...and nothing is graded under it", !r.stdout.includes("mutation(s) did not produce"), r.stdout.slice(-300));

// 4. An ambiguous target must ERROR: the experiment must change only what was named.
r = runTool([
  "--command", `${process.execPath} suite.mjs`,
  "--file", "src/impl.js",
  "--find", "return",
  "--replace", "return",
]);
check("an ambiguous target is refused", r.status !== 0 && r.stdout.includes("appears"), r.stdout.slice(-200));

// 5. Red for the WRONG reason must not read as proof.
r = runTool([
  "--command", `${process.execPath} suite.mjs`,
  "--file", "src/impl.js",
  "--find", "if (n > 10)\n    return false;",
  "--replace", "throw new Error('unrelated explosion');",
  "--expect-red", "oversized values are refused",
]);
check("red for an unnamed reason is WRONG-RED, not KILLED", r.status !== 0 && r.stdout.includes("WRONG-RED"), r.stdout.slice(-300));

// 6. A dirty tree is refused: git must be the recovery, not this tool.
writeFileSync(join(root, "src/impl.js"), readFileSync(join(root, "src/impl.js"), "utf8") + "\n// dirty\n");
r = runTool([
  "--command", `${process.execPath} suite.mjs`,
  "--file", "src/impl.js",
  "--find", "if (n > 10)",
  "--replace", "if (false)",
]);
check("a dirty tree is refused before anything is mutated", r.status !== 0 && r.stdout.includes("dirty"), r.stdout.slice(-200));
execSync("git checkout -- .", { cwd: root });

// 7. An already-red suite is refused: it would grade every mutation as KILLED.
writeFileSync(join(root, "broken.mjs"), "console.error('AssertionError: pre-existing'); process.exit(1);\n");
execSync("git add -A && git -c user.email=a@b -c user.name=c commit -qm broken", { cwd: root });
r = runTool([
  "--command", `${process.execPath} broken.mjs`,
  "--file", "src/impl.js",
  "--find", "if (n > 10)",
  "--replace", "if (false)",
]);
check("a suite that is already red is refused", r.status !== 0 && r.stdout.includes("red BEFORE any mutation"), r.stdout.slice(-200));

// 7b. A boolean flag must be typeable. `--allow-dirty` paired with the next token, so alone it
// parsed as undefined and the guard never saw it: a documented escape hatch that could not be used.
writeFileSync(join(root, "src/impl.js"), readFileSync(join(root, "src/impl.js"), "utf8") + "\n// dirty\n");
r = runTool([
  "--command", `${process.execPath} suite.mjs`,
  "--file", "src/impl.js",
  "--find", "if (n > 10)\n    return false;",
  "--replace", "if (false)\n    return false;",
  "--expect-red", "oversized values are refused",
  "--allow-dirty",
]);
check("bare --allow-dirty is honoured, not swallowed as a value", r.stdout.includes("KILLED") && !r.stdout.includes("REFUSING"), r.stdout.slice(-260));
execSync("git checkout -- .", { cwd: root });

// 7c. A mutation at the suite's FIRST assertion has zero preceding progress marks. The tick floor is
// a heuristic; a matched expectRed is direct evidence, and the heuristic must not overrule it.
writeFileSync(
  join(root, "first.mjs"),
  [
    "import { admit } from './src/impl.js';",
    "if (admit(50) !== false) { console.error('AssertionError: oversized values are refused'); process.exit(1); }",
    "console.log('  ✓ the guard refuses an oversized value');",
    "",
  ].join("\n"),
);
execSync("git add -A && git -c user.email=a@b -c user.name=c commit -qm first", { cwd: root });
r = runTool([
  "--command", `${process.execPath} first.mjs`,
  "--file", "src/impl.js",
  "--find", "if (n > 10)\n    return false;",
  "--replace", "if (false)\n    return false;",
  "--expect-red", "oversized values are refused",
]);
check("a named red at the FIRST assertion is KILLED, not WRONG-RED", r.status === 0 && r.stdout.includes("KILLED"), r.stdout.slice(-300));

// 7d. A CONFIG KEY THE TOOL DOES NOT KNOW IS REFUSED BY NAME. This is the quietest failure the
// tool has: a misspelt `expectRed` is not an error, it is an ABSENT `expectRed`, and every mutation
// under it then reports KILLED on any red at all — including a crash that never reached the guard.
// So the mutation below is the same mutation as cell 1, and the ONLY difference is the typo.
const cfgPath = join(root, "mut.json");
const baseMutation = {
  name: "the oversize guard is disabled",
  file: "src/impl.js",
  find: "if (n > 10)\n    return false;",
  replace: "if (false)\n    return false;",
};
writeFileSync(cfgPath, JSON.stringify({
  command: `${process.execPath} suite.mjs`,
  mutations: [{ ...baseMutation, expectRedd: "oversized values are refused" }],
}));
execSync("git add -A && git -c user.email=a@b -c user.name=c commit -qm cfg", { cwd: root });
r = runTool(["--config", "mut.json"]);
check("a misspelt config key is refused, and NAMED", r.status !== 0 && r.stdout.includes("expectRedd"), r.stdout.slice(-300));
check("...and the run does not proceed to grade anything", !r.stdout.includes("mutation(s)"), r.stdout.slice(-300));

// `label` is what most configs in flight already write, so it is an ALIAS rather than an unknown:
// rejecting it would redden them all, and ignoring it printed the fallback label instead of the
// intent their author wrote.
writeFileSync(cfgPath, JSON.stringify({
  command: `${process.execPath} suite.mjs`,
  mutations: [{ ...baseMutation, name: undefined, label: "the oversize guard is disabled", expectRed: "oversized values are refused" }],
}));
execSync("git add -A && git -c user.email=a@b -c user.name=c commit -qm cfg2", { cwd: root });
r = runTool(["--config", "mut.json"]);
check("`label` names the mutation the way `name` does", r.status === 0 && r.stdout.includes("the oversize guard is disabled"), r.stdout.slice(-300));

// 7e. An ABSOLUTE config path is used as given, not joined to the repo root. A config that grades
// this tool cannot live in the tree — committing it dirties the tree the tool then refuses — so
// before this, the only way to run one was the tool's own `--allow-dirty` escape hatch.
const outside = join(mkdtempSync(join(tmpdir(), "mutation-selftest-cfg-")), "outside.json");
writeFileSync(outside, JSON.stringify({
  command: `${process.execPath} suite.mjs`,
  mutations: [{ ...baseMutation, expectRed: "oversized values are refused" }],
}));
r = runTool(["--config", outside]);
check("an absolute --config path is read where it is, not under the repo root", r.status === 0 && r.stdout.includes("KILLED"), r.stdout.slice(-300));

// 7f. A suite that dies before its own end is INCONCLUSIVE, not a kill. The mutation below reddens
// the named assertion AND stops the suite before it finishes — which is what a mutant that crashes
// the run looks like, and it is not evidence about one cell.
writeFileSync(outside, JSON.stringify({
  command: `${process.execPath} suite.mjs`,
  completionMarker: "  ✓ done",
  mutations: [{ ...baseMutation, expectRed: "oversized values are refused" }],
}));
r = runTool(["--config", outside]);
check("a run that never reaches the suite's end is INCONCLUSIVE, not KILLED",
  r.status !== 0 && r.stdout.includes("INCONCLUSIVE") && !r.stdout.includes("KILLED"), r.stdout.slice(-400));

// 7g. THE MIRROR OF 7f, AND THE ONE THE ORDERING DECIDES. 7f only needs the completion check to sit
// above KILLED. This needs it above SURVIVED as well: the mutant ends the run with exit 0 before the
// region is ever entered, so the suite "passes" — and SURVIVED is an ACCUSATION that the suite has a
// hole, made about code that never executed. Measured before the fix: "the suite PASSED with the
// implementation broken", about a guard two lines below the exit.
writeFileSync(outside, JSON.stringify({
  command: `${process.execPath} suite.mjs`,
  completionMarker: "  ✓ done",
  mutations: [{
    name: "the run ends cleanly before the region under test",
    file: "src/impl.js",
    find: "if (n > 10)\n    return false;",
    replace: "process.exit(0);",
    expectRed: "oversized values are refused",
  }],
}));
r = runTool(["--config", outside]);
check("a CLEAN exit that never reached the region is INCONCLUSIVE, not SURVIVED",
  r.stdout.includes("INCONCLUSIVE") && !r.stdout.includes("SURVIVED"), r.stdout.slice(-400));

// 7h. A run that printed nothing at all says THAT, rather than blaming the assertion for not
// printing. Same verdict either way, but the reason is what a reader acts on: "your assertion never
// printed" sends them to re-aim a mutation that is aimed correctly.
writeFileSync(outside, JSON.stringify({
  command: `${process.execPath} suite.mjs`,
  completionMarker: "  ✓ done",
  mutations: [{
    name: "the module ends the process at import, silently",
    file: "src/impl.js",
    find: "export const unrelated = () => 'untouched';",
    replace: "process.exit(9);",
    expectRed: "oversized values are refused",
  }],
}));
r = runTool(["--config", outside]);
check("a run with NO OUTPUT is named as never having started", r.stdout.includes("NO OUTPUT"), r.stdout.slice(-400));

// 7i. AN EXIT CODE IS NOT A PASS. A counting suite that sets `process.exitCode = 1` and then calls
// a teardown which exits 0 hands the grader a clean code over a run that printed real failures.
// Graded on the code alone that is a SURVIVED — "the suite does not test this", published about a
// check the suite had just caught. The suite cannot defend against its own teardown; the grader has
// to, by requiring positive evidence of a pass rather than the absence of a red one.
writeFileSync(
  join(root, "count.mjs"),
  [
    "import { admit } from './src/impl.js';",
    "let passed = 0, failed = 0;",
    "const c = (n, ok) => { if (ok) { passed++; console.log(`  ✓ ${n}`); } else { failed++; console.log(`  ✗ FAIL: ${n}`); } };",
    "c('oversized values are refused', admit(50) === false);",
    "console.log(`  ✓ done: ${passed} passed, ${failed} failed`);",
    "process.exitCode = failed > 0 ? 1 : 0;",
    "process.exit(0);   // the teardown gets the last word",
    "",
  ].join("\n"),
);
execSync("git add -A && git -c user.email=a@b -c user.name=c commit -qm count", { cwd: root });
writeFileSync(outside, JSON.stringify({
  command: `${process.execPath} count.mjs`,
  completionMarker: "  ✓ done",
  mutations: [{ ...baseMutation, expectRed: "oversized values are refused" }],
}));
r = runTool(["--config", outside]);
check("a suite whose teardown forces exit 0 over real failures is not a SURVIVED",
  !r.stdout.includes("SURVIVED"), r.stdout.slice(-400));
check("...and the untrustworthy exit code is named in the verdict",
  r.stdout.includes("teardown overrode the code"), r.stdout.slice(-400));

// And the mirror, so the requirement cannot be satisfied by never reporting SURVIVED again: a
// genuinely untested change on the SAME suite still comes back SURVIVED.
writeFileSync(outside, JSON.stringify({
  command: `${process.execPath} count.mjs`,
  completionMarker: "  ✓ done",
  mutations: [{
    name: "an untested function is changed",
    file: "src/impl.js",
    find: "'untouched'",
    replace: "'mutated'",
    expectRed: "oversized values are refused",
  }],
}));
r = runTool(["--config", outside]);
check("...while a change nothing tests is still SURVIVED on that same suite",
  r.stdout.includes("SURVIVED"), r.stdout.slice(-400));

rmSync(dirname(outside), { recursive: true, force: true });
rmSync(cfgPath);
execSync("git add -A && git -c user.email=a@b -c user.name=c commit -qm cfg-gone", { cwd: root });

// 8. The tree is left exactly as found, after all of that.
const after = execSync("git status --porcelain", { cwd: root, encoding: "utf8" }).trim();
check("every run restored the tree", after === "", { after });
check("...and the guard is byte-intact", readFileSync(join(root, "src/impl.js"), "utf8").includes("if (n > 10)"));

rmSync(root, { recursive: true, force: true });
console.log(`\nMUTATION-PROOF SELF-TEST PASSED ✅  (${pass} checks)`);
