import { lstatSync, rmSync } from "node:fs";
import { writeSecretFileAtomic } from "@cotal-ai/core";
import { assertRecordIdentity, canonicalLocalProcessPath, formatRecord, identityRecord, NATS_PIDFILE, parsePid, parseRecord, readContainedRecord, stopReservationPath, type LocalProcess, type LocalProcessContext, type ProcessIdentityRecord } from "@cotal-ai/workspace";
import { stopLocalProcess } from "./local-process-stop.js";

const intentPath = (pidPath: string): string => `${stopReservationPath(pidPath)}.broker`;

function reservationIdentity(path: string): string | undefined {
  const stat = lstatSync(path, { bigint: true, throwIfNoEntry: false });
  return stat?.isFile() ? `${stat.dev}:${stat.ino}` : undefined;
}

/** Publish a broker stop request only after the stop verifies its target. The reservation covers
 * the pending request, and confirmed exits leave a receipt for a delayed foreground launcher. */
export function stopRetainedStackProcess(component: LocalProcess, context: LocalProcessContext): Promise<boolean> {
  if (component.pidFile !== NATS_PIDFILE) return stopLocalProcess(component, context);
  const path = intentPath(canonicalLocalProcessPath(NATS_PIDFILE, context));
  let requested: string | undefined;
  return stopLocalProcess(component, context, {
    beforeSignal: ({ target, stopper }) => {
      if (target.token === undefined) return;
      const owner = identityRecord(stopper.pid);
      const reservation = reservationIdentity(stopper.marker);
      if (!("token" in owner) || reservation === undefined) return;
      const broker = formatRecord({ pid: target.pid, token: target.token });
      writeSecretFileAtomic(path, `${broker}\n${formatRecord(owner)}\n${reservation}`);
      requested = broker;
    },
    afterFailedSignal: () => { if (requested !== undefined) rmSync(path, { force: true }); },
    afterConfirmedStop: () => { if (requested !== undefined) writeSecretFileAtomic(path, requested); },
  });
}

/** Recognize a confirmed stop of this broker birth or a request backed by its live reservation. */
export function brokerStopRequested(root: string, pidPath: string, target: ProcessIdentityRecord): boolean {
  const path = intentPath(pidPath), expected = formatRecord(target);
  const record = readContainedRecord(root, path);
  if (record.state === "content") {
    if (record.raw === expected) return true;
    const [broker, owner, inode, extra] = record.raw.split("\n");
    if (broker === expected && owner !== undefined && inode !== undefined && extra === undefined) {
      const stopper = parseRecord(owner);
      const marker = stopReservationPath(pidPath);
      const reservation = readContainedRecord(root, marker);
      if (stopper.kind === "record" && reservation.state === "content" && parsePid(reservation.raw) === stopper.record.pid) {
        try {
          if (reservationIdentity(marker) === inode && assertRecordIdentity(stopper.record).kind === "match") return true;
        } catch { /* The reservation is not verified. Check whether the stopper confirmed exit. */ }
      }
    }
  }
  // A confirming stopper can replace pending evidence before releasing the reservation.
  const confirmed = readContainedRecord(root, path);
  return confirmed.state === "content" && confirmed.raw === expected;
}
