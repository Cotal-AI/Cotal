import { lstatSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, resolve } from "node:path";
import { assertSocketPathFits } from "./protocol.js";

export function checkDarwinExecDirectory(directory: string, uid: number): void {
  const entry = lstatSync(directory);
  if (!isAbsolute(directory) || realpathSync.native(directory) !== directory || !entry.isDirectory() ||
      entry.uid !== uid || (entry.mode & 0o777) !== 0o700) throw new Error("unverified Darwin exec directory");
}

export function checkDarwinExecAddress(address: string, uid: number): string {
  if (process.platform !== "darwin" || !uid || resolve(address) !== address ||
      !/^e-[a-f0-9]{32}\.sock$/.test(basename(address))) throw new Error("unverified Darwin exec address");
  checkDarwinExecDirectory(dirname(address), uid);
  return assertSocketPathFits(address, "darwin");
}

export function checkDarwinExecSocket(address: string, uid: number) {
  const entry = lstatSync(checkDarwinExecAddress(address, uid), { bigint: true });
  if (!entry.isSocket() || entry.uid !== BigInt(uid) || (entry.mode & 0o777n) !== 0o600n)
    throw new Error("unverified Darwin exec socket");
  return entry;
}
