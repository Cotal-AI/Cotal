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
import { mkdtempSync, writeFileSync, rmSync, readFileSync, mkdirSync, statSync } from "node:fs";
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

// A verdict is a FIELD, not a substring. The tool prints it as `verdict.padEnd(12)` at the start
// of its own line, and the prose legitimately names other verdicts — the UNGRADABLE explanation
// ends "...this verdict becomes SURVIVED and is reportable". So `stdout.includes("SURVIVED")`
// matched the EXPLANATION of an UNGRADABLE, and two checks here stayed green while the tool had
// reclassified their fixtures out from under them. Read the field, not the page.
const stripAnsi = (s) => s.replace(/\[[0-9;]*m/g, "");
const verdictIs = (out, v) =>
  out.split("\n").some((l) => stripAnsi(l).startsWith(v + " "));

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
// Paired with a KILLING control in the SAME FILE, which is what licenses the SURVIVED verdict:
// the kill proves the suite reaches `src/impl.js` at runtime, so a survivor there is a real
// coverage gap rather than a mutant that changed nothing. See 2b for the unpaired case.
writeFileSync(join(root, "survivor-with-control.json"), JSON.stringify({
  command: `${process.execPath} suite.mjs`,
  mutations: [
    { name: "control: the guard itself", file: "src/impl.js", find: "if (n > 10)\n    return false;",
      replace: "if (false)\n    return false;", expectRed: "oversized values are refused" },
    { name: "the survivor", file: "src/impl.js", find: "'untouched'", replace: "'mutated'",
      expectRed: "never printed" },
  ],
}));
execSync("git add -A && git -c user.email=a@b -c user.name=c commit -qm survivor-control", { cwd: root });
r = runTool(["--config", "survivor-with-control.json"]);
check("a SURVIVED mutation is reported and exits non-zero", r.status !== 0 && verdictIs(r.stdout, "SURVIVED"), r.stdout.slice(-300));
check("...and it cites the positive control that licenses the verdict",
  r.stdout.includes("positive control") && verdictIs(r.stdout, "KILLED"), r.stdout.slice(-400));

// 2b. APPLIES IS NOT MUTATES. The same survivor with NO control in the file is UNGRADABLE, not
// SURVIVED. A mutant can install cleanly and change nothing — a shadowed duplicate key, a dead
// branch — and that produces a passing suite exactly as a genuine coverage gap does. Output
// comparison cannot separate them: a true survivor is byte-identical to the green run too. With
// no kill anywhere in the file, the run has no evidence either way, and UNGRADABLE says so
// instead of accusing the suite.
r = runTool([
  "--command", `${process.execPath} suite.mjs`,
  "--file", "src/impl.js",
  "--find", "'untouched'",
  "--replace", "'mutated'",
  "--expect-red", "never printed",
]);
check("an unpaired survivor is UNGRADABLE, not SURVIVED",
  r.status !== 0 && verdictIs(r.stdout, "UNGRADABLE") && !verdictIs(r.stdout, "SURVIVED"), r.stdout.slice(-400));
check("...and UNGRADABLE still exits non-zero, so it is never a cheap green",
  r.status !== 0, r.stdout.slice(-200));

// 3. A target that does not exist must ERROR, never silently grade.
r = runTool([
  "--command", `${process.execPath} suite.mjs`,
  "--file", "src/impl.js",
  "--find", "this string is not in the file",
  "--replace", "x",
]);
check("an absent target is an ERROR, not a verdict", r.status !== 0 && r.stdout.includes("ERROR") && r.stdout.includes("not found"));

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

// 7d. THE GREEN LINE THAT READ AS A RED. Suites here print `✓ <label>` on pass and `✗ FAIL: <label>`
// on fail — the SAME label both ways. `expectRed` was matched with a substring search over the whole
// transcript, so a mutation that left the named cell PASSING and crashed the suite somewhere else
// satisfied it with the pass line, and the tool reported `KILLED — red, and named: <that cell>`.
// A matched label is only evidence if the line it sits on is not the line a green run prints.
writeFileSync(
  join(root, "paired.mjs"),
  [
    "import { admit, unrelated } from './src/impl.js';",
    "const c = (n, v) => { console.log(v ? `  ✓ ${n}` : `  ✗ FAIL: ${n}`); if (!v) process.exitCode = 1; };",
    "c('the guard refuses an oversized value', admit(50) === false);",
    "if (unrelated() !== 'untouched') throw new Error('the unrelated helper blew up');",
    "c('the unrelated helper is untouched', admit(7) === true);",
    "",
  ].join("\n"),
);
// 7e. Green after barely running is not a survivor. A mutated run that exits 0 having emitted no
// progress marks never reached the check, and "the suite passed" is a claim about a suite that did
// not run. The completion question has to be asked BEFORE the pass is believed, not after.
writeFileSync(
  join(root, "bails.mjs"),
  [
    "import { admit } from './src/impl.js';",
    "if (admit(50) !== false) process.exit(0);",
    "console.log('  ✓ the guard refuses an oversized value');",
    "",
  ].join("\n"),
);
writeFileSync(
  join(root, "unknown-key.json"),
  JSON.stringify({
    command: `${process.execPath} suite.mjs`,
    mutations: [{ label: "typo: the key is `name`", file: "src/impl.js", find: "if (n > 10)", replace: "if (false)", expectRed: "oversized values are refused" }],
  }),
);
// A key a sibling tool reads is not an unknown key.
writeFileSync(
  join(root, "sibling-keys.json"),
  JSON.stringify({
    command: `${process.execPath} suite.mjs`,
    mutations: [{ name: "carries the keys the coverage pass reads", file: "src/impl.js", find: "if (n > 10)", replace: "if (false)", expectRed: "the guard refuses an oversized value", cell: "the guard refuses an oversized value", note: "prose for the next reader" }],
  }),
);
// ...and the control, because a widened allowlist that refuses nothing is a removal, not a fix.
writeFileSync(
  join(root, "unknown-top-key.json"),
  JSON.stringify({
    command: `${process.execPath} suite.mjs`,
    complitionMarker: "a real typo of a real key",
    mutations: [{ name: "fine", file: "src/impl.js", find: "if (n > 10)", replace: "if (false)", expectRed: "the guard refuses an oversized value" }],
  }),
);
writeFileSync(
  join(root, "no-expect.json"),
  JSON.stringify({
    command: `${process.execPath} suite.mjs`,
    mutations: [{ name: "unnamed red", file: "src/impl.js", find: "if (n > 10)", replace: "if (false)" }],
  }),
);
execSync("git add -A && git -c user.email=a@b -c user.name=c commit -qm more", { cwd: root });

r = runTool([
  "--command", `${process.execPath} paired.mjs`,
  "--file", "src/impl.js",
  "--find", "'untouched'",
  "--replace", "'mutated'",
  "--expect-red", "the guard refuses an oversized value",
]);
check("a label matched on a PASS line is WRONG-RED, not KILLED",
  r.status !== 0 && r.stdout.includes("WRONG-RED") && r.stdout.includes("prints when GREEN"), r.stdout.slice(-400));

r = runTool([
  "--command", `${process.execPath} bails.mjs`,
  "--file", "src/impl.js",
  "--find", "if (n > 10)\n    return false;",
  "--replace", "if (false)\n    return false;",
  "--expect-red", "oversized values are refused",
]);
check("green with zero progress marks is INCONCLUSIVE, not SURVIVED",
  r.status !== 0 && r.stdout.includes("INCONCLUSIVE") && !r.stdout.includes("SURVIVED"), r.stdout.slice(-400));

// 7e-bis. THE DELIBERATE NON-CHANGE, pinned so nobody "fixes" it later. A mutation that reddens the
// named cell for real AND THEN crashes the suite is KILLED, not INCONCLUSIVE. A harness that
// harvests a kill set by counting FAIL lines must call that inconclusive — the crash adds a second
// FAIL line and inflates its count. This grader asks one question per mutation, about one named
// assertion, and that assertion demonstrably went from its green line to its red line BEFORE the
// crash. The crash destroys evidence about the cells that never ran; it does not retract the
// evidence about the cell that did.
r = runTool([
  "--command", `${process.execPath} paired.mjs`,
  "--file", "src/impl.js",
  "--find", "if (n > 10)\n    return false;",
  "--replace", "if (false)\n    return false;\n  if (n === 7) throw new Error('and then a crash');",
  "--expect-red", "the guard refuses an oversized value",
]);
check("a real red followed by a crash is still KILLED", r.status === 0 && r.stdout.includes("KILLED"), r.stdout.slice(-400));

// 7e-quater. THE SAME RUN, UNDER A SUITE THAT OPTED IN — and the control that keeps the cell above
// meaning what it says. `completionMarker` lets a suite declare "a run of mine that did not finish
// is not evidence I want counted", which is a STRICTER bargain than the default, not a correction
// to it. The two cells differ in exactly one config field, so if the opt-in ever stops being an
// opt-in and becomes global, the control goes red and says so.
writeFileSync(
  join(root, "marked.mjs"),
  [
    "import { admit, unrelated } from './src/impl.js';",
    "const c = (n, v) => { console.log(v ? `  ✓ ${n}` : `  ✗ FAIL: ${n}`); if (!v) process.exitCode = 1; };",
    "c('the guard refuses an oversized value', admit(50) === false);",
    "if (unrelated() !== 'untouched') throw new Error('the unrelated helper blew up');",
    "c('the unrelated helper is untouched', admit(7) === true);",
    "console.log('SELFTEST SUITE DONE');",
    "",
  ].join("\n"),
);
const crashAfterRed = {
  name: "reddens the named cell for real, then crashes before the suite ends",
  file: "src/impl.js",
  find: "if (n > 10)\n    return false;",
  replace: "if (false)\n    return false;\n  if (n === 7) throw new Error('and then a crash');",
  expectRed: "the guard refuses an oversized value",
};
writeFileSync(
  join(root, "completion-optin.json"),
  JSON.stringify({ command: `${process.execPath} marked.mjs`, completionMarker: "SELFTEST SUITE DONE", mutations: [crashAfterRed] }),
);
writeFileSync(
  join(root, "completion-control.json"),
  JSON.stringify({ command: `${process.execPath} marked.mjs`, mutations: [crashAfterRed] }),
);
execSync("git add -A && git -c user.email=a@b -c user.name=c commit -qm completion", { cwd: root });
r = runTool(["--config", "completion-optin.json"]);
check("a suite that declared a completion marker gets INCONCLUSIVE, not KILLED, when the run stops early",
  r.status !== 0 && verdictIs(r.stdout, "INCONCLUSIVE") && r.stdout.includes("SELFTEST SUITE DONE"), r.stdout.slice(-400));
r = runTool(["--config", "completion-control.json"]);
check("...and THE SAME RUN with no marker declared is still KILLED, so this is opt-in and not a new default",
  r.status === 0 && r.stdout.includes("KILLED"), r.stdout.slice(-400));

// 7e-ter. EXIT STATUS IS NOT THE EVIDENCE, THE OTHER WAY ROUND. A teardown that calls
// `process.exit(0)` after the suite printed real failures and set `exitCode = 1` hands the grader a
// green status over a red run. Graded on status alone that reads SURVIVED — "the suite PASSED with
// the implementation broken" — about a suite that printed `✗ FAIL:` on the very cell being graded.
writeFileSync(
  join(root, "swallow.mjs"),
  [
    "import { admit } from './src/impl.js';",
    "let fail = 0;",
    "const c = (n, v) => { if (v) console.log(`  ✓ ${n}`); else { fail++; console.log(`  ✗ FAIL: ${n}`); } };",
    // A preamble cell that stays green, so the mutated run still clears the tick floor and this arm
    // measures the swallowed exit code rather than an early death.
    "c('the preamble ran', true);",
    "c('the guard refuses an oversized value', admit(50) === false);",
    "if (fail > 0) process.exitCode = 1;",
    "process.on('exit', () => { process.exit(0); });",
    "",
  ].join("\n"),
);
// 7e-quater. And the mirror hole on the same branch: a green run that never printed the named cell
// at all. Nothing failed, so nothing is red — but the cell did not run, so its "pass" is about
// nothing, and a survivor claim needs the cell to have executed and stayed green.
writeFileSync(
  join(root, "skips.mjs"),
  [
    "import { admit } from './src/impl.js';",
    "console.log('  ✓ the preamble ran');",
    "if (admit(50) !== false) process.exit(0);",
    "console.log('  ✓ the guard refuses an oversized value');",
    "",
  ].join("\n"),
);
execSync("git add -A && git -c user.email=a@b -c user.name=c commit -qm swallow", { cwd: root });

r = runTool([
  "--command", `${process.execPath} swallow.mjs`,
  "--file", "src/impl.js",
  "--find", "if (n > 10)\n    return false;",
  "--replace", "if (false)\n    return false;",
  "--expect-red", "the guard refuses an oversized value",
]);
check("exit 0 after a REAL named red is INCONCLUSIVE, not SURVIVED",
  r.status !== 0 && r.stdout.includes("INCONCLUSIVE") && r.stdout.includes("swallowed the exit code")
  && !r.stdout.includes("SURVIVED"), r.stdout.slice(-400));

r = runTool([
  "--command", `${process.execPath} skips.mjs`,
  "--file", "src/impl.js",
  "--find", "if (n > 10)\n    return false;",
  "--replace", "if (false)\n    return false;",
  "--expect-red", "the guard refuses an oversized value",
]);
check("a green run that never printed the named cell is INCONCLUSIVE, not SURVIVED",
  r.status !== 0 && r.stdout.includes("INCONCLUSIVE") && r.stdout.includes("never printed the named assertion")
  && !r.stdout.includes("SURVIVED"), r.stdout.slice(-400));

// 7e-sexies. THE LAST SWALLOW ON THIS BRANCH, and the one every check above waves through: OTHER
// cells go red, the NAMED cell stays green and prints exactly what it prints when green, teardown
// returns 0. The named assertion is intact, so the run reads as a survivor — but SURVIVED claims
// the SUITE passed, and it did not. Discriminated convention-free by mark count against baseline.
writeFileSync(
  join(root, "collateral.mjs"),
  [
    "import { admit } from './src/impl.js';",
    "let fail = 0;",
    "const c = (n, v) => { if (v) console.log(`  ✓ ${n}`); else { fail++; console.log(`  ✗ FAIL: ${n}`); } };",
    // The named cell does not read the mutated branch at all, so it survives the mutation intact.
    "c('the guard admits a small value', admit(1) === true);",
    // These do, and they are the ones that redden.
    "c('some other cell', admit(50) === false);",
    "c('and another', admit(99) === false);",
    "if (fail > 0) process.exitCode = 1;",
    "process.on('exit', () => { process.exit(0); });",
    "",
  ].join("\n"),
);
execSync("git add -A && git -c user.email=a@b -c user.name=c commit -qm collateral", { cwd: root });
r = runTool([
  "--command", `${process.execPath} collateral.mjs`,
  "--file", "src/impl.js",
  "--find", "if (n > 10)\n    return false;",
  "--replace", "if (false)\n    return false;",
  "--expect-red", "the guard admits a small value",
]);
check("exit 0 with the named cell green but FEWER marks than the green run is INCONCLUSIVE",
  r.status !== 0 && r.stdout.includes("INCONCLUSIVE") && r.stdout.includes("progress marks against the green run")
  && !r.stdout.includes("SURVIVED"), r.stdout.slice(-500));

// 7e-septies. THE NEGATIVE CONTROL FOR IT, and the reason the rule reads `fewer` and not `at or
// fewer`. A GENUINE survivor sits at EXACTLY the baseline: a guard nothing tests, removed, changes
// no cell and moves no mark. Making an exact-baseline survivor inconclusive would make a true
// SURVIVED unreportable — and a true SURVIVED is the finding a kill set exists to produce.
writeFileSync(
  join(root, "indifferent.mjs"),
  [
    "import { admit } from './src/impl.js';",
    "let fail = 0;",
    "const c = (n, v) => { if (v) console.log(`  ✓ ${n}`); else { fail++; console.log(`  ✗ FAIL: ${n}`); } };",
    "c('the guard admits a small value', admit(1) === true);",
    "c('and a second cell that also ignores the branch', admit(2) === true);",
    "if (fail > 0) process.exitCode = 1;",
    "",
  ].join("\n"),
);
execSync("git add -A && git -c user.email=a@b -c user.name=c commit -qm indifferent", { cwd: root });
// Paired with a control this suite DOES catch, in the same file: breaking `return true` reddens
// `the guard admits a small value`. The kill proves `indifferent.mjs` reaches src/impl.js at
// runtime, so the exact-baseline survivor beside it is a real coverage gap and not an inert mutant.
writeFileSync(join(root, "indifferent.json"), JSON.stringify({
  command: `${process.execPath} indifferent.mjs`,
  mutations: [
    { name: "control: break what this suite DOES read", file: "src/impl.js",
      find: "  return true;", replace: "  return false;",
      expectRed: "FAIL: the guard admits a small value" },
    { name: "the indifferent guard", file: "src/impl.js",
      find: "if (n > 10)\n    return false;", replace: "if (false)\n    return false;",
      expectRed: "the guard admits a small value" },
  ],
}));
execSync("git add -A && git -c user.email=a@b -c user.name=c commit -qm indifferent-cfg", { cwd: root });
r = runTool(["--config", "indifferent.json"]);
check("a genuine survivor at EXACTLY the baseline still reports SURVIVED",
  r.status !== 0 && verdictIs(r.stdout, "SURVIVED") && !verdictIs(r.stdout, "INCONCLUSIVE"), r.stdout.slice(-500));

// 7e-octies. THE SURVIVOR THAT IS ABOUT NOTHING. An empty baseline hit-set turns the survivor checks
// off, because a suite that prints nothing on a pass makes the label's absence uninformative. It is
// also exactly what a mutation running the WRONG SUITE looks like — the cell is not there to print.
// The verdict stays SURVIVED (for a throw-only suite it is right) and must NAME the ambiguity.
writeFileSync(
  join(root, "silent.mjs"),
  [
    "import { admit } from './src/impl.js';",
    // Prints NOTHING on a pass; throws on a failure. Nothing here reads the mutated branch.
    "if (admit(1) !== true) { console.log('  \u2717 FAIL: the guard admits a small value'); process.exit(1); }",
    "",
  ].join("\n"),
);
execSync("git add -A && git -c user.email=a@b -c user.name=c commit -qm silent", { cwd: root });
// Paired with a control, for the same reason as 7e-septies: without a kill in this file the run
// cannot tell an inert mutant from an untested one, and the ambiguity being reported here is a
// DIFFERENT one (silent-on-pass vs wrong-suite). Both notes must survive together.
writeFileSync(join(root, "silent.json"), JSON.stringify({
  command: `${process.execPath} silent.mjs`,
  mutations: [
    { name: "control: break what this suite DOES read", file: "src/impl.js",
      find: "  return true;", replace: "  return false;",
      expectRed: "FAIL: the guard admits a small value" },
    { name: "the unread branch", file: "src/impl.js",
      find: "if (n > 10)\n    return false;", replace: "if (false)\n    return false;",
      expectRed: "the guard admits a small value" },
  ],
}));
execSync("git add -A && git -c user.email=a@b -c user.name=c commit -qm silent-cfg", { cwd: root });
r = runTool(["--config", "silent.json"]);
check("a survivor whose cell never printed in the GREEN run is SURVIVED and says the absence is ambiguous",
  r.status !== 0 && verdictIs(r.stdout, "SURVIVED") && r.stdout.includes("appears nowhere in the green run"),
  r.stdout.slice(-500));

// 7e-quinquies. RESTORING THE FILE IS NOT RESTORING THE TREE. When the command under test compiles
// the mutated source, the run leaves a build artefact made FROM THE MUTANT; the sha check proves
// only that the source is byte-identical again, and a `dist/` is gitignored, so the git recovery
// this tool insists on before it starts does not cover it. `afterRestore` runs after the source is
// back, so whatever it regenerates is regenerated from the original.
writeFileSync(
  join(root, "compile.mjs"),
  [
    "import { readFileSync, writeFileSync } from 'node:fs';",
    "writeFileSync('built.txt', readFileSync('src/impl.js', 'utf8'));",
    "",
  ].join("\n"),
);
writeFileSync(join(root, "built.txt"), readFileSync(join(root, "src/impl.js"), "utf8"));
writeFileSync(
  join(root, "after.json"),
  JSON.stringify({
    command: `${process.execPath} compile.mjs && ${process.execPath} suite.mjs`,
    mutations: [{
      name: "leaves a build artefact behind",
      file: "src/impl.js", find: "if (n > 10)\n    return false;", replace: "if (false)\n    return false;",
      expectRed: "oversized values are refused",
      afterRestore: `${process.execPath} compile.mjs`,
    }],
  }),
);
execSync("git add -A && git -c user.email=a@b -c user.name=c commit -qm compile", { cwd: root });
r = runTool(["--config", "after.json"]);
check("afterRestore regenerates derived output from the RESTORED source",
  r.stdout.includes("KILLED")
  && readFileSync(join(root, "built.txt"), "utf8") === readFileSync(join(root, "src/impl.js"), "utf8"),
  { stdout: r.stdout.slice(-300) });

// 7f. A mis-spelled key is silently dropped by every JSON reader. In an instrument whose whole
// premise is that each step of the experiment has a way to lie, a `label:` that should have been
// `name:` — or an `expectred:` that should have been `expectRed:` — is one of them.
r = runTool(["--config", "unknown-key.json"]);
check("an unknown mutation key is an ERROR, not a shrug",
  r.status !== 0 && r.stdout.includes("ERROR") && r.stdout.includes("unknown mutation key"), r.stdout.slice(-300));

// The claim is exactly "these keys no longer make a mutation ungradable", so that is what this
// asserts: no ERROR, and a real verdict reached. Which verdict depends on where in this file the
// fixture sits and is not the property under test — asserting KILLED here would pin the fixture's
// position rather than the allowlist.
r = runTool(["--config", "sibling-keys.json"]);
check("...but a key a SIBLING tool reads is not unknown, and the mutation is GRADED rather than refused",
  !r.stdout.includes("unknown mutation key") && !r.stdout.includes("ERROR")
    && /KILLED|SURVIVED|WRONG-RED|INCONCLUSIVE|UNGRADABLE/.test(r.stdout), r.stdout.slice(-300));

r = runTool(["--config", "unknown-top-key.json"]);
check("...and a mis-spelled TOP-LEVEL key is refused, at the level the silent ignore actually lived at",
  r.status !== 0 && r.stdout.includes("complitionMarker"), r.stdout.slice(-300));

// 7g. Mandatory since the first version's header, unenforced until now.
r = runTool(["--config", "no-expect.json"]);
check("a mutation with no expectRed is refused",
  r.status !== 0 && r.stdout.includes("ERROR") && r.stdout.includes("no expectRed"), r.stdout.slice(-300));

// 7h. `^  ✓` is the natural way to write "a progress line", and without the `m` flag it matched the
// start of the transcript exactly once — so the floor compared 1 against 1 for every suite that
// anchored, and the banner reported "1 progress marks" as though it had counted.
r = runTool([
  "--command", `${process.execPath} suite.mjs`,
  "--progress-pattern", "^  ✓",
  "--file", "src/impl.js",
  "--find", "if (n > 10)\n    return false;",
  "--replace", "if (false)\n    return false;",
  "--expect-red", "oversized values are refused",
]);
check("an anchored progress pattern counts per LINE, not once per transcript",
  r.stdout.includes("baseline green") && r.stdout.includes("(3 progress marks)"), r.stdout.slice(0, 300));

// 8. The tree is left exactly as found, after all of that.
const after = execSync("git status --porcelain", { cwd: root, encoding: "utf8" }).trim();
check("every run restored the tree", after === "", { after });
check("...and the guard is byte-intact", readFileSync(join(root, "src/impl.js"), "utf8").includes("if (n > 10)"));

// 9. Restoring the BYTES is not restoring the FILE. `copyFileSync` is a write, so a restored file
// carries a fresh mtime while its content is provably unchanged — and every tool that compares a
// source against a build reads exactly that. After a real graded run, `smoke:dist-freshness` named
// `packages/core` stale and refused the 261-suite chain at its first entry, for a file nobody had
// edited. The sha checks above stay green through all of it, which is why this asserts the TIME.
//
// Back-date first: without it a fast restore lands in the same millisecond as the original and the
// check passes whether or not the timestamp was preserved.
const timed = join(root, "src/impl.js");
const OLD_MS = Date.now() - 3600_000;
execSync(`touch -d ${JSON.stringify(new Date(OLD_MS).toISOString())} ${JSON.stringify(timed)}`);
const mtimeBefore = statSync(timed).mtimeMs;
const startedMs = Date.now();
r = runTool([
  "--command", `${process.execPath} suite.mjs`,
  "--file", "src/impl.js",
  "--find", "if (n > 10)\n    return false;",
  "--replace", "if (false)\n    return false;",
  "--expect-red", "oversized values are refused",
]);
const mtimeAfter = statSync(timed).mtimeMs;
// Not an equality test. `statSync` surfaces a nanosecond timestamp as a millisecond Date and
// `utimesSync` can only write that precision back, so a faithful restore still lands up to 1ms
// off. The defect is not imprecision, it is the mtime becoming NOW — so the discriminating
// question is whether the restored time predates the run that touched it.
check("a restored file keeps its original mtime, not the time of the restore",
  verdictIs(r.stdout, "KILLED") && mtimeAfter < startedMs && Math.abs(mtimeAfter - mtimeBefore) <= 1,
  { mtimeBefore, mtimeAfter, startedMs, movedMs: mtimeAfter - mtimeBefore });
check("...and the content is unchanged too, so the time was not preserved by skipping the restore",
  readFileSync(timed, "utf8").includes("if (n > 10)"));

rmSync(root, { recursive: true, force: true });
console.log(`\nMUTATION-PROOF SELF-TEST PASSED ✅  (${pass} checks)`);
