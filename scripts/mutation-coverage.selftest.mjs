#!/usr/bin/env node
/**
 * Self-test for `mutation-coverage.mjs`'s gradability check.
 *
 * The check exists because a mutation whose suite resolves the target package to `dist` reports
 * SURVIVED — honestly, and indistinguishably from a missing test. The second witness (`assembles`)
 * exists because a suite that COPIES the target's source tree into a fixture runs the mutated
 * bytes through the copy, where the resolver is never asked. Each half has a way to lie:
 *
 *   - the witness admitted without the suite referencing the tree   → the dist trap reopens wearing
 *                                                                     a declaration
 *   - the witness refused for a suite that assembles                → a gradable mutation is called
 *                                                                     ungradable and pushed to "unkillable"
 *
 * This drives the script against throwaway fixture configs where the right answer is known, both
 * ways. Fast on purpose: the "suite" is a shell exit code, so there is no reason to skip it.
 *
 * Run: node scripts/mutation-coverage.selftest.mjs
 */
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const TOOL = join(dirname(fileURLToPath(import.meta.url)), "mutation-coverage.mjs");
const root = mkdtempSync(join(tmpdir(), "mutation-coverage-selftest-"));
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

// A fixture tree: a package whose source a suite may import or copy, and three suites — one that
// assembles the source, one that imports the package by name from another package root, and one
// that imports it by name from INSIDE the same package (the exact shape the ../src witness guards).
mkdirSync(join(root, "packages/seat/src"), { recursive: true });
mkdirSync(join(root, "packages/seat/smoke"), { recursive: true });
mkdirSync(join(root, "packages/other"), { recursive: true });
mkdirSync(join(root, "bin/smoke"), { recursive: true });
writeFileSync(join(root, "packages/seat/package.json"), JSON.stringify({ name: "@cotal-ai/seat" }));
writeFileSync(join(root, "packages/seat/src/impl.ts"), "export const x = 1;\n");
writeFileSync(join(root, "packages/other/impl.ts"), "export const y = 1;\n");
writeFileSync(
  join(root, "bin/smoke/assembling.smoke.ts"),
  'import { cpSync } from "node:fs";\n' +
  'cpSync(join(ROOT, "packages", "seat"), clone, { recursive: true });\n',
);
writeFileSync(
  join(root, "bin/smoke/by-name.smoke.ts"),
  'import { x } from "@cotal-ai/seat";\n',
);
writeFileSync(
  join(root, "packages/seat/smoke/local-by-name.smoke.ts"),
  'import { x } from "@cotal-ai/seat";\n',
);

// A "suite" the script can tally: its terminal line is the only thing the coverage report parses.
const TALLY = `${process.execPath} -e "console.log('FIXTURE: 3 passed, 0 failed')"`;
const mutation = (file) => ({
  name: `mutates ${file}`, file, find: "x", replace: "y",
  expectRed: "the fixture cell", cell: "the fixture cell",
});
const writeConfig = (name, cfg) => writeFileSync(join(root, name), JSON.stringify(cfg));
const runTool = (config) =>
  spawnSync(process.execPath, [TOOL, config], { cwd: root, encoding: "utf8", timeout: 60_000 });

// 1. THE TRAP THE CHECK EXISTS FOR: same package, imported by name, no ../src, no declaration.
// Refused before this change and refused after it — the safety the `assembles` witness must not
// weaken, pinned first so the cells below cannot pass by widening the rule.
writeConfig("trap.json", {
  suite: "packages/seat/smoke/local-by-name.smoke.ts", command: TALLY,
  mutations: [mutation("packages/seat/src/impl.ts")],
});
let r = runTool("trap.json");
check(
  "a by-name import in the same package is still refused",
  r.status !== 0 && /assembles/.test(r.stderr) && /dist/.test(r.stderr),
  r.stderr.slice(-300),
);

// 2. THE WITNESS: the assembling suite is gradable when the config declares the tree it copies.
writeConfig("assembled.json", {
  suite: "bin/smoke/assembling.smoke.ts", command: TALLY, assembles: ["packages/seat"],
  mutations: [mutation("packages/seat/package.json")],
});
r = runTool("assembled.json");
check(
  "an assembling suite is gradable when the config declares the source tree it copies",
  r.status === 0 && r.stdout.includes("1 /   3 cells observed failing"),
  (r.stderr || r.stdout).slice(-300),
);

// 3. THE DECLARATION IS NOT THE WITNESS: same declaration, suite that never references the tree.
writeConfig("hollow.json", {
  suite: "bin/smoke/by-name.smoke.ts", command: TALLY, assembles: ["packages/seat"],
  mutations: [mutation("packages/seat/package.json")],
});
r = runTool("hollow.json");
check(
  "a declaration the suite source cannot back is refused",
  r.status !== 0 && /neither imports by source path nor reaches through/.test(r.stderr),
  r.stderr.slice(-300),
);

// 4. CONTAINMENT: a declared root cannot smuggle a file it does not contain.
writeConfig("foreign.json", {
  suite: "bin/smoke/assembling.smoke.ts", command: TALLY, assembles: ["packages/seat"],
  mutations: [mutation("packages/other/impl.ts")],
});
r = runTool("foreign.json");
check(
  "a declared root cannot smuggle a file outside it",
  r.status !== 0 && /assembles/.test(r.stderr),
  r.stderr.slice(-300),
);

// 5. SHAPE: `assembles` is an array of paths, and anything else is refused rather than guessed at.
writeConfig("malformed.json", {
  suite: "bin/smoke/assembling.smoke.ts", command: TALLY, assembles: "packages/seat",
  mutations: [mutation("packages/seat/package.json")],
});
r = runTool("malformed.json");
check(
  'a non-array "assembles" is refused',
  r.status !== 0 && /"assembles" must be an array/.test(r.stderr),
  r.stderr.slice(-300),
);

rmSync(root, { recursive: true, force: true });
console.log(`\nMUTATION-COVERAGE SELF-TEST: ${pass} passed, 0 failed`);
