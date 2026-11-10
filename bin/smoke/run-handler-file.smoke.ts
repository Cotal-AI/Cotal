/** Offline `run simulate --handler` file refusals through the shipped CLI. No broker. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const repo = join(import.meta.dirname, "..", "..");
const root = mkdtempSync(join(tmpdir(), "run-handler-file-"));
const home = join(root, "home");
mkdirSync(home);
const program = join(root, "good.cotal.js");
writeFileSync(program, 'log("ready");\n');
const handler = (name: string, content: string) => {
  const file = join(root, name);
  writeFileSync(file, content);
  return file;
};
const good = handler("good.json", '{"events":{}}');
const bom = handler("bom.json", '\uFEFF{"events":{}}');
const empty = handler("empty.json", "");
const blank = handler("blank.json", " \n\t");
const malformed = handler("malformed.json", "{");
const array = handler("array.json", "[]");
const missing = join(root, "missing.json");
const directory = join(root, "directory");
mkdirSync(directory);
const denied = handler("denied.json", "{}");
chmodSync(denied, 0o000);
const dangling = join(root, "dangling.json");
// Windows does not grant symlink creation or POSIX mode bits to every test account.
if (process.platform !== "win32") symlinkSync(missing, dangling);
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("COTAL_") && !key.startsWith("NATS_")));
Object.assign(env, { HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: join(home, "config"), DO_NOT_TRACK: "1", NO_COLOR: "1" });
let passed = 0, failed = 0;

function check(name: string, file: string | undefined, json: boolean, code?: string, cause?: string, status = 1) {
  const result = spawnSync(process.execPath, [join(repo, "bin", "dist", "cotal.js"), "run", "simulate", program,
    ...(file === undefined ? [] : ["--handler", file]), ...(json ? ["--json"] : [])], { cwd: root, env, encoding: "utf8", timeout: 30_000 });
  const label = `${name}-${json ? "json" : "text"}`;
  writeFileSync(join(root, `${label}.out`), result.stdout ?? "");
  writeFileSync(join(root, `${label}.err`), result.stderr ?? "");
  writeFileSync(join(root, `${label}.exit`), String(result.status));
  try {
    assert.ifError(result.error);
    assert.equal(result.signal, null);
    assert.equal(result.status, code === undefined ? 0 : status);
    if (json) {
      assert.equal(result.stderr, "");
      const envelope = JSON.parse(result.stdout);
      if (code === undefined) {
        assert.equal(envelope.outcome, "ok");
        assert.equal(envelope.result.outcome, "completed");
        assert.deepEqual(envelope.result.log, [{ scope: "", values: ["ready"] }]);
      } else {
        assert.equal(envelope.outcome, "refused");
        assert.equal(envelope.error.code, code);
        assert.equal(envelope.target.file, file);
        assert.ok(envelope.error.message.includes(file));
        assert.ok(envelope.error.message.includes(cause));
        assert.ok(envelope.error.remedy.includes(file));
      }
    } else {
      const output = result.stdout + result.stderr;
      if (code === undefined) assert.ok(output.includes("ready"));
      else {
        assert.ok(output.includes(file!));
        assert.ok(output.includes(cause!));
        // Usage refusals print their remedy beside help, rather than the classified report.
        if (code === "USAGE_INVALID") assert.ok(output.includes(`check that ${file} exists and this account can read it`));
        else {
          assert.ok(output.includes(code));
          assert.ok(output.includes("Next"));
        }
      }
    }
    passed++;
    console.log(`  ✓ ${label}`);
  } catch (error) {
    failed++;
    console.error(`  ✗ FAIL: ${label}`, error);
  }
}

for (const json of [false, true]) {
  check("no-handler", undefined, json);
  check("readable", good, json);
  check("bom", bom, json);
  check("missing", missing, json, "TARGET_NOT_FOUND", "does not exist", 2);
  check("directory", directory, json, "USAGE_INVALID", "is a directory");
  if (process.platform !== "win32") {
    check("dangling", dangling, json, "TARGET_NOT_FOUND", "is a link whose target does not exist", 2);
    if (process.getuid?.() !== 0) check("denied", denied, json, "PERMISSION_DENIED", "is not readable", 2);
  }
  check("empty", empty, json, "SCHEMA_INVALID", "is empty");
  check("blank", blank, json, "SCHEMA_INVALID", "not valid JSON");
  check("malformed", malformed, json, "SCHEMA_INVALID", "not valid JSON");
  check("array", array, json, "SCHEMA_INVALID", "must be an object");
}
chmodSync(denied, 0o600);
console.log(`Handler file evidence: ${root}`);
console.log(`${passed} passed, ${failed} failed`);
process.exitCode = failed ? 1 : 0;
