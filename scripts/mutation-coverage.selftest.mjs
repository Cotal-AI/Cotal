#!/usr/bin/env node
/** Self-test for mutation-coverage's reachability, parser, and whole-corpus accounting. */
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const TOOL = join(dirname(fileURLToPath(import.meta.url)), "mutation-coverage.mjs");
const root = mkdtempSync(join(tmpdir(), "mutation-coverage-selftest-"));
let pass = 0;
const check = (name, condition, extra) => {
  if (!condition) {
    console.error(`\n  ✗ ${name}${extra !== undefined ? ` - ${JSON.stringify(extra)}` : ""}`);
    rmSync(root, { recursive: true, force: true });
    process.exit(1);
  }
  pass++;
  console.log(`  ✓ ${name}`);
};
const write = (path, value) => {
  const target = join(root, path);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, value);
};
const summaryCommand = (line) =>
  `${JSON.stringify(process.execPath)} -e ${JSON.stringify(`console.log(${JSON.stringify(line)})`)}`;
const mutation = (file) => ({
  name: `mutates ${file}`, file, find: "x", replace: "y",
  expectRed: "the fixture cell", cell: "the fixture cell",
});
const config = (name, value) => write(`${name}.json`, JSON.stringify(value));
const run = (...names) => spawnSync(process.execPath, [TOOL, ...names.map((name) => `${name}.json`)], {
  cwd: root, encoding: "utf8", timeout: 60_000,
});
const report = (result) => `${result.stdout}\n${result.stderr}`;

try {
  write("packages/seat/package.json", JSON.stringify({ name: "@cotal-ai/seat" }));
  write("packages/seat/src/index.ts", "export const x = 1;\n");
  write("packages/seat/smoke/local.smoke.ts", 'import { x } from "@cotal-ai/seat";\n');
  write("packages/other/package.json", JSON.stringify({ name: "@cotal-ai/other" }));
  write("packages/other/src/index.ts", "export const x = 1;\n");
  write("bin/entry.ts", 'import "@cotal-ai/seat";\n');
  write("bin/other-entry.ts", 'import "@cotal-ai/other";\n');
  write("bin/direct.mjs", "export const x = 1;\n");
  write("bin/smoke/assembling.smoke.ts", 'cpSync(join(ROOT, "packages", "seat"), clone);\n');
  write("bin/smoke/by-name.smoke.ts", 'import { x } from "@cotal-ai/seat";\n');
  write("bin/smoke/spawn-entry.smoke.ts",
    'const ENTRY = join(import.meta.dirname, "..", "entry.ts");\n' +
    'spawnSync(process.execPath, [ENTRY], { stdio: "inherit" });\n');
  write("bin/smoke/spawn-other.smoke.ts",
    'const ENTRY = join(import.meta.dirname, "..", "other-entry.ts");\n' +
    'spawnSync(process.execPath, [ENTRY], { stdio: "inherit" });\n');
  write("bin/smoke/reference-only.smoke.ts",
    'const ENTRY = join(import.meta.dirname, "..", "entry.ts");\nvoid ENTRY;\n');
  write("bin/smoke/direct.smoke.ts",
    'const ENTRY = join(import.meta.dirname, "..", "direct.mjs");\n' +
    'spawnSync(process.execPath, [ENTRY], { stdio: "inherit" });\n');
  write("fake-build.mjs", "process.exit(0);\n");
  execFileSync("git", ["init", "-q"], { cwd: root });
  execFileSync("git", ["add", "."], { cwd: root });
  execFileSync("git", ["-c", "user.name=fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "fixture"], { cwd: root });

  const tally = summaryCommand("FIXTURE: 3 passed, 0 failed");
  const seatBuild = `${JSON.stringify(process.execPath)} fake-build.mjs --filter @cotal-ai/seat build && ${tally}`;
  const otherBuild = `${JSON.stringify(process.execPath)} fake-build.mjs --filter @cotal-ai/other build && ${tally}`;

  config("trap", { suite: ["packages/seat/smoke/local.smoke.ts"], command: tally, mutations: [mutation("packages/seat/src/index.ts")] });
  let result = run("trap");
  check("a by-name same-package import without ../src is refused", result.status !== 0 && /REFUSED trap\.json/.test(result.stderr) && /dist/.test(result.stderr), report(result));

  config("assembled", { suite: ["bin/smoke/assembling.smoke.ts"], command: tally, assembles: ["packages/seat"], mutations: [mutation("packages/seat/package.json")] });
  result = run("assembled");
  check("the preserved assembles witness remains gradable", result.status === 0 && result.stdout.includes("1 /   3 cells observed failing"), report(result));

  config("hollow-assembled", { suite: ["bin/smoke/by-name.smoke.ts"], command: tally, assembles: ["packages/seat"], mutations: [mutation("packages/seat/package.json")] });
  result = run("hollow-assembled");
  check("an assembles declaration without a suite reference is refused", result.status !== 0 && /REFUSED hollow-assembled/.test(result.stderr), report(result));

  config("foreign-assembled", { suite: ["bin/smoke/assembling.smoke.ts"], command: tally, assembles: ["packages/seat"], mutations: [mutation("packages/other/src/index.ts")] });
  result = run("foreign-assembled");
  check("an assembled root cannot admit a foreign mutation", result.status !== 0 && /REFUSED foreign-assembled/.test(result.stderr), report(result));

  config("executed", { suite: ["bin/smoke/spawn-entry.smoke.ts"], command: seatBuild, executes: ["bin/entry.ts"], mutations: [mutation("packages/seat/src/index.ts")] });
  result = run("executed");
  check("a spawned repo entrypoint plus target-package build is gradable", result.status === 0 && /graded=1 refused-with-reason=0 unparsed=0/.test(result.stdout), report(result));

  config("direct", { suite: ["bin/smoke/direct.smoke.ts"], command: tally, executes: ["bin/direct.mjs"], mutations: [mutation("bin/direct.mjs")] });
  result = run("direct");
  check("a directly spawned mutated source entrypoint needs no build", result.status === 0 && /graded=1 refused-with-reason=0/.test(result.stdout), report(result));

  config("declaration-only", { suite: ["bin/smoke/by-name.smoke.ts"], command: seatBuild, executes: ["bin/entry.ts"], mutations: [mutation("packages/seat/src/index.ts")] });
  result = run("declaration-only");
  check("an executes declaration alone is refused", result.status !== 0 && /REFUSED declaration-only/.test(result.stderr), report(result));

  config("reference-only", { suite: ["bin/smoke/reference-only.smoke.ts"], command: seatBuild, executes: ["bin/entry.ts"], mutations: [mutation("packages/seat/src/index.ts")] });
  result = run("reference-only");
  check("an entrypoint reference not passed to a subprocess is refused", result.status !== 0 && /REFUSED reference-only/.test(result.stderr), report(result));

  config("wrong-entry", { suite: ["bin/smoke/spawn-other.smoke.ts"], command: seatBuild, executes: ["bin/other-entry.ts"], mutations: [mutation("packages/seat/src/index.ts")] });
  result = run("wrong-entry");
  check("an unrelated spawned entrypoint is refused", result.status !== 0 && /REFUSED wrong-entry/.test(result.stderr), report(result));

  config("wrong-build", { suite: ["bin/smoke/spawn-entry.smoke.ts"], command: otherBuild, executes: ["bin/entry.ts"], mutations: [mutation("packages/seat/src/index.ts")] });
  result = run("wrong-build");
  check("building an unrelated package does not admit the target", result.status !== 0 && /REFUSED wrong-build/.test(result.stderr), report(result));

  config("malformed-executes", { suite: ["bin/smoke/spawn-entry.smoke.ts"], command: seatBuild, executes: "bin/entry.ts", mutations: [mutation("packages/seat/src/index.ts")] });
  result = run("malformed-executes");
  check("a non-array executes declaration is refused", result.status !== 0 && /"executes" must be an array/.test(result.stderr), report(result));

  config("fraction", { suite: ["bin/smoke/direct.smoke.ts"], command: summaryCommand("ENDPOINT RESULTS: 4/4"), completionMarker: "ENDPOINT RESULTS:", executes: ["bin/direct.mjs"], mutations: [mutation("bin/direct.mjs")] });
  result = run("fraction");
  check("a completed all-passed fraction supplies the executed total", result.status === 0 && result.stdout.includes("1 /   4 cells observed failing"), report(result));

  config("partial-fraction", { suite: ["bin/smoke/direct.smoke.ts"], command: summaryCommand("ENDPOINT RESULTS: 3/4"), completionMarker: "ENDPOINT RESULTS:", executes: ["bin/direct.mjs"], mutations: [mutation("bin/direct.mjs")] });
  result = run("partial-fraction");
  check("a partial fraction is unparsed rather than graded", result.status !== 0 && /UNPARSED partial-fraction/.test(result.stderr) && /unparsed=1/.test(result.stdout), report(result));

  config("zero-failed", { suite: ["bin/smoke/direct.smoke.ts"], command: summaryCommand("FIXTURE SMOKE OK (0 failed)"), executes: ["bin/direct.mjs"], mutations: [mutation("bin/direct.mjs")] });
  result = run("zero-failed");
  check("zero failures without a total stays unparsed", result.status !== 0 && /UNPARSED zero-failed/.test(result.stderr), report(result));

  const ticks = `${JSON.stringify(process.execPath)} -e ${JSON.stringify("console.log('  ✓ one\\n  ✓ two\\n  ✓ three\\nFIXTURE PASSED')")}`;
  config("progress", { suite: ["bin/smoke/direct.smoke.ts"], command: ticks, progressPattern: "^  ✓ ", minTicks: 3, completionMarker: "FIXTURE PASSED", executes: ["bin/direct.mjs"], mutations: [mutation("bin/direct.mjs")] });
  result = run("progress");
  check("anchored progress plus an explicit completion marker supplies a total", result.status === 0 && result.stdout.includes("1 /   3 cells observed failing"), report(result));

  const noCompletion = `${JSON.stringify(process.execPath)} -e ${JSON.stringify("console.log('  ✓ one\\n  ✓ two\\n  ✓ three')")}`;
  config("unfinished-progress", { suite: ["bin/smoke/direct.smoke.ts"], command: noCompletion, progressPattern: "^  ✓ ", minTicks: 3, completionMarker: "FIXTURE PASSED", executes: ["bin/direct.mjs"], mutations: [mutation("bin/direct.mjs")] });
  result = run("unfinished-progress");
  check("progress without completion is unparsed", result.status !== 0 && /UNPARSED unfinished-progress/.test(result.stderr), report(result));

  config("no-suite", { command: tally, mutations: [mutation("bin/direct.mjs")] });
  result = run("no-suite");
  check("missing suite metadata is still refused", result.status !== 0 && /REFUSED no-suite/.test(result.stderr) && /MISSING SUITE METADATA|required top-level "suite"/.test(report(result)), report(result));

  config("legacy-suite", { suite: "bin/smoke/direct.smoke.ts", command: tally, executes: ["bin/direct.mjs"], mutations: [mutation("bin/direct.mjs")] });
  result = run("legacy-suite");
  check("a legacy string suite is still refused", result.status !== 0 && /REFUSED legacy-suite/.test(result.stderr) && /MALFORMED SUITE METADATA|legacy string/.test(report(result)), report(result));

  config("multi-source", { suite: ["bin/smoke/direct.smoke.ts", "bin/smoke/assembling.smoke.ts"], command: tally, executes: ["bin/direct.mjs"], mutations: [mutation("bin/direct.mjs")] });
  result = run("multi-source");
  check("a valid multi-source fixture is still graded", result.status === 0 && /graded=1 refused-with-reason=0/.test(result.stdout), report(result));

  result = run("declaration-only", "zero-failed", "fraction");
  check(
    "one bad config does not hide later configs",
    result.status !== 0 && /enumerated=3 examined=3 graded=1 refused-with-reason=1 unparsed=1/.test(result.stdout),
    report(result),
  );
} finally {
  rmSync(root, { recursive: true, force: true });
}
console.log(`\nMUTATION-COVERAGE SELF-TEST: ${pass} passed, 0 failed`);
