import { syncBuiltinESMExports } from "node:module";
import { win32 } from "node:path";

// Debug E2E only. Never retain command lines, environment, or unfiltered output.
const suspicious = /https?:\/\/|\beyJ[A-Za-z0-9_-]*\.|(?:secret|token|password|authorization|credential|api[_-]?key)\b|[A-Za-z0-9_+/-]{48,}|\b[A-Za-z_][\w-]*\s*=\s*\S|[=:]\s*["']?\S{24,}/i;
function safeText(value) {
  if (typeof value !== "string" || value.length > 65536) return null;
  return value.split(/\r?\n/).filter(line => !suspicious.test(line) && !/[\x00-\x08\x0e-\x1f]/.test(line))
    .join("\n").slice(0, 512);
}
const atom = value => typeof value === "string" && /^[A-Za-z0-9_ .-]{1,64}$/.test(value) ? value : null;
const bytes = value => typeof value === "string" ? Buffer.byteLength(value) : Buffer.isBuffer(value) ? value.length : null;
function taskOutput(stdout) {
  if (bytes(stdout) > 65536) return null;
  const parsed = JSON.parse(String(stdout).replace(/^\uFEFF/, ""));
  if (!parsed || typeof parsed !== "object" || typeof parsed.present !== "boolean") return null;
  const task = {};
  for (const key of ["present", "state", "actions", "execute", "arguments", "workingDirectory", "userId", "logonType", "runLevel", "enabled", "instances"]) {
    const value = parsed[key];
    if (typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value)) || value === null) task[key] = value;
    else if (typeof value === "string") task[key] = safeText(value);
  }
  return task;
}
function stage(tool, args) {
  if (!Array.isArray(args)) return "native-call";
  if (tool === "whoami.exe") return args.length === 4 && args.every((v, i) => v === ["/user", "/fo", "csv", "/nh"][i]) ? "sid" : "native-call";
  if (tool === "schtasks.exe") {
    const verb = typeof args[0] === "string" ? args[0].toLowerCase() : "";
    return ["/query", "/create", "/delete", "/change", "/run", "/end"].includes(verb) ? `task-${verb.slice(1)}` : "native-call";
  }
  const index = args.indexOf("-EncodedCommand");
  if (index >= 0 && typeof args[index + 1] === "string" && args[index + 1].length < 32768) {
    const script = Buffer.from(args[index + 1], "base64").toString("utf16le");
    if (script.includes("Get-ScheduledTask") && script.includes("$env:COTAL_DAEMON_TASK") && script.includes("ConvertTo-Json")) return "read-task";
  }
  return "native-call";
}
export function installWindowsInstallToolTrace({ childProcess, record }) {
  const original = childProcess.spawnSync;
  let sequence = 0;
  const emit = data => { try { record(data); } catch { /* Logging is passive. */ } };
  childProcess.spawnSync = function (...args) {
    let tool, label, id, started;
    try {
      tool = typeof args[0] === "string" ? win32.basename(args[0]).toLowerCase() : "";
      if (!["whoami.exe", "powershell.exe", "schtasks.exe"].includes(tool)) tool = null;
      if (tool) {
        label = stage(tool, args[1]); id = ++sequence; started = performance.now();
        emit({ phase: "install-tool-start", id, tool, stage: label });
      }
    } catch { tool = null; }
    let result, thrown;
    try { result = Reflect.apply(original, this, args); return result; }
    catch (error) { thrown = error; throw error; }
    finally {
      if (tool) try {
        const error = thrown ?? result?.error;
        const fields = { phase: "install-tool-end", id, tool, stage: label, durationMs: performance.now() - started,
          status: Number.isInteger(result?.status) ? result.status : null, signal: atom(result?.signal),
          errorCode: atom(error?.code), syscall: atom(error?.syscall),
          stdoutBytes: bytes(result?.stdout), stderrBytes: bytes(result?.stderr),
          nativeError: safeText(Buffer.isBuffer(result?.stderr) ? result.stderr.toString("utf8") : result?.stderr),
          errorText: safeText(error?.message) };
        if (label === "read-task") { try { fields.task = taskOutput(result?.stdout); } catch { fields.task = null; } }
        emit(fields);
      } catch { /* Inspection, including hostile getters, must not alter the call. */ }
    }
  };
  syncBuiltinESMExports();
}
