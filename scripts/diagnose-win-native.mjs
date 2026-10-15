// Diagnostic only: observe the real reader and preserve its original result, including failure.
import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";

assert.equal(process.platform, "win32");
const original = childProcess.execFileSync;
console.log(JSON.stringify({ node: process.version, arch: process.arch, head: original("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(), readerSha256: createHash("sha256").update(readFileSync("packages/workspace/src/pid.ts")).digest("hex"), diagnostic: "real cold suite; unchanged original reader result; immediate retry measured only after a real timeout" }));
let call = 0;
const describe = (error) => ({ code: error.code, status: error.status, signal: error.signal, stdoutBytes: Buffer.byteLength(error.stdout ?? ""), stderrBytes: Buffer.byteLength(error.stderr ?? "") });
childProcess.execFileSync = function (file, args, options) {
  if (file !== "powershell.exe") return Reflect.apply(original, this, [file, args, options]);
  const index = ++call, started = performance.now();
  try {
    const result = Reflect.apply(original, this, [file, args, options]);
    console.log(JSON.stringify({ call: index, elapsedMs: Math.round(performance.now() - started), timeout: options?.timeout, succeeded: true, numericToken: /^\d{1,20}$/.test(String(result).trim()) }));
    return result;
  } catch (error) {
    console.log(JSON.stringify({ call: index, elapsedMs: Math.round(performance.now() - started), timeout: options?.timeout, succeeded: false, ...describe(error) }));
    if (error.code === "ETIMEDOUT") {
      const retry = performance.now();
      try {
        const result = Reflect.apply(original, this, [file, args, { ...options, timeout: 5000 }]);
        console.log(JSON.stringify({ diagnosticImmediateRetry: index, elapsedMs: Math.round(performance.now() - retry), succeeded: true, numericToken: /^\d{1,20}$/.test(String(result).trim()), originalFailurePreserved: true }));
      } catch (retryError) {
        console.log(JSON.stringify({ diagnosticImmediateRetry: index, elapsedMs: Math.round(performance.now() - retry), succeeded: false, ...describe(retryError), originalFailurePreserved: true }));
      }
    }
    throw error;
  }
};
syncBuiltinESMExports();
try {
  await import("../packages/workspace/smoke/win32-creation-native.smoke.ts");
} catch (error) {
  console.error(JSON.stringify({ nativeSuiteFailed: true, code: error.code, assertion: error.code === "ERR_ASSERTION" ? error.message : undefined }));
  process.exitCode = 1;
} finally {
  childProcess.execFileSync = original;
  syncBuiltinESMExports();
}
