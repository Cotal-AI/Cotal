import { lstatSync } from "node:fs";
import { inspectLock } from "./advisory-lock.js";
import { win32ProcessBinding, type Win32ProcessPin } from "./win32-process.js";
import type { UpdateRecovery } from "./updates.js";

const FILETIME_EPOCH = 116444736000000000n;
let retained: { key: string; pin: Win32ProcessPin; timer: ReturnType<typeof setInterval> } | undefined;

function releaseRetained(): void {
  if (!retained) return;
  clearInterval(retained.timer);
  retained.pin.close(); retained = undefined;
}

/** Compare a Windows process creation token with both durable publication times, without rounding. */
export function windowsOwnerPredatesRecord(token: string, recordedAt: string, lockBirthNs: bigint): boolean {
  if (!/^[1-9][0-9]*$/.test(token) || !Number.isFinite(Date.parse(recordedAt)) || lockBirthNs <= 0n) return false;
  const creation = BigInt(token);
  return creation < FILETIME_EPOCH + BigInt(Date.parse(recordedAt)) * 10000n
    && creation < FILETIME_EPOCH + lockBirthNs / 100n;
}

/** Windows-only compatibility for published owners without start tokens. Unknown evidence refuses. */
export function liveWindowsUpdateClosureOwner(record: UpdateRecovery, path: string): boolean {
  const owner = record.owner;
  if (!owner || !owner.nonce || process.platform !== "win32") return false;
  const key = JSON.stringify([owner.pid, owner.start, owner.nonce, record.recordedAt]);
  try {
    const before = lstatSync(path, { bigint: true });
    if (!before.isFile() || before.isSymbolicLink()) return false;
    const current = inspectLock(path);
    if (current.state !== "active" || current.owner.pid !== owner.pid || current.owner.nonce !== owner.nonce
      || (current.owner.start !== undefined && current.owner.start !== owner.start)) { releaseRetained(); return false; }
    if (retained?.key !== key) {
      releaseRetained();
      const pin = win32ProcessBinding().pinProcess(owner.pid);
      try {
        if ((owner.start ? pin.token !== owner.start : !windowsOwnerPredatesRecord(pin.token, record.recordedAt, before.birthtimeNs)) || pin.exited()) return false;
        const timer = setInterval(() => {
          try { if (pin.exited()) releaseRetained(); }
          catch { releaseRetained(); }
        }, 1000);
        timer.unref();
        retained = { key, pin, timer };
      } finally { if (retained?.pin !== pin) pin.close(); }
    }
    const after = lstatSync(path, { bigint: true });
    const confirmed = inspectLock(path);
    const same = before.dev === after.dev && before.ino === after.ino && before.birthtimeNs === after.birthtimeNs
      && confirmed.state === "active" && confirmed.owner.pid === owner.pid && confirmed.owner.nonce === owner.nonce
      && (confirmed.owner.start === undefined || confirmed.owner.start === owner.start) && !retained.pin.exited();
    if (!same) releaseRetained();
    return same;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") releaseRetained();
    return false;
  }
}
