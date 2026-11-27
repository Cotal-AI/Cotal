import { spawn } from "node:child_process";
import { closeSync, readSync } from "node:fs";
import { constants as osConstants } from "node:os";

// Read the framed non-identifier environment block from inherited descriptor 4 and close it
// before loading or spawning the target so values never enter argv and descriptor 4 never leaks.
function readEnvPipe(fd: number): Buffer {
  const chunks: Buffer[] = [];
  const scratch = Buffer.allocUnsafe(65536);
  try {
    for (;;) {
      try {
        const count = readSync(fd, scratch, 0, scratch.length, null);
        if (count === 0) break;
        chunks.push(Buffer.from(scratch.subarray(0, count)));
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "EAGAIN") {
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2);
          continue;
        }
        throw err;
      }
    }
  } finally {
    try { closeSync(fd); } catch { /* already closed */ }
  }
  return Buffer.concat(chunks);
}

function decodeGateEnv(raw: Buffer): [string, string][] {
  if (raw.length < 8) throw new Error("truncated gate environment");
  const count = raw.readUInt32BE(0);
  let offset = 4;
  const entries: [string, string][] = [];
  for (let i = 0; i < count; i++) {
    if (offset + 8 > raw.length) throw new Error("truncated gate environment entry");
    const keyLength = raw.readUInt32BE(offset);
    const valueLength = raw.readUInt32BE(offset + 4);
    offset += 8;
    if (offset + keyLength + valueLength > raw.length) throw new Error("truncated gate environment payload");
    const key = raw.subarray(offset, offset + keyLength).toString("utf8");
    offset += keyLength;
    const value = raw.subarray(offset, offset + valueLength).toString("utf8");
    offset += valueLength;
    entries.push([key, value]);
  }
  if (offset + 4 !== raw.length || raw.readUInt32BE(offset) !== 0xffffffff)
    throw new Error("missing gate environment trailer");
  return entries;
}

function stripSelfExecArgv(): boolean {
  let stripped = false;
  for (let i = process.execArgv.length - 1; i >= 0; i--) {
    const arg = process.execArgv[i]!;
    if (arg === `--import=${import.meta.url}`) {
      process.execArgv.splice(i, 1);
      stripped = true;
    } else if (arg === "--import" && process.execArgv[i + 1] === import.meta.url) {
      process.execArgv.splice(i, 2);
      stripped = true;
    }
  }
  return stripped;
}

function runStage(entries: readonly (readonly [string, string])[]): void {
  const [label, file, ...args] = process.argv.slice(2);
  if (!label || !file) process.exit(1);
  const childEnv: NodeJS.ProcessEnv = { ...process.env };
  delete childEnv.NODE_OPTIONS;
  for (const [key, value] of entries) childEnv[key] = value;
  const inner = spawn(file, args, { env: childEnv, stdio: "inherit", windowsHide: true });
  for (const sig of ["SIGTERM", "SIGINT", "SIGHUP", "SIGQUIT"] as const) {
    process.on(sig, () => {
      if (inner.pid !== undefined) {
        try { process.kill(inner.pid, sig); } catch { /* child already exited */ }
      }
    });
  }
  inner.once("error", err => {
    const code = (err as NodeJS.ErrnoException).code;
    const detail = code === "ENOENT" ? "not found" : code === "EACCES" ? "Permission denied" : err.message;
    process.stderr.write(`${label}: 1: exec: ${file}: ${detail}\n`);
    process.exit(code === "ENOENT" ? 127 : 126);
  });
  inner.once("exit", (exitCode, termSignal) => {
    if (termSignal !== null) {
      // Node ignores SIGPIPE and SIGXFSZ and starts the inspector on SIGUSR1; exit non-zero directly.
      if (termSignal === "SIGPIPE" || termSignal === "SIGXFSZ" || termSignal === "SIGUSR1") {
        const num = osConstants.signals[termSignal as keyof typeof osConstants.signals];
        process.exit(128 + (typeof num === "number" ? num : 1));
      }
      process.removeAllListeners(termSignal);
      process.kill(process.pid, termSignal);
      return;
    }
    process.exit(exitCode ?? 1);
  });
}

function main(): void {
  const preload = stripSelfExecArgv();
  let entries: [string, string][];
  try {
    entries = decodeGateEnv(readEnvPipe(4));
  } catch {
    process.exit(1);
  }
  if (preload) {
    for (const [key, value] of entries) process.env[key] = value;
    return;
  }
  runStage(entries);
}

main();
