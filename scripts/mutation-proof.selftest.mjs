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
import { mkdtempSync, writeFileSync, rmSync, readFileSync, readdirSync, realpathSync, mkdirSync, statSync, existsSync, chmodSync } from "node:fs";
import { createHash } from "node:crypto";
import { execSync, spawnSync, spawn } from "node:child_process";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
// NAMESPACE import, not named. The cleanup guard below is the thing this suite grades, and a tree
// WITHOUT it must fail on the assertion that names it, not on an unresolved import: a named import
// makes the module fail to link, which kills the run before a single check prints and proves
// nothing about the behaviour claimed. Read through the namespace, a missing export is a VALUE this
// suite can assert on. Measured: with the guard removed from the policy module, the named form died
// with SyntaxError "does not provide an export named 'containmentRefusal'" at 0 checks; this form
// reds `the cleanup guard refuses a target one level above its own mkdtemp root` by name.
import * as safety from "./mutation-command-safety.mjs";

/** The guard's verdict, or `undefined` (= "nothing refused") on a tree that has no guard. */
const refusalFor = (dir, dirBase, created) =>
  typeof safety.containmentRefusal === "function" ? safety.containmentRefusal(dir, dirBase, created) : undefined;
/** Guarded removal where the guard exists; the plain pre-#1625 delete where it does not. */
const removeSelfTestDir = (dir, dirBase, created) =>
  typeof safety.removeSelfTestDir === "function"
    ? safety.removeSelfTestDir(dir, dirBase, created)
    : rmSync(dir, { recursive: true, force: true });

const TOOL = join(dirname(fileURLToPath(import.meta.url)), "mutation-proof.mjs");
const base = tmpdir();
// The cleanups below may only remove this exact path, and only beneath this base (#1625).
const root = mkdtempSync(join(base, "mutation-selftest-"));
let pass = 0;
const check = (name, cond, extra) => {
  if (!cond) {
    console.error(`\n  ✗ ${name}${extra !== undefined ? ` — ${JSON.stringify(extra)}` : ""}`);
    removeSelfTestDir(root, base, root);
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

/** The breadcrumbs the tool has left in tmpdir for `tree`. Filtered on the tree each one names,
 *  because tmpdir is shared: a bare count would also read other proofs' records, including those of
 *  a proof that is mutating this suite's own tool. */
const breadcrumbsFor = (tree) => {
  const key = realpathSync(tree);
  return readdirSync(tmpdir())
    .filter((name) => name.startsWith("mutation-proof-bc-") && name.endsWith(".json"))
    .map((name) => {
      const path = join(tmpdir(), name);
      try { return { path, body: JSON.parse(readFileSync(path, "utf8")) }; } catch { return undefined; }
    })
    .filter((entry) => entry?.body?.treeKey === key);
};
const shaOf = (path) => createHash("sha256").update(readFileSync(path)).digest("hex");
/** Files this suite writes into the shared tmpdir, out of reach of the fixture cleanup. Removed on
 *  every exit, a failed check's included. */
const sharedTmpFiles = [];
process.on("exit", () => {
  for (const path of sharedTmpFiles) rmSync(path, { force: true });
});

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
    "if (process.env.pnpm_config_verify_deps_before_run !== 'false') { console.error('AssertionError: mutation child disables pnpm dependency verification'); process.exit(1); }",
    "console.log('  ✓ admits a small value');",
    "if (admit(5) !== true) { console.error('AssertionError: small values are admitted'); process.exit(1); }",
    "console.log('  ✓ the guard refuses an oversized value');",
    "if (admit(50) !== false) { console.error('AssertionError: oversized values are refused'); process.exit(1); }",
    "console.log('  ✓ done');",
    "",
  ].join("\n"),
);
mkdirSync(join(root, "smoke"), { recursive: true });
writeFileSync(join(root, "smoke", "suite.mjs"), readFileSync(join(root, "suite.mjs"), "utf8"));
writeFileSync(join(root, ".gitignore"), ".cotal/\n");
execSync("git init -q && git add -A && git -c user.email=a@b -c user.name=c commit -qm fixture", { cwd: root });

const runTool = (args) =>
  spawnSync(process.execPath, [TOOL, ...args], {
    cwd: root,
    encoding: "utf8",
    timeout: 120_000,
    // Prove the tool overrides this only for commands it launches rather than relying on ambient
    // configuration already carrying the desired value.
    env: { ...process.env, pnpm_config_verify_deps_before_run: "install" },
  });

const OMIT_SUITE = Symbol("omit suite metadata");
const writeConfig = (name, suite = ["smoke/suite.mjs"], extra = {}) => {
  writeFileSync(join(root, name), JSON.stringify({
    ...(suite === OMIT_SUITE ? {} : { suite }),
    command: `${process.execPath} suite.mjs`,
    mutations: [{ name: "metadata control", file: "src/impl.js", find: "if (n > 10)", replace: "if (false)", expectRed: "oversized values are refused" }],
    ...extra,
  }));
};

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
// A proof that finished removes its breadcrumb. Graded HERE, after the first completed proof, and
// the position is load-bearing: a breadcrumb left behind records the clean hash of src/impl.js, so
// once `a dirty tree is refused` dirties that file, the next run reads the leftover as an
// unrecovered mutation and refuses for that reason, which reddens the wrong cell first.
check("a proof that completes leaves no breadcrumb behind", breadcrumbsFor(root).length === 0,
  breadcrumbsFor(root).map((entry) => entry.path));

// 2. THE ONE THAT MATTERS: a mutation the suite does NOT catch must be reported, not passed.
// Paired with a KILLING control in the SAME FILE, which is what licenses the SURVIVED verdict:
// the kill proves the suite reaches `src/impl.js` at runtime, so a survivor there is a real
// coverage gap rather than a mutant that changed nothing. See 2b for the unpaired case.
writeFileSync(join(root, "survivor-with-control.json"), JSON.stringify({
  suite: ["smoke/suite.mjs"],
  command: `${process.execPath} suite.mjs`,
  mutations: [
    { name: "control: the guard itself", file: "src/impl.js", find: "if (n > 10)\n    return false;",
      replace: "if (false)\n    return false;", expectRed: "oversized values are refused" },
    { name: "the survivor", file: "src/impl.js", find: "'untouched'", replace: "'mutated'",
      expectRed: "never printed" },
  ],
}));
execSync("git add -A && git -c user.email=a@b -c user.name=c commit -qm survivor-control", { cwd: root });

writeConfig("metadata-missing.json", OMIT_SUITE);
writeConfig("metadata-empty.json", []);
writeConfig("metadata-string.json", "suite.mjs");
writeConfig("metadata-element.json", [42]);
writeConfig("metadata-nonpath.json", ["./suite.mjs"]);
writeConfig("metadata-missing-source.json", ["smoke/missing.mjs"]);
writeConfig("metadata-valid.json", ["smoke/suite.mjs", "src/impl.js"]);
writeConfig("metadata-root-valid.json", ["suite.mjs"]);
execSync("git add -A && git -c user.email=a@b -c user.name=c commit -qm metadata", { cwd: root });
for (const [name, diagnosis] of [
  ["metadata-missing.json", "MISSING SUITE METADATA"],
  ["metadata-empty.json", "EMPTY SUITE METADATA"],
  ["metadata-string.json", "MALFORMED SUITE METADATA"],
  ["metadata-element.json", "MALFORMED SUITE METADATA"],
  ["metadata-nonpath.json", "NON-PATH SUITE SOURCE"],
  ["metadata-missing-source.json", "SUITE SOURCE MISSING"],
]) {
  r = runTool(["--config", name]);
  check(`config mode rejects ${name}`, r.status !== 0 && r.stdout.includes(diagnosis), r.stdout.slice(-400));
}
r = runTool(["--config", "metadata-valid.json"]);
check("config mode accepts a valid multi-source array", r.status === 0 && verdictIs(r.stdout, "KILLED"), r.stdout.slice(-400));
r = runTool(["--config", "metadata-root-valid.json"]);
check("config mode accepts a valid root-level source path", r.status === 0 && verdictIs(r.stdout, "KILLED"), r.stdout.slice(-400));
r = runTool([
  "--command", `${process.execPath} suite.mjs`,
  "--file", "src/impl.js",
  "--find", "if (n > 10)\n    return false;",
  "--replace", "if (false)\n    return false;",
  "--expect-red", "oversized values are refused",
]);
check("ad-hoc CLI mode remains usable without repository suite metadata", r.status === 0 && verdictIs(r.stdout, "KILLED"), r.stdout.slice(-400));
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
    suite: ["smoke/suite.mjs"],
    command: `${process.execPath} suite.mjs`,
    mutations: [{ label: "typo: the key is `name`", file: "src/impl.js", find: "if (n > 10)", replace: "if (false)", expectRed: "oversized values are refused" }],
  }),
);
// A key a sibling tool reads is not an unknown key.
writeFileSync(
  join(root, "sibling-keys.json"),
  JSON.stringify({
    suite: ["smoke/suite.mjs"],
    command: `${process.execPath} suite.mjs`,
    mutations: [{ name: "carries the keys the coverage pass reads", file: "src/impl.js", find: "if (n > 10)", replace: "if (false)", expectRed: "the guard refuses an oversized value", cell: "the guard refuses an oversized value", note: "prose for the next reader" }],
  }),
);
// ...and the control, because a widened allowlist that refuses nothing is a removal, not a fix.
writeFileSync(
  join(root, "unknown-top-key.json"),
  JSON.stringify({
    suite: ["smoke/suite.mjs"],
    command: `${process.execPath} suite.mjs`,
    complitionMarker: "a real typo of a real key",
    mutations: [{ name: "fine", file: "src/impl.js", find: "if (n > 10)", replace: "if (false)", expectRed: "the guard refuses an oversized value" }],
  }),
);
writeFileSync(
  join(root, "no-expect.json"),
  JSON.stringify({
    suite: ["smoke/suite.mjs"],
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
  JSON.stringify({ suite: ["smoke/suite.mjs"], command: `${process.execPath} marked.mjs`, completionMarker: "SELFTEST SUITE DONE", mutations: [crashAfterRed] }),
);
writeFileSync(
  join(root, "completion-control.json"),
  JSON.stringify({ suite: ["smoke/suite.mjs"], command: `${process.execPath} marked.mjs`, mutations: [crashAfterRed] }),
);
execSync("git add -A && git -c user.email=a@b -c user.name=c commit -qm completion", { cwd: root });
r = runTool(["--config", "completion-optin.json"]);
check("a suite that declared a completion marker gets INCONCLUSIVE, not KILLED, when the run stops early",
  r.status !== 0 && verdictIs(r.stdout, "INCONCLUSIVE") && r.stdout.includes("SELFTEST SUITE DONE"), r.stdout.slice(-400));
// The unfinished run DID execute and DID print, and where it stopped is the evidence a reader needs.
// The first excerpt release dropped `transcript` from this one return, so the report said
// "(no run: ...)" about a run that had printed the red and the crash. Pinned here.
{
  const out = stripAnsi(r.stdout);
  check("...and the echo shows WHERE the unfinished run stopped, instead of claiming there was no run",
    out.includes("|   ✗ FAIL: the guard refuses an oversized value") && out.includes("and then a crash") && !out.includes("(no run:"),
    out.slice(-900));
}
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
writeFileSync(join(root, "indifferent.json"), JSON.stringify({ suite: ["smoke/suite.mjs"],
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
writeFileSync(join(root, "silent.json"), JSON.stringify({ suite: ["smoke/suite.mjs"],
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
    suite: ["smoke/suite.mjs"],
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

// 7i/7j. A `✓` inside an assertion LABEL is not a progress mark: the default pattern must anchor to
// line start (#1348). This suite prints three pass lines, the second of which names the glyph in
// its own label text rather than being one.
writeFileSync(
  join(root, "labelled.mjs"),
  [
    "import { admit } from './src/impl.js';",
    "console.log('  ✓ admits a small value');",
    "console.log('  ✓ the label carries a glyph (not ✓ started)');",
    "if (admit(50) !== false) { process.exit(0); }",
    "console.log('  ✓ the guard refuses an oversized value');",
    "",
  ].join("\n"),
);
execSync("git add -A && git -c user.email=a@b -c user.name=c commit -qm labelled", { cwd: root });

r = runTool([
  "--command", `${process.execPath} labelled.mjs`,
  "--file", "src/impl.js",
  "--find", "if (n > 10)\n    return false;",
  "--replace", "if (false)\n    return false;",
  "--expect-red", "oversized values are refused",
]);
check("a ✓ inside an assertion label is not a progress mark",
  r.stdout.includes("baseline green") && r.stdout.includes("(3 progress marks)"), r.stdout.slice(0, 300));

r = runTool([
  "--command", `${process.execPath} labelled.mjs`,
  "--file", "src/impl.js",
  "--find", "if (n > 10)\n    return false;",
  "--replace", "if (false)\n    return false;",
  "--expect-red", "oversized values are refused",
  "--min-ticks", "3",
]);
check("a minTicks floor near the true count fails a run that is one real check short",
  verdictIs(r.stdout, "INCONCLUSIVE") && r.stdout.includes("reached only 2 progress marks (expected \u2265 3)"),
  r.stdout.slice(0, 400));
execSync("git checkout -- .", { cwd: root });

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

// 10. #1337: the restore must not depend on the on-disk BACKUP surviving the run. A suite that
// deletes the tool's own `.bak` (computed exactly as the tool computes it, under this suite's own
// tmp directory) mid-run used to make `restore()` throw ENOENT, and the SAME throw from the catch's
// own `restore()` call then escaped `proveOne` entirely: no verdict line, no exit status of the
// tool's own, the process died with a raw stack, and the mutant stayed on disk. This is red at the
// base for exactly that reason.
writeFileSync(
  join(root, "delete-backup-suite.mjs"),
  [
    "import { admit } from './src/impl.js';",
    "import { createHash } from 'node:crypto';",
    "import { unlinkSync } from 'node:fs';",
    "import { tmpdir } from 'node:os';",
    "import { join, resolve } from 'node:path';",
    "// Computed the way the tool computes it (mutation-proof.mjs, the `backup` assignment in proveOne).",
    "const target = resolve(process.cwd(), 'src/impl.js');",
    "const backup = join(tmpdir(), `mutation-proof-${createHash('sha1').update(target).digest('hex').slice(0, 12)}.bak`);",
    "try { unlinkSync(backup); } catch {}",
    "console.log('  ✓ admits a small value');",
    "if (admit(5) !== true) { console.error('AssertionError: small values are admitted'); process.exit(1); }",
    "console.log('  ✓ the guard refuses an oversized value');",
    "if (admit(50) !== false) { console.error('AssertionError: oversized values are refused'); process.exit(1); }",
    "console.log('  ✓ done');",
    "",
  ].join("\n"),
);
execSync("git add -A && git -c user.email=a@b -c user.name=c commit -qm delete-backup-fixture", { cwd: root });
{
  const impl = join(root, "src/impl.js");
  const shaBaseline = shaOf(impl);
  r = runTool([
    "--command", `${process.execPath} delete-backup-suite.mjs`,
    "--file", "src/impl.js",
    "--find", "if (n > 10)\n    return false;",
    "--replace", "if (false)\n    return false;",
    "--expect-red", "oversized values are refused",
  ]);
  const out = stripAnsi(r.stdout);
  check("a suite that deletes the tool's own backup mid-run still completes with a verdict, no stack trace",
    r.status !== null && !(r.stderr ?? "").includes("at copyFileSync") && !(r.stderr ?? "").includes("at restore ("),
    { status: r.status, signal: r.signal, stderr: (r.stderr ?? "").slice(-400) });
  check("...and the run's own verdict is printed, KILLED (the in-memory restore does not change grading)",
    verdictIs(out, "KILLED"), out.slice(-400));
  check("...and the tree is exactly as it was, even though the on-disk backup was deleted",
    execSync("git status --porcelain", { cwd: root, encoding: "utf8" }).trim() === "" && shaOf(impl) === shaBaseline);
  check("...and no breadcrumb is left behind", breadcrumbsFor(root).length === 0,
    breadcrumbsFor(root).map((entry) => entry.path));
}

// 11. #1337, the other half: a restore that CANNOT succeed (the target unwritable when restore()
// runs) must not throw either. It must report ERROR, name the backup path, say the tree is still
// mutated, and the process must exit non-zero with no stack trace on stderr — never the silent
// mutant-left-behind crash this issue is about. This is red at the base too: the throw from
// `copyFileSync` inside `restore()` escaped exactly the same way.
writeFileSync(
  join(root, "unwritable-suite.mjs"),
  [
    "import { admit } from './src/impl.js';",
    "import { chmodSync } from 'node:fs';",
    "// Make the restore target unwritable BEFORE the tool's restore() runs, but ONLY under the mutant:",
    "// the tool runs this suite once as the baseline and takes its backup afterwards, and a backup",
    "// copied from a read-only file is read-only itself, which --recover then copies back over the",
    "// target and leaves every later cell unable to write src/impl.js. Root ignores file permissions,",
    "// so this cell only proves anything under a non-root uid; the fixture never runs as root here.",
    "console.log('  ✓ admits a small value');",
    "if (admit(5) !== true) { console.error('AssertionError: small values are admitted'); process.exit(1); }",
    "console.log('  ✓ the guard refuses an oversized value');",
    "if (admit(50) !== false) { chmodSync('src/impl.js', 0o444); console.error('AssertionError: oversized values are refused'); process.exit(1); }",
    "console.log('  ✓ done');",
    "",
  ].join("\n"),
);
execSync("git add -A && git -c user.email=a@b -c user.name=c commit -qm unwritable-fixture", { cwd: root });
{
  const impl = join(root, "src/impl.js");
  r = runTool([
    "--command", `${process.execPath} unwritable-suite.mjs`,
    "--file", "src/impl.js",
    "--find", "if (n > 10)\n    return false;",
    "--replace", "if (false)\n    return false;",
    "--expect-red", "oversized values are refused",
  ]);
  // The cell itself restores the mode: a check() failure calls process.exit(1) from inside check(),
  // which would otherwise skip this cleanup and leave every later cell unable to touch src/impl.js.
  try { chmodSync(impl, 0o644); } catch {}
  const out = stripAnsi(r.stdout);
  const stderr = r.stderr ?? "";
  check("a restore that cannot succeed reports exactly one ERROR verdict, not a crash",
    out.split("\n").filter((l) => verdictIs(l + "\n", "ERROR")).length === 1, out.slice(-500));
  check("...naming the backup path and that the tree is still mutated",
    /backup at .*mutation-proof-.*\.bak/.test(out) && /still mutated/.test(out), out.slice(-500));
  check("...with a non-zero exit and no stack trace on stderr",
    r.status !== 0 && !stderr.includes("at copyFileSync") && !stderr.includes("at restore (") && !stderr.includes("at proveOne"),
    { status: r.status, stderr: stderr.slice(-400) });
  // Put the fixture back: the suite left the mutant in place (that is the point), so recover it the
  // way an operator would, then confirm the tree really is clean again for the cells after this one.
  execSync("git checkout -- src/impl.js", { cwd: root });
  check("...and the scratch fixture itself is recoverable with plain git after the ERROR",
    execSync("git status --porcelain", { cwd: root, encoding: "utf8" }).trim() === "");
  // restore()'s catch above never reaches `clearBreadcrumb`/`rmSync(backup)` (the throw happens
  // before either), so the on-disk breadcrumb and backup for src/impl.js are still sitting in
  // tmpdir. Left alone they auto-recover — harmlessly, but noisily — on the very next tool
  // invocation in this fixture tree, polluting a cell after this one with an unrelated "leftover
  // breadcrumb" message. Clear them now with the tool's own recovery path, the way an operator
  // finishing the cleanup would.
  const rr = runTool(["--recover"]);
  check("...and running --recover afterwards clears the stray breadcrumb and backup",
    breadcrumbsFor(root).length === 0, breadcrumbsFor(root).map((entry) => entry.path));
}

// ---- the transcript echo attributes evidence to the RUN it came from, and keeps the cause ----
//
// The #1328 review reproduced two defects in the first version of this feature. (1) Transcripts
// were held in a Map keyed by label, and duplicate mutation names are accepted, so two WRONG-REDs
// both echoed the SECOND run's output. (2) The echo was tail-only, so an early cause followed by a
// long teardown printed the teardown and omitted the cause. Both cells below fail against that
// version and pass against the per-result head+tail excerpt.
//
// A suite that prints a run-specific first line and then a long tail. `TRIP` selects which
// distinct red each mutant produces, so the two runs are distinguishable by content alone.
writeFileSync(
  join(root, "echo-suite.mjs"),
  [
    "import { admit } from './src/impl.js';",
    "const v = admit(5);",
    "const marker = v === 'A' ? 'CAUSE-ALPHA' : v === 'B' ? 'CAUSE-BETA' : 'CAUSE-NONE';",
    "console.error('first line: ' + marker);",
    "for (let i = 0; i < 30; i++) console.log('teardown line ' + i);",
    "console.log('  ✓ tail cell');",
    "// green when unmutated (the tool refuses a red baseline); red for either mutant",
    "process.exit(v === true ? 0 : 1);",
    "",
  ].join("\n"),
);
// Two mutations with the SAME name, each turning `admit` into a different constant. Both are
// WRONG-RED (the named assertion never prints), so both echo; the question is WHICH run each echoes.
writeFileSync(join(root, "dup-labels.json"), JSON.stringify({ suite: ["smoke/suite.mjs"],
  command: `${process.execPath} echo-suite.mjs`,
  mutations: [
    { name: "same name", file: "src/impl.js", find: "  return true;", replace: "  return 'A';", expectRed: "never printed" },
    { name: "same name", file: "src/impl.js", find: "  return true;", replace: "  return 'B';", expectRed: "never printed" },
  ],
}));
execSync("git add -A && git -c user.email=a@b -c user.name=c commit -qm echo-fixtures", { cwd: root });
r = runTool(["--config", "dup-labels.json"]);
{
  const out = stripAnsi(r.stdout);
  const alpha = out.indexOf("first line: CAUSE-ALPHA");
  const beta = out.indexOf("first line: CAUSE-BETA");
  check("two mutations sharing a label each echo THEIR OWN run, not the last one's",
    alpha !== -1 && beta !== -1 && alpha < beta, out.slice(-900));
  check("...and the cause on the FIRST line survives a 30-line teardown after it",
    out.includes("| first line: CAUSE-ALPHA") && out.includes("middle line(s) omitted") && out.includes("| teardown line 29"),
    out.slice(-900));
}
// A FAILURE IN THE MIDDLE, which is the shape a positional window cannot see and the one that cost a
// panel an hour: banner, a run of green cells, ONE red, then a summary. Head and tail are chosen by
// POSITION, so the single line naming the failing cell falls in the discarded span. Observed for real
// on a `creds-supply-expiry` WRONG-RED that echoed `… 8 middle line(s) omitted` where the omitted
// eight held the only thing a reader needed. The rescue is by CONTENT, so it does not depend on the
// red landing anywhere in particular.
writeFileSync(
  join(root, "buried-suite.mjs"),
  [
    "import { admit } from './src/impl.js';",
    "const v = admit(5);",
    "console.log('banner');",
    "for (let i = 0; i < 14; i++) console.log('  \\u2713 green cell ' + i);",
    "if (v !== true) console.log('  \\u2717 FAIL: BURIED-CELL the one line that names the failure');",
    "else console.log('  \\u2713 BURIED-CELL green');",
    "for (let i = 0; i < 14; i++) console.log('  \\u2713 later green ' + i);",
    "console.log('SUITE SUMMARY (22 passed, 1 failed)');",
    "process.exit(v === true ? 0 : 1);",
    "",
  ].join("\n"),
);
writeFileSync(join(root, "buried.json"), JSON.stringify({ suite: ["smoke/suite.mjs"],
  command: `${process.execPath} buried-suite.mjs`,
  mutations: [
    { name: "buried", file: "src/impl.js", find: "  return true;", replace: "  return 'A';", expectRed: "never printed" },
  ],
}));
execSync("git add -A && git -c user.email=a@b -c user.name=c commit -qm buried-fixture", { cwd: root });
r = runTool(["--config", "buried.json"]);
{
  const out = stripAnsi(r.stdout);
  // The load-bearing assertion. Without the content rescue this line is inside the omitted span and
  // the reader is told only how many lines vanished.
  check("a FAILING line buried mid-transcript is echoed, not counted as an omitted line",
    out.includes("✗ FAIL: BURIED-CELL the one line that names the failure"), out.slice(-1200));
  // And the window is still a window: the greens in the DISCARDED span are not dragged in with it.
  // `later green 5` and after fall inside the tail, so they are shown for an unrelated reason; the
  // honest probe is a green that lies in the omitted middle. Getting this wrong once is why the
  // assertion names the line it expects to be absent rather than any convenient nearby string.
  check("...while the greens in the omitted span stay omitted, the rescue is by failure, not by widening",
    out.includes("middle line(s) omitted") && !out.includes("green cell 12"), out.slice(-1200));
}
// MORE BURIED FAILURES THAN THE CAP. The cell above uses ONE buried failure, which cannot tell a
// rescue that scans the whole span from one that stops at the cap and then claims the remainder is
// clean. A reviewer found exactly that with twelve failures against a cap of eight: four were
// dropped and the footer still read "(no failure markers)". A tool asserting something false about
// what it hid is the defect this whole change exists to remove, so it is graded here.
writeFileSync(
  join(root, "many-suite.mjs"),
  [
    "import { admit } from './src/impl.js';",
    "const v = admit(5);",
    "for (let i = 0; i < 10; i++) console.log('head ' + i);",
    "for (let i = 0; i < 12; i++) console.log(v === true ? '  \\u2713 ok ' + i : '  \\u2717 FAIL buried ' + i);",
    "for (let i = 0; i < 10; i++) console.log('tail ' + i);",
    "process.exit(v === true ? 0 : 1);",
    "",
  ].join("\n"),
);
writeFileSync(join(root, "many.json"), JSON.stringify({ suite: ["smoke/suite.mjs"],
  command: `${process.execPath} many-suite.mjs`,
  mutations: [
    { name: "many", file: "src/impl.js", find: "  return true;", replace: "  return 'A';", expectRed: "never printed" },
  ],
}));
execSync("git add -A && git -c user.email=a@b -c user.name=c commit -qm many-fixture", { cwd: root });
r = runTool(["--config", "many.json"]);
{
  const out = stripAnsi(r.stdout);
  // 12 failures in the span, 8 shown, so 4 are hidden and the footer must SAY so.
  check("when more failures are buried than the cap shows, the footer counts the hidden ones",
    out.includes("INCLUDING 4 more failure(s)"), out.slice(-1400));
  // The load-bearing negative: it must never claim cleanliness it did not verify.
  check("...and it does NOT claim the omitted lines carry no failure markers",
    !out.includes("(no failure markers)"), out.slice(-1400));
}
// A verdict reached BEFORE any run has no transcript, and must say so rather than claim an empty run.
r = runTool([
  "--command", `${process.execPath} suite.mjs`,
  "--file", "src/impl.js", "--find", "this string is not in the file", "--replace", "x",
  "--expect-red", "oversized values are refused",
]);
check("an ERROR raised before the run says there was no run, not that the run was silent",
  stripAnsi(r.stdout).includes("(no run:") && !stripAnsi(r.stdout).includes("produced NO output"), r.stdout.slice(-400));

// 8. Refuse to start when a proof is already live against the tree.
// The lock has to be written BY A RUNNING PROOF. Planting one by hand tests only the reader half,
// and the writer half was broken under it: the setup called `dirname` without importing it, the
// ReferenceError was swallowed, no lock was ever written, and two real proofs still ran together.
// So this starts a genuine first proof against a slow suite and asks the second one to refuse.
writeFileSync(join(root, "slow-suite.mjs"), [
  "import { admit } from './src/impl.js';",
  "const t = Date.now(); while (Date.now() - t < 6000) {}",
  "console.log('  ✓ the guard refuses an oversized value');",
  "if (admit(50) !== false) { console.error('AssertionError: oversized values are refused'); process.exit(1); }",
  "",
].join("\n"));
execSync("git add -A && git -c user.email=a@b -c user.name=c commit -qm slow-suite", { cwd: root });

const liveArgs = [
  "--command", `${process.execPath} slow-suite.mjs`,
  "--file", "src/impl.js",
  "--find", "if (n > 10)\n    return false;",
  "--replace", "if (false)\n    return false;",
  "--expect-red", "oversized values are refused",
];
const first = spawn(process.execPath, [TOOL, ...liveArgs], { cwd: root, stdio: "ignore" });
const firstExit = new Promise((res) => first.on("exit", res));
const lockPath = join(root, ".cotal", "mutation-proof.lock");
const sleepSync = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
let lockSeen = false;
for (let i = 0; i < 50 && !lockSeen; i++) {
  lockSeen = existsSync(lockPath);
  if (!lockSeen) sleepSync(100);
}
check("a LIVE proof writes the lock that the refusal reads", lockSeen, lockPath);
check("...and the lock names the running proof's pid",
  lockSeen && JSON.parse(readFileSync(lockPath, "utf8")).pid === first.pid,
  lockSeen ? readFileSync(lockPath, "utf8") : "no lock");
r = runTool(liveArgs);
check("refuses to start when a proof is already live against the tree",
  r.status !== 0 && stripAnsi(r.stdout).includes("already live against the tree"), r.stdout.slice(-300));
check("...and the refusal names the live pid, so the human can find it",
  stripAnsi(r.stdout).includes(`PID ${first.pid}`), r.stdout.slice(-300));
const firstStatus = await firstExit;
check("...and the first proof still finished normally and released the lock",
  firstStatus === 0 && !existsSync(lockPath), `${firstStatus} lock=${existsSync(lockPath)}`);

// 9. Reclaim stale lock when the recorded PID is dead.
mkdirSync(join(root, ".cotal"), { recursive: true });
writeFileSync(join(root, ".cotal", "mutation-proof.lock"), JSON.stringify({ pid: 999999, ts: Date.now() }));
r = runTool([
  "--command", `${process.execPath} suite.mjs`,
  "--file", "src/impl.js",
  "--find", "if (n > 10)\n    return false;",
  "--replace", "if (false)\n    return false;",
  "--expect-red", "oversized values are refused",
]);
check("reclaims stale proof lock when recorded PID is dead and runs successfully",
  r.status === 0 && stripAnsi(r.stdout).includes("KILLED"), r.stdout.slice(-300));
// A killed proof must leave the tree byte-identical (#1607). Gated on an OBSERVED
// applied mutation, not on a fixed delay: a timer that lands between fixtures
// reads clean and would pass as a clean bill of health.
const slow = join(root, "slow-suite.mjs");
writeFileSync(slow, "console.log('  ✓ started'); setTimeout(() => { console.log('  ✓ done'); }, 4_000);\n");
execSync("git add -A && git -c user.email=a@b -c user.name=c commit -qm slow-suite", { cwd: root });
const child = spawn(process.execPath, [TOOL,
  "--command", `${process.execPath} slow-suite.mjs`,
  "--file", "src/impl.js", "--find", "if (n > 10)", "--replace", "if (false)",
  "--expect-red", "oversized values are refused",
], { cwd: root, stdio: "ignore" });
// Wait for the REPLACEMENT TEXT, not for a dirty tree. `git status --porcelain` is non-empty from
// the moment the tool writes its own lock at `.cotal/mutation-proof.lock`, which it does at startup,
// about 500ms in and roughly 3.7s before the mutation is applied (measured: dirty at 500ms, mutated
// at 4250ms, with a 4s baseline in between). Gating on dirt therefore fired during the BASELINE run
// and the kill landed while nothing was mutated at all, so this control asserted the one thing it
// was written to rule out. The tree then came back clean either way, because releasing the lock
// leaves `.cotal/` empty and git does not report empty directories, so the byte-identical check
// below passed and only the exit-status check saw anything wrong (#1701).
const mutantPath = join(root, "src", "impl.js");
let observedApplied = false;
for (let i = 0; i < 600 && !observedApplied; i++) {
  observedApplied = readFileSync(mutantPath, "utf8").includes("if (false)");
  if (!observedApplied) await new Promise((done) => setTimeout(done, 50));
}
check("the kill lands while a mutation is really applied (the control that would otherwise lie)", observedApplied);
child.kill("SIGTERM");
let killedCode, killedSignal;
await new Promise((done) =>
  child.once("exit", (code, signal) => {
    killedCode = code;
    killedSignal = signal;
    done(null);
  }),
);
await new Promise((done) => setTimeout(done, 250));
check("a killed proof leaves the tree byte-identical to its pre-run state",
  execSync("git status --porcelain", { cwd: root, encoding: "utf8" }).trim() === "",
  execSync("git status --porcelain", { cwd: root, encoding: "utf8" }));
check("...and the exit status still reports the signal, not a tidy 0",
  killedSignal === "SIGTERM" && killedCode === null,
  `code=${killedCode} signal=${killedSignal}`);

// Breadcrumb recovery survives SIGKILL (#1607): when killed with uncatchable SIGKILL,
// the next mutation-proof invocation recovers from the breadcrumb before proceeding.
{
  const hungSuite = join(root, "hung-suite.mjs");
  writeFileSync(hungSuite, [
    "import { existsSync } from 'node:fs';",
    "import { admit } from './src/impl.js';",
    "if (admit(50) === false) {",
    "  console.log('  ✓ clean baseline');",
    "  process.exit(0);",
    "} else {",
    "  console.log('  ✓ mutated hanging');",
    // Hang until this suite says so, not forever. The kill below takes the proof, not this child,
    // which `run()` starts in a process group of its own, so a bare `setInterval` outlived the
    // self-test: one orphan per run, and one per mutation when a config drives this suite. Not keyed
    // on the parent dying: the kill usually lands before the proof has spawned this, so the child
    // starts already reparented. The timeout bounds a run that never reaches the release.
    "  const release = process.env.MUTATION_SELFTEST_RELEASE;",
    "  setInterval(() => { if (release && existsSync(release)) process.exit(0); }, 100);",
    "  setTimeout(() => process.exit(0), 60_000);",
    "}",
    "",
  ].join("\n"));
  execSync("git add -A && git -c user.email=a@b -c user.name=c commit -qm hung-suite", { cwd: root });
  const impl = join(root, "src/impl.js");
  const shaClean = shaOf(impl);
  const mtimeClean = statSync(impl).mtimeMs;

  const release = `${root}-release`;
  sharedTmpFiles.push(release);
  const hardChild = spawn(process.execPath, [TOOL,
    "--command", `${process.execPath} hung-suite.mjs`,
    "--file", "src/impl.js", "--find", "if (n > 10)", "--replace", "if (false)",
    "--expect-red", "oversized values are refused",
  ], { cwd: root, stdio: "ignore", env: { ...process.env, MUTATION_SELFTEST_RELEASE: release } });

  let hardApplied = false;
  for (let i = 0; i < 600 && !hardApplied; i++) {
    hardApplied = execSync("git status --porcelain", { cwd: root, encoding: "utf8" }).trim() !== "";
    if (!hardApplied) await new Promise((done) => setTimeout(done, 50));
  }
  check("hard kill lands while mutation is applied", hardApplied);
  hardChild.kill("SIGKILL");
  // Kept until this suite exits: a child the proof spawned just before it died may start later.
  writeFileSync(release, "");
  await new Promise((done) => setTimeout(done, 200));

  // The mutant is left on disk right after SIGKILL
  check("mutant was left on disk after SIGKILL before recovery",
    readFileSync(join(root, "src/impl.js"), "utf8").includes("if (false)"));
  {
    const crumbs = breadcrumbsFor(root);
    check("...and a breadcrumb outside the tree names the file, its pre-mutation hash and the backup",
      crumbs.length === 1 && crumbs[0].body.targetPath === realpathSync(impl)
        && crumbs[0].body.shaBefore === shaClean && existsSync(crumbs[0].body.backupPath),
      crumbs.map((entry) => entry.body));
  }

  // Next run recovers the breadcrumb automatically
  const recoverStartedMs = Date.now();
  r = runTool(["--recover"]);
  check("next invocation recovers from breadcrumb",
    r.status === 0 && stripAnsi(r.stdout).includes("restored original contents"),
    r.stdout.slice(-300));
  check("...and the working tree is clean again after breadcrumb recovery",
    execSync("git status --porcelain", { cwd: root, encoding: "utf8" }).trim() === "");
  // Same tolerance as `a restored file keeps its original mtime`, for the reason given there. The
  // bytes alone are not the recovery: a timestamp that becomes the time of the recovery is what
  // `smoke:dist-freshness` reads as a stale package, and no hash comparison can see it.
  const mtimeRecovered = statSync(impl).mtimeMs;
  check("...and recovery puts the timestamp back, not the time of the recovery",
    mtimeRecovered < recoverStartedMs && Math.abs(mtimeRecovered - mtimeClean) <= 1,
    { mtimeClean, mtimeRecovered, recoverStartedMs, movedMs: mtimeRecovered - mtimeClean });
}

// A breadcrumb whose file already matches its baseline is evidence of nothing: the proof was killed
// before it wrote the mutant, or the operator recovered with git. Refusing on it would turn the
// `git checkout` recovery the refusal recommends into a state that refuses every later run.
const proveImpl = [
  "--command", `${process.execPath} suite.mjs`,
  "--file", "src/impl.js", "--find", "if (n > 10)", "--replace", "if (false)",
  "--expect-red", "oversized values are refused",
];
{
  const impl = join(root, "src/impl.js");
  const stale = join(tmpdir(), "mutation-proof-bc-selftest-stale.json");
  sharedTmpFiles.push(stale);
  writeFileSync(stale, JSON.stringify({
    targetPath: realpathSync(impl), backupPath: join(tmpdir(), "mutation-proof-selftest-no-such-backup.bak"),
    shaBefore: shaOf(impl), treeKey: realpathSync(root), pid: 1,
  }));
  r = runTool(proveImpl);
  check("a breadcrumb whose file already matches its baseline is cleared, and the proof runs",
    r.status === 0 && verdictIs(r.stdout, "KILLED") && !existsSync(stale),
    { status: r.status, out: stripAnsi(r.stdout).slice(0, 400), staleLeft: existsSync(stale) });
}

// A mutation still on disk whose backup is gone cannot be put back by this tool, and the run has to
// stop, because measuring in that tree grades a mutant stacked on a mutant. It has to stop by NAMING
// the interrupted proof: the dirty-tree refusal would stop it too, while telling the operator to
// commit work they never did.
{
  const impl = join(root, "src/impl.js");
  const live = join(tmpdir(), "mutation-proof-bc-selftest-live.json");
  sharedTmpFiles.push(live);
  const shaBaseline = shaOf(impl);
  writeFileSync(impl, readFileSync(impl, "utf8").replace("if (n > 10)", "if (false)"));
  writeFileSync(live, JSON.stringify({
    targetPath: realpathSync(impl), backupPath: join(tmpdir(), "mutation-proof-selftest-no-such-backup.bak"),
    shaBefore: shaBaseline, treeKey: realpathSync(root), pid: 1,
  }));
  r = runTool(proveImpl);
  const out = stripAnsi(r.stdout);
  check("a live mutation with no backup is refused by naming the interrupted proof, not the dirty tree",
    r.status === 3 && out.includes("live unrecovered mutation") && !out.includes("working tree is dirty"),
    { status: r.status, out: out.slice(0, 400) });
  execSync("git checkout -- .", { cwd: root });
  rmSync(live, { force: true });
}

// ---- the cleanup's own containment (#1625) -----------------------------------------------------
// A mutant that makes a directory helper return the PARENT of the directory it created hands
// `tmpdir()` to this suite's recursive cleanup, which then deletes other processes' files —
// including the live control sockets of every connector on the host. The guard must refuse a
// target one level up from its own root, and must still allow the root itself.
check("the cleanup guard refuses a target one level above its own mkdtemp root",
  refusalFor(dirname(root), base, dirname(root)) !== undefined, dirname(root));
check("...and it names that the target is not beneath its base, not some unrelated reason",
  /not strictly beneath/.test(refusalFor(base, base, base) ?? ""), refusalFor(base, base, base));
check("the cleanup guard refuses a target that is not the path mkdtemp returned",
  /not the path mkdtemp returned/.test(refusalFor(join(root, "sub"), base, root) ?? ""),
  refusalFor(join(root, "sub"), base, root));
check("...and it still permits the suite's own mkdtemp root",
  refusalFor(root, base, root) === undefined, refusalFor(root, base, root));

// The predicate checks above read the verdict. This one runs the ACTUAL ESCAPE end to end, because
// a correct verdict that no cleanup path consults is worth nothing: the report of #1625 is about a
// delete that happened, not about a boolean. A sandbox base stands in for the shared temp directory
// and holds a LISTENING unix socket, the same shape as the connector control sockets that were
// unlinked. A child then runs the mutant cleanup — the helper returns `dirname(created)`, so the
// base itself is handed to the recursive delete — and must refuse with exit 2 and leave the
// bystander in place. On a tree WITHOUT the guard this same child deletes the socket and exits 0,
// which is the original defect reproduced.
{
  const sandbox = mkdtempSync(join(base, "mutation-selftest-escape-"));
  const victimBase = join(sandbox, "shared-tmp");
  mkdirSync(victimBase, { recursive: true });
  const bystander = join(victimBase, "bystander.sock");
  const listener = createServer(() => {});
  await new Promise((ready) => listener.listen(bystander, ready));
  const created = mkdtempSync(join(victimBase, "suite-work-"));
  const escape = join(sandbox, "escape.mjs");
  writeFileSync(escape, [
    `import * as safety from ${JSON.stringify(pathToFileURL(join(dirname(fileURLToPath(import.meta.url)), "mutation-command-safety.mjs")).href)};`,
    "import { rmSync } from 'node:fs';",
    "import { dirname } from 'node:path';",
    `const base = ${JSON.stringify(victimBase)};`,
    `const created = ${JSON.stringify(created)};`,
    "// THE MUTANT: the directory helper returns the PARENT of what mkdtemp made.",
    "const escaped = dirname(created);",
    "if (typeof safety.removeSelfTestDir === 'function') safety.removeSelfTestDir(escaped, base, created);",
    "else rmSync(escaped, { recursive: true, force: true });",
    "",
  ].join("\n"));
  const escaped = spawnSync(process.execPath, [escape], { encoding: "utf8" });
  check("an escaped cleanup refuses instead of deleting, and exits 2 rather than 0 or 1",
    escaped.status === 2, { status: escaped.status, stderr: (escaped.stderr ?? "").slice(-300) });
  check("...and the refusal names the containment breach in its own output",
    /REFUSING to clean up/.test(escaped.stderr ?? ""), (escaped.stderr ?? "").slice(-300));
  check("...and the bystander socket in the shared base is still there afterwards",
    existsSync(bystander), { bystander, present: existsSync(bystander) });
  await new Promise((done) => listener.close(done));
  removeSelfTestDir(sandbox, base, sandbox);
}

removeSelfTestDir(root, base, root);
console.log(`\nMUTATION-PROOF SELF-TEST PASSED ✅  (${pass} checks)`);
