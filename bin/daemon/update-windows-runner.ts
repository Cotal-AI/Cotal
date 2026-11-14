/** The scheduled helper owns its job until native accounting proves it empty. */
import { isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { closeSync, ftruncateSync, readFileSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";

const home = process.argv[3];
if (process.platform !== "win32" || !home || !isAbsolute(home)) throw new Error("Windows automatic helper needs its exact recorded home");
process.env.COTAL_HOME = home;
const { admitWindowsUpdate } = await import("./update-windows.js");
const { win32ProcessBinding, windowsCommandLine, windowsEnvironmentBlock, readUpdateSettings, UPDATE_HOUR_MS } = await import("@cotal-ai/workspace");
const { openPrivateAppend, writeSecretFileAtomic } = await import("@cotal-ai/core");
const custody = admitWindowsUpdate(process.argv[2] ?? "");
Object.assign(process.env, custody.receipt.env);
const native = win32ProcessBinding();
const attemptPath = join(home, "update-attempt.json");
let launched = false, done = false, drained = false, drainAttempted = false;
const failed = (error: unknown) => {
  const attempt = JSON.parse(readFileSync(attemptPath, "utf8"));
  writeSecretFileAtomic(attemptPath, `${JSON.stringify({ ...attempt, failures: Math.max(attempt.failures ?? 0, custody.receipt.failures + 1), result: `Windows automatic update refused: ${error instanceof Error ? error.message : String(error)}; retrying automatically`, next: Date.now() + UPDATE_HOUR_MS })}\n`);
  process.exitCode = 1;
};
try {
  if (!readUpdateSettings().auto || process.env.COTAL_NO_UPDATE_CHECK === "1") {
    const attempt = JSON.parse(readFileSync(attemptPath, "utf8"));
    writeSecretFileAtomic(attemptPath, `${JSON.stringify({ ...attempt, result: "automatic updates disabled before Windows handoff", next: Date.now() + UPDATE_HOUR_MS })}\n`);
    done = true; drained = true;
  } else {
    const logPath = join(home, "update-attempt.log");
    const log = openPrivateAppend(logPath);
    try { ftruncateSync(log, 0); } finally { closeSync(log); }
    const args = [fileURLToPath(new URL("../cotal.js", import.meta.url)), "update", "--self"];
    native.launch({ application: process.execPath, commandLine: windowsCommandLine(process.execPath, args), cwd: home,
      environment: windowsEnvironmentBlock({ ...process.env, COTAL_AUTO_UPDATE: "1", COTAL_NO_UPDATE_CHECK: "1" }), log: logPath });
    launched = true;
    const deadline = performance.now() + 30 * 60_000;
    let code = native.rootExit();
    while (code === undefined && performance.now() < deadline) { await delay(100); code = native.rootExit(); }
    // No member is trusted to outlive the updater. Drain also covers descendants born late.
    drainAttempted = true;
    if (native.drain(20_000) !== "drained") throw new Error("Windows updater descendants did not drain by the custody deadline");
    drained = true;
    if (code !== 0) throw new Error(`updater exited with ${code ?? "a timeout"}; inspect update-attempt.log`);
    done = true;
  }
} catch (error) {
  if (launched && !drainAttempted) {
    drainAttempted = true;
    try { drained = native.drain(20_000) === "drained"; } catch { /* Completion stays unconfirmed and pauses on owner death. */ }
  }
  failed(error);
} finally {
  if (drained) custody.complete(done);
  custody.release();
}
