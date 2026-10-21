import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, readdirSync, readlinkSync, rmdirSync, unlinkSync, type Stats } from "node:fs";
import { join } from "node:path";
import { CommandFailure, protectedLocalDirectory } from "@cotal-ai/workspace";

const MAX_ENTRIES = 20_000;
const MAX_BYTES = 1024 * 1024 * 1024;

/** Bind a private seed tree without following package-manager symlinks. This is an ownership
 *  fingerprint for later removal, not a claim that seeded code or external link targets are safe. */
function scanPrivateSystemdTree(root: string) {
  if (process.platform !== "linux" || process.getuid === undefined || constants.O_NOFOLLOW === undefined || constants.O_NONBLOCK === undefined) throw new CommandFailure("refused", "UNSUPPORTED", "private unit tree inspection requires Linux no-follow file reads");
  protectedLocalDirectory(root);
  const owner = process.getuid();
  const digest = createHash("sha256");
  const inventory: { path: string; stat: Stats; kind: "directory" | "file" | "link" }[] = [];
  let entries = 0, bytes = 0;
  const visit = (path: string, name: string): void => {
    if (++entries > MAX_ENTRIES) throw new CommandFailure("refused", "TARGET_UNAVAILABLE", "the private unit store exceeds its bounded entry census");
    const before = lstatSync(path);
    if (before.uid !== owner || !before.isSymbolicLink() && (before.mode & 0o022) !== 0) throw new CommandFailure("refused", "PERMISSION_DENIED", "the private unit store includes an unowned or group-writable physical entry");
    digest.update(name).update("\0").update(String(before.mode & 0o777)).update("\0");
    if (before.isSymbolicLink()) {
      const target = readlinkSync(path);
      if (target.length > 4096) throw new CommandFailure("refused", "TARGET_UNAVAILABLE", "a private unit store link exceeds its bounded source");
      digest.update("link\0").update(target).update("\0");
    } else if (before.isDirectory()) {
      digest.update("directory\0");
      for (const child of readdirSync(path).sort()) visit(join(path, child), `${name}/${child}`);
    } else if (before.isFile()) {
      if (before.size > MAX_BYTES - bytes) throw new CommandFailure("refused", "TARGET_UNAVAILABLE", "the private unit store exceeds its bounded byte census");
      let fd: number;
      try { fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
      catch { throw new CommandFailure("refused", "CONFLICT", "a private unit source could not be opened as an unchanged regular file"); }
      try {
        const opened = fstatSync(fd);
        if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino || opened.size !== before.size) throw new CommandFailure("refused", "CONFLICT", "a private unit file changed before its exact read");
        const content = createHash("sha256"), buffer = Buffer.allocUnsafe(64 * 1024);
        let count = 0;
        for (;;) {
          const read = readSync(fd, buffer, 0, buffer.length, null);
          if (!read) break;
          count += read;
          if (count > before.size) throw new CommandFailure("refused", "CONFLICT", "a private unit file grew during its bounded read");
          content.update(buffer.subarray(0, read));
        }
        const after = fstatSync(fd);
        if (count !== before.size || after.dev !== before.dev || after.ino !== before.ino || after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs) throw new CommandFailure("refused", "CONFLICT", "a private unit file changed during its exact read");
        bytes += count;
        digest.update("file\0").update(String(count)).update("\0").update(content.digest("hex")).update("\0");
      } finally { closeSync(fd); }
    } else throw new CommandFailure("refused", "SCHEMA_INVALID", "the private unit store includes an unsupported filesystem entry");
    const after = lstatSync(path);
    if (after.dev !== before.dev || after.ino !== before.ino || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs || after.mode !== before.mode || after.size !== before.size) throw new CommandFailure("refused", "CONFLICT", "the private unit store changed during its ownership census");
    inventory.push({ path, stat: after, kind: before.isDirectory() ? "directory" : before.isSymbolicLink() ? "link" : "file" });
  };
  visit(root, ".");
  return { sha256: digest.digest("hex"), inventory };
}

export function fingerprintPrivateSystemdTree(root: string): string {
  return scanPrivateSystemdTree(root).sha256;
}

/** Delete only an unchanged bounded owned tree, child first. Symlinks are unlinked, never
 *  traversed. A failure after the first unlink is an unknown partial effect for the caller's
 *  retained uninstall intent; there is no automatic recursive retry. */
export function removePrivateSystemdTree(root: string, expectedSha256: string): void {
  const captured = scanPrivateSystemdTree(root);
  if (captured.sha256 !== expectedSha256) throw new CommandFailure("refused", "CONFLICT", "the private unit store differs from its saved source digest; no child was removed");
  for (const { path, stat, kind } of captured.inventory) {
    const current = lstatSync(path);
    if (current.dev !== stat.dev || current.ino !== stat.ino || current.mode !== stat.mode || current.uid !== stat.uid || kind !== "directory" && (current.size !== stat.size || current.mtimeMs !== stat.mtimeMs || current.ctimeMs !== stat.ctimeMs)) throw new CommandFailure("unknown", "OPERATION_UNKNOWN", "the private unit tree changed during removal; later entries were not touched");
    if (kind === "directory") rmdirSync(path);
    else unlinkSync(path);
  }
}
