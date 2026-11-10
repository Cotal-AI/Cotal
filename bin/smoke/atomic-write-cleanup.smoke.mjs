import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createSuite, skipSuite } from "./sentinel.mjs";
import { localWriteFailure } from "../../packages/workspace/dist/index.js";

if (process.platform !== "linux") skipSuite("RLIMIT_FSIZE requires Linux prlimit");

const bin = fileURLToPath(new URL("../dist/cotal.js", import.meta.url));
const core = new URL("../../packages/core/dist/secret-fs-entry.js", import.meta.url).href;
const root = mkdtempSync(join(tmpdir(), "cotal-write-cleanup-"));
const { check, finish } = createSuite();
const oldUmask = process.umask(0o077);

function test(name, body) {
  try {
    body();
    check(name, true);
  } catch (error) {
    check(name, false, error);
  }
}

function run(home, args, limit, mkdirFault) {
  mkdirSync(home, { recursive: true, mode: 0o700 });
  const tmp = join(home, "tmp");
  mkdirSync(tmp, { recursive: true, mode: 0o700 });
  const preload = join(home, "mkdir-fault.mjs");
  if (mkdirFault) writeFileSync(preload, `
    import fs from "node:fs";
    import { syncBuiltinESMExports } from "node:module";
    const mkdir = fs.mkdirSync;
    fs.mkdirSync = function(path, ...args) {
      if (path === ${JSON.stringify(mkdirFault.path)}) {
        throw Object.assign(new Error("injected mkdir failure"), { code: ${JSON.stringify(mkdirFault.code)}, path, syscall: "mkdir" });
      }
      return mkdir.call(this, path, ...args);
    };
    syncBuiltinESMExports();
  `);
  const command = [process.execPath, ...(mkdirFault ? ["--import", preload] : []), ...args];
  const env = {
    PATH: process.env.PATH,
    HOME: home,
    USERPROFILE: home,
    COTAL_HOME: join(home, ".cotal"),
    XDG_CONFIG_HOME: join(home, ".config"),
    XDG_RUNTIME_DIR: join(home, "run"),
    TMPDIR: tmp,
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
  for (const code of ["ENOSPC", "EDQUOT", "EFBIG", "EACCES"]) {
    test(`space: initial directory ${code} names its boundary without publishing a record`, () => {
      const home = join(root, `mkdir-${code}`);
      const project = join(home, "project");
      mkdirSync(project, { recursive: true, mode: 0o700 });
      const dir = join(project, ".cotal");
      const args = [bin, "space", "create", "storage", "--root", project, "--json"];
      const failed = run(home, args, undefined, { path: dir, code });
      const result = JSON.parse(failed.stdout);
      assert.equal(failed.signal, null);
      assert.equal(failed.status, code === "EACCES" ? 2 : 5, failed.stdout + failed.stderr);
      assert.equal(result.error.code, code === "EACCES" ? "PERMISSION_DENIED" : "OPERATION_FAILED");
      if (code !== "EACCES") {
        assert.equal(result.error.cause.code, code);
        assert.equal(result.target.path, dir);
        assert.equal(result.target.requested, "storage");
        assert.ok(result.error.message.includes(dir));
        assert.match(result.error.remedy, /retry/);
      }
      assert.equal(existsSync(dir), false);
      assert.equal(existsSync(join(home, ".cotal")), false);
      assert.equal(failed.stderr, "");
      assert.equal(run(home, args).status, 0);
    });
  }

  test("storage codes carry a path and remedy while unrelated failures propagate", () => {
    for (const code of ["EFBIG", "ENOSPC", "EDQUOT"]) {
      const error = Object.assign(new Error("write failed"), { code });
      const result = localWriteFailure(error, "/destination/record");
      assert.equal(result.code, "OPERATION_FAILED");
      assert.equal(result.outcome, "failed");
      assert.equal(result.native.code, code);
      assert.equal(result.cause, error);
      assert.match(result.message, /\/destination\/record/);
      assert.match(result.remedy, /retry/);
    }
    for (const error of [new Error("validation failed"), null, { code: "EACCES" }, { code: "__proto__" }])
      assert.throws(() => localWriteFailure(error, "/destination/record"), thrown => thrown === error);
  });

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
      assert.equal(failed.status, 5, failed.stdout + failed.stderr);
      assert.match(failed.stdout + failed.stderr, /EFBIG/);
      assert.match(failed.stderr, /OPERATION_FAILED/);
      assert.ok(failed.stderr.includes(file), failed.stderr);
      assert.match(failed.stderr, /save did not complete/);
      assert.match(failed.stderr, /Next[\s\S]*file-size limit/);
      assert.equal(existsSync(file), false);
      const residue = temporaryFiles(dir);
      const retry = run(home, args);
      assert.equal(retry.status, 0, retry.stdout + retry.stderr);
      assert.ok(existsSync(file));
      assert.deepEqual(residue, [], "failed write left a temporary sibling");
      assert.deepEqual(temporaryFiles(dir), []);
      console.log(`${kind}: EFBIG exit 5, retry exit 0, temporary siblings ${residue.length}`);
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

  test("config: failed replacement preserves the saved value and revision in JSON", () => {
    const home = join(root, "config-replace");
    const args = [bin, "config", "set", "color", "never", "--json"];
    assert.equal(run(home, args).status, 0);
    const file = join(home, ".config", "cotal", "preferences.json");
    const before = readFileSync(file);
    const failed = run(home, [bin, "config", "set", "color", "always", "--json"], 40);
    assert.equal(failed.status, 5, failed.stdout + failed.stderr);
    const result = JSON.parse(failed.stdout);
    assert.equal(result.outcome, "failed");
    assert.equal(result.error.code, "OPERATION_FAILED");
    assert.equal(result.error.cause.code, "EFBIG");
    assert.equal(result.target.path, file);
    assert.ok(result.error.message.includes(file));
    assert.match(result.error.remedy, /file-size limit/);
    assert.equal(failed.stderr, "");
    assert.deepEqual(readFileSync(file), before);
    assert.deepEqual(temporaryFiles(join(home, ".config", "cotal")), []);
  });

  test("config: per-space write failure names the selected space and leaves the default", () => {
    const home = join(root, "config-space");
    const project = join(home, "project");
    mkdirSync(project, { recursive: true, mode: 0o700 });
    assert.equal(run(home, [bin, "space", "create", "s", "--root", project]).status, 0);
    const failed = run(home, [bin, "config", "set", "persona", "planner", "--space", "s", "--json"], 40);
    assert.equal(failed.status, 5, failed.stdout + failed.stderr);
    const result = JSON.parse(failed.stdout);
    assert.equal(result.target.space, "s");
    assert.equal(result.error.cause.code, "EFBIG");
    const read = run(home, [bin, "config", "get", "persona", "--space", "s", "--json"]);
    assert.equal(read.status, 0);
    assert.equal(JSON.parse(read.stdout).result.setting.value, "default");
  });

  test("persona: a final catalog write failure names its destination and leaves no new persona", () => {
    const home = join(root, "persona-file");
    const project = join(home, "project");
    mkdirSync(project, { recursive: true, mode: 0o700 });
    assert.equal(run(home, [bin, "space", "create", "s", "--root", project]).status, 0);
    const file = join(home, "source.md");
    writeFileSync(file, `---\nname: big\nsubscribe: []\n---\n\n${"x".repeat(760)}\n`);
    const args = [bin, "persona", "create", "big", "--space", "s", "--file", file, "--json"];
    const failed = run(home, args, 256);
    assert.equal(failed.status, 5, failed.stdout + failed.stderr);
    const result = JSON.parse(failed.stdout);
    const destination = join(project, ".cotal", "agents", "big.md");
    assert.equal(result.target.path, destination);
    assert.equal(result.error.cause.code, "EFBIG");
    assert.equal(existsSync(destination), false);
    assert.deepEqual(temporaryFiles(join(project, ".cotal", "agents")), []);
    assert.equal(run(home, args).status, 0);
    assert.deepEqual(readFileSync(destination), readFileSync(file));
  });

  for (const json of [false, true]) {
    test(`persona: a draft write failure is not invalid input (${json ? "json" : "text"})`, () => {
      const home = join(root, `persona-${json}`);
      const project = join(home, "project");
      mkdirSync(project, { recursive: true, mode: 0o700 });
      assert.equal(run(home, [bin, "space", "create", "s", "--root", project]).status, 0);
      const args = [bin, "persona", "create", "big", "--space", "s", "--prompt", "x".repeat(760), "--subscribe", "", ...(json ? ["--json"] : [])];
      const failed = run(home, args, 100);
      assert.equal(failed.status, 5, failed.stdout + failed.stderr);
      const text = failed.stdout + failed.stderr;
      assert.match(text, /EFBIG/);
      assert.match(text, /OPERATION_FAILED/);
      assert.doesNotMatch(text, /SCHEMA_INVALID|invalid persona fields/);
      assert.ok(text.includes(join(home, "tmp")), text);
      assert.match(text, /big\.md/);
      assert.match(text, /file-size limit/);
      if (json) {
        const result = JSON.parse(failed.stdout);
        assert.equal(result.outcome, "failed");
        assert.equal(result.target.space, "s");
        assert.equal(result.error.cause.code, "EFBIG");
        assert.equal(failed.stderr, "");
      } else assert.match(text, /Next/);
      assert.equal(existsSync(join(project, ".cotal", "agents", "big.md")), false);
      assert.deepEqual(readdirSync(join(home, "tmp")), []);
      assert.equal(run(home, args).status, 0);
      assert.match(readFileSync(join(project, ".cotal", "agents", "big.md"), "utf8"), /x{760}/);
    });
  }

  test("space: a later seed failure reports the prepared record and the possibly incomplete persona", () => {
    const home = join(root, "seed-partial");
    const project = join(home, "project");
    mkdirSync(project, { recursive: true, mode: 0o700 });
    const failed = run(home, [bin, "space", "create", "s", "--root", project, "--json"], 256);
    assert.equal(failed.status, 4, failed.stdout + failed.stderr);
    const result = JSON.parse(failed.stdout);
    assert.equal(result.outcome, "partial");
    assert.equal(result.error.code, "OPERATION_PARTIAL");
    assert.equal(result.error.cause.code, "EFBIG");
    const record = join(home, ".cotal", "prepared", "space.73.json");
    assert.ok(result.changed.some(change => change.path === record));
    assert.equal(existsSync(record), true);
    const persona = join(project, ".cotal", "agents", "default.md");
    assert.match(result.error.message, /persona file may be incomplete/);
    assert.equal(readFileSync(persona).length, 256);
    assert.match(result.error.remedy, /file-size limit[\s\S]*cotal up/);
    assert.deepEqual(temporaryFiles(join(project, ".cotal", "agents")), []);
  });

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
      assert.deepEqual(readdirSync(home), ["tmp"]);
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
  process.umask(oldUmask);
}
finish();
