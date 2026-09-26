import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertSmokeSandboxDown, awaitBrokerReady, emitSentinel, recordSmokeSandbox } from "../src/index.js";

let checks = 0;
const check = (name: string, run: () => void): void => {
  assert.doesNotThrow(run, name);
  checks++;
  console.log(`  ✓ ${name}`);
};

const base = mkdtempSync(join(tmpdir(), "cotal-smoke-kit-package-"));
try {
  const root = join(base, "root");
  const cotalHome = join(base, "home");
  const xdgConfigHome = join(base, "config");
  const anchor = recordSmokeSandbox({ root, cotalHome, xdgConfigHome });
  const env = { COTAL_HOME: cotalHome, XDG_CONFIG_HOME: xdgConfigHome };
  check("recorded sandbox permits its own down command", () => assertSmokeSandboxDown(anchor, ["down"], { cwd: root, env }));
  assert.throws(() => assertSmokeSandboxDown(undefined, ["down"], { cwd: root, env }), /missing anchor/);
  checks++;
  console.log("  ✓ missing sandbox anchor is refused");
  check("non-destructive commands do not require the down guard", () => assertSmokeSandboxDown(anchor, ["status"], { cwd: root, env }));
} finally {
  rmSync(base, { recursive: true, force: true });
}

{
  let calls = 0;
  await awaitBrokerReady(async () => (++calls === 3), { servers: "nats://127.0.0.1:1", attempts: 5, delayMs: 1 });
  assert.equal(calls, 3);
  checks++;
  console.log("  ✓ awaitBrokerReady resolves once the probe answers true (after two delays)");
}

await (async () => {
  await assert.rejects(
    () => awaitBrokerReady(async () => false, { servers: "nats://127.0.0.1:2", attempts: 4, delayMs: 1 }),
    /nats:\/\/127\.0\.0\.1:2.*4 attempts.*no broker output collected/s,
  );
  checks++;
  console.log("  ✓ awaitBrokerReady throws on exhaustion naming the server and attempt count");
})();

await (async () => {
  await assert.rejects(
    () => awaitBrokerReady(async () => false, { servers: "nats://127.0.0.1:3", attempts: 2, delayMs: 1, output: () => "boot failed: address in use" }),
    /boot failed: address in use/,
  );
  checks++;
  console.log("  ✓ awaitBrokerReady's exhaustion message carries the collected broker output");
})();

await (async () => {
  await assert.rejects(
    () => awaitBrokerReady(async () => false, { servers: "nats://127.0.0.1:4", attempts: 2, delayMs: 1, output: () => "" }),
    /no broker output collected/,
  );
  checks++;
  console.log("  ✓ awaitBrokerReady names \"no broker output collected\" when output() is empty");
})();

console.log(`SMOKE-KIT PACKAGE TESTS: ${checks} tests executed`);
emitSentinel({ passed: checks, failed: 0 });
