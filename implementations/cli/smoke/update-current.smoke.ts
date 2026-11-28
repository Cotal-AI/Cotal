import "./update-isolation.js";
import strictAssert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, realpathSync, renameSync, rmdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, parse } from "node:path";
import { pathToFileURL } from "node:url";
import { claimGlobalNpmUpdateLock, recoveryProcessStartToken, withWindowsUpdateIdentity } from "@cotal-ai/workspace";
import { countedAssert, emitSentinel } from "../../../bin/smoke/sentinel.mjs";
import { executeUpdate, updateRuntime, type UpdateRuntime } from "../src/commands/update.js";
import { installedUpdatePrefix, runGlobalProcess, runNpm, runProcess } from "../src/commands/update-process.js";
import { npmInvocation, npmProjectDirectory, npmUpdateChildEnvironment } from "../src/lib/npm-invocation.js";
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
emitSentinel({ passed: counted.cells(), failed: 0 });
