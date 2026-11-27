import { execFile } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import strictAssert from "node:assert/strict";
import { countedAssert, emitSentinel } from "../../../bin/smoke/sentinel.mjs";

function pendingPromotion(config: string) {
  const root = join(config, "extensions");
  const stage = join(config, ".extensions.stage-offline.ready");
  const old = join(config, ".extensions.rollback-offline");
  const journal = join(config, ".extensions-promotion.json");
  const name = "offline-promotion-fixture";
  const manifest = (prefix: string) => join(prefix, "node_modules", name, "package.json");
  for (const [prefix, version] of [[root, "1.0.0"], [stage, "2.0.0"]] as const) {
    mkdirSync(join(prefix, "node_modules", name), { recursive: true, mode: 0o700 });
    writeFileSync(manifest(prefix), JSON.stringify({ name, version }), { mode: 0o600 });
    writeFileSync(join(prefix, "extensions.json"), JSON.stringify({ extensions: [{ pkg: name, version, spec: name, commands: [] }] }), { mode: 0o600 });
  }
  const identity = (path: string) => {
    const stat = lstatSync(path);
    return { dev: String(stat.dev), ino: String(stat.ino), birth: stat.birthtimeMs };
  };
  writeFileSync(journal, JSON.stringify({ v: 1, root, stage, old, stageIdentity: identity(stage), oldIdentity: identity(root) }), { mode: 0o600 });
  return { journal, version: () => JSON.parse(readFileSync(manifest(root), "utf8")).version as string };
}

/** Exercise the public CLI with npm's own effective config and a reachable registry. */
async function assertOfflineSelfUpdate(assert: typeof strictAssert): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "update-offline-"));
  const requests: string[] = [];
  const server = createServer((req, res) => {
    requests.push(`${req.method} ${req.url}`);
    res.writeHead(401, { "Content-Type": "application/json" }).end('{"error":"authentication required"}');
  });
  const env: NodeJS.ProcessEnv = Object.fromEntries(Object.entries(process.env)
    .filter(([key]) => !/^(?:cotal_|npm_config_|(?:https?_proxy|all_proxy|proxy|no_proxy)$)/i.test(key)));
  Object.assign(env, { HOME: root, USERPROFILE: root, COTAL_HOME: join(root, "cotal"), XDG_CONFIG_HOME: join(root, "config"),
    APPDATA: join(root, "config"), LOCALAPPDATA: join(root, "local"), XDG_RUNTIME_DIR: root,
    npm_config_userconfig: join(root, "user.npmrc"), npm_config_globalconfig: join(root, "global.npmrc"),
    npm_config_prefix: join(root, "prefix"), npm_config_cache: join(root, "cache"),
    COTAL_TELEMETRY: "off", COTAL_NO_UPDATE_CHECK: "1" });
  const entry = join(import.meta.dirname, "../../../bin/dist/cotal.js");
  const run = (extra: NodeJS.ProcessEnv = {}) => new Promise<{ code: string | number; stdout: string; stderr: string }>(resolve => {
    execFile(process.execPath, [entry, "update", "--self"], { cwd: root, env: { ...env, ...extra }, timeout: 30_000 },
      (error, stdout, stderr) => resolve({ code: error?.code ?? (error ? -1 : 0), stdout, stderr }));
  });
  const receipt = join(root, "cotal", "daemon", "service-unit.json");
  try {
    const receiptBytes = JSON.stringify({ v: 1, mechanism: "systemd-user", unit: "cotal-daemon.service",
      unitPath: join(root, "absent.service"), unitSha256: "0".repeat(64), installedAt: "2026-01-01T00:00:00Z" });
    mkdirSync(join(root, ".cotal"), { mode: 0o700 });
    if (process.platform === "linux") {
      // No operating-system unit exists. Reaching activation would refuse this test-only receipt.
      mkdirSync(join(root, "cotal", "daemon"), { recursive: true, mode: 0o700 });
      writeFileSync(receipt, receiptBytes, { mode: 0o600 });
    }
    await new Promise<void>((resolve, reject) => server.once("error", reject).listen(0, "127.0.0.1", resolve));
    env.npm_config_registry = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    for (const extra of [{ npm_config_offline: "true" }, { npm_config_offline: "true" }, {}]) {
      if (!extra.npm_config_offline) writeFileSync(env.npm_config_userconfig!, "offline=true\n");
      const result = await run(extra);
      assert.equal(result.code, 0, result.stdout + result.stderr);
      assert.equal(result.stdout.trim(), "npm is in offline mode. The latest-version check was skipped.");
      assert.equal(result.stderr, "");
      assert.deepEqual(requests, []);
    }
    const promotion = pendingPromotion(join(env.XDG_CONFIG_HOME!, "cotal"));
    assert.equal(promotion.version(), "1.0.0");
    const recovered = await run();
    assert.equal(recovered.code, 0, recovered.stdout + recovered.stderr);
    assert.equal(recovered.stderr, "");
    assert.deepEqual(requests, []);
    assert.equal(promotion.version(), "2.0.0");
    assert.equal(existsSync(promotion.journal), false);
    assert.equal(recovered.stdout.trim(), "Completed an interrupted extension promotion.\nnpm is in offline mode. The latest-version check was skipped.");
    const online = await run({ npm_config_offline: "false" });
    assert.equal(online.code, 1, online.stdout + online.stderr);
    assert.match(online.stderr, /cotal-ai version check failed: npm (?:error|ERR!) code E401/);
    assert.deepEqual(requests, ["GET /cotal-ai"]);
    if (process.platform === "linux") assert.equal(readFileSync(receipt, "utf8"), receiptBytes);
  } finally {
    if (server.listening) await new Promise<void>(resolve => server.close(() => resolve()));
    rmSync(root, { recursive: true, force: true });
  }
}

async function assertOfflineUpdateCheck(assert: typeof strictAssert): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "update-check-offline-"));
  const current = (JSON.parse(readFileSync(join(import.meta.dirname, "../../../bin/package.json"), "utf8")) as { version: string }).version;
  const requests: string[] = [];
  let failRegistry = false;
  const server = createServer((req, res) => {
    requests.push(`${req.method} ${req.url}`);
    if (failRegistry) {
      res.writeHead(500, { "Content-Type": "application/json" }).end('{"error":"upstream unavailable"}');
      return;
    }
    res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({
      name: "cotal-ai",
      "dist-tags": { latest: current },
      versions: { [current]: { name: "cotal-ai", version: current } },
    }));
  });
  const env: NodeJS.ProcessEnv = Object.fromEntries(Object.entries(process.env)
    .filter(([key]) => !/^(?:cotal_|npm_config_|(?:https?_proxy|all_proxy|proxy|no_proxy)$)/i.test(key)));
  Object.assign(env, {
    HOME: root, USERPROFILE: root, COTAL_HOME: join(root, "cotal"), XDG_CONFIG_HOME: join(root, "config"),
    APPDATA: join(root, "config"), LOCALAPPDATA: join(root, "local"), XDG_RUNTIME_DIR: root,
    npm_config_userconfig: join(root, "user.npmrc"), npm_config_globalconfig: join(root, "global.npmrc"),
    npm_config_prefix: join(root, "prefix"), npm_config_cache: join(root, "cache"),
    COTAL_TELEMETRY: "off", COTAL_NO_UPDATE_CHECK: "1", NO_COLOR: "1",
  });
  const entry = join(import.meta.dirname, "../../../bin/dist/cotal.js");
  const runCheck = (flags: string[], extra: NodeJS.ProcessEnv = {}) => new Promise<{ code: string | number; stdout: string; stderr: string }>(resolve => {
    execFile(process.execPath, [entry, "update", "--check", ...flags], { cwd: root, env: { ...env, ...extra }, timeout: 30_000 },
      (error, stdout, stderr) => resolve({ code: error?.code ?? (error ? -1 : 0), stdout, stderr }));
  });
  const offlineWarning = "npm is in offline mode. Update availability is unknown.";
  const offlineRemedy = "Disable npm offline mode for this invocation and repeat update --check if you want a live registry check.";
  try {
    await new Promise<void>((resolve, reject) => server.once("error", reject).listen(0, "127.0.0.1", resolve));
    env.npm_config_registry = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    const extDir = join(env.XDG_CONFIG_HOME!, "cotal", "extensions");
    const manifest = join(extDir, "extensions.json");
    for (const populated of [false, true]) {
      if (populated) {
        mkdirSync(extDir, { recursive: true, mode: 0o700 });
        writeFileSync(manifest, JSON.stringify({
          extensions: [{ pkg: "offline-check-fixture", version: "1.2.3", spec: "offline-check-fixture@1.2.3", commands: [] }],
        }), { mode: 0o600 });
      }
      for (const extra of [{ npm_config_offline: "true" }, {}]) {
        if (!extra.npm_config_offline) writeFileSync(env.npm_config_userconfig!, "offline=true\n");
        else rmSync(env.npm_config_userconfig!, { force: true });

        for (const flags of [[], ["--plain"]]) {
          const text = await runCheck(flags, extra);
          assert.equal(text.code, 4, text.stdout + text.stderr);
          assert.match(text.stdout, /Registry latest:\s+not established/);
          assert.match(text.stdout, /CLI update:\s+unknown/);
          assert.match(text.stdout, populated ? /offline-check-fixture/ : /No extensions in the recorded inventory\./);
          assert.ok(text.stderr.includes(`! ${offlineWarning}`), text.stderr);
          assert.ok(text.stderr.includes(offlineRemedy), text.stderr);
          assert.doesNotMatch(text.stderr, /The registry did not return a valid latest version|unreadable inventory|Check registry access/);
        }

        const json = await runCheck(["--json"], extra);
        assert.equal(json.code, 4, json.stdout + json.stderr);
        assert.equal(json.stderr, "");
        const report = JSON.parse(json.stdout);
        assert.equal(report.outcome, "partial");
        assert.equal(report.completeness, "partial");
        assert.equal(report.result.current, current);
        assert.equal(report.result.latest, null);
        assert.equal(report.result.updateAvailable, null);
        assert.equal(report.result.installationChanged, false);
        assert.equal(report.result.processesRestarted, false);
        assert.equal(report.result.extensions.length, populated ? 1 : 0);
        assert.deepEqual(report.warnings, [{ code: "LATEST_VERSION_UNAVAILABLE", target: null, message: offlineWarning }]);
        assert.deepEqual(report.error, {
          code: "OPERATION_PARTIAL",
          message: "Some update information could not be established.",
          remedy: offlineRemedy,
        });
        assert.deepEqual(requests, []);
      }
    }

    const onlineJson = await runCheck(["--json"], { npm_config_offline: "false" });
    assert.equal(onlineJson.code, 0, onlineJson.stdout + onlineJson.stderr);
    assert.equal(onlineJson.stderr, "");
    const onlineReport = JSON.parse(onlineJson.stdout);
    assert.equal(onlineReport.outcome, "ok");
    assert.equal(onlineReport.completeness, "complete");
    assert.equal(onlineReport.result.latest, current);
    assert.equal(onlineReport.result.updateAvailable, false);
    assert.deepEqual(onlineReport.warnings, []);
    assert.equal(requests.length > 0, true);

    failRegistry = true;
    const registryError = await runCheck(["--json"], { npm_config_offline: "false" });
    assert.equal(registryError.code, 4, registryError.stdout + registryError.stderr);
    const registryReport = JSON.parse(registryError.stdout);
    assert.deepEqual(registryReport.warnings, [{
      code: "LATEST_VERSION_UNAVAILABLE",
      target: null,
      message: "The registry did not return a valid latest version. Update availability is unknown.",
    }]);
    assert.equal(registryReport.error.remedy, "Check registry access and repeat update --check.");
  } finally {
    if (server.listening) await new Promise<void>(resolve => server.close(() => resolve()));
    rmSync(root, { recursive: true, force: true });
  }
}

const counted = countedAssert(strictAssert);
await assertOfflineSelfUpdate(counted.assert as typeof strictAssert);
await assertOfflineUpdateCheck(counted.assert as typeof strictAssert);
emitSentinel({ passed: counted.cells(), failed: 0 });
