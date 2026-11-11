import { readUpdateRecovery } from "./updates.js";
import { spawn } from "node:child_process";
import { acquireLock } from "@cotal-ai/core";
import { cmdSpawnSpec } from "./win-cmd.js";
import { join } from "node:path";
import { homeCotalDir } from "./cotal-home.js";
import { readFileSync } from "node:fs";
import { mkSecretDir, writeSecretFileAtomic } from "@cotal-ai/core";

export const UPDATE_DAY_MS = 24 * 60 * 60 * 1000;
export const UPDATE_HOUR_MS = 60 * 60 * 1000;
export interface UpdateCheck {
  readonly v: 1;
  readonly latest?: string;
  readonly checkedAt?: number;
  readonly firstSeenAt?: number;
  readonly attemptedAt: number;
  readonly error?: string;
}

export function readUpdateCheck(): UpdateCheck | undefined {
  try {
    const value = JSON.parse(readFileSync(join(homeCotalDir(), "update-check.json"), "utf8"));
    if (!value || value.v !== 1 || !Number.isFinite(value.attemptedAt) || value.latest !== undefined && !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(value.latest)) return undefined;
    return value;
  } catch { return undefined; }
}

/** Registry access goes through npm so scoped registry, proxy and TLS policy stay authoritative. */
export async function checkForUpdate(): Promise<UpdateCheck | undefined> {
  if (process.env.COTAL_NO_UPDATE_CHECK === "1") return readUpdateCheck();
  mkSecretDir(homeCotalDir());
  let held;
  try { held = acquireLock(join(homeCotalDir(), "update-check.lock"), { label: "update check", waitMs: 0 }); }
  catch { return readUpdateCheck(); }
  try {
    const now = Date.now();
    const cached = readUpdateCheck();
    if (cached && now - (cached.checkedAt ?? 0) < UPDATE_DAY_MS && !cached.error || cached && now - cached.attemptedAt < UPDATE_HOUR_MS) return cached;
    const result = await new Promise<{ version?: string; error?: string }>(resolve => {
      const command = cmdSpawnSpec("npm", ["view", "cotal-ai@latest", "version", "--json", "--fetch-retries=0", "--fetch-timeout=3000", "--update-notifier=false"]);
      const child = spawn(command.file, command.args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true, windowsVerbatimArguments: command.windowsVerbatimArguments });
      let stdout = "";
      const timeout = setTimeout(() => child.kill(), 4000);
      child.stdout.on("data", chunk => { stdout += chunk; if (stdout.length > 8192) child.kill(); });
      child.stderr.resume();
      child.once("error", error => { clearTimeout(timeout); resolve({ error: error.message }); });
      child.once("close", code => {
        clearTimeout(timeout);
        try {
          const version: unknown = JSON.parse(stdout);
          if (code !== 0 || typeof version !== "string" || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) throw new Error("registry latest unavailable");
          resolve({ version });
        } catch { resolve({ error: "registry latest unavailable" }); }
      });
    });
    const next: UpdateCheck = result.version ? { v: 1, latest: result.version, attemptedAt: now, checkedAt: now, firstSeenAt: result.version === cached?.latest ? cached.firstSeenAt ?? now : now } : { ...cached, v: 1, attemptedAt: now, error: result.error };
    writeSecretFileAtomic(join(homeCotalDir(), "update-check.json"), `${JSON.stringify(next)}\n`);
    return next;
  } finally { held.release(); }
}

/** Compare stable numeric releases without treating prereleases as newer stable versions. */
export function newerUpdate(latest: string, current: string): boolean {
  const a = latest.split(".").map(Number), b = current.split(".").map(Number);
  if (a.length !== 3 || b.length !== 3 || !a.every(Number.isInteger) || !b.every(Number.isInteger)) return false;
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i]! > b[i]!;
  return false;
}

export function cachedUpdateSummary(current: string): string {
  try {
    const recovery = readUpdateRecovery();
    if (recovery) return `update needs repair: installed ${recovery.installed}; automatic updates paused; run cotal update --self`;
  } catch { return "update state unreadable; automatic updates paused"; }
  const cached = readUpdateCheck();
  return !cached?.latest ? "update status unknown" : newerUpdate(cached.latest, current) ? `newer version ${cached.latest} available` : "up to date";
}
