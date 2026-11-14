import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

assert.equal(process.platform, "win32");
const [sourcePath, receiptPath, output] = process.argv.slice(2);
const source = readFileSync(sourcePath, "utf8");
const match = /const READ_TASK = (\[[\s\S]*?\])\.join\("\\n"\);/.exec(source);
assert.ok(match, "measure the shipped READ_TASK, not a copied script");
const lines = JSON.parse(match[1].replace(/,\s*\]$/, "]"));
const receipt = JSON.parse(readFileSync(receiptPath, "utf8"));
assert.equal(receipt.mechanism, "scheduled-task");
assert.match(receipt.unit, /^cotal-daemon-[A-Za-z0-9-]+$/);
const powershell = join(process.env.SystemRoot, "System32/WindowsPowerShell/v1.0/powershell.exe");
const results = [];
for (const extraImport of [false, true]) {
  const script = ["$clock=[System.Diagnostics.Stopwatch]::StartNew()", ...(extraImport ? ["Import-Module Microsoft.PowerShell.Utility"] : []), ...lines.flatMap((line, index) => [
    `[Console]::Error.WriteLine('STAGE ${index} START ' + $clock.ElapsedMilliseconds)`, line,
    `[Console]::Error.WriteLine('STAGE ${index} END ' + $clock.ElapsedMilliseconds)`,
  ])].join("\n");
  const start = Date.now();
  const result = spawnSync(powershell, ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")], { env: { ...process.env, COTAL_DAEMON_TASK: receipt.unit }, encoding: "utf8", windowsHide: true, timeout: 30_000, maxBuffer: 128 * 1024 });
  // Keep only presence/state and fixed timing markers, not registered executable/arguments.
  let present, state;
  try { const task = JSON.parse(result.stdout.trim()); present = task.present; state = task.state; } catch {}
  results.push({ extraImport, elapsedMs: Date.now() - start, status: result.status, signal: result.signal, code: result.error?.code, present, state, stages: result.stderr.split("\n").filter(line => /^STAGE \d+ (START|END) \d+\r?$/.test(line)) });
  writeFileSync(output, JSON.stringify(results, null, 2));
}
