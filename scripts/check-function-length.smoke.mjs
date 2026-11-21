import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = mkdtempSync(join(tmpdir(), "function-length-"));
const checker = fileURLToPath(new URL("./check-function-length.mjs", import.meta.url));
const allowlist = join(root, "scripts/function-length-allowlist.json");
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
const filler = (lines) => "  void 0;\n".repeat(Math.max(0, lines));
const shapes = {
  declaration: (id, lines) => `export function probe${id}() {\n${filler(lines - 2)}}\n`,
  method: (id, lines) => `export class Probe${id} {\n  run${id}() {\n${filler(lines - 2)}  }\n}\n`,
  arrow: (id, lines) => `export const probe${id} = () => {\n${filler(lines - 2)}};\n`,
  expression: (id, lines) => `export const probe${id} = function () {\n${filler(lines - 2)}};\n`,
  nested: (id, lines) => `export function probe${id}() {\n  const inner${id} = () => {\n${filler(lines - 5)}  };\n  return inner${id};\n}\n`,
};
// Writes one function per entry of `lengths`, each that many lines long, in the given shape.
function put(name, lengths, { shape = "declaration", doc = "" } = {}) {
  mkdirSync(dirname(join(root, name)), { recursive: true });
  writeFileSync(join(root, name), lengths.map((lines, id) => doc + shapes[shape](id, lines)).join("\n"));
  git("add", "--", name);
}
function run(...args) {
  const result = spawnSync(process.execPath, [join(root, "scripts/check-function-length.mjs"), ...args], { cwd: root, env, encoding: "utf8", timeout: 30_000 });
  assert.ifError(result.error);
  return result;
}
function baseline(files = {}) {
  writeFileSync(allowlist, JSON.stringify({ version: 1, files }));
}

try {
  mkdirSync(join(root, "scripts"));
  mkdirSync(join(root, "node_modules"));
  symlinkSync(dirname(createRequire(import.meta.url).resolve("typescript/package.json")), join(root, "node_modules/typescript"), "junction");
  copyFileSync(checker, join(root, "scripts/check-function-length.mjs"));
  check("fixture runs unchanged checker bytes", readFileSync(checker).equals(readFileSync(join(root, "scripts/check-function-length.mjs"))));
  git("init", "--quiet", "--template=");
  const big = "implementations/probe/src/big.ts";
  const listed = "packages/probe/src/listed.ts";
  baseline();
  put(big, [150]);
  check("an unlisted function at the limit passes", run().status === 0);
  put(big, [151]);
  let result = run();
  check("an unlisted function over the limit fails", result.status === 1 && result.stderr.includes(`${big}:1: probe0 is 151 lines, over the 150-line limit`) && result.stderr.includes("pnpm check:function-length:update"));
  for (const [shape, name] of [["method", "run0"], ["arrow", "probe0"], ["expression", "probe0"]]) {
    put(big, [151], { shape });
    check(`counts a ${shape}`, run().stderr.includes(`${name} is 151 lines`));
    put(big, [150], { shape });
    check(`passes a ${shape} at the limit`, run().status === 0);
  }
  put(big, [150], { doc: "/**\n * A doc comment.\n */\n" });
  check("a doc comment above a function does not count", run().status === 0);
  put(big, [400], { shape: "nested" });
  result = run();
  check("a nested function counts on its own", result.status === 1 && result.stderr.includes("probe0 is 400 lines") && result.stderr.includes("inner0 is 397 lines"));
  put(big, [151, 30, 200]);
  result = run();
  check("every long function in an unlisted file is named", result.stderr.includes("probe0 is 151 lines") && result.stderr.includes("probe2 is 200 lines") && !result.stderr.includes("probe1"));
  put(big, [1]);

  put(listed, [300, 200]);
  baseline({ [listed]: [300, 200] });
  check("a listed file at its recorded lengths passes", run().status === 0);
  put(listed, [300, 201]);
  result = run();
  check("a grown listed function fails", result.status === 1 && result.stderr.includes(`${listed}: [300, 200] -> [300, 201] lines; a listed function may not grow`));
  put(listed, [300, 200, 151]);
  result = run();
  check("a new long function in a listed file fails", result.status === 1 && result.stderr.includes(`${listed}: 3 functions over 150 lines, its row lists 2`));
  put(listed, [250, 200]);
  result = run();
  check("a shrunk listed function passes and prints the new lengths", result.status === 0 && result.stdout.includes(`${listed}: [300, 200] -> [250, 200] lines; record the new lengths`));
  put(listed, [300, 150]);
  result = run();
  check("a function split under the limit passes and prints the new lengths", result.status === 0 && result.stdout.includes(`${listed}: [300, 200] -> [300] lines; record the new lengths`));
  put(listed, [150]);
  result = run();
  check("a listed file with no long function says its row can go", result.status === 0 && result.stdout.includes(`${listed}: no function over 150 lines; its row can go`));
  git("rm", "--quiet", "--cached", "--", listed);
  result = run();
  check("a listed file that is no longer tracked says its row can go", result.status === 0 && result.stdout.includes(`${listed}: not a tracked source file; its row can go`));

  put(listed, [160, 400]);
  put(big, [700]);
  result = run("--update-allowlist");
  const first = readFileSync(allowlist, "utf8");
  check("update records every file by path, longest function first", result.status === 0 && JSON.stringify(JSON.parse(first).files) === JSON.stringify({ [big]: [700], [listed]: [400, 160] }));
  check("update stores one file per line", first.split("\n").filter((line) => line.includes("/src/")).every((line) => /^    "[^"]+": \[\d+(?:, \d+)*\],?$/.test(line)));
  check("the check passes after update", run().status === 0);
  run("--update-allowlist");
  check("update is deterministic", readFileSync(allowlist, "utf8") === first);
  put(listed, [150]);
  run("--update-allowlist");
  check("update drops a file with no long function", Object.keys(JSON.parse(readFileSync(allowlist, "utf8")).files).join(",") === big);
  put(big, [1]);
  run("--update-allowlist");

  for (const name of ["packages/probe/smoke/x.ts", "packages/probe/src/x.smoke.ts", "packages/probe/src/x.test.ts", "packages/probe/src/x.d.ts", "packages/probe/src/x.generated.ts", "implementations/probe/src/vendor/x.ts", "packages/smoke-kit/src/x.ts", "bin/scripts/x.mjs", "examples/probe/src/x.ts", "scripts/x.mjs"]) {
    put(name, [151]);
    check(`excludes ${name}`, run().status === 0);
    put(name, [1]);
  }
  for (const name of ["bin/daemon/x.ts", "extensions/probe/src/x.mjs", "implementations/probe/src/x.tsx"]) {
    put(name, [151]);
    check(`includes ${name}`, run().stderr.includes(`${name}:1: probe0 is 151 lines`));
    put(name, [1]);
  }

  baseline({ [listed]: [150] });
  check("refuses a row with a length at or under the limit", run().status === 2);
  baseline({ [listed]: [200, 300] });
  check("refuses a row that is not longest first", run().status === 2);
  baseline({ [listed]: [] });
  check("refuses an empty row", run().status === 2);
  baseline({ "scripts/x.mjs": [2000] });
  check("refuses a row outside the scanned scope", run().status === 2);
  writeFileSync(allowlist, "not json");
  check("refuses a malformed allowlist", run().status === 2);
  rmSync(allowlist);
  check("refuses a missing allowlist", run().status === 2);
  check("refuses an unknown CLI option", run("--unknown").status === 2);
} finally {
  rmSync(root, { recursive: true, force: true });
}
console.log(`function-length controls: ${passed} passed, ${failed} failed`);
if (failed) process.exitCode = 1;
