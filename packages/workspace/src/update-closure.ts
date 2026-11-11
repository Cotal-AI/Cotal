import { join } from "node:path";
import { homeCotalDir } from "./cotal-home.js";
import { readUpdateRecovery } from "./updates.js";
import { acquireLock, inspectLock, processStartToken, type HeldLock } from "./advisory-lock.js";

const OWNER = "COTAL_UPDATE_CLOSURE_OWNER";
const NONCE = "COTAL_UPDATE_CLOSURE_NONCE";
const START = "COTAL_UPDATE_CLOSURE_START";
let held: HeldLock | undefined;
let references = 0;
const lockPath = () => join(homeCotalDir(), ".update-closure.lock");

/** Reserve the outer closure barrier before taking seed or extension writer locks. */
export function claimUpdateClosureAccess(): () => void {
  const owner = process.env[OWNER];
  const nonce = process.env[NONCE];
  if (!held && (owner !== undefined || nonce !== undefined)) {
    const current = inspectLock(lockPath());
    if (current.state !== "active" || String(current.owner.pid) !== owner || current.owner.nonce !== nonce || (current.owner.start ?? "") !== (process.env[START] ?? ""))
      throw new Error("the update closure transaction owner is no longer active");
    return () => {};
  }
  if (!held) {
    const current = inspectLock(lockPath());
    if (current.state === "active") throw new Error("an update is in progress, retry in a minute");
    const recovery = readUpdateRecovery();
    if (recovery && recovery.phase !== "verified-ready") throw new Error("an interrupted update needs restoration; run cotal update --self");
    held = acquireLock(lockPath(), { label: "an update closure transaction", waitMs: 0 });
    process.env[OWNER] = String(process.pid);
    process.env[NONCE] = held.nonce;
    process.env[START] = processStartToken(process.pid) ?? "";
  }
  references++;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    if (--references === 0) {
      held!.release(); held = undefined;
      delete process.env[OWNER]; delete process.env[NONCE]; delete process.env[START];
    }
  };
}

/** Identity persisted in the existing recovery record before replacement. */
export function updateClosureOwner(): { pid: number; start: string; nonce: string } {
  if (!held) throw new Error("this process does not own the update closure transaction");
  return { pid: process.pid, start: processStartToken(process.pid) ?? "", nonce: held.nonce };
}

/** No generation may activate before reconciliation or restoration is verified. */
export function updateActivationBlocked(): boolean {
  const record = readUpdateRecovery();
  return record !== undefined && record.phase !== "verified-ready";
}

/** Delegate only the outer barrier, leaving each child responsible for native writer ownership. */
export function updateClosureChildEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  if (!held) throw new Error("this process does not own the update closure transaction");
  return { ...env, [OWNER]: String(process.pid), [NONCE]: held.nonce, [START]: processStartToken(process.pid) ?? "" };
}
