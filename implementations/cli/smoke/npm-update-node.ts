import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, cpSync, mkdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export function checkNpmUpdateNode(root: string, binRoot: string): number {
  const installed = join(root, "prefix/lib/node_modules/cotal-ai");
  const launcher = join(root, "prefix/bin/cotal");
  const tools = join(root, "tools");
  const cli = join(root, "npm-package/bin/npm-cli.js");
  const cotal = join(installed, "dist/cotal.js");
  const node = realpathSync(process.execPath);
  for (const dir of [dirname(launcher), dirname(cli), dirname(cotal), join(installed, "scripts"), tools]) mkdirSync(dir, { recursive: true });
  cpSync(join(binRoot, "dist"), dirname(cotal), { recursive: true });
  for (const file of ["package.json", "scripts/pin-npm-node.cjs"]) copyFileSync(join(binRoot, file), join(installed, file));
  symlinkSync(join(binRoot, "node_modules"), join(installed, "node_modules"));
  symlinkSync("../lib/node_modules/cotal-ai/dist/cotal.js", launcher);
  symlinkSync(cli, join(tools, "npm"));
  // Keep the test independent of which Node archives are installed on the CI worker.
  const projectVersion = process.version === "v22.10.0" ? "v22.10.1" : "v22.10.0";
  writeFileSync(cli, `#!/usr/bin/env node
if (process.version === ${JSON.stringify(projectVersion)}) process.exit(18);
console.log(JSON.stringify('0.0.1'));
`, { mode: 0o755 });
  const projectRuntime = join(root, "project-node.mjs");
  const projectLaunch = join(root, "project-launch");
  writeFileSync(projectRuntime, `import { appendFileSync } from 'node:fs';
Object.defineProperty(process, 'version', { value: ${JSON.stringify(projectVersion)} });
if (process.argv[1] === ${JSON.stringify(cotal)}) appendFileSync(${JSON.stringify(projectLaunch)}, 'CLI\\n');
`);
  writeFileSync(join(tools, "node"), `#!/bin/sh
if [ "$1" = --version ]; then printf '%s\\n' '${projectVersion}'; exit 0; fi
exec "$FIXTURE_NODE" --import "$FIXTURE_PROJECT_RUNTIME" "$@"
`, { mode: 0o755 });
  const env = {
    HOME: root, USERPROFILE: root, COTAL_HOME: join(root, "cotal"), XDG_CONFIG_HOME: join(root, "config"), XDG_RUNTIME_DIR: join(root, "runtime"), TMPDIR: root,
    PATH: `${tools}:/usr/bin:/bin`, CI: "1", NO_COLOR: "1", COTAL_TELEMETRY: "off", COTAL_NO_UPDATE_CHECK: "1", COTAL_SKIP_CONNECTOR_SEED: "1",
    FIXTURE_NODE: node, FIXTURE_PROJECT_RUNTIME: projectRuntime,
  };
  for (const dir of [env.COTAL_HOME, env.XDG_CONFIG_HOME, env.XDG_RUNTIME_DIR]) mkdirSync(dir, { mode: 0o700 });
  const pin = spawnSync(node, [join(installed, "scripts/pin-npm-node.cjs")], { cwd: root, env, encoding: "utf8", timeout: 10_000 });
  assert.equal(pin.status, 0, pin.stdout + pin.stderr);
  assert.equal(realpathSync(launcher), join(installed, "dist/cotal-npm"));

  const packageJson = join(dirname(cli), "../package.json");
  const check = (args = ["update", "--check", "--json"]) => spawnSync(launcher, args, { cwd: root, env, encoding: "utf8", timeout: 10_000 });
  for (const [engine, expected] of [[`=${process.versions.node}`, 0], [">=999.0.0", 1]] as const) {
    writeFileSync(packageJson, JSON.stringify({ name: "npm", engines: { node: engine } }));
    const result = check(expected ? ["update", "--self"] : undefined);
    assert.equal(result.status, expected, result.stdout + result.stderr);
    if (expected) assert.match(result.stderr, /npm requires Node\.js .*no usable compatible Node/);
    else assert.equal(JSON.parse(result.stdout).result.latest, "0.0.1");
  }
  writeFileSync(packageJson, JSON.stringify({ name: "npm", engines: { node: `=${process.versions.node}` } }));
  chmodSync(launcher, 0o775);
  const untrusted = check(["update", "--self"]);
  assert.equal(untrusted.status, 1, untrusted.stdout + untrusted.stderr);
  assert.match(untrusted.stderr, /npm requires Node\.js .*no usable compatible Node/);
  assert.equal(readFileSync(projectLaunch, "utf8"), "CLI\nCLI\nCLI\n", "the CLI always starts on the project Node");
  return 9;
}
