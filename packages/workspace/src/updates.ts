import { clearWindowsUpdateAfterManualSuccess } from "./update-windows-state.js";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { mkSecretDir, writeSecretFileAtomic, writeSecretFileCreateOnly } from "@cotal-ai/core";
import { homeCotalDir } from "./cotal-home.js";
import { recoveryOwner, recoverySnapshotProblem } from "./update-recovery.js";

/** Shared CLI and daemon update preferences, independent of telemetry. */
export interface UpdateSettings {
  readonly v: 1;
  readonly auto: boolean;
  readonly notify: boolean;
}

/** Target-issued local update actions. Unknown work never grants restart or stop authority. */
export type UpdateAdmission = {
  readonly hostedSpaces: readonly string[];
} & (
  | { readonly disposition: "restart-empty"; readonly occupied: 0 }
  | { readonly disposition: "deferred"; readonly occupied: number | null; readonly reason: string }
  | { readonly disposition: "consent-stop"; readonly occupied: number; readonly inventory: readonly {
    readonly space: string; readonly instanceId: string;
    readonly agents: readonly { readonly name: string; readonly id: string; readonly lifecycleUid: string }[];
  }[] }
);

/** Validate persisted target data before a bound reconcile child consumes it. */
export function validUpdateAdmission(value: unknown): value is UpdateAdmission {
  if (!value || typeof value !== "object") return false;
  const row = value as UpdateAdmission;
  if (!Array.isArray(row.hostedSpaces) || row.hostedSpaces.some(space => typeof space !== "string" || !space)) return false;
  if (row.disposition === "restart-empty") return row.occupied === 0;
  if (row.disposition === "deferred") return (row.occupied === null || Number.isSafeInteger(row.occupied) && row.occupied >= 0) && typeof row.reason === "string" && row.reason.length > 0 && row.reason.length <= 2000;
  return row.disposition === "consent-stop" && Number.isSafeInteger(row.occupied) && row.occupied > 0 && Array.isArray(row.inventory)
    && row.inventory.every(manager => manager && typeof manager.space === "string" && !!manager.space && typeof manager.instanceId === "string" && !!manager.instanceId && Array.isArray(manager.agents)
      && manager.agents.every((agent: { name?: unknown; id?: unknown; lifecycleUid?: unknown }) => agent && [agent.name, agent.id, agent.lifecycleUid].every(field => typeof field === "string" && !!field)))
    && row.inventory.reduce((sum, manager) => sum + manager.agents.length, 0) === row.occupied;
}

/** A replacement that could not be reconciled must stop unattended updates. */
export interface UpdateRecovery {
  readonly v: 1;
  readonly previous: string;
  readonly target: string;
  readonly installed: string;
  readonly phase: "replacing" | "restoring" | "verified-ready" | "paused";
  readonly owner?: { readonly pid: number; readonly start: string; readonly nonce: string };
  readonly preparedRestart?: boolean;
  /** Admission from the verified staged target, consumed only under the live parent capability. */
  readonly admission?: UpdateAdmission;
  readonly snapshot?: string;
  /** The verified published target is reconciling without using its foreign rollback snapshot. */
  readonly reconcileWithoutSnapshot?: boolean;
  /** Protected execution journal for staged publication. Absent on published in-place records. */
  readonly execution?: string;
  readonly renames?: readonly { readonly from: string; readonly to: string; readonly done: boolean }[];
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

/** Missing preferences use defaults. Explicit preference commands may preserve and reset damaged JSON. */
export function readUpdateSettings(recovered?: (backup: string) => void): UpdateSettings {
  const defaults: UpdateSettings = { v: 1, auto: true, notify: true };
  const path = join(homeCotalDir(), "update-settings.json");
  let contents: Buffer;
  try { contents = readFileSync(path); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return defaults;
    throw error;
  }
  let value: unknown;
  try { value = JSON.parse(contents.toString("utf8")); }
  catch (error) { if (!recovered) throw error; }
  const record = value as UpdateSettings;
  if (record && record.v === 1 && typeof record.auto === "boolean" && typeof record.notify === "boolean") return record;
  if (!recovered) throw new Error("invalid update settings in update-settings.json");
  const backup = `${path}.corrupt.${randomBytes(8).toString("hex")}`;
  mkSecretDir(homeCotalDir());
  writeSecretFileCreateOnly(backup, contents);
  save("update-settings.json", defaults);
  recovered(backup);
  return defaults;
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
  if (!record || record.v !== 1 || !["replacing", "restoring", "verified-ready", "paused"].includes(record.phase) ||
      ![record.previous, record.target, record.installed, record.reason, record.recordedAt].every(field => typeof field === "string")) throw new Error("invalid update recovery record in update-recovery.json");
  if (record.preparedRestart !== undefined && typeof record.preparedRestart !== "boolean") throw new Error("invalid prepared restart evidence");
  if (record.admission !== undefined && !validUpdateAdmission(record.admission)) throw new Error("invalid target update admission");
  if (record.snapshot !== undefined && typeof record.snapshot !== "string") throw new Error("invalid update snapshot path");
  if (record.reconcileWithoutSnapshot !== undefined && typeof record.reconcileWithoutSnapshot !== "boolean") throw new Error("invalid update snapshot reconciliation mode");
  if (record.execution !== undefined && typeof record.execution !== "string") throw new Error("invalid update execution journal path");
  if (record.renames !== undefined && (!Array.isArray(record.renames) || record.renames.some(entry => !entry || typeof entry.from !== "string" || typeof entry.to !== "string" || typeof entry.done !== "boolean"))) throw new Error("invalid update rename journal");
  if (record.owner && !recoveryOwner(record) && !recoverySnapshotProblem(record)) throw new Error("invalid update transaction owner");
  return record;
}

export function writeUpdateRecovery(record: Omit<UpdateRecovery, "v" | "recordedAt">): void {
  save("update-recovery.json", { ...record, v: 1, recordedAt: new Date().toISOString() });
}

/** Record completion from the updater itself, which can outlive the daemon generation. */
export function recordUpdateCompletion(version: string, result: string, success: boolean): void {
  const previous = readRecord("update-attempt.json") as { failures?: number } | undefined;
  const automatic = process.env.COTAL_AUTO_UPDATE === "1";
  if (success && !automatic && process.platform === "win32") clearWindowsUpdateAfterManualSuccess();
  save("update-attempt.json", { version, failures: success || !automatic ? 0 : previous?.failures ?? 1, result, next: Date.now() + (success ? 86400_000 : 3600_000) });
}

/** Record installed software whose connectors have not been reconciled. */
export function recordConnectorReconciliationDeferred(version: string, releaseInstalled: boolean): void {
  const result = releaseInstalled ? `installed ${version}; connector reconciliation is waiting for folder repair` : `CLI ${version} remains installed; connector reconciliation is waiting for folder repair`;
  save("update-attempt.json", { version, failures: 0, connectorReconciliationPending: true, deferred: result, result, next: Date.now() + 60_000 });
}

/** Count an automatic attempt only after replacement begins. */
export function recordUpdateReplacement(version: string): void {
  if (process.env.COTAL_AUTO_UPDATE !== "1") return;
  const previous = readRecord("update-attempt.json") as { failures?: number } | undefined;
  save("update-attempt.json", { version, failures: (previous?.failures ?? 0) + 1, result: `updating to ${version}`, next: Date.now() + 3600_000 });
}

/** Record an automatic attempt that did not begin replacement. Refund a resolution-only install refusal. */
export function recordUpdateDeferral(version: string, reason: string, registry = false, refundReplacement = false): void {
  if (process.env.COTAL_AUTO_UPDATE !== "1") return;
  const previous = readRecord("update-attempt.json") as { failures?: number } | undefined;
  save("update-attempt.json", { version, failures: Math.max(0, (previous?.failures ?? 0) - (refundReplacement ? 1 : 0)), deferred: reason, result: reason, next: Date.now() + (registry ? 3600_000 : 60_000) });
}

/** Schedule the release that was actually observed, with no failures carried over from another release. */
export function recordUpdateReleaseHold(version: string, next: number): void {
  const previous = readRecord("update-attempt.json") as { version?: string; failures?: number } | undefined;
  save("update-attempt.json", { version, failures: previous?.version === version ? previous.failures ?? 0 : 0, result: "waiting for release hold", next });
}

/** Record an automatic attempt this account cannot make. No retry is scheduled until a successful manual update records a new result. */
export function recordUpdateRefusal(version: string, reason: string): void {
  if (process.env.COTAL_AUTO_UPDATE !== "1") return;
  const previous = readRecord("update-attempt.json") as { failures?: number } | undefined;
  save("update-attempt.json", { version, failures: previous?.failures ?? 0, result: reason, next: Number.MAX_SAFE_INTEGER });
}

/** Keep a tombstone so completion is an atomic write, rather than an unlink race. */
export function clearUpdateRecovery(): void { save("update-recovery.json", null); }
