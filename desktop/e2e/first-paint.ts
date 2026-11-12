import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { until } from "./webdriver.js";

/** Preload native capture before launch, so compiler startup cannot hide the white interval. */
export async function observeFirstPaint(repo: string, output: string, env: NodeJS.ProcessEnv) {
  mkdirSync(output, { recursive: true });
  const pidFile = join(output, "pid"), readyFile = join(output, "ready");
  let command: string, args: string[];
  if (process.platform === "darwin") {
    command = join(output, "paint-macos");
    const compile = spawnSync("swiftc", ["-target", `${process.arch === "arm64" ? "arm64" : "x86_64"}-apple-macos13.0`, join(repo, "desktop/e2e/paint-macos.swift"), "-o", command], { env, encoding: "utf8", timeout: 120_000 });
    writeFileSync(join(output, "compile.log"), `${compile.stdout ?? ""}${compile.stderr ?? ""}`);
    assert.equal(compile.status, 0, "native paint sampler compiles before app launch");
    args = [pidFile, readyFile, output];
  } else if (process.platform === "win32") {
    command = "powershell.exe";
    args = ["-NoProfile", "-NonInteractive", "-File", join(repo, "desktop/e2e/paint-windows.ps1"), "-PidFile", pidFile, "-ReadyFile", readyFile, "-OutputDir", output];
  } else {
    command = "/usr/bin/python3"; args = [join(repo, "desktop/e2e/paint-linux.py"), pidFile, readyFile, output];
  }
  const child: ChildProcess = spawn(command, args, { env, stdio: ["ignore", "pipe", "pipe"] });
  child.stdout?.on("data", b => writeFileSync(join(output, "sampler.log"), b, { flag: "a" }));
  child.stderr?.on("data", b => writeFileSync(join(output, "sampler.log"), b, { flag: "a" }));
  let error: Error | undefined; child.on("error", value => { error = value; });
  try {
    await until("native paint sampler ready before launch", async () => {
      assert.ifError(error);
      assert.equal(child.exitCode, null, "native paint sampler remains alive");
      return existsSync(readyFile);
    }, Boolean, 45_000);
  } catch (failure) {
    if (child.exitCode === null) child.kill();
    await until("failed paint sampler exits", async () => child.exitCode !== null || child.signalCode !== null || !!error, Boolean, 10_000);
    throw failure;
  }
  return {
    started(pid: number) { writeFileSync(pidFile, String(pid)); },
    async close() {
      if (!existsSync(pidFile) && child.exitCode === null) child.kill();
      await until("native paint sampler exits", async () => child.exitCode !== null || child.signalCode !== null, Boolean, 50_000);
      writeFileSync(join(output, "sampler-exit.json"), JSON.stringify({ code: child.exitCode, signal: child.signalCode, error: String(error ?? "") }));
    },
  };
}
