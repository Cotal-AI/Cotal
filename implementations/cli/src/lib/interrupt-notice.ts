const SIGNAL_EXIT = { SIGINT: 130, SIGTERM: 143, SIGHUP: 129 } as const;
type ExitSignal = keyof typeof SIGNAL_EXIT;

/** Until the returned release runs, a SIGINT, SIGTERM or SIGHUP writes `notice()` to stderr and exits
 *  with that signal's code. The interrupted command's own cleanup does not run, so the notice names
 *  what it left and the command that recovers it. */
export function noticeOnInterrupt(notice: () => string): () => void {
  const signals = Object.keys(SIGNAL_EXIT) as ExitSignal[];
  const handler = (signal: ExitSignal) => {
    let text: string;
    try { text = notice(); } catch { text = "Interrupted. cotal status shows what this root holds."; }
    process.stderr.write(`\n${text}\n`);
    process.exit(SIGNAL_EXIT[signal]);
  };
  for (const signal of signals) process.on(signal, handler);
  return () => { for (const signal of signals) process.off(signal, handler); };
}
