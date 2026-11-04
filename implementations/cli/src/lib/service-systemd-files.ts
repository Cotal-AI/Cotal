import { createHash } from "node:crypto";
import { lstatSync, mkdirSync } from "node:fs";
import { dirname, isAbsolute, relative, sep } from "node:path";
import { ensureDirNoSymlink, writeSecretFileCreateOnly } from "@cotal-ai/core";
import { CommandFailure, protectedLocalDirectory, readLocalRecordSource } from "@cotal-ai/workspace";

function ownedDirectory(path: string, privateState = false): void {
  protectedLocalDirectory(path);
  const stat = lstatSync(path);
  if (process.getuid === undefined || !stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid() || (stat.mode & (privateState ? 0o077 : 0o022)) !== 0) throw new CommandFailure("refused", "PERMISSION_DENIED", "the proposed systemd state directory is not owned and protected; no unit file was published");
}

/** The manager-selected unit directory may not exist yet. Create only physical, protected
 *  descendants of an existing protected ancestor; a unit filename is never an ownership claim. */
export function createSystemdPrivateHome(unitDirectory: string, privateHome: string): void {
  if (process.platform !== "linux" || !isAbsolute(unitDirectory) || !isAbsolute(privateHome) || relative(unitDirectory, privateHome).split(sep)[0] !== "cotal-service") throw new CommandFailure("refused", "USAGE_INVALID", "the private unit home is not under the selected native user-unit directory");
  const leaf = relative(unitDirectory, privateHome).split(sep);
  if (leaf.length !== 2 || leaf[0] !== "cotal-service" || !/^cotal-[0-9a-f]{64}$/.test(leaf[1]!)) throw new CommandFailure("refused", "USAGE_INVALID", "the private unit home is not one exact service directory");
  let ancestor = unitDirectory;
  const missing: string[] = [];
  for (;;) {
    try { lstatSync(ancestor); break; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const parent = dirname(ancestor);
      if (parent === ancestor) throw new CommandFailure("refused", "TARGET_UNAVAILABLE", "the native unit directory has no existing protected ancestor");
      missing.unshift(ancestor.slice(parent.length + (parent.endsWith(sep) ? 0 : 1)));
      ancestor = parent;
    }
  }
  protectedLocalDirectory(ancestor);
  let current = ancestor;
  for (const segment of missing) {
    current = ensureDirNoSymlink(current, segment);
    ownedDirectory(current);
  }
  ownedDirectory(unitDirectory);
  const serviceRoot = ensureDirNoSymlink(unitDirectory, "cotal-service");
  ownedDirectory(serviceRoot, true);
  mkdirSync(privateHome, { mode: 0o700 });
  ownedDirectory(privateHome, true);
}

/** Publish only at an absent final name. Verify the physical owned inode and exact source
 *  after creation; a failed or uncertain publication must be retained as an unknown step. */
export function assertSystemdSource(path: string, sha256: string, privateState = false): void {
  ownedDirectory(dirname(path), privateState);
  const stat = lstatSync(path);
  const observed = readLocalRecordSource(path, 64 * 1024, true);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== process.getuid!() || (stat.mode & 0o077) !== 0 || !observed || createHash("sha256").update(observed).digest("hex") !== sha256) throw new CommandFailure("unknown", "OPERATION_UNKNOWN", "the published native service source could not be verified against its exact recorded digest; no further native action was submitted");
}

export function createSystemdSource(path: string, bytes: string, sha256: string, privateState = false): void {
  ownedDirectory(dirname(path), privateState);
  writeSecretFileCreateOnly(path, bytes);
  assertSystemdSource(path, sha256, privateState);
}
