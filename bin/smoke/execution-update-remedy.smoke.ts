import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertExecutionDestination } from "../execution-transaction.js";
import { retainExecutionGeneration } from "../execution-store.js";

if (!["linux", "darwin"].includes(process.platform) || process.getuid?.() === 0) {
  console.log("execution update remedy: requires a non-root POSIX account");
} else {
  process.umask(0o022);
  const scratch = mkdtempSync(join(tmpdir(), "execution-update-remedy-"));
  console.log(`execution update remedy fixtures: ${scratch}`);
  const cases = [
    { name: "doas", tools: ["doas"], command: "doas ", normal: "without doas" },
    { name: "sudo", tools: ["sudo"], command: "sudo ", normal: "without sudo" },
    { name: "both", tools: ["doas", "sudo"], command: "sudo ", normal: "without sudo" },
    { name: "neither", tools: [], command: "as root: ", normal: "not as root" },
    { name: "non-executable-sudo", tools: ["doas"], command: "doas ", normal: "without doas" },
    { name: "sudo-directory", tools: ["doas"], command: "doas ", normal: "without doas" },
  ];
  const installed = join(scratch, "prefix with 'quote/lib/node_modules/cotal-ai");
  mkdirSync(installed, { recursive: true });
  cpSync(join(import.meta.dirname, "../dist"), join(installed, "dist"), { recursive: true });
  cpSync(join(import.meta.dirname, "../package.json"), join(installed, "package.json"));
  symlinkSync(join(import.meta.dirname, "../node_modules"), join(installed, "node_modules"));
  const original = readFileSync(join(installed, "dist/cotal.js"));
  const manifest = readFileSync(join(installed, "package.json"));
  const quotedPrefix = `'${join(scratch, "prefix with 'quote").replace(/'/g, "'\\''")}'`;
  const records = cases.map(test => {
    const root = join(scratch, test.name), path = join(root, "pathbin");
    for (const directory of ["pathbin", "home", "config", "runtime", "cotal"])
      mkdirSync(join(root, directory), { recursive: true, mode: 0o700 });
    const invoked = join(root, "invoked");
    for (const tool of test.tools)
      writeFileSync(join(path, tool), `#!/bin/sh\nprintf invoked > '${invoked}'\nexit 99\n`, { mode: 0o755 });
    if (test.name === "non-executable-sudo") writeFileSync(join(path, "sudo"), "not executable\n", { mode: 0o644 });
    if (test.name === "sudo-directory") mkdirSync(join(path, "sudo"));
    const env: NodeJS.ProcessEnv = {
      PATH: path, HOME: join(root, "home"), XDG_CONFIG_HOME: join(root, "config"),
      XDG_RUNTIME_DIR: join(root, "runtime"), COTAL_HOME: join(root, "cotal"),
      TMPDIR: tmpdir(), COTAL_NO_UPDATE_CHECK: "1", DO_NOT_TRACK: "1", NO_COLOR: "1",
    };
    const run = () => {
      const result = spawnSync(process.execPath, [join(installed, "dist/cotal.js"), "update", "--self"], {
        cwd: root, env, encoding: "utf8", timeout: 30_000,
      });
      if (result.error) throw result.error;
      return { status: result.status, signal: result.signal, stdout: result.stdout, stderr: result.stderr };
    };
    chmodSync(installed, 0o555);
    const refused = run();
    chmodSync(installed, 0o755);
    const writable = run();
    assert.deepEqual(readFileSync(join(installed, "dist/cotal.js")), original);
    assert.deepEqual(readFileSync(join(installed, "package.json")), manifest);
    assert.equal(existsSync(invoked), false, "guidance must never execute a privilege tool");
    return { test, refused, writable, path };
  });
  writeFileSync(join(scratch, "results.json"), JSON.stringify(records, null, 2));
  for (const { test, refused, writable, path } of records) {
    assert.equal(writable.status, 0, writable.stderr);
    assert.match(writable.stdout + writable.stderr, /The registry cannot be reached; nothing was changed\./);
    assert.doesNotMatch(writable.stdout + writable.stderr, /installation is not writable/);
    assert.equal(refused.status, 2, refused.stderr);
    assert.match(refused.stderr, /DEPENDENCY_UNAVAILABLE/);
    assert.match(refused.stderr, /not-executed/);
    const remedy = `installation is not writable; have an administrator run: ${test.command}npm install -g --prefix ${quotedPrefix} cotal-ai@latest; then run \`cotal update\` as your normal account, ${test.normal}`;
    assert.ok(refused.stderr.includes(remedy), `${test.name}: ${refused.stderr}`);
    const previous = process.env.PATH;
    process.env.PATH = path;
    chmodSync(installed, 0o555);
    try {
      for (const attempt of [() => assertExecutionDestination(installed), () => retainExecutionGeneration(installed, installed)])
        assert.throws(attempt, error => error instanceof Error && error.message === remedy, test.name);
    } finally {
      chmodSync(installed, 0o755);
      if (previous === undefined) delete process.env.PATH;
      else process.env.PATH = previous;
    }
    console.log(`execution update remedy: ${test.name}, refusal and writable control passed`);
  }
}
