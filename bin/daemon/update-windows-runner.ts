/** The scheduled helper owns its job until native accounting proves it empty. */
import { isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";

const home = process.argv[3];
if (process.platform !== "win32" || !home || !isAbsolute(home)) throw new Error("Windows automatic helper needs its exact recorded home");
process.env.COTAL_HOME = home;
const { admitWindowsUpdate, windowsAutomaticPrefix } = await import("./update-windows.js");
const { win32ProcessBinding, windowsCommandLine, windowsEnvironmentBlock, readUpdateSettings, UPDATE_HOUR_MS } = await import("@cotal-ai/workspace");
const { writeSecretFile, writeSecretFileAtomic } = await import("@cotal-ai/core");
const { captureWindowsAutomaticActivation } = await import("./update-windows-activation.js");
const custody = admitWindowsUpdate(process.argv[2] ?? "");
Object.assign(process.env, custody.receipt.env);
const native = win32ProcessBinding();
const attemptPath = join(home, "update-attempt.json");
let launched = false, done = false, drained = false, drainAttempted = false;
let activation: Awaited<ReturnType<typeof captureWindowsAutomaticActivation>> | undefined;
const failed = (error: unknown) => {
  const attempt = JSON.parse(readFileSync(attemptPath, "utf8"));
  writeSecretFileAtomic(attemptPath, `${JSON.stringify({ ...attempt, failures: Math.max(attempt.failures ?? 0, custody.receipt.failures + 1), result: `Windows automatic update refused: ${error instanceof Error ? error.message : String(error)}; retrying automatically`, next: Date.now() + UPDATE_HOUR_MS })}\n`);
  process.exitCode = 1;
};
try {
  const cliEntry = fileURLToPath(new URL("../cotal.js", import.meta.url));
  const prefix = windowsAutomaticPrefix(cliEntry);
  if (custody.receipt.env.npm_config_prefix !== prefix) throw new Error("Windows automatic update destination differs from its owned installation");
  process.argv[1] = cliEntry;
  for (const key of Object.keys(process.env)) if (key.toLowerCase() === "npm_config_prefix") delete process.env[key];
  process.env.npm_config_prefix = prefix;
  if (!readUpdateSettings().auto || process.env.COTAL_NO_UPDATE_CHECK === "1") {
    const attempt = JSON.parse(readFileSync(attemptPath, "utf8"));
    writeSecretFileAtomic(attemptPath, `${JSON.stringify({ ...attempt, result: "automatic updates disabled before Windows handoff", next: Date.now() + UPDATE_HOUR_MS })}\n`);
    done = true; drained = true;
  } else {
    activation = await captureWindowsAutomaticActivation(custody.receipt.nonce);
    const logPath = join(home, "update-attempt.log");
    writeSecretFile(logPath, "");
    const args = [cliEntry, "update", "--self"];
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
    custody.complete(true);
    await activation.activate();
  }
} catch (error) {
  if (!launched) drained = true;
  else if (!drainAttempted) {
    drainAttempted = true;
    try { drained = native.drain(20_000) === "drained"; } catch { /* Completion stays unconfirmed and pauses on owner death. */ }
  }
  if (done) {
    process.stderr.write(`Windows automatic activation failed: ${error instanceof Error ? error.message : String(error)}; release remains installed; use Start service\n`);
    process.exitCode = 1;
  } else failed(error);
} finally {
  activation?.close();
  if (drained) custody.complete(done);
  custody.release();
}
