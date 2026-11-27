/** Bounded native-service output, retained when Task Scheduler has no terminal to show it in. */
import { closeSync, writeSync } from "node:fs";
import { join } from "node:path";
import { openPrivateAppend, writeSecretFile, writeSecretFileAtomic } from "@cotal-ai/core";
import { readLocalRecordSource } from "@cotal-ai/workspace";

export const nativeDaemonLog = (state: string): string => join(state, "daemon.log");
export const previousNativeDaemonLog = (state: string): string => join(state, "daemon.previous.log");
const outputLimit = 64 * 1024;
let capturing = false;

/** Start a fresh private log for this launch. Keep stdout/stderr behavior for manual diagnosis. */
export function captureNativeDaemonOutput(state: string): void {
  if (capturing) return;
  const file = nativeDaemonLog(state);
  let archiveFailed = false;
  try {
    const previous = readLocalRecordSource(file, outputLimit + 128, true);
    if (previous?.length) writeSecretFileAtomic(previousNativeDaemonLog(state), previous);
  } catch {
    archiveFailed = true;
  }
  writeSecretFile(file, `daemon service launch ${new Date().toISOString()}\n`);
  const fd = openPrivateAppend(file);
  capturing = true;
  let remaining = outputLimit;
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
  if (archiveFailed) process.stderr.write("daemon: could not save the previous service log\n");
}

/** launchd opens StandardOutPath with its own umask, so the log it creates is readable by others. */
export function privateLaunchdLog(state: string): void {
  closeSync(openPrivateAppend(nativeDaemonLog(state)));
}
