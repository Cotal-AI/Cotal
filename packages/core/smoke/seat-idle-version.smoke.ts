/** The load harness keeps its default pin and requires an explicit, matching version override. */
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { emitSentinel } from "@cotal-ai/smoke-kit";

const script = join(import.meta.dirname, "seat-idle-load.smoke.ts");
const absent = join(tmpdir(), `absent-nats-version-${randomUUID()}`);
let passed = 0;
function refuses(args: string[], binary: string, expected: string): void {
  const result = spawnSync(process.execPath, [...process.execArgv, script, "--seats", "2", "--seconds", "0", "--settle", "0", ...args], {
    env: { ...process.env, NATS_SERVER_BIN: binary }, encoding: "utf8", timeout: 30_000,
  });
  assert.ifError(result.error);
  assert.equal(result.status, 1);
  assert.ok(result.stderr.includes(expected), result.stderr);
  assert.ok(!result.stderr.includes("phase=setup_done"), "refusal must precede setup");
  passed++;
  console.log(`  ✓ ${expected}`);
}
// An absent binary makes a lost validation guard fail without starting a broker.
refuses(["--server-version"], absent, "--server-version is required");
refuses(["--server-version", "2.15"], absent, "--server-version must be a numeric major.minor.patch version");
refuses(["--server-version", "v2.15.2"], absent, "--server-version must be a numeric major.minor.patch version");
const binary = process.env.NATS_SERVER_BIN ?? "nats-server";
const actual = /\d+\.\d+\.\d+/.exec(execFileSync(binary, ["--version"], { encoding: "utf8" }))?.[0];
assert.ok(actual && actual !== "0.0.0", "native broker must identify its real version");
refuses(["--server-version", "0.0.0"], binary, `this harness measures nats-server 0.0.0; ${binary} is ${actual}`);
assert.equal(passed, 4);
emitSentinel({ passed, failed: 0 });
