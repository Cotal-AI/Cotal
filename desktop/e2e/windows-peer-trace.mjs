import nodeFs from "node:fs";
import { findPackageJSON, syncBuiltinESMExports } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// Debug harness only. No extra connect, read, lock, descriptor operation or product check.
export function installWindowsPeerTrace({ native, pipePath, lockPath, record, fs = nodeFs, stdout = process.stdout }) {
  const connect = native.pipeConnect, readFile = fs.readFileSync, write = stdout.write;
  const connectDescriptor = Object.getOwnPropertyDescriptor(native, "pipeConnect");
  const readDescriptor = Object.getOwnPropertyDescriptor(fs, "readFileSync");
  const writeDescriptor = Object.getOwnPropertyDescriptor(stdout, "write");
  let sequence = 0, attempt = 0, read = 0, completedAttempt = null, pending = "";
  const emit = fields => {
    try { record({ at: new Date().toISOString(), monotonicMs: performance.now(), pid: process.pid, sequence: ++sequence, ...fields }); }
    catch { /* Diagnostics cannot change the client outcome. */ }
  };
  const failed = (phase, error, fields) => {
    try { emit({ phase, ...fields, errorCode: typeof error?.code === "string" && /^[A-Z0-9_]{1,64}$/.test(error.code) ? error.code : null }); }
    catch { /* An unusual error getter is not a client failure. */ }
  };
  if (typeof connect !== "function") {
    emit({ phase: "peer-trace-install-failed", stage: "patch-native", errorCode: "ERR_PEER_TRACE_UNSUPPORTED" });
    return;
  }
  function pipeConnect(...args) {
    if (args[0] !== pipePath) return Reflect.apply(connect, this, args);
    const id = ++attempt;
    let promise;
    try { promise = Reflect.apply(connect, this, args); }
    catch (error) { failed("pipe-connect-error", error, { attempt: id }); throw error; }
    try {
      // Return the original promise, not the observation chain. Both observer branches swallow.
      Promise.prototype.then.call(promise, peer => {
        try {
          completedAttempt = id;
          emit({ phase: "pipe-connected", attempt: id, peer: { pid: peer.pid, birth: peer.birth } });
        } catch { /* Receipt inspection cannot affect resolution. */ }
      }, error => { failed("pipe-connect-error", error, { attempt: id }); });
    } catch { /* Leave even an unsupported promise shape untouched. */ }
    return promise;
  }
  function readFileSync(...args) {
    if (args[0] !== lockPath) return Reflect.apply(readFile, this, args);
    const id = ++read;
    let value;
    try { value = Reflect.apply(readFile, this, args); }
    catch (error) { failed("lock-read-error", error, { read: id, afterAttempt: completedAttempt }); throw error; }
    try {
      const encoding = typeof args[1] === "string" ? args[1] : args[1]?.encoding;
      // This is the actual returned client buffer/string, never a second read. UTF-8
      // text is re-encoded as seen by the client, not claimed as raw disk bytes.
      emit({ phase: "lock-read", read: id, afterAttempt: completedAttempt,
        encoding: encoding ?? null, byteSource: Buffer.isBuffer(value) ? "buffer" : "client-string",
        bytesBase64: (Buffer.isBuffer(value) ? value : Buffer.from(value, encoding || "utf8")).subarray(0, 4096).toString("base64"),
        truncated: (Buffer.isBuffer(value) ? value.length : Buffer.byteLength(value, encoding || "utf8")) > 4096 });
    } catch { /* Observation must not replace a successful read. */ }
    return value;
  }
  function stdoutWrite(...args) {
    try {
      const chunk = args[0];
      if (typeof chunk === "string" || Buffer.isBuffer(chunk) || chunk instanceof Uint8Array) {
        pending += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
        let newline;
        while ((newline = pending.indexOf("\n")) >= 0) {
          const line = pending.slice(0, newline); pending = pending.slice(newline + 1);
          let frame;
          try { frame = JSON.parse(line); } catch { continue; }
          const code = frame?.error?.code;
          const wrapped = code === "OPERATION_UNKNOWN" && frame?.error?.message ===
            `the process answering at ${pipePath} is not the daemon holding ${lockPath}; nothing was sent`;
          if (code === "PEER_NOT_LOCK_OWNER" || wrapped) emit({ phase: "client-refusal", code: "PEER_NOT_LOCK_OWNER",
            ...(wrapped ? { wrappedCode: "OPERATION_UNKNOWN" } : {}), afterAttempt: completedAttempt, afterRead: read || null });
        }
        // Bound transient framing storage. No stdout payload is written to diagnostics.
        if (pending.length > 65536) pending = "";
      }
    } catch { /* Output and its callback still go to the original writer. */ }
    return Reflect.apply(write, this, args);
  }
  const restore = (target, key, wrapper, descriptor) => {
    if (target[key] !== wrapper) return;
    if (descriptor) Object.defineProperty(target, key, descriptor);
    else delete target[key];
  };
  const stop = () => {
    restore(native, "pipeConnect", pipeConnect, connectDescriptor);
    restore(fs, "readFileSync", readFileSync, readDescriptor);
    restore(stdout, "write", stdoutWrite, writeDescriptor);
    syncBuiltinESMExports();
  };
  try {
    native.pipeConnect = pipeConnect;
    fs.readFileSync = readFileSync;
    stdout.write = stdoutWrite;
    syncBuiltinESMExports();
  } catch (error) {
    stop();
    failed("peer-trace-install-failed", error, { stage: "patch-native" });
    return;
  }
  return stop;
}

export async function installWindowsPeerTraceFromContext({ cliPath, pipe, lock, output }) {
  let stage = "resolve-package";
  try {
    if (![cliPath, pipe, lock, output].every(value => typeof value === "string" && value.length > 0)) return;
    // Node 24's package resolver uses import conditions at the client's location.
    // Seat has no require export. Keep its real dist/build layout and module cache.
    const seatPackage = findPackageJSON("@cotal-ai/seat", pathToFileURL(cliPath));
    stage = "import-helper";
    const { loadNativeHelper } = await import(pathToFileURL(join(dirname(seatPackage), "dist/peercred.js")).href);
    stage = "load-native";
    const native = loadNativeHelper();
    stage = "patch-native";
    const stop = installWindowsPeerTrace({ native, pipePath: pipe, lockPath: lock,
      record: receipt => nodeFs.appendFileSync(output, JSON.stringify(receipt) + "\n") });
    if (!stop) return;
    try { nodeFs.appendFileSync(output, JSON.stringify({ phase: "peer-trace-installed", at: new Date().toISOString(), pid: process.pid }) + "\n"); } catch { /* Diagnostic I/O only. */ }
    return stop;
  } catch (error) {
    try {
      const errorCode = typeof error?.code === "string" && /^[A-Z0-9_]{1,64}$/.test(error.code) ? error.code : null;
      if (typeof output === "string") nodeFs.appendFileSync(output, JSON.stringify({ phase: "peer-trace-install-failed", stage, errorCode, at: new Date().toISOString(), pid: process.pid }) + "\n");
    } catch { /* Missing diagnostics cannot prevent the real command from running. */ }
  }
}

// Preserve every other flag verbatim. Only the harness's exact loader coordinate is removed.
export function withoutPeerTraceImport(options, url = import.meta.url) {
  const escaped = url.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return options.replace(new RegExp(`(^|\\s)--import(?:=|\\s+)(?:"${escaped}"|${escaped})(?=\\s|$)`, "g"), "$1");
}

// The orchestrator places this fixed fixture-only context beside the copied helper.
// Importing the module in tests or without that context has no side effects.
const here = dirname(fileURLToPath(import.meta.url));
try {
  const context = JSON.parse(nodeFs.readFileSync(join(here, "windows-peer-context.json"), "utf8"));
  if (typeof process.env.NODE_OPTIONS === "string") {
    const retained = withoutPeerTraceImport(process.env.NODE_OPTIONS);
    if (retained.trim()) process.env.NODE_OPTIONS = retained;
    else delete process.env.NODE_OPTIONS;
  }
  await installWindowsPeerTraceFromContext(context);
} catch { /* Not a configured debug harness process. */ }
