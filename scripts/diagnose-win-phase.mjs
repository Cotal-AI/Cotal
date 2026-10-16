// Diagnostic only: observe the original query's first output, process exit and pipe close.
// Observation past the production deadline never qualifies the production reader.
import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { win32ProcessCreationToken } from "../packages/workspace/src/pid.js";
import { coldOsEnvironment } from "./release-cold-environment.mjs";

assert.equal(process.platform, "win32");
const original = childProcess.execFileSync;
let captured;
childProcess.execFileSync = function (file, args, options) {
  assert.equal(file, "powershell.exe");
  assert.equal(captured, undefined);
  captured = { file, args: [...args], options };
  return "1"; // Capture construction only. This launches nothing and warms no runtime.
};
syncBuiltinESMExports();
try { win32ProcessCreationToken(process.pid); }
finally { childProcess.execFileSync = original; syncBuiltinESMExports(); }
assert(captured && captured.options.timeout === 10_000);
assert.deepEqual(captured.options.stdio, ["ignore", "pipe", "ignore"]);
const root = mkdtempSync(join(tmpdir(), "win32-native-phase-"));
const env = coldOsEnvironment();
for (const name of ["home", "local", "roaming", "tmp"]) mkdirSync(join(root, name));
Object.assign(env, { HOME: join(root, "home"), USERPROFILE: join(root, "home"), LOCALAPPDATA: join(root, "local"), APPDATA: join(root, "roaming"), TMPDIR: join(root, "tmp"), TMP: join(root, "tmp"), TEMP: join(root, "tmp") });
const events = [];
const chunks = [];
const started = performance.now();
let child;
let bytes = 0;
let firstByteMs;
let exit;
let close;
let hardLimit = false;
let forcedStreamClose = false;
let overflow = false;
const elapsed = () => Math.round(performance.now() - started);
const event = (kind, fields = {}) => { const row = { kind, elapsedMs: elapsed(), ...fields }; events.push(row); console.log(JSON.stringify(row)); };
try {
  await new Promise((resolve) => {
    let finished = false;
    let drainTimer;
    const finish = () => {
      if (finished) return;
      finished = true;
      clearTimeout(firstDeadline); clearTimeout(combinedDeadline); clearTimeout(hardDeadline); clearTimeout(drainTimer);
      resolve();
    };
    const firstDeadline = setTimeout(() => event("original-first-deadline", { stdoutBytes: bytes, exitObserved: exit !== undefined }), 10_000);
    const combinedDeadline = setTimeout(() => event("original-combined-budget", { stdoutBytes: bytes, exitObserved: exit !== undefined }), 15_000);
    const hardDeadline = setTimeout(() => {
      hardLimit = true;
      event("diagnostic-hard-limit", { stdoutBytes: bytes, exitObserved: exit !== undefined });
      if (exit === undefined) try { child?.kill("SIGKILL"); } catch (error) { event("kill-error", { code: error.code }); }
      drainTimer = setTimeout(() => {
        forcedStreamClose = true;
        child?.stdout?.destroy();
        event("diagnostic-stream-closed", { exitObserved: exit !== undefined });
        finish();
      }, 2000);
    }, 30_000);
    try {
      child = childProcess.spawn(captured.file, captured.args, { env, stdio: captured.options.stdio });
      event("spawn-returned");
      child.once("spawn", () => event("spawn-event"));
      child.stdout.on("data", (data) => {
        bytes += data.length;
        if (firstByteMs === undefined) { firstByteMs = elapsed(); event("first-stdout-byte", { bytes: data.length }); }
        if (bytes <= 4096) chunks.push(data); else overflow = true;
      });
      child.once("error", (error) => { event("spawn-error", { code: error.code }); finish(); });
      child.once("exit", (code, signal) => { exit = { elapsedMs: elapsed(), code, signal, stdoutBytes: bytes }; event("child-exit", exit); });
      child.once("close", (code, signal) => { close = { elapsedMs: elapsed(), code, signal, stdoutBytes: bytes }; event("child-close", close); finish(); });
    } catch (error) { event("spawn-threw", { code: error.code }); finish(); }
  });
  const output = overflow ? "" : Buffer.concat(chunks).toString("utf8").trim();
  const numericAfterCleanExit = !hardLimit && !forcedStreamClose && exit?.code === 0 && close?.code === 0 && /^\d{1,20}$/.test(output);
  const result = { source: original("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(), readerSha256: createHash("sha256").update(readFileSync("packages/workspace/src/pid.ts")).digest("hex"), node: process.version, arch: process.arch, firstByteMs, exit, close, bytes, hardLimit, forcedStreamClose, overflow, numericAfterCleanExit, initialProductionBoundMet: numericAfterCleanExit && close.elapsedMs <= 10_000, events, scope: "Original captured query/stdio, one fresh profile, no retry/exit/Flush/warmup. Async observer with scheduled30s hard stop; this is not a production repair or qualification." };
  writeFileSync("win-phase-diagnostic.json", JSON.stringify(result, null, 2) + "\n", { flag: "wx" });
  if (!result.initialProductionBoundMet) process.exitCode = 1;
} finally {
  if (exit !== undefined) {
    try { rmSync(root, { recursive: true, force: true }); }
    catch (error) { console.error(JSON.stringify({ diagnosticStateRetained: root, cleanupCode: error.code })); }
  } else console.error(JSON.stringify({ diagnosticStateRetained: root, why: "child exit was not observed" }));
}
