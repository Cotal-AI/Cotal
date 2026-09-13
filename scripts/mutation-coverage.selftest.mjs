#!/usr/bin/env node
/** Self-test for mutation-coverage's reachability, parser, and whole-corpus accounting. */
import { chmodSync, existsSync, mkdtempSync, mkdirSync, unlinkSync, writeFileSync, rmSync } from "node:fs";
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
const runArgs = (...argv) => spawnSync(process.execPath, [TOOL, ...argv], {
  cwd: root, encoding: "utf8", timeout: 60_000, env: { ...process.env, PATH: `${root}:${process.env.PATH}` },
});
const run = (...names) => runArgs(...names.map((name) => `${name}.json`));
const report = (result) => `${result.stdout}\n${result.stderr}`;

try {
  write("packages/seat/package.json", JSON.stringify({ name: "@cotal-ai/seat" }));
  write("packages/seat/src/index.ts", "export const x = 1;\n");
  write("packages/seat/smoke/local.smoke.ts", 'import { x } from "@cotal-ai/seat";\n');
  write("packages/seat/smoke/src-import.smoke.ts", 'import { x } from "../src/index.js";\n');
  write("packages/seat/smoke/comment-src.smoke.ts", 'const note = "see ../src/index.ts for details";\n');
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
  write("bin/smoke/pty-entry.smoke.ts",
    'const here = dirname(fileURLToPath(import.meta.url));\n' +
    'const repoRoot = resolve(here, "../..");\n' +
    'const ENTRY = join(repoRoot, "bin", "entry.ts");\n' +
    'pty.spawn(process.execPath, [ENTRY], { cwd: process.cwd() });\n');
  write("bin/smoke/spawn-other.smoke.ts",
    'const ENTRY = join(import.meta.dirname, "..", "other-entry.ts");\n' +
    'spawnSync(process.execPath, [ENTRY], { stdio: "inherit" });\n');
  write("bin/smoke/reference-only.smoke.ts",
    'const ENTRY = join(import.meta.dirname, "..", "entry.ts");\nvoid ENTRY;\n');
  write("bin/smoke/wrong-executable.smoke.ts",
    'const ENTRY = join(import.meta.dirname, "..", "entry.ts");\n' +
    'spawnSync("echo", [ENTRY]);\n');
  write("bin/smoke/commented-spawn.smoke.ts",
    'const ENTRY = join(import.meta.dirname, "..", "entry.ts");\n' +
    '// spawnSync(process.execPath, [ENTRY]);\n');
  write("bin/smoke/despawn.smoke.ts",
    'const ENTRY = join(import.meta.dirname, "..", "entry.ts");\n' +
    'despawnSync(process.execPath, [ENTRY]);\n');
  write("bin/smoke/args-variable.smoke.ts",
    'const ENTRY = join(import.meta.dirname, "..", "entry.ts");\n' +
    'const ARGS = [ENTRY];\nspawnSync(process.execPath, ARGS);\n');
  write("bin/comment-entry.ts", '// import "@cotal-ai/seat";\n');
  write("bin/smoke/comment-import.smoke.ts",
    'const ENTRY = join(import.meta.dirname, "..", "comment-entry.ts");\n' +
    'spawnSync(process.execPath, [ENTRY]);\n');
  write("bin/smoke/direct.smoke.ts",
    'const ENTRY = join(import.meta.dirname, "..", "direct.mjs");\n' +
    'spawnSync(process.execPath, [ENTRY], { stdio: "inherit" });\n');
  write("bin/smoke/direct-suite.smoke.ts", "console.log('direct');\n");
  write("scripts/direct.mjs", "console.log('direct');\n");
  write("bin/smoke/direct-script.smoke.ts",
    'spawnSync(process.execPath, [join(ROOT, "scripts", "direct.mjs")]);\n');
  write("bin/smoke/aliased-launcher.smoke.ts",
    'import { spawnSync as run } from "node:child_process";\n' +
    'run(process.execPath, [join(ROOT, "scripts", "direct.mjs")]);\n');
  write("bin/smoke/bound-entry.smoke.ts",
    'const ENTRY = join(ROOT, "scripts", "direct.mjs");\n' +
    'execFileSync(process.execPath, [ENTRY]);\n');
  write("bin/smoke/node-by-name.smoke.ts",
    'spawnSync("node", [join(ROOT, "scripts", "direct.mjs")]);\n');
  write("bin/smoke/bound-entry-unused.smoke.ts",
    'const ENTRY = join(ROOT, "scripts", "direct.mjs");\n' +
    'spawnSync(process.execPath, ["-e", "void 0"]);\n' +
    'console.log(ENTRY);\n');
  write("bin/smoke/mentions-script.smoke.ts",
    'const note = "scripts/direct.mjs";\n');
  write("bin/smoke/unused-root.smoke.ts",
    'import { x } from "@cotal-ai/seat";\n' +
    'const unused = join(ROOT, "packages", "seat");\n');
  write("bin/smoke/unrelated-spawn.smoke.ts",
    'spawnSync(process.execPath, ["-e", "void 0"]);\n' +
    'const unused = join(ROOT, "scripts", "direct.mjs");\n');
  write("bin/smoke/eval-extra-arg.smoke.ts",
    'spawnSync(process.execPath, ["-e", "void 0", join(ROOT, "scripts", "direct.mjs")]);\n');
  write("bin/smoke/eval-env.smoke.ts",
    'spawnSync(process.execPath, ["-e", "void 0"], { env: { HINT: join(ROOT, "scripts", "direct.mjs") } });\n');
  write("bin/smoke/eval-then-script.smoke.ts",
    'spawnSync(process.execPath, ["-e", "void 0", "--", join(ROOT, "scripts", "direct.mjs")]);\n');
  write("bin/smoke/import-then-script.smoke.ts",
    'spawnSync(process.execPath, ["--import", "tsx", join(ROOT, "scripts", "direct.mjs")]);\n');
  write("pnpm", "#!/bin/sh\nexit 0\n");
  chmodSync(join(root, "pnpm"), 0o755);
  execFileSync("git", ["init", "-q"], { cwd: root });
  execFileSync("git", ["add", "."], { cwd: root });
  execFileSync("git", ["-c", "user.name=fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "fixture"], { cwd: root });
  const fixtureHead = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();

  const tally = summaryCommand("FIXTURE: 3 passed, 0 failed");
  const seatBuild = `pnpm --filter @cotal-ai/seat build && ${tally}`;
  const equalsSeatBuild = `pnpm --filter=@cotal-ai/seat build && ${tally}`;
  const otherBuild = `pnpm --filter @cotal-ai/other build && ${tally}`;
  const fakePrintedBuild = `${JSON.stringify(process.execPath)} -e ${JSON.stringify("console.log('pnpm build')")} && ${tally}`;

  config("trap", { suite: ["packages/seat/smoke/local.smoke.ts"], command: tally, mutations: [mutation("packages/seat/src/index.ts")] });
  let result = run("trap");
  check("a by-name same-package import without ../src is refused", result.status !== 0 && /REFUSED trap\.json/.test(result.stderr) && /dist/.test(result.stderr), report(result));

  config("src-import", { suite: ["packages/seat/smoke/src-import.smoke.ts"], command: tally, mutations: [mutation("packages/seat/src/index.ts")] });
  result = run("src-import");
  check("a value import of ../src is gradable for a same-package source file", result.status === 0 && result.stdout.includes("1 /   3 cells observed failing"), report(result));

  config("comment-src", { suite: ["packages/seat/smoke/comment-src.smoke.ts"], command: tally, mutations: [mutation("packages/seat/src/index.ts")] });
  result = run("comment-src");
  check("a string mentioning ../src is not a source import", result.status !== 0 && /REFUSED comment-src/.test(result.stderr), report(result));

  config("assembled", { suite: ["bin/smoke/assembling.smoke.ts"], command: tally, assembles: ["packages/seat"], mutations: [mutation("packages/seat/package.json")] });
  result = run("assembled");
  check("the preserved assembles witness remains gradable", result.status === 0 && result.stdout.includes("1 /   3 cells observed failing"), report(result));

  config("hollow-assembled", { suite: ["bin/smoke/by-name.smoke.ts"], command: tally, assembles: ["packages/seat"], mutations: [mutation("packages/seat/package.json")] });
  result = run("hollow-assembled");
  check("an assembles declaration without a suite reference is refused", result.status !== 0 && /REFUSED hollow-assembled/.test(result.stderr), report(result));

  config("foreign-assembled", { suite: ["bin/smoke/assembling.smoke.ts"], command: tally, assembles: ["packages/seat"], mutations: [mutation("packages/other/src/index.ts")] });
  result = run("foreign-assembled");
  check("an assembled root cannot admit a foreign mutation", result.status !== 0 && /REFUSED foreign-assembled/.test(result.stderr), report(result));

  config("direct-suite", { suite: ["bin/smoke/direct-suite.smoke.ts"], command: tally, mutations: [mutation("bin/smoke/direct-suite.smoke.ts")] });
  result = run("direct-suite");
  check("a suite is gradable when it directly executes the file being mutated", result.status === 0 && result.stdout.includes("1 /   3 cells observed failing"), report(result));

  config("direct-script", { suite: ["bin/smoke/direct-script.smoke.ts"], command: tally, mutations: [mutation("scripts/direct.mjs")] });
  result = run("direct-script");
  check("a suite is gradable when it launches the exact mutated script path", result.status === 0 && result.stdout.includes("1 /   3 cells observed failing"), report(result));

  config("aliased-launcher", { suite: ["bin/smoke/aliased-launcher.smoke.ts"], command: tally, mutations: [mutation("scripts/direct.mjs")] });
  result = run("aliased-launcher");
  check("a launcher imported under an alias still witnesses the script it runs", result.status === 0 && result.stdout.includes("1 /   3 cells observed failing"), report(result));

  config("bound-entry", { suite: ["bin/smoke/bound-entry.smoke.ts"], command: tally, mutations: [mutation("scripts/direct.mjs")] });
  result = run("bound-entry");
  check("a target bound to a const before the launcher call still witnesses it", result.status === 0 && result.stdout.includes("1 /   3 cells observed failing"), report(result));

  config("node-by-name", { suite: ["bin/smoke/node-by-name.smoke.ts"], command: tally, mutations: [mutation("scripts/direct.mjs")] });
  result = run("node-by-name");
  check("spawning \"node\" by name is the same witness as process.execPath", result.status === 0 && result.stdout.includes("1 /   3 cells observed failing"), report(result));

  config("mentions-script", { suite: ["bin/smoke/mentions-script.smoke.ts"], command: tally, mutations: [mutation("scripts/direct.mjs")] });
  result = run("mentions-script");
  check("a quoted script path without an invocation is refused", result.status !== 0 && /REFUSED mentions-script/.test(result.stderr), report(result));

  config("bound-entry-unused", { suite: ["bin/smoke/bound-entry-unused.smoke.ts"], command: tally, mutations: [mutation("scripts/direct.mjs")] });
  result = run("bound-entry-unused");
  check("a name bound to the target but never passed to a launcher is still refused", result.status !== 0 && /REFUSED bound-entry-unused/.test(result.stderr), report(result));

  config("malformed-assembles", { suite: ["bin/smoke/assembling.smoke.ts"], command: tally, assembles: "packages/seat", mutations: [mutation("packages/seat/package.json")] });
  result = run("malformed-assembles");
  check('a non-array "assembles" is refused', result.status !== 0 && /"assembles" must be an array/.test(result.stderr), report(result));

  config("unused-root", { suite: ["bin/smoke/unused-root.smoke.ts"], command: tally, assembles: ["packages/seat"], mutations: [mutation("packages/seat/src/index.ts")] });
  result = run("unused-root");
  check("an unused root spelling beside a by-name import is refused", result.status !== 0 && /REFUSED unused-root/.test(result.stderr), report(result));

  config("unrelated-spawn", { suite: ["bin/smoke/unrelated-spawn.smoke.ts"], command: tally, mutations: [mutation("scripts/direct.mjs")] });
  result = run("unrelated-spawn");
  check("an unrelated spawn near a quoted path is refused", result.status !== 0 && /REFUSED unrelated-spawn/.test(result.stderr), report(result));

  config("eval-extra-arg", { suite: ["bin/smoke/eval-extra-arg.smoke.ts"], command: tally, mutations: [mutation("scripts/direct.mjs")] });
  result = run("eval-extra-arg");
  check("a path after -e is not a launched script", result.status !== 0 && /REFUSED eval-extra-arg/.test(result.stderr), report(result));

  config("eval-env", { suite: ["bin/smoke/eval-env.smoke.ts"], command: tally, mutations: [mutation("scripts/direct.mjs")] });
  result = run("eval-env");
  check("a path in spawn env is not a launched script", result.status !== 0 && /REFUSED eval-env/.test(result.stderr), report(result));

  config("eval-then-script", { suite: ["bin/smoke/eval-then-script.smoke.ts"], command: tally, mutations: [mutation("scripts/direct.mjs")] });
  result = run("eval-then-script");
  check("a path after -e and -- is not a launched script", result.status !== 0 && /REFUSED eval-then-script/.test(result.stderr), report(result));

  config("import-then-script", { suite: ["bin/smoke/import-then-script.smoke.ts"], command: tally, mutations: [mutation("scripts/direct.mjs")] });
  result = run("import-then-script");
  check("a script after --import still witnesses the launched file", result.status === 0 && result.stdout.includes("1 /   3 cells observed failing"), report(result));

  config("executed", { suite: ["bin/smoke/spawn-entry.smoke.ts"], command: seatBuild, executes: ["bin/entry.ts"], mutations: [mutation("packages/seat/src/index.ts")] });
  result = run("executed");
  check("a spawned repo entrypoint plus target-package build is gradable", result.status === 0 && /graded=1 refused-with-reason=0 unparsed=0/.test(result.stdout), report(result));

  const skippedBuild = `false && pnpm --filter @cotal-ai/seat build || ${tally}`;
  config("skipped-build", { suite: ["bin/smoke/spawn-entry.smoke.ts"], command: skippedBuild, executes: ["bin/entry.ts"], mutations: [mutation("packages/seat/src/index.ts")] });
  result = run("skipped-build");
  check("a package build that never runs is refused", result.status !== 0 && /REFUSED skipped-build/.test(result.stderr), report(result));

  config("pty-executed", { suite: ["bin/smoke/pty-entry.smoke.ts"], command: seatBuild, executes: ["bin/entry.ts"], mutations: [mutation("packages/seat/src/index.ts")] });
  result = run("pty-executed");
  check("a pty-spawned repo entrypoint is also gradable", result.status === 0 && /graded=1 refused-with-reason=0/.test(result.stdout), report(result));

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

  for (const [name, suite, entry, command] of [
    ["wrong-executable", "bin/smoke/wrong-executable.smoke.ts", "bin/entry.ts", seatBuild],
    ["commented-spawn", "bin/smoke/commented-spawn.smoke.ts", "bin/entry.ts", seatBuild],
    ["despawn", "bin/smoke/despawn.smoke.ts", "bin/entry.ts", seatBuild],
    ["comment-import", "bin/smoke/comment-import.smoke.ts", "bin/comment-entry.ts", seatBuild],
    ["printed-build", "bin/smoke/spawn-entry.smoke.ts", "bin/entry.ts", fakePrintedBuild],
  ]) {
    config(name, { suite: [suite], command, executes: [entry], mutations: [mutation("packages/seat/src/index.ts")] });
    result = run(name);
    check(`${name} cannot fabricate executes evidence`, result.status !== 0 && new RegExp(`REFUSED ${name}`).test(result.stderr), report(result));
  }

  config("args-variable", { suite: ["bin/smoke/args-variable.smoke.ts"], command: seatBuild, executes: ["bin/entry.ts"], mutations: [mutation("packages/seat/src/index.ts")] });
  result = run("args-variable");
  check("a genuine subprocess argument array is accepted", result.status === 0 && /graded=1 refused-with-reason=0/.test(result.stdout), report(result));

  config("equals-filter", { suite: ["bin/smoke/spawn-entry.smoke.ts"], command: equalsSeatBuild, executes: ["bin/entry.ts"], mutations: [mutation("packages/seat/src/index.ts")] });
  result = run("equals-filter");
  check("the pnpm --filter=value build form is accepted", result.status === 0 && /graded=1 refused-with-reason=0/.test(result.stdout), report(result));

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
  config("progress-banner", { suite: ["bin/smoke/direct.smoke.ts"], command: ticks, progressPattern: "^  ✓ ", minTicks: 3, completionMarker: "FIXTURE PASSED", executes: ["bin/direct.mjs"], mutations: [mutation("bin/direct.mjs")] });
  result = run("progress-banner");
  check(
    "a declared terminal banner is not an executed-cell total",
    result.status !== 0 && /UNPARSED progress-banner/.test(result.stderr),
    report(result),
  );

  config("progress", { suite: ["bin/smoke/direct.smoke.ts"], command: ticks, progressPattern: "^  ✓ ", minTicks: 3, completionMarker: "FIXTURE PASSED", executes: ["bin/direct.mjs"], mutations: [mutation("bin/direct.mjs")] });
  result = run("progress");
  check(
    "a terminal banner without a printed number is unparsed",
    result.status !== 0 && /UNPARSED progress/.test(result.stderr)
      && /progress ticks are not an executed-cell total/.test(result.stderr)
      && /the instrument grades only a number the suite printed/.test(result.stderr),
    report(result),
  );

  const noCompletion = `${JSON.stringify(process.execPath)} -e ${JSON.stringify("console.log('  ✓ one\\n  ✓ two\\n  ✓ three')")}`;
  config("unfinished-progress", { suite: ["bin/smoke/direct.smoke.ts"], command: noCompletion, progressPattern: "^  ✓ ", minTicks: 3, completionMarker: "FIXTURE PASSED", executes: ["bin/direct.mjs"], mutations: [mutation("bin/direct.mjs")] });
  result = run("unfinished-progress");
  check("progress without a printed number is unparsed", result.status !== 0 && /UNPARSED unfinished-progress/.test(result.stderr), report(result));

  config("progress-no-marker", { suite: ["bin/smoke/direct.smoke.ts"], command: ticks, progressPattern: "^  ✓ ", minTicks: 3, executes: ["bin/direct.mjs"], mutations: [mutation("bin/direct.mjs")] });
  result = run("progress-no-marker");
  check(
    "progress without a declared completionMarker names why it is unparsed",
    result.status !== 0 && /UNPARSED progress-no-marker/.test(result.stderr)
      && /progress ticks are not an executed-cell total/.test(result.stderr)
      && /the instrument grades only a number the suite printed/.test(result.stderr),
    report(result),
  );

  config("progress-no-minticks", { suite: ["bin/smoke/direct.smoke.ts"], command: ticks, progressPattern: "^  ✓ ", executes: ["bin/direct.mjs"], mutations: [mutation("bin/direct.mjs")] });
  result = run("progress-no-minticks");
  check(
    "progress without minTicks names why it is unparsed",
    result.status !== 0 && /UNPARSED progress-no-minticks/.test(result.stderr)
      && /progressPattern is present and minTicks is absent/.test(result.stderr),
    report(result),
  );

  config("progress-minticks-no-pattern", { suite: ["bin/smoke/direct.smoke.ts"], command: ticks, minTicks: 3, executes: ["bin/direct.mjs"], mutations: [mutation("bin/direct.mjs")] });
  result = run("progress-minticks-no-pattern");
  check(
    "minTicks without progressPattern names why it is unparsed",
    result.status !== 0 && /UNPARSED progress-minticks-no-pattern/.test(result.stderr)
      && /minTicks is present and progressPattern is absent/.test(result.stderr)
      && /the progress path cannot run at all/.test(result.stderr),
    report(result),
  );

  const markerOffTerminal = `${JSON.stringify(process.execPath)} -e ${JSON.stringify("console.log('  ✓ one\\n  ✓ two\\n  ✓ three\\nhost pins the seat binary against background self-update\\nJCODE HOST SMOKE PASSED (85 checks)')")}`;
  config("progress-marker-not-terminal", {
    suite: ["bin/smoke/direct.smoke.ts"],
    command: markerOffTerminal,
    progressPattern: "^  ✓ ",
    minTicks: 3,
    completionMarker: "host pins the seat binary against background self-update",
    executes: ["bin/direct.mjs"],
    mutations: [mutation("bin/direct.mjs")],
  });
  result = run("progress-marker-not-terminal");
  check(
    "progress with a non-terminal completionMarker names why it is unparsed",
    result.status !== 0 && /UNPARSED progress-marker-not-terminal/.test(result.stderr)
      && /progress ticks are not an executed-cell total/.test(result.stderr),
    report(result),
  );

  for (const [name, text] of [
    ["early-ok", "SETUP OK\\n  ✓ one\\n  ✓ two\\nWORK REMAINS"],
    ["tick-passed", "  ✓ setup PASSED\\n  ✓ second\\nWORK REMAINS"],
  ]) {
    config(name, { suite: ["bin/smoke/direct.smoke.ts"], command: `${JSON.stringify(process.execPath)} -e ${JSON.stringify(`console.log(${JSON.stringify(text)})`)}`, progressPattern: "^  ✓ ", minTicks: 2, executes: ["bin/direct.mjs"], mutations: [mutation("bin/direct.mjs")] });
    result = run(name);
    check(`${name} is not a terminal completion witness`, result.status !== 0 && new RegExp(`UNPARSED ${name}`).test(result.stderr), report(result));
  }

  const ticksNot = `${JSON.stringify(process.execPath)} -e ${JSON.stringify("console.log('  ✓ one\\n  ✓ two\\n  ✓ three\\nNOT FIXTURE PASSED')")}`;
  config("progress-not-marker", { suite: ["bin/smoke/direct.smoke.ts"], command: ticksNot, progressPattern: "^  ✓ ", minTicks: 3, completionMarker: "FIXTURE PASSED", executes: ["bin/direct.mjs"], mutations: [mutation("bin/direct.mjs")] });
  result = run("progress-not-marker");
  check("a terminal line that contains and negates the marker is unparsed without a printed number", result.status !== 0 && /UNPARSED progress-not-marker/.test(result.stderr), report(result));

  const ticksPrefixed = `${JSON.stringify(process.execPath)} -e ${JSON.stringify("console.log('  ✓ one\\n  ✓ two\\n  ✓ three\\nrun complete: FIXTURE PASSED')")}`;
  config("progress-prefixed-marker", { suite: ["bin/smoke/direct.smoke.ts"], command: ticksPrefixed, progressPattern: "^  ✓ ", minTicks: 3, completionMarker: "FIXTURE PASSED", executes: ["bin/direct.mjs"], mutations: [mutation("bin/direct.mjs")] });
  result = run("progress-prefixed-marker");
  check("a prefixed completion marker without a printed number is unparsed (the #1464 must-accept pin was pinning banner-as-completion)", result.status !== 0 && /UNPARSED progress-prefixed-marker/.test(result.stderr), report(result));

  const ticksPrefixedFraction = `${JSON.stringify(process.execPath)} -e ${JSON.stringify("console.log('  ✓ one\\n  ✓ two\\n  ✓ three\\nrun complete: FIXTURE PASSED 3/3')")}`;
  config("progress-prefixed-fraction", { suite: ["bin/smoke/direct.smoke.ts"], command: ticksPrefixedFraction, progressPattern: "^  ✓ ", minTicks: 3, completionMarker: "FIXTURE PASSED", executes: ["bin/direct.mjs"], mutations: [mutation("bin/direct.mjs")] });
  result = run("progress-prefixed-fraction");
  check("a prefixed completion marker still grades", result.status === 0 && result.stdout.includes("1 /   3 cells observed failing"), report(result));

  const ticksChecks = `${JSON.stringify(process.execPath)} -e ${JSON.stringify("console.log('  ✓ one\\n  ✓ two\\n  ✓ three\\n  42 checks passed')")}`;
  config("midline-checks", { suite: ["bin/smoke/direct.smoke.ts"], command: ticksChecks, progressPattern: "^  ✓ ", minTicks: 3, completionMarker: "checks passed", executes: ["bin/direct.mjs"], mutations: [mutation("bin/direct.mjs")] });
  result = run("midline-checks");
  check("a mid-line checks-passed marker still grades", result.status === 0 && /graded=1/.test(result.stdout), report(result));

  const ticksAnsi = `${JSON.stringify(process.execPath)} -e ${JSON.stringify("console.log('  ✓ one\\n  ✓ two\\n  ✓ three\\n\\u001b[32mFIXTURE PASSED\\u001b[0m')")}`;
  config("progress-ansi-marker", { suite: ["bin/smoke/direct.smoke.ts"], command: ticksAnsi, progressPattern: "^  ✓ ", minTicks: 3, completionMarker: "FIXTURE PASSED", executes: ["bin/direct.mjs"], mutations: [mutation("bin/direct.mjs")] });
  result = run("progress-ansi-marker");
  check("an ANSI-coloured banner without a printed number is unparsed (the #1464 must-accept pin was pinning banner-as-completion)", result.status !== 0 && /UNPARSED progress-ansi-marker/.test(result.stderr), report(result));

  const ticksAnsiFraction = `${JSON.stringify(process.execPath)} -e ${JSON.stringify("console.log('  ✓ one\\n  ✓ two\\n  ✓ three\\n\\u001b[32mFIXTURE PASSED 3/3\\u001b[0m')")}`;
  config("progress-ansi-fraction", { suite: ["bin/smoke/direct.smoke.ts"], command: ticksAnsiFraction, progressPattern: "^  ✓ ", minTicks: 3, completionMarker: "FIXTURE PASSED", executes: ["bin/direct.mjs"], mutations: [mutation("bin/direct.mjs")] });
  result = run("progress-ansi-fraction");
  check("an ANSI-coloured completion banner still grades", result.status === 0 && result.stdout.includes("1 /   3 cells observed failing"), report(result));

  const ticksTrail = `${JSON.stringify(process.execPath)} -e ${JSON.stringify("console.log('  ✓ one\\n  ✓ two\\n  ✓ three\\nFIXTURE PASSED but cleanup failed')")}`;
  config("progress-trailing-marker", { suite: ["bin/smoke/direct.smoke.ts"], command: ticksTrail, progressPattern: "^  ✓ ", minTicks: 3, completionMarker: "FIXTURE PASSED", executes: ["bin/direct.mjs"], mutations: [mutation("bin/direct.mjs")] });
  result = run("progress-trailing-marker");
  check("trailing text after the marker is unparsed without a printed number", result.status !== 0 && /UNPARSED progress-trailing-marker/.test(result.stderr), report(result));

  const ticksTrailFraction = `${JSON.stringify(process.execPath)} -e ${JSON.stringify("console.log('  ✓ one\\n  ✓ two\\n  ✓ three\\nFIXTURE PASSED 3/3 but cleanup failed')")}`;
  config("progress-trailing-fraction", { suite: ["bin/smoke/direct.smoke.ts"], command: ticksTrailFraction, progressPattern: "^  ✓ ", minTicks: 3, completionMarker: "FIXTURE PASSED", executes: ["bin/direct.mjs"], mutations: [mutation("bin/direct.mjs")] });
  result = run("progress-trailing-fraction");
  check("trailing text after a complete fraction on the marker line is accepted today (see #1464)", result.status === 0 && result.stdout.includes("1 /   3 cells observed failing"), report(result));

  config("invalid-regex", { suite: ["bin/smoke/direct.smoke.ts"], command: tally, progressPattern: "[", minTicks: 1, executes: ["bin/direct.mjs"], mutations: [mutation("bin/direct.mjs")] });
  result = run("invalid-regex", "fraction");
  check("an invalid progress regex is refused without hiding the next config", result.status !== 0 && /enumerated=2 examined=2 graded=1 refused-with-reason=1/.test(result.stdout), report(result));

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
  check("the audit summary names the exact checkout tree", result.stdout.includes(`head=${fixtureHead}`), report(result));

  const sentinelPath = (name) => join(root, `mark-${name}`);
  const sentinelCmd = (name, tag = "") => {
    const inner = `require("fs").writeFileSync(${JSON.stringify(sentinelPath(name))}, "ran"); console.log("FIXTURE: 3 passed, 0 failed");`;
    const node = `${JSON.stringify(process.execPath)} -e ${JSON.stringify(inner)}`;
    return tag ? `${node} # ${tag}` : node;
  };
  const fenceBody = (command) => ({
    suite: ["bin/smoke/direct.smoke.ts"],
    command,
    executes: ["bin/direct.mjs"],
    mutations: [mutation("bin/direct.mjs")],
  });
  const clearSentinels = (...names) => {
    for (const name of names) try { unlinkSync(sentinelPath(name)); } catch { /* absent */ }
  };
  const fenceNames = ["safe-a", "safe-b", "safe-c", "safe-d", "safe-e", "suffix", "ops"];
  for (const name of ["safe-a", "safe-b", "safe-c", "safe-d", "safe-e"]) {
    write(`bin/smoke/mutations/${name}.json`, JSON.stringify(fenceBody(sentinelCmd(name))));
  }
  write("bin/smoke/mutations/suffix.json", JSON.stringify(fenceBody(sentinelCmd("suffix", "pnpm smoke:user-spawn:live"))));
  write("bin/smoke/mutations/ops.json", JSON.stringify(fenceBody(sentinelCmd("ops", "pnpm smoke:manager-service-ops"))));
  execFileSync("git", ["add", "bin/smoke/mutations"], { cwd: root });

  clearSentinels(...fenceNames);
  result = runArgs(
    "bin/smoke/mutations/safe-a.json",
    "bin/smoke/mutations/safe-b.json",
    "bin/smoke/mutations/safe-c.json",
    "bin/smoke/mutations/safe-d.json",
    "bin/smoke/mutations/safe-e.json",
    "bin/smoke/mutations/suffix.json",
  );
  check(
    "a glob-shaped argv still fences a live-suite command",
    result.status === 0
      && !existsSync(sentinelPath("suffix"))
      && ["safe-a", "safe-b", "safe-c", "safe-d", "safe-e"].every((name) => existsSync(sentinelPath(name)))
      && /bin\/smoke\/mutations\/suffix\.json\s+REFUSED `.*smoke:user-spawn:live`/.test(report(result))
      && /1 live-shaped config\(s\) refused/.test(result.stdout)
      && /fenced-live=1/.test(result.stdout),
    report(result),
  );

  clearSentinels(...fenceNames);
  result = runArgs("bin/smoke/mutations/ops.json");
  check(
    "an always-live suite name is fenced without a :live suffix",
    result.status === 0
      && !existsSync(sentinelPath("ops"))
      && /bin\/smoke\/mutations\/ops\.json\s+REFUSED `/.test(report(result))
      && /1 live-shaped config\(s\) refused/.test(result.stdout)
      && /fenced-live=1/.test(result.stdout),
    report(result),
  );

  clearSentinels(...fenceNames);
  result = runArgs();
  check(
    "a discovered run does not execute any config",
    fenceNames.every((name) => !existsSync(sentinelPath(name)))
      && /fenced-discovered=[1-9]\d*/.test(result.stdout),
    report(result),
  );

  clearSentinels(...fenceNames);
  result = runArgs("bin/smoke/mutations/safe-a.json");
  check(
    "a named non-live config still executes without a flag",
    existsSync(sentinelPath("safe-a")) && /graded=1/.test(result.stdout) && /fenced-live=0/.test(result.stdout),
    report(result),
  );

  clearSentinels(...fenceNames);
  result = runArgs("--gradable-only", "bin/smoke/mutations/safe-a.json");
  check(
    "gradable-only accepts a named config without executing it",
    !existsSync(sentinelPath("safe-a"))
      && /ACCEPTED bin\/smoke\/mutations\/safe-a\.json/.test(result.stdout)
      && /graded=1 refused-with-reason=0/.test(result.stdout),
    report(result),
  );
} finally {
  rmSync(root, { recursive: true, force: true });
}
console.log(`\nMUTATION-COVERAGE SELF-TEST: ${pass} passed, 0 failed`);
