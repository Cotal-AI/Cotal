import { readFileSync } from "node:fs";
import { join } from "node:path";
import { mkSecretDir, writeSecretFileAtomic } from "@cotal-ai/core";
import { homeCotalDir } from "./cotal-home.js";

/** Shared CLI and daemon update preferences, independent of telemetry. */
export interface UpdateSettings {
  readonly v: 1;
  readonly auto: boolean;
  readonly notify: boolean;
}

/** A replacement that could not be reconciled must stop unattended updates. */
export interface UpdateRecovery {
  readonly v: 1;
  readonly previous: string;
  readonly target: string;
  readonly installed: string;
  readonly phase: "replacing" | "paused";
  readonly reason: string;
  readonly recordedAt: string;
}

function readRecord(name: string): unknown {
  try { return JSON.parse(readFileSync(join(homeCotalDir(), name), "utf8")); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

function save(name: string, value: unknown): void {
  mkSecretDir(homeCotalDir());
  writeSecretFileAtomic(join(homeCotalDir(), name), `${JSON.stringify(value, null, 2)}\n`);
}

/** Missing preferences use the documented defaults, malformed preferences refuse. */
export function readUpdateSettings(): UpdateSettings {
  const value = readRecord("update-settings.json");
  if (value === undefined) return { v: 1, auto: true, notify: true };
  const record = value as UpdateSettings;
  if (!record || record.v !== 1 || typeof record.auto !== "boolean" || typeof record.notify !== "boolean") throw new Error("invalid update settings in update-settings.json");
  return record;
}

export function setUpdateSetting(key: "auto" | "notify", enabled: boolean): UpdateSettings {
  const settings = { ...readUpdateSettings(), [key]: enabled };
  save("update-settings.json", settings);
  return settings;
}

/** An unreadable recovery record is an error, never evidence that an install is healthy. */
export function readUpdateRecovery(): UpdateRecovery | undefined {
  const value = readRecord("update-recovery.json");
  if (value === undefined || value === null) return undefined;
  const record = value as UpdateRecovery;
  if (!record || record.v !== 1 || !["replacing", "paused"].includes(record.phase) ||
      ![record.previous, record.target, record.installed, record.reason, record.recordedAt].every(field => typeof field === "string")) throw new Error("invalid update recovery record in update-recovery.json");
  return record;
}

export function writeUpdateRecovery(record: Omit<UpdateRecovery, "v" | "recordedAt">): void {
  save("update-recovery.json", { ...record, v: 1, recordedAt: new Date().toISOString() });
}

/** Record completion from the updater itself, which can outlive the daemon generation. */
export function recordUpdateCompletion(version: string, result: string, success: boolean): void {
  const previous = readRecord("update-attempt.json") as { failures?: number } | undefined;
  const automatic = process.env.COTAL_AUTO_UPDATE === "1";
  save("update-attempt.json", { version, failures: success || !automatic ? 0 : previous?.failures ?? 1, result, next: Date.now() + (success ? 86400_000 : 3600_000) });
}

/** Keep a tombstone so completion is an atomic write, rather than an unlink race. */
export function clearUpdateRecovery(): void { save("update-recovery.json", null); }
