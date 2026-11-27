import { observeWindowsProcess } from "./host.js";
import { DEFAULT_COLS, DEFAULT_ROWS, GRACE_MS } from "./protocol.js";
import type { WindowsSharedIdentity } from "./shared-control-win32.js";
import { prepareWindowsJobConPty, WINDOWS_SEAT_LAUNCH_UNKNOWN } from "./shared-job-conpty-win32.js";
import type { SeatIsolation } from "./shared-platform.js";
import type { SeatStopMode, SeatTerminal } from "./shared-prepared-seat.js";

const POLL_MS = 25;

/** One reservation owns exactly one private job. Native drain and terminal EOF are separate proofs. */
export function createWindowsSeatIsolation(runtime: string): SeatIsolation<WindowsSharedIdentity> {
  let used = false, unconfirmed = false;
  let lifetime: Promise<void> | undefined;
  return {
    async prepare({ spec, cwd }) {
      if (used) throw new Error("Windows seat isolation already used");
      used = true;
      let terminal: ReturnType<typeof prepareWindowsJobConPty>;
      try {
        terminal = prepareWindowsJobConPty({ runtime, executable: spec.command, args: spec.args, cwd,
          env: spec.env ?? {}, cols: DEFAULT_COLS, rows: DEFAULT_ROWS });
      } catch (error) {
        unconfirmed = isUnknownLaunch(error);
        throw error;
      }
      const { pid, start, input, output } = terminal;
      let release!: () => void;
      const drained = lifetime = new Promise<void>(resolve => { release = resolve; });
      let attempted = false, closed = false, done = false;
      let outputEnd: "eof" | "lost" | undefined;
      let exitCode: number | undefined, exitSent = false;
      let rollback: unknown;
      let timer: ReturnType<typeof setInterval> | undefined;
      let graceful: Promise<void> | undefined;
      let endGrace: (() => void) | undefined;
      let terminated = false;
      // Use the exact birth pinned by the native process handle, even on the observation path.
      const readIdentity = (): WindowsSharedIdentity => {
        const child = observeWindowsProcess(pid);
        const host = observeWindowsProcess(process.pid);
        if (!child || child.birth !== start || !host || child.user !== host.user || child.session !== host.session)
          throw new Error("suspended Windows seat identity is unknown");
        return { pid, start, user: child.user, session: child.session };
      };
      const ready = Promise.resolve().then(readIdentity);
      void ready.catch(() => {});

      const exitListeners = new Set<(event: { exitCode: number }) => void>();
      function emitExit(): void {
        if (exitSent || !done || !outputEnd || exitCode === undefined) return;
        exitSent = true;
        if (outputEnd === "lost") {
          // This is a native exit status, not a claim that all terminal bytes were delivered.
          try { console.error(`Windows seat ${pid}: terminal output closed before EOF`); } catch { /* Diagnostics cannot hold custody. */ }
        }
        for (const listener of exitListeners) listener({ exitCode });
        exitListeners.clear();
      }
      output.setEncoding("utf8");
      output.once("end", () => { outputEnd = "eof"; emitExit(); });
      output.once("close", () => { outputEnd ??= "lost"; emitExit(); });

      function poll(): void {
        let exited;
        try {
          exited = terminal.poll();
          if (!exited || exited.active !== 0 || !terminal.dispose()) return;
        } catch {
          // Neither a failed query nor the root's death proves the private job is empty.
          return;
        }
        exitCode = exited.exitCode;
        clearInterval(timer);
        done = true;
        release();
        // If nobody subscribed, still consume the pipe so Node can deliver its EOF.
        if (!outputEnd && output.listenerCount("data") === 0) output.resume();
        emitExit();
      }
      function terminateJob(): void {
        poll();
        if (done || terminated) return;
        terminal.stop();
        terminated = true;
        endGrace?.();
      }
      async function interruptAndWait(): Promise<void> {
        // Write only to this ConPTY, never to a process group or a host console.
        try { if (!input.destroyed && input.writable) input.write("\x03"); }
        catch { /* Grace and exact job escalation still apply if input cannot be written. */ }
        let graceTimer: ReturnType<typeof setTimeout> | undefined;
        try {
          await Promise.race([drained, new Promise<void>(resolve => {
            endGrace = resolve;
            graceTimer = setTimeout(resolve, GRACE_MS);
          })]);
        } finally { clearTimeout(graceTimer); endGrace = undefined; }
        terminateJob();
        await drained;
      }
      const stop = async (mode: SeatStopMode): Promise<void> => {
        if (done) return;
        if (!attempted) { abort(); return; }
        poll();
        if (done) return;
        if (mode === "graceful" && !terminated) return graceful ??= interruptAndWait().finally(() => { graceful = undefined; });
        terminateJob();
        await drained;
      };
      function abort(): void {
        if (rollback) throw rollback;
        if (closed || attempted) return;
        closed = true;
        try { terminal.abort(); }
        catch (error) { rollback = error; unconfirmed = true; throw error; }
        done = true;
        release();
      }
      const proc: SeatTerminal = {
        pid,
        onData(listener) {
          output.on("data", listener);
          return { dispose: () => { output.off("data", listener); } };
        },
        onExit(listener) {
          if (exitSent && exitCode !== undefined) {
            const event = { exitCode };
            queueMicrotask(() => { if (exitListeners.delete(listener)) listener(event); });
          }
          exitListeners.add(listener);
          return { dispose: () => { exitListeners.delete(listener); } };
        },
        write(data) { if (!done && !input.destroyed) input.write(data); },
        resize: terminal.resize,
        kill(signal) { void stop(signal === "SIGKILL" ? "hard" : "graceful").catch(() => {}); },
      };
      return {
        proc, ready, abort, stop, drain: () => drained,
        get commitAttempted() { return attempted; },
        async commit(beforeDispatch) {
          const expected = await ready;
          if (closed || attempted || input.destroyed || output.destroyed) throw new Error("Windows seat is not ready to dispatch");
          const child = readIdentity();
          if (child.user !== expected.user || child.session !== expected.session) throw new Error("Windows seat identity changed before dispatch");
          beforeDispatch();
          attempted = true;
          try { terminal.resume(); }
          catch (error) {
            // Do not report refusal or run the suspended-only rollback after dispatch was attempted.
            // Stop using the private job even if native resume failed with the root still suspended.
            try { terminateJob(); } catch { /* The poll loop still owns the job. */ }
            throw error;
          } finally { if (!done) timer = setInterval(poll, POLL_MS); }
        },
      };
    },
    prepareFailure: error => unconfirmed || isUnknownLaunch(error) ? "unknown" : "not-admitted",
    async drain() {
      if (unconfirmed) throw new Error("Windows seat rollback was not confirmed");
      await lifetime;
    },
  };
}

function isUnknownLaunch(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === WINDOWS_SEAT_LAUNCH_UNKNOWN;
}
