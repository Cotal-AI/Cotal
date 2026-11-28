interface ScreenTerminal {
  write(data: string, callback?: () => void): void;
  resize(cols: number, rows: number): void;
}

interface ScreenSerializer {
  serialize(): string;
}

type ScreenOperation = "write" | "resize" | "snapshot";

const SNAPSHOT_TIMEOUT_MS = 5_000;

/** Optional rendering only. Keep PTY I/O, dimensions and lifecycle outside this class. */
export class SharedScreen {
  #disabled = false;
  readonly #pending = new Set<(data: string) => void>();

  constructor(
    private readonly terminal: ScreenTerminal,
    private readonly serializer: ScreenSerializer,
    private readonly onFault?: (error: unknown, operation: ScreenOperation) => void | Promise<void>,
  ) {}

  write(data: string): void {
    if (this.#disabled) return;
    try {
      this.terminal.write(data);
    } catch (error) {
      this.#disable(error, "write");
    }
  }

  resize(cols: number, rows: number): void {
    if (this.#disabled) return;
    if (!Number.isInteger(cols) || !Number.isInteger(rows) || cols > 500 || rows > 300) {
      this.#disable(new Error("shared screen dimensions exceed the mirror bounds"), "resize");
      return;
    }
    try {
      this.terminal.resize(cols, rows);
    } catch (error) {
      this.#disable(error, "resize");
    }
  }

  /** Flush queued writes before serializing. A disabled mirror returns an empty screen. */
  snapshot(): Promise<string> {
    if (this.#disabled) return Promise.resolve("");
    return new Promise((resolve) => {
      const finish = (data: string): void => {
        this.#pending.delete(finish);
        clearTimeout(timer);
        resolve(data);
      };
      // xterm may never call the flush callback if its asynchronous parser stalls.
      // Exceptions internal to that parser cannot be caught through the public API.
      const timer = setTimeout(() => {
        this.#disable(new Error("shared screen snapshot flush timed out"), "snapshot");
      }, SNAPSHOT_TIMEOUT_MS);
      this.#pending.add(finish);
      try {
        this.terminal.write("", () => {
          if (!this.#pending.has(finish)) return;
          try {
            finish(this.serializer.serialize());
          } catch (error) {
            this.#disable(error, "snapshot");
          }
        });
      } catch (error) {
        this.#disable(error, "snapshot");
      }
    });
  }

  #disable(error: unknown, operation: ScreenOperation): void {
    if (this.#disabled) return;
    this.#disabled = true;
    for (const finish of this.#pending) finish("");
    try {
      void Promise.resolve(this.onFault?.(error, operation)).catch(() => {});
    } catch {
      // A diagnostic sink must not break PTY handling either.
    }
  }
}
