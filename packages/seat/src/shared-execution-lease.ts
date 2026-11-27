import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, realpathSync, statfsSync, type BigIntStats } from "node:fs";
import { basename, dirname, isAbsolute, join } from "node:path";

// Linux statfs magic values from <linux/magic.h>. Restrict flock to known local filesystems;
// NFS, SMB, FUSE, overlay (whose backing mount is unknown) and unrecognized mounts fail closed.
const localFilesystems = new Set([0xef53n, 0x58465342n, 0x9123683en, 0x01021994n]); // ext2/3/4, XFS, Btrfs, tmpfs
const maxInventoryBytes = 4 * 1024 * 1024;

export interface SharedExecutionLease {
  readonly dev: string;
  readonly ino: string;
  assertCurrent(): void;
  release(): void;
}

function identity(stat: BigIntStats): string {
  return `${stat.dev}:${stat.ino}`;
}

function revision(stat: BigIntStats): string {
  return `${identity(stat)}:${stat.size}:${stat.mode}:${stat.uid}:${stat.mtimeNs}:${stat.ctimeNs}`;
}

/** Acquire a Linux flock on a verified generation's existing inventory inode. Each participant
 * opens independently and holds its own fd until the handoff is proved or its custody ends. */
export function acquireSharedExecutionLease(root: string, mode: "shared" | "exclusive", expectedInventorySha256?: string): SharedExecutionLease {
  const generation = dirname(root), store = dirname(generation);
  if (process.platform !== "linux" || !isAbsolute(root) || root !== join(generation, "cotal-ai") ||
      basename(store) !== ".cotal-generations" || !/^[a-f0-9]{32}$/.test(basename(generation)) ||
      (mode !== "shared" && mode !== "exclusive") ||
      (expectedInventorySha256 !== undefined && !/^[a-f0-9]{64}$/.test(expectedInventorySha256)))
    throw new Error("invalid shared execution lease request");
  if (realpathSync(root) !== root || !lstatSync(root).isDirectory()) throw new Error("unsafe shared execution generation");
  const path = join(generation, "inventory.json");
  const generationStat = lstatSync(generation, { bigint: true });
  const rootStat = lstatSync(root, { bigint: true });
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    closeSync(fd);
  };
  try {
    const opened = fstatSync(fd, { bigint: true });
    const uid = BigInt(process.getuid!());
    if (!opened.isFile() || opened.nlink !== 1n || (opened.uid !== uid && opened.uid !== 0n) ||
        (opened.mode & 0o022n) !== 0n || opened.size < 1n || opened.size > BigInt(maxInventoryBytes))
      throw new Error("unsafe shared execution inventory");
    const descriptor = `/proc/self/fd/${fd}`;
    if (!localFilesystems.has(statfsSync(descriptor, { bigint: true }).type))
      throw new Error("shared execution inventory is not on a supported local filesystem");
    const assertCurrent = () => {
      if (released || realpathSync(descriptor) !== path ||
          revision(fstatSync(fd, { bigint: true })) !== revision(opened) ||
          revision(lstatSync(path, { bigint: true })) !== revision(opened) ||
          identity(lstatSync(generation, { bigint: true })) !== identity(generationStat) ||
          identity(lstatSync(root, { bigint: true })) !== identity(rootStat))
        throw new Error("shared execution lease inode or generation changed");
    };
    assertCurrent();
    // fd 3 in flock is a duplicate of our open file description. flock exits without unlocking;
    // the kernel retains the lock until our last reference closes, not until that helper exits.
    const lock = spawnSync("/usr/bin/flock", [`--${mode}`, "--nonblock", "3"], {
      stdio: ["ignore", "ignore", "ignore", fd], env: {}, timeout: 2000, killSignal: "SIGKILL",
    });
    if (lock.status !== 0 || lock.error) throw new Error("shared execution inventory lease unavailable");
    assertCurrent();
    if (expectedInventorySha256 !== undefined) {
      const bytes = Buffer.allocUnsafe(Number(opened.size));
      for (let offset = 0; offset < bytes.length;) {
        const count = readSync(fd, bytes, offset, bytes.length - offset, offset);
        if (!count) throw new Error("shared execution inventory truncated");
        offset += count;
      }
      const inventory: unknown = JSON.parse(bytes.toString("utf8"));
      if (!Array.isArray(inventory) || createHash("sha256").update(JSON.stringify(inventory)).digest("hex") !== expectedInventorySha256)
        throw new Error("shared execution lease inventory digest mismatch");
      assertCurrent();
    }
    return { dev: String(opened.dev), ino: String(opened.ino), assertCurrent, release };
  } catch (error) { release(); throw error; }
}
