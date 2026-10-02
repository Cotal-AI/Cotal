import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendedLogTail, detachedArgs, terminateDetachedWeb, waitForDetachedWeb } from "../src/web.js";

const root = mkdtempSync(join(tmpdir(), "cotal-web-detach-"));
const pidPath = join(root, "web.pid");
const readyPath = join(root, "child.ready");

/** A deliberately SIGTERM-resistant, detached, unref'd fixture child. It still ignores SIGTERM
 *  (that resistance is what this suite tests), but it takes a deadline in milliseconds from its
 *  own first argument and exits on its own once that deadline passes, so a copy that is never
 *  collected by the suite's `finally` reaps itself instead of surviving forever. */
const FIXTURE_DEADLINE_MS = 60_000;
function spawnFixture(readyMarkerPath: string, deadlineMs: number) {
  const child = spawn(process.execPath, [
    "-e",
    `const fs=require("node:fs"); process.on("SIGTERM",()=>{}); fs.writeFileSync(${JSON.stringify(readyMarkerPath)}, "ready"); const deadlineMs=Number(process.argv[1]); setTimeout(()=>process.exit(0), deadlineMs);`,
    String(deadlineMs),
  ], { detached: true, stdio: "ignore" });
  child.unref();
  return child;
}

const child = spawnFixture(readyPath, FIXTURE_DEADLINE_MS);

const alive = (pid: number): boolean => {
  try { process.kill(pid, 0); return true; }
  catch (e) { return (e as NodeJS.ErrnoException).code === "EPERM"; }
};
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

try {
  assert.deepEqual(
    detachedArgs(["--detach", "--space=old", "--server=old:1", "--host", "192.0.2.10", "--port", "8123", "--no-open"], "new", "nats://new:2"),
    ["--host", "192.0.2.10", "--port", "8123", "--space", "new", "--server", "nats://new:2", "--no-open"],
    "equals-form targets are replaced without consuming the following flag",
  );
  assert.deepEqual(
    detachedArgs(["--space", "old", "--server", "old:1", "--detach"], "new", "nats://new:2"),
    ["--space", "new", "--server", "nats://new:2", "--no-open"],
    "split-form targets are replaced and child-only flags are normalized",
  );

  const missing = spawn(join(root, "missing-cotal-binary"), [], { stdio: "ignore" });
  await assert.rejects(
    waitForDetachedWeb(missing, { pidPath, url: "http://127.0.0.1:1/", space: "fixture", timeoutMs: 100 }),
    /failed to start:.*(?:ENOENT|no such file)/i,
    "no-PID spawn failures retain the operating-system cause",
  );

  const logPath = join(root, "web.log");
  const old = "old-attempt\n";
  writeFileSync(logPath, old + "x".repeat(6000), { mode: 0o600 });
  const tail = appendedLogTail(logPath, Buffer.byteLength(old));
  assert.ok(Buffer.byteLength(tail) <= 4096, "attempt diagnostics are capped at 4096 bytes");
  assert.equal(tail.includes("old-attempt"), false, "attempt diagnostics exclude historical bytes");
  // POSIX-only: Windows' fs does not honor mode bits (the file reads back 0o666), so 0o600 privacy is
  // a POSIX concept there — Windows scopes access via ACLs instead. Assert it only where it applies.
  if (process.platform !== "win32") assert.equal(statSync(logPath).mode & 0o777, 0o600, "fixture log is private");

  assert.ok(child.pid, "fixture child has a pid");
  for (let i = 0; i < 100 && !existsSync(readyPath); i++) await sleep(10);
  assert.ok(existsSync(readyPath), "SIGTERM-resistant fixture child became ready");
  writeFileSync(pidPath, String(child.pid));

  const selfReapReadyPath = join(root, "self-reap.ready");
  const selfReapChild = spawnFixture(selfReapReadyPath, 500);
  assert.ok(selfReapChild.pid, "self-reap fixture child has a pid");
  let selfReaped = false;
  for (let i = 0; i < 300 && !selfReaped; i++) {
    await sleep(10);
    selfReaped = !alive(selfReapChild.pid!);
  }
  assert.ok(selfReaped, "a leaked fixture child with a short deadline reaps itself, with no signal sent to it");

  await assert.rejects(
    waitForDetachedWeb(child, {
      pidPath,
      url: "http://127.0.0.1:1/",
      space: "fixture",
      timeoutMs: 100,
    }),
    /did not become HTTP-ready/,
  );
  await terminateDetachedWeb(child, pidPath);
  assert.equal(alive(child.pid!), false, "timeout cleanup escalates and confirms child death");
  assert.equal(existsSync(pidPath), false, "timeout cleanup removes the exact child-owned pidfile");

  writeFileSync(pidPath, "999999");
  await terminateDetachedWeb(child, pidPath);
  assert.equal(readFileSync(pidPath, "utf8"), "999999", "cleanup preserves a replacement pidfile owner");

  console.log("web detach smoke: timeout teardown and pid ownership passed");
} finally {
  if (child.pid && alive(child.pid)) {
    try { process.kill(child.pid, "SIGKILL"); } catch { /* gone */ }
  }
  rmSync(root, { recursive: true, force: true });
}
