import { randomUUID, createHash } from "node:crypto";
import { join } from "node:path";
import { claimIdentityRecord } from "@cotal-ai/workspace";

interface ComputerIdentity { v: 1; kind: "cotal-account-computer"; machineId: string }

/** Claim the computer identity before sending any account request, including after a crash. */
export function accountComputerId(home: string, account: { issuer: string; sub: string }): string {
  const key = createHash("sha256").update(JSON.stringify([account.issuer, account.sub])).digest("hex");
  return claimIdentityRecord(join(home, "daemon", "accounts", key, "computer.json"), "account computer identity", (raw: unknown): ComputerIdentity | undefined => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
    const value = raw as Record<string, unknown>;
    if (Object.keys(value).sort().join(",") !== "kind,machineId,v" || value.v !== 1 || value.kind !== "cotal-account-computer" || typeof value.machineId !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value.machineId)) return undefined;
    return value as unknown as ComputerIdentity;
  }, (): ComputerIdentity => ({ v: 1, kind: "cotal-account-computer", machineId: randomUUID() })).machineId;
}
