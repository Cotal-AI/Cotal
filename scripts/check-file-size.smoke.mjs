import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = mkdtempSync(join(tmpdir(), "file-size-"));
const checker = fileURLToPath(new URL("./check-file-size.mjs", import.meta.url));
const allowlist = join(root, "scripts/file-size-allowlist.json");
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
function put(name, lines, { newline = "\n", tail = "" } = {}) {
  mkdirSync(dirname(join(root, name)), { recursive: true });
  writeFileSync(join(root, name), `export const line = 1;${newline}`.repeat(lines) + tail);
  git("add", "--", name);
}
function run(...args) {
  const result = spawnSync(process.execPath, [join(root, "scripts/check-file-size.mjs"), ...args], { cwd: root, env, encoding: "utf8", timeout: 10_000 });
  assert.ifError(result.error);
  return result;
}
function baseline(files = {}) {
  writeFileSync(allowlist, JSON.stringify({ version: 1, files }));
}

try {
  mkdirSync(join(root, "scripts"));
  copyFileSync(checker, join(root, "scripts/check-file-size.mjs"));
  check("fixture runs unchanged checker bytes", readFileSync(checker).equals(readFileSync(join(root, "scripts/check-file-size.mjs"))));
  git("init", "--quiet", "--template=");
  const big = "implementations/probe/src/big.ts";
  const listed = "packages/probe/src/listed.ts";
  baseline();
  put(big, 1500);
  check("an unlisted file at the limit passes", run().status === 0);
  put(big, 1501);
  let result = run();
  check("an unlisted file over the limit fails", result.status === 1 && result.stderr.includes(`${big}: 1501 lines, over the 1500-line limit`) && result.stderr.includes("pnpm check:file-size:update"));
  put(big, 1500, { newline: "\r\n" });
  check("a CRLF line counts once", run().status === 0);
  put(big, 1500, { tail: "export {};" });
  check("a last line without a newline counts", run().status === 1);
  put(big, 1);

  put(listed, 1600);
  baseline({ [listed]: 1600 });
  check("a listed file at its recorded count passes", run().status === 0);
  put(listed, 1601);
  result = run();
  check("a grown listed file fails", result.status === 1 && result.stderr.includes(`${listed}: 1600 -> 1601 lines; a listed file may not grow`));
  put(listed, 1550);
  result = run();
  check("a shrunk listed file passes and prints its new count", result.status === 0 && result.stdout.includes(`${listed}: 1600 -> 1550 lines; record the new count`));
  put(listed, 1500);
  result = run();
  check("a listed file at the limit says its row can go", result.status === 0 && result.stdout.includes(`${listed}: 1500 lines, at or under 1500; its row can go`));
  git("rm", "--quiet", "--cached", "--", listed);
  result = run();
  check("a listed file that is no longer tracked says its row can go", result.status === 0 && result.stdout.includes(`${listed}: not a tracked source file; its row can go`));

  put(listed, 1550);
  put(big, 1700);
  result = run("--update-allowlist");
  const first = readFileSync(allowlist, "utf8");
  check("update records every file over the limit, sorted by path", result.status === 0 && JSON.stringify(JSON.parse(first).files) === JSON.stringify({ [big]: 1700, [listed]: 1550 }));
  check("update stores one file per line", first.split("\n").filter((line) => line.includes("/src/")).every((line) => /^    "[^"]+": \d+,?$/.test(line)));
  check("the check passes after update", run().status === 0);
  run("--update-allowlist");
  check("update is deterministic", readFileSync(allowlist, "utf8") === first);
  put(listed, 1400);
  run("--update-allowlist");
  check("update drops a row at or under the limit", Object.keys(JSON.parse(readFileSync(allowlist, "utf8")).files).join(",") === big);
  put(big, 1);
  run("--update-allowlist");

  for (const name of ["packages/probe/smoke/x.ts", "packages/probe/src/x.smoke.ts", "packages/probe/src/x.test.ts", "packages/probe/src/x.d.ts", "packages/probe/src/x.generated.ts", "implementations/probe/src/vendor/x.ts", "packages/smoke-kit/src/x.ts", "bin/scripts/x.mjs", "examples/probe/src/x.ts", "scripts/x.mjs"]) {
    put(name, 1501);
    check(`excludes ${name}`, run().status === 0);
    put(name, 1);
  }
  for (const name of ["bin/daemon/x.ts", "extensions/probe/src/x.mjs", "implementations/probe/src/x.tsx"]) {
    put(name, 1501);
    check(`includes ${name}`, run().stderr.includes(`${name}: 1501 lines`));
    put(name, 1);
  }

  baseline({ [listed]: 1500 });
  check("refuses a row at or under the limit", run().status === 2);
  baseline({ "scripts/x.mjs": 2000 });
  check("refuses a row outside the scanned scope", run().status === 2);
  writeFileSync(allowlist, "not json");
  check("refuses a malformed allowlist", run().status === 2);
  rmSync(allowlist);
  check("refuses a missing allowlist", run().status === 2);
  check("refuses an unknown CLI option", run("--unknown").status === 2);
} finally {
  rmSync(root, { recursive: true, force: true });
}
console.log(`file-size controls: ${passed} passed, ${failed} failed`);
if (failed) process.exitCode = 1;
