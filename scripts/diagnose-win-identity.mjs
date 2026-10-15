import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir, release } from "node:os";
import { join } from "node:path";
assert.equal(process.platform, "win32");
const root = mkdtempSync(join(tmpdir(), "win-identity-diagnostic-"));
try {
  const source = readFileSync(new URL("release-cold-setup.mjs", import.meta.url), "utf8");
  const matches = [...source.matchAll(/for \(const key of (\[[^\]]+\])\)/g)];
  assert.equal(matches.length, 1);
  const cold = {};
  for (const key of JSON.parse(matches[0][1])) if (process.env[key] !== undefined) cold[key] = process.env[key];
  const home = join(root, "home"), temp = join(root, "tmp");
  mkdirSync(home); mkdirSync(temp);
  Object.assign(cold, { HOME: home, USERPROFILE: home, COTAL_HOME: join(home, ".cotal"), XDG_CONFIG_HOME: join(home, "xdg"), APPDATA: join(home, "AppData/Roaming"), LOCALAPPDATA: join(home, "AppData/Local"), TMPDIR: temp, TMP: temp, TEMP: temp, NO_COLOR: "1" });
  const extended = { ...cold };
  for (const key of ["SystemDrive", "ProgramFiles", "ProgramFiles(x86)", "ProgramW6432", "CommonProgramFiles", "CommonProgramFiles(x86)", "CommonProgramW6432", "PSModulePath"])
    if (process.env[key] !== undefined) extended[key] = process.env[key];
  console.log(JSON.stringify({ platform: process.platform, arch: process.arch, node: process.version, os: release() }));
  const ps = `(Get-Process -Id ${process.pid} -ErrorAction Stop).StartTime.ToUniversalTime().ToFileTimeUtc()`;
  const dotnet = `[System.Diagnostics.Process]::GetProcessById(${process.pid}).StartTime.ToUniversalTime().ToFileTimeUtc()`;
  for (const [label, env] of [["runner", process.env], ["cold", cold], ["cold-plus-os", extended]]) {
    for (const [kind, command] of [["cmdlet", ps], ["dotnet", dotnet]]) {
      for (const executable of ["powershell.exe", "pwsh.exe"]) {
        const start = performance.now();
        const r = spawnSync(executable, ["-NoProfile", "-NonInteractive", "-Command", command], { env, encoding: "utf8", timeout: 15_000, maxBuffer: 1024 * 1024 });
        console.log(JSON.stringify({ label, kind, executable, elapsedMs: Math.round(performance.now() - start), status: r.status, signal: r.signal, error: r.error?.message, stdout: r.stdout?.trim(), stderr: r.stderr?.trim() }));
      }
    }
  }
} finally { rmSync(root, { recursive: true, force: true }); }
