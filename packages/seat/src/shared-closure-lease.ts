import { spawnSync } from "node:child_process";
import {
  chmodSync, closeSync, constants, fstatSync, lstatSync, mkdtempSync, opendirSync, openSync,
  readSync, realpathSync, renameSync, rmSync, rmdirSync, statfsSync, type BigIntStats,
} from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import type { SharedExecutionLease } from "./shared-execution-lease.js";
import { verifySharedRuntimeClosure } from "./shared-runtime-closure.js";

const digestPattern = /^[a-f0-9]{64}$/;
// Linux <linux/magic.h>: ext2/3/4, XFS, Btrfs and tmpfs. Refuse network, overlay and unknown mounts.
const localFilesystems = new Set([0xef53n, 0x58465342n, 0x9123683en, 0x01021994n]);
const MIN_AGE_MS = 24 * 60 * 60 * 1000;
const MAX_SCAN = 128;
const MAX_RECLAIM_ATTEMPTS = 4;
const DIR_FLAGS = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;

function same(a: BigIntStats, b: BigIntStats): boolean {
  return a.dev === b.dev && a.ino === b.ino;
}

function ownedDirectory(stat: BigIntStats, mode: bigint): boolean {
  return stat.isDirectory() && stat.uid === BigInt(process.getuid!()) && (stat.mode & 0o7777n) === mode;
}

function canonicalStore(store: string): string {
  if (process.platform !== "linux" || !isAbsolute(store) || !lstatSync(resolve(store)).isDirectory())
    throw new Error("invalid shared runtime closure store");
  const base = realpathSync(resolve(store));
  if (!ownedDirectory(lstatSync(base, { bigint: true }), 0o700n)) throw new Error("unprotected shared runtime closure store");
  return base;
}

function openLease(base: string, digest: string, exclusive: boolean): SharedExecutionLease {
  if (!digestPattern.test(digest)) throw new Error("invalid shared runtime closure digest");
  const baseStat = lstatSync(base, { bigint: true });
  const root = join(base, digest);
  const fd = openSync(root, DIR_FLAGS);
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    closeSync(fd);
  };
  try {
    const opened = fstatSync(fd, { bigint: true });
    const descriptor = `/proc/self/fd/${fd}`;
    if (!ownedDirectory(opened, 0o500n) || opened.dev !== baseStat.dev ||
        !localFilesystems.has(statfsSync(descriptor, { bigint: true }).type))
      throw new Error("unsupported shared runtime closure directory");
    const assertCurrent = () => {
      const currentBase = lstatSync(base, { bigint: true }), current = lstatSync(root, { bigint: true });
      if (released || realpathSync(descriptor) !== root || !same(currentBase, baseStat) ||
          !ownedDirectory(currentBase, 0o700n) || !same(current, opened) || !ownedDirectory(current, 0o500n))
        throw new Error("shared runtime closure path changed");
    };
    assertCurrent();
    // flock's fd 3 shares the parent's open file description. Closing the helper's copy
    // leaves the lock held until our fd closes. Never unlock explicitly in the helper.
    const locked = spawnSync("/usr/bin/flock", [exclusive ? "--exclusive" : "--shared", "--nonblock", "3"], {
      stdio: ["ignore", "ignore", "ignore", fd], env: {}, timeout: 2000, killSignal: "SIGKILL",
    });
    if (locked.error || locked.status !== 0) throw new Error("shared runtime closure lease unavailable");
    assertCurrent();
    return { dev: String(opened.dev), ino: String(opened.ino), assertCurrent, release };
  } catch (error) { release(); throw error; }
}

/** Pin the exact published inode before verification or use. Each holder opens independently. */
export function acquireSharedClosureLease(store: string, digest: string): SharedExecutionLease {
  return openLease(canonicalStore(store), digest, false);
}

// stat.dev alone misses bind mounts. Read the bounded kernel mount table and refuse mount
// points at or below the candidate. A private store is not a boundary against same-uid edits
// or a privileged concurrent mount; all participating users of the closure must use leases.
function assertNoMounts(root: string): void {
  const fd = openSync("/proc/self/mountinfo", constants.O_RDONLY);
  const bytes = Buffer.allocUnsafe(1024 * 1024);
  let offset = 0;
  try {
    while (offset < bytes.length) {
      const size = readSync(fd, bytes, offset, bytes.length - offset, null);
      if (!size) break;
      offset += size;
    }
  } finally { closeSync(fd); }
  const text = bytes.toString("utf8", 0, offset);
  if (offset === bytes.length || !text.endsWith("\n")) throw new Error("unproved runtime closure mount layout");
  for (const line of text.slice(0, -1).split("\n")) {
    const field = line.split(" ")[4];
    if (!field?.startsWith("/")) throw new Error("unrecognized mount information");
    const target = field.replace(/\\([0-7]{3})/g, (_match, octal: string) => String.fromCharCode(parseInt(octal, 8)));
    if (target === root || target.startsWith(`${root}/`)) throw new Error("mount in shared runtime closure");
  }
}

/** Validate either the full inventory or the exact private Node-only layout. A staged digest
 * includes external generation identity, so the collector never opens that generation. */
function inspectCandidate(base: string, digest: string, root: string): void {
  if (lstatSync(join(root, "inventory.json"), { throwIfNoEntry: false })) {
    verifySharedRuntimeClosure(base, digest);
    return;
  }
  for (const [dir, name] of [[root, "bin"], [join(root, "bin"), "node"]]) {
    if (!ownedDirectory(lstatSync(dir, { bigint: true }), 0o500n)) throw new Error("unexpected staged closure directory");
    const entries = opendirSync(dir);
    try { if (entries.readSync()?.name !== name || entries.readSync()) throw new Error("unexpected staged closure entry"); }
    finally { entries.closeSync(); }
  }
  const path = join(root, "bin/node");
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(fd, { bigint: true });
    const header = Buffer.alloc(4);
    if (!stat.isFile() || stat.uid !== BigInt(process.getuid!()) || stat.nlink !== 1n ||
        (stat.mode & 0o7777n) !== 0o500n || stat.size > 256n * 1024n * 1024n ||
        !same(stat, lstatSync(path, { bigint: true })) || readSync(fd, header, 0, 4, 0) !== 4 || header.toString("hex") !== "7f454c46")
      throw new Error("unexpected staged closure Node executable");
  } finally { closeSync(fd); }
}

function enableRemoval(root: string): void {
  chmodSync(root, 0o700);
  const entries = opendirSync(root);
  try {
    for (let entry = entries.readSync(); entry; entry = entries.readSync()) {
      if (entry.isDirectory()) enableRemoval(join(root, entry.name));
    }
  } finally { entries.closeSync(); }
}

/** Opportunistic reclamation of old private runtime copies, not execution generations.
 * Busy, malformed, unrecognized and recently published entries are always retained. */
export function collectSharedRuntimeClosures(store: string, currentDigest: string): number {
  if (!digestPattern.test(currentDigest)) return 0;
  let removed = 0;
  try {
    const base = canonicalStore(store);
    const dir = opendirSync(base);
    let attempts = 0;
    try {
      for (let scanned = 0; scanned < MAX_SCAN && attempts < MAX_RECLAIM_ATTEMPTS; scanned++) {
        const entry = dir.readSync();
        if (!entry) break;
        const digest = entry.name;
        if (digest === currentDigest || !digestPattern.test(digest) || !entry.isDirectory()) continue;
        const root = join(base, digest);
        try {
          const info = lstatSync(root);
          if (Date.now() - Math.max(info.mtimeMs, info.ctimeMs) < MIN_AGE_MS) continue;
          attempts++;
          const lease = openLease(base, digest, true);
          try {
            const locked = lstatSync(root);
            if (Date.now() - Math.max(locked.mtimeMs, locked.ctimeMs) < MIN_AGE_MS) continue;
            assertNoMounts(root);
            inspectCandidate(base, digest, root);
            const quarantine = mkdtempSync(join(base, ".collect-"));
            try {
              lease.assertCurrent();
              const moved = join(quarantine, "closure");
              // Linux requires write permission on a directory moved across parents.
              // While writable it cannot pass a new caller's lease or verification checks.
              chmodSync(root, 0o700);
              try { renameSync(root, moved); }
              catch (error) {
                const still = lstatSync(root, { bigint: true });
                if (String(still.dev) === lease.dev && String(still.ino) === lease.ino && ownedDirectory(still, 0o700n)) chmodSync(root, 0o500);
                throw error;
              }
              const exact = lstatSync(moved, { bigint: true });
              if (String(exact.dev) !== lease.dev || String(exact.ino) !== lease.ino || !ownedDirectory(exact, 0o700n))
                throw new Error("quarantined closure identity differs");
              assertNoMounts(moved);
              enableRemoval(moved);
              rmSync(moved, { recursive: true });
              removed++;
            } finally {
              // A partial failure stays quarantined. Do not recursively clean unknown leftovers.
              try { rmdirSync(quarantine); } catch { /* Keep unproved scratch state. */ }
            }
          } finally { lease.release(); }
        } catch { /* Lease loss, bad evidence, or filesystem failure: retain conservatively. */ }
      }
    } finally { dir.closeSync(); }
  } catch { /* Collection never blocks host admission. */ }
  return removed;
}
