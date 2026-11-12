import childProcess from "node:child_process";
import workerThreads from "node:worker_threads";
import { errorMonitor } from "node:events";
import { syncBuiltinESMExports } from "node:module";
import { appendFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// Debug-only native launcher wrapper. Record only fixed tool names, timing and outcomes.
// Return the original spawnSync result without changing arguments, environment or control flow.
const output = join(dirname(fileURLToPath(import.meta.url)), "native-tool-timings.jsonl");
// Keep this self-contained so the focused test exercises the injected implementation.
function tapOwnedServiceWorker(threads, monitor, record) {
  const OriginalWorker = threads.Worker;
  threads.Worker = new Proxy(OriginalWorker, {
    construct(target, args, newTarget) {
      const started = Date.now();
      const worker = Reflect.construct(target, args, newTarget);
      // Inspection and diagnostics must never change constructor success or decisions.
      try {
        const [script, options] = args;
        if (typeof script !== "string" || !script.includes("daemonStartedByOwnedService") ||
            options?.eval !== true || typeof options.workerData?.module !== "string" ||
            !options.workerData.module.replaceAll("\\", "/").endsWith("/daemon/install.js")) return worker;
        const threadId = worker.threadId;
        const write = (phase, fields = {}) => {
          try {
            record({ at: new Date().toISOString(), phase, pid: process.pid, threadId, elapsedMs: Date.now() - started, ...fields });
          } catch { /* Diagnostic I/O cannot affect the worker's consumer. */ }
        };
        write("owned-service-worker-start");
        worker.on("message", (value) => {
          try {
            if (typeof value === "boolean") write("owned-service-worker-message", { value });
            else if (value && typeof value === "object" &&
                ["owned", "not-owned", "unknown"].includes(value.state) &&
                ["verified", "marker-absent", "identity-differs", "source-marker-absent",
                  "observation-failed", "observation-timeout", "observation-aborted", "worker-failed"].includes(value.reason)) {
              write("owned-service-worker-message", { state: value.state, reason: value.reason });
            }
          } catch { /* Payload inspection must never affect delivery to the consumer. */ }
        });
        // errorMonitor observes without handling or suppressing an unhandled error.
        worker.on(monitor, (error) => {
          try {
            const sanitize = (value) => typeof value === "string" ? value
              .replace(/(?:bearer\s+)[^\s,;]+/gi, "[redacted]")
              .replace(/(?:token|secret|password|credential|authorization|api[_-]?key)\s*[:=]\s*[^\s,;]+/gi, "[redacted]")
              .replace(/(?:https?:\/\/|file:\/\/)[^\s]+/gi, "[redacted]")
              .replace(/[A-Za-z0-9_+\/.=-]{20,}/g, "[redacted]")
              .replace(/[\r\n\x00-\x1f\x7f]/g, " ").slice(0, 160) : undefined;
            write("owned-service-worker-error", {
              error: true, errorName: sanitize(error?.name),
              errorCode: typeof error?.code === "string" && /^ERR_[A-Z_]{1,76}$/.test(error.code)
                ? error.code : sanitize(error?.code), errorMessage: sanitize(error?.message),
            });
          } catch { /* Even unusual error getters must not affect error delivery. */ }
        });
        worker.on("exit", (code) => write("owned-service-worker-exit", {
          exited: true, ...(Number.isInteger(code) ? { exitCode: code } : {}),
        }));
      } catch { /* Leave product behavior intact even if observation cannot attach. */ }
      return worker;
    },
  });
}
tapOwnedServiceWorker(workerThreads, errorMonitor, (record) => {
  appendFileSync(output, JSON.stringify(record) + "\n");
});
appendFileSync(output, JSON.stringify({ at: new Date().toISOString(), phase: "wrapper-start", pid: process.pid }) + "\n");
// Remove only this wrapper's script coordinate before importing the unchanged native entry.
// Node flags and the entry's daemon/serve arguments remain the shipped launcher vector.
process.argv.splice(1, 1);
// selfArgv preserves Node loader flags for the hosted Manager. This preload only records
// its own PATH, never changes discovery, and is absent from release launches.
process.execArgv.push(`--import=${pathToFileURL(join(dirname(fileURLToPath(import.meta.url)), "windows-manager-path.mjs")).href}`);
const original = childProcess.spawnSync;
childProcess.spawnSync = function (file, ...args) {
  const started = Date.now();
  appendFileSync(output, JSON.stringify({ at: new Date(started).toISOString(), tool: basename(file), phase: "start" }) + "\n");
  const result = original.call(this, file, ...args);
  appendFileSync(output, JSON.stringify({ at: new Date().toISOString(), tool: basename(file), phase: "end", elapsedMs: Date.now() - started, status: result.status, signal: result.signal, errorCode: result.error?.code }) + "\n");
  return result;
};
syncBuiltinESMExports();
await import(pathToFileURL(process.argv[1]).href);
