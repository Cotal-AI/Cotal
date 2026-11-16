/**
 * A command that waits on another command's installation change says so. The closure barrier makes
 * every command wait while one of them changes the installed connectors or extensions; a wait of a
 * second or more names the holder on stderr, and a shorter one or none prints nothing.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { emitSentinel } from "@cotal-ai/smoke-kit";

const home = process.env.COTAL_CLOSURE_WAIT_HOME ?? mkdtempSync(join(tmpdir(), "cotal-closure-wait-"));
process.env.COTAL_HOME = home;
const { acquireLock } = await import("../src/advisory-lock.js");
const { waitForUpdateClosure } = await import("../src/update-closure.js");

if (process.argv[2] === "wait") {
  const waitedForUpdate = waitForUpdateClosure();
  console.log(JSON.stringify({ waitedForUpdate }));
  process.exit(0);
}

const NOTICE = `waiting for another cotal command (pid ${process.pid}) to finish changing this installation`;

/** Runs the waiter as its own process while this one holds the closure lock for `holdMs`. */
async function waiter(holdMs: number | undefined): Promise<{ code: number | null; stdout: string; stderr: string; ms: number }> {
  const lock = holdMs === undefined ? undefined : acquireLock(join(home, ".update-closure.lock"), { label: "fixture closure writer" });
  const t0 = Date.now();
  const child = spawn(process.execPath, [...process.execArgv, fileURLToPath(import.meta.url), "wait"], {
    env: { ...process.env, COTAL_HOME: home, COTAL_CLOSURE_WAIT_HOME: home }, stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "", stderr = "";
  child.stdout.on("data", (d) => (stdout += d));
  child.stderr.on("data", (d) => (stderr += d));
  const release = lock && setTimeout(() => lock.release(), holdMs);
  try {
    const code = await new Promise<number | null>((resolve, reject) => { child.once("error", reject); child.once("exit", resolve); });
    return { code, stdout, stderr, ms: Date.now() - t0 };
  } finally {
    if (release) clearTimeout(release);
    lock?.release();
  }
}

try {
  const free = await waiter(undefined);
  assert.equal(free.code, 0, free.stderr);
  assert.equal(free.stderr.includes("waiting for"), false, "no holder, no notice");
  assert.deepEqual(JSON.parse(free.stdout), { waitedForUpdate: false });

  const brief = await waiter(300);
  assert.equal(brief.code, 0, brief.stderr);
  assert.equal(brief.stderr.includes("waiting for"), false, "a wait under a second prints nothing");

  const long = await waiter(2_500);
  assert.equal(long.code, 0, long.stderr);
  assert.ok(long.ms >= 2_400, `the waiter stays behind the holder (${long.ms} ms)`);
  assert.equal(long.stderr.split(NOTICE).length - 1, 1, `a wait over a second names the holder once: ${JSON.stringify(long.stderr)}`);
  assert.equal(long.stderr.includes("waiting for a Cotal update"), false, "a writer that is not an update is not called one");
  assert.deepEqual(JSON.parse(long.stdout), { waitedForUpdate: false });
  console.log("update-closure-wait.smoke: 3 waits passed (free, brief, announced)");
  emitSentinel({ passed: 3, failed: 0 });
} finally {
  rmSync(home, { recursive: true, force: true });
}
