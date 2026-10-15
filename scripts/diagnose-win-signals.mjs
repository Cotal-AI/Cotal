import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

assert.equal(process.platform, "win32", "native Windows diagnostic only");
if (process.argv[2] === "child") {
  const finish = () => { writeFileSync(process.argv[3], "handler-ran"); process.exit(0); };
  process.on("SIGTERM", finish);
  process.on("message", finish);
  setInterval(() => {}, 1000);
  process.send("ready");
} else {
  const root = mkdtempSync(join(tmpdir(), "win-stop-observe-"));
  try {
    for (const mode of ["ipc-control", "process-kill-sigterm"]) {
      const marker = join(root, mode);
      const child = spawn(process.execPath, [fileURLToPath(import.meta.url), "child", marker], { stdio: ["ignore", "ignore", "ignore", "ipc"] });
      const exit = new Promise((resolve, reject) => { child.once("error", reject); child.once("exit", (code, signal) => resolve({ code, signal })); });
      try {
        await new Promise((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error("child readiness timed out")), 5000);
          child.once("error", reject);
          child.once("message", (message) => { clearTimeout(timer); assert.equal(message, "ready"); resolve(); });
        });
        if (mode === "ipc-control") child.send("stop");
        else process.kill(child.pid, "SIGTERM");
        const result = await exit;
        const handlerRan = existsSync(marker);
        assert.equal(handlerRan, mode === "ipc-control", "compare a reachable cleanup handler with the real Windows signal path");
        console.log(JSON.stringify({ mode, ...result, handlerRan, native: true }));
      } finally {
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
        await exit;
      }
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
