import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = mkdtempSync(join(tmpdir(), "comment-history-"));
const checker = fileURLToPath(new URL("./check-comment-history.mjs", import.meta.url));
const input = "packages/probe/src/example.tsx";
const allowlist = join(root, "scripts/comment-history-allowlist.json");
const env = { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null" };
for (const key of Object.keys(env)) if (key.startsWith("COTAL_")) delete env[key];
for (const key of ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE"]) delete env[key];
let passed = 0;
let failed = 0;
function check(name, condition) {
  console.log(`  ${condition ? "✓" : "x FAIL:"} ${name}`);
  if (condition) passed++;
  else failed++;
}
function git(...args) {
  const result = spawnSync("git", ["-C", root, ...args], { env, encoding: "utf8" });
  assert.equal(result.status, 0, "fixture git setup");
}
function put(name, text) {
  mkdirSync(dirname(join(root, name)), { recursive: true });
  writeFileSync(join(root, name), text);
  git("add", "--", name);
}
function run(...args) {
  const result = spawnSync(process.execPath, [join(root, "scripts/check-comment-history.mjs"), ...args], { cwd: root, env, encoding: "utf8", timeout: 10_000 });
  assert.ifError(result.error);
  return result;
}
function baseline(files = {}) {
  writeFileSync(allowlist, JSON.stringify({ version: 1, files }));
}

try {
  mkdirSync(join(root, "scripts"));
  mkdirSync(join(root, "node_modules"));
  copyFileSync(checker, join(root, "scripts/check-comment-history.mjs"));
  check("fixture runs unchanged checker bytes", readFileSync(checker).equals(readFileSync(join(root, "scripts/check-comment-history.mjs"))));
  symlinkSync(dirname(fileURLToPath(import.meta.resolve("typescript/package.json"))), join(root, "node_modules/typescript"), "junction");
  git("init", "--quiet", "--template=");
  put(input, "export const value = 1;");
  git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "--quiet", "--no-verify", "-m", "test: add fixture");
  baseline();
  const cases = [
    ["current contract", "// Returns the active value.\nexport const value = 1;", null],
    ["line issue reference", "// See #123.\nexport const value = 1;", "issue-reference"],
    ["block issue reference", "/* #1234 */", "issue-reference"],
    ["issue digits followed by letters", "// #123abc", "issue-reference"],
    ["short issue number", "// #12", null],
    ["doc phrase", "/** This used to return null. */\nexport const value = 1;", "used-to"],
    ["previously case insensitive", "// PREVIOUSLY active", "previously"],
    ["no longer", "/* It is no longer active. */", "no-longer"],
    ["formerly", "// Formerly active", "formerly"],
    ["phrase word boundaries", "// unused tool, previouslyEnabled, formerlyKnown", null],
    ["whitespace in phrase", "/* used\n to return null */", "used-to"],
    ["wrapped doc phrase", "/** It used\n * to return null. */", "used-to"],
    ["string literal", 'export const value = "// previously #123 used to no longer formerly";', null],
    ["template text", 'export const value = `/* previously #123 */`;', null],
    ["regular expression", 'export const value = /formerly|previously|#123/;', null],
    ["JSX text", 'export const value = <pre>previously #123 used to no longer formerly</pre>;', null],
    ["JSX attribute", 'export const value = <pre title="previously #123" />;', null],
    ["template expression comment", 'export const value = `${ /* previously */ 1}`;', "previously"],
    ["JSX expression comment", 'export const value = <pre>{/* formerly */}</pre>;', "formerly"],
    ["trailing EOF comment", 'export const value = 1; // previously', "previously"],
    ["comment only file", '// formerly', "formerly"],
    ["unterminated comment", '/* previously', "previously"],
  ];
  for (const [name, text, rule] of cases) {
    put(input, text);
    const result = run();
    check(name, result.status === (rule ? 1 : 0) && (!rule || (result.stderr.includes(`repository total ${rule}: 0 -> 1`) && result.stderr.includes(`${input}:`))));
  }
  for (const newline of ["\n", "\r\n", "\r", "\u2028", "\u2029"]) {
    put(input, `export const value = 1;${newline}// previously`);
    const result = run();
    check(`diagnostic line for ${JSON.stringify(newline)}`, result.status === 1 && result.stderr.includes(`${input}:2: previously`));
  }
  put(input, "");
  for (const name of ["packages/probe/smoke/example.ts", "packages/probe/src/example.test.ts", "packages/probe/src/__tests__/example.ts", "packages/probe/src/example.d.mts", "packages/smoke-kit/src/example.ts", "bin/smoke/example.ts", "bin/scripts/example.mjs", "examples/probe/src/example.ts", "scripts/example.mjs"]) {
    put(name, "// previously #123 used to no longer formerly");
    check(`excludes ${name}`, run().status === 0);
  }
  for (const name of ["bin/daemon/probe.ts", "extensions/probe/src/probe.mjs", "implementations/probe/src/probe.cts", "packages/probe/src/probe.jsx"]) {
    put(name, "// formerly");
    const result = run();
    check(`includes ${name}`, result.status === 1 && result.stderr.includes(`${name}:1: formerly`));
    put(name, "");
  }
  put(input, "// previously previously #123");
  baseline({ [input]: { previously: 2, "issue-reference": 1 } });
  check("accepts existing per-rule counts", run().status === 0);
  put(input, "// previously");
  check("accepts decreased counts", run().status === 0);
  put(input, "// previously previously previously #123");
  let result = run();
  check("refuses repository total increase", result.status === 1 && result.stderr.includes("repository total previously: 2 -> 3") && result.stderr.includes(`${input}:1: previously: 2 -> 3`));
  put(input, "// formerly formerly");
  result = run();
  check("counts are separate for each rule", result.status === 1 && result.stderr.includes("repository total formerly: 0 -> 2"));
  const moved = "packages/probe/src/moved.ts";
  baseline({ [input]: { previously: 2 } });
  put(input, "");
  put(moved, "// previously previously");
  result = run();
  check("pure move names receiving file without total increase", result.status === 1 && result.stderr.includes(`${moved}:1: previously: 0 -> 2`) && !result.stderr.includes("repository total") && result.stderr.includes("pnpm check:comment-history:update"));
  result = run("--update-allowlist");
  check("one command regenerates counts for moved file", result.status === 0 && JSON.parse(readFileSync(allowlist, "utf8")).files[moved].previously === 2);
  check("pure move passes after regeneration", run().status === 0);
  const first = readFileSync(allowlist, "utf8");
  run("--update-allowlist");
  check("regeneration is deterministic", readFileSync(allowlist, "utf8") === first);
  check("regeneration stores no commit metadata or totals", Object.keys(JSON.parse(first)).join(",") === "version,files");
  check("each file is stored on one line", first.split("\n").filter((line) => line.includes('"packages/')).every((line) => /^    "[^"]+": \{ .+ \},?$/.test(line)));
  put(input, "// formerly previously");
  run("--update-allowlist");
  const sorted = readFileSync(allowlist, "utf8");
  check("file entries are sorted by path", Object.keys(JSON.parse(sorted).files).join(",") === [input, moved].join(","));
  check("rule counts share their file's line", sorted.split("\n").some((line) => line.includes(JSON.stringify(input)) && line.includes('"formerly": 1, "previously": 1')));
  put(input, "");
  run("--update-allowlist");
  put(moved, "// previously previously previously");
  check("new violation after move is still refused", run().status === 1);
  baseline({ [moved]: { previously: -1 } });
  check("refuses negative baseline count", run().status === 2);
  baseline({ [moved]: { unknown: 1 } });
  check("refuses unknown baseline rule", run().status === 2);
  writeFileSync(allowlist, "not json");
  check("refuses malformed baseline", run().status === 2);
  rmSync(allowlist);
  check("refuses missing baseline", run().status === 2);
  check("refuses unknown CLI option", run("--unknown").status === 2);
} finally {
  rmSync(root, { recursive: true, force: true });
}
console.log(`comment-history controls: ${passed} passed, ${failed} failed`);
if (failed) process.exitCode = 1;
