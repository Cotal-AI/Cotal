import { setTimeout as delay } from "node:timers/promises";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { SeatClient } from "./client.js";
import { seatHandle, type SeatHandle, type SeatHandleClient } from "./handle.js";
import { PROTOCOL_VERSION, type SeatExit, type StopMode } from "./protocol.js";
import { exitPath, type SeatRecord } from "./record.js";
import type { ExactIdentity, ProcessObservation } from "./shared-platform.js";
import { proveSharedHost, proveSharedSeat, verifySeatPeer } from "./shared-launch.js";
import { readPrivateRecord, readSharedHost, readSharedSeat, recordedProcess, sharedSeatRecord, shortSocketPath, type SharedSeatRecord } from "./shared-record.js";
import type { StartupOutcome } from "./startup-confirm.js";

function childLife(row: SharedSeatRecord): "live" | "gone" | undefined {
  return row.childStart ? recordedProcess(row.childPid, row.childStart, row.bootId) : undefined;
}

function hostLife(row: SharedSeatRecord): "live" | "gone" | undefined {
  return recordedProcess(row.custodianPid, row.custodianStart, row.bootId);
}

type LinuxChildIdentity = ExactIdentity & { boot: string };

export type SharedHandle<I extends ExactIdentity = LinuxChildIdentity> = SeatHandle & {
  startupOutcome(): StartupOutcome;
  readonly childIdentity?: Readonly<I>;
};

interface SharedHandleProof<I extends ExactIdentity> {
  childIdentity?: I;
  childLife(): ProcessObservation;
  hostLife(): ProcessObservation;
  terminalEvidence(): SeatExit | undefined;
}

export function openSharedSeat(root: string, id: string, adopting = false): SharedHandle {
  root = resolve(root);
  const row = readSharedSeat(root, id);
  const localRecord = sharedSeatRecord(root, id);
  if (adopting) {
    if (childLife(row) !== "live" || existsSync(exitPath(localRecord))) throw new Error("shared PTY seat is not verified live");
    const host = readSharedHost(root);
    if (host.pid !== row.custodianPid || host.start !== row.custodianStart || host.bootId !== row.bootId || host.scope !== row.scope)
      throw new Error("shared PTY seat does not match its recorded host");
    proveSharedHost(root, host);
    proveSharedSeat(root, id);
  }
  const client = new SeatClient(row, socket => verifySeatPeer(row, socket), () => shortSocketPath(row.socket), true);
  return observeSharedHandle(row, client, exitPath(localRecord));
}

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
  return observeNativeSharedHandle(row, client, {
    ...(row.childStart ? { childIdentity: { pid: row.childPid, start: row.childStart, boot: row.bootId } } : {}),
    childLife: () => childLife(row) ?? "unknown", hostLife: () => hostLife(row) ?? "unknown",
    terminalEvidence: () => terminalEvidence(terminalPath),
  });
}

export function observeNativeSharedHandle<I extends ExactIdentity>(row: SeatRecord,
  client: SeatHandleClient & Pick<SeatClient, "connected" | "health">, proof: SharedHandleProof<I>): SharedHandle<I> {
  const base = seatHandle(row, client, true);
  let released = false, exited = false, startup: StartupOutcome = "pending";
  let pending = false, watchStartup = true;
  let requestedStop: StopMode | undefined;
  let goneAt: number | undefined;
  const listeners = new Set<() => void>();
  const markExited = () => {
    if (released || exited) return;
    exited = true;
    clearInterval(poll);
    for (const listener of listeners) {
      try { listener(); } catch { /* Other exit observers must still receive the same evidence. */ }
    }
    listeners.clear();
  };
  const observe = () => {
    if (goneAt !== undefined || proof.childLife() === "gone") {
      goneAt ??= Date.now();
      if (proof.hostLife() !== "live" || proof.terminalEvidence() || Date.now() - goneAt >= 1_000) {
        markExited();
        return;
      }
    }
    if (released || pending || (client.connected() && !watchStartup && !requestedStop)) return;
    pending = true;
    void client.health().then(async report => {
      if (report.protocol !== PROTOCOL_VERSION || report.pid !== row.childPid) { client.close(); return; }
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
  const release = () => { released = true; unsub(); clearInterval(poll); listeners.clear(); base.close(); };
  return {
    ...base,
    ...(proof.childIdentity ? { childIdentity: Object.freeze({ ...proof.childIdentity }) } : {}),
    status() {
      const child = proof.childLife();
      if (exited || child === "gone") return "exited";
      if (child !== "live" || proof.hostLife() !== "live") throw new Error("shared PTY seat lifetime is unknown");
      return "running";
    },
    exitInfo: () => base.exitInfo() ?? (exited ? proof.terminalEvidence() : undefined),
    release, close: release,
    stop(opts) {
      if (!released && !exited) {
        if (requestedStop !== "hard") requestedStop = opts?.graceful === false ? "hard" : "graceful";
        observe();
      }
    },
    startupOutcome: () => startup,
    async waitForExit() {
      while (!released && !exited) { observe(); if (!exited) await delay(50); }
      if (!exited) throw new Error("shared PTY seat released before exit was proved");
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
