/** Native diagnostic opt-in leaves the default workload and non-broker processes unchanged. */
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { join } from "node:path";
import { emitSentinel, skipSuite } from "@cotal-ai/smoke-kit";

if (process.platform !== "linux") skipSuite("seat-idle-go-trace requires Linux /proc");
const binary = process.env.NATS_SERVER_BIN ?? "nats-server";
const version = /\d+\.\d+\.\d+/.exec(execFileSync(binary, ["--version"], { encoding: "utf8" }))?.[0];
assert.ok(version, "native broker must identify its version");
if (version !== "2.15.1") skipSuite(`seat-idle-go-trace requires nats-server 2.15.1; found ${version}`);

const script = join(import.meta.dirname, "seat-idle-load.smoke.ts");
let assertions = 0;
const check = (value: unknown, message: string): void => { assert.ok(value, message); assertions++; };
for (const trace of [false, true]) {
  const result = spawnSync(process.execPath, [...process.execArgv, script,
    "--seats", "2", "--space-size", "1", "--seconds", "1", "--settle", "0", ...(trace ? ["--go-trace"] : [])], {
    env: process.env, encoding: "utf8", timeout: 60_000,
  });
  check(!result.error, result.error?.message ?? "harness completed");
  check(result.status === 0, result.stderr);
  check(/seats up \/ failed\s+2 \/ 0/.test(result.stdout), "both native endpoints started");
  check(result.stderr.includes("phase=teardown_end"), "native teardown completed");
  check(new RegExp(`broker Go trace\\s+${trace ? "on" : "off"}`).test(result.stdout), "effective diagnostic mode reported");
  const gc = result.stderr.split("\n").filter(line => /^broker-go utc_epoch_ms=\d+ gc \d+ @/.test(line));
  check(trace ? gc.length > 0 : gc.length === 0, "only the opt-in surfaces native broker GC records");
  check(!/^(gc \d+ @|scav \d+ KiB)/m.test(result.stderr), "other Go processes did not inherit the diagnostic opt-in");
  console.log(`  ✓ ${trace ? "opt-in" : "default"}: two native endpoints, ${gc.length} surfaced broker GC records`);
}
assert.equal(assertions, 14);
console.log(`  ${assertions} assertions across two native runs`);
emitSentinel({ passed: 2, failed: 0 });
