import { claimForegroundHold, foregroundStackEnd, foregroundStopLauncher, hangupForegroundStack, releaseForegroundHold } from "../lib/foreground-hold.js";
import { handOverStartupNotice } from "../lib/interrupt-notice.js";
import { readStackJournal, type StackJournal } from "../lib/stack-journal.js";
import { stopForegroundStack } from "./stack-down.js";

interface HoldOptions { releaseRestoreNotice?: () => void; supervised?: true }

/** Foreground controller stack: the terminal holds the stack's lifetime until SIGINT or SIGTERM,
 *  which runs the same guarded whole-stack stop as bare `down`. A hangup leaves the stack running and
 *  exits 129, naming `cotal down`. `start`, when given, is the startup this terminal already holds: a
 *  signal during it lets the start settle, then a stop signal runs that stop and a hangup leaves what
 *  the start left. A failed start still runs the stop, and its failure is thrown once the stop returns.
 *  The hold exits 0 after a completed external stop or preserve, 5 after a broker crash, 129 after
 *  a hangup, 130 or 143 after a stop signal, whatever the start receipt set. */
export async function holdForegroundStack(root: string, space: string, start?: () => Promise<void | StackJournal>, options?: HoldOptions): Promise<void> {
  claimForegroundHold(root);
  try { await holdStack(root, space, start, options); }
  finally { releaseForegroundHold(root); }
}

async function holdStack(root: string, space: string, start: (() => Promise<void | StackJournal>) | undefined, options?: HoldOptions): Promise<void> {
  const outsideCmd = foregroundStopLauncher(root);
  // The start's listeners go only once the hold's own are installed. Node runs a listener for a
  // signal when the loop next polls, and drops the signal if its last listener was removed first,
  // so a signal that lands in the start's last synchronous step would be lost in between.
  let held: StackJournal | void = undefined, releaseStart = (): void => {};
  if (start) {
    let requested: "SIGINT" | "SIGTERM" | "SIGHUP" | undefined;
    const request = (signal: "SIGINT" | "SIGTERM" | "SIGHUP") => {
      if (requested) return;
      requested = signal;
      process.stderr.write(signal === "SIGHUP"
        ? "The terminal closed; the start settles, then the stack is left running\n"
        : "Stop requested; the whole-stack stop runs once the start settles\n");
    };
    const interrupt = () => request("SIGINT"), terminate = () => request("SIGTERM"), hangup = () => request("SIGHUP");
    process.on("SIGINT", interrupt); process.on("SIGTERM", terminate); process.on("SIGHUP", hangup);
    handOverStartupNotice();
    let failure: { error: unknown } | undefined;
    try { held = await start(); } catch (error) { failure = { error }; }
    releaseStart = () => { process.off("SIGINT", interrupt); process.off("SIGTERM", terminate); process.off("SIGHUP", hangup); };
    if (requested || failure) releaseStart();
    if (requested === "SIGHUP") hangupForegroundStack(root, space, outsideCmd);
    if (requested) await stopForegroundStack(root, requested, true, held?.space);
    if (failure) throw failure.error;
    if (requested) return;
  }
  return new Promise<void>((resolveHold) => {
    const observed = held ?? (() => { try { return readStackJournal(root)?.journal; } catch { return undefined; } })();
    let stopping = false;
    const checkLifetime = () => {
      if (stopping) return;
      const code = foregroundStackEnd(root, observed, options?.supervised);
      if (code === undefined) return;
      stopping = true;
      process.off("SIGINT", interrupt); process.off("SIGTERM", terminate); process.off("SIGHUP", hangup);
      clearInterval(lifetime);
      process.exitCode = code;
      resolveHold();
    }, lifetime = setInterval(checkLifetime, 1000);
    const stop = (signal: "SIGINT" | "SIGTERM") => {
      if (stopping) return;
      stopping = true;
      process.off("SIGINT", interrupt); process.off("SIGTERM", terminate); process.off("SIGHUP", hangup);
      clearInterval(lifetime);
      void stopForegroundStack(root, signal, false, observed?.space).finally(resolveHold);
    };
    const interrupt = () => stop("SIGINT");
    const terminate = () => stop("SIGTERM");
    const hangup = () => { checkLifetime(); if (!stopping) hangupForegroundStack(root, space, outsideCmd); };
    process.on("SIGINT", interrupt); process.on("SIGTERM", terminate); process.on("SIGHUP", hangup);
    releaseStart();
    handOverStartupNotice();
    options?.releaseRestoreNotice?.();
  });
}
