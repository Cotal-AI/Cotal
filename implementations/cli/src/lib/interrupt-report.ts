import { commandFailureReport, failureEnvelope, renderReport, terminalWidth, writeEnvelope, type CommandFailure, type Presentation } from "@cotal-ai/workspace";

/** While a command that changes state runs, a SIGINT or SIGTERM reports what it left, as `left`
 *  states it at that moment, and exits as the signal would: 130 or 143. `release` runs first, so a
 *  lock the command holds is not left for the next run to take over. Returns the function that
 *  removes the handlers. */
export function reportOnInterrupt(presentation: Presentation, command: string, left: () => CommandFailure, release?: () => void): () => void {
  const exit = (signal: "SIGINT" | "SIGTERM"): void => {
    const failure = left();
    try { release?.(); } catch { /* the next run takes the lock over and says so */ }
    if (presentation === "json") writeEnvelope(failureEnvelope(command, failure));
    process.stderr.write(`${renderReport(commandFailureReport(failure), presentation === "plain" ? "plain" : "rich", terminalWidth(process.stderr))}\n`);
    process.exit(signal === "SIGINT" ? 130 : 143);
  };
  const onInterrupt = () => exit("SIGINT");
  const onTerminate = () => exit("SIGTERM");
  process.once("SIGINT", onInterrupt);
  process.once("SIGTERM", onTerminate);
  return () => { process.off("SIGINT", onInterrupt); process.off("SIGTERM", onTerminate); };
}
