#!/usr/bin/env node
/**
 * Self-test for mutation-coverage's source-reachability auditor.
 *
 * A root-level suite may import a root-level script directly. That import is source-reachable even
 * though neither file lives under a two-segment package root and the specifier does not contain
 * `../src/`. A nearby relative import of a different file remains insufficient evidence.
 *
 * Run: pnpm smoke:mutation-coverage
 */
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const TOOL = join(dirname(fileURLToPath(import.meta.url)), "mutation-coverage.mjs");
const root = mkdtempSync(join(tmpdir(), "mutation-coverage-selftest-"));
let passed = 0, failed = 0;
const check = (name, condition, detail = "") => {
  if (condition) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.log(`  ✗ FAIL: ${name}`, detail); }
};

try {
  mkdirSync(join(root, "scripts"), { recursive: true });
  mkdirSync(join(root, "bin/smoke"), { recursive: true });
  writeFileSync(join(root, "scripts/target.mjs"), "export const value = 1;\n");
  writeFileSync(join(root, "scripts/other.mjs"), "export const value = 1;\n");
  writeFileSync(join(root, "bin/smoke/direct.smoke.mjs"), [
    "import { value } from '../../scripts/target.mjs';",
    "console.log(`direct root source smoke: ${value} passed, 0 failed`);",
    "",
  ].join("\n"));
  writeFileSync(join(root, "bin/smoke/other.smoke.mjs"), [
    "import { value } from '../../scripts/other.mjs';",
    "console.log(`other root source smoke: ${value} passed, 0 failed`);",
    "",
  ].join("\n"));
  const mutation = {
    name: "root source target",
    file: "scripts/target.mjs",
    find: "export const value = 1;",
    replace: "export const value = 2;",
    expectRed: "root source target",
    cell: "root source target",
  };
  writeFileSync(join(root, "direct.json"), JSON.stringify({
    suite: "bin/smoke/direct.smoke.mjs",
    command: `${process.execPath} bin/smoke/direct.smoke.mjs`,
    mutations: [mutation],
  }));
  writeFileSync(join(root, "other.json"), JSON.stringify({
    suite: "bin/smoke/other.smoke.mjs",
    command: `${process.execPath} bin/smoke/other.smoke.mjs`,
    mutations: [mutation],
  }));
  execFileSync("git", ["init", "-q"], { cwd: root });

  const direct = spawnSync(process.execPath, [TOOL, "direct.json"], { cwd: root, encoding: "utf8" });
  check(
    "an exact static relative import makes a root script mutation source-gradable",
    direct.status === 0 && direct.stdout.includes("1 /   1 cells observed failing"),
    `${direct.stdout}${direct.stderr}`,
  );
  const other = spawnSync(process.execPath, [TOOL, "other.json"], { cwd: root, encoding: "utf8" });
  check(
    "a relative import of another root script does not make the target source-gradable",
    other.status !== 0 && `${other.stdout}${other.stderr}`.includes("does not import by source path"),
    `${other.stdout}${other.stderr}`,
  );
} finally {
  rmSync(root, { recursive: true, force: true });
}

const EXPECTED = 2;
check(`every cell ran (${EXPECTED} before sentinel)`, passed + failed === EXPECTED);
console.log(`MUTATION COVERAGE SELFTEST ${failed === 0 ? "OK" : "FAILED"} (${passed} passed, ${failed} failed)`);
if (failed) process.exitCode = 1;
