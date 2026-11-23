import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import strictAssert from "node:assert/strict";
import { countedAssert, emitSentinel } from "../../../bin/smoke/sentinel.mjs";

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
      assert.equal(result.stdout.trim(), "npm is in offline mode. The latest-version check was skipped; no installed packages were replaced.");
      assert.equal(result.stderr, "");
      assert.deepEqual(requests, []);
    }
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

const counted = countedAssert(strictAssert);
await assertOfflineSelfUpdate(counted.assert as typeof strictAssert);
emitSentinel({ passed: counted.cells(), failed: 0 });
