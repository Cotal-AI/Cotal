import { writePrivateRecord } from "@cotal-ai/core";
import { formatRecord, probeLiveness, readLocalRecordSource, stopReservationPath, type ProcessIdentityRecord } from "@cotal-ai/workspace";
import { setTimeout as delay } from "node:timers/promises";

const receiptPath = (pidPath: string): string => `${pidPath}.stop-confirmed`;

/** Windows reports code 1 for TerminateProcess. Record a confirmed stop of this exact launch. */
export function recordForegroundBrokerStop(pidPath: string, target: ProcessIdentityRecord): void {
  try { writePrivateRecord(receiptPath(pidPath), formatRecord(target)); }
  catch { /* A missing receipt must not prevent down from reporting the exit it observed. */ }
}

/** An unrelated exit, or a stop that found an already-dead process, has no matching receipt. */
export async function foregroundBrokerStopped(pidPath: string, target: ProcessIdentityRecord | undefined, code: number | null): Promise<boolean> {
  if (process.platform !== "win32" || code !== 1 || !target) return false;
  const deadline = Date.now() + 3000;
  try {
    for (;;) {
      const stopper = Number(readLocalRecordSource(stopReservationPath(pidPath), 32)?.toString());
      if (readLocalRecordSource(receiptPath(pidPath), 128, true)?.toString() === formatRecord(target)) return true;
      if (!Number.isSafeInteger(stopper) || stopper <= 0 || Date.now() >= deadline || probeLiveness(stopper) === "dead") return false;
      await delay(50);
    }
  } catch { return false; }
}
