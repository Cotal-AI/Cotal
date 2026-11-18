import { rmSync } from "node:fs";
import { writeSecretFileAtomic } from "@cotal-ai/core";
import { acquireLock, canonicalLocalProcessPath, formatRecord, NATS_PIDFILE, readContainedRecord, stopReservationPath, type LocalProcess, type LocalProcessContext, type ProcessIdentityRecord } from "@cotal-ai/workspace";
import { stopLocalProcess } from "./local-process-stop.js";

export const brokerStopReceiptPath = (pidPath: string): string => `${stopReservationPath(pidPath)}.broker`;

/** Receipt I/O is diagnostic, not stop authority. Its failures cannot block the verified signal
 * or turn a confirmed broker exit into a failed stop. */
function receiptIo<T>(operation: string, run: () => T): T | undefined {
  try { return run(); }
  catch (error) { console.error(`! could not ${operation} the broker stop receipt: ${(error as Error).message}`); }
}

function lockReceipt(root: string, path: string) {
  const lockPath = `${path}.lock`;
  const lock = readContainedRecord(root, lockPath);
  if (lock.state === "unread") throw new Error(`${lock.at} is ${lock.why}`);
  return acquireLock(lockPath, { waitMs: 1000, pollMs: 10, label: "the broker stop receipt lock" });
}

/** Publish only after sending the signal, without waiting for the broker to be reaped. The reader
 * takes the same lock, so even an immediate child exit cannot race publication. */
export function stopRetainedStackProcess(component: LocalProcess, context: LocalProcessContext): Promise<boolean> {
  if (component.pidFile !== NATS_PIDFILE) return stopLocalProcess(component, context);
  const path = brokerStopReceiptPath(canonicalLocalProcessPath(NATS_PIDFILE, context));
  let termReceipt: string | undefined;
  return stopLocalProcess(component, context, {
    signal: (target, signal, send) => {
      if (target.token === undefined) return send();
      const lock = receiptIo("lock", () => lockReceipt(context.root, path));
      try {
        send();
        if (!lock) return;
        const record = `${formatRecord({ pid: target.pid, token: target.token })}\n${signal}`;
        receiptIo("write", () => writeSecretFileAtomic(path, record));
        if (signal === "SIGTERM") termReceipt = record;
      } finally {
        if (lock) receiptIo("unlock", () => lock.release());
      }
    },
    // A TERM that timed out is not evidence of a later exit. Keep a delivered KILL receipt even
    // when down times out or is interrupted before the foreground owner reaps its child.
    afterFailedSignal: () => {
      if (termReceipt !== undefined) receiptIo("clear", () => takeReceipt(context.root, path, (raw) => raw === termReceipt));
    },
  });
}

function takeReceipt(root: string, path: string, matches: (raw: string) => boolean): string | undefined {
  const lock = lockReceipt(root, path);
  try {
    const row = readContainedRecord(root, path);
    if (row.state === "unread") throw new Error(`${row.at} is ${row.why}`);
    if (row.state !== "content" || !matches(row.raw)) return undefined;
    receiptIo("remove", () => rmSync(path, { force: true }));
    return row.raw;
  } finally {
    receiptIo("unlock", () => lock.release());
  }
}

/** Consume the receipt for this exact child. A TERM does not explain an unrelated SIGKILL. */
export function consumeBrokerStopReceipt(root: string, pidPath: string, target: ProcessIdentityRecord, code: number | null, signal: NodeJS.Signals | null): boolean {
  const birth = formatRecord(target), term = `${birth}\nSIGTERM`, kill = `${birth}\nSIGKILL`;
  const receipt = receiptIo("read", () => takeReceipt(root, brokerStopReceiptPath(pidPath), (raw) => raw === term || raw === kill));
  return receipt === kill ? signal === "SIGKILL" : receipt === term && (code === 0 || signal === "SIGTERM");
}
