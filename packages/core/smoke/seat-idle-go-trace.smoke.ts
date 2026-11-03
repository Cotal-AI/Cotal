/** Native diagnostic opt-ins leave the default workload and non-broker processes unchanged. */
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
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
const profDir = mkdtempSync(join(tmpdir(), "seat-idle-prof-"));
const profFile = join(profDir, "allocs.pb.gz");
for (const cell of ["default", "go-trace", "broker-prof"]) {
  const trace = cell === "go-trace", prof = cell === "broker-prof";
  const result = spawnSync(process.execPath, [...process.execArgv, script,
    "--seats", "2", "--space-size", "1", "--seconds", "1", "--settle", "0", ...(trace ? ["--go-trace"] : []), ...(prof ? ["--broker-prof", profFile] : [])], {
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
  const profRow = /broker allocation profile\s+(.+)/.exec(result.stdout)?.[1] ?? "";
  if (prof) {
    const file = readFileSync(profFile);
    check(file.length > 2 && file[0] === 0x1f && file[1] === 0x8b, "the allocation profile is a gzip pprof file");
    check(profRow.startsWith(`${file.length} bytes, sha256 `), `the report names the written profile: ${profRow}`);
  } else check(profRow === "off", `no allocation profile without the opt-in: ${profRow}`);
  console.log(`  ✓ ${cell}: two native endpoints, ${gc.length} surfaced broker GC records${prof ? `, ${profRow}` : ""}`);
}
rmSync(profDir, { recursive: true, force: true });
assert.equal(assertions, 25);
console.log(`  ${assertions} assertions across three native runs`);
emitSentinel({ passed: 3, failed: 0 });
