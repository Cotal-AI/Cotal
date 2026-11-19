import { holdsManagedHandoff } from "../managed-handoff.js";

export const ENROLLMENT_URL_ENV = "COTAL_ENROLLMENT_URL";
export const ENROLLMENT_FILE_ENV = "COTAL_ENROLLMENT_FILE";

/** Custody has already removed the managed handoff variable before argument parsing. */
export function isPersistedSpawn(): boolean {
  return holdsManagedHandoff() || Boolean(process.env[ENROLLMENT_URL_ENV] || process.env[ENROLLMENT_FILE_ENV]);
}

/** A public caller gets the same guidance whether parsing or validation first sees the flag. */
export const reservedSpawnConfig = {
  message: "--config is reserved for persisted internal launch callers",
  remedy: "use `cotal spawn <persona>` for a catalog name or `cotal spawn --file <persona-file>` for a file",
} as const;
