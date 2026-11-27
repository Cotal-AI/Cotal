/**
 * The local note of released runs one manager is still retrying. The next boot of that same manager
 * reads it and continues those retries. The note is this process's own bookkeeping, not a run record.
 */
import { createPrivateRecord, mkSecretDir } from "@cotal-ai/core";
import { existsSync, readFileSync, renameSync, unlinkSync } from "node:fs";
import { join } from "node:path";

export interface InterruptedRunRecovery {
  readonly runId: string;
  readonly timeout: string;
  readonly holder: string;
  readonly epoch: number;
  readonly fencingToken: number;
  readonly until: number;
}

function interruptedRunRecoveryPath(dir: string, endpoint: string): string {
  return join(dir, `interrupted-run-recovery.${endpoint.replace(/[^A-Za-z0-9_-]/g, "_")}.json`);
}

export function readInterruptedRunRecovery(dir: string, endpoint: string): InterruptedRunRecovery[] {
  const path = interruptedRunRecoveryPath(dir, endpoint);
  if (!existsSync(path)) return [];
  try {
    const raw: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (!Array.isArray(raw)) return [];
    return raw.flatMap((row) => interruptedRunRecoveryRow(row));
  } catch {
    return [];
  }
}

function interruptedRunRecoveryRow(row: unknown): InterruptedRunRecovery[] {
  if (row === null || typeof row !== "object") return [];
  const note = row as Record<string, unknown>;
  if (typeof note.runId !== "string" || typeof note.timeout !== "string" || typeof note.holder !== "string") return [];
  if (![note.epoch, note.fencingToken, note.until].every((value) => typeof value === "number" && Number.isSafeInteger(value) && value >= 0)) return [];
  return [{
    runId: note.runId, timeout: note.timeout, holder: note.holder,
    epoch: note.epoch as number, fencingToken: note.fencingToken as number, until: note.until as number,
  }];
}

export function writeInterruptedRunRecovery(dir: string, endpoint: string, rows: readonly InterruptedRunRecovery[]): void {
  const path = interruptedRunRecoveryPath(dir, endpoint);
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
