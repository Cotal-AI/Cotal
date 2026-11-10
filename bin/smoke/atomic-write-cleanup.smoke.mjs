import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createSuite, skipSuite } from "./sentinel.mjs";

if (process.platform !== "linux") skipSuite("RLIMIT_FSIZE requires Linux prlimit");

const bin = fileURLToPath(new URL("../dist/cotal.js", import.meta.url));
const core = new URL("../../packages/core/dist/secret-fs-entry.js", import.meta.url).href;
const root = mkdtempSync(join(tmpdir(), "cotal-write-cleanup-"));
const { check, finish } = createSuite();

function test(name, body) {
  try {
    body();
    check(name, true);
  } catch (error) {
    check(name, false, error);
  }
}

function run(home, args, limit) {
  mkdirSync(home, { recursive: true, mode: 0o700 });
  const command = [process.execPath, ...args];
  const env = {
    PATH: process.env.PATH,
    HOME: home,
    USERPROFILE: home,
    COTAL_HOME: join(home, ".cotal"),
    XDG_CONFIG_HOME: join(home, ".config"),
    COTAL_SKIP_CONNECTOR_SEED: "1",
    DO_NOT_TRACK: "1",
  };
  // Keep shell arguments separate: the shell ignores SIGXFSZ, then execs the real command.
  const options = { env, encoding: "utf8", timeout: 30_000 };
  const result = limit === undefined
    ? spawnSync(command[0], command.slice(1), options)
    : spawnSync("/bin/sh", ["-c", 'trap "" XFSZ; limit=$1; shift; exec prlimit --fsize="$limit" -- "$@"', "limit", String(limit), ...command], options);
  assert.ifError(result.error);
  return result;
}

function temporaryFiles(dir) {
  return readdirSync(dir).filter((name) => name.endsWith(".tmp"));
}

try {
  for (const kind of ["prepared", "preferences"]) {
    test(`${kind}: failed CLI write removes its temporary sibling and a retry succeeds`, () => {
      const home = join(root, kind);
      const project = join(home, "project");
      mkdirSync(project, { recursive: true });
      const args = kind === "prepared"
        ? [bin, "space", "create", "demo", "--root", project]
        : [bin, "config", "set", "color", "never"];
      const dir = kind === "prepared" ? join(home, ".cotal", "prepared") : join(home, ".config", "cotal");
      const file = join(dir, kind === "prepared" ? "space.64656d6f.json" : "preferences.json");
      const failed = run(home, args, kind === "prepared" ? 64 : 40);
      assert.equal(failed.signal, null);
      assert.equal(failed.status, 3, failed.stdout + failed.stderr);
      assert.match(failed.stdout + failed.stderr, /EFBIG/);
      assert.equal(existsSync(file), false);
      const residue = temporaryFiles(dir);
      const retry = run(home, args);
      assert.equal(retry.status, 0, retry.stdout + retry.stderr);
      assert.ok(existsSync(file));
      assert.deepEqual(residue, [], "failed write left a temporary sibling");
      assert.deepEqual(temporaryFiles(dir), []);
      console.log(`${kind}: EFBIG exit 3, retry exit 0, temporary siblings ${residue.length}`);
    });

    test(`${kind}: unrestricted CLI positive control publishes without residue`, () => {
      const home = join(root, `${kind}-control`);
      const project = join(home, "project");
      mkdirSync(project, { recursive: true });
      const args = kind === "prepared"
        ? [bin, "space", "create", "demo", "--root", project]
        : [bin, "config", "set", "color", "never"];
      const result = run(home, args);
      assert.equal(result.status, 0, result.stdout + result.stderr);
      const dir = kind === "prepared" ? join(home, ".cotal", "prepared") : join(home, ".config", "cotal");
      const file = join(dir, kind === "prepared" ? "space.64656d6f.json" : "preferences.json");
      assert.ok(existsSync(file));
      assert.deepEqual(temporaryFiles(dir), []);
    });
  }

  for (const method of ["createPrivateRecord", "writeSecretFileCreateOnly"]) {
    test(`${method}: a partial exclusive write leaves no new file`, () => {
      const home = join(root, method);
      const file = join(home, "record");
      const script = `import { ${method} } from ${JSON.stringify(core)};
        try { ${method}(${JSON.stringify(file)}, "x".repeat(256)); }
        catch (error) { console.error(error.code); process.exit(7); }`;
      const failed = run(home, ["--input-type=module", "-e", script], 40);
      assert.equal(failed.status, 7, failed.stdout + failed.stderr);
      assert.match(failed.stderr, /EFBIG/);
      assert.deepEqual(readdirSync(home), []);
      const success = run(home, ["--input-type=module", "-e", script]);
      assert.equal(success.status, 0, success.stdout + success.stderr);
      assert.equal(readFileSync(file, "utf8"), "x".repeat(256));
      const taken = run(home, ["--input-type=module", "-e", script]);
      assert.equal(taken.status, 7);
      assert.match(taken.stderr, /EEXIST/);
      assert.equal(readFileSync(file, "utf8"), "x".repeat(256));
    });
  }
} finally {
  // All children run synchronously and have exited before their private fixture is removed.
  rmSync(root, { recursive: true, force: true });
}
finish();
