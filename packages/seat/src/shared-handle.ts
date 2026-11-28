import { setTimeout as delay } from "node:timers/promises";
import type { SeatClient } from "./client.js";
import { seatHandle, type SeatHandle, type SeatHandleClient } from "./handle.js";
import { GRACE_MS, type SeatExit, type StopMode } from "./protocol.js";
import { readPrivateRecord, recordedProcess, type SharedSeatRecord } from "./shared-record.js";
import type { StartupOutcome } from "./startup-confirm.js";
import { killRecordedSharedSeat, sharedSeatPopulated } from "./shared-cgroup.js";

function childLife(row: SharedSeatRecord): "live" | "gone" | undefined {
  return row.childStart ? recordedProcess(row.childPid, row.childStart, row.bootId) : undefined;
}

function hostLife(row: SharedSeatRecord): "live" | "gone" | undefined {
  return recordedProcess(row.custodianPid, row.custodianStart, row.bootId);
}

export type SharedHandle = SeatHandle & {
  startupOutcome(): StartupOutcome;
  readonly childIdentity?: Readonly<{ pid: number; start: string; boot: string }>;
};

function terminalEvidence(path: string | undefined): SeatExit | undefined {
  if (!path) return undefined;
  try {
    const value = readPrivateRecord(path) as SeatExit | null;
    if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
    return {
      ...(Number.isInteger(value.code) ? { code: value.code } : {}),
      ...(Number.isInteger(value.signal) ? { signal: value.signal } : {}),
      ...(typeof value.diagnostic === "string" ? { diagnostic: value.diagnostic } : {}),
    };
  } catch { return undefined; }
}

export function observeSharedHandle(row: SharedSeatRecord, client: SeatHandleClient & Pick<SeatClient, "connected" | "health">, terminalPath?: string): SharedHandle {
  const base = seatHandle(row, client, true);
  let released = false, exited = false, terminal = false, startup: StartupOutcome = "pending";
  let pending = false, watchStartup = true;
  let requestedStop: StopMode | undefined;
  let stopTimer: ReturnType<typeof setTimeout> | undefined;
  let goneAt: number | undefined;
  const listeners = new Set<() => void>();
  const markExited = () => {
    terminal = true;
    if (released || exited) return;
    try { if (sharedSeatPopulated(row)) return; } catch { return; }
    exited = true;
    clearInterval(poll);
    for (const listener of listeners) {
      try { listener(); } catch { /* Other exit observers must still receive the same evidence. */ }
    }
    listeners.clear();
  };
  const observe = () => {
    if (terminal) { markExited(); return; }
    if (goneAt !== undefined || childLife(row) === "gone") {
      goneAt ??= Date.now();
      if (hostLife(row) !== "live" || terminalEvidence(terminalPath) || Date.now() - goneAt >= 1_000) {
        markExited();
        return;
      }
    }
    if (released || pending || (client.connected() && !watchStartup && !requestedStop)) return;
    pending = true;
    void client.health().then(async report => {
      startup = report.startup ?? startup;
      watchStartup = report.startup === "pending";
      if (report.status === "exited") { markExited(); return; }
      const stop = requestedStop;
      if (stop && !released) {
        await client.stop(stop);
        if (requestedStop === stop) requestedStop = undefined;
      }
    }).catch(() => {}).finally(() => { pending = false; });
  };
  const poll = setInterval(observe, 250);
  poll.unref();
  const unsub = client.onExit(() => {
    markExited();
  });
  const release = () => { released = true; unsub(); clearInterval(poll); clearTimeout(stopTimer); listeners.clear(); base.close(); };
  return {
    ...base,
    ...(row.childStart ? { childIdentity: Object.freeze({ pid: row.childPid, start: row.childStart, boot: row.bootId }) } : {}),
    status() {
      const child = childLife(row);
      if (exited || child === "gone") {
        if (exited) return "exited";
        try { if (!sharedSeatPopulated(row)) return "exited"; } catch { /* Keep managing the seat. */ }
      }
      // The recorded launch remains managed until there is terminal evidence. Transport and
      // unreadable kernel state are internal, not a third public process state.
      return "running";
    },
    exitInfo: () => base.exitInfo() ?? (exited ? terminalEvidence(terminalPath) : undefined),
    release, close: release,
    stop(opts) {
      if (!released) {
        const hard = opts?.graceful === false;
        if (requestedStop !== "hard") requestedStop = hard ? "hard" : "graceful";
        if (!stopTimer || hard) {
          clearTimeout(stopTimer);
          stopTimer = setTimeout(() => {
            stopTimer = undefined;
            try { if (sharedSeatPopulated(row)) killRecordedSharedSeat(row); } catch { /* Exit remains unproved. */ }
          }, hard ? 0 : GRACE_MS + 250);
          stopTimer.unref();
        }
        observe();
      }
    },
    startupOutcome: () => startup,
    async waitForExit() {
      while (!released && (!exited || sharedSeatPopulated(row))) { observe(); await delay(50); }
      if (!exited || sharedSeatPopulated(row)) throw new Error("shared PTY seat released before exit was proved");
      base.close();
    },
    attach() {
      const session = base.attach();
      return { ...session, get cols() { return session.cols; }, get rows() { return session.rows; }, onExit(listener) {
        if (exited) queueMicrotask(listener);
        else listeners.add(listener);
        return () => { listeners.delete(listener); };
      } };
    },
  };
}
