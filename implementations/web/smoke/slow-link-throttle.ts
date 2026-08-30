export type ThrottleWriter = {
  readonly destroyed: boolean;
  write(chunk: Buffer, callback: () => void): unknown;
};

export type ThrottleDeps = {
  now(): number;
  schedule(callback: () => void, delay: number): unknown;
  cancel(handle: unknown): void;
};

/** One TCP direction's FIFO scheduler. Only one timer/write may be active at a time. */
export function throttledWriter(
  to: ThrottleWriter,
  opts: { oneWayMs: number; bytesPerSec: number },
  deps: ThrottleDeps = {
    now: Date.now,
    schedule: (callback, delay) => {
      const timer = setTimeout(callback, delay);
      timer.unref();
      return timer;
    },
    cancel: (handle) => clearTimeout(handle as NodeJS.Timeout),
  },
): { push(chunk: Buffer): void; close(): void } {
  let clear = 0;
  let timer: unknown;
  let writing = false;
  const queued: Array<{ at: number; chunk: Buffer }> = [];
  const pump = () => {
    if (writing || timer !== undefined || queued.length === 0 || to.destroyed) return;
    const next = queued[0];
    const delay = Math.max(0, next.at - deps.now());
    timer = deps.schedule(() => {
      timer = undefined;
      if (to.destroyed) return;
      queued.shift();
      writing = true;
      to.write(next.chunk, () => { writing = false; pump(); });
    }, delay);
  };
  return {
    push: (chunk: Buffer) => {
      const now = deps.now();
      const at = Math.max(now + opts.oneWayMs, clear) + (chunk.length / opts.bytesPerSec) * 1000;
      clear = at;
      queued.push({ at, chunk: Buffer.from(chunk) });
      pump();
    },
    close: () => { if (timer !== undefined) deps.cancel(timer); },
  };
}
