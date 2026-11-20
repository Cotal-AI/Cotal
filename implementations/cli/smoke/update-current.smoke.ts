import "./update-isolation.js";
import strictAssert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmdirSync, rmSync, symlinkSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { countedAssert, emitSentinel } from "../../../bin/smoke/sentinel.mjs";
import { executeUpdate, updateRuntime, type UpdateRuntime } from "../src/commands/update.js";
const counted = countedAssert(strictAssert);
const assert: typeof strictAssert = counted.assert as typeof strictAssert;
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
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("COTAL_") && key.toLowerCase() !== "path"));
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
if (process.platform !== "win32") {
  const home = mkdtempSync(join(tmpdir(), "cotal-update-cwd-"));
  try {
    const gone = join(home, "gone");
    mkdirSync(gone);
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("COTAL_") && !key.toLowerCase().startsWith("npm_config_")));
    const result = spawnSync("/bin/sh", ["-c", 'cd "$1" && rmdir "$1" && shift && "$@" update --self && "$@" update --self', "sh", gone,
      process.execPath, join(import.meta.dirname, "../../../bin/dist/cotal.js")], {
      cwd: home, encoding: "utf8", timeout: 180_000,
      env: { ...env, HOME: home, USERPROFILE: home, COTAL_HOME: join(home, "cotal"), XDG_CONFIG_HOME: join(home, "xdg"),
        COTAL_TELEMETRY: "off", COTAL_NO_UPDATE_CHECK: "1", COTAL_ALLOW_CHECKOUT_SEED: "1" },
    });
    assert.equal(result.status, 0, `plain self-update and retry run from an already removed folder: ${result.stdout}\n${result.stderr}`);
    assert.doesNotMatch(result.stdout + result.stderr, /this folder no longer exists|update preflight failed|registry cannot be reached/i,
      "removed cwd does not refuse update or masquerade as unavailable registry metadata");
    assert.match(result.stdout, /Registry latest:/, "the actual updater completed its registry check");
    mkdirSync(join(home, ".cotal"));
    mkdirSync(gone);
    const during = await new Promise<{ status: number | null; output: string; removed: boolean }>((resolve, reject) => {
      const child = spawn("/bin/sh", ["-c", 'cd "$1" && shift && "$@" update --self && "$@" update --self', "sh", gone,
        process.execPath, join(import.meta.dirname, "../../../bin/dist/cotal.js")], {
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
    assert.doesNotMatch(during.output, /this folder no longer exists|update preflight failed|registry cannot be reached/i);
  } finally { rmSync(home, { recursive: true, force: true }); }
}
emitSentinel({ passed: counted.cells(), failed: 0 });
