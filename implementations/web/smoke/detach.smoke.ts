import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendedLogTail, detachedArgs, terminateDetachedWeb, waitForDetachedWeb } from "../src/web.js";

const root = mkdtempSync(join(tmpdir(), "cotal-web-detach-"));
const pidPath = join(root, "web.pid");
const readyPath = join(root, "child.ready");
const child = spawn(process.execPath, [
  "-e",
  `const fs=require("node:fs"); process.on("SIGTERM",()=>{}); fs.writeFileSync(${JSON.stringify(readyPath)}, "ready"); setInterval(()=>{}, 1000);`,
], { detached: true, stdio: "ignore" });
child.unref();

const alive = (pid: number): boolean => {
  try { process.kill(pid, 0); return true; }
  catch (e) { return (e as NodeJS.ErrnoException).code === "EPERM"; }
};
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

try {
  assert.deepEqual(
    detachedArgs(["--detach", "--space=old", "--server=old:1", "--port", "8123", "--no-open"], "new", "nats://new:2"),
    ["--port", "8123", "--space", "new", "--server", "nats://new:2", "--no-open"],
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
