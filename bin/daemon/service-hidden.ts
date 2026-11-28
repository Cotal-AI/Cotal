import { createHash } from "node:crypto";
import { accessSync, constants, existsSync, readFileSync, realpathSync } from "node:fs";
import { delimiter, isAbsolute, join, posix } from "node:path";
import { inspectLock } from "@cotal-ai/core";
import type { DaemonPaths } from "./endpoint.js";
import { readReceipt } from "./install-receipt.js";
import { recordedSourceIdentity } from "./install-identity.js";
import { readServiceRepair, servicePolicyRepairFile } from "./service-repair.js";

/** Applications a service report says this shell can run and the service cannot see.
 *  Empty with no report or no unexpired local sign-in. The reason text is the one a hosted
 *  Manager records. This does not read the service. */
export function applicationsHiddenByReport(report: { readonly managers?: readonly { readonly connectors?: readonly { readonly agent: string; readonly state: string; readonly reason?: string }[] }[] } | undefined, signedIn: boolean): readonly string[] {
  if (!report || !signedIn) return [];
  const hidden = new Set<string>();
  for (const manager of report.managers ?? []) {
    for (const connector of manager.connectors ?? []) {
      if (connector.state === "available") continue;
      const missing = / harness needs (.+) on PATH/.exec(connector.reason ?? "")?.[1]?.split(", ") ?? [];
      if (missing.length > 0 && missing.every((binary) => resolveOnPath(binary) !== undefined)) hidden.add(connector.agent);
    }
  }
  return [...hidden].sort();
}

/** True when the recorded unit pins this CLI's entry. A missing receipt, an unreadable unit, or a
 *  unit whose bytes no longer match its receipt is false. This reads those two files only, so a
 *  quiet user manager cannot hide the sentence or show it for another installation. */
export function recordedUnitPinsThisEntry(paths: Pick<DaemonPaths, "state">): boolean {
  const receipt = readReceipt(paths);
  if (!receipt) return false;
  let bytes: Buffer;
  try { bytes = readFileSync(receipt.unitPath); }
  catch { return false; }
  if (createHash("sha256").update(bytes).digest("hex") !== receipt.unitSha256) return false;
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    const pinned = recordedSourceIdentity(receipt, receipt.mechanism ?? "systemd-user", () => [process.execPath, entry, "daemon", "serve"]);
    return pinned.same;
  } catch { return false; }
}

/** The sentence's next step. `daemon setup` only while that command can refresh this installation.
 *  A relative PATH entry, an unfinished repair, a missing unit and a unit another installation
 *  recorded name no command. */
export function serviceHiddenCommand(paths: Pick<DaemonPaths, "state">, path = process.env.PATH ?? ""): string | undefined {
  if (!absoluteSearchPath(path) || serviceRepairHeld(paths) || !recordedUnitPinsThisEntry(paths)) return undefined;
  return "daemon setup";
}

/** The same absolute-entry rule the unit uses before it inherits this shell's PATH. */
function absoluteSearchPath(value: string): boolean {
  const grammar = process.platform === "win32" ? { delimiter, isAbsolute } : posix;
  const entries = value.split(grammar.delimiter).filter((entry) => entry !== "");
  return entries.length > 0 && entries.every((entry) => grammar.isAbsolute(entry));
}

/** The same records `daemon setup` refuses before it rewrites the unit. A lock held by this
 *  process is the setup that is running, so it does not hide the sentence. */
function serviceRepairHeld(paths: Pick<DaemonPaths, "state">): boolean {
  if (process.platform !== "darwin" && process.platform !== "linux") return false;
  const held = inspectLock(join(paths.state, "service-repair.lock"));
  if (held.state === "active" && held.owner.pid !== process.pid) return true;
  if (repairRecord(paths.state)) return true;
  return process.platform === "linux" && repairRecord(paths.state, servicePolicyRepairFile(paths.state));
}

function repairRecord(state: string, file?: string): boolean {
  try { return (file ? readServiceRepair(state, file) : readServiceRepair(state)) !== undefined; }
  catch { return existsSync(file ?? join(state, "service-repair.json")); }
}

/** Whether this shell can run the named binary. A directory on PATH is not a binary. */
function resolveOnPath(bin: string, path = process.env.PATH ?? ""): string | undefined {
  if (!bin || bin.includes("/") || bin.includes("\\")) return undefined;
  for (const dir of path.split(delimiter)) {
    if (!dir) continue;
    const candidate = join(dir, bin);
    try { accessSync(candidate, constants.X_OK); return realpathSync(candidate); }
    catch { /* the next entry */ }
  }
  return undefined;
}
