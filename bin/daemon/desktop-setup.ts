import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { CommandFailure } from "@cotal-ai/workspace/local-observation";

/** An incomplete desktop replacement must never be started through the service controls. */
export function assertDesktopSetupComplete(executable = process.execPath, localAppData = process.env.LOCALAPPDATA, platform = process.platform): void {
  if (platform !== "win32" || !localAppData) return;
  const installPath = dirname(executable);
  let state: unknown;
  try { state = JSON.parse(readFileSync(join(localAppData, "CotalSetup", "service-update.json"), "utf8")); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw new CommandFailure("refused", "CONFLICT", "Setup was interrupted or its handover could not be read. Run the installer again before starting the service.");
  }
  const record = state && typeof state === "object" ? state as Record<string, unknown> : undefined;
  if (!record || record.schema !== 1 || typeof record.installPath !== "string") throw new CommandFailure("refused", "CONFLICT", "Setup was interrupted and its handover is invalid. Run the installer again before starting the service.");
  if (resolve(record.installPath).toLowerCase() !== resolve(installPath).toLowerCase()) return;
  if (record.phase === "ready") return;
  throw new CommandFailure("refused", "CONFLICT", "Setup was interrupted. Run the installer again before starting the service.");
}
