import "./update-isolation.js";
import strictAssert from "node:assert/strict";
import { chmodSync, statSync } from "node:fs";
import { join } from "node:path";
import { countedAssert, emitSentinel } from "../../../bin/smoke/sentinel.mjs";
import { update, updateRuntime, type UpdateRuntime } from "../src/commands/update.js";

const counted = countedAssert(strictAssert);
const assert: typeof strictAssert = counted.assert as typeof strictAssert;

// npm's explicit offline mode skips the version check after the connector preflight. A restored
// owner-write bit is reported once, apart from package replacement, and a clean retry stays quiet.
if (process.platform !== "win32") {
  const config = join(process.env.XDG_CONFIG_HOME!, "cotal");
  const skipped = "npm is in offline mode. The latest-version check was skipped.";
  const restored = "Restored owner write permission on the Cotal connector configuration; no installed packages were replaced.";
  const run = async () => {
    const lines: string[] = [], errors: string[] = [];
    const rt: UpdateRuntime = { ...updateRuntime, env: {},
      prepareExecution: async () => { throw new Error("offline mode must not stage a replacement"); },
      npm: args => {
        assert.equal(args[0], "view");
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
  chmodSync(config, 0o500);
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
emitSentinel({ passed: counted.cells(), failed: 0 });
