import { join } from "node:path";
import { homeCotalDir } from "./cotal-home.js";
import { readUpdateRecovery, type UpdateRecovery } from "./updates.js";
import { acquireLock, inspectLock, processStartToken, type HeldLock } from "./advisory-lock.js";
import { nativeWin32CreationToken } from "./win32-process.js";
import { liveWindowsUpdateClosureOwner } from "./update-closure-win32.js";

const ownerStart = (pid: number) => {
  if (process.platform !== "win32") return processStartToken(pid);
  const token = nativeWin32CreationToken(pid);
  if (!token) throw new Error("the Windows update owner creation token is unreadable");
  return token;
};

const OWNER = "COTAL_UPDATE_CLOSURE_OWNER";
const NONCE = "COTAL_UPDATE_CLOSURE_NONCE";
const START = "COTAL_UPDATE_CLOSURE_START";
let held: HeldLock | undefined;
let references = 0;
const lockPath = () => join(homeCotalDir(), ".update-closure.lock");

/** Wait without acquiring on read-only boot gates. A wait on another command's installation change
 *  says so after one second, so a command that prints nothing yet is not mistaken for a hang. */
export function waitForUpdateClosure(): boolean {
  let waitedForUpdate = false;
  const started = Date.now();
  const deadline = started + 300_000;
  let updateDeadline: number | undefined;
  let announced = false;
  let announcedWriter = false;
  for (;;) {
    const current = inspectLock(lockPath());
    const record = readUpdateRecovery();
    if (current.state !== "active") {
      if (record && record.phase !== "verified-ready") throw new Error("an interrupted update needs restoration; run `cotal update --self`");
      return waitedForUpdate;
    }
    if (String(current.owner.pid) === process.env[OWNER] && current.owner.nonce === process.env[NONCE]) return false;
    const updating = record?.owner?.pid === current.owner.pid && record.owner.nonce === current.owner.nonce;
    if (updating) {
      waitedForUpdate = true;
      updateDeadline ??= Date.now() + 120_000;
      if (!announced) { console.error("waiting for a Cotal update to finish"); announced = true; }
    } else if (!announcedWriter && Date.now() - started >= 1_000) {
      console.error(`waiting for another cotal command (pid ${current.owner.pid}) to finish changing this installation`);
      announcedWriter = true;
    }
    if (Date.now() >= (updating ? updateDeadline! : deadline)) throw new Error(updating ? "Cotal update did not finish within 120 seconds; retry once it finishes" : `closure writer pid ${current.owner.pid} did not finish within 300 seconds`);
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
  }
}

/** The other process that is changing this installation now, for a read that reports it and does
 *  not wait behind it. Undefined when nobody is, or when this process's own transaction is. */
export function installationWriter(): { pid: number } | undefined {
  const current = inspectLock(lockPath());
  if (current.state !== "active") return undefined;
  if (held || (String(current.owner.pid) === process.env[OWNER] && current.owner.nonce === process.env[NONCE])) return undefined;
  return { pid: current.owner.pid };
}

/** Reserve the outer closure barrier before taking seed or extension writer locks. */
export function claimUpdateClosureAccess(recover = false): () => void {
  const owner = process.env[OWNER];
  const nonce = process.env[NONCE];
  if (!held && (owner !== undefined || nonce !== undefined)) {
    const record = readUpdateRecovery();
    if (!record && process.env.COTAL_UPDATE_CLOSURE_TRANSACTION === "1") {
      delete process.env[OWNER]; delete process.env[NONCE]; delete process.env[START]; delete process.env.COTAL_UPDATE_CLOSURE_TRANSACTION;
      return claimUpdateClosureAccess();
    }
    const current = inspectLock(lockPath());
    const matchesStart = process.platform === "win32" && process.env[START] === "" && record
      ? liveWindowsUpdateClosureOwner(record, lockPath())
      : (process.platform === "win32" ? ownerStart(Number(owner)) ?? "" : current.state === "active" ? current.owner.start ?? "" : "") === (process.env[START] ?? "");
    if (current.state !== "active" || String(current.owner.pid) !== owner || current.owner.nonce !== nonce || !matchesStart)
      throw new Error("the update closure transaction owner is no longer active");
    if (record?.owner && (record.owner.nonce !== nonce || String(record.owner.pid) !== owner || record.owner.start !== (process.env[START] ?? ""))) throw new Error("the update closure capability does not match its recovery journal");
    return () => {};
  }
  if (!held) {
    if (!recover) waitForUpdateClosure();
    const start = ownerStart(process.pid) ?? "";
    held = acquireLock(lockPath(), { label: "a closure writer", waitMs: 300_000 });
    process.env[OWNER] = String(process.pid);
    process.env[NONCE] = held.nonce;
    process.env[START] = start;
  }
  references++;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    if (--references === 0) {
      held!.release(); held = undefined;
      delete process.env[OWNER]; delete process.env[NONCE]; delete process.env[START]; delete process.env.COTAL_UPDATE_CLOSURE_TRANSACTION;
    }
  };
}

/** Identity persisted in the existing recovery record before replacement. */
export function updateClosureOwner(): { pid: number; start: string; nonce: string } {
  if (!held) throw new Error("this process does not own the update closure transaction");
  process.env.COTAL_UPDATE_CLOSURE_TRANSACTION = "1";
  return { pid: process.pid, start: ownerStart(process.pid) ?? "", nonce: held.nonce };
}

/** Whether the recorded updater still owns this exact live closure, including its nonce. */
export function liveUpdateClosureOwner(record: UpdateRecovery, lookup = processStartToken): boolean {
  if (process.platform === "win32") return liveWindowsUpdateClosureOwner(record, lockPath());
  const owner = record.owner;
  if (!owner?.start || !owner.nonce) return false;
  try {
    const current = inspectLock(lockPath());
    return current.state === "active" && current.owner.pid === owner.pid && current.owner.start === owner.start
      && current.owner.nonce === owner.nonce && lookup(owner.pid) === owner.start;
  } catch { return false; }
}

/** No generation may activate before reconciliation or restoration is verified. */
export function updateActivationBlocked(): boolean {
  const record = readUpdateRecovery();
  return record !== undefined && record.phase !== "verified-ready";
}

/** Delegate only the outer barrier, leaving each child responsible for native writer ownership. */
export function updateClosureChildEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  if (!held) throw new Error("this process does not own the update closure transaction");
  return { ...env, [OWNER]: String(process.pid), [NONCE]: held.nonce, [START]: ownerStart(process.pid) ?? "" };
}
