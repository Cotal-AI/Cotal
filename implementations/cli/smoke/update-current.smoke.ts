import "./update-isolation.js";
import strictAssert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { copyFileSync, cpSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, realpathSync, renameSync, rmdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, parse } from "node:path";
import { pathToFileURL } from "node:url";
import { claimGlobalNpmUpdateLock, recoveryProcessStartToken, withWindowsUpdateIdentity } from "@cotal-ai/workspace";
import { countedAssert, emitSentinel } from "../../../bin/smoke/sentinel.mjs";
import { executeUpdate, updateRuntime, type UpdateRuntime } from "../src/commands/update.js";
import { installedUpdatePrefix, runGlobalProcess, runNpm, runProcess } from "../src/commands/update-process.js";
import { npmProjectDirectory } from "../src/lib/npm-invocation.js";
import { SEED_BUILTINS } from "../src/seed/paths.js";
import { repairRuntimeEntry } from "./update-runtime-entry.smoke.js";
const counted = countedAssert(strictAssert);
const assert: typeof strictAssert = counted.assert as typeof strictAssert;
if (process.platform === "win32") {
  const prefix = mkdtempSync(join(tmpdir(), "cotal update prefix "));
  const previous = process.env.npm_config_prefix;
  try {
    const installed = join(prefix, "node_modules", "cotal-ai"), entry = join(installed, "dist", "cotal.js");
    mkdirSync(dirname(entry), { recursive: true });
    writeFileSync(entry, "");
    writeFileSync(join(installed, "package.json"), JSON.stringify({ name: "cotal-ai", version: "1.0.0", bin: { cotal: "dist/cotal.js" } }));
    writeFileSync(join(prefix, "cotal.cmd"), '@node "%dp0%\\node_modules\\cotal-ai\\dist\\cotal.js" %*\r\n');
    const selected = installedUpdatePrefix(installed, entry);
    assert.equal(selected, realpathSync(prefix), "the invoked Windows package selects its own prefix");
    process.env.npm_config_prefix = join(prefix, "other");
    const result = runNpm(["root", "-g", "--prefix", selected!]);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(realpathSync(result.stdout.trim()), realpathSync(join(prefix, "node_modules")), "the pinned prefix wins over the alternate npm environment");
    writeFileSync(join(prefix, "package.json"), '{"name":"local-project"}');
    assert.equal(installedUpdatePrefix(installed, entry), undefined, "local installs do not redirect the global update");
    const root = join(prefix, "node_modules");
    const fail = await runGlobalProcess(root, "install", process.execPath, ["-e", "process.exit(7)"], process.env);
    assert.equal(fail.status, 7, fail.error);
    const retry = await runGlobalProcess(root, "install", process.execPath, ["-e", "console.log('retried')"], process.env);
    assert.equal(retry.status, 0, retry.error);
    assert.equal(retry.stdout.trim(), "retried", "a confirmed failed Windows install does not block retry");
    const token = withWindowsUpdateIdentity(() => recoveryProcessStartToken(process.pid));
    assert.match(token ?? "", /^\d{1,20}$/, "a Windows updater can pin its identity without loading its replaceable native binding");
  } finally {
    if (previous === undefined) delete process.env.npm_config_prefix;
    else process.env.npm_config_prefix = previous;
    rmSync(prefix, { recursive: true, force: true });
  }
}
const effects: string[] = [], output: string[] = [];
const current = { isCurrent: () => true };
const rt: UpdateRuntime = {
  ...updateRuntime, ...current, env: {}, version: () => "0.13.1",
  reportRunningManager: async () => { effects.push("custody"); return "legacy"; },
  reconcile: async () => { effects.push("reconcile"); },
  npm: args => { assert.equal(args[0], "view"); return { status: 0, stdout: '"0.13.1"', stderr: "" }; },
  out: text => { output.push(text); }, err: text => { output.push(text); },
};
assert.equal(await executeUpdate(true, rt), 0, "current package closure with no newer release succeeds");
assert.deepEqual(effects, []);
assert.ok(output.some(line => line.includes("installed package closure is current")) && !output.some(line => line.includes("Run `cotal update` to repair connector integrations")), "a current no-op reports its observed current package closure without inventing connector repair work");
for (const consistent of [false, true]) {
  const actions: string[] = [];
  const denied: UpdateRuntime = { ...rt, isCurrent: () => consistent,
    reportRunningManager: async () => { actions.push("custody"); if (consistent) throw new Error("custody unreadable"); return "legacy"; },
    reconcile: async () => { actions.push("repair"); },
  };
  assert.equal(await executeUpdate(true, denied), consistent ? 0 : 1, "only reconciliation needs a custody verdict");
  assert.deepEqual(actions, consistent ? [] : ["custody"]);
}
for (const consistent of [false, true]) {
  const actions: string[] = [], lines: string[] = [];
  const offline: UpdateRuntime = { ...rt, isCurrent: () => consistent,
    npm: args => {
      assert.ok(args.includes("--fetch-retries=0") && args.includes("--fetch-timeout=15000"));
      return { status: 1, stdout: '{"error":{"code":"EAI_AGAIN"}}', stderr: "npm error EAI_AGAIN" };
    },
    reportRunningManager: async () => { actions.push("custody"); return "legacy"; },
    reconcile: async () => { actions.push("repair"); },
    out: line => { lines.push(line); }, err: line => { lines.push(line); },
  };
  assert.equal(await executeUpdate(true, offline), 0);
  assert.deepEqual(actions, []);
  assert.deepEqual(lines, ["The registry cannot be reached; nothing was changed."]);
}
for (const code of ["ENOTCACHED", "EAI_AGAIN", "E401"]) {
  const lines: string[] = [], errors: string[] = [];
  const plain: UpdateRuntime = { ...rt,
    reportRunningManager: async () => "none", preflightReplacement: async () => {},
    refreshConnectors: async () => {}, refreshClients: async () => [], extensions: () => [], claimUpdatePass: () => () => {},
    npm: () => ({ status: 1, stdout: JSON.stringify({ error: { code } }), stderr: `npm error ${code}` }),
    out: line => { lines.push(line); }, err: line => { errors.push(line); },
  };
  assert.equal(await executeUpdate(false, plain), 0);
  assert.match(lines.join("\n"), /Registry latest:\s+not established/);
  assert.deepEqual(errors, []);
}
async function closedPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => server.once("error", reject).listen(0, "127.0.0.1", resolve));
  const address = server.address();
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  if (!address || typeof address === "string") throw new Error("no loopback port");
  return address.port;
}
const proxyPort = await closedPort();
let registryPort = await closedPort();
while (registryPort === proxyPort) registryPort = await closedPort();
const proxyHome = mkdtempSync(join(tmpdir(), "cotal-update-proxy-"));
try {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(?:cotal_|npm_config_|(?:https?_proxy|all_proxy|proxy|no_proxy)$)/i.test(key)));
  const update = (extra: NodeJS.ProcessEnv) => spawnSync(process.execPath, [join(import.meta.dirname, "../../../bin/dist/cotal.js"), "update", "--self"], {
    cwd: proxyHome, encoding: "utf8", timeout: 30_000,
    env: { ...env, HOME: proxyHome, USERPROFILE: proxyHome, COTAL_HOME: join(proxyHome, "cotal"),
      XDG_CONFIG_HOME: join(proxyHome, "config"), LOCALAPPDATA: join(proxyHome, "local"), APPDATA: join(proxyHome, "roaming"),
      npm_config_userconfig: join(proxyHome, "user.npmrc"), npm_config_globalconfig: join(proxyHome, "global.npmrc"),
      npm_config_prefix: join(proxyHome, "prefix"), npm_config_registry: `https://127.0.0.1:${registryPort}`,
      COTAL_TELEMETRY: "off", COTAL_NO_UPDATE_CHECK: "1", COTAL_SKIP_CONNECTOR_SEED: "1", ...extra },
  });
  const proxy = { HTTPS_PROXY: `http://example-user:example-password@127.0.0.1:${proxyPort}` };
  const refused = update(proxy);
  assert.equal(refused.status, 1, refused.stdout + refused.stderr);
  assert.match(refused.stderr, /npm proxy refused the connection \(ECONNREFUSED\).*HTTP_PROXY and HTTPS_PROXY/);
  assert.doesNotMatch(refused.stdout + refused.stderr, /example-user|example-password|127\.0\.0\.1/);
  const direct = update({ ...proxy, NO_PROXY: "127.0.0.1" });
  assert.equal(direct.status, 0, direct.stdout + direct.stderr);
  assert.equal(direct.stdout.trim(), "The registry cannot be reached; nothing was changed.");
  assert.doesNotMatch(direct.stderr, /proxy refused/i);

  const userConfig = join(proxyHome, "user.npmrc");
  const contents = `https-proxy=${proxy.HTTPS_PROXY}\n`;
  writeFileSync(userConfig, contents);
  const configured = update({});
  assert.equal(configured.status, 0, configured.stdout + configured.stderr);
  assert.match(configured.stdout, /npm proxy refused the connection \(ECONNREFUSED\).*`https-proxy` in your npm configuration/);
  assert.doesNotMatch(configured.stdout + configured.stderr, /example-user|example-password|127\.0\.0\.1/);
  assert.equal(readFileSync(userConfig, "utf8"), contents);

  const overridden = update({ npm_config_https_proxy: `http://127.0.0.1:${registryPort}` });
  assert.equal(overridden.status, 0, overridden.stdout + overridden.stderr);
  assert.equal(overridden.stdout.trim(), "The registry cannot be reached; nothing was changed.");
  const bypassed = update({ NO_PROXY: "127.0.0.1" });
  assert.equal(bypassed.status, 0, bypassed.stdout + bypassed.stderr);
  assert.equal(bypassed.stdout.trim(), "The registry cannot be reached; nothing was changed.");

  writeFileSync(userConfig, `proxy=${proxy.HTTPS_PROXY}\n`);
  const fallback = update({});
  assert.equal(fallback.status, 0, fallback.stdout + fallback.stderr);
  assert.match(fallback.stdout, /npm proxy refused the connection \(ECONNREFUSED\).*`proxy` in your npm configuration/);
} finally { rmSync(proxyHome, { recursive: true, force: true }); }
const { seedInstallationCurrent } = await import("../src/seed/reconcile.js");
assert.equal(seedInstallationCurrent(), false, "an unseeded checkout is not proven current");
{
  const home = mkdtempSync(join(tmpdir(), "cotal-update-no-npm-"));
  try {
    const path = join(home, "node-only");
    mkdirSync(path);
    if (process.platform === "win32") copyFileSync(process.execPath, join(path, "node.exe"));
    else symlinkSync(process.execPath, join(path, "node"));
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(?:cotal_|path$)/i.test(key)));
    for (const flags of [["--self"], ["--check"], ["--check", "--plain"], ["--check", "--json"]]) {
      const result = spawnSync(process.execPath, [join(import.meta.dirname, "../../../bin/dist/cotal.js"), "update", ...flags], {
        cwd: home, encoding: "utf8", timeout: 30_000,
        env: { ...env, HOME: home, USERPROFILE: home, APPDATA: join(home, "config"), LOCALAPPDATA: join(home, "config"),
          COTAL_HOME: join(home, "cotal"), XDG_CONFIG_HOME: join(home, "config"), XDG_RUNTIME_DIR: home, PATH: path,
          COTAL_TELEMETRY: "off", COTAL_NO_UPDATE_CHECK: "1", COTAL_SKIP_CONNECTOR_SEED: "1" },
      });
      const output = result.stdout + result.stderr;
      assert.equal(result.status, flags[0] === "--self" ? 1 : 4, output);
      assert.match(output, /npm is not on PATH/);
      assert.match(output, /Install npm or add it to this command's PATH/);
      assert.doesNotMatch(output, /registry cannot be reached|Check registry access/);
      if (flags.includes("--json")) {
        const report = JSON.parse(result.stdout);
        assert.equal(report.warnings[0].code, "NPM_UNAVAILABLE");
        assert.equal(report.result.installationChanged, false);
      }
    }
  } finally { rmSync(home, { recursive: true, force: true }); }
}
const { registryArrivalCell } = await import("../../../bin/smoke/update-registry-arrival.smoke.mjs");
const cacheUpdate = await registryArrivalCell({ scenario: "cache" });
assert.equal(cacheUpdate.code, 0, "real CLI and npm update succeed with a user-owned cache that is not writable");
if (["linux", "darwin"].includes(process.platform)) {
  const lifecycleUpdate = await registryArrivalCell({ scenario: "version-named-node" });
  assert.equal(lifecycleUpdate.code, 0, lifecycleUpdate.output);
}

function assertSlowProbeFallback(root: string, dispatcher: string, executable: string, path: string,
  check: () => { status: number | null; stdout: string; stderr: string }, launchedNode: () => string): void {
  const probeLog = join(root, "slow-probe");
  writeFileSync(dispatcher, `#!/bin/sh
if [ "$1" = -p ]; then exec /bin/sleep 3; fi
case "$1" in
  --version) printf '%s\\n' "$PWD" >> "${probeLog}" ;;
  *) printf '%s\\n' "$PWD" "$PATH" >> "${probeLog}" ;;
esac
exec "${executable}" "$@"
`);
  const result = check();
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /Registry latest:\s+\d/);
  const isolated = parse(root).root;
  assert.deepEqual(readFileSync(probeLog, "utf8").trim().split("\n"), [isolated, isolated, path],
    "the fallback probes and runs npm through the shim with its original PATH precedence");
  assert.equal(realpathSync(launchedNode()), realpathSync(executable), "the slow probe keeps the compatible npm runtime");
}

await repairRuntimeEntry(assert);

async function npmNodeEngine(): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "cotal-npm-node-"));
  try {
    const repoBin = join(import.meta.dirname, "../../../bin");
    const posixLauncher = process.platform === "linux" || process.platform === "darwin";
    const exe = process.platform === "win32" ? "node.exe" : "node";
    const alternate = join(root, "alternate Node", exe);
    const npmBin = join(root, "npm-bin");
    const npmRoot = join(npmBin, "node_modules", "npm");
    const cli = join(npmRoot, "bin", "npm-cli.js");
    for (const dir of [dirname(alternate), dirname(cli)]) mkdirSync(dir, { recursive: true });
    copyFileSync(process.execPath, alternate);
    const version = JSON.parse(readFileSync(join(repoBin, "package.json"), "utf8")).version;
    const record = join(root, "npm-runtime");
    type NpmLaunch = { node: string; cwd: string; pathHead: string };
    const recordedLaunches = (): NpmLaunch[] => readFileSync(record, "utf8").trim().split(/\r?\n/).map(line => JSON.parse(line));
    writeFileSync(join(npmRoot, "package.json"), JSON.stringify({ name: "npm", bin: { npm: "bin/npm-cli.js" }, engines: { node: process.version } }));
    writeFileSync(cli, `#!/usr/bin/env node
require('node:fs').appendFileSync(${JSON.stringify(record)}, JSON.stringify({
  node: process.execPath, cwd: process.cwd(), pathHead: (process.env.PATH ?? '').split(require('node:path').delimiter)[0],
}) + '\\n');
console.log(JSON.stringify(${JSON.stringify(version)}));
`, { mode: 0o755 });
    if (process.platform === "win32") writeFileSync(join(npmBin, "npm.cmd"), '@node "%~dp0node_modules\\npm\\bin\\npm-cli.js" %*\r\n');
    else symlinkSync(cli, join(npmBin, "npm"));
    const prefix = join(root, "prefix");
    let entry = join(repoBin, "dist", "cotal.js");
    if (posixLauncher) {
      const installed = join(prefix, "lib/node_modules/cotal-ai");
      mkdirSync(join(prefix, "bin"), { recursive: true });
      mkdirSync(join(installed, "scripts"), { recursive: true });
      cpSync(join(repoBin, "dist"), join(installed, "dist"), { recursive: true });
      copyFileSync(join(repoBin, "package.json"), join(installed, "package.json"));
      symlinkSync(join(repoBin, "node_modules"), join(installed, "node_modules"));
      entry = join(installed, "dist", "cotal.js");
      symlinkSync(entry, join(prefix, "bin", "cotal"));
      const pin = join(installed, "scripts", "pin-npm-node.cjs");
      copyFileSync(join(repoBin, "scripts", "pin-npm-node.cjs"), pin);
      const result = spawnSync(alternate, [pin], { cwd: root, env: Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^cotal_/i.test(key))), encoding: "utf8" });
      assert.equal(result.status, 0, result.stdout + result.stderr);
      assert.match(readlinkSync(join(prefix, "bin", "cotal")), /cotal-npm$/);
    }
    // Vary the running CLI's Node version without downloading a second runtime onto every runner.
    const versionOverride = join(root, "project-node.mjs");
    const incompatibleVersion = process.version === "v22.10.0" ? "v22.10.1" : "v22.10.0";
    writeFileSync(versionOverride, `if (process.argv[1]?.endsWith('cotal.js')) Object.defineProperty(process, 'version', { value: '${incompatibleVersion}' });\n`);
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(cotal_|npm_config_|path$)/i.test(key)));
    const onlyNode = join(root, "project-bin");
    mkdirSync(onlyNode);
    if (process.platform === "win32") copyFileSync(process.execPath, join(onlyNode, exe));
    else symlinkSync(process.execPath, join(onlyNode, exe));
    const cliEnv = (extraPath: string[], npmPath = npmBin) => ({
      ...env, HOME: root, USERPROFILE: root, APPDATA: join(root, "config"), LOCALAPPDATA: join(root, "config"),
      COTAL_HOME: join(root, "cotal"), XDG_CONFIG_HOME: join(root, "config"), XDG_RUNTIME_DIR: root, npm_config_prefix: prefix,
      COTAL_TELEMETRY: "off", COTAL_NO_UPDATE_CHECK: "1", COTAL_SKIP_CONNECTOR_SEED: "1", COTAL_ALLOW_CHECKOUT_SEED: "1",
      NODE_OPTIONS: `--import=${pathToFileURL(versionOverride).href}`, PATH: [onlyNode, npmPath, ...extraPath].join(delimiter),
    });
    const run = (flag: string, extraPath: string[] = [], npmPath = npmBin, cwd = root, node?: string) => spawnSync(node ?? join(onlyNode, exe), [entry, "update", flag], {
      cwd, encoding: "utf8", timeout: 60_000,
      env: node ? { ...cliEnv(extraPath, npmPath), NODE_OPTIONS: undefined, PATH: "." } : cliEnv(extraPath, npmPath),
    });
    const first = run("--check", posixLauncher ? [] : [dirname(alternate)]);
    assert.equal(first.status, 0, first.stdout + first.stderr);
    assert.match(first.stdout, /Registry latest:/);
    assert.ok(recordedLaunches().every(({ node }) => realpathSync(node) === realpathSync(alternate)));
    // Record all built-ins as deliberately removed so self-update needs no fixture npm installs.
    const seed = join(root, "config", "cotal", "seed");
    mkdirSync(seed, { recursive: true });
    writeFileSync(join(seed, "authority.json"), JSON.stringify({ everSeeded: SEED_BUILTINS }));
    writeFileSync(join(seed, "witness.json"), JSON.stringify({ initialized: true, firstGeneration: version }));
    writeFileSync(join(seed, "stamp.json"), JSON.stringify({ generation: version }));
    const before = readFileSync(entry);
    const corepackDir = join(root, "corepack-bin");
    const corepackRoot = join(root, "node_modules", "corepack");
    const corepackNpm = join(corepackRoot, "dist", "npm.js");
    mkdirSync(corepackDir);
    mkdirSync(dirname(corepackNpm), { recursive: true });
    writeFileSync(corepackNpm, `#!/usr/bin/env node
const { realpathSync } = require('node:fs');
if (realpathSync(process.execPath) !== ${JSON.stringify(realpathSync(alternate))}) {
  console.error(${JSON.stringify(`npm warn cli npm v12.2.3 does not support Node.js ${incompatibleVersion}. This version of npm supports the following node versions: \`${process.version}\`.`)});
  if (process.argv.includes('--version')) console.log('12.2.3');
  process.exit(process.argv.includes('--version') ? 0 : 1);
}
if (process.argv.includes('--version')) {
  console.log('12.2.3');
  process.exit(0);
}
require(${JSON.stringify(cli)});
`, { mode: 0o755 });
    if (process.platform === "win32") writeFileSync(join(corepackDir, "npm.cmd"), '@node "%~dp0\\..\\node_modules\\corepack\\dist\\npm.js" %*\r\n');
    else symlinkSync(corepackNpm, join(corepackDir, "npm"));
    for (const node of [process.version, "*"]) {
      writeFileSync(join(corepackRoot, "package.json"), JSON.stringify({ name: "corepack", engines: { node } }));
      const before = recordedLaunches().length;
      const viaCorepack = run("--self", [dirname(alternate)], corepackDir);
      assert.equal(viaCorepack.status, 0, viaCorepack.stdout + viaCorepack.stderr);
      assert.match(viaCorepack.stdout, /Registry latest:/);
      assert.deepEqual(recordedLaunches().slice(before).map(({ node }) => realpathSync(node)),
        [realpathSync(alternate)], "npm's Corepack entry runs on the compatible Node");
    }
    renameSync(alternate, `${alternate}.gone`);
    if (process.platform !== "win32") {
      const shimDir = join(root, "shim-bin");
      mkdirSync(shimDir);
      const dispatcher = join(shimDir, "tool-shim");
      writeFileSync(dispatcher, `#!/bin/sh\n[ "\${0##*/}" = node ] || exit 1\nexec "${alternate}.gone" "$@"\n`, { mode: 0o755 });
      symlinkSync(dispatcher, join(shimDir, "node"));
      const viaShim = run("--self", [shimDir]);
      assert.equal(viaShim.status, 0, viaShim.stdout + viaShim.stderr);
      assert.match(viaShim.stdout, /Registry latest:/);
      assert.equal(realpathSync(recordedLaunches().at(-1)!.node), realpathSync(`${alternate}.gone`), "npm uses the Node selected by the name-sensitive shim");

      assertSlowProbeFallback(root, dispatcher, `${alternate}.gone`, [shimDir, onlyNode, npmBin, shimDir].join(delimiter),
        () => run("--check", [shimDir]), () => recordedLaunches().at(-1)!.node);

      const projectNode = join(root, "project runtime", "bin", "node");
      mkdirSync(dirname(projectNode), { recursive: true });
      copyFileSync(process.execPath, projectNode);
      const project = join(root, "project");
      mkdirSync(project);
      mkdirSync(join(root, ".cotal"));
      writeFileSync(join(project, ".tool-versions"), `nodejs ${process.versions.node}\n`);
      writeFileSync(dispatcher, `#!/bin/sh\n[ "\${0##*/}" = node ] && [ -f .tool-versions ] || exit 126\nexec "${projectNode}" "$@"\n`);
      const before = recordedLaunches().length;
      const viaProject = run("--self", [shimDir], npmBin, project);
      assert.equal(viaProject.status, 0, viaProject.stdout + viaProject.stderr);
      assert.match(viaProject.stdout, /Registry latest:/);
      assert.deepEqual(recordedLaunches().slice(before), [{
        node: realpathSync(projectNode), cwd: parse(root).root, pathHead: dirname(realpathSync(projectNode)),
      }], "npm uses the project-selected executable and its bin directory outside the project");

      rmSync(projectNode);
      writeFileSync(dispatcher, `#!/bin/sh\nif [ -f .tool-versions ]; then exec "${projectNode}" "$@"; fi\nexec "${alternate}.gone" "$@"\n`);
      const original = process.version;
      Object.defineProperty(process, "version", { value: incompatibleVersion });
      try {
        const file = join(onlyNode, exe), args = [entry, "update", "--check"], env = cliEnv([shimDir]);
        const release = claimGlobalNpmUpdateLock(root);
        try {
          for (const binName of ["node executable", "node:executable"]) {
            const namedNode = join(root, binName, `node-${process.versions.node}`);
            mkdirSync(dirname(namedNode));
            copyFileSync(process.execPath, namedNode);
            symlinkSync(namedNode, projectNode);
            const resolved = realpathSync(namedNode);
            const pathHead = binName.includes(delimiter) ? onlyNode : dirname(resolved);
            for (const launch of [() => runGlobalProcess(root, "reconcile", file, args, env), () => runProcess(file, args, env)]) {
              const child = await npmProjectDirectory.run(project, () => launch());
              assert.equal(child.status, 0, child.stdout + child.stderr);
              assert.deepEqual(recordedLaunches().at(-1), {
                node: resolved, cwd: parse(root).root, pathHead,
              }, `the child keeps the symlinked runtime from ${binName} without splitting its directory on PATH`);
            }
            rmSync(projectNode);
          }
        } finally { release(); }
      } finally { Object.defineProperty(process, "version", { value: original }); }

      writeFileSync(dispatcher, `#!/bin/sh\n[ -f .tool-versions ] && exit 126\nexec "${alternate}.gone" "$@"\n`);
      const viaIsolatedShim = run("--check", [shimDir], npmBin, project);
      assert.equal(viaIsolatedShim.status, 0, viaIsolatedShim.stdout + viaIsolatedShim.stderr);
      assert.equal(realpathSync(recordedLaunches().at(-1)!.node), realpathSync(`${alternate}.gone`), "the same shim can select Node from the isolated npm directory");

      const asdfData = join(root, "asdf-data"), asdfShims = join(asdfData, "shims"), asdfBin = join(root, "asdf-bin");
      const asdfPluginShim = join(asdfData, "plugins", "nodejs", "shims", "npm");
      const asdfInstall = join(asdfData, "installs", "nodejs", process.versions.node);
      for (const dir of [asdfShims, asdfBin, dirname(asdfPluginShim), join(asdfInstall, "bin")]) mkdirSync(dir, { recursive: true });
      copyFileSync(process.execPath, join(asdfInstall, "bin", "node"));
      symlinkSync(cli, join(asdfInstall, "bin", "npm"));
      const asdfCalls = join(root, "asdf-calls");
      const asdfExe = join(asdfBin, "asdf");
      const writeAsdfExe = () => writeFileSync(asdfExe, `#!/bin/sh
printf '%s\\n' "$1:$2:$PWD" >> ${JSON.stringify(asdfCalls)}
if [ -n "$ASDF_TEST_SLEEP" ]; then /bin/sleep "$ASDF_TEST_SLEEP"; fi
if [ -n "$ASDF_TEST_WHICH_OUT" ]; then printf '%b' "$ASDF_TEST_WHICH_OUT"; exit "\${ASDF_TEST_WHICH_CODE:-0}"; fi
if [ ! -f .tool-versions ]; then
  printf '%s\\n' 'No version is set for nodejs; please run \`asdf set [options] nodejs <version>\`' >&2
  exit 1
fi
case "$1:$2" in
  which:npm) printf '%s\\n' ${JSON.stringify(asdfPluginShim)} ;;
  where:nodejs) cat .tool-versions ;;
  exec:npm) shift 2; exec ${JSON.stringify(asdfPluginShim)} "$@" ;;
  *) exit 2 ;;
esac
`, { mode: 0o755 });
      writeAsdfExe();
      writeFileSync(asdfPluginShim, `#!/bin/sh\ninstalled=$(${JSON.stringify(asdfExe)} where nodejs) || exit $?\nexec "$installed/bin/npm" "$@"\n`, { mode: 0o755 });
      const writeGoAsdfShim = (asdfCmd = "asdf") => writeFileSync(join(asdfShims, "npm"), `#!/bin/sh\n# asdf-plugin: nodejs ${process.versions.node}\nexec ${asdfCmd} exec "npm" "$@"`, { mode: 0o755 });
      writeGoAsdfShim();
      const asdfExtra = [asdfBin, "/usr/bin", "/bin"];
      const asdfBaseEnv = { ...cliEnv(asdfExtra, asdfShims), ASDF_DATA_DIR: asdfData };
      writeFileSync(join(project, ".tool-versions"), `${asdfInstall}\n`);

      rmSync(asdfCalls, { force: true });
      const standaloneAsdf = spawnSync(join(onlyNode, exe), [entry, "update", "--self"], {
        cwd: project, encoding: "utf8", timeout: 60_000, env: { ...asdfBaseEnv, NODE_OPTIONS: undefined },
      });
      assert.equal(standaloneAsdf.status, 0, standaloneAsdf.stdout + standaloneAsdf.stderr);
      assert.match(standaloneAsdf.stdout, /Registry latest:/);
      assert.deepEqual(recordedLaunches().at(-1), {
        node: realpathSync(join(onlyNode, exe)), cwd: parse(root).root, pathHead: onlyNode,
      }, "project-selected asdf npm runs outside the project on Cotal's standalone compatible Node");
      assert.deepEqual(readFileSync(asdfCalls, "utf8").trim().split(/\r?\n/), [
        `which:npm:${realpathSync(project)}`, `where:nodejs:${realpathSync(project)}`,
      ], "asdf npm resolution is memoised per process for the same shim and directory");

      // Exact bash reshim template from asdf v0.10.2, v0.14.1, and v0.15.0 (`lib/commands/reshim.bash`),
      // where `$(asdf_dir)` and `${executable_name}` expand when asdf writes the shim.
      for (const asdfDirExpr of [asdfData, "${ASDF_DIR}"]) {
        const legacyAsdfDir = join(asdfData, "bin");
        mkdirSync(legacyAsdfDir, { recursive: true });
        copyFileSync(asdfExe, join(legacyAsdfDir, "asdf"));
        writeFileSync(join(asdfShims, "npm"), `#!/usr/bin/env bash\n# asdf-plugin: nodejs ${process.versions.node}\nexec ${asdfDirExpr}/bin/asdf exec "npm" "$@" # asdf_allow: ' asdf '\n`, { mode: 0o755 });
        const legacyEnv = { ...cliEnv(["/usr/bin", "/bin"], asdfShims), ASDF_DATA_DIR: asdfData, ASDF_DIR: asdfData, NODE_OPTIONS: undefined };
        const legacyAsdf = spawnSync(join(onlyNode, exe), [entry, "update", "--self"], {
          cwd: project, encoding: "utf8", timeout: 60_000, env: legacyEnv,
        });
        assert.equal(legacyAsdf.status, 0, legacyAsdf.stdout + legacyAsdf.stderr);
        assert.match(legacyAsdf.stdout, /Registry latest:/);
        assert.deepEqual(recordedLaunches().at(-1), {
          node: realpathSync(join(onlyNode, exe)), cwd: parse(root).root, pathHead: onlyNode,
        }, `bash-era asdf reshim template (${asdfDirExpr}) resolves the project's npm`);
      }
      writeGoAsdfShim();

      const unsetAsdf = spawnSync(join(onlyNode, exe), [entry, "update", "--self"], {
        cwd: root, encoding: "utf8", timeout: 60_000, env: { ...asdfBaseEnv, NODE_OPTIONS: undefined },
      });
      assert.equal(unsetAsdf.status, 1, unsetAsdf.stdout + unsetAsdf.stderr);
      assert.match(unsetAsdf.stderr, /No version is set for nodejs/);

      // Failure fallbacks: missing asdf, >2s hang, and relative / multi-line / non-executable answers
      // each leave the original shim in place (main's behaviour).
      const missingAsdfPath = join(root, "missing-asdf-dir", "asdf");
      writeFileSync(join(asdfShims, "npm"), `#!/bin/sh\n# asdf-plugin: nodejs ${process.versions.node}\nexec "${missingAsdfPath}" exec "npm" "$@"\n`, { mode: 0o755 });
      const missingAsdf = spawnSync(join(onlyNode, exe), [entry, "update", "--self"], {
        cwd: project, encoding: "utf8", timeout: 60_000,
        env: { ...cliEnv(["/usr/bin", "/bin"], asdfShims), ASDF_DATA_DIR: asdfData, NODE_OPTIONS: undefined },
      });
      assert.equal(missingAsdf.status, 1, missingAsdf.stdout + missingAsdf.stderr);
      assert.match(missingAsdf.stderr, /missing-asdf-dir\/asdf/);
      writeGoAsdfShim();

      const nonExecNpm = join(root, "non-exec-npm");
      writeFileSync(nonExecNpm, "#!/bin/sh\nexit 0\n", { mode: 0o644 });
      const fallbackShimCalls = join(root, "fallback-shim-calls");
      writeFileSync(join(asdfShims, "npm"), `#!/bin/sh
# asdf-plugin: nodejs ${process.versions.node}
exec asdf exec "npm" "$@"
`, { mode: 0o755 });
      writeFileSync(asdfExe, `#!/bin/sh
case "$1:$2" in
  which:npm)
    if [ -n "$ASDF_TEST_SLEEP" ]; then exec /bin/sleep "$ASDF_TEST_SLEEP"; fi
    printf '%b' "$ASDF_TEST_WHICH_OUT"
    exit 0 ;;
  exec:npm)
    printf '%s\\n' "$PWD" >> ${JSON.stringify(fallbackShimCalls)}
    shift 2
    exec ${JSON.stringify(cli)} "$@" ;;
  *) exit 2 ;;
esac
`, { mode: 0o755 });
      for (const [label, extraEnv] of [
        ["timeout", { ASDF_TEST_SLEEP: "3" }],
        ["relative", { ASDF_TEST_WHICH_OUT: "relative/bin/npm\\n" }],
        ["multiline", { ASDF_TEST_WHICH_OUT: `${join(asdfInstall, "bin", "npm")}\\n${join(asdfInstall, "bin", "npm")}\\n` }],
        ["non-executable", { ASDF_TEST_WHICH_OUT: `${nonExecNpm}\\n` }],
      ] as const) {
        rmSync(fallbackShimCalls, { force: true });
        const fallbackRes = spawnSync(join(onlyNode, exe), [entry, "update", "--check"], {
          cwd: project, encoding: "utf8", timeout: 60_000,
          env: { ...asdfBaseEnv, NODE_OPTIONS: undefined, ...extraEnv },
        });
        assert.equal(fallbackRes.status, 0, `${label}: ${fallbackRes.stdout}${fallbackRes.stderr}`);
        assert.deepEqual(readFileSync(fallbackShimCalls, "utf8").trim().split(/\r?\n/), [parse(root).root],
          `${label} falls back to running the original shim from the isolated directory`);
      }

      // Non-asdf npm wrapper on PATH is untouched and never consults asdf.
      const customNpmDir = join(root, "custom-npm-bin");
      mkdirSync(customNpmDir, { recursive: true });
      const customNpmLog = join(root, "custom-npm-calls");
      writeFileSync(join(customNpmDir, "npm"), `#!/bin/sh\nprintf '%s\\n' "$PWD" >> ${JSON.stringify(customNpmLog)}\nexec ${JSON.stringify(cli)} "$@"\n`, { mode: 0o755 });
      writeAsdfExe();
      rmSync(asdfCalls, { force: true });
      const nonAsdfRes = spawnSync(join(onlyNode, exe), [entry, "update", "--check"], {
        cwd: project, encoding: "utf8", timeout: 60_000,
        env: { ...cliEnv(asdfExtra, customNpmDir), ASDF_DATA_DIR: asdfData, NODE_OPTIONS: undefined },
      });
      assert.equal(nonAsdfRes.status, 0, nonAsdfRes.stdout + nonAsdfRes.stderr);
      assert.equal(readFileSync(customNpmLog, "utf8").trim(), parse(root).root, "non-asdf npm wrapper runs directly from /");
      assert.throws(() => readFileSync(asdfCalls), { code: "ENOENT" }, "non-asdf npm never invokes asdf");

      const compatibleAsdf = spawnSync(join(onlyNode, exe), [entry, "update", "--self"], {
        cwd: project, encoding: "utf8", timeout: 60_000, env: asdfBaseEnv,
      });
      assert.equal(compatibleAsdf.status, 0, compatibleAsdf.stdout + compatibleAsdf.stderr);
      assert.match(compatibleAsdf.stdout, /Registry latest:/);
      assert.deepEqual(recordedLaunches().at(-1), {
        node: realpathSync(join(asdfInstall, "bin", "node")), cwd: parse(root).root, pathHead: join(asdfInstall, "bin"),
      }, "project-selected asdf npm uses its compatible Node when Cotal's Node does not satisfy npm's range");

      const release = claimGlobalNpmUpdateLock(root);
      try {
        for (const installName of ["asdf runtime", "asdf:runtime"]) {
          const customInstall = join(root, installName);
          mkdirSync(join(customInstall, "bin"), { recursive: true });
          symlinkSync(cli, join(customInstall, "bin", "npm"));
          writeFileSync(join(project, ".tool-versions"), `${customInstall}\n`);
          const childEnv = { ...asdfBaseEnv, NODE_OPTIONS: undefined };
          const childFile = join(onlyNode, exe), childArgs = [entry, "update", "--check"];
          for (const launch of [() => runGlobalProcess(root, "reconcile", childFile, childArgs, childEnv), () => runProcess(childFile, childArgs, childEnv)]) {
            const child = await npmProjectDirectory.run(project, () => launch());
            assert.equal(child.status, 0, child.stdout + child.stderr);
            assert.deepEqual(recordedLaunches().at(-1), {
              node: realpathSync(join(onlyNode, exe)), cwd: parse(root).root, pathHead: onlyNode,
            }, `reconcile and update children retain the resolved asdf npm from ${installName}`);
          }
        }
      } finally { release(); }

      // Real seedOne reconciliation cell: drive `runSeed` (`seed/reconcile.ts:seedOne` -> `ext add` child)
      // from `/` under `npmProjectDirectory.run(project, ...)` with an asdf npm shim and unset global asdf.
      {
        const seedSandbox = join(root, "seed-reconcile-cell");
        const seedXdg = join(seedSandbox, "config"), seedHome = join(seedSandbox, "home"), seedCotal = join(seedSandbox, "cotal");
        const seedInstall = join(seedSandbox, "asdf-install"), seedNpmLog = join(seedSandbox, "seed-npm.jsonl");
        const seedEntry = join(repoBin, "dist", "cotal.js");
        for (const dir of [seedXdg, seedHome, seedCotal, join(seedInstall, "bin")]) {
          mkdirSync(dir, { recursive: true, mode: 0o700 });
        }
        const seedNpm = join(seedInstall, "bin", "npm"), seedNpmRoot = join(seedInstall, "lib", "node_modules", "npm"), seedNpmCli = join(seedNpmRoot, "bin", "npm-cli.js");
        mkdirSync(dirname(seedNpmCli), { recursive: true });
        writeFileSync(join(seedNpmRoot, "package.json"), JSON.stringify({ name: "npm", bin: { npm: "bin/npm-cli.js" }, engines: { node: process.version } }));
        writeFileSync(seedNpmCli, `#!/usr/bin/env node
const fs = require("node:fs"), path = require("node:path");
const args = process.argv.slice(2);
const pIdx = args.indexOf("--prefix");
const prefix = pIdx >= 0 ? args[pIdx + 1] : "";
const spec = args.filter((a, i) => !a.startsWith("-") && i !== pIdx + 1)[1];
fs.appendFileSync(${JSON.stringify(seedNpmLog)}, JSON.stringify({ node: process.execPath, cwd: process.cwd(), cmd: args[0], hasUpdateNpm: Object.prototype.hasOwnProperty.call(process.env, "COTAL_UPDATE_NPM") }) + "\\n");
if (args[0] === "install" && prefix && spec) {
  const meta = JSON.parse(fs.readFileSync(path.join(spec, "package.json"), "utf8"));
  const dest = path.join(prefix, "node_modules", ...meta.name.split("/"));
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.cpSync(spec, dest, { recursive: true });
  const rootPkgPath = path.join(prefix, "package.json");
  const rootPkg = fs.existsSync(rootPkgPath) ? JSON.parse(fs.readFileSync(rootPkgPath, "utf8")) : { dependencies: {} };
  rootPkg.dependencies = { ...rootPkg.dependencies, [meta.name]: "file:" + path.relative(prefix, spec) };
  fs.writeFileSync(rootPkgPath, JSON.stringify(rootPkg, null, 2) + "\\n");
}
`, { mode: 0o755 });
        symlinkSync(seedNpmCli, seedNpm);
        writeFileSync(join(project, ".tool-versions"), `${seedInstall}\n`);
        const seedReconcileUrl = pathToFileURL(join(import.meta.dirname, "../dist/seed/reconcile.js")).href;
        const npmInvocationUrl = pathToFileURL(join(import.meta.dirname, "../dist/lib/npm-invocation.js")).href;
        const seedDriver = join(seedSandbox, "drive-seed.mjs");
        writeFileSync(seedDriver, `
process.argv[1] = ${JSON.stringify(seedEntry)};
const { npmProjectDirectory } = await import(${JSON.stringify(npmInvocationUrl)});
const { runSeed } = await import(${JSON.stringify(seedReconcileUrl)});
await npmProjectDirectory.run(${JSON.stringify(project)}, () => runSeed({}));
`);
        const seedRun = spawnSync(join(onlyNode, exe), [seedDriver], {
          cwd: parse(root).root, encoding: "utf8", timeout: 60_000,
          env: {
            ...asdfBaseEnv, NODE_OPTIONS: undefined,
            HOME: seedHome, USERPROFILE: seedHome, COTAL_HOME: seedCotal, XDG_CONFIG_HOME: seedXdg,
            COTAL_SKIP_CONNECTOR_SEED: undefined,
          },
        });
        assert.equal(seedRun.status, 0, `seedOne reconcile cell failed:\n${seedRun.stdout}\n${seedRun.stderr}`);
        assert.match(seedRun.stdout, /connectors reconciled.*seeded claude/);
        const seedEvents = readFileSync(seedNpmLog, "utf8").trim().split(/\r?\n/).map(line => JSON.parse(line));
        const installEvents = seedEvents.filter(event => event.cmd === "install");
        assert.equal(installEvents.length, SEED_BUILTINS.length);
        for (const event of seedEvents) {
          assert.equal(event.node, realpathSync(join(onlyNode, exe)));
          assert.equal(event.cwd, parse(root).root);
          assert.equal(event.hasUpdateNpm, false, "COTAL_UPDATE_NPM is stripped before npm runs");
        }
      }
    }
    const updated = run("--self");
    assert.equal(updated.status, 0, updated.stdout + updated.stderr);
    assert.match(updated.stdout, /Registry latest:/);
    assert.deepEqual(readFileSync(entry), before);
    const projectNode = process.platform === "win32" ? join(onlyNode, exe) : process.execPath;
    assert.equal(realpathSync(recordedLaunches().at(-1)!.node), realpathSync(projectNode), "npm can succeed on the project Node even when its declared range excludes it");
    if (process.platform !== "win32") {
      for (const [dir, name] of [["native:tools", "node"], ["native-tools", `node-${process.versions.node}`]]) {
        const cwd = join(root, dir), node = join(cwd, name);
        mkdirSync(cwd);
        copyFileSync(process.execPath, node);
        symlinkSync(cli, join(cwd, "npm"));
        const update = run("--self", [], npmBin, cwd, node);
        assert.equal(update.status, 0, `${node}\n${update.stdout}${update.stderr}`);
        assert.match(update.stdout, /Registry latest:/);
        assert.equal(recordedLaunches().at(-1)!.node, realpathSync(node));
        assert.equal(recordedLaunches().at(-1)!.cwd, parse(root).root, "npm still runs outside the caller's project");
      }
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
}

await npmNodeEngine();
if (process.platform !== "win32") {
  const home = mkdtempSync(join(tmpdir(), "cotal-update-cwd-"));
  try {
    const gone = join(home, "gone");
    mkdirSync(gone);
    const repoBin = join(import.meta.dirname, "../../../bin");
    const entry = [process.execPath, join(repoBin, "dist/cotal.js")];
    if (process.platform === "linux") {
      const prefix = join(home, "prefix"), installed = join(prefix, "lib/node_modules/cotal-ai");
      const launcher = join(prefix, "bin/cotal"), pinScript = "scripts/pin-npm-node.cjs";
      for (const directory of [join(prefix, "bin"), join(installed, "dist"), join(installed, "scripts")]) {
        mkdirSync(directory, { recursive: true });
      }
      copyFileSync(join(repoBin, "package.json"), join(installed, "package.json"));
      copyFileSync(join(repoBin, pinScript), join(installed, pinScript));
      symlinkSync(entry[1]!, join(installed, "dist/cotal.js"));
      symlinkSync("../lib/node_modules/cotal-ai/dist/cotal.js", launcher);
      const pin = spawnSync(process.execPath, [join(installed, pinScript)], { cwd: home, env: Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^cotal_/i.test(key))), encoding: "utf8" });
      assert.equal(pin.status, 0, pin.stdout + pin.stderr);
      assert.equal(readlinkSync(launcher), "../lib/node_modules/cotal-ai/dist/cotal-npm");
      if (readFileSync(launcher, "utf8").startsWith("#!/usr/bin/env -S ")) entry.splice(0, entry.length, launcher);
    }
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(?:cotal_|npm_config_)/i.test(key)));
    const result = spawnSync("/bin/sh", ["-c", 'cd "$1" && rmdir "$1" && shift && "$@" update --self && "$@" update --self', "sh", gone,
      ...entry], {
      cwd: home, encoding: "utf8", timeout: 180_000,
      env: { ...env, HOME: home, USERPROFILE: home, COTAL_HOME: join(home, "cotal"), XDG_CONFIG_HOME: join(home, "xdg"),
        COTAL_TELEMETRY: "off", COTAL_NO_UPDATE_CHECK: "1", COTAL_ALLOW_CHECKOUT_SEED: "1" },
    });
    assert.equal(result.status, 0, `plain self-update and retry run from an already removed folder: ${result.stdout}\n${result.stderr}`);
    assert.doesNotMatch(result.stdout + result.stderr, /getcwd\(\) failed|this folder no longer exists|update preflight failed|registry cannot be reached/i,
      "removed cwd does not refuse update or masquerade as unavailable registry metadata");
    assert.match(result.stdout, /Registry latest:/, "the actual updater completed its registry check");
    mkdirSync(join(home, ".cotal"));
    mkdirSync(gone);
    const during = await new Promise<{ status: number | null; output: string; removed: boolean }>((resolve, reject) => {
      const child = spawn("/bin/sh", ["-c", 'cd "$1" && shift && "$@" update --self && "$@" update --self', "sh", gone,
        ...entry], {
        cwd: home, env: { ...env, HOME: home, USERPROFILE: home, COTAL_HOME: join(home, "cotal"), XDG_CONFIG_HOME: join(home, "xdg"),
          COTAL_TELEMETRY: "off", COTAL_NO_UPDATE_CHECK: "1", COTAL_ALLOW_CHECKOUT_SEED: "1" },
      });
      let output = "", removed = false;
      const timer = setTimeout(() => child.kill("SIGTERM"), 180_000);
      child.stdout.on("data", chunk => {
        output += chunk.toString();
        if (!removed && /Built-in connectors|installed package closure is current/.test(output)) {
          rmdirSync(gone);
          removed = true;
        }
      });
      child.stderr.on("data", chunk => { output += chunk.toString(); });
      child.once("error", error => { clearTimeout(timer); reject(error); });
      child.once("close", status => { clearTimeout(timer); resolve({ status, output, removed }); });
    });
    assert.equal(during.removed, true, `remove the original folder after plain update begins: ${during.output}`);
    assert.equal(during.status, 0, during.output);
    assert.doesNotMatch(during.output, /getcwd\(\) failed|this folder no longer exists|update preflight failed|registry cannot be reached/i);
  } finally { rmSync(home, { recursive: true, force: true }); }
}
emitSentinel({ passed: counted.cells(), failed: 0 });
