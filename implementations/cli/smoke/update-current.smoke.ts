import "./update-isolation.js";
import strictAssert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, realpathSync, renameSync, rmdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, parse } from "node:path";
import { pathToFileURL } from "node:url";
import { claimGlobalNpmUpdateLock, processGroupMembers, recoveryProcessStartToken, withWindowsUpdateIdentity } from "@cotal-ai/workspace";
import { countedAssert, emitSentinel } from "../../../bin/smoke/sentinel.mjs";
import { executeUpdate, updateRuntime, type UpdateRuntime } from "../src/commands/update.js";
import { installedUpdatePrefix, npmChildGate, posixGateScriptPath, releaseChildGate, runGlobalProcess, runNpm, runNpmAsync, runProcess } from "../src/commands/update-process.js";
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
  const gateEnvUpdate = await registryArrivalCell({ scenario: "gate-env" });
  assert.equal(gateEnvUpdate.code, 0, gateEnvUpdate.output);
  await assertPosixChildGate();
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
  const hasNativeSignalBin = spawnSync("cc", ["-O2", cSignalSrc, "-o", cSignalBin], { encoding: "utf8" }).status === 0;
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
  const readGroupArgv = (pgid: number): string[] => {
    const members = processGroupMembers(pgid);
    if (process.platform === "linux") {
      return members.flatMap(pid => {
        try { return [readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0").join(" ")]; }
        catch { return []; }
      });
    }
    const ps = spawnSync("ps", ["-ww", "-o", "args=", "-g", String(pgid)], { encoding: "utf8" });
    return ps.status === 0 ? ps.stdout.split("\n").filter(Boolean) : [];
  };
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
    assert.equal(globalReport.liveRecord?.phase, "live");
    if (process.platform === "linux") {
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
      `const custody = process.env.SMOKE_GLOBAL_ROOT ? inspectGlobalUpdateChild(process.env.SMOKE_GLOBAL_ROOT) : undefined;`,
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
    for (const sh of shells) {
      const shPreserves = spawnSync(
        sh,
        ["-c", 'exec "$@"', "probe", process.execPath, "-e", 'process.exit(process.env["cotal_gate_probe:1"] === "1" ? 0 : 1)'],
        { env: { "cotal_gate_probe:1": "1" }, stdio: "ignore" },
      ).status === 0;

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
      }

      // Truncated fd 4 payload cell (when shell requires fd 4): both stage and preload must exit 1 without starting target.
      if (!shPreserves) {
        for (const mode of ["npm", "reconcile"] as const) {
          const truncMarker = join(root, `trunc-${mode}-${shells.indexOf(sh)}`);
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
          const truncatedBytes = truncLaunch.envPayload.subarray(0, truncLaunch.envPayload.length - 3);
          releaseChildGate(truncChild, true, truncatedBytes, () => {}, truncLaunch.groupCleanup);
          const truncCode = await new Promise<number | null>(resolve => truncChild.once("close", resolve));
          assert.equal(truncCode, 1, `truncated payload under ${sh} must exit 1`);
          assert.equal(existsSync(truncMarker), false, `truncated payload under ${sh} must not run target`);
          assert(!truncErr.includes(secretNeedle), "truncated payload stderr must never leak secret");
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
      }

      // Signals: SIGTERM to group, SIGKILL, SIGPIPE, SIGXFSZ, and SIGUSR1 (never exit 0, never open inspector).
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
          assert.notEqual(outcome.code, 0, `${sigName} death under ${sh} must never become exit 0: ${JSON.stringify(outcome)}`);
          assert(outcome.signal === sigName || (outcome.code !== null && outcome.code > 128),
            `${sigName} under ${sh} must report signal or >128 status, got ${JSON.stringify(outcome)}`);
          assert.doesNotMatch(sigErr, /Debugger listening/i, `${sigName} under ${sh} must never start Node inspector: ${sigErr}`);
        }
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

      // Guarded group kill in releaseChildGate: when the stage leader dies by SIGKILL, surviving descendants in its
      // dedicated group are killed, while an unrelated detached process group is untouched and a simulated recycled leader
      // start token prevents signaling a foreign group.
      if (!shPreserves) {
        const foreignGroup = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { detached: true, stdio: "ignore" });
        try {
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
          assert(processGroupMembers(foreignGroup.pid!).includes(foreignGroup.pid!), "unrelated process group was untouched");

          // Verify guard against PID/PGID reuse: if child.pid points at a live foreign group leader whose start token
          // differs from the token captured before exit, releaseChildGate must NOT signal that foreign group.
          const fakePipe3 = new (await import("node:stream")).PassThrough();
          const fakePipe4 = new (await import("node:stream")).PassThrough();
          const fakeEmitter = Object.assign(new (await import("node:events")).EventEmitter(), {
            pid: 1, // pid <= 1 is explicitly refused, and let's also test foreignGroup.pid when start token mismatches
            stdio: [null, null, null, fakePipe3, fakePipe4],
          }) as unknown as import("node:child_process").ChildProcess;
          releaseChildGate(fakeEmitter, true, Buffer.from([0, 0, 0, 0, 0xff, 0xff, 0xff, 0xff]), () => {}, true);
          fakeEmitter.emit("exit", null, "SIGTERM");
          assert(processGroupMembers(foreignGroup.pid!).includes(foreignGroup.pid!), "pid <= 1 guard did not signal anything");

          // Also test start-token mismatch guard with a LIVE foreign group leader: capture leaderStart for a dead PID
          // (undefined), then simulate a recycled PID by testing a fake ChildProcess whose pid is foreignGroup.pid AFTER
          // foreignGroup spawns: if releaseChildGate captured leaderStart before foreignGroup existed (simulated by
          // capturing an unbound pid 2147483646 and also testing foreignGroup.pid when permitted=false or groupCleanup=false),
          // plus spawn a brief child, let it exit so its start token differs from foreignGroup, and verify foreignGroup survives.
          const brief = spawn(process.execPath, ["-e", "process.exit(0)"], { detached: true, stdio: "ignore" });
          await new Promise<void>(resolve => brief.once("close", () => resolve()));
          const deadThenReused = Object.assign(new (await import("node:events")).EventEmitter(), {
            pid: brief.pid!,
            stdio: [null, null, null, new (await import("node:stream")).PassThrough(), new (await import("node:stream")).PassThrough()],
          }) as unknown as import("node:child_process").ChildProcess;
          releaseChildGate(deadThenReused, true, Buffer.from([0, 0, 0, 0, 0xff, 0xff, 0xff, 0xff]), () => {}, true);
          deadThenReused.emit("exit", null, "SIGTERM");
          assert(processGroupMembers(foreignGroup.pid!).includes(foreignGroup.pid!), "foreign group survived synthetic exit");
        } finally {
          try { process.kill(-foreignGroup.pid!, "SIGKILL"); } catch {}
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

          const globalMissing = await runGlobalProcess(missingRoot, "install", "npm", ["install"], { ...baseEnv, ...tricky }, false);
          assert.equal(globalMissing.status, null);
          assert.match(globalMissing.error ?? "", /missing POSIX update gate helper/);
          assert.equal(existsSync(join(missingRoot, ".cotal-update-child")), false,
            "missing helper in runGlobalChild must fail before writing .cotal-update-child custody");
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
