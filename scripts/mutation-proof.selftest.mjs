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

// 7f. A mis-spelled key is silently dropped by every JSON reader. In an instrument whose whole
// premise is that each step of the experiment has a way to lie, a `label:` that should have been
// `name:` — or an `expectred:` that should have been `expectRed:` — is one of them.
r = runTool(["--config", "unknown-key.json"]);
check("an unknown mutation key is an ERROR, not a shrug",
  r.status !== 0 && r.stdout.includes("ERROR") && r.stdout.includes("unknown mutation key"), r.stdout.slice(-300));

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

rmSync(root, { recursive: true, force: true });
console.log(`\nMUTATION-PROOF SELF-TEST PASSED ✅  (${pass} checks)`);
