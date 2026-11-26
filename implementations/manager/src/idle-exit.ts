/** How often the watcher looks, at most. The stop begins up to this long after the period ends. */
const CHECK_MS = 5_000;

/** {@link ManagerOptions.idleExit}: stop the Manager once it has held no agents for a while. */
export interface IdleExitOptions {
  /** How long the Manager must stay idle before it stops, in milliseconds. */
  readonly afterMs: number;
  /** Receives the stop the watcher began. The embedder ends its process once that settles. */
  readonly onStop: (stopped: Promise<void>) => void;
}

/** The idle clock of one Manager. `idle` reads the Manager's state; `stop` begins its stop. */
export class IdleExit {
  private timer: ReturnType<typeof setInterval> | undefined;
  private idleSince: number | undefined;

  constructor(private readonly options: IdleExitOptions, private readonly idle: () => boolean, private readonly stop: () => Promise<void>) {
    if (!Number.isSafeInteger(options.afterMs) || options.afterMs <= 0) throw new Error("manager idleExit.afterMs must be a positive whole number of milliseconds");
    if (typeof options.onStop !== "function") throw new Error("manager idleExit.onStop must be a function");
  }

  /** Start the clock, once the Manager's start has returned. */
  arm(): void {
    if (this.timer) return;
    this.idleSince = this.idle() ? Date.now() : undefined;
    this.timer = setInterval(() => this.check(), Math.min(CHECK_MS, this.options.afterMs));
    this.timer.unref();
  }

  disarm(): void {
    clearInterval(this.timer);
    this.timer = undefined;
  }

  private check(): void {
    if (!this.idle()) {
      this.idleSince = undefined;
      return;
    }
    const now = Date.now();
    this.idleSince ??= now;
    if (now - this.idleSince < this.options.afterMs) return;
    this.disarm();
    // The Manager's stop closes its lifecycle fence before its first await, so it runs in the tick
    // that found the Manager idle: no spawn is admitted between that check and the stop.
    this.options.onStop(this.stop());
  }
}
