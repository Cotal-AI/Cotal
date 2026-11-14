import { spawnSync } from "node:child_process";
import { basename } from "node:path";
import { CommandFailure } from "@cotal-ai/workspace/local-observation";
import type { NativeResult } from "./install.js";

/** Runs one native tool by absolute path with the existing bounds, never through a shell. */
export function nativeRun(file: string, args: readonly string[], env?: NodeJS.ProcessEnv): NativeResult {
  const started = Date.now();
  const result = spawnSync(file, args, { encoding: "utf8", timeout: 30_000, maxBuffer: 256 * 1024, stdio: ["ignore", "pipe", "pipe"], windowsHide: true, ...(env ? { env } : {}) });
  if (result.error || result.signal) {
    const elapsedMs = Date.now() - started;
    const code = (result.error as NodeJS.ErrnoException | undefined)?.code;
    const reason = code === "ETIMEDOUT" ? "timed out after 30 s"
      : code === "ENOBUFS" ? "exceeded its 256 KiB output limit"
      : code ? `could not start or complete (${code})`
      : `exited by signal ${result.signal}`;
    throw new CommandFailure("refused", "DEPENDENCY_UNAVAILABLE", `${basename(file)} ${reason} (elapsed ${elapsedMs} ms); no further native step was taken`, {
      native: { code: code ?? result.signal ?? "NATIVE_TOOL_FAILED", detail: { elapsedMs, timeoutMs: 30_000, signal: result.signal } },
    });
  }
  const stdout = typeof result.stdout === "string" ? result.stdout : "";
  const stderr = typeof result.stderr === "string" ? result.stderr : "";
  return { status: result.status, stdout, detail: (stderr.trim() || stdout.trim()).replace(/[\u0000-\u001f\u007f]+/gu, " ").slice(0, 300) };
}
