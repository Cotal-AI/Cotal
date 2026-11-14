import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { DaemonPaths } from "./endpoint.js";
import type { UnitReceipt } from "./install.js";

/** Where the receipt lives: beside the lifetime lock, in this daemon's own state directory. */
export function unitReceiptFile(paths: Pick<DaemonPaths, "state">): string {
  return join(paths.state, "service-unit.json");
}

/** Read the existing installer receipt shape without loading installation commands. */
export function readReceipt(paths: Pick<DaemonPaths, "state">): UnitReceipt | undefined {
  let o: unknown;
  try { o = JSON.parse(readFileSync(unitReceiptFile(paths), "utf8")); } catch { return undefined; }
  if (!o || typeof o !== "object") return undefined;
  const r = o as Record<string, unknown>;
  if (r.v !== 1 || typeof r.unit !== "string" || typeof r.unitPath !== "string" || typeof r.unitSha256 !== "string" || typeof r.installedAt !== "string") return undefined;
  if (r.mechanism !== undefined && r.mechanism !== "systemd-user" && r.mechanism !== "launchd-agent" && r.mechanism !== "scheduled-task") return undefined;
  return { v: 1, ...(r.mechanism !== undefined ? { mechanism: r.mechanism } : {}), unit: r.unit, unitPath: r.unitPath, unitSha256: r.unitSha256, installedAt: r.installedAt, ...(typeof r.daemonHome === "string" ? { daemonHome: r.daemonHome } : {}) };
}
