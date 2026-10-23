import { writeSync } from "node:fs";

/** How many commands currently own process.stdout's errors. */
let owners = 0;

/**
 * The binary's process.stdout error listener, registered before any command can write. A closed
 * pipe (`| head`, a pager that quits, `source <(cotal completion script bash)`) exits as SIGPIPE
 * would, with 0 unless the command already set its exit status. Any other error, such as ENOSPC on
 * a full disk, lost output the caller asked for: it is reported in one line and exits 3, or with the
 * non-zero status the command already set, never as a stack trace. Neither happens while a command
 * owns stdout's errors through {@link ownStdoutErrors}: that command ends its own work, such as
 * closing a session, and sets the exit status.
 */
export function stdoutError(error: NodeJS.ErrnoException): void {
  if (owners > 0) return;
  if (error.code === "EPIPE") process.exit(process.exitCode ?? 0);
  reportLostOutput(error);
  process.exit(Number(process.exitCode ?? 0) || 3);
}

/** Say on stderr, in one line, that stdout could not be written. A closed pipe says nothing. */
export function reportLostOutput(error: NodeJS.ErrnoException): void {
  if (error.code === "EPIPE") return;
  try { writeSync(2, `✗ could not write to stdout: ${error.message}\n`); } catch { /* stderr failed too; the exit status still says so */ }
}

/**
 * Handle process.stdout's errors, EPIPE or any other, with `onError` until the returned release
 * runs, for a command that must finish its own shutdown when its output fails. The binary's
 * {@link stdoutError} stands down for that time. A failed write's error event comes a turn after
 * its callback, and a queued write can still fail after the release, so the release waits for the
 * writes made so far to settle and one more turn before it gives the errors back.
 */
export function ownStdoutErrors(onError: (error: Error) => void): () => void {
  const stdout = process.stdout;
  stdout.on("error", onError);
  owners++;
  let released = false;
  const detach = (): void => {
    stdout.off("error", onError);
    owners--;
  };
  return () => {
    if (released) return;
    released = true;
    if (stdout.destroyed || stdout.writableEnded || stdout.writableLength === 0) setImmediate(detach);
    // A write's callback runs only after every earlier write completed or failed.
    else stdout.write("", () => setImmediate(detach));
  };
}
