import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runEndpointCallerCLI, type EndpointCallerCLIInput, type EndpointCallerCLIResult } from "./endpoint-caller-child.js";

// Test-first expectations for the existing helper, not implemented production fields or a mock.
// These real Node children need neither Cotal authority nor a broker. Every runnable child has
// a finite self-exit fallback. Output is at most 4096 bytes per stream, never an unbounded flood.
interface RequiredInput extends EndpointCallerCLIInput {
  timeoutMs: number;
  closeWaitMs: number;
  maxOutputBytes: number;
  signal?: AbortSignal;
}
interface RequiredResult extends EndpointCallerCLIResult {
  closeObserved: boolean;
  killAttempted: boolean;
  killAccepted: boolean | null;
  terminationReason: null | "timeout" | "cancelled" | "stdout-limit" | "stderr-limit";
  stdoutBytes: number;
  stderrBytes: number;
  spawnError: null | { code: string; message: string };
}
const root = mkdtempSync(join(tmpdir(), "endpoint-known-child-controls-"));
const limit = 1024;
const fallbackMs = 1000;
const checks: { name: string; passed: boolean; outcome: unknown; error?: string }[] = [];
const reportPath = process.env.ENDPOINT_CHILD_REPORT;
let attempted = 0;
let failed = 0;

function child(name: string, body: string, hold = false): string {
  const path = join(root, `${name}.mjs`);
  // setTimeout before the body, so cancellation/timeout/overflow failures in the old helper
  // still end this exact child without a process scan or an unowned termination.
  const timer = `setTimeout(() => process.exit(0), ${fallbackMs})${hold ? "" : ".unref()"};\n`;
  writeFileSync(path, timer + body + "\n", { mode: 0o600 });
  return path;
}
function input(cli: string, extra: Partial<RequiredInput> = {}): RequiredInput {
  return { cwd: root, env: { PATH: process.env.PATH, HOME: root }, cli,
    timeoutMs: 5000, closeWaitMs: 1000, maxOutputBytes: limit, ...extra };
}
async function invoke(options: RequiredInput): Promise<RequiredResult> {
  // Extra fields are intentional test expectations. The carried helper remains byte-identical
  // to its reviewed defective implementation until these controls establish actual CI RED.
  return await runEndpointCallerCLI(options, []) as RequiredResult;
}
async function cell(name: string, run: (retain: (outcome: unknown) => void) => Promise<void>): Promise<void> {
  attempted++;
  let outcome: unknown = null;
  try {
    await run(value => { outcome = value; });
    checks.push({ name, passed: true, outcome });
    console.log(`PASS ${name}`);
  } catch (error) {
    failed++;
    if (error instanceof assert.AssertionError) error.message = `${name}: ${error.message}`;
    const cause = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    checks.push({ name, passed: false, outcome, error: cause });
    // These fixtures emit only the finite literals written above, never login or authority data.
    // Retain true child results in CI even when the optional private report path is not selected.
    console.error(`CHILD OUTCOME ${name}: ${JSON.stringify(outcome)}`);
    console.error(`FAIL ${name}: ${cause}`);
  }
}
function cleanClose(result: RequiredResult): void {
  assert.equal(result.code, 0);
  assert.equal(result.signal, null);
  assert.equal(result.timedOut, false);
  assert.equal(result.closeObserved, true, "the exact child's close event must be observed");
  assert.equal(result.killAttempted, false);
  assert.equal(result.killAccepted, null);
  assert.equal(result.terminationReason, null);
  assert.equal(result.spawnError, null);
}
function terminated(result: RequiredResult, reason: RequiredResult["terminationReason"]): void {
  assert.equal(result.code, null, "a killed child must not be recast as exit zero");
  assert.equal(result.signal, "SIGKILL");
  assert.equal(result.timedOut, reason === "timeout");
  assert.equal(result.killAttempted, true);
  assert.equal(result.killAccepted, true, "record the exact owned handle's kill result");
  assert.equal(result.closeObserved, true, "termination must retain the final close observation");
  assert.equal(result.terminationReason, reason);
  assert.equal(result.spawnError, null);
}

try {
  await cell("CH00-existing-real-child-entry-positive-control", async retain => {
    const result = await invoke(input(child("entry", 'process.stdout.write("known-child-entry");')));
    retain(result);
    assert.equal(result.code, 0);
    assert.equal(result.signal, null);
    assert.equal(result.timedOut, false);
    assert.equal(result.stdout, "known-child-entry");
    assert.equal(result.stderr, "");
  });
  await cell("CH01-real-success-preserves-output-and-final-close", async retain => {
    const result = await invoke(input(child("success", 'process.stdout.write("child-out"); process.stderr.write("child-err");')));
    retain(result);
    assert.equal(result.stdout, "child-out");
    assert.equal(result.stderr, "child-err");
    cleanClose(result);
    assert.equal(result.stdoutBytes, 9);
    assert.equal(result.stderrBytes, 9);
  });
  await cell("CH02-real-nonzero-exit-is-not-success", async retain => {
    const result = await invoke(input(child("nonzero", 'process.stderr.write("finite known error"); process.exitCode = 7;')));
    retain(result);
    assert.equal(result.code, 7);
    assert.equal(result.signal, null);
    assert.equal(result.stderr, "finite known error");
    assert.equal(result.timedOut, false);
    assert.equal(result.closeObserved, true);
    assert.equal(result.killAttempted, false);
    assert.equal(result.spawnError, null);
  });
  await cell("CH03-labelled-failed-spawn-retains-error-and-close", async retain => {
    // Labelled real fault injection: a nonexistent executable under this owned temp directory.
    // It starts no child. No PATH substitution, mock, registry mutation or external process.
    let result: RequiredResult | undefined;
    try {
      result = await invoke(input(child("unreachable", ""), { node: join(root, "known-nonexistent-node") }));
      retain(result);
    } catch (error) {
      retain({ rejected: true, code: (error as NodeJS.ErrnoException).code,
        message: error instanceof Error ? error.message : String(error) });
      assert.fail(`failed spawn must retain its close/error result, not discard custody: ${(error as NodeJS.ErrnoException).code}`);
    }
    assert.ok(result, "failed spawn must return its recorded outcome");
    assert.equal(result.spawnError?.code, "ENOENT");
    assert.match(result.spawnError!.message, /known-nonexistent-node/);
    assert.ok(typeof result.code === "number" && result.code < 0,
      "the actual negative failed-spawn close code is retained, never normalized to success");
    assert.equal(result.signal, null);
    assert.equal(result.closeObserved, true);
    assert.equal(result.killAttempted, false);
    assert.equal(result.killAccepted, null);
    assert.equal(result.timedOut, false);
  });
  await cell("CH04-real-timeout-kills-owned-child-and-waits-close", async retain => {
    const result = await invoke(input(child("timeout", 'process.stdout.write("finite-timeout-child");', true), { timeoutMs: 100 }));
    retain(result);
    terminated(result, "timeout");
  });
  await cell("CH05-real-cancellation-after-child-ready-waits-close", async retain => {
    const ready = join(root, "cancel-ready");
    const controller = new AbortController();
    const cli = child("cancel", `import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(ready)}, "ready", { mode: 0o600 });`, true);
    let sawReady = false;
    const watcher = setInterval(() => {
      if (existsSync(ready)) { sawReady = true; controller.abort("known-child-control-cancel"); }
    }, 10);
    try {
      const result = await invoke(input(cli, { signal: controller.signal }));
      retain({ ...result, sawReady });
      assert.equal(sawReady, true, "cancellation is requested only after this exact child starts");
      assert.equal(readFileSync(ready, "utf8"), "ready");
      terminated(result, "cancelled");
    } finally { clearInterval(watcher); }
  });
  await cell("CH06-finite-stdout-overflow-is-byte-bounded-and-reaped", async retain => {
    // 1365 Euro signs are 4095 UTF-8 bytes. The test also catches a clipped partial character
    // being decoded to a replacement whose serialized bytes would exceed the 1024-byte cap.
    const result = await invoke(input(child("stdout", 'process.stdout.write("€".repeat(1365));', true)));
    retain(result);
    assert.ok(Buffer.byteLength(result.stdout, "utf8") <= limit, "retained stdout exceeds its byte budget");
    assert.ok(result.stdoutBytes > limit && result.stdoutBytes <= 4095, "actual observed byte count retained");
    terminated(result, "stdout-limit");
  });
  await cell("CH07-finite-stderr-overflow-is-byte-bounded-and-reaped", async retain => {
    const result = await invoke(input(child("stderr", 'process.stderr.write("E".repeat(4096));', true)));
    retain(result);
    assert.ok(Buffer.byteLength(result.stderr, "utf8") <= limit, "retained stderr exceeds its byte budget");
    assert.ok(result.stderrBytes > limit && result.stderrBytes <= 4096, "actual observed byte count retained");
    terminated(result, "stderr-limit");
  });
  const windows = process.platform === "win32";
  await cell(windows
    ? "CH08-real-windows-self-termination-retains-code-one-and-null-signal"
    : "CH08-real-signal-exit-retains-null-code-and-true-signal", async retain => {
    const result = await invoke(input(child("signal", 'process.kill(process.pid, "SIGTERM");')));
    retain(result);
    // Windows self-termination reports exit 1 without a POSIX signal. Keep the observed result.
    assert.equal(result.code, windows ? 1 : null);
    assert.equal(result.signal, windows ? null : "SIGTERM");
    assert.equal(result.timedOut, false);
    assert.equal(result.closeObserved, true);
    assert.equal(result.closeWaitExpired, false);
    assert.equal(result.killAttempted, false);
    assert.equal(result.killAccepted, null);
    assert.equal(result.killError, null);
    assert.equal(result.terminationReason, null);
    assert.equal(result.spawnError, null);
    assert.equal(result.childError, null);
  });
  await cell("CH09-exact-stream-byte-budgets-do-not-trigger-overflow", async retain => {
    const result = await invoke(input(child("boundary", 'process.stdout.write("O".repeat(1024)); process.stderr.write("E".repeat(1024));')));
    retain(result);
    assert.equal(Buffer.byteLength(result.stdout, "utf8"), limit);
    assert.equal(Buffer.byteLength(result.stderr, "utf8"), limit);
    cleanClose(result);
    assert.equal(result.stdoutBytes, limit);
    assert.equal(result.stderrBytes, limit);
  });
  assert.equal(attempted, 10, "all ten focused controls must be reached");
  console.log(`endpoint-caller-child-controls.smoke: ${attempted - failed}/${attempted} passed`);
  if (reportPath) writeFileSync(reportPath, JSON.stringify({ scope: "finite-real-known-child-helper-controls",
    attempted, failed, checks, authenticatedCLI: false, broker: false, faultInjection: "CH03 nonexistent owned executable only",
    finiteOutputBytesPerStream: 4096, requestedRetainedBytesPerStream: limit, selfExitFallbackMs: fallbackMs }, null, 2) + "\n", { mode: 0o600 });
  if (failed) process.exitCode = 1;
} finally {
  rmSync(root, { recursive: true, force: true });
}
