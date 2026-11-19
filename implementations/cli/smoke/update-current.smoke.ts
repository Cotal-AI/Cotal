import "./update-isolation.js";
import strictAssert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer as createRegistry } from "node:http";
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
assert.equal(await executeUpdate(true, rt), 0, "current package closure with no newer release reports legacy custody without refusing");
assert.deepEqual(effects, ["custody"]);
assert.match(output.join("\n"), /later update will require/i);
assert.ok(output.some(line => line.includes("installed package closure is current")) && !output.some(line => line.includes("Run `cotal update` to repair connector integrations")), "a current no-op reports its observed current package closure without inventing connector repair work");
for (const consistent of [false, true]) {
  const actions: string[] = [];
  const denied: UpdateRuntime = { ...rt, isCurrent: () => consistent,
    reportRunningManager: async () => { actions.push("custody"); if (consistent) throw new Error("custody unreadable"); return "legacy"; },
    reconcile: async () => { actions.push("repair"); },
  };
  assert.equal(await executeUpdate(true, denied), 1, "repair-needed or unreadable custody remains a refusal");
  assert.deepEqual(actions, ["custody"]);
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
  if (!address || typeof address === "string") throw new Error("no loopback address");
  return address.port;
}
const proxyPort = await closedPort();
let registryPort = await closedPort();
while (registryPort === proxyPort) registryPort = await closedPort();
const proxyEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(?:cotal_|npm_config_|(?:https?_proxy|all_proxy|proxy|no_proxy)$)/i.test(key)));
const proxyHome = mkdtempSync(join(tmpdir(), "cotal-update-proxy-"));
try {
  const userConfig = join(proxyHome, "user.npmrc");
  const update = (extra: NodeJS.ProcessEnv) => spawnSync(process.execPath, [join(import.meta.dirname, "../../../bin/dist/cotal.js"), "update", "--self"], {
    cwd: proxyHome, encoding: "utf8", timeout: 30_000,
    env: { ...proxyEnv, HOME: proxyHome, USERPROFILE: proxyHome, COTAL_HOME: join(proxyHome, "cotal"),
      XDG_CONFIG_HOME: join(proxyHome, "config"), XDG_RUNTIME_DIR: join(proxyHome, "runtime"), TMPDIR: proxyHome, TMP: proxyHome, TEMP: proxyHome,
      LOCALAPPDATA: join(proxyHome, "local"), APPDATA: join(proxyHome, "roaming"),
      npm_config_userconfig: userConfig, npm_config_globalconfig: join(proxyHome, "global.npmrc"),
      npm_config_registry: `https://127.0.0.1:${registryPort}`, npm_config_prefix: join(proxyHome, "prefix"),
      COTAL_NO_UPDATE_CHECK: "1", COTAL_TELEMETRY: "off", ...extra },
  });
  const checkRefusal = (refused: ReturnType<typeof update>) => {
    assert.equal(refused.status, 1, refused.stdout + refused.stderr);
    assert.match(refused.stderr, /npm proxy refused the connection \(ECONNREFUSED\)/);
    assert.match(refused.stderr, /HTTP_PROXY, HTTPS_PROXY/);
    assert.doesNotMatch(refused.stdout + refused.stderr, /example-user|example-password|localhost|127\.0\.0\.1|registry cannot be reached/i);
  };
  checkRefusal(update({ https_proxy: `http://example-user:example-password@localhost:${proxyPort}` }));
  writeFileSync(userConfig, `https-proxy=http://127.0.0.1:${proxyPort}\n`);
  checkRefusal(update({}));
  writeFileSync(userConfig, `proxy=http://example-user:example-password@localhost:${proxyPort}\n`);
  checkRefusal(update({}));
  writeFileSync(userConfig, `https-proxy=socks5://127.0.0.1:${proxyPort}\n`);
  checkRefusal(update({}));
  writeFileSync(userConfig, "");
  const privateRegistry = `https://proxy-only.test.invalid:${proxyPort}`;
  checkRefusal(update({ npm_config_registry: privateRegistry, HTTPS_PROXY: `http://127.0.0.1:${proxyPort}` }));
  checkRefusal(update({ npm_config_registry: privateRegistry, HTTPS_PROXY: `socks5h://127.0.0.1:${proxyPort}` }));
  for (const extra of [
    {},
    { HTTPS_PROXY: `http://127.0.0.1:${proxyPort}`, NO_PROXY: "127.0.0.1" },
    { HTTPS_PROXY: `http://127.0.0.1:${registryPort}`, npm_config_noproxy: "127.0.0.1" },
    { HTTPS_PROXY: `http://127.0.0.1:${proxyPort}`, COTAL_AUTO_UPDATE: "1" }]) {
    const offline = update(extra);
    assert.equal(offline.status, 0, offline.stdout + offline.stderr);
    assert.equal(offline.stdout.trim(), "The registry cannot be reached; nothing was changed.");
    assert.doesNotMatch(offline.stderr, /proxy refused/i);
  }
} finally {
  rmSync(proxyHome, { recursive: true, force: true });
}
const { seedInstallationCurrent } = await import("../src/seed/reconcile.js");
assert.equal(seedInstallationCurrent(), false, "an unseeded checkout is not proven current");
const { registryArrivalCell } = await import("../../../bin/smoke/update-registry-arrival.smoke.mjs");
const cacheUpdate = await registryArrivalCell({ scenario: "cache" });
assert.equal(cacheUpdate.code, 0, "real CLI and npm update succeed with a user-owned cache that is not writable");
if (process.platform !== "win32") {
  const home = mkdtempSync(join(tmpdir(), "cotal-update-cwd-"));
  const version = JSON.parse(readFileSync(join(import.meta.dirname, "../../../bin/package.json"), "utf8")).version;
  const registry = createRegistry((_request, response) => response.end(JSON.stringify({
    name: "cotal-ai", "dist-tags": { latest: version }, versions: { [version]: { name: "cotal-ai", version } },
  })));
  try {
    await new Promise<void>((resolve, reject) => registry.once("error", reject).listen(0, "127.0.0.1", resolve));
    const address = registry.address();
    if (!address || typeof address === "string") throw new Error("no loopback registry address");
    const gone = join(home, "gone"), tools = join(home, "tools");
    mkdirSync(gone);
    mkdirSync(tools);
    // Only test the vanished cwd, even if the public tag has moved past this checkout.
    // Connector reconciliation still needs the real registry for dependencies.
    writeFileSync(join(tools, "npm"), `#!/bin/sh
if [ "$1:$2:$3" = 'view:cotal-ai@latest:version' ]; then export npm_config_registry=http://127.0.0.1:${address.port}; fi
export PATH="$COTAL_TEST_ORIGINAL_PATH"
exec npm "$@"
`, { mode: 0o700 });
    const env = { ...proxyEnv, PATH: `${tools}:${process.env.PATH}`, COTAL_TEST_ORIGINAL_PATH: process.env.PATH,
      npm_config_prefix: join(home, "prefix"), npm_config_cache: join(home, "cache"),
      npm_config_globalconfig: join(home, "global.npmrc"), npm_config_userconfig: join(home, "user.npmrc"),
      HOME: home, USERPROFILE: home, COTAL_HOME: join(home, "cotal"), XDG_CONFIG_HOME: join(home, "xdg"), XDG_RUNTIME_DIR: join(home, "runtime"),
      COTAL_TELEMETRY: "off", COTAL_NO_UPDATE_CHECK: "1", COTAL_ALLOW_CHECKOUT_SEED: "1" };
    const run = (shell: string, removeDuringUpdate: boolean) => new Promise<{ status: number | null; output: string; removed: boolean }>((resolve, reject) => {
      const child = spawn("/bin/sh", ["-c", shell, "sh", gone, process.execPath, join(import.meta.dirname, "../../../bin/dist/cotal.js")], { cwd: home, env });
      let output = "", removed = false;
      const timer = setTimeout(() => child.kill("SIGTERM"), 180_000);
      child.stdout.on("data", chunk => {
        output += chunk.toString();
        if (removeDuringUpdate && !removed && /Built-in connectors|installed package closure is current/.test(output)) {
          rmdirSync(gone);
          removed = true;
        }
      });
      child.stderr.on("data", chunk => { output += chunk.toString(); });
      child.once("error", error => { clearTimeout(timer); reject(error); });
      child.once("close", status => { clearTimeout(timer); resolve({ status, output, removed }); });
    });
    const result = await run('cd "$1" && rmdir "$1" && shift && "$@" update --self && "$@" update --self', false);
    assert.equal(result.status, 0, `plain self-update and retry run from an already removed folder: ${result.output}`);
    assert.doesNotMatch(result.output, /this folder no longer exists|release is not ready|registry cannot be reached/i,
      "removed cwd does not refuse update or masquerade as unavailable registry metadata");
    assert.match(result.output, /Registry latest:/, "the actual updater completed its registry check");
    mkdirSync(join(home, ".cotal"));
    mkdirSync(gone);
    const during = await run('cd "$1" && shift && "$@" update --self && "$@" update --self', true);
    assert.equal(during.removed, true, `remove the original folder after plain update begins: ${during.output}`);
    assert.equal(during.status, 0, during.output);
    assert.doesNotMatch(during.output, /this folder no longer exists|release is not ready|registry cannot be reached/i);
  } finally {
    await new Promise<void>(resolve => registry.close(() => resolve()));
    rmSync(home, { recursive: true, force: true });
  }
}
emitSentinel({ passed: counted.cells(), failed: 0 });
