import "./update-isolation.js";
import strictAssert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, realpathSync, renameSync, rmdirSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, parse } from "node:path";
import { pathToFileURL } from "node:url";
import { claimGlobalNpmUpdateLock, processGroupMembers, processStartToken, readProcessCommand, recoveryProcessStartToken, withWindowsUpdateIdentity } from "@cotal-ai/workspace";
import { countedAssert, emitSentinel } from "../../../bin/smoke/sentinel.mjs";
import { executeUpdate, updateRuntime, type UpdateRuntime } from "../src/commands/update.js";
import { collectUpdateCaches } from "../src/commands/update-caches.js";
import { installedUpdatePrefix, npmChildGate, posixGateScriptPath, releaseChildGate, runGlobalProcess, runNpm, runNpmAsync, runProcess } from "../src/commands/update-process.js";
import { npmInvocation, npmProjectDirectory, npmUpdateChildEnvironment } from "../src/lib/npm-invocation.js";
import { SEED_BUILTINS } from "../src/seed/paths.js";
import { repairRuntimeEntry } from "./update-runtime-entry.smoke.js";
const counted = countedAssert(strictAssert);
const assert: typeof strictAssert = counted.assert as typeof strictAssert;
let skippedCells = 0;
function skipCell(name: string, why: string): void {
  skippedCells += 1;
  console.log(`  - skipped: ${name} (${why})`);
}
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
{
  // A registry that accepts the connection and never answers is the same outcome as one that refuses it.
  // The fixture runs in its own process: this cell waits on the CLI with spawnSync, which would
  // otherwise stop the in-process server from accepting the lookup. Each invocation has its own
  // home and runtime directory, so a daemon left on the machine cannot fail continuity first.
  const home = mkdtempSync(join(tmpdir(), "cotal-update-hang-"));
  const fixture = join(home, "registry.mjs");
  writeFileSync(fixture, `import { createServer } from "node:http";
    import { appendFileSync } from "node:fs";
    const mode = process.argv[2];
    const log = process.argv[3];
    const server = createServer((request, response) => {
      const url = request.url ?? "";
      appendFileSync(log, url + "\\n");
      const path = decodeURIComponent(url.split("?")[0]);
      const scoped = path.includes("@cotal-ai/");
      if (mode === "silent" || (mode === "scoped-meta" && scoped) || path.includes("9.9.9")) return;
      const name = scoped ? "@cotal-ai/core" : "cotal-ai";
      const version = { name, version: "9.9.9", dist: { tarball: "http://" + request.headers.host + "/" + (scoped ? "core" : "cotal-ai") + "-9.9.9.tgz", integrity: "sha512-aaaa" }, ...(scoped ? {} : { dependencies: { "@cotal-ai/core": "9.9.9" } }) };
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ name, "dist-tags": { latest: "9.9.9" }, versions: { "9.9.9": version } }));
    });
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("no loopback port");
      process.stdout.write(String(address.port) + "\\n");
    });
  `);
  const servers: ReturnType<typeof spawn>[] = [];
  const registry = (mode: "silent" | "partial" | "scoped-meta") => new Promise<number>((resolve, reject) => {
    const log = join(home, `${mode}.log`);
    writeFileSync(log, "");
    const child = spawn(process.execPath, [fixture, mode, log], { stdio: ["ignore", "pipe", "pipe"] });
    servers.push(child);
    let port = "";
    let error = "";
    child.stdout.on("data", (chunk: Buffer) => { port += chunk.toString(); });
    child.stderr.on("data", (chunk: Buffer) => { error += chunk.toString(); });
    child.once("error", reject);
    child.once("exit", code => reject(new Error(`registry fixture exited ${code}: ${error}`)));
    child.stdout.once("data", () => {
      const parsed = Number(port.trim());
      if (!Number.isInteger(parsed)) reject(new Error(`registry fixture port: ${port}`));
      else resolve(parsed);
    });
  });
  try {
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(?:cotal_|npm_config_)/i.test(key)));
    const update = (port: number, mode: string) => {
      const root = join(home, mode);
      mkdirSync(join(root, "runtime"), { recursive: true, mode: 0o700 });
      return spawnSync(process.execPath, [join(import.meta.dirname, "../../../bin/dist/cotal.js"), "update", "--self"], {
        cwd: root, encoding: "utf8", timeout: 90_000,
        env: { ...env, HOME: root, USERPROFILE: root, COTAL_HOME: join(root, "cotal"),
          XDG_CONFIG_HOME: join(root, "config"), XDG_RUNTIME_DIR: join(root, "runtime"),
          LOCALAPPDATA: join(root, "local"), APPDATA: join(root, "roaming"),
          npm_config_cache: join(root, "npm-cache"), npm_config_userconfig: join(root, "user.npmrc"),
          npm_config_registry: `http://127.0.0.1:${port}`,
          COTAL_TELEMETRY: "off", COTAL_NO_UPDATE_CHECK: "1", COTAL_SKIP_CONNECTOR_SEED: "1" },
      });
    };
    const version = update(await registry("silent"), "silent");
    assert.equal(version.status, 0, version.stdout + version.stderr);
    assert.equal(version.stdout.trim(), "The registry cannot be reached; nothing was changed.");
    assert.doesNotMatch(version.stderr, /FETCH_ERROR|version check failed|npm registry settings/);
    const archives = update(await registry("partial"), "partial");
    const partialRequests = readFileSync(join(home, "partial.log"), "utf8").trim().split("\n").filter(Boolean);
    assert.equal(archives.status, 0, archives.stdout + archives.stderr);
    assert.match(archives.stdout, /Checking cotal-ai@9\.9\.9 release archives/, `requests=${partialRequests.join(" ")}\n${archives.stdout}${archives.stderr}`);
    assert.match(archives.stdout, /The registry cannot be reached; nothing was changed\./);
    assert.doesNotMatch(archives.stdout + archives.stderr, /FETCH_ERROR|update preflight failed|@cotal-ai:registry|npm registry settings/);
    assert.ok(partialRequests.some(url => url.includes("9.9.9")), `archive reads name the version: ${partialRequests.join(" ")}`);
    assert.ok(partialRequests.some(url => url.includes("@cotal-ai") || url.includes("%40cotal-ai")), `archive checks read the scoped dependency: ${partialRequests.join(" ")}`);
    const scopedMeta = update(await registry("scoped-meta"), "scoped-meta");
    const scopedRequests = readFileSync(join(home, "scoped-meta.log"), "utf8").trim().split("\n").filter(Boolean);
    assert.equal(scopedMeta.status, 0, scopedMeta.stdout + scopedMeta.stderr + scopedRequests.join(" "));
    assert.match(scopedMeta.stdout, /Checking cotal-ai@9\.9\.9 release archives/, scopedRequests.join(" "));
    assert.match(scopedMeta.stdout, /The registry cannot be reached; nothing was changed\./);
    assert.doesNotMatch(scopedMeta.stdout + scopedMeta.stderr, /FETCH_ERROR|update preflight failed|@cotal-ai:registry|npm registry settings/);
    assert.ok(scopedRequests.some(url => url.includes("@cotal-ai") || url.includes("%40cotal-ai")), `scoped metadata reached the registry: ${scopedRequests.join(" ")}`);
  } finally {
    for (const child of servers) child.kill();
    rmSync(home, { recursive: true, force: true });
  }
}
const { seedInstallationCurrent } = await import("../src/seed/reconcile.js");
assert.equal(seedInstallationCurrent(), false, "an unseeded checkout is not proven current");
{
  const home = mkdtempSync(join(tmpdir(), "cotal-update-no-npm-"));
  try {
    const path = join(home, "node-only");
    mkdirSync(path);
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(?:cotal_|path$)/i.test(key)));
    let bareNode = process.execPath;
    if (process.platform !== "win32") {
      const bare = join(home, "bare-node");
      const installed = spawnSync(process.execPath, [join(dirname(dirname(realpathSync(process.execPath))), "lib", "node_modules", "npm", "bin", "npm-cli.js"), "install", "--prefix", bare, "--no-audit", "--no-fund", `node@${process.versions.node}`], {
        cwd: home, encoding: "utf8", timeout: 120_000, env: { ...env, PATH: process.env.PATH, HOME: home, npm_config_cache: join(home, "npm-cache") },
      });
      assert.equal(installed.status, 0, installed.stdout + installed.stderr);
      bareNode = join(bare, "node_modules", "node", "bin", "node");
    }
    if (process.platform === "win32") copyFileSync(process.execPath, join(path, "node.exe"));
    else symlinkSync(bareNode, join(path, "node"));
    for (const flags of [["--self"], ["--check"], ["--check", "--plain"], ["--check", "--json"]]) {
      const result = spawnSync(bareNode, [join(import.meta.dirname, "../../../bin/dist/cotal.js"), "update", ...flags], {
        cwd: home, encoding: "utf8", timeout: 30_000,
        env: { ...env, HOME: home, USERPROFILE: home, APPDATA: join(home, "config"), LOCALAPPDATA: join(home, "config"),
          COTAL_HOME: join(home, "cotal"), XDG_CONFIG_HOME: join(home, "config"), XDG_RUNTIME_DIR: home, PATH: path,
          COTAL_TELEMETRY: "off", COTAL_NO_UPDATE_CHECK: "1", COTAL_SKIP_CONNECTOR_SEED: "1" },
      });
      const output = result.stdout + result.stderr;
      assert.equal(result.status, flags[0] === "--self" ? 1 : 4, output);
      assert.match(output, /npm is not on PATH/);
      assert.match(output, /Install npm or add it to this command's PATH/);
      assert.doesNotMatch(output, /registry cannot be reached|Check registry access|Using the npm shipped with/);
      if (flags.includes("--json")) {
        const report = JSON.parse(result.stdout);
        assert.equal(report.warnings[0].code, "NPM_UNAVAILABLE");
        assert.equal(report.result.installationChanged, false);
      }
    }
    const sibling = join(home, "node-and-npm");
    mkdirSync(sibling);
    const nodeName = process.platform === "win32" ? "node.exe" : "node";
    const npmName = process.platform === "win32" ? "npm.cmd" : "npm";
    copyFileSync(process.execPath, join(sibling, nodeName));
    const privateEnv = {
      ...env, HOME: home, USERPROFILE: home, APPDATA: join(home, "config"), LOCALAPPDATA: join(home, "config"),
      COTAL_HOME: join(home, "cotal"), XDG_CONFIG_HOME: join(home, "config"), XDG_RUNTIME_DIR: home, PATH: path,
      COTAL_TELEMETRY: "off", COTAL_NO_UPDATE_CHECK: "1", COTAL_SKIP_CONNECTOR_SEED: "1",
    };
    const runNode = (node: string, args: string[], timeout = 30_000) => spawnSync(node, [join(import.meta.dirname, "../../../bin/dist/cotal.js"), ...args], {
      cwd: home, encoding: "utf8", timeout, env: privateEnv,
    });
    if (process.platform === "win32") {
      writeFileSync(join(sibling, npmName), '@node "%~dp0node_modules\\npm\\bin\\npm-cli.js" %*\r\n');
      const windowsSibling = runNode(join(sibling, nodeName), ["update", "--check"]);
      const windowsOut = windowsSibling.stdout + windowsSibling.stderr;
      assert.equal(windowsSibling.status, 4, windowsOut);
      assert.match(windowsOut, /npm is not on PATH/);
      assert.match(windowsOut, /Install npm or add it to this command's PATH/);
    } else {
      const impostor = join(sibling, "impostor");
      writeFileSync(impostor, "#!/bin/sh\nprintf '%s\\n' IMPOSTOR-NOT-NPM\n", { mode: 0o755 });
      symlinkSync(impostor, join(sibling, npmName));
      const refused = runNode(join(sibling, nodeName), ["update", "--check"]);
      const refusedOut = refused.stdout + refused.stderr;
      assert.equal(refused.status, 4, refusedOut);
      assert.match(refusedOut, /npm is not on PATH/);
      assert.match(refusedOut, /Install npm or add it to this command's PATH/);
      assert.doesNotMatch(refusedOut, /IMPOSTOR-NOT-NPM/);
      rmSync(join(sibling, npmName));
      const runtime = join(home, "runtime");
      const runtimeBin = join(runtime, "bin");
      const runtimeNode = join(runtimeBin, "node");
      const bundledCli = join(runtime, "lib", "node_modules", "npm", "bin", "npm-cli.js");
      mkdirSync(runtimeBin, { recursive: true });
      mkdirSync(dirname(bundledCli), { recursive: true });
      copyFileSync(process.execPath, runtimeNode);
      const seen = join(home, "bundled-npm-seen");
      writeFileSync(join(runtime, "lib", "node_modules", "npm", "package.json"), JSON.stringify({ name: "npm", bin: { npm: "bin/npm-cli.js" }, engines: { node: process.version } }));
      writeFileSync(bundledCli, [
        "#!/usr/bin/env node",
        `require("node:fs").writeFileSync(${JSON.stringify(seen)}, "bundled" + String.fromCharCode(10) + process.argv[1]);`,
        "console.log(JSON.stringify(\"9.9.9\"));",
        "",
      ].join("\n"), { mode: 0o755 });
      const runtimeLink = join(home, "runtime-link");
      symlinkSync(runtime, runtimeLink);
      const viaBundled = runNode(join(runtimeLink, "bin", "node"), ["update", "--check"], 60_000);
      const bundledOut = viaBundled.stdout + viaBundled.stderr;
      assert.equal(viaBundled.status, 0, bundledOut);
      assert.match(bundledOut, /Registry latest:\s+9\.9\.9/);
      assert.match(bundledOut, /Using the npm shipped with/);
      assert.doesNotMatch(bundledOut, /Install npm or add it to this command's PATH/);
      assert.equal(readFileSync(seen, "utf8").trim(), `bundled\n${bundledCli}`, "the npm shipped with the running Node is the one that answers");
      rmSync(seen);
      const pathSeen = join(home, "path-npm-seen");
      const pathNpm = join(home, "path-npm");
      mkdirSync(pathNpm);
      writeFileSync(join(pathNpm, "npm"), `#!/bin/sh
printf '%s\n' PATH-NPM > ${JSON.stringify(pathSeen)}
printf '%s\n' '"8.8.8"'
`, { mode: 0o755 });
      const pathRun = spawnSync(join(runtimeLink, "bin", "node"), [join(import.meta.dirname, "../../../bin/dist/cotal.js"), "update", "--check"], {
        cwd: home, encoding: "utf8", timeout: 60_000, env: { ...privateEnv, PATH: `${pathNpm}${delimiter}${path}` },
      });
      const pathOut = pathRun.stdout + pathRun.stderr;
      assert.equal(pathRun.status, 0, pathOut);
      assert.match(pathOut, /Registry latest:\s+8\.8\.8/, "an unrecognised npm on PATH is the one that answers");
      assert.equal(readFileSync(pathSeen, "utf8").trim(), "PATH-NPM");
      assert.doesNotMatch(pathOut, /Using the npm shipped with/);
      assert.equal(existsSync(seen), false, "the bundled package does not answer for an unrecognised PATH npm");
      const unsupported = join(home, "unsupported-npm");
      const unsupportedRoot = join(unsupported, "node_modules", "corepack");
      const unsupportedCli = join(unsupportedRoot, "dist", "npm.js");
      mkdirSync(dirname(unsupportedCli), { recursive: true });
      writeFileSync(join(unsupportedRoot, "package.json"), JSON.stringify({ name: "corepack", engines: { node: process.version } }));
      writeFileSync(unsupportedCli, `#!/usr/bin/env node
if (process.argv.includes("--version")) {
  console.error("npm warn cli npm v12.2.3 does not support Node.js " + process.version + ". This version of npm supports the following node versions: \`>=99\`");
  console.log("12.2.3");
  process.exit(0);
}
require("node:fs").writeFileSync(${JSON.stringify(seen)}, "unsupported" + String.fromCharCode(10) + process.argv[1]);
process.exit(1);
`, { mode: 0o755 });
      symlinkSync(unsupportedCli, join(unsupported, "npm"));
      const unsupportedRun = spawnSync(join(runtimeLink, "bin", "node"), [join(import.meta.dirname, "../../../bin/dist/cotal.js"), "update", "--check"], {
        cwd: home, encoding: "utf8", timeout: 60_000, env: { ...privateEnv, PATH: `${unsupported}${delimiter}${path}` },
      });
      const unsupportedOut = unsupportedRun.stdout + unsupportedRun.stderr;
      assert.equal(unsupportedRun.status, 0, unsupportedOut);
      assert.match(unsupportedOut, /Registry latest:\s+9\.9\.9/);
      assert.match(unsupportedOut, /Using the npm shipped with/);
      assert.equal(readFileSync(seen, "utf8").trim(), `bundled\n${bundledCli}`, "an npm that reports this Node unsupported does not answer");
      assert.equal(unsupportedOut.split("Using the npm shipped with").length - 1, 1, "the notice is printed once");
      symlinkSync(bundledCli, join(runtimeBin, "npm"));
      const direct = spawnSync(runtimeNode, [bundledCli, "view", "cotal-ai@latest", "version", "--json"], {
        cwd: home, encoding: "utf8", timeout: 60_000, env: { ...privateEnv, PATH: `${runtimeBin}${delimiter}${path}` },
      });
      const selected = spawnSync(join(runtimeLink, "bin", "node"), [join(import.meta.dirname, "../../../bin/dist/cotal.js"), "update", "--check"], {
        cwd: home, encoding: "utf8", timeout: 60_000, env: { ...privateEnv, PATH: `${runtimeBin}${delimiter}${path}` },
      });
      assert.equal(direct.status, 0, direct.stdout + direct.stderr);
      assert.match(direct.stdout, /9\.9\.9/);
      assert.equal(selected.status, 0, selected.stdout + selected.stderr);
      assert.match(selected.stdout, /Registry latest:\s+9\.9\.9/, "a usable npm on PATH keeps the registry answer");
      assert.doesNotMatch(selected.stdout + selected.stderr, /Using the npm shipped with/);
      const recorded = readFileSync(seen, "utf8").trim().split("\n").at(-1);
      assert.equal(recorded === undefined ? "" : realpathSync(recorded), realpathSync(bundledCli), "the PATH npm, not another package, answers");
    }
  } finally { rmSync(home, { recursive: true, force: true }); }
}
const { registryArrivalCell, registryArrivalSkippedCount } = await import("../../../bin/smoke/update-registry-arrival.smoke.mjs");
const cacheUpdate = await registryArrivalCell({ scenario: "cache" });
assert.equal(cacheUpdate.code, 0, "real CLI and npm update succeed with a user-owned cache that is not writable");
if (["linux", "darwin"].includes(process.platform)) {
  const lifecycleUpdate = await registryArrivalCell({ scenario: "version-named-node" });
  assert.equal(lifecycleUpdate.code, 0, lifecycleUpdate.output);
  const gateEnvUpdate = await registryArrivalCell({ scenario: "gate-env" });
  assert.equal(gateEnvUpdate.code, 0, gateEnvUpdate.output);
  await assertPosixChildGate();
} else {
  skipCell("POSIX update gate cells", `POSIX only; running on ${process.platform}`);
}

async function assertPosixChildGate(): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "cotal-gate-env-"));
  const stubBin = join(root, "bin"), archiveCache = join(root, "archive-cache");
  const globalRoot = join(root, "global-modules"), staging = join(root, "staging"), eqDir = join(root, "eq=dir");
  for (const dir of [stubBin, archiveCache, globalRoot, staging, eqDir]) mkdirSync(dir, { recursive: true, mode: 0o700 });
  symlinkSync(process.execPath, join(stubBin, "node"));
  // Non-Node shell fd probe proves fds 3 and 4 independently of Node's own internal descriptors:
  // first verify the probe positively detects open fds 3 and 4 when inherited, then use real fstatSync
  // and /proc/self/fd checks in the stand-in target.
  const rawFdProbe = join(root, "raw-fd-probe");
  writeFileSync(rawFdProbe, `#!/bin/sh
open=""
for fd in 3 4; do
  if ( : <&"$fd" ) 2>/dev/null; then open="\${open}\${open:+,}\${fd}"; fi
done
printf '%s' "$open"
`, { mode: 0o755 });
  const positiveLeak = spawnSync(rawFdProbe, [], { stdio: ["ignore", "pipe", "pipe", "pipe", "pipe"] });
  assert.equal(positiveLeak.status, 0);
  assert.equal(positiveLeak.stdout.toString("utf8"), "3,4", "raw fd probe must positively detect inherited fds 3 and 4");

  const probeScript = `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const cp = require("node:child_process");
if (process.env.SMOKE_SPAWN_DETACHED_SLEEPER) {
  const sleeper = cp.spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  fs.writeFileSync(process.env.SMOKE_SPAWN_DETACHED_SLEEPER, String(sleeper.pid));
}
if (process.env.SMOKE_RAN_MARKER) fs.writeFileSync(process.env.SMOKE_RAN_MARKER, String(process.pid));
if (process.env.SMOKE_HOLD_UNTIL) {
  while (!fs.existsSync(process.env.SMOKE_HOLD_UNTIL)) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 15);
  }
}
if (process.env.SMOKE_SELF_SIGNAL) {
  process.kill(process.pid, process.env.SMOKE_SELF_SIGNAL);
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500);
}
if (process.env.SMOKE_EXIT_CODE !== undefined) process.exit(Number(process.env.SMOKE_EXIT_CODE));
let pgid = null;
if (process.platform === "linux") {
  const stat = fs.readFileSync("/proc/self/stat", "utf8");
  const tail = stat.slice(stat.lastIndexOf(")") + 2).trim().split(" ");
  pgid = Number(tail[2]);
} else {
  const out = cp.spawnSync("ps", ["-o", "pgid=", "-p", String(process.pid)], { encoding: "utf8" });
  if (out.status === 0) pgid = Number(out.stdout.trim());
}
const sameGroupAsGate = pgid !== null && (pgid === process.pid || pgid === process.ppid);
const checkDir = process.env.SMOKE_WORKER_DIR || process.env.npm_config_cache || "";
const workerBeforeStart = checkDir ? (fs.existsSync(path.join(checkDir, ".worker-" + process.pid)) || fs.existsSync(path.join(checkDir, ".worker-" + process.ppid))) : false;
let liveRecord = null;
if (process.env.SMOKE_GLOBAL_ROOT) {
  try { liveRecord = JSON.parse(fs.readFileSync(path.join(process.env.SMOKE_GLOBAL_ROOT, ".cotal-update-child"), "utf8")); } catch {}
}
const stdinText = process.env.SMOKE_READ_STDIN ? fs.readFileSync(0, "utf8") : "";
const keys = JSON.parse(process.env.SMOKE_KEYS || "[]");
const picked = Object.fromEntries(keys.map(k => [k, process.env[k]]));
const openGateFds = [];
for (const fd of [3, 4]) {
  try {
    const st = fs.fstatSync(fd);
    if (st.isFIFO() || st.isSocket()) openGateFds.push(fd);
  } catch {}
}
process.stdout.write(JSON.stringify({
  pid: process.pid, ppid: process.ppid, pgid, argv: process.argv.slice(2), execArgv: process.execArgv,
  nodeOptionsLoaded: Boolean(globalThis.__cotalSmokeNodeOptLoaded),
  nodeOptionsEnv: process.env.NODE_OPTIONS ?? null,
  stdinText, sameGroupAsGate, workerBeforeStart, liveRecord, picked, openGateFds,
}));
`;
  writeFileSync(join(stubBin, "npm"), probeScript, { mode: 0o755 });
  const eqCmd = join(eqDir, "probe=cmd");
  writeFileSync(eqCmd, probeScript, { mode: 0o755 });
  const nonExecCmd = join(root, "non-exec-cmd");
  writeFileSync(nonExecCmd, "#!/bin/sh\nexit 0\n", { mode: 0o600 });
  const cSignalSrc = join(root, "die-sig.c"), cSignalBin = join(root, "die-sig");
  writeFileSync(cSignalSrc, [
    "#include <signal.h>",
    "#include <stdlib.h>",
    "#include <string.h>",
    "#include <unistd.h>",
    "int main(int argc, char **argv) {",
    "  int sig = SIGTERM;",
    "  if (argc > 1) {",
    '    if (strcmp(argv[1], "SIGPIPE") == 0) sig = SIGPIPE;',
    '    else if (strcmp(argv[1], "SIGXFSZ") == 0) sig = SIGXFSZ;',
    '    else if (strcmp(argv[1], "SIGUSR1") == 0) sig = SIGUSR1;',
    '    else if (strcmp(argv[1], "SIGKILL") == 0) sig = SIGKILL;',
    "  }",
    "  signal(sig, SIG_DFL);",
    "  kill(getpid(), sig);",
    "  _exit(0);",
    "}",
  ].join("\n"));
  const ccBuild = spawnSync("cc", ["-O2", cSignalSrc, "-o", cSignalBin], { encoding: "utf8" });
  const hasNativeSignalBin = ccBuild.status === 0;
  const ccSkipWhy = (ccBuild.error as NodeJS.ErrnoException | undefined)?.code === "ENOENT"
    ? "cc is not on PATH"
    : `cc exited ${ccBuild.status ?? "null"}: ${(ccBuild.stderr || "").trim() || "build failed"}`;
  const waitPidGone = async (pid: number | undefined, start?: string): Promise<void> => {
    if (pid === undefined || pid <= 1) return;
    for (let deadline = Date.now() + 5_000; Date.now() < deadline; ) {
      try {
        process.kill(pid, 0);
        if (start !== undefined && processStartToken(pid) !== start) return;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ESRCH") return;
      }
      await new Promise(resolve => setTimeout(resolve, 15));
    }
  };
  const nodeOptPreload = join(root, "node-opt-preload.cjs");
  writeFileSync(nodeOptPreload, "globalThis.__cotalSmokeNodeOptLoaded = true;\n");

  const secretNeedle = "COTAL_SECRET_SENTINEL_9f81c2e4";
  const tricky: Record<string, string> = {
    "npm_config_//127.0.0.1:4873/:_authToken": `-lead-${secretNeedle}\nline2'single"double$(echo bad)\`bad\`*`,
    "npm_config_@cotal-ai:registry": "https://127.0.0.1:4874/\n'\"-scope",
    "npm_config_strict-ssl": "false",
    "npm_config_https-proxy": `-http://user:${secretNeedle}@proxy'"example:8080`,
  };
  const keysJson = JSON.stringify(Object.keys(tricky));
  const baseEnv = Object.fromEntries(
    Object.entries(process.env).filter(([k]) => !k.startsWith("COTAL_") && /^[A-Za-z_][A-Za-z0-9_]*$/.test(k) && k !== "NODE_OPTIONS"),
  );

  // Positive control on probeScript's openGateFds: spawning probeScript directly with pipe fds 3 and 4 MUST report [3, 4].
  const positiveProbe = spawnSync(process.execPath, [eqCmd], {
    env: { ...baseEnv }, stdio: ["ignore", "pipe", "pipe", "pipe", "pipe"],
  });
  assert.equal(positiveProbe.status, 0, positiveProbe.stderr?.toString("utf8"));
  assert.deepEqual(JSON.parse(positiveProbe.stdout.toString("utf8")).openGateFds, [3, 4], "openGateFds must detect Node socketpair stdio pipes on fds 3 and 4");

  const mainPermitGate = 'IFS= read -r permit <&3 && [ "$permit" = run ] || exit 1; exec 3<&-; exec "$@"';
  // Identifier-only launch equals main: exact file, args, env object identity, no payload, no groupCleanup, direct exec pid/ppid.
  const idOnlyEnv: NodeJS.ProcessEnv = { ...baseEnv, PATH: `${stubBin}${delimiter}${baseEnv.PATH ?? ""}`, SMOKE_KEYS: "[]" };
  const idOnlyLaunch = npmChildGate("cotal-id-only", eqCmd, ["plain-arg"], idOnlyEnv);
  assert.equal(idOnlyLaunch.file, "/bin/sh");
  assert.deepEqual(idOnlyLaunch.args, ["-c", mainPermitGate, "cotal-id-only", eqCmd, "plain-arg"]);
  assert.equal(idOnlyLaunch.env, idOnlyEnv, "identifier-only env keeps the exact env object reference");
  assert.equal(idOnlyLaunch.envPayload, undefined);
  assert.equal(idOnlyLaunch.groupCleanup, undefined);
  {
    const idChild = spawn(idOnlyLaunch.file, idOnlyLaunch.args, {
      env: idOnlyLaunch.env, detached: true, stdio: ["ignore", "pipe", "pipe", "pipe"],
    });
    let idOut = "";
    idChild.stdout?.on("data", chunk => { idOut += chunk.toString(); });
    releaseChildGate(idChild, true, idOnlyLaunch.envPayload, cause => { throw cause; }, idOnlyLaunch.groupCleanup);
    assert.equal(await new Promise<number | null>(resolve => idChild.once("close", resolve)), 0, idOut);
    const idReport = JSON.parse(idOut);
    assert.equal(idReport.pid, idChild.pid, "identifier-only gate execs target in place with the published pid");
    assert.equal(idReport.ppid, process.pid, "identifier-only gate preserves the CLI as direct parent");
    assert.deepEqual(idReport.openGateFds, []);
    await waitPidGone(idChild.pid);
  }

  // Review 2 Finding 1: with identifier-only names, a refused .cotal-update-child marker throws out of
  // runGlobalProcess (as on main) rather than returning { status: null } and entering repairReplacement.
  {
    const refusedRoot = join(root, "refused-marker-global");
    mkdirSync(join(refusedRoot, "cotal-ai", "dist"), { recursive: true, mode: 0o700 });
    writeFileSync(join(refusedRoot, "cotal-ai", "package.json"), JSON.stringify({ name: "cotal-ai", version: "0.183.0", bin: { cotal: "dist/cotal.js" } }), { mode: 0o600 });
    writeFileSync(join(refusedRoot, "cotal-ai", "dist", "cotal.js"), "console.log('ok');\n", { mode: 0o700 });
    const markerPath = join(realpathSync(refusedRoot), ".cotal-update-child");
    const writeRefusedMarker = () => writeFileSync(markerPath, JSON.stringify({
      phase: "ambiguous", owner: process.pid, nonce: "deadbeefcafebabe01234567", operation: "global install", reason: "simulated marker",
    }), { mode: 0o600 });
    writeRefusedMarker();
    await assert.rejects(
      () => runGlobalProcess(refusedRoot, "install", "npm", ["install"], { ...baseEnv }, false),
      /global install ended ambiguously \(simulated marker;/,
      "beginGlobalUpdateChild refusal with identifier-only names must reject spawnGlobal as on main",
    );
    rmSync(markerPath, { force: true });

    const refusedSubHome = join(root, "refused-cli-home");
    for (const sub of ["home", "cotal", "config/cotal", "runtime", "tmp"]) mkdirSync(join(refusedSubHome, sub), { recursive: true, mode: 0o700 });
    const refusedCallsFile = join(root, "refused-spawn-calls.json");
    const refusedRunner = join(refusedRoot, "cotal-ai", "refused-cli-runner.mjs");
    const cliCommandUrl = pathToFileURL(join(import.meta.dirname, "../dist/command.js")).href;
    const cliIndexUrl = pathToFileURL(join(import.meta.dirname, "../dist/index.js")).href;
    const cliUpdateUrl = pathToFileURL(join(import.meta.dirname, "../dist/commands/update.js")).href;
    const coreDistUrl = pathToFileURL(join(import.meta.dirname, "../../../packages/core/dist/index.js")).href;
    writeFileSync(refusedRunner, [
      `import { writeFileSync } from "node:fs";`,
      `import { registry } from ${JSON.stringify(coreDistUrl)};`,
      `import ${JSON.stringify(cliIndexUrl)};`,
      `import { runCli } from ${JSON.stringify(cliCommandUrl)};`,
      `import { updateRuntime } from ${JSON.stringify(cliUpdateUrl)};`,
      `const calls = [];`,
      `const origSpawnGlobal = updateRuntime.spawnGlobal;`,
      `Object.assign(updateRuntime, {`,
      `  version: () => "0.183.0",`,
      `  checkout: () => true,`,
      `  installPrefix: () => undefined,`,
      `  preflightReplacement: async () => {},`,
      `  reportRunningManager: async () => "none",`,
      `  extensions: () => [],`,
      `  npm: (args) => args[0] === "view" ? { status: 0, stdout: '"99.0.0"\\n', stderr: "" } : args[0] === "root" ? { status: 0, stdout: ${JSON.stringify(`${realpathSync(refusedRoot)}\n`)}, stderr: "" } : { status: 0, stdout: "", stderr: "" },`,
      `  npmAsync: async (args) => args[0] === "view" ? { status: 0, stdout: JSON.stringify({ name: "cotal-ai", version: args[1].endsWith("@99.0.0") ? "99.0.0" : "0.183.0", dependencies: {}, dist: { tarball: "http://127.0.0.1:1/pkg.tgz", integrity: "sha512-AA==" } }), stderr: "" } : { status: 0, stdout: "", stderr: "" },`,
      `  prepareReplacement: async () => {`,
      `    writeFileSync(${JSON.stringify(markerPath)}, JSON.stringify({ phase: "ambiguous", owner: process.pid, nonce: "deadbeefcafebabe01234567", operation: "global install", reason: "simulated marker" }), { mode: 0o600 });`,
      `    return async () => {};`,
      `  },`,
      `  spawnGlobal: async (...a) => { calls.push(a[1]); writeFileSync(${JSON.stringify(refusedCallsFile)}, JSON.stringify(calls)); return origSpawnGlobal(...a); },`,
      `});`,
      `await runCli(registry, ["update", "--self"]);`,
    ].join("\n"), { mode: 0o700 });
    const refusedCli = spawnSync(process.execPath, [refusedRunner], {
      cwd: refusedSubHome,
      encoding: "utf8",
      env: {
        ...baseEnv,
        NO_COLOR: "1",
        HOME: join(refusedSubHome, "home"),
        COTAL_HOME: join(refusedSubHome, "cotal"),
        XDG_CONFIG_HOME: join(refusedSubHome, "config"),
        XDG_RUNTIME_DIR: join(refusedSubHome, "runtime"),
        TMPDIR: join(refusedSubHome, "tmp"),
        DO_NOT_TRACK: "1",
      },
    });
    assert.equal(refusedCli.status, 3, `refused marker CLI status must match main (3): ${refusedCli.stdout}\n${refusedCli.stderr}`);
    assert.equal(refusedCli.signal, null);
    assert.equal(existsSync(refusedCallsFile), true, `spawnGlobal was not reached: ${refusedCli.stdout}\n${refusedCli.stderr}`);
    assert.deepEqual(JSON.parse(readFileSync(refusedCallsFile, "utf8")), ["install"], "no repairReplacement retry or rollback attempt may run");
    const normLines = (s: string) => s.trim().split("\n").filter(Boolean).map(l => l.replace(/\(\d+\.\d+ s\)/g, "(<t>)"));
    assert.deepEqual(normLines(refusedCli.stdout), [
      "Checking cotal-ai@99.0.0 release archives",
      "Checking installed extension dependencies for 99.0.0",
      "Checking cotal-ai@0.183.0 recovery archives",
      "✓ release archives checked (<t>)",
      "Saving update recovery snapshot",
      "✓ recovery snapshot saved (<t>)",
      "cotal-ai binary",
      "installing cotal-ai@99.0.0 into npm's global installation; this 0.183.0 process remains loaded until the verified global copy takes over",
    ], "identifier-only refused marker stdout lines match main with no global install finished or repair lines");
    assert.deepEqual(refusedCli.stderr.trim().split("\n").filter(Boolean), [
      "Outcome unconfirmed",
      `  global install ended ambiguously (simulated marker; ${markerPath}) - if no descendant process is running, remove the marker and retry`,
      "  Outcome: unknown",
      "  Code:    OPERATION_UNKNOWN",
    ], "identifier-only refused marker stderr lines match main with no repairReplacement output");
  }

  const savedEnv = new Map<string, string | undefined>();
  const patchKeys = ["PATH", "SMOKE_WORKER_DIR", "SMOKE_KEYS", "SMOKE_EXIT_CODE", "NODE_OPTIONS", ...Object.keys(tricky)];
  for (const key of patchKeys) savedEnv.set(key, process.env[key]);
  try {
    for (const k of Object.keys(process.env)) {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) {
        if (!savedEnv.has(k)) savedEnv.set(k, process.env[k]);
        delete process.env[k];
      }
    }
    process.env.PATH = `${stubBin}${delimiter}${baseEnv.PATH ?? ""}`;
    process.env.SMOKE_WORKER_DIR = archiveCache;
    process.env.SMOKE_KEYS = keysJson;
    process.env.NODE_OPTIONS = `--require ${JSON.stringify(nodeOptPreload)}`;
    Object.assign(process.env, tricky);
    const asyncResult = await runNpmAsync(["view", "-leading", "a'b\"c\nd"], archiveCache);
    assert.equal(asyncResult.status, 0, asyncResult.stderr || asyncResult.error);
    const asyncReport = JSON.parse(asyncResult.stdout);
    assert.equal(asyncReport.workerBeforeStart, true, "runNpmAsync publishes .worker-<pid> before npm starts");
    assert.equal(asyncReport.sameGroupAsGate, true, "runNpmAsync keeps detached process group");
    assert.deepEqual(asyncReport.argv, ["view", "-leading", "a'b\"c\nd"]);
    assert.deepEqual(asyncReport.picked, tricky);
    assert.equal(asyncReport.nodeOptionsLoaded, true, "stage forwards NODE_OPTIONS to spawned npm child without breaking stage");
    assert.deepEqual(asyncReport.openGateFds, []);
    process.env.SMOKE_EXIT_CODE = "1";
    assert.equal((await runNpmAsync(["view"], archiveCache)).status, 1, "runNpmAsync preserves exit status 1");
  } finally {
    for (const [key, value] of savedEnv) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
  const readGroupArgv = (pgid: number): string[] =>
    processGroupMembers(pgid).flatMap(pid => {
      const cmd = readProcessCommand(pid);
      return cmd.kind === "command" ? [cmd.command] : [];
    });
  try {
    const childEnv: NodeJS.ProcessEnv = {
      ...baseEnv, PATH: `${stubBin}${delimiter}${baseEnv.PATH ?? ""}`,
      SMOKE_GLOBAL_ROOT: globalRoot, SMOKE_KEYS: keysJson,
      NODE_OPTIONS: `--require ${JSON.stringify(nodeOptPreload)}`,
      ...tricky,
    };
    const globalResult = await runGlobalProcess(globalRoot, "install", "npm", ["install", "-leading", "x'y\"z\nw"], childEnv, false, false, staging);
    assert.equal(globalResult.status, 0, globalResult.stderr || globalResult.error);
    const globalReport = JSON.parse(globalResult.stdout);
    assert.equal(globalReport.sameGroupAsGate, true);
    assert.deepEqual(globalReport.argv, ["install", "-leading", "x'y\"z\nw"]);
    assert.deepEqual(globalReport.picked, tricky);
    assert.equal(globalReport.nodeOptionsLoaded, true);
    assert.deepEqual(globalReport.openGateFds, []);
    if (process.platform === "linux") {
      assert.equal(globalReport.liveRecord?.phase, "live");
      assert.equal(globalReport.workerBeforeStart, true, "runGlobalChild publishes .worker-<pid> before npm starts");
      assert(
        globalReport.liveRecord?.pid === globalReport.pid || globalReport.liveRecord?.pid === globalReport.ppid,
        "runGlobalChild marks the gate group leader live before permit",
      );
    }

    // Real reconcile child binding cell through runGlobalProcess("reconcile", process.execPath, [reconcileEntry, "update"], ...)
    // with non-identifier npm_config_* variables set, plus direct npmChildGate under both dash and bash.
    const cliDistUrl = pathToFileURL(join(import.meta.dirname, "../dist/commands/update.js")).href;
    const workspaceDistUrl = pathToFileURL(join(import.meta.dirname, "../../../packages/workspace/dist/index.js")).href;
    const reconcileEntry = join(root, "reconcile-entry.mjs");
    writeFileSync(reconcileEntry, [
      `import { fstatSync, writeFileSync } from "node:fs";`,
      `import { executeUpdate, updateRuntime } from ${JSON.stringify(cliDistUrl)};`,
      `import { inspectGlobalUpdateChild } from ${JSON.stringify(workspaceDistUrl)};`,
      `const keys = JSON.parse(process.env.SMOKE_KEYS ?? "[]");`,
      `const picked = {};`,
      `for (const k of keys) picked[k] = k in process.env ? process.env[k] : null;`,
      `const openGateFds = [];`,
      `for (const fd of [3, 4]) { try { const st = fstatSync(fd); if (st.isFIFO() || st.isSocket()) openGateFds.push(fd); } catch {} }`,
      `const custody = process.platform === "linux" && process.env.SMOKE_GLOBAL_ROOT ? inspectGlobalUpdateChild(process.env.SMOKE_GLOBAL_ROOT) : undefined;`,
      `let reconciled = false;`,
      `const code = await executeUpdate(false, {`,
      `  ...updateRuntime,`,
      `  env: process.env,`,
      `  pid: process.pid,`,
      `  parentPid: process.ppid,`,
      `  version: () => "99.0.0",`,
      `  reconcile: async () => { reconciled = true; },`,
      `  refreshConnectors: async () => {},`,
      `  refreshClients: async () => [],`,
      `  reportRunningManager: async () => "none",`,
      `  waitForInstalledGeneration: async () => {},`,
      `  extensions: () => [],`,
      `  claimUpdatePass: () => () => {},`,
      `});`,
      `if (process.env.SMOKE_RECONCILE_REPORT) {`,
      `  writeFileSync(process.env.SMOKE_RECONCILE_REPORT, JSON.stringify({`,
      `    code, reconciled, pid: process.pid, ppid: process.ppid, execArgv: process.execArgv,`,
      `    picked, openGateFds, nodeOptionsLoaded: Boolean(globalThis.__cotalSmokeNodeOptLoaded),`,
      `    nodeOptionsEnv: process.env.NODE_OPTIONS ?? null,`,
      `    custodyPid: custody?.child?.pid ?? null, custodyPhase: custody?.child?.phase ?? null,`,
      `  }));`,
      `}`,
      `process.exit(code);`,
    ].join("\n"), { mode: 0o700 });
    const reconcileHome = join(root, "reconcile-home");
    for (const sub of ["home", "cotal", "config", "runtime", "tmp"]) mkdirSync(join(reconcileHome, sub), { recursive: true, mode: 0o700 });
    const reconcileReportPath = join(root, "reconcile-global-report.json");
    const reconcileEnv: NodeJS.ProcessEnv = {
      ...baseEnv,
      HOME: join(reconcileHome, "home"),
      COTAL_HOME: join(reconcileHome, "cotal"),
      XDG_CONFIG_HOME: join(reconcileHome, "config"),
      XDG_RUNTIME_DIR: join(reconcileHome, "runtime"),
      TMPDIR: join(reconcileHome, "tmp"),
      COTAL_SKIP_CONNECTOR_SEED: "1",
      COTAL_NO_UPDATE_CHECK: "1",
      COTAL_TELEMETRY: "off",
      DO_NOT_TRACK: "1",
      COTAL_UPDATE_TARGET_VERSION: "99.0.0",
      COTAL_UPDATE_PARENT: String(process.pid),
      COTAL_UPDATE_PARENT_WAITS: "1",
      SMOKE_KEYS: keysJson,
      SMOKE_GLOBAL_ROOT: globalRoot,
      SMOKE_RECONCILE_REPORT: reconcileReportPath,
      NODE_OPTIONS: `--require ${JSON.stringify(nodeOptPreload)}`,
      ...tricky,
    };
    const releaseGlobalLock = claimGlobalNpmUpdateLock(globalRoot);
    let reconcileRun;
    try {
      reconcileRun = await runGlobalProcess(globalRoot, "reconcile", process.execPath, [reconcileEntry, "update"], reconcileEnv, false);
    } finally {
      releaseGlobalLock();
    }
    assert.equal(reconcileRun.status, 0, `reconcile child must bind to CLI parent pid even with non-identifier env:\n${reconcileRun.stderr}\n${reconcileRun.stdout}\n${reconcileRun.error ?? ""}`);
    assert.doesNotMatch(reconcileRun.stderr, /invalid global update child binding/);
    const reconcileReport = JSON.parse(readFileSync(reconcileReportPath, "utf8"));
    assert.equal(reconcileReport.code, 0);
    assert.equal(reconcileReport.reconciled, true);
    assert.equal(reconcileReport.ppid, process.pid, "runGlobalProcess reconcile child keeps CLI parent pid");
    assert.deepEqual(reconcileReport.execArgv, [], "runGlobalProcess reconcile child strips gate --import from execArgv");
    assert.deepEqual(reconcileReport.picked, tricky, "runGlobalProcess reconcile child preserves all non-identifier env vars");
    assert.deepEqual(reconcileReport.openGateFds, [], "runGlobalProcess reconcile child closes gate fds");
    assert.equal(reconcileReport.nodeOptionsLoaded, true, "runGlobalProcess reconcile child executes caller NODE_OPTIONS");
    assert.equal(reconcileReport.nodeOptionsEnv, reconcileEnv.NODE_OPTIONS, "runGlobalProcess reconcile child restores NODE_OPTIONS for grandchildren");
    if (process.platform === "linux") {
      assert.equal(reconcileReport.custodyPhase, "live");
      assert.equal(reconcileReport.custodyPid, reconcileReport.pid, "runGlobalProcess custody marker records exact reconcile child pid");
    } else {
      skipCell("Linux .cotal-update-child gate custody assertions", `runGlobalChild gates only on Linux; running on ${process.platform}`);
    }

    // Built CLI pins its own dist/commands/update-posix-gate.js once before custody into a private 0600
    // update-posix-gate.mjs in the update's private scratch (removed at update end), so replacing the package
    // tree's built helper between install and reconcile still completes the update with non-identifier names preserved.
    {
      const replaceRoot = join(root, "replace-helper-global");
      mkdirSync(join(replaceRoot, "cotal-ai", "dist"), { recursive: true, mode: 0o700 });
      writeFileSync(join(replaceRoot, "cotal-ai", "package.json"), JSON.stringify({ name: "cotal-ai", version: "0.183.0", bin: { cotal: "dist/cotal.js" } }), { mode: 0o600 });
      const replaceEntry = join(replaceRoot, "cotal-ai", "dist", "cotal.js");
      copyFileSync(reconcileEntry, replaceEntry);
      const replaceReportPath = join(root, "replace-helper-reconcile.json");
      const replaceMetaPath = join(root, "replace-helper-meta.json");
      const replaceHome = join(root, "replace-helper-home");
      for (const sub of ["home", "cotal", "config/cotal", "runtime", "tmp"]) mkdirSync(join(replaceHome, sub), { recursive: true, mode: 0o700 });
      const replaceCliPkg = join(root, "replace-cli-pkg");
      mkdirSync(replaceCliPkg, { recursive: true, mode: 0o700 });
      cpSync(join(import.meta.dirname, "../dist"), join(replaceCliPkg, "dist"), { recursive: true });
      copyFileSync(join(import.meta.dirname, "../package.json"), join(replaceCliPkg, "package.json"));
      symlinkSync(join(import.meta.dirname, "../node_modules"), join(replaceCliPkg, "node_modules"));
      if (existsSync(join(import.meta.dirname, "../cotal-skills"))) {
        symlinkSync(join(import.meta.dirname, "../cotal-skills"), join(replaceCliPkg, "cotal-skills"));
      }
      const builtTreeHelper = join(replaceCliPkg, "dist", "commands", "update-posix-gate.js");
      assert.equal(existsSync(builtTreeHelper), true, "built dist/commands/update-posix-gate.js must exist");
      const savedHelperBytes = readFileSync(builtTreeHelper);
      const shDrops = spawnSync(
        "/bin/sh",
        ["-c", 'exec "$@"', "probe", process.execPath, "-e", 'process.exit(process.env["cotal_gate_probe:1"] === "1" ? 0 : 1)'],
        { env: { "cotal_gate_probe:1": "1" }, stdio: "ignore" },
      ).status !== 0;
      const replaceRunner = join(replaceRoot, "cotal-ai", "replace-helper-runner.mjs");
      const coreDistUrl = pathToFileURL(join(import.meta.dirname, "../../../packages/core/dist/index.js")).href;
      const pkgIndexUrl = pathToFileURL(join(replaceCliPkg, "dist/index.js")).href;
      const pkgCommandUrl = pathToFileURL(join(replaceCliPkg, "dist/command.js")).href;
      const pkgUpdateUrl = pathToFileURL(join(replaceCliPkg, "dist/commands/update.js")).href;
      const pkgProcessUrl = pathToFileURL(join(replaceCliPkg, "dist/commands/update-process.js")).href;
      writeFileSync(replaceRunner, [
        `import assert from "node:assert/strict";`,
        `import { existsSync, lstatSync, writeFileSync } from "node:fs";`,
        `import { join } from "node:path";`,
        `import { registry } from ${JSON.stringify(coreDistUrl)};`,
        `import ${JSON.stringify(pkgIndexUrl)};`,
        `import { runCli } from ${JSON.stringify(pkgCommandUrl)};`,
        `import { updateRuntime } from ${JSON.stringify(pkgUpdateUrl)};`,
        `import { posixGateScriptPath, runGlobalProcess } from ${JSON.stringify(pkgProcessUrl)};`,
        `assert.equal(posixGateScriptPath(), ${JSON.stringify(realpathSync(builtTreeHelper))}, "unpinned built CLI helper resolves dist/commands/update-posix-gate.js");`,
        `let observedScratch = "", observedPinned = "", pinnedChecked = false, helperSabotaged = false;`,
        `Object.assign(updateRuntime, {`,
        `  version: () => "0.183.0",`,
        `  checkout: () => true,`,
        `  installPrefix: () => undefined,`,
        `  preflightReplacement: async () => {},`,
        `  reportRunningManager: async () => "none",`,
        `  waitForInstalledGeneration: async () => {},`,
        `  extensions: () => [],`,
        `  npm: (args) => args[0] === "view" ? { status: 0, stdout: '"99.0.0"\\n', stderr: "" } : args[0] === "root" ? { status: 0, stdout: ${JSON.stringify(`${realpathSync(replaceRoot)}\n`)}, stderr: "" } : { status: 0, stdout: "", stderr: "" },`,
        `  npmAsync: async (args) => args[0] === "view" ? { status: 0, stdout: JSON.stringify({ name: "cotal-ai", version: args[1].endsWith("@99.0.0") ? "99.0.0" : "0.183.0", dependencies: {}, dist: { tarball: "http://127.0.0.1:1/pkg.tgz", integrity: "sha512-AA==" } }), stderr: "" } : { status: 0, stdout: "", stderr: "" },`,
        `  spawnGlobal: async (r, op, f, a, e, inh, verb, stg) => {`,
        `    if (op === "install") {`,
        `      observedScratch = process.env.TMPDIR ?? "";`,
        `      observedPinned = join(observedScratch, "update-posix-gate.mjs");`,
        `      if (${JSON.stringify(shDrops)}) {`,
        `        assert.equal(posixGateScriptPath(), observedPinned, "active scratch scope pins built .js helper to update-posix-gate.mjs");`,
        `        assert.equal(existsSync(observedPinned), true, "built .mjs helper copy pinned in update scratch before custody");`,
        `        assert.equal(lstatSync(observedPinned).mode & 0o777, 0o600, "pinned .mjs helper copy in scratch must be mode 0600");`,
        `        pinnedChecked = true;`,
        `      }`,
        `      const installRes = await runGlobalProcess(r, op, process.execPath, ["-e", ${JSON.stringify(`require("node:fs").writeFileSync(${JSON.stringify(join(replaceRoot, "cotal-ai", "package.json"))}, JSON.stringify({ name: "cotal-ai", version: "99.0.0", bin: { cotal: "dist/cotal.js" } }))`)}], e, false, verb, stg);`,
        `      writeFileSync(${JSON.stringify(builtTreeHelper)}, 'process.stderr.write("REPLACED_PACKAGE_TREE_HELPER_RAN\\\\n"); process.exit(99);\\n', { mode: 0o600 });`,
        `      helperSabotaged = true;`,
        `      return installRes;`,
        `    }`,
        `    return runGlobalProcess(r, op, f, a, e, inh, verb, stg);`,
        `  },`,
        `});`,
        `await runCli(registry, ["update", "--self"]);`,
        `writeFileSync(${JSON.stringify(replaceMetaPath)}, JSON.stringify({ runnerPid: process.pid, observedScratch, observedPinned, pinnedChecked, helperSabotaged }));`,
      ].join("\n"), { mode: 0o700 });
      const replaceCli = spawnSync(process.execPath, [replaceRunner], {
        cwd: replaceHome,
        encoding: "utf8",
        env: {
          ...baseEnv,
          NO_COLOR: "1",
          PATH: `${stubBin}${delimiter}${baseEnv.PATH ?? ""}`,
          HOME: join(replaceHome, "home"),
          COTAL_HOME: join(replaceHome, "cotal"),
          XDG_CONFIG_HOME: join(replaceHome, "config"),
          XDG_RUNTIME_DIR: join(replaceHome, "runtime"),
          TMPDIR: join(replaceHome, "tmp"),
          DO_NOT_TRACK: "1",
          COTAL_TELEMETRY: "off",
          COTAL_NO_UPDATE_CHECK: "1",
          COTAL_SKIP_CONNECTOR_SEED: "1",
          SMOKE_KEYS: keysJson,
          SMOKE_GLOBAL_ROOT: replaceRoot,
          SMOKE_RECONCILE_REPORT: replaceReportPath,
          NODE_OPTIONS: `--require ${JSON.stringify(nodeOptPreload)}`,
          ...tricky,
        },
      });
      assert.equal(replaceCli.status, 0, `built CLI update with replaced dist/commands/update-posix-gate.js failed:\n${replaceCli.stderr}\n${replaceCli.stdout}`);
      assert.equal(replaceCli.signal, null);
      assert(!replaceCli.stderr.includes("REPLACED_PACKAGE_TREE_HELPER_RAN"), "reconcile must run pinned scratch .mjs helper, never replaced dist/commands/update-posix-gate.js");
      const meta = JSON.parse(readFileSync(replaceMetaPath, "utf8")) as {
        runnerPid: number; observedScratch: string; observedPinned: string; pinnedChecked: boolean; helperSabotaged: boolean;
      };
      assert.equal(meta.helperSabotaged, true, "built package-tree helper was replaced between install and reconcile");
      assert.match(meta.observedPinned, /\/update-posix-gate\.mjs$/, "pinned helper filename is built update-posix-gate.mjs");
      if (shDrops) assert.equal(meta.pinnedChecked, true, "verified 0600 pinned update-posix-gate.mjs before custody");
      const rep = JSON.parse(readFileSync(replaceReportPath, "utf8"));
      assert.equal(rep.code, 0);
      assert.equal(rep.reconciled, true);
      assert.equal(rep.ppid, meta.runnerPid);
      assert.deepEqual(rep.picked, tricky, "built CLI update completed with non-identifier names preserved after dist helper replacement");
      if (meta.observedPinned) assert.equal(existsSync(meta.observedPinned), false, "pinned 0600 .mjs helper copy removed at end of update");
      if (meta.observedScratch) assert.equal(existsSync(meta.observedScratch), false, "private update scratch removed at end of update");

      // Also prove collectUpdateCaches reclaims an aged interrupted cotal-update-* scratch that still holds a 0600
      // pinned update-posix-gate.mjs alongside node-compile-cache, while keeping one whose helper is group-writable.
      const agedParent = mkdtempSync(join(root, "aged-scratch-"));
      const makeScratchWithPinnedGate = (gateMode: number) => {
        const s = mkdtempSync(join(agedParent, "cotal-update-"));
        const cc = join(s, "node-compile-cache");
        mkdirSync(cc, { mode: 0o700 });
        const ccEntry = join(cc, "compiled");
        writeFileSync(ccEntry, "cache", { mode: 0o600 });
        const gateCopy = join(s, "update-posix-gate.mjs");
        writeFileSync(gateCopy, savedHelperBytes, { mode: gateMode });
        const old = new Date(Date.now() - 61 * 60_000);
        for (const p of [ccEntry, cc, gateCopy, s]) {
          chmodSync(p, p === gateCopy ? gateMode : p === ccEntry ? 0o600 : 0o700);
          utimesSync(p, old, old);
        }
        return s;
      };
      const reclaimableScratch = makeScratchWithPinnedGate(0o600);
      const sharedGateScratch = makeScratchWithPinnedGate(0o640);
      collectUpdateCaches(agedParent);
      assert.equal(existsSync(reclaimableScratch), false, "collectUpdateCaches reclaims aged scratch with 0600 pinned helper");
      if (process.getuid) assert.equal(existsSync(sharedGateScratch), true, "collectUpdateCaches retains scratch with non-0600 helper");
    }

    const candidateShells = ["/bin/sh", "/bin/dash", "/usr/bin/dash", "/bin/bash", "/usr/bin/bash"];
    const seenReal = new Set<string>();
    const shells = candidateShells.filter(s => {
      if (!existsSync(s)) return false;
      const real = realpathSync(s);
      if (seenReal.has(real) && s !== "/bin/sh") return false;
      seenReal.add(real);
      return true;
    });
    const shellsWithDisposition = shells.map(sh => ({
      sh,
      shPreserves: spawnSync(
        sh,
        ["-c", 'exec "$@"', "probe", process.execPath, "-e", 'process.exit(process.env["cotal_gate_probe:1"] === "1" ? 0 : 1)'],
        { env: { "cotal_gate_probe:1": "1" }, stdio: "ignore" },
      ).status === 0,
    }));
    if (!shellsWithDisposition.some(entry => !entry.shPreserves)) {
      skipCell("non-identifier-dropping shell gate cells", "no dash or other non-identifier-dropping shell is installed on this host");
    }
    if (!shellsWithDisposition.some(entry => entry.shPreserves)) {
      skipCell("non-identifier-preserving shell gate cells", "no bash or other non-identifier-preserving shell is installed on this host");
    }
    for (const { sh, shPreserves } of shellsWithDisposition) {

      // Finding 2: where the shell preserves non-identifier names (e.g. bash), npmChildGate MUST return main's exact gate unchanged.
      const shellCheckEnv: NodeJS.ProcessEnv = { ...baseEnv, PATH: `${stubBin}${delimiter}${baseEnv.PATH ?? ""}`, ...tricky };
      const shellCheckLaunch = npmChildGate("cotal-shell-check", eqCmd, ["arg1"], shellCheckEnv, sh);
      if (shPreserves) {
        assert.equal(shellCheckLaunch.file, sh);
        assert.deepEqual(shellCheckLaunch.args, ["-c", mainPermitGate, "cotal-shell-check", eqCmd, "arg1"], `${sh} preserves non-identifiers so main's gate must be used unchanged`);
        assert.equal(shellCheckLaunch.env, shellCheckEnv);
        assert.equal(shellCheckLaunch.envPayload, undefined);
        assert.equal(shellCheckLaunch.groupCleanup, undefined);
      } else {
        assert(shellCheckLaunch.envPayload !== undefined, `${sh} drops non-identifiers so fd 4 payload must be used`);
        assert.equal(shellCheckLaunch.groupCleanup, true);
      }

      // Finding 1 + 2 + 6: real reconcile child + own Node child under both dash and bash keeps exact pid === child.pid and ppid === process.pid.
      const nodeOwnLaunch = npmChildGate("cotal-reconcile-own", process.execPath, [eqCmd, "own-node-arg"], {
        ...baseEnv, PATH: `${stubBin}${delimiter}${baseEnv.PATH ?? ""}`, SMOKE_KEYS: keysJson,
        NODE_OPTIONS: `--require ${JSON.stringify(nodeOptPreload)}`,
        ...tricky,
      }, sh, "reconcile");
      assert.equal(nodeOwnLaunch.groupCleanup, undefined, `own Node child never uses a middle stage under ${sh}`);
      {
        const ownStdio = nodeOwnLaunch.envPayload ? ["ignore", "pipe", "pipe", "pipe", "pipe"] as const : ["ignore", "pipe", "pipe", "pipe"] as const;
        const ownChild = spawn(nodeOwnLaunch.file, nodeOwnLaunch.args, { env: nodeOwnLaunch.env, detached: true, stdio: [...ownStdio] });
        let ownOut = "";
        ownChild.stdout?.on("data", chunk => { ownOut += chunk.toString(); });
        releaseChildGate(ownChild, true, nodeOwnLaunch.envPayload, cause => { throw cause; }, nodeOwnLaunch.groupCleanup);
        assert.equal(await new Promise<number | null>(resolve => ownChild.once("close", resolve)), 0, ownOut);
        const ownReport = JSON.parse(ownOut);
        assert.equal(ownReport.pid, ownChild.pid, `own Node child keeps published pid under ${sh}`);
        assert.equal(ownReport.ppid, process.pid, `own Node child keeps launching process as direct ppid under ${sh}`);
        assert.deepEqual(ownReport.argv, ["own-node-arg"]);
        assert.deepEqual(ownReport.execArgv, [], `own Node child strips gate --import from execArgv under ${sh}`);
        assert.deepEqual(ownReport.picked, tricky);
        assert.equal(ownReport.nodeOptionsEnv, `--require ${JSON.stringify(nodeOptPreload)}`);
        assert.deepEqual(ownReport.openGateFds, []);
        await waitPidGone(ownChild.pid);
      }

      // Real executeUpdate reconcile child bound to `process.pid` under `sh` (dash and bash).
      {
        const shRecReportPath = join(root, `reconcile-sh-${shells.indexOf(sh)}.json`);
        const shRecEnv = { ...reconcileEnv, SMOKE_GLOBAL_ROOT: "", SMOKE_RECONCILE_REPORT: shRecReportPath };
        const recLaunch = npmChildGate("cotal-reconcile-real", process.execPath, [reconcileEntry, "update"], shRecEnv, sh, "reconcile");
        const recStdio = recLaunch.envPayload ? ["ignore", "pipe", "pipe", "pipe", "pipe"] as const : ["ignore", "pipe", "pipe", "pipe"] as const;
        const recChild = spawn(recLaunch.file, recLaunch.args, { env: recLaunch.env, detached: true, stdio: [...recStdio] });
        let recOut = "", recErr = "";
        recChild.stdout?.on("data", chunk => { recOut += chunk.toString(); });
        recChild.stderr?.on("data", chunk => { recErr += chunk.toString(); });
        releaseChildGate(recChild, true, recLaunch.envPayload, cause => { throw cause; }, recLaunch.groupCleanup);
        const recStatus = await new Promise<number | null>(resolve => recChild.once("close", resolve));
        assert.equal(recStatus, 0, `real reconcile child failed under ${sh}:\n${recErr}\n${recOut}`);
        assert.doesNotMatch(recErr, /invalid global update child binding/);
        const shRecReport = JSON.parse(readFileSync(shRecReportPath, "utf8"));
        assert.equal(shRecReport.reconciled, true, `real executeUpdate reconciled under ${sh}`);
        assert.equal(shRecReport.pid, recChild.pid, `real executeUpdate kept published pid under ${sh}`);
        assert.equal(shRecReport.ppid, process.pid, `real executeUpdate kept CLI parent pid under ${sh}`);
        assert.deepEqual(shRecReport.picked, tricky, `real executeUpdate preserved non-identifier env under ${sh}`);
        assert.deepEqual(shRecReport.execArgv, [], `real executeUpdate stripped gate --import under ${sh}`);
        assert.deepEqual(shRecReport.openGateFds, [], `real executeUpdate closed gate fds under ${sh}`);
        await waitPidGone(recChild.pid);
      }

      // Raw non-Node shell fd check under sh: neither fd 3 nor fd 4 is open in target.
      {
        const rawLaunch = npmChildGate("cotal-raw-fd", rawFdProbe, [], { ...baseEnv, ...tricky }, sh);
        const rawStdio = rawLaunch.envPayload ? ["ignore", "pipe", "pipe", "pipe", "pipe"] as const : ["ignore", "pipe", "pipe", "pipe"] as const;
        const rawChild = spawn(rawLaunch.file, rawLaunch.args, { env: rawLaunch.env, detached: true, stdio: [...rawStdio] });
        let rawOut = "";
        rawChild.stdout?.on("data", chunk => { rawOut += chunk.toString(); });
        releaseChildGate(rawChild, true, rawLaunch.envPayload, cause => { throw cause; }, rawLaunch.groupCleanup);
        assert.equal(await new Promise<number | null>(resolve => rawChild.once("close", resolve)), 0);
        assert.equal(rawOut, "", `non-Node target must not inherit fd 3 or fd 4 under ${sh}, got ${JSON.stringify(rawOut)}`);
        await waitPidGone(rawChild.pid);
      }

      // Denied/EOF permit cell: target never starts, exit status 1.
      for (const permitted of [false, true] as const) {
        const ranMarker = join(root, `denied-${permitted ? "badtok" : "eof"}-${shells.indexOf(sh)}`);
        const launch = npmChildGate("cotal-gate-smoke", eqCmd, ["should-not-run"], {
          ...baseEnv, PATH: `${stubBin}${delimiter}${baseEnv.PATH ?? ""}`, SMOKE_RAN_MARKER: ranMarker, ...tricky,
        }, sh);
        for (const arg of launch.args) assert(!arg.includes(secretNeedle), `launch.args exposed secret under ${sh}`);
        if (!shPreserves) {
          for (const val of Object.values(launch.env)) assert(!String(val ?? "").includes(secretNeedle), `shell env exposed non-identifier secret`);
        }
        const stdio = launch.envPayload ? ["ignore", "pipe", "pipe", "pipe", "pipe"] as const : ["ignore", "pipe", "pipe", "pipe"] as const;
        const child = spawn(launch.file, launch.args, { env: launch.env, detached: true, stdio: [...stdio] });
        if (!permitted) {
          releaseChildGate(child, false, launch.envPayload, () => {}, launch.groupCleanup);
        } else {
          (child.stdio[4] as import("node:stream").Writable | undefined)?.end();
          (child.stdio[3] as import("node:stream").Writable).end("refuse\n");
        }
        const status = await new Promise<number | null>(resolve => child.once("close", resolve));
        assert.equal(status, 1, `refused/closed permit under ${sh} must exit 1`);
        assert.equal(existsSync(ranMarker), false, `refused/closed permit under ${sh} must not start target`);
        await waitPidGone(child.pid);
      }

      // Review 2 Finding 5: truncated or absent fd 4 payload in both stage and preload must exit 1 without starting
      // target and print exactly one stderr line `<label>: gate environment unreadable` with no values.
      if (!shPreserves) {
        for (const mode of ["npm", "reconcile"] as const) {
          for (const corruption of ["truncated", "absent"] as const) {
            const truncMarker = join(root, `trunc-${mode}-${corruption}-${shells.indexOf(sh)}`);
            const target = mode === "reconcile" ? process.execPath : eqCmd;
            const truncArgs = mode === "reconcile" ? [eqCmd, "should-not-run"] : ["should-not-run"];
            const truncLaunch = npmChildGate("cotal-gate-trunc", target, truncArgs, {
              ...baseEnv, PATH: `${stubBin}${delimiter}${baseEnv.PATH ?? ""}`, SMOKE_RAN_MARKER: truncMarker, ...tricky,
            }, sh, mode);
            assert(truncLaunch.envPayload && truncLaunch.envPayload.length > 6);
            const truncChild = spawn(truncLaunch.file, truncLaunch.args, {
              env: truncLaunch.env, detached: true, stdio: ["ignore", "pipe", "pipe", "pipe", "pipe"],
            });
            let truncErr = "";
            truncChild.stderr?.on("data", chunk => { truncErr += chunk.toString(); });
            if (corruption === "truncated") {
              const truncatedBytes = truncLaunch.envPayload.subarray(0, truncLaunch.envPayload.length - 3);
              releaseChildGate(truncChild, true, truncatedBytes, () => {}, truncLaunch.groupCleanup);
            } else {
              (truncChild.stdio[4] as import("node:stream").Writable).end();
              (truncChild.stdio[3] as import("node:stream").Writable).end("run\n");
            }
            const truncCode = await new Promise<number | null>(resolve => truncChild.once("close", resolve));
            assert.equal(truncCode, 1, `${corruption} payload (${mode}) under ${sh} must exit 1`);
            assert.equal(existsSync(truncMarker), false, `${corruption} payload (${mode}) under ${sh} must not run target`);
            assert.equal(truncErr, "cotal-gate-trunc: gate environment unreadable\n", `${corruption} payload (${mode}) must print one diagnostic line with label and no values`);
            assert(!truncErr.includes(secretNeedle), "unreadable payload stderr must never leak secret");
            await waitPidGone(truncChild.pid);
          }
        }

        // Release-check preflight (update-release.ts) surfaces `<label>: gate environment unreadable` to the operator
        // on both metadata view and archive cache-add steps without leaking values or starting install.
        const relSubHome = join(root, `rel-trunc-home-${shells.indexOf(sh)}`);
        const relPkgDir = join(root, `rel-trunc-pkg-${shells.indexOf(sh)}`, "cotal-ai");
        mkdirSync(join(relPkgDir, "dist"), { recursive: true, mode: 0o700 });
        writeFileSync(join(relPkgDir, "package.json"), JSON.stringify({ name: "cotal-ai", version: "0.183.0", bin: { cotal: "dist/cotal.js" } }), { mode: 0o600 });
        writeFileSync(join(relPkgDir, "dist", "cotal.js"), "console.log('ok');\n", { mode: 0o700 });
        for (const sub of ["home", "cotal", "config/cotal", "runtime", "tmp"]) mkdirSync(join(relSubHome, sub), { recursive: true, mode: 0o700 });
        const relCoreUrl = pathToFileURL(join(import.meta.dirname, "../../../packages/core/dist/index.js")).href;
        const relIndexUrl = pathToFileURL(join(import.meta.dirname, "../dist/index.js")).href;
        const relCommandUrl = pathToFileURL(join(import.meta.dirname, "../dist/command.js")).href;
        const relUpdateUrl = pathToFileURL(join(import.meta.dirname, "../dist/commands/update.js")).href;
        const relProcessUrl = pathToFileURL(join(import.meta.dirname, "../dist/commands/update-process.js")).href;
        for (const [step, corruption] of [["view", "truncated"], ["cache", "absent"]] as const) {
          const relNeverRan = join(root, `rel-never-ran-${step}-${corruption}-${shells.indexOf(sh)}`);
          const relRunner = join(relPkgDir, `rel-trunc-runner-${step}-${corruption}.mjs`);
          const relGateEnv = { ...baseEnv, PATH: `${stubBin}${delimiter}${baseEnv.PATH ?? ""}`, SMOKE_RAN_MARKER: relNeverRan, ...tricky };
          writeFileSync(relRunner, [
            `import { spawn } from "node:child_process";`,
            `import { writeFileSync } from "node:fs";`,
            `import { join } from "node:path";`,
            `import { registry } from ${JSON.stringify(relCoreUrl)};`,
            `import ${JSON.stringify(relIndexUrl)};`,
            `import { runCli } from ${JSON.stringify(relCommandUrl)};`,
            `import { updateRuntime } from ${JSON.stringify(relUpdateUrl)};`,
            `import { npmChildGate, releaseChildGate } from ${JSON.stringify(relProcessUrl)};`,
            `Object.assign(updateRuntime, {`,
            `  version: () => "0.183.0",`,
            `  checkout: () => true,`,
            `  installPrefix: () => undefined,`,
            `  preflightReplacement: async () => {},`,
            `  reportRunningManager: async () => "none",`,
            `  extensions: () => [],`,
            `  npm: (args) => args[0] === "view" ? { status: 0, stdout: '"99.0.0"\\n', stderr: "" } : { status: 0, stdout: "", stderr: "" },`,
            `  npmAsync: async (args, cache) => {`,
            `    if (${JSON.stringify(step)} === "cache" && args[0] === "view") {`,
            `      return { status: 0, stdout: JSON.stringify({ name: "cotal-ai", version: "99.0.0", dependencies: {}, dist: { tarball: "http://127.0.0.1:1/pkg.tgz", integrity: "sha512-AA==" } }), stderr: "" };`,
            `    }`,
            `    const launch = npmChildGate("cotal-release-check", ${JSON.stringify(eqCmd)}, args, ${JSON.stringify(relGateEnv)}, ${JSON.stringify(sh)});`,
            `    const child = spawn(launch.file, launch.args, { env: launch.env, detached: true, stdio: ["ignore", "pipe", "pipe", "pipe", "pipe"] });`,
            `    let stdout = "", stderr = "";`,
            `    child.stdout.on("data", chunk => { stdout += chunk.toString(); });`,
            `    child.stderr.on("data", chunk => { stderr += chunk.toString(); });`,
            `    if (cache && child.pid !== undefined) writeFileSync(join(cache, ".worker-" + child.pid), "", { mode: 0o600 });`,
            `    if (${JSON.stringify(corruption)} === "truncated") {`,
            `      releaseChildGate(child, true, launch.envPayload.subarray(0, launch.envPayload.length - 3), () => {}, launch.groupCleanup);`,
            `    } else {`,
            `      child.stdio[4].end();`,
            `      child.stdio[3].end("run\\n");`,
            `    }`,
            `    const [status, signal] = await new Promise(resolve => child.once("close", (c, s) => resolve([c, s])));`,
            `    return { status, signal, stdout, stderr };`,
            `  },`,
            `  spawnGlobal: async () => { throw new Error("spawnGlobal must not run on preflight failure"); },`,
            `});`,
            `await runCli(registry, ["update", "--self"]);`,
          ].join("\n"), { mode: 0o700 });
          const relRes = spawnSync(process.execPath, [relRunner], {
            cwd: relSubHome,
            encoding: "utf8",
            env: {
              ...baseEnv,
              NO_COLOR: "1",
              PATH: `${stubBin}${delimiter}${baseEnv.PATH ?? ""}`,
              HOME: join(relSubHome, "home"),
              COTAL_HOME: join(relSubHome, "cotal"),
              XDG_CONFIG_HOME: join(relSubHome, "config"),
              XDG_RUNTIME_DIR: join(relSubHome, "runtime"),
              TMPDIR: join(relSubHome, "tmp"),
              DO_NOT_TRACK: "1",
              COTAL_TELEMETRY: "off",
              COTAL_NO_UPDATE_CHECK: "1",
              COTAL_SKIP_CONNECTOR_SEED: "1",
              ...tricky,
            },
          });
          assert.equal(relRes.status, 1, `release-check ${corruption} payload (${step}) must exit 1:\n${relRes.stdout}\n${relRes.stderr}`);
          assert.equal(relRes.signal, null);
          assert.equal(existsSync(relNeverRan), false, `release-check ${corruption} payload (${step}) must not run target`);
          const expectedDetail = step === "view"
            ? "metadata for cotal-ai@99.0.0 is unavailable: cotal-release-check: gate environment unreadable"
            : "archives for cotal-ai@99.0.0 could not be downloaded and verified: cotal-release-check: gate environment unreadable";
          assert.deepEqual(relRes.stderr.trim().split("\n").filter(Boolean), [
            `✗ cotal-ai@99.0.0 update preflight failed: ${expectedDetail}. No global install was attempted. Correct the reported failure, then run \`cotal update --self\` again.`,
          ], `release-check (${step}/${corruption}) prints cotal-release-check: gate environment unreadable`);
          assert(!(relRes.stdout + relRes.stderr).includes(secretNeedle), "release-check unreadable payload output must never leak secret");
        }
      }

      // Argv-absence cell: inspect whole process group while permit is held, and again while stand-in child runs.
      const startedMarker = join(root, `started-${shells.indexOf(sh)}`);
      const releaseMarker = join(root, `release-${shells.indexOf(sh)}`);
      const argvLaunch = npmChildGate("cotal-gate-argv", eqCmd, ["visible-arg"], {
        ...baseEnv, PATH: `${stubBin}${delimiter}${baseEnv.PATH ?? ""}`,
        SMOKE_RAN_MARKER: startedMarker, SMOKE_HOLD_UNTIL: releaseMarker, SMOKE_KEYS: keysJson, ...tricky,
      }, sh);
      const argvStdio = argvLaunch.envPayload ? ["ignore", "pipe", "pipe", "pipe", "pipe"] as const : ["ignore", "pipe", "pipe", "pipe"] as const;
      const argvChild = spawn(argvLaunch.file, argvLaunch.args, {
        env: argvLaunch.env, detached: true, stdio: [...argvStdio],
      });
      let argvOut = "";
      argvChild.stdout?.on("data", chunk => { argvOut += chunk.toString(); });
      const pgid = argvChild.pid!;
      await new Promise(resolve => setTimeout(resolve, 40));
      const beforePermitArgvs = readGroupArgv(pgid);
      assert(beforePermitArgvs.length >= 1, `expected live gated process group ${pgid} before permit under ${sh}`);
      for (const cmdline of beforePermitArgvs) {
        assert(!cmdline.includes(secretNeedle), `secret leaked into argv before permit under ${sh}: ${cmdline}`);
      }
      assert.equal(existsSync(startedMarker), false, "child must not start before permit is released");
      releaseChildGate(argvChild, true, argvLaunch.envPayload, cause => { throw cause; }, argvLaunch.groupCleanup);
      for (let deadline = Date.now() + 10_000; !existsSync(startedMarker) && Date.now() < deadline; ) {
        await new Promise(resolve => setTimeout(resolve, 15));
      }
      assert(existsSync(startedMarker), `stand-in child started after permit under ${sh}`);
      const childPid = Number(readFileSync(startedMarker, "utf8").trim());
      const duringRunMembers = processGroupMembers(pgid);
      if (shPreserves) {
        assert.equal(childPid, pgid, `${sh} execs target directly at pgid`);
        assert(duringRunMembers.includes(pgid));
      } else {
        assert(duringRunMembers.includes(pgid) && duringRunMembers.includes(childPid),
          `expected both gate (${pgid}) and child (${childPid}) in process group under ${sh}, got ${JSON.stringify(duringRunMembers)}`);
      }
      const duringRunArgvs = readGroupArgv(pgid);
      assert(duringRunArgvs.length >= (shPreserves ? 1 : 2), `expected argvs for running group under ${sh}`);
      for (const cmdline of duringRunArgvs) {
        assert(!cmdline.includes(secretNeedle), `secret leaked into argv while child runs under ${sh}: ${cmdline}`);
      }
      writeFileSync(releaseMarker, "done");
      assert.equal(await new Promise<number | null>(resolve => argvChild.once("close", resolve)), 0, argvOut);
      assert.deepEqual(JSON.parse(argvOut).picked, tricky);
      await waitPidGone(argvChild.pid);
      await waitPidGone(childPid);

      // Exit status cells (0, 1, 126 EACCES, 127 ENOENT) under sh, including ENOENT stderr text matching main.
      for (const expectedCode of [0, 1, 126, 127] as const) {
        const missingTarget = join(root, "missing-executable-127");
        const targetCmd = expectedCode === 127 ? missingTarget : expectedCode === 126 ? nonExecCmd : eqCmd;
        const exitLaunch = npmChildGate("cotal-gate-exit", targetCmd, ["-leading", "q'w\"e\nr"], {
          ...baseEnv, PATH: `${stubBin}${delimiter}${baseEnv.PATH ?? ""}`,
          SMOKE_EXPECTED_PGID: String(0), SMOKE_KEYS: keysJson, SMOKE_READ_STDIN: expectedCode === 0 ? "1" : "",
          ...(expectedCode === 1 ? { SMOKE_EXIT_CODE: "1" } : {}),
          ...tricky,
        }, sh);
        const exitStdio = exitLaunch.envPayload ? ["pipe", "pipe", "pipe", "pipe", "pipe"] as const : ["pipe", "pipe", "pipe", "pipe"] as const;
        const exitChild = spawn(exitLaunch.file, exitLaunch.args, {
          env: exitLaunch.env, detached: true, stdio: [...exitStdio],
        });
        let exitStdout = "", exitStderr = "";
        exitChild.stdout?.on("data", chunk => { exitStdout += chunk.toString(); });
        exitChild.stderr?.on("data", chunk => { exitStderr += chunk.toString(); });
        exitChild.stdin?.end("stdin-payload\n");
        releaseChildGate(exitChild, true, exitLaunch.envPayload, cause => { throw cause; }, exitLaunch.groupCleanup);
        const actualCode = await new Promise<number | null>(resolve => exitChild.once("close", resolve));
        assert.equal(actualCode, expectedCode, `expected exit code ${expectedCode} under ${sh}, got ${actualCode} (${exitStderr})`);
        if (expectedCode === 127) {
          assert.match(exitStderr, /not found|No such file or directory/i, `ENOENT stderr under ${sh}: ${exitStderr}`);
          assert(exitStderr.includes(missingTarget), `ENOENT stderr names missing executable under ${sh}: ${exitStderr}`);
        }
        if (expectedCode === 0) {
          const report = JSON.parse(exitStdout);
          if (shPreserves) assert.equal(report.pid, exitChild.pid);
          else assert.equal(report.ppid, exitChild.pid, `${sh} gate parent pid matches recorded gate pid`);
          assert.equal(report.sameGroupAsGate, true);
          assert.equal(report.pgid, exitChild.pid, `${sh} child runs in the detached gate process group`);
          assert.equal(report.stdinText, "stdin-payload\n");
          assert.deepEqual(report.argv, ["-leading", "q'w\"e\nr"]);
          assert.deepEqual(report.picked, tricky);
          assert.deepEqual(report.openGateFds, []);
        }
        await waitPidGone(exitChild.pid);
      }

      // Review 2 Finding 4 + 6: SIGKILL, SIGPIPE, SIGXFSZ, and SIGUSR1 through the stage must report as a signal
      // (code === null, signal === sigName), keep .cotal-update-child ambiguous with custody, and run group cleanup.
      if (hasNativeSignalBin) {
        for (const sigName of ["SIGKILL", "SIGPIPE", "SIGXFSZ", "SIGUSR1"] as const) {
          const sigLaunch = npmChildGate("cotal-gate-sig", cSignalBin, [sigName], { ...baseEnv, ...tricky }, sh);
          const sigStdio = sigLaunch.envPayload ? ["ignore", "pipe", "pipe", "pipe", "pipe"] as const : ["ignore", "pipe", "pipe", "pipe"] as const;
          const sigChild = spawn(sigLaunch.file, sigLaunch.args, {
            env: sigLaunch.env, detached: true, stdio: [...sigStdio],
          });
          let sigErr = "";
          sigChild.stderr?.on("data", chunk => { sigErr += chunk.toString(); });
          const sigClosed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(resolve =>
            sigChild.once("close", (code, signal) => resolve({ code, signal })),
          );
          releaseChildGate(sigChild, true, sigLaunch.envPayload, cause => { throw cause; }, sigLaunch.groupCleanup);
          const outcome = await sigClosed;
          assert.equal(outcome.code, null, `${sigName} death under ${sh} must report null exit code, got ${JSON.stringify(outcome)}`);
          assert.equal(outcome.signal, sigName, `${sigName} death under ${sh} must report signal ${sigName}, got ${JSON.stringify(outcome)}`);
          assert.doesNotMatch(sigErr, /Debugger listening/i, `${sigName} under ${sh} must never start Node inspector: ${sigErr}`);
          await waitPidGone(sigChild.pid);
        }
        if (!shPreserves && sh === "/bin/sh" && process.platform === "linux") {
          for (const sigName of ["SIGPIPE", "SIGXFSZ", "SIGUSR1"] as const) {
            const sigGlobalRoot = join(root, `sig-custody-${sigName}`);
            mkdirSync(sigGlobalRoot, { recursive: true, mode: 0o700 });
            const sigSleeperFile = join(sigGlobalRoot, "sleeper.pid");
            const sigWrapper = join(sigGlobalRoot, "spawn-then-die");
            writeFileSync(sigWrapper, `#!/bin/sh
"${process.execPath}" -e 'const cp = require("node:child_process"), fs = require("node:fs"); const s = cp.spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" }); s.unref(); fs.writeFileSync(${JSON.stringify(sigSleeperFile)}, String(s.pid));'
exec "${cSignalBin}" "$1"
`, { mode: 0o755 });
            const globalSigRes = await runGlobalProcess(sigGlobalRoot, "install", sigWrapper, [sigName], { ...baseEnv, ...tricky }, false);
            assert.equal(globalSigRes.status, null, `runGlobalProcess ${sigName} must have status null`);
            assert.equal(globalSigRes.signal, sigName, `runGlobalProcess ${sigName} must report signal ${sigName}`);
            const marker = JSON.parse(readFileSync(join(sigGlobalRoot, ".cotal-update-child"), "utf8"));
            assert.equal(marker.phase, "ambiguous", `${sigName} must keep .cotal-update-child as ambiguous`);
            assert.equal(typeof marker.custody?.pid, "number", `${sigName} ambiguous marker must record custody pid`);
            assert.equal(typeof marker.custody?.start, "string", `${sigName} ambiguous marker must record custody start token`);
            const sigSleeperPid = Number(readFileSync(sigSleeperFile, "utf8").trim());
            for (let deadline = Date.now() + 5_000; processGroupMembers(marker.custody.pid).length > 0 && Date.now() < deadline; ) {
              await new Promise(resolve => setTimeout(resolve, 20));
            }
            assert.deepEqual(processGroupMembers(marker.custody.pid), [], `${sigName} through stage must run group cleanup on surviving descendants`);
            await waitPidGone(sigSleeperPid);
            await waitPidGone(marker.custody.pid, marker.custody.start);
          }
        }
      } else {
        skipCell(`native signal death cells (SIGKILL/SIGPIPE/SIGXFSZ/SIGUSR1) under ${sh}`, ccSkipWhy);
      }

      // SIGTERM to recorded process group ends both the gate and the running child.
      const sigStarted = join(root, `sig-started-${shells.indexOf(sh)}`);
      const sigHold = join(root, `sig-hold-${shells.indexOf(sh)}`);
      const sigLaunch = npmChildGate("cotal-gate-sigterm", eqCmd, ["hold-for-sigterm"], {
        ...baseEnv, PATH: `${stubBin}${delimiter}${baseEnv.PATH ?? ""}`,
        SMOKE_RAN_MARKER: sigStarted, SMOKE_HOLD_UNTIL: sigHold, ...tricky,
      }, sh);
      const sigTermStdio = sigLaunch.envPayload ? ["ignore", "pipe", "pipe", "pipe", "pipe"] as const : ["ignore", "pipe", "pipe", "pipe"] as const;
      const sigChild = spawn(sigLaunch.file, sigLaunch.args, {
        env: sigLaunch.env, detached: true, stdio: [...sigTermStdio],
      });
      const sigPgid = sigChild.pid!;
      const closedPromise = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(resolve =>
        sigChild.once("close", (code, signal) => resolve({ code, signal })),
      );
      releaseChildGate(sigChild, true, sigLaunch.envPayload, cause => { throw cause; }, sigLaunch.groupCleanup);
      for (let deadline = Date.now() + 10_000; !existsSync(sigStarted) && Date.now() < deadline; ) {
        await new Promise(resolve => setTimeout(resolve, 15));
      }
      assert(existsSync(sigStarted), `SIGTERM stand-in child started under ${sh}`);
      const sigInnerPid = Number(readFileSync(sigStarted, "utf8").trim());
      process.kill(-sigPgid, "SIGTERM");
      const closedSig = await closedPromise;
      assert(closedSig.signal === "SIGTERM" || closedSig.code === 143,
        `expected SIGTERM termination under ${sh}, got ${JSON.stringify(closedSig)}`);
      for (let deadline = Date.now() + 5_000; processGroupMembers(sigPgid).length > 0 && Date.now() < deadline; ) {
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      assert.deepEqual(processGroupMembers(sigPgid), [], `SIGTERM to -${sigPgid} ended gate and child ${sigInnerPid} under ${sh}`);
      await waitPidGone(sigPgid);
      await waitPidGone(sigInnerPid);

      // Guarded group kill in releaseChildGate: when the stage leader dies by SIGKILL, surviving descendants in its
      // dedicated group are killed, while an unrelated detached process group is untouched and reaching the
      // `currentStart !== leaderStart` guard leaves the live foreign group completely unsignalled (Review 2 Finding 3).
      if (!shPreserves) {
        const foreignReady = join(root, `foreign-ready-${shells.indexOf(sh)}`);
        const foreignSignaled = join(root, `foreign-signaled-${shells.indexOf(sh)}`);
        const foreignGroup = spawn(process.execPath, ["-e", [
          `const fs = require("node:fs");`,
          `process.on("SIGTERM", () => { fs.writeFileSync(${JSON.stringify(foreignSignaled)}, "SIGTERM"); process.exit(0); });`,
          `fs.writeFileSync(${JSON.stringify(foreignReady)}, String(process.pid));`,
          `setInterval(() => {}, 1000);`,
        ].join(" ")], { detached: true, stdio: "ignore" });
        const foreignClosed = new Promise<void>(resolve => foreignGroup.once("close", () => resolve()));
        let foreignStart: string | undefined;
        try {
          for (let deadline = Date.now() + 10_000; !existsSync(foreignReady) && Date.now() < deadline; ) {
            await new Promise(resolve => setTimeout(resolve, 15));
          }
          assert(existsSync(foreignReady), "foreign group leader armed SIGTERM trap");
          foreignStart = processStartToken(foreignGroup.pid!);
          assert(foreignStart !== undefined, "captured live foreign group start token");

          const sleeperFile = join(root, `sleeper-${shells.indexOf(sh)}`);
          const gkStarted = join(root, `gk-started-${shells.indexOf(sh)}`);
          const gkHold = join(root, `gk-hold-${shells.indexOf(sh)}`);
          const gkLaunch = npmChildGate("cotal-gate-groupkill", eqCmd, ["hold-for-groupkill"], {
            ...baseEnv, PATH: `${stubBin}${delimiter}${baseEnv.PATH ?? ""}`,
            SMOKE_SPAWN_DETACHED_SLEEPER: sleeperFile, SMOKE_RAN_MARKER: gkStarted, SMOKE_HOLD_UNTIL: gkHold, ...tricky,
          }, sh);
          const gkChild = spawn(gkLaunch.file, gkLaunch.args, {
            env: gkLaunch.env, detached: true, stdio: ["ignore", "pipe", "pipe", "pipe", "pipe"],
          });
          const gkPgid = gkChild.pid!;
          releaseChildGate(gkChild, true, gkLaunch.envPayload, cause => { throw cause; }, gkLaunch.groupCleanup);
          for (let deadline = Date.now() + 10_000; (!existsSync(gkStarted) || !existsSync(sleeperFile)) && Date.now() < deadline; ) {
            await new Promise(resolve => setTimeout(resolve, 15));
          }
          const sleeperPid = Number(readFileSync(sleeperFile, "utf8").trim());
          assert(processGroupMembers(gkPgid).includes(sleeperPid), "grandchild sleeper is in gate process group");
          // Kill ONLY the stage leader PID with SIGKILL; releaseChildGate exit hook must clean up the surviving group members.
          process.kill(gkPgid, "SIGKILL");
          await new Promise<void>(resolve => gkChild.once("close", () => resolve()));
          for (let deadline = Date.now() + 5_000; processGroupMembers(gkPgid).length > 0 && Date.now() < deadline; ) {
            await new Promise(resolve => setTimeout(resolve, 20));
          }
          assert.deepEqual(processGroupMembers(gkPgid), [], "releaseChildGate cleaned up surviving group descendants after stage SIGKILL");
          await waitPidGone(gkPgid);
          await waitPidGone(sleeperPid);
          assert(processGroupMembers(foreignGroup.pid!).includes(foreignGroup.pid!), "unrelated process group was untouched");
          assert.equal(existsSync(foreignSignaled), false, "unrelated process group received no signal during stage group cleanup");

          // Review 2 Finding 3: reach `currentStart !== leaderStart` directly against the live `foreignGroup.pid`
          // (whose processGroupMembers is non-empty and whose SIGTERM handler writes `foreignSignaled` if signalled).
          const tokenReads: (string | undefined)[] = [];
          const priorStageStart = `${foreignStart}-prior-stage`;
          let readCount = 0;
          const reusedEmitter = Object.assign(new (await import("node:events")).EventEmitter(), {
            pid: foreignGroup.pid!,
            stdio: [null, null, null, new (await import("node:stream")).PassThrough(), new (await import("node:stream")).PassThrough()],
          }) as unknown as import("node:child_process").ChildProcess;
          releaseChildGate(reusedEmitter, true, Buffer.from([0, 0, 0, 0, 0xff, 0xff, 0xff, 0xff]), () => {}, true, pid => {
            readCount += 1;
            const tok = readCount === 1 ? priorStageStart : processStartToken(pid);
            tokenReads.push(tok);
            return tok;
          });
          reusedEmitter.emit("exit", null, "SIGTERM");
          await new Promise(resolve => setTimeout(resolve, 60));
          assert.deepEqual(tokenReads, [priorStageStart, foreignStart], "exit hook must reach currentStart !== leaderStart check");
          assert.equal(existsSync(foreignSignaled), false, "foreign group pid must receive no signal when currentStart !== leaderStart");
          assert(processGroupMembers(foreignGroup.pid!).includes(foreignGroup.pid!), "foreign group remains alive after start-token mismatch guard");

          // Positive control on foreignGroup's SIGTERM trap: sending SIGTERM now MUST record `foreignSignaled` and exit cleanly.
          process.kill(-foreignGroup.pid!, "SIGTERM");
          await foreignClosed;
          assert.equal(existsSync(foreignSignaled), true, "positive control: foreignGroup SIGTERM trap records signal when actually signalled");
        } finally {
          try { process.kill(-foreignGroup.pid!, "SIGKILL"); } catch {}
          await foreignClosed;
          await waitPidGone(foreignGroup.pid, foreignStart);
        }
      }

      // Missing stage file cell (Finding 3): when the shell drops non-identifier names and the stage helper is missing,
      // both runNpmAsync and runGlobalProcess refuse with an actionable remedy BEFORE writing .worker-<pid> or .cotal-update-child.
      if (!shPreserves && sh === "/bin/sh") {
        const helperPath = posixGateScriptPath();
        const movedHelper = `${helperPath}.smoke-aside-${process.pid}`;
        const missingCache = join(root, "missing-helper-archive");
        const missingRoot = join(root, "missing-helper-global");
        mkdirSync(missingCache, { recursive: true, mode: 0o700 });
        mkdirSync(missingRoot, { recursive: true, mode: 0o700 });
        renameSync(helperPath, movedHelper);
        try {
          assert.throws(
            () => npmChildGate("cotal-missing", eqCmd, [], { ...baseEnv, ...tricky }, sh),
            /missing POSIX update gate helper.*reinstall with `npm install -g cotal-ai@latest`/i,
          );
          const savedMissing = new Map<string, string | undefined>();
          for (const k of Object.keys(tricky)) { savedMissing.set(k, process.env[k]); process.env[k] = tricky[k]; }
          let asyncMissing: Awaited<ReturnType<typeof runNpmAsync>>;
          try {
            asyncMissing = await runNpmAsync(["view"], missingCache);
          } finally {
            for (const [k, v] of savedMissing) {
              if (v === undefined) delete process.env[k];
              else process.env[k] = v;
            }
          }
          assert.equal(asyncMissing.status, null);
          assert.match(asyncMissing.error ?? "", /missing POSIX update gate helper/);
          assert.equal(existsSync(missingCache) && (await import("node:fs")).readdirSync(missingCache).some(n => n.startsWith(".worker-")), false,
            "missing helper in runNpmAsync must fail before writing .worker-<pid>");

          if (process.platform === "linux") {
            const globalMissing = await runGlobalProcess(missingRoot, "install", "npm", ["install"], { ...baseEnv, ...tricky }, false);
            assert.equal(globalMissing.status, null);
            assert.match(globalMissing.error ?? "", /missing POSIX update gate helper/);
            assert.equal(existsSync(join(missingRoot, ".cotal-update-child")), false,
              "missing helper in runGlobalChild must fail before writing .cotal-update-child custody");
          }
        } finally {
          renameSync(movedHelper, helperPath);
        }
      }
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
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
    const lastPathFile = join(root, "npm-last-path");
    type NpmLaunch = { node: string; cwd: string; pathHead: string };
    const recordedLaunches = (): NpmLaunch[] => readFileSync(record, "utf8").trim().split(/\r?\n/).map(line => JSON.parse(line));
    writeFileSync(join(npmRoot, "package.json"), JSON.stringify({ name: "npm", bin: { npm: "bin/npm-cli.js" }, engines: { node: process.version } }));
    writeFileSync(cli, `#!/usr/bin/env node
const fs = require('node:fs');
fs.writeFileSync(${JSON.stringify(lastPathFile)}, process.env.PATH ?? '');
fs.appendFileSync(${JSON.stringify(record)}, JSON.stringify({
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

      // Failure fallbacks: missing absolute asdf (even with another asdf on PATH), >2s hang, and
      // relative / multi-line / non-executable / non-npm answers each leave the original shim in place.
      const missingAsdfPath = join(root, "missing-asdf-dir", "asdf");
      writeFileSync(join(asdfShims, "npm"), `#!/bin/sh\n# asdf-plugin: nodejs ${process.versions.node}\nexec "${missingAsdfPath}" exec "npm" "$@"\n`, { mode: 0o755 });
      const missingAsdf = spawnSync(join(onlyNode, exe), [entry, "update", "--self"], {
        cwd: project, encoding: "utf8", timeout: 60_000,
        env: { ...asdfBaseEnv, NODE_OPTIONS: undefined },
      });
      assert.equal(missingAsdf.status, 1, missingAsdf.stdout + missingAsdf.stderr);
      assert.match(missingAsdf.stderr, /missing-asdf-dir\/asdf/);
      writeGoAsdfShim();

      const nonExecNpm = join(root, "non-exec-npm");
      writeFileSync(nonExecNpm, "#!/bin/sh\nexit 0\n", { mode: 0o644 });
      const nonNpmExec = join(root, "non-npm-exec");
      writeFileSync(nonNpmExec, "#!/bin/sh\nexit 99\n", { mode: 0o755 });
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
        ["non-npm", { ASDF_TEST_WHICH_OUT: `${nonNpmExec}\\n` }],
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

      // Linear bounded shim check: a 64 KB one-line file (and a sub-4KB pathological spaces line)
      // with `# asdf-plugin:` returns in well under 1 s and is treated as not a shim.
      writeAsdfExe();
      for (const [label, content] of [
        ["64kb-one-line", `# asdf-plugin: nodejs ${" ".repeat(65_536)}exec asdf exec "npm" "$@"`],
        ["3kb-spaces", `#!/bin/sh\n# asdf-plugin: nodejs\nexec ${" ".repeat(3000)}not-asdf\n`],
      ] as const) {
        const bigNpmDir = join(root, `big-shim-${label}`);
        mkdirSync(bigNpmDir, { recursive: true });
        writeFileSync(join(bigNpmDir, "npm"), content, { mode: 0o755 });
        rmSync(asdfCalls, { force: true });
        const started = performance.now();
        const invoked = await npmProjectDirectory.run(project, () =>
          npmInvocation({ ...cliEnv(asdfExtra, bigNpmDir), ASDF_DATA_DIR: asdfData, NODE_OPTIONS: undefined }, ["view", "cotal-ai@latest", "version", "--json"]));
        const elapsedMs = performance.now() - started;
        assert.ok(elapsedMs < 500, `${label} shim check took ${elapsedMs}ms (must be well under 1000ms)`);
        assert.equal(invoked.npm, undefined, `${label} is treated as not an asdf shim`);
        assert.throws(() => readFileSync(asdfCalls), { code: "ENOENT" }, `${label} never invokes asdf`);
      }

      // Non-asdf npm wrapper on PATH is untouched and never consults asdf.
      const customNpmDir = join(root, "custom-npm-bin");
      mkdirSync(customNpmDir, { recursive: true });
      const customNpmLog = join(root, "custom-npm-calls");
      writeFileSync(join(customNpmDir, "npm"), `#!/bin/sh\nprintf '%s\\n' "$PWD" >> ${JSON.stringify(customNpmLog)}\nexec ${JSON.stringify(cli)} "$@"\n`, { mode: 0o755 });
      rmSync(asdfCalls, { force: true });
      const nonAsdfRes = spawnSync(join(onlyNode, exe), [entry, "update", "--check"], {
        cwd: project, encoding: "utf8", timeout: 60_000,
        env: { ...cliEnv(asdfExtra, customNpmDir), ASDF_DATA_DIR: asdfData, NODE_OPTIONS: undefined },
      });
      assert.equal(nonAsdfRes.status, 0, nonAsdfRes.stdout + nonAsdfRes.stderr);
      assert.equal(readFileSync(customNpmLog, "utf8").trim(), parse(root).root, "non-asdf npm wrapper runs directly from /");
      assert.throws(() => readFileSync(asdfCalls), { code: "ENOENT" }, "non-asdf npm never invokes asdf");

      // Inherited COTAL_UPDATE_NPM is accepted only when npmEngine recognises it:
      // a non-npm executable on PATH and one in a directory containing the PATH delimiter are both ignored.
      writeGoAsdfShim();
      writeFileSync(join(project, ".tool-versions"), `${asdfInstall}\n`);
      const rogueLog = join(root, "rogue-update-npm-calls");
      const rogueOnPath = join(asdfBin, "rogue-npm");
      const rogueColonDir = join(root, `rogue${delimiter}npm`);
      mkdirSync(rogueColonDir, { recursive: true });
      const rogueInColonDir = join(rogueColonDir, "npm");
      for (const rogue of [rogueOnPath, rogueInColonDir]) {
        writeFileSync(rogue, `#!/bin/sh\nprintf 'ran\\n' >> ${JSON.stringify(rogueLog)}\nexit 99\n`, { mode: 0o755 });
      }
      for (const [label, inheritedValue] of [
        ["non-npm on PATH", rogueOnPath],
        ["non-npm in colon directory", rogueInColonDir],
      ] as const) {
        rmSync(rogueLog, { force: true });
        const ignoredRes = spawnSync(join(onlyNode, exe), [entry, "update", "--self"], {
          cwd: project, encoding: "utf8", timeout: 60_000,
          env: { ...asdfBaseEnv, NODE_OPTIONS: undefined, COTAL_UPDATE_NPM: inheritedValue },
        });
        assert.equal(ignoredRes.status, 0, `${label}: ${ignoredRes.stdout}${ignoredRes.stderr}`);
        assert.match(ignoredRes.stdout, /Registry latest:/);
        assert.deepEqual(recordedLaunches().at(-1), {
          node: realpathSync(join(onlyNode, exe)), cwd: parse(root).root, pathHead: onlyNode,
        }, `${label} is ignored in favour of the project's asdf npm`);
        assert.throws(() => readFileSync(rogueLog), { code: "ENOENT" }, `${label} never executes`);
      }

      // Transient timeout retry: a first `asdf which npm` timeout is not cached as "no npm";
      // a second call retries and caches a positive answer, while persistent timeouts ask at most once more.
      {
        const retryShimDir = join(root, "asdf-retry-shims");
        const capShimDir = join(root, "asdf-cap-shims");
        for (const dir of [retryShimDir, capShimDir]) {
          mkdirSync(dir, { recursive: true });
          writeFileSync(join(dir, "npm"), `#!/bin/sh\n# asdf-plugin: nodejs ${process.versions.node}\nexec asdf exec "npm" "$@"\n`, { mode: 0o755 });
        }
        const onceMarker = join(root, "asdf-timeout-once");
        writeFileSync(asdfExe, `#!/bin/sh
printf '%s\\n' "$1:$2:$PWD" >> ${JSON.stringify(asdfCalls)}
if [ "$1:$2" = "which:npm" ] && [ -n "$ASDF_ONCE_MARKER" ] && [ ! -f "$ASDF_ONCE_MARKER" ]; then
  : > "$ASDF_ONCE_MARKER"
  exec /bin/sleep 3
fi
if [ -n "$ASDF_TEST_SLEEP" ]; then exec /bin/sleep "$ASDF_TEST_SLEEP"; fi
case "$1:$2" in
  which:npm) printf '%s\\n' ${JSON.stringify(asdfPluginShim)} ;;
  where:nodejs) cat .tool-versions ;;
  exec:npm) shift 2; exec ${JSON.stringify(asdfPluginShim)} "$@" ;;
  *) exit 2 ;;
esac
`, { mode: 0o755 });

        rmSync(asdfCalls, { force: true });
        rmSync(onceMarker, { force: true });
        const retryEnv = { ...cliEnv(asdfExtra, retryShimDir), ASDF_DATA_DIR: asdfData, ASDF_ONCE_MARKER: onceMarker, NODE_OPTIONS: undefined };
        const firstTry = await npmProjectDirectory.run(project, () => npmInvocation(retryEnv, ["view"]));
        assert.equal(firstTry.npm, undefined, "first call falls back when asdf which npm times out");
        const secondTry = await npmProjectDirectory.run(project, () => npmInvocation(retryEnv, ["view"]));
        assert.equal(secondTry.npm, join(asdfInstall, "bin", "npm"), "second call retries after a timeout and resolves the project's npm");
        const thirdTry = await npmProjectDirectory.run(project, () => npmInvocation(retryEnv, ["view"]));
        assert.equal(thirdTry.npm, join(asdfInstall, "bin", "npm"), "third call reuses the cached positive answer");
        assert.deepEqual(readFileSync(asdfCalls, "utf8").trim().split(/\r?\n/), [
          `which:npm:${realpathSync(project)}`,
          `which:npm:${realpathSync(project)}`,
          `where:nodejs:${realpathSync(project)}`,
        ], "timeout is retried once and positive resolution is then cached");

        rmSync(asdfCalls, { force: true });
        const capEnv = { ...cliEnv(asdfExtra, capShimDir), ASDF_DATA_DIR: asdfData, ASDF_TEST_SLEEP: "3", NODE_OPTIONS: undefined };
        const cap1 = await npmProjectDirectory.run(project, () => npmInvocation(capEnv, ["view"]));
        const cap2 = await npmProjectDirectory.run(project, () => npmInvocation(capEnv, ["view"]));
        const startedCap3 = performance.now();
        const cap3 = await npmProjectDirectory.run(project, () => npmInvocation(capEnv, ["view"]));
        const cap3Elapsed = performance.now() - startedCap3;
        assert.equal(cap1.npm, undefined);
        assert.equal(cap2.npm, undefined);
        assert.equal(cap3.npm, undefined);
        assert.ok(cap3Elapsed < 500, `third call after two timeouts returned without probing (${cap3Elapsed}ms)`);
        assert.deepEqual(readFileSync(asdfCalls, "utf8").trim().split(/\r?\n/), [
          `which:npm:${realpathSync(project)}`,
          `which:npm:${realpathSync(project)}`,
        ], "persistent timeouts probe at most once more per command");
        writeAsdfExe();
      }

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

        // When node and npm come from different directories, the child's appended PATH tail keeps
        // main's `[node, npm]` order (`dirname(node)` ahead of `dirname(npm)`).
        const separateNpmInstall = join(root, "asdf-separate-npm");
        const separateNodeBin = join(root, "asdf-separate-node", "bin");
        mkdirSync(join(separateNpmInstall, "bin"), { recursive: true });
        mkdirSync(separateNodeBin, { recursive: true });
        symlinkSync(cli, join(separateNpmInstall, "bin", "npm"));
        copyFileSync(process.execPath, join(separateNodeBin, exe));
        writeFileSync(dispatcher, `#!/bin/sh\n[ "\${0##*/}" = node ] || exit 1\nexec "${join(separateNodeBin, exe)}" "$@"\n`, { mode: 0o755 });
        writeFileSync(join(project, ".tool-versions"), `${separateNpmInstall}\n`);
        const originalVersion = process.version;
        Object.defineProperty(process, "version", { value: incompatibleVersion });
        try {
          const splitEnv = cliEnv([shimDir, ...asdfExtra], asdfShims);
          const prepared = await npmProjectDirectory.run(project, () => npmUpdateChildEnvironment(splitEnv));
          const expectedTail = [realpathSync(separateNodeBin), join(separateNpmInstall, "bin")];
          assert.deepEqual((prepared.PATH ?? "").split(delimiter).slice(-2), expectedTail,
            "npmUpdateChildEnvironment appends dirname(node) before dirname(npm)");
          const childFile = join(onlyNode, exe), childArgs = [entry, "update", "--check"];
          for (const launch of [() => runGlobalProcess(root, "reconcile", childFile, childArgs, splitEnv), () => runProcess(childFile, childArgs, splitEnv)]) {
            const child = await npmProjectDirectory.run(project, () => launch());
            assert.equal(child.status, 0, child.stdout + child.stderr);
            assert.deepEqual(readFileSync(lastPathFile, "utf8").split(delimiter).slice(-2), expectedTail,
              "child PATH keeps dirname(node) before dirname(npm) on the appended tail");
          }
        } finally {
          Object.defineProperty(process, "version", { value: originalVersion });
          writeFileSync(dispatcher, `#!/bin/sh\n[ -f .tool-versions ] && exit 126\nexec "${alternate}.gone" "$@"\n`);
        }
      } finally { release(); }
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
    mkdirSync(join(home, "runtime"), { recursive: true, mode: 0o700 });
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
      env: { ...env, HOME: home, USERPROFILE: home, COTAL_HOME: join(home, "cotal"),
        XDG_CONFIG_HOME: join(home, "xdg"), XDG_RUNTIME_DIR: join(home, "runtime"),
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
        cwd: home, env: { ...env, HOME: home, USERPROFILE: home, COTAL_HOME: join(home, "cotal"),
          XDG_CONFIG_HOME: join(home, "xdg"), XDG_RUNTIME_DIR: join(home, "runtime"),
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
const totalSkipped = skippedCells + registryArrivalSkippedCount();
console.log(`UPDATE CURRENT SMOKE OK (${counted.cells()} passed, 0 failed; ${totalSkipped} skipped)`);
emitSentinel({ passed: counted.cells(), failed: 0 });
