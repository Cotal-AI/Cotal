import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "cvit-"));
const saved = { ...process.env };
try {
  for (const key of Object.keys(process.env)) if (key.startsWith("COTAL_")) delete process.env[key];
  for (const name of ["home", "config", "cotal"]) mkdirSync(join(root, name), { mode: 0o700 });
  Object.assign(process.env, { HOME: join(root, "home"), USERPROFILE: join(root, "home"), XDG_CONFIG_HOME: join(root, "config"), COTAL_HOME: join(root, "cotal"), COTAL_TELEMETRY: "off", COTAL_SKIP_CONNECTOR_SEED: "1" });
  let powershellChecks = 0;
  const originalExecFile = childProcess.execFile;
  if (process.platform === "win32") {
    childProcess.execFile = ((...args: Parameters<typeof childProcess.execFile>) => {
      if (args[0] === "powershell.exe") powershellChecks++;
      return Reflect.apply(originalExecFile, childProcess, args);
    }) as typeof childProcess.execFile;
    syncBuiltinESMExports();
  }
  const { measureComputerVitals } = await import("@cotal-ai/manager");
  const { cpus, totalmem } = await import("node:os");
  const sample = await measureComputerVitals();
  assert.equal(sample.cpu.logicalCount, cpus().length);
  assert.ok(sample.cpu.logicalCount > 0 && sample.cpu.logicalCount <= 4096);
  assert.ok(Number.isFinite(sample.cpu.utilisationPercent) && sample.cpu.utilisationPercent >= 0 && sample.cpu.utilisationPercent <= 100);
  assert.ok(Number.isSafeInteger(sample.cpu.intervalMs) && sample.cpu.intervalMs > 0);
  assert.equal(Object.hasOwn(sample.cpu, "load1"), process.platform !== "win32");
  if (process.platform !== "win32") for (const value of [sample.cpu.load1, sample.cpu.load5, sample.cpu.load15]) assert.ok(typeof value === "number" && Number.isFinite(value) && value >= 0);
  assert.equal(sample.memory.totalBytes, totalmem());
  assert.ok(sample.memory.availableBytes <= sample.memory.totalBytes);
  assert.ok(sample.filesystems.length >= 1 && sample.filesystems.length <= 2);
  for (const fs of sample.filesystems) {
    assert.ok(fs.freeBytes <= fs.totalBytes);
    assert.ok(Buffer.byteLength(fs.mount) <= 1024 && !/\p{Cc}/u.test(fs.mount));
    assert.ok(!fs.mount.includes(root));
    for (const value of [fs.totalBytes, fs.freeBytes]) assert.ok(Number.isSafeInteger(value) && value >= 0);
  }
  for (const value of [sample.memory.totalBytes, sample.memory.availableBytes, sample.uptimeSeconds]) assert.ok(Number.isSafeInteger(value) && value >= 0);
  assert.ok(Number.isFinite(Date.parse(sample.sampledAt)));
  if (process.platform === "win32") {
    const initialChecks = powershellChecks;
    assert.ok(initialChecks >= 1 && initialChecks <= 2);
    await measureComputerVitals();
    assert.equal(powershellChecks, initialChecks, "second heartbeat reuses root classifications");
    childProcess.execFile = originalExecFile;
    syncBuiltinESMExports();
  }
  console.log(JSON.stringify({ platform: process.platform, sample }));
  console.log("computer vitals native acceptance passed");
} finally {
  for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
  Object.assign(process.env, saved);
  rmSync(root, { recursive: true, force: true });
}
