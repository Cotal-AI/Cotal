/**
 * Fixture for `broker-teardown.smoke.ts`. Not a suite. Spawns a real `nats-server` through the
 * helper, prints `READY <brokerPid> <storeDir>` so the parent can observe the process it must
 * outlive, and then either returns immediately (`clean`) or idles until it is signalled (`signal`).
 */
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pickFreePort } from "./_free-port.js";
import { SMOKE_BROKER_TOKEN, teardownOnSignal } from "@cotal-ai/smoke-kit";

// `unowned` is the POSITIVE CONTROL: identical in every respect except that it does not take
// ownership, so it reproduces the leak. Without it, the owned cells could pass against a broker that
// was dying for some other reason entirely.
const mode = process.argv[2];
if (mode !== "clean" && mode !== "signal" && mode !== "unowned" && mode !== "release-only") {
  throw new Error(`fixture needs mode "clean", "signal", "unowned", or "release-only", got ${String(mode)}`);
}

const port = await pickFreePort();
const storeDir = mkdtempSync(join(tmpdir(), SMOKE_BROKER_TOKEN));
const broker = spawn("nats-server", ["-js", "-sd", storeDir, "-p", String(port), "-a", "127.0.0.1"], { stdio: "ignore" });
const release = mode === "unowned" ? () => {} : teardownOnSignal(broker, storeDir);

// Give it long enough to actually be running, so "still alive later" is a real observation.
await new Promise((r) => setTimeout(r, 900));
if (broker.exitCode !== null) throw new Error(`fixture: nats-server exited early with ${broker.exitCode}`);
// Its OWN pid matters as much as the broker's. `tsx` runs this in a forked child, and signalling the
// wrapper instead makes THIS process exit with code 13 (unsettled top-level await) and run its exit
// handler, without ever receiving the signal. A cell that signalled the wrapper would therefore be
// grading the exit path while claiming to grade the signal path.
console.log(`READY ${process.pid} ${broker.pid} ${storeDir}`);

if (mode !== "clean" && mode !== "release-only") await new Promise(() => {}); // idle until signalled; the handler does the rest

// The normal path, modelled as a real suite runs it: the suite kills the broker itself and releases
// ownership, then returns. This is NOT decoration. A spawned child holds the parent's event loop
// open, so a suite that left the broker running would never exit at all, and `process.on("exit")`
// would never fire. The exit handler is a backstop for an early return, never the mechanism for the
// normal path, and the existing `finally` teardown is what does that work.
if (mode === "release-only") {
  // A suite that calls ONLY release, with no kill and no rmSync of its own: identical to `clean`
  // except for this branch, so the difference between the two cells is exactly what release does.
  // An explicit exit models the real trap: a broken release leaves the broker running, which would
  // otherwise hold this process's event loop open forever (the same reason `clean` above needs its
  // own kill to ever return) — masking the leak as a hang instead of exposing it as a live orphan.
  // A real suite hits the same shape by way of its test framework's own forced exit after the run.
  release();
  process.exit(0);
} else {
  release();
  broker.kill("SIGTERM");
  await new Promise((r) => setTimeout(r, 300));
  rmSync(storeDir, { recursive: true, force: true });
}
