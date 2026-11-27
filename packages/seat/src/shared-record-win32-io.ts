import { closeSync, fstatSync, fsyncSync, lstatSync, openSync, readSync, realpathSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { seatId } from "./record.js";
import { checkWindowsCustodyPath, checkWindowsCustodyRoot } from "./shared-files-win32.js";
import type { VerifiedRead } from "./shared-managed-platform.js";

const MAX_RECORD = 64 * 1024;

function checkRecordAddress(path: string): void {
  const leaf = basename(path);
  if (resolve(path) !== path || !/^[a-z]:\\/i.test(path) || !/^[a-z0-9_.-]+$/i.test(leaf) || /[.]$/.test(leaf) ||
      /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(leaf))
    throw new Error("unknown Windows PTY record address");
}

export function checkWindowsRecordFile(path: string): void {
  checkRecordAddress(path);
  checkWindowsCustodyPath(path, false);
  if (realpathSync.native(path).toLowerCase() !== path.toLowerCase() || lstatSync(path).nlink !== 1)
    throw new Error("unknown Windows PTY record path");
}

function recordBytes(value: unknown): Buffer {
  const json = JSON.stringify(value);
  if (json === undefined) throw new Error("missing Windows PTY record");
  return Buffer.from(`${json}\n`, "utf8");
}

function checkBound(bound: number): void {
  if (!Number.isSafeInteger(bound) || bound < 1 || bound > MAX_RECORD) throw new Error("invalid Windows PTY record bound");
}

/** Only a missing leaf below an already verified private directory proves absence. */
export function readWindowsPrivateRecord(path: string, bound = MAX_RECORD): VerifiedRead<unknown> {
  try {
    checkBound(bound);
    checkRecordAddress(path);
    checkWindowsCustodyRoot(dirname(path));
    if (!lstatSync(path, { throwIfNoEntry: false })) {
      checkWindowsCustodyRoot(dirname(path));
      return { state: "absent" };
    }
    checkWindowsRecordFile(path);
    const fd = openSync(path, "r");
    try {
      const stat = fstatSync(fd);
      if (!stat.isFile() || stat.nlink !== 1 || stat.size > bound) return { state: "unknown" };
      const bytes = Buffer.alloc(bound + 1);
      let count = 0;
      while (count < bytes.length) {
        const read = readSync(fd, bytes, count, bytes.length - count, count);
        if (read === 0) break;
        count += read;
      }
      if (count > bound) return { state: "unknown" };
      const data = bytes.subarray(0, count);
      const value: unknown = JSON.parse(data.toString("utf8"));
      if (!data.equals(recordBytes(value))) return { state: "unknown" };
      return { state: "verified", value };
    } finally { closeSync(fd); }
  } catch { return { state: "unknown" }; }
}

export function writeWindowsPrivateRecord(path: string, value: unknown, bound = MAX_RECORD): void {
  checkBound(bound);
  checkRecordAddress(path);
  const bytes = recordBytes(value);
  if (bytes.length > bound) throw new Error("Windows PTY record exceeds its write bound");
  const parent = dirname(path);
  checkWindowsCustodyRoot(parent);
  const temp = join(parent, `.record-${seatId()}`);
  const fd = openSync(temp, "wx");
  let renamed = false;
  try {
    try {
      checkWindowsRecordFile(temp);
      writeFileSync(fd, bytes);
      fsyncSync(fd);
    } finally { closeSync(fd); }
    if (lstatSync(path, { throwIfNoEntry: false })) checkWindowsRecordFile(path);
    renameSync(temp, path);
    renamed = true;
    checkWindowsRecordFile(path);
  } finally { if (!renamed) unlinkSync(temp); }
}
