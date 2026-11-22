import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, constants, copyFileSync, cpSync, linkSync, mkdirSync, readFileSync, realpathSync, renameSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export function checkNpmUpdateNode(root: string, binRoot: string): number {
  const installed = join(root, "prefix/lib/node_modules/cotal-ai");
  const launcher = join(root, "prefix/bin/cotal");
  const tools = join(root, "tools");
  const cli = join(root, "npm-package/bin/npm-cli.js");
  const cotal = join(installed, "dist/cotal.js");
  const node = realpathSync(process.execPath);
  const recorded = join(root, "recorded Node's bin/nodejs");
  const projectNode = join(root, "project-runtime/node");
  for (const dir of [dirname(launcher), dirname(cli), dirname(cotal), dirname(recorded), dirname(projectNode), join(installed, "scripts"), tools]) mkdirSync(dir, { recursive: true });
  copyFileSync(node, recorded, constants.COPYFILE_FICLONE);
  linkSync(recorded, projectNode);
  cpSync(join(binRoot, "dist"), dirname(cotal), { recursive: true });
  for (const file of ["package.json", "scripts/pin-npm-node.cjs"]) copyFileSync(join(binRoot, file), join(installed, file));
  symlinkSync(join(binRoot, "node_modules"), join(installed, "node_modules"));
  symlinkSync("../lib/node_modules/cotal-ai/dist/cotal.js", launcher);
  symlinkSync(cli, join(tools, "npm"));
  // Keep the test independent of which Node archives are installed on the CI worker.
  const projectVersion = process.version === "v22.10.0" ? "v22.10.1" : "v22.10.0";
  writeFileSync(cli, `#!/usr/bin/env node
const project = process.execPath === ${JSON.stringify(projectNode)};
if (project && !process.env.FIXTURE_ADVISORY_WORKS) {
  console.error('npm error code ERR_REQUIRE_ESM');
  process.exit(18);
}
console.log(JSON.stringify(project ? '0.0.2' : '0.0.1'));
`, { mode: 0o755 });
  const projectRuntime = join(root, "project-node.mjs");
  const projectLaunch = join(root, "project-launch");
  writeFileSync(projectRuntime, `import { appendFileSync } from 'node:fs';
Object.defineProperty(process, 'version', { value: process.env.FIXTURE_PROJECT_VERSION });
if (process.argv[1] === ${JSON.stringify(cotal)}) appendFileSync(${JSON.stringify(projectLaunch)}, 'CLI\\n');
`);
  writeFileSync(join(tools, "node"), `#!/bin/sh
if [ "$1" = --version ]; then printf '%s\\n' "$FIXTURE_PROJECT_VERSION"; exit 0; fi
exec "$FIXTURE_NODE" --import "$FIXTURE_PROJECT_RUNTIME" "$@"
`, { mode: 0o755 });
  const env = {
    HOME: root, USERPROFILE: root, COTAL_HOME: join(root, "cotal"), XDG_CONFIG_HOME: join(root, "config"), XDG_RUNTIME_DIR: join(root, "runtime"), TMPDIR: root,
    PATH: `${tools}:/usr/bin:/bin`, CI: "1", NO_COLOR: "1", COTAL_TELEMETRY: "off", COTAL_NO_UPDATE_CHECK: "1", COTAL_SKIP_CONNECTOR_SEED: "1",
    FIXTURE_NODE: projectNode, FIXTURE_PROJECT_RUNTIME: projectRuntime,
  };
  for (const dir of [env.COTAL_HOME, env.XDG_CONFIG_HOME, env.XDG_RUNTIME_DIR]) mkdirSync(dir, { mode: 0o700 });
  const pin = spawnSync(recorded, [join(installed, "scripts/pin-npm-node.cjs")], { cwd: root, env, encoding: "utf8", timeout: 10_000 });
  assert.equal(pin.status, 0, pin.stdout + pin.stderr);
  assert.equal(realpathSync(launcher), join(installed, "dist/cotal-npm"));

  const meta = join(root, "npm-manifest.json");
  symlinkSync(meta, join(dirname(cli), "../package.json"));
  const declare = (engine: string, version = "12.2.3") => writeFileSync(meta, JSON.stringify({ name: "npm", version, engines: { node: engine } }));
  const run = (args: string[], advisoryWorks = false, version = projectVersion) => spawnSync(launcher, ["update", ...args], {
    cwd: root, env: { ...env, FIXTURE_PROJECT_VERSION: version, ...(advisoryWorks ? { FIXTURE_ADVISORY_WORKS: "1" } : {}) },
    encoding: "utf8", timeout: 10_000,
  });
  const check = (advisoryWorks: boolean, expected: string, version = projectVersion) => {
    const result = run(["--check", "--json"], advisoryWorks, version);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.equal(JSON.parse(result.stdout).result.latest, expected);
  };
  for (const [engine, advisoryWorks, expected] of [[`=${process.versions.node}`, false, "0.0.1"], [">=999.0.0", true, "0.0.2"]] as const) {
    declare(engine);
    check(advisoryWorks, expected);
  }
  const failed = run(["--check", "--json"]);
  assert.equal(failed.status, 4, failed.stdout + failed.stderr);
  const partial = JSON.parse(failed.stdout);
  assert.equal(partial.warnings[0].code, "NPM_RUNTIME_UNAVAILABLE");
  assert.match(partial.warnings[0].message, /npm failed on Node\.js v22\.10\./);
  assert.match(partial.error.remedy, /compatible Node and npm on PATH/);

  for (const [npmVersion, expected] of [["11.19.0", "0.0.1"], ["12.2.1", "0.0.1"], ["12.2.2", "0.0.2"]] as const) {
    declare(">=22.9.0", npmVersion);
    check(true, expected, "v26.1.0-rc.0");
  }

  declare(`=${process.versions.node}`);
  const moved = `${recorded}.moved`;
  renameSync(recorded, moved);
  symlinkSync(moved, recorded);
  check(true, "0.0.2");
  unlinkSync(recorded);
  renameSync(moved, recorded);
  for (const directory of [dirname(launcher), dirname(recorded)]) {
    chmodSync(directory, 0o777);
    try { check(true, "0.0.2"); }
    finally { chmodSync(directory, 0o755); }
  }
  chmodSync(launcher, 0o775);
  const untrusted = run(["--self"]);
  assert.equal(untrusted.status, 1, untrusted.stdout + untrusted.stderr);
  assert.match(untrusted.stderr, /npm failed on Node\.js .*compatible Node and npm on PATH/);
  assert.equal(readFileSync(projectLaunch, "utf8"), "CLI\n".repeat(10), "the CLI always starts on the project Node");
  return 25;
}
