import "./update-isolation.js";
import strictAssert from "node:assert/strict";
import { chmodSync, statSync } from "node:fs";
import { join } from "node:path";
import { countedAssert, emitSentinel } from "../../../bin/smoke/sentinel.mjs";
import { update, updateRuntime, type UpdateRuntime } from "../src/commands/update.js";

const counted = countedAssert(strictAssert);
const assert: typeof strictAssert = counted.assert as typeof strictAssert;

// npm's explicit offline mode skips the version check after the connector preflight. A restored
// owner access mode is reported once, apart from package replacement, and a clean retry stays quiet.
if (process.platform !== "win32") {
  const config = join(process.env.XDG_CONFIG_HOME!, "cotal");
  const skipped = "npm is in offline mode. The latest-version check was skipped.";
  const restored = "Restored owner access to the Cotal connector configuration; no installed packages were replaced.";
  const run = async (kind: "offline" | "online" | "missing-npm" | "auth-error" = "offline") => {
    const lines: string[] = [], errors: string[] = [];
    const rt: UpdateRuntime = { ...updateRuntime, env: {}, version: () => "0.183.0", isCurrent: () => true,
      prepareExecution: async () => { throw new Error("no-op self-update must not stage a replacement"); },
      npm: args => {
        assert.equal(args[0], "view");
        if (kind === "online") return { status: 0, stdout: '"0.183.0"', stderr: "" };
        if (kind === "missing-npm") return { status: null, stdout: "", stderr: "", error: "spawnSync npm ENOENT", errorCode: "ENOENT" };
        if (kind === "auth-error") return { status: 1, stdout: '{"error":{"code":"E401","summary":"authentication required"}}', stderr: "npm error code E401" };
        return { status: 1, stdout: '{"error":{"code":"ENOTCACHED"}}', stderr: "npm error code ENOTCACHED" };
      },
      out: line => { lines.push(line); }, err: line => { errors.push(line); },
    };
    const previous = process.exitCode;
    process.exitCode = undefined;
    try {
      await update({ values: { self: true }, positionals: [], raw: ["--self"] }, rt);
      return { code: process.exitCode ?? 0, lines, errors };
    } finally { process.exitCode = previous; }
  };
  for (const mode of [0o500, 0o300]) {
    chmodSync(config, mode);
    const repaired = await run();
    assert.equal(repaired.code, 0, repaired.errors.join("\n"));
    assert.deepEqual(repaired.errors, []);
    assert.deepEqual(repaired.lines, [restored, skipped]);
    assert.equal(statSync(config).mode & 0o777, 0o700);
    const retry = await run();
    assert.equal(retry.code, 0, retry.errors.join("\n"));
    assert.deepEqual(retry.errors, []);
    assert.deepEqual(retry.lines, [skipped]);
  }
  chmodSync(config, 0o500);
  const onlineRepaired = await run("online");
  assert.equal(onlineRepaired.code, 0, onlineRepaired.errors.join("\n"));
  assert.deepEqual(onlineRepaired.errors, []);
  assert.equal(onlineRepaired.lines[0], "Restored owner access to the Cotal connector configuration.");
  assert.equal(statSync(config).mode & 0o777, 0o700);
  const onlineRetry = await run("online");
  assert.equal(onlineRetry.code, 0, onlineRetry.errors.join("\n"));
  assert.deepEqual(onlineRetry.errors, []);
  assert.ok(!onlineRetry.lines.some(line => line.includes("Restored owner access")));
  for (const kind of ["missing-npm", "auth-error"] as const) {
    chmodSync(config, 0o500);
    const failed = await run(kind);
    assert.equal(failed.code, 1);
    assert.deepEqual(failed.lines, ["Restored owner access to the Cotal connector configuration."]);
    assert.equal(failed.errors.length, 1);
    assert.equal(statSync(config).mode & 0o777, 0o700);
  }
}
emitSentinel({ passed: counted.cells(), failed: 0 });
