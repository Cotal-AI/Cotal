/** Exercise the real daemon on a private, exhausted Linux tmpfs. */
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { skipSuite } from "@cotal-ai/smoke-kit";

const namespace = ["-Urmpf", "--kill-child", "--mount-proc"];
const env = { PATH: process.env.PATH, DO_NOT_TRACK: "1" };
if (process.platform !== "linux") skipSuite("daemon-disk-full: Linux only");
const probe = spawnSync("unshare", [...namespace, "true"], { env, timeout: 5000, killSignal: "SIGKILL" });
if (probe.error && (probe.error as NodeJS.ErrnoException).code !== "ENOENT") throw probe.error;
if (probe.status !== 0) skipSuite("daemon-disk-full: unprivileged mount/PID namespace unavailable");

const disk = mkdtempSync(join(realpathSync(tmpdir()), "ddf-"));
const scenario = fileURLToPath(new URL("./_fixture-daemon-disk-full.mjs", import.meta.url));
try {
  const runner = spawn("unshare", [...namespace, "sh", "-ec", `
    mount -t tmpfs -o size=8m,mode=0700 tmpfs "$1"
    exec "$2" "$3" "$1"
  `, "daemon-disk-full", disk, process.execPath, scenario], { env, stdio: "inherit", detached: true });
  const kill = () => { runner.kill("SIGKILL"); };
  const timer = setTimeout(() => { console.error("daemon-disk-full: scenario timed out"); kill(); }, 120_000);
  const signal = () => { process.exitCode = 1; kill(); };
  process.once("SIGINT", signal);
  process.once("SIGTERM", signal);
  try {
    const code = await new Promise<number | null>((resolve, reject) => {
      runner.once("error", reject);
      runner.once("close", resolve);
    });
    if (code !== 0) process.exitCode = 1;
  } finally {
    clearTimeout(timer);
    process.off("SIGINT", signal);
    process.off("SIGTERM", signal);
  }
} finally {
  rmSync(disk, { recursive: true, force: true });
}
