import { createHash } from "node:crypto";
import { isAbsolute, join } from "node:path";
import { readLocalRecordSource } from "@cotal-ai/workspace";
import type { UnitReceipt } from "./install.js";

export interface ServiceRepairIntent {
  readonly v: 1;
  readonly receipt: UnitReceipt;
  readonly previousSource: string;
  readonly nextSource: string;
  readonly enabled: boolean;
}

export const serviceRepairFile = (state: string): string => join(state, "service-repair.json");
export const sourceDigest = (source: string): string => createHash("sha256").update(source).digest("hex");

/** A protected intent binds both permitted file states. Unknown content never becomes repair authority. */
export function readServiceRepair(state: string): ServiceRepairIntent | undefined {
  const bytes = readLocalRecordSource(serviceRepairFile(state), 256 * 1024, true);
  if (!bytes) return undefined;
  const value = JSON.parse(bytes.toString("utf8")) as ServiceRepairIntent;
  if (value.v !== 1 || typeof value.enabled !== "boolean" || typeof value.previousSource !== "string" || typeof value.nextSource !== "string"
    || value.receipt?.v !== 1 || value.receipt.mechanism !== "launchd-agent" || typeof value.receipt.unitSha256 !== "string"
    || typeof value.receipt.unit !== "string" || typeof value.receipt.unitPath !== "string" || typeof value.receipt.installedAt !== "string"
    || !isAbsolute(value.receipt.unitPath) || !/^[a-f0-9]{64}$/.test(value.receipt.unitSha256)
    || sourceDigest(value.previousSource) !== value.receipt.unitSha256) throw new Error("the daemon service repair intent is invalid; nothing was changed");
  return value;
}

/** A crash may leave either old or new source and receipt. Only those recorded pairs may resume. */
export function assertServiceRepairPair(intent: ServiceRepairIntent, receipt: UnitReceipt, source: string): void {
  const next = { ...intent.receipt, unitSha256: sourceDigest(intent.nextSource) };
  if (JSON.stringify(receipt) !== JSON.stringify(intent.receipt) && JSON.stringify(receipt) !== JSON.stringify(next)) throw new Error("the daemon service receipt changed outside repair; nothing was changed");
  if (source !== intent.previousSource && source !== intent.nextSource) throw new Error("the daemon service source changed outside repair; nothing was changed");
}
