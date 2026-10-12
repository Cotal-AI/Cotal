import { spawn } from "node:child_process";
import { resolve } from "node:path";

export interface EndpointCallerCLIInput {
  cwd: string;
  env: NodeJS.ProcessEnv;
  node?: string;
  /** A packed entry requires a separately qualified installation witness. Omitted uses source. */
  cli?: string;
  timeoutMs?: number;
  closeWaitMs?: number;
  /** Per-stream retained UTF-8 byte budget, at most 32768. */
  maxOutputBytes?: number;
  signal?: AbortSignal;
}
export interface EndpointCallerCLIResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  closeObserved: boolean;
  closeWaitExpired: boolean;
  killAttempted: boolean;
  killAccepted: boolean | null;
  killError: string | null;
  terminationReason: null | "timeout" | "cancelled" | "stdout-limit" | "stderr-limit" | "child-error";
  stdoutBytes: number;
  stderrBytes: number;
  spawnError: null | { code: string; message: string };
  childError: null | { code: string; message: string };
}

function positive(value: number, maximum: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0 || value > maximum)
    throw new Error(`${name} must be an integer between 1 and ${maximum}`);
  return value;
}
/** Replacement characters from malformed or cut UTF-8 must not expand the retained byte budget. */
function boundedText(bytes: Buffer, limit: number): string {
  let length = 0, end = 0;
  const text = bytes.toString("utf8");
  for (const character of text) {
    const size = Buffer.byteLength(character);
    if (length + size > limit) break;
    length += size;
    end += character.length;
  }
  return text.slice(0, end);
}

/** Run only this known child. No process scan or descendant cleanup claim. A close-wait expiry
 * returns explicitly unconfirmed custody, never a fabricated close or success. The fixture owns
 * broker, session and trust setup. A source entry is not installed-package acceptance. */
export async function runEndpointCallerCLI(input: EndpointCallerCLIInput, args: string[]): Promise<EndpointCallerCLIResult> {
  const timeoutMs = positive(input.timeoutMs ?? 30000, 30000, "timeoutMs");
  const closeWaitMs = positive(input.closeWaitMs ?? 1000, 5000, "closeWaitMs");
  const limit = positive(input.maxOutputBytes ?? 8192, 32768, "maxOutputBytes");
  if (input.signal?.aborted) throw new Error("endpoint CLI child was cancelled before spawn");
  const entry = input.cli ?? resolve(input.cwd, "bin/cotal.ts");
  const argv = input.cli ? [entry, ...args] : ["--import", "tsx", entry, ...args];
  const child = spawn(input.node ?? process.execPath, argv, {
    cwd: input.cwd, env: input.env, stdio: ["ignore", "pipe", "pipe"],
  });
  const stdout = Buffer.alloc(limit), stderr = Buffer.alloc(limit);
  let stdoutLength = 0, stderrLength = 0, stdoutBytes = 0, stderrBytes = 0;
  let done = false, timedOut = false, killAttempted = false;
  let killAccepted: boolean | null = null, killError: string | null = null;
  let terminationReason: EndpointCallerCLIResult["terminationReason"] = null;
  let spawnError: EndpointCallerCLIResult["spawnError"] = null;
  let childError: EndpointCallerCLIResult["childError"] = null;
  let timeout: NodeJS.Timeout | undefined, closeWait: NodeJS.Timeout | undefined;

  return await new Promise<EndpointCallerCLIResult>(accept => {
    const finish = (code: number | null, signal: NodeJS.Signals | null, closeObserved: boolean) => {
      if (done) return;
      done = true;
      clearTimeout(timeout);
      clearTimeout(closeWait);
      input.signal?.removeEventListener("abort", cancel);
      // Stop reading only on final close or explicit unconfirmed close-wait expiry. This does not
      // establish that a still-live child or a descendant has gone away.
      child.stdout.destroy();
      child.stderr.destroy();
      accept({ code, signal, stdout: boundedText(stdout.subarray(0, stdoutLength), limit),
        stderr: boundedText(stderr.subarray(0, stderrLength), limit), timedOut, closeObserved,
        closeWaitExpired: !closeObserved, killAttempted, killAccepted, killError,
        terminationReason, stdoutBytes, stderrBytes, spawnError, childError });
    };
    const waitForClose = () => {
      if (closeWait === undefined)
        closeWait = setTimeout(() => finish(child.exitCode, child.signalCode, false), closeWaitMs);
    };
    const terminate = (reason: NonNullable<EndpointCallerCLIResult["terminationReason"]>) => {
      if (done || terminationReason !== null) return;
      terminationReason = reason;
      timedOut = reason === "timeout";
      if (child.pid !== undefined && child.exitCode === null && child.signalCode === null) {
        killAttempted = true;
        try { killAccepted = child.kill("SIGKILL"); }
        catch (error) { killError = error instanceof Error ? error.message : String(error); }
      }
      waitForClose();
    };
    const cancel = () => terminate("cancelled");
    child.stdout.on("data", (bytes: Buffer) => {
      if (done) return;
      stdoutBytes += bytes.length;
      stdoutLength += bytes.copy(stdout, stdoutLength, 0, Math.min(bytes.length, limit - stdoutLength));
      if (stdoutBytes > limit) terminate("stdout-limit");
    });
    child.stderr.on("data", (bytes: Buffer) => {
      if (done) return;
      stderrBytes += bytes.length;
      stderrLength += bytes.copy(stderr, stderrLength, 0, Math.min(bytes.length, limit - stderrLength));
      if (stderrBytes > limit) terminate("stderr-limit");
    });
    child.on("error", (error: NodeJS.ErrnoException) => {
      if (done) return;
      childError = { code: error.code ?? "UNKNOWN", message: error.message };
      if (child.pid === undefined) spawnError = childError;
      terminate("child-error");
    });
    child.once("close", (code, signal) => finish(code, signal, true));
    timeout = setTimeout(() => terminate("timeout"), timeoutMs);
    input.signal?.addEventListener("abort", cancel, { once: true });
    // Handle cancellation between the pre-spawn check and listener attachment.
    if (input.signal?.aborted) cancel();
  });
}
