import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createSuite, skipSuite } from "./sentinel.mjs";

if (process.platform !== "linux") skipSuite("native quota syscall injection requires Linux");
const available = spawnSync("strace", ["--version"], { encoding: "utf8" });
if (available.error?.code === "ENOENT") skipSuite("native quota syscall injection requires strace on PATH");
assert.ifError(available.error);
assert.equal(available.status, 0);

const bin = fileURLToPath(new URL("../dist/cotal.js", import.meta.url));
const root = mkdtempSync(join(tmpdir(), "cotal-native-quota-"));
const { check, finish } = createSuite();
const oldUmask = process.umask(0o077);
console.log(`Native quota fixtures and syscall traces retained: ${root}`);

function run(home, args, trace) {
  mkdirSync(join(home, "tmp"), { recursive: true, mode: 0o700 });
  const env = {
    PATH: process.env.PATH, HOME: home, USERPROFILE: home,
    COTAL_HOME: join(home, ".cotal"), XDG_CONFIG_HOME: join(home, ".config"),
    XDG_RUNTIME_DIR: join(home, "run"), TMPDIR: join(home, "tmp"),
    COTAL_SKIP_CONNECTOR_SEED: "1", DO_NOT_TRACK: "1",
  };
  const cli = [process.execPath, bin, ...args];
  const result = trace
    ? spawnSync("strace", ["-f", "-e", "trace=rename", "-e", "inject=rename:error=EDQUOT:when=1", "-o", trace, ...cli], { env, cwd: home, encoding: "utf8", timeout: 30_000 })
    : spawnSync(cli[0], cli.slice(1), { env, cwd: home, encoding: "utf8", timeout: 30_000 });
  assert.ifError(result.error);
  assert.equal(result.signal, null);
  console.log(JSON.stringify({ args, status: result.status, stdout: result.stdout, stderr: result.stderr, trace }));
  return result;
}

try {
  for (const kind of ["persona", "preferences", "prepared"]) {
    try {
      const home = join(root, kind);
      const project = join(home, "project");
      mkdirSync(project, { recursive: true, mode: 0o700 });
      let args, destination, before;
      if (kind === "persona") {
        assert.equal(run(home, ["space", "create", "s", "--root", project, "--json"]).status, 0);
        const source = join(home, "source.md");
        writeFileSync(source, "---\nname: quota\nsubscribe: []\n---\n\nQuota fixture.\n");
        args = ["persona", "create", "quota", "--space", "s", "--file", source, "--json"];
        destination = join(project, ".cotal", "agents", "quota.md");
      } else if (kind === "preferences") {
        assert.equal(run(home, ["config", "set", "color", "never", "--json"]).status, 0);
        args = ["config", "set", "color", "always", "--json"];
        destination = join(home, ".config", "cotal", "preferences.json");
        before = readFileSync(destination);
      } else {
        args = ["space", "create", "s", "--root", project, "--json"];
        destination = join(home, ".cotal", "prepared", "space.73.json");
      }
      const trace = join(root, `${kind}-EDQUOT.trace`);
      const failed = run(home, args, trace);
      assert.equal(failed.status, 5, failed.stdout + failed.stderr);
      const result = JSON.parse(failed.stdout);
      assert.equal(result.outcome, "failed");
      assert.equal(result.error.code, "OPERATION_FAILED");
      assert.equal(result.error.cause.code, "EDQUOT");
      assert.equal(result.target.path, destination);
      assert.match(result.error.message, /quota.*EDQUOT/);
      assert.match(result.error.remedy, /quota.*retry/);
      assert.equal(failed.stderr, "");
      assert.match(readFileSync(trace, "utf8"), /rename\(.* = -1 EDQUOT.*INJECTED/);
      if (before) assert.deepEqual(readFileSync(destination), before);
      else assert.equal(existsSync(destination), false);
      assert.deepEqual(readdirSync(join(destination, "..")).filter(name => name.endsWith(".tmp") || name.endsWith(".lock")), []);
      assert.equal(run(home, args).status, 0);
      assert.ok(existsSync(destination));
      check(`${kind}: native quota rename failure is classified, leaves destination intact and retries`, true);
    } catch (error) { check(`${kind}: native quota rename failure`, false, error); }
  }
} finally { process.umask(oldUmask); }
finish();
