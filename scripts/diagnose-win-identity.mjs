import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir, release } from "node:os";
import { join } from "node:path";
assert.equal(process.platform, "win32");
const root = mkdtempSync(join(tmpdir(), "win-identity-direct-first-"));
try {
  const source = readFileSync(new URL("release-cold-setup.mjs", import.meta.url), "utf8");
  const matches = [...source.matchAll(/for \(const key of (\[[^\]]+\])\)/g)];
  assert.equal(matches.length, 1);
  const cold = {};
  for (const key of JSON.parse(matches[0][1])) if (process.env[key] !== undefined) cold[key] = process.env[key];
  const system = { ...cold };
  for (const key of ["SystemDrive", "ProgramFiles", "ProgramFiles(x86)", "ProgramW6432", "CommonProgramFiles", "CommonProgramFiles(x86)", "CommonProgramW6432"])
    if (process.env[key] !== undefined) system[key] = process.env[key];
  const modules = { ...system, PSModulePath: join(process.env.SystemRoot, "System32/WindowsPowerShell/v1.0/Modules") };
  const host = { ...process.env }; delete host.PSModulePath;
  console.log(JSON.stringify({ platform: process.platform, arch: process.arch, node: process.version, os: release(), order: "direct .NET first, distinct empty profile for every query" }));
  let index = 0;
  for (const [label, baseline] of [["original-scrub", cold], ["system-paths", system], ["system-modules", modules], ["host-env-new-profile", host]]) {
    for (const [kind, command] of [["dotnet", `[System.Diagnostics.Process]::GetProcessById(${process.pid}).StartTime.ToUniversalTime().ToFileTimeUtc()`], ["cmdlet", `(Get-Process -Id ${process.pid} -ErrorAction Stop).StartTime.ToUniversalTime().ToFileTimeUtc()`]]) {
      const dir = join(root, String(++index)); mkdirSync(dir);
      for (const name of ["home", "local", "roaming", "tmp"]) mkdirSync(join(dir, name));
      const env = { ...baseline, HOME: join(dir, "home"), USERPROFILE: join(dir, "home"), LOCALAPPDATA: join(dir, "local"), APPDATA: join(dir, "roaming"), TMPDIR: join(dir, "tmp"), TMP: join(dir, "tmp"), TEMP: join(dir, "tmp") };
      const start = performance.now();
      const r = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", command], { env, encoding: "utf8", timeout: 25_000, maxBuffer: 1024 * 1024 });
      console.log(JSON.stringify({ label, kind, elapsedMs: Math.round(performance.now() - start), status: r.status, signal: r.signal, error: r.error?.message, stdout: r.stdout?.trim(), stderr: r.stderr?.trim() }));
    }
  }
} finally { rmSync(root, { recursive: true, force: true }); }
