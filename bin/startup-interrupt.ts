/**
 * The interrupt notice for the time before a command begins. Until a listener exists, Node ends the
 * process on SIGINT, SIGTERM or SIGHUP with no output, and loading the CLI takes a moment. So the
 * entry holds this notice from before it loads the CLI until `runCli` starts the command, which then
 * reports its own interrupt. This module imports nothing, so the entry can load it on any Node.
 */
const SIGNAL_EXIT = { SIGINT: 130, SIGTERM: 143, SIGHUP: 129 } as const;
type ExitSignal = keyof typeof SIGNAL_EXIT;
const SIGNALS = Object.keys(SIGNAL_EXIT) as ExitSignal[];

const notice = (signal: ExitSignal): void => {
  process.stderr.write("\nInterrupted before the command began, so it did nothing. Run it again.\n");
  process.exit(SIGNAL_EXIT[signal]);
};

/** A signal from here on writes the notice and exits 130, 143 or 129. */
export function holdStartupInterrupt(): void {
  for (const signal of SIGNALS) process.on(signal, notice);
}

/** The command has begun: a signal is its own to report from here on. A signal that arrived while
 *  the CLI loaded waits until the event loop polls, and removing the listener before that drops it,
 *  so the release first lets the loop poll. It takes two turns, because from inside an I/O callback
 *  the first turn runs before the next poll. */
export async function releaseStartupInterrupt(): Promise<void> {
  for (let turn = 0; turn < 2; turn++) await new Promise((resolve) => setImmediate(resolve));
  for (const signal of SIGNALS) process.off(signal, notice);
}
