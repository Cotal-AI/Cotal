import { readLocalRecordSource } from "./local-record-source.js";
import { join } from "node:path";
import { homeCotalDir } from "./cotal-home.js";
import { writeSecretFileAtomic } from "@cotal-ai/core";

export const WINDOWS_INTERRUPTED_UPDATE = "The last automatic update was interrupted. Restart the computer or run `cotal update` to clear it.";
export interface WindowsUpdatePause { readonly nonce: string; readonly bootId: number; }

/** A boot sequence comparison, never a wall-clock or process FILETIME subtraction. */
export function windowsBootDisposition(recorded: number, current: number): "same" | "later" {
  if (![recorded, current].every(value => Number.isInteger(value) && value >= 0 && value <= 0xffffffff) || current < recorded)
    throw new Error("Windows boot identity is unavailable or moved backwards");
  return current === recorded ? "same" : "later";
}

export function windowsUpdateManuallyCleared(nonce: string): boolean {
  const source = readLocalRecordSource(join(homeCotalDir(), "update-windows-clear.json"), 4096, true);
  if (!source) return false;
  const value = JSON.parse(source.toString("utf8"));
  if (value?.v !== 1 || typeof value.nonce !== "string" || !/^[a-f0-9]{32}$/.test(value.nonce)) throw new Error("invalid Windows automatic update clearance");
  return value.nonce === nonce;
}

export function readWindowsUpdatePause(): WindowsUpdatePause | undefined {
  const source = readLocalRecordSource(join(homeCotalDir(), "update-windows-paused.json"), 4096, true);
  if (!source) return undefined;
  const value = JSON.parse(source.toString("utf8"));
  if (value === null) return undefined;
  if (value?.v !== 1 || !/^[a-f0-9]{32}$/.test(value.nonce) || !Number.isInteger(value.bootId) || value.bootId < 0 || value.bootId > 0xffffffff) throw new Error("invalid Windows automatic update pause");
  return windowsUpdateManuallyCleared(value.nonce) ? undefined : value;
}

/** Successful manual reconciliation clears only the attempt it observed, never a future attempt. */
export function clearWindowsUpdateAfterManualSuccess(): void {
  const source = readLocalRecordSource(join(homeCotalDir(), "update-windows.json"), 64 * 1024, true);
  if (!source) return;
  const value = JSON.parse(source.toString("utf8"));
  if (!/^[a-f0-9]{32}$/.test(value?.nonce)) throw new Error("invalid Windows automatic update receipt");
  writeSecretFileAtomic(join(homeCotalDir(), "update-windows-clear.json"), `${JSON.stringify({ v: 1, nonce: value.nonce })}\n`);
}
