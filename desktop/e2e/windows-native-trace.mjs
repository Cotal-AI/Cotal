import childProcess from "node:child_process";
import workerThreads from "node:worker_threads";
import { errorMonitor } from "node:events";
import { syncBuiltinESMExports } from "node:module";
import { appendFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// Debug-only native launcher wrapper. Record only fixed tool names, timing and outcomes.
// Return the original spawnSync result without changing arguments, environment or control flow.
const traceHome = process.env.COTAL_DESKTOP_E2E_TRACE_HOME ?? dirname(fileURLToPath(import.meta.url));
if (!isAbsolute(traceHome)) throw new Error("E2E trace home must be absolute");
const output = join(traceHome, "native-tool-timings.jsonl");
// Eagerly create the upload artifact before importing any native entry point.
appendFileSync(output, "");
// Observe the original streams before the shipped native logger wraps them. Keep
// its return value and callback ownership unchanged, including when trace I/O fails.
const daemonOutput = join(traceHome, "daemon-native.log");
let remaining = 64 * 1024;
const capture = text => {
  try {
    const bytes = Buffer.from(text.replace(/eyJ[A-Za-z0-9_.-]*/g, "<redacted>")).subarray(0, remaining);
    appendFileSync(daemonOutput, bytes);
    remaining -= bytes.length;
  } catch { /* Debug output must not change the daemon outcome. */ }
};
capture(`daemon service launch ${new Date().toISOString()}\n`);
for (const stream of [process.stdout, process.stderr]) {
  const write = stream.write;
  stream.write = function (chunk, ...args) {
    if (remaining > 0) {
      try { capture(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8")); }
      catch { /* Preserve native validation and errors for unusual inputs. */ }
    }
    return Reflect.apply(write, this, [chunk, ...args]);
  };
}
// Keep this self-contained so the focused test exercises the injected implementation.
function tapOwnedServiceWorker(threads, monitor, record, workerOutput) {
  function preload(output, constructedAt) {
    const enteredAt = Date.now();
    const cp = require("node:child_process");
    const { threadId } = require("node:worker_threads");
    const { appendFileSync } = require("node:fs");
    const write = (phase, fields = {}) => {
      try {
        appendFileSync(output, JSON.stringify({ at: new Date().toISOString(), phase,
          pid: process.pid, threadId, elapsedMs: Date.now() - enteredAt,
          constructorToEntryMs: enteredAt - constructedAt, ...fields }) + "\n");
      } catch { /* Diagnostics must not affect native calls. */ }
    };
    write("owned-service-worker-entry");
    const original = cp.spawnSync;
    let first = true;
    cp.spawnSync = function (file, ...args) {
      const tool = typeof file === "string" ? file.replaceAll("\\", "/").split("/").at(-1).toLowerCase() : "";
      const fixedTool = ["whoami", "whoami.exe"].includes(tool) ? "whoami"
        : ["powershell", "powershell.exe"].includes(tool) ? "PowerShellREAD_TASK" : undefined;
      if (!fixedTool) return original.call(this, file, ...args);
      const started = Date.now();
      write("owned-service-native-start", { tool: fixedTool,
        ...(first ? { workerEntryToFirstCallMs: started - enteredAt } : {}) });
      first = false;
      const safeCode = (code) => typeof code === "string" && /^(?:E[A-Z0-9_]{1,76})$/.test(code) ? code : undefined;
      try {
        const result = original.call(this, file, ...args);
        write("owned-service-native-end", { tool: fixedTool, callElapsedMs: Date.now() - started,
          status: Number.isInteger(result.status) ? result.status : null, errorCode: safeCode(result.error?.code) });
        return result;
      } catch (error) {
        write("owned-service-native-end", { tool: fixedTool, callElapsedMs: Date.now() - started,
          threw: true, errorCode: safeCode(error?.code) });
        throw error;
      }
    };
    require("node:module").syncBuiltinESMExports();
  }
  const OriginalWorker = threads.Worker;
  threads.Worker = new Proxy(OriginalWorker, {
    construct(target, args, newTarget) {
      const started = Date.now();
      let observed = false;
      let forwarded = args;
      try {
        const [script, options] = args;
        observed = typeof script === "string" && script.includes("daemonStartedByOwnedService") &&
          options?.eval === true && typeof options.workerData?.module === "string" &&
          options.workerData.module.replaceAll("\\", "/").endsWith("/daemon/install.js");
        if (observed && typeof workerOutput === "string") {
          forwarded = [`;(${preload.toString()})(${JSON.stringify(workerOutput)},${started});\n${script}`, ...args.slice(1)];
        }
      } catch { /* Unknown inputs pass through untouched. */ }
      const worker = Reflect.construct(target, forwarded, newTarget);
      // Inspection and diagnostics must never change constructor success or decisions.
      try {
        if (!observed) return worker;
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
}, output);
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
