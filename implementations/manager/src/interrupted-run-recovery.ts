/**
 * The local note of released runs one manager is still retrying. The next boot of that same manager
 * reads it and continues those retries. The note is this process's own bookkeeping, not a run record.
 * It lives under the space's own directory, so another space on the same root never reads it.
 */
import { createPrivateRecord, mkSecretDir } from "@cotal-ai/core";
import { closeSync, constants, existsSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

export interface InterruptedRunRecovery {
  readonly runId: string;
  readonly timeout: string;
  readonly holder: string;
  readonly epoch: number;
  readonly fencingToken: number;
  readonly until: number;
}

/** A row the file held that was not a note. The caller logs it rather than dropping it silently. */
export interface InterruptedRunRecoveryRead {
  readonly notes: InterruptedRunRecovery[];
  readonly dropped: number;
  /** The file existed and could not be read as a note list. */
  readonly corrupt: boolean;
}

function interruptedRunRecoveryPath(dir: string): string {
  return join(dir, "interrupted-run-recovery.json");
}

export function readInterruptedRunRecovery(dir: string): InterruptedRunRecoveryRead {
  const path = interruptedRunRecoveryPath(dir);
  if (!existsSync(path)) return { notes: [], dropped: 0, corrupt: false };
  try {
    const raw: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (!Array.isArray(raw)) return { notes: [], dropped: 0, corrupt: true };
    const notes: InterruptedRunRecovery[] = [];
    let dropped = 0;
    for (const row of raw) {
      const note = interruptedRunRecoveryRow(row);
      if (note === undefined) dropped += 1;
      else notes.push(note);
    }
    return { notes, dropped, corrupt: false };
  } catch {
    return { notes: [], dropped: 0, corrupt: true };
  }
}

function interruptedRunRecoveryRow(row: unknown): InterruptedRunRecovery | undefined {
  if (row === null || typeof row !== "object") return undefined;
  const note = row as Record<string, unknown>;
  if (typeof note.runId !== "string" || typeof note.timeout !== "string" || typeof note.holder !== "string") return undefined;
  if (![note.epoch, note.fencingToken, note.until].every((value) => typeof value === "number" && Number.isSafeInteger(value) && value >= 0)) return undefined;
  return {
    runId: note.runId, timeout: note.timeout, holder: note.holder,
    epoch: note.epoch as number, fencingToken: note.fencingToken as number, until: note.until as number,
  };
}

export function writeInterruptedRunRecovery(dir: string, rows: readonly InterruptedRunRecovery[]): void {
  const path = interruptedRunRecoveryPath(dir);
  if (rows.length === 0) {
    try { unlinkSync(path); } catch { /* already gone */ }
    return;
  }
  mkSecretDir(dir);
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  try {
    createPrivateRecord(tmp, `${JSON.stringify(rows)}\n`);
    renameSync(tmp, path);
  } catch (error) {
    try { unlinkSync(tmp); } catch { /* the temp was not created */ }
    throw error;
  }
}

export const interruptedRunRecoveryStore = {
  write: writeInterruptedRunRecovery,
};

/** Read the note, change it, and write it back while holding the directory lock. A second process
 *  waits for the same lock, so the two updates cannot drop each other's rows. */
export async function updateInterruptedRunRecovery(dir: string, change: (read: InterruptedRunRecoveryRead) => readonly InterruptedRunRecovery[]): Promise<InterruptedRunRecoveryRead> {
  mkSecretDir(dir);
  const release = await lockInterruptedRunRecovery(dir);
  try {
    const read = readInterruptedRunRecovery(dir);
    interruptedRunRecoveryStore.write(dir, change(read));
    return read;
  } finally {
    release();
  }
}

/** An exclusive create, so a second process waits. The file names its holder, and a release deletes
 *  it only while that name is still there. A file left by a dead holder is replaced after a few
 *  seconds, which is long enough for the rewrite itself. */
async function lockInterruptedRunRecovery(dir: string): Promise<() => void> {
  const path = join(dir, "interrupted-run-recovery.lock");
  const token = `${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}`;
  const deadline = Date.now() + 5_000;
  for (;;) {
    try {
      const fd = openSync(path, constants.O_CREAT | constants.O_EXCL | constants.O_RDWR, 0o600);
      try { writeFileSync(fd, token); }
      catch (error) {
        closeSync(fd);
        try { unlinkSync(path); } catch { /* the create is this attempt's to undo */ }
        throw error;
      }
      closeSync(fd);
      return () => {
        try { if (readFileSync(path, "utf8") === token) unlinkSync(path); }
        catch { /* already released */ }
      };
    } catch (error) {
      if ((error as { code?: string }).code !== "EEXIST") throw error;
      try { if (Date.now() - statSync(path).mtimeMs > 5_000) unlinkSync(path); }
      catch { /* the holder released it between the check and the removal */ }
      if (Date.now() >= deadline) throw error;
      await delay(20);
    }
  }
}
