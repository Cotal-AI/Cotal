// Diagnostic only. Every variant gets a new personal profile and keeps the production reader's
// attempt bounds, parser and error outcome. No output from a failed command becomes an identity.
import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultStartToken } from "../packages/workspace/src/pid.js";
import { coldOsEnvironment } from "./release-cold-environment.mjs";

assert.equal(process.platform, "win32");
const original = childProcess.execFileSync;
const before = { ...process.env };
const replica = Number(process.env.DIAGNOSTIC_REPLICA);
assert([1, 2, 3].includes(replica));
const variants = ["unchanged", "powershell-exit", "console-runtime-exit"];
const order = [...variants.slice(replica - 1), ...variants.slice(0, replica - 1)];
const rows = [];
let reference;
for (const variant of order) {
  const root = mkdtempSync(join(tmpdir(), "win32-exit-diagnostic-"));
  const env = coldOsEnvironment(before);
  for (const name of ["home", "local", "roaming", "tmp"]) mkdirSync(join(root, name));
  Object.assign(env, { HOME: join(root, "home"), USERPROFILE: join(root, "home"), LOCALAPPDATA: join(root, "local"), APPDATA: join(root, "roaming"), TMPDIR: join(root, "tmp"), TMP: join(root, "tmp"), TEMP: join(root, "tmp") });
  for (const key of Object.keys(process.env)) delete process.env[key];
  Object.assign(process.env, env);
  const attempts = [];
  childProcess.execFileSync = function (file, args, options) {
    if (file !== "powershell.exe") return Reflect.apply(original, this, [file, args, options]);
    const query = `[System.Diagnostics.Process]::GetProcessById(${process.pid}).StartTime.ToUniversalTime().ToFileTimeUtc()`;
    assert.equal(args[3], query, "diagnostic query no longer matches the production reader");
    const actual = [...args];
    if (variant === "powershell-exit") actual[3] = query + "; exit 0";
    if (variant === "console-runtime-exit") actual[3] = `[Console]::Out.WriteLine(${query}); [Console]::Out.Flush(); [System.Environment]::Exit(0)`;
    const started = performance.now();
    try {
      const output = Reflect.apply(original, this, [file, actual, options]);
      attempts.push({ timeout: options.timeout, elapsedMs: Math.round(performance.now() - started), returned: true, numericOutput: /^\d{1,20}$/.test(String(output).trim()) });
      return output;
    } catch (error) {
      attempts.push({ timeout: options.timeout, elapsedMs: Math.round(performance.now() - started), returned: false, code: error.code, status: error.status, signal: error.signal, stdoutBytes: Buffer.byteLength(error.stdout ?? ""), stderrBytes: Buffer.byteLength(error.stderr ?? "") });
      throw error;
    }
  };
  syncBuiltinESMExports();
  try {
    const token = defaultStartToken(process.pid);
    const numericToken = token !== undefined && /^\d{1,20}$/.test(token);
    if (numericToken && reference === undefined) reference = token;
    const row = { variant, attempts, numericToken, sameProcessToken: numericToken && token === reference };
    rows.push(row);
    console.log(JSON.stringify(row));
  } finally {
    childProcess.execFileSync = original;
    syncBuiltinESMExports();
    for (const key of Object.keys(process.env)) delete process.env[key];
    Object.assign(process.env, before);
    try { rmSync(root, { recursive: true, force: true }); }
    catch (error) { console.error(JSON.stringify({ diagnosticStateRetained: root, cleanupCode: error.code })); }
  }
}
const result = { head: original("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(), readerSha256: createHash("sha256").update(readFileSync("packages/workspace/src/pid.ts")).digest("hex"), node: process.version, arch: process.arch, replica, order, rows, scope: "Fresh personal profiles; rotated variant order. Shared host/OS cache is not claimed cold. Experimental variants are not production fixes." };
writeFileSync("win-exit-diagnostic.json", JSON.stringify(result, null, 2) + "\n", { flag: "wx" });
if (rows.some((row) => !row.numericToken || !row.sameProcessToken)) process.exitCode = 1;
