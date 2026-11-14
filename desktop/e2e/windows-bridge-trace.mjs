import fs, { appendFileSync } from "node:fs";
import childProcess from "node:child_process";
import { installWindowsInstallToolTrace } from "./windows-install-tool-trace.mjs";
import { syncBuiltinESMExports } from "node:module";
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// Loaded only by the debug E2E native shell. Observe the actual bridge, not its
// parent environment. No credentials, successful result bodies or prompts are retained.
if (process.argv[2] === "daemon" && process.argv[3] === "desktop") {
  // Native debug shell sets only this loader flag. Do not propagate it into spawned services.
  delete process.env.NODE_OPTIONS;
  await import("./windows-peer-trace.mjs");
  const traceHome = process.env.COTAL_DESKTOP_E2E_TRACE_HOME ?? dirname(fileURLToPath(import.meta.url));
  if (!isAbsolute(traceHome)) throw new Error("E2E trace home must be absolute");
  appendFileSync(join(traceHome, "native-tool-timings.jsonl"), "");
  const output = join(traceHome, "windows-bridge-progress.jsonl");
  const record = data => appendFileSync(output, JSON.stringify({ at: new Date().toISOString(),
    monotonicMs: performance.now(), pid: process.pid, parentPid: process.ppid, ...data }) + "\n");
  installWindowsInstallToolTrace({ childProcess, record });
  const access = fs.accessSync;
  fs.accessSync = function (path, ...args) {
    if (!String(path).includes("desktop-fixture-app")) return access.call(this, path, ...args);
    let error;
    try { return access.call(this, path, ...args); }
    catch (cause) { error = cause; throw cause; }
    finally { record({ phase: "actual-fixture-access", candidate: String(path), errorCode: error?.code ?? null,
      inApplicationRefresh: new Error().stack?.includes("hasNewApplications") ?? false }); }
  };
  syncBuiltinESMExports();
  const { resolveOnPath } = await import(pathToFileURL(join(dirname(process.argv[1]), "../node_modules/@cotal-ai/workspace/dist/index.js")).href);
  const original = process.stdout.write;
  let pending = "";
  process.stdout.write = function (chunk, ...args) {
    pending += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
    let newline;
    while ((newline = pending.indexOf("\n")) >= 0) {
      const line = pending.slice(0, newline); pending = pending.slice(newline + 1);
      let frame;
      try { frame = JSON.parse(line); } catch { continue; }
      if (frame.event === "result") {
        try {
          record({ phase: "bridge-result", ok: frame.ok === true,
            daemonPid: Number.isSafeInteger(frame.result?.pid) ? frame.result.pid : null });
        } catch { /* Missing metadata cannot alter the client's result. */ }
      }
      if (frame.event === "setup-progress") {
        record({ phase: "progress", path: process.env.PATH ?? "", pathExt: process.env.PATHEXT ?? null,
          diagnosticFixtureResolved: resolveOnPath("desktop-fixture-app") ?? null, frame });
      }
    }
    return original.call(this, chunk, ...args);
  };
}
