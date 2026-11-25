import { readWindowsUpdatePause, WINDOWS_INTERRUPTED_UPDATE } from "./update-windows-state.js";
import { readUpdateRecovery } from "./updates.js";
import { recoveryDisposition } from "./update-recovery.js";
import { spawn } from "node:child_process";
import { acquireLock, acquireLockAsync } from "@cotal-ai/core";
import { cmdSpawnSpec } from "./win-cmd.js";
import { homedir } from "node:os";
import { join, parse } from "node:path";
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

function saveObservedVersion(version: string, cached: UpdateCheck | undefined, now: number): UpdateCheck & { firstSeenAt: number } {
  const seen = version === cached?.latest ? cached.firstSeenAt : undefined;
  const firstSeenAt = typeof seen === "number" && Number.isFinite(seen) ? seen : now;
  const next = { v: 1 as const, latest: version, attemptedAt: now, checkedAt: now, firstSeenAt };
  writeSecretFileAtomic(join(homeCotalDir(), "update-check.json"), `${JSON.stringify(next)}\n`);
  return next;
}

/** Record the updater's uncached npm observation under the same lock as scheduled checks. */
export async function observeUpdateVersion(version: string): Promise<number> {
  mkSecretDir(homeCotalDir());
  const held = await acquireLockAsync(join(homeCotalDir(), "update-check.lock"), { label: "update check", waitMs: 5000 });
  try { return saveObservedVersion(version, readUpdateCheck(), Date.now()).firstSeenAt; }
  finally { held.release(); }
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
      const child = spawn(command.file, command.args, { cwd: parse(homedir()).root, stdio: ["ignore", "pipe", "pipe"], windowsHide: true, windowsVerbatimArguments: command.windowsVerbatimArguments });
      let stdout = "";
      const timeout = setTimeout(() => child.kill(), 4000);
      child.stdout.on("data", chunk => { stdout += chunk; if (stdout.length > 8192) child.kill(); });
      child.stderr.resume();
      child.once("error", error => { clearTimeout(timeout); resolve({ error: error.message }); });
      child.once("close", code => {
        clearTimeout(timeout);
        try {
          const payload: unknown = JSON.parse(stdout);
          const version = Array.isArray(payload) && payload.length === 1 ? payload[0] : payload;
          if (code !== 0 || typeof version !== "string" || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) throw new Error("registry latest unavailable");
          resolve({ version });
        } catch { resolve({ error: "registry latest unavailable" }); }
      });
    });
    if (result.version) return saveObservedVersion(result.version, cached, now);
    const next: UpdateCheck = { ...cached, v: 1, attemptedAt: now, error: result.error };
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
    if (process.platform === "win32" && readWindowsUpdatePause()) return WINDOWS_INTERRUPTED_UPDATE;
    const recovery = readUpdateRecovery();
    if (recovery) {
      const decision = recoveryDisposition(recovery);
      return decision.action === "active" ? decision.instruction : `update needs repair: installed ${recovery.installed}; ${decision.instruction}`;
    }
  } catch { return "update state unreadable; automatic updates paused"; }
  const cached = readUpdateCheck();
  return !cached?.latest ? "update status unknown" : newerUpdate(cached.latest, current) ? `newer version ${cached.latest} available` : "up to date";
}
