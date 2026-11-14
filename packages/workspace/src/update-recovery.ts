import { createHash } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { globalConfigDir, writeSecretFileAtomic } from "@cotal-ai/core";
import { processStartToken } from "./advisory-lock.js";
import { homeCotalDir } from "./cotal-home.js";
import type { UpdateRecovery } from "./updates.js";

export const UPDATE_RECOVERY_WAIT_MS = 60 * 60 * 1000;
export const updateRecoveryObservationName = "update-recovery-observed.json";

/** Inspect local snapshot metadata only. A foreign snapshot is never opened. */
export function recoverySnapshotProblem(record: UpdateRecovery): string | undefined {
  const path = record.snapshot;
  if (!path) return "the interrupted update has no snapshot path";
  if (!isAbsolute(path) || dirname(resolve(path)) !== resolve(globalConfigDir()) || !basename(path).startsWith(".update-snapshot-"))
    return "the interrupted update snapshot does not belong to this configuration";
  const info = lstatSync(path, { throwIfNoEntry: false });
  if (!info) return "the interrupted update snapshot is missing";
  if (!info.isDirectory() || info.isSymbolicLink()) return "the interrupted update snapshot is not a plain directory";
  return undefined;
}

/** Malformed historical owners have no authority, but the record remains intact for retention. */
export function recoveryOwner(record: UpdateRecovery): UpdateRecovery["owner"] {
  const owner = record.owner;
  return owner && Number.isSafeInteger(owner.pid) && owner.pid > 0 && typeof owner.start === "string" && owner.start.length > 0 && typeof owner.nonce === "string" ? owner : undefined;
}

/** A best-effort token's absence alone is not proof that its process has ended. */
export function recoveryProcessStartToken(pid: number): string | undefined {
  const start = processStartToken(pid);
  if (start !== undefined) return start;
  try { process.kill(pid, 0); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return undefined;
    throw error;
  }
  throw new Error(`cannot read process start token for pid ${pid}`);
}

function fingerprint(): string {
  return createHash("sha256").update(readFileSync(join(homeCotalDir(), "update-recovery.json"))).digest("hex");
}

function firstObserved(hash: string): number | undefined {
  const path = join(homeCotalDir(), updateRecoveryObservationName);
  const info = lstatSync(path, { throwIfNoEntry: false });
  if (info && (!info.isFile() || info.isSymbolicLink())) throw new Error("update recovery observation is not a plain file");
  let value;
  try { value = JSON.parse(readFileSync(path, "utf8")); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  if (value?.v !== 1 || typeof value.hash !== "string" || !Number.isFinite(value.firstObservedAt) || value.firstObservedAt < 0) throw new Error("invalid update recovery observation record");
  return value.hash === hash ? value.firstObservedAt : undefined;
}

/** Called only under exclusive updater access, never by status or notices. */
export function observeUnownedRecovery(now: number): void {
  const hash = fingerprint();
  if (firstObserved(hash) !== undefined) return;
  writeSecretFileAtomic(join(homeCotalDir(), updateRecoveryObservationName), `${JSON.stringify({ v: 1, hash, firstObservedAt: now })}\n`);
}

export type RecoveryDisposition = {
  readonly action: "restore" | "retire" | "active" | "wait" | "unreadable";
  readonly instruction: string;
  readonly problem?: string;
};

/** Shared diagnostics predict the updater's decision without changing any files. */
export function recoveryDisposition(record: UpdateRecovery, now = Date.now(), lookup = recoveryProcessStartToken): RecoveryDisposition {
  let problem: string | undefined;
  try { problem = recoverySnapshotProblem(record); }
  catch (error) { return { action: "unreadable", instruction: `Cannot inspect the interrupted update snapshot: ${error instanceof Error ? error.message : String(error)}. Correct access, then run \`cotal update --self\`.` }; }
  if (!problem) return { action: "restore", instruction: "Run `cotal update --self` to restore the interrupted update." };
  const facts = `Previous ${record.previous}, target ${record.target}, recorded ${record.recordedAt}, snapshot ${record.snapshot ?? "not recorded"}, recorded installed ${record.installed}. ${problem}. Installed files have not been verified.`;
  const owner = recoveryOwner(record);
  if (owner) {
    let start;
    try { start = lookup(owner.pid); }
    catch (error) { return { action: "unreadable", problem, instruction: `${facts} Cannot read update owner pid ${owner.pid}: ${error instanceof Error ? error.message : String(error)}. Correct process inspection access, then run \`cotal update --self\`.` }; }
    if (start !== undefined && start === owner.start) return { action: "active", problem, instruction: `${facts} An update is in progress in pid ${owner.pid}. Wait for that process to finish, then run \`cotal update --self\`.` };
    return { action: "retire", problem, instruction: `${facts} Run \`cotal update --self\` to retain these unusable records and continue the update.` };
  }
  try {
    const first = firstObserved(fingerprint());
    if (first !== undefined && now - first >= UPDATE_RECOVERY_WAIT_MS) return { action: "retire", problem, instruction: `${facts} The one-hour observation bound has elapsed. Run \`cotal update --self\` to retain these unusable records and continue the update.` };
    const left = first === undefined ? UPDATE_RECOVERY_WAIT_MS : Math.max(0, first + UPDATE_RECOVERY_WAIT_MS - now);
    return { action: "wait", problem, instruction: `${facts} No valid update owner is recorded. ${first === undefined ? "Run `cotal update --self` to start" : "Retry `cotal update --self` after"} the observation wait (${Math.ceil(left / 1000)} seconds remaining).` };
  } catch (error) { return { action: "unreadable", problem, instruction: `${facts} Cannot read update recovery observation: ${error instanceof Error ? error.message : String(error)}. Correct the observation file access or contents, then run \`cotal update --self\`.` }; }
}
