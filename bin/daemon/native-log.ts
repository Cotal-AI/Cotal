/** Bounded native-service output, retained when Task Scheduler has no terminal to show it in. */
import { closeSync, writeSync } from "node:fs";
import { join } from "node:path";
import { openPrivateAppend, writeSecretFile } from "@cotal-ai/core";

export const nativeDaemonLog = (state: string): string => join(state, "daemon.log");

/** Start a fresh private log for this launch. Keep stdout/stderr behavior for manual diagnosis. */
export function captureNativeDaemonOutput(state: string): void {
  const file = nativeDaemonLog(state);
  writeSecretFile(file, `daemon service launch ${new Date().toISOString()}\n`);
  const fd = openPrivateAppend(file);
  let remaining = 64 * 1024;
  for (const stream of [process.stdout, process.stderr]) {
    const original = stream.write.bind(stream);
    stream.write = ((chunk: string | Uint8Array, ...args: unknown[]) => {
      if (remaining > 0) {
        const text = (typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"))
          .replace(/eyJ[A-Za-z0-9_.-]*/g, "<redacted>");
        const bytes = Buffer.from(text).subarray(0, remaining);
        writeSync(fd, bytes);
        remaining -= bytes.length;
      }
      return Reflect.apply(original, stream, [chunk, ...args]);
    }) as typeof stream.write;
  }
  process.once("exit", () => closeSync(fd));
}
