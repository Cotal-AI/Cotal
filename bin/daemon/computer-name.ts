import { execFileSync } from "node:child_process";
import { hostname } from "node:os";
import { join } from "node:path";
import { claimIdentityRecord } from "@cotal-ai/workspace";
import { writeSecretFileAtomic } from "@cotal-ai/core";
import { computerName } from "./name-validation.js";

export function defaultComputerName(): string {
  if (process.platform === "darwin") {
    for (const key of ["ComputerName", "LocalHostName"]) {
      try {
        const value = execFileSync("/usr/sbin/scutil", ["--get", key], { encoding: "utf8", timeout: 3000, stdio: ["ignore", "pipe", "ignore"] }).trim();
        if (value) return computerName(value);
      } catch { /* An unset persistent preference uses the next documented name. */ }
    }
  }
  if (process.platform === "win32") return computerName(execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", "[System.Environment]::MachineName"], { encoding: "utf8", timeout: 5000, windowsHide: true }).trim());
  return computerName(hostname());
}
const pathFor = (home: string) => join(home, "daemon", "computer-name.json");
export function readComputerName(home: string): string {
  return claimIdentityRecord(pathFor(home), "computer name", (raw: unknown): { v: 1; name: string } | undefined => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
    const r = raw as Record<string, unknown>;
    if (r.v !== 1 || Object.keys(r).sort().join(",") !== "name,v") return undefined;
    try { return { v: 1, name: computerName(r.name) }; } catch { return undefined; }
  }, () => ({ v: 1 as const, name: defaultComputerName() })).name;
}
export function saveComputerName(home: string, value: unknown): string {
  const name = computerName(value);
  readComputerName(home);
  writeSecretFileAtomic(pathFor(home), JSON.stringify({ v: 1, name }));
  return name;
}
