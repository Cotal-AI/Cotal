import { setTimeout as delay } from "node:timers/promises";
import { win32ProcessBinding, type Win32ProcessBinding, type Win32ProcessPin, type Win32TreePin } from "@cotal-ai/workspace";

type WindowsProcessStopBinding = Pick<Win32ProcessBinding, "pinProcess" | "processTree">;

/** One stop-time snapshot, not launch-time custody of detached or future work. */
export class WindowsSeatStop {
  private root?: Win32ProcessPin;
  private rootPid?: number;
  private captureError?: Error;
  private exitedBeforePin = false;
  private pending?: Promise<void>;
  private succeeded = false;
  private readonly startup: ReturnType<typeof setInterval>;

  constructor(
    private readonly pid: () => number,
    private readonly binding: () => WindowsProcessStopBinding = win32ProcessBinding,
  ) {
    this.startup = setInterval(() => this.capture(), 5);
    this.startup.unref();
    this.capture();
  }

  capture(): void {
    if (this.root || this.captureError || this.exitedBeforePin) return;
    const pid = this.pid();
    if (pid <= 0) return;
    try {
      this.root = this.binding().pinProcess(pid);
      this.rootPid = pid;
      clearInterval(this.startup);
    } catch (error) {
      this.captureError = error instanceof Error ? error : new Error(String(error));
      clearInterval(this.startup);
    }
  }

  onProcessExit(): void {
    clearInterval(this.startup);
    if (!this.root && !this.captureError) {
      this.exitedBeforePin = true;
      this.captureError = new Error("the Windows seat exited before its launch process identity could be pinned");
    }
  }

  stop(graceMs: number, timeoutMs: number, ptyExit: () => Promise<void>): Promise<void> {
    if (this.pending) return this.pending;
    if (this.succeeded) return Promise.resolve();
    this.capture();
    const task = async (): Promise<void> => {
      const deadline = Date.now() + timeoutMs;
      while (!this.root && !this.captureError) {
        if (Date.now() >= deadline) {
          clearInterval(this.startup);
          throw new Error("the Windows seat has no retained launch process identity");
        }
        await delay(5);
        this.capture();
      }
      clearInterval(this.startup);
      if (this.captureError) throw this.captureError;
      if (!this.root || !this.rootPid) throw new Error("the Windows seat has no retained launch process identity");
      let tree: Win32TreePin[] = [];
      try {
        tree = this.binding().processTree(this.rootPid, this.root.token);
        if (graceMs > 0) {
          const graceEnd = Math.min(deadline, Date.now() + graceMs);
          while (Date.now() < graceEnd && !tree.every((member) => member.exited())) {
            await delay(Math.min(20, Math.max(1, graceEnd - Date.now())));
          }
        }
        // Kill through the captured kernel handles, never by a reusable child PID.
        // A naturally exited root does not exempt surviving captured descendants.
        for (const member of [...tree].reverse()) {
          if (!member.exited()) member.terminate();
        }
        while (!tree.every((member) => member.exited())) {
          if (Date.now() >= deadline) throw new Error("Windows seat stop could not prove every captured process exited");
          await delay(20);
        }
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          await Promise.race([
            ptyExit(),
            new Promise<never>((_, reject) => {
              timer = setTimeout(
                () => reject(new Error("Windows seat processes exited but the PTY did not report exit")),
                Math.max(0, deadline - Date.now()),
              );
            }),
          ]);
        } finally {
          clearTimeout(timer);
        }
        this.succeeded = true;
      } finally {
        for (const member of tree) {
          try {
            member.close();
          } catch {
            /* close every retained member */
          }
        }
      }
    };
    const run = task();
    this.pending = run;
    // Some stop doors observe later through waitForExit. Keep rejection handled now.
    void run.then(
      () => {
        this.close();
      },
      () => {
        if (this.pending === run) this.pending = undefined;
      },
    );
    return run;
  }

  close(): void {
    clearInterval(this.startup);
    // A stop task can still be using its original root identity after PTY exit.
    const release = (): void => {
      try {
        this.root?.close();
      } catch {
        /* repeated close is a no-op */
      }
      this.root = undefined;
    };
    if (this.pending && !this.succeeded) void this.pending.then(release, () => {});
    else release();
  }
}
