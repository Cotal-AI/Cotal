const SIGNAL_EXIT = { SIGINT: 130, SIGTERM: 143, SIGHUP: 129 } as const;
export type InterruptSignal = keyof typeof SIGNAL_EXIT;
export const INTERRUPT_SIGNALS = Object.keys(SIGNAL_EXIT) as InterruptSignal[];

/** Write `text` to stderr and exit with the code `signal` sets. */
export function exitInterrupted(signal: InterruptSignal, text: string): never {
  process.stderr.write(`\n${text}\n`);
  process.exit(SIGNAL_EXIT[signal]);
}

/** An entry's notice for an interrupt before the command begins: `release` ends it with no other
 *  listener installed, and `handOver` ends it once one is. */
export interface StartupNotice { release(): Promise<void>; handOver(): void }

let kept: StartupNotice | undefined;

/** Keep the entry's startup notice past the command's start, for a command that installs its own. */
export function keepStartupNotice(notice: StartupNotice): void {
  kept = notice;
}

/** Hand a kept startup notice over to a signal listener this command just installed. */
export function handOverStartupNotice(): void {
  kept?.handOver();
  kept = undefined;
}

/** A command that kept the startup notice and begins work with no notice of its own ends it here. */
export async function releaseStartupNotice(): Promise<void> {
  const notice = kept;
  kept = undefined;
  await notice?.release();
}

/** Until the returned release runs, a SIGINT, SIGTERM or SIGHUP writes `notice()` to stderr and exits
 *  with that signal's code. The interrupted command's own cleanup does not run, so the notice names
 *  what it left and the command that recovers it. It takes over a startup notice the command kept. */
export function noticeOnInterrupt(notice: () => string): () => void {
  return noticeBetweenSteps(notice, () => false).release;
}

/** As {@link noticeOnInterrupt}, for a command whose steps each report as they end. A signal that
 *  lands while `inStep()` holds waits for `between()`, which the command awaits once that step has
 *  ended and reported, and which then writes the notice and exits. A second signal ends it at once. */
export function noticeBetweenSteps(notice: () => string, inStep: () => boolean): { between(): Promise<void>; release(): void } {
  let pending: InterruptSignal | undefined;
  const exit = (signal: InterruptSignal): never => {
    let text: string;
    try { text = notice(); } catch { text = "Interrupted. `cotal status` shows what this root holds."; }
    exitInterrupted(signal, text);
  };
  const handler = (signal: InterruptSignal) => {
    if (pending === undefined && inStep()) pending = signal;
    else exit(signal);
  };
  for (const signal of INTERRUPT_SIGNALS) process.on(signal, handler);
  handOverStartupNotice();
  return {
    // A signal that arrived during synchronous work is dispatched only when the loop polls, so
    // `between` gives it the two turns the startup release does before it reads `pending`.
    between: async () => {
      for (let turn = 0; turn < 2; turn++) await new Promise((resolve) => setImmediate(resolve));
      if (pending !== undefined) exit(pending);
    },
    release: () => { for (const signal of INTERRUPT_SIGNALS) process.off(signal, handler); },
  };
}
