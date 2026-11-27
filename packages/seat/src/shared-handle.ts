import { setTimeout as delay } from "node:timers/promises";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { SeatClient } from "./client.js";
import { seatHandle, type SeatHandle } from "./handle.js";
import { PROTOCOL_VERSION } from "./protocol.js";
import { exitPath } from "./record.js";
import { proveSharedHost, proveSharedSeat, verifySeatPeer } from "./shared-launch.js";
import { readSharedHost, readSharedSeat, recordedProcess, sharedSeatRecord, shortSocketPath, type SharedSeatRecord } from "./shared-record.js";
import type { StartupOutcome } from "./startup-confirm.js";

function childLife(row: SharedSeatRecord): "live" | "gone" | undefined {
  return row.childStart ? recordedProcess(row.childPid, row.childStart, row.bootId) : undefined;
}

function hostLife(row: SharedSeatRecord): "live" | "gone" | undefined {
  return recordedProcess(row.custodianPid, row.custodianStart, row.bootId);
}

export type SharedHandle = SeatHandle & { startupOutcome(): StartupOutcome };

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
  const client = new SeatClient(row, socket => verifySeatPeer(row, socket), () => shortSocketPath(row.socket));
  return observeHandle(row, client);
}

function observeHandle(row: SharedSeatRecord, client: SeatClient): SharedHandle {
  const base = seatHandle(row, client);
  let released = false, exited = false, startup: StartupOutcome = "pending";
  let pending = false, authenticated = false, watchStartup = true;
  const listeners = new Set<() => void>();
  const markExited = () => {
    if (released || exited) return;
    exited = true;
    clearInterval(poll);
    for (const listener of listeners) listener();
    listeners.clear();
  };
  const observe = () => {
    if (childLife(row) === "gone" && hostLife(row) !== "live") { markExited(); return; }
    if (released || pending || (authenticated && !watchStartup)) return;
    pending = true;
    void client.health().then(report => {
      if (report.protocol !== PROTOCOL_VERSION || report.pid !== row.childPid) { authenticated = false; client.close(); return; }
      authenticated = true;
      startup = report.startup ?? startup;
      watchStartup = report.startup === "pending";
      if (report.status === "exited") markExited();
    }).catch(() => {}).finally(() => { pending = false; });
  };
  const poll = setInterval(observe, 250);
  poll.unref();
  const unsub = client.onExit(() => {
    authenticated = false;
    if (childLife(row) === "gone" || (hostLife(row) === "live" && client.exitInfo() !== undefined)) markExited();
  });
  const release = () => { released = true; unsub(); clearInterval(poll); listeners.clear(); base.close(); };
  return {
    ...base,
    status() {
      const child = childLife(row);
      if (exited || child === "gone") return "exited";
      if (child !== "live" || hostLife(row) !== "live") throw new Error("shared PTY seat lifetime is unknown");
      return "running";
    },
    release, close: release,
    startupOutcome: () => startup,
    async waitForExit() {
      while (!released && !exited) {
        if (childLife(row) === "gone") { markExited(); break; }
        await delay(50);
      }
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
