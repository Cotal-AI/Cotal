import { lstatSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { acquireLock, claimExtensionMutationLock, claimGlobalNpmUpdateLock, claimUpdateClosureAccess, connectorConfigDir, homeCotalDir, inspectLock, protectedResolvedDirectory, readLocalRecordSource, readUpdateRecovery, type LockOwner } from "@cotal-ai/workspace";

function deadWriter(path: string) {
  const stat = lstatSync(path, { bigint: true, throwIfNoEntry: false });
  if (!stat?.isFile()) return;
  const bytes = readLocalRecordSource(path, 1024, true);
  if (!bytes) return;
  const owner = JSON.parse(bytes.toString()) as LockOwner;
  if (typeof owner.start !== "string" || !owner.start || !Number.isSafeInteger(owner.pid) || owner.pid < 2 ||
      typeof owner.nonce !== "string" || inspectLock(path).state !== "stale") return;
  return { stat, owner, bytes };
}

const matches = (path: string, bytes: Buffer) => readLocalRecordSource(path, 1024, true)?.equals(bytes);

/** Recover only copies that were created while the same, now dead, updater held both writers. */
export function reclaimInterruptedUpdateSnapshots(globalRoot: () => string): void {
  const uid = process.getuid?.();
  if (uid === undefined) return;
  try {
    const config = protectedResolvedDirectory(connectorConfigDir(), "the Cotal config folder");
    const names = readdirSync(config).filter(name => /^\.update-snapshot-[A-Za-z0-9]{6}$/.test(name));
    if (!names.length || readUpdateRecovery()) return;
    const seed = join(config, "seed");
    if (protectedResolvedDirectory(seed) !== seed) return;
    const reconcile = join(seed, "reconcile.lock"), writer = join(config, ".extensions.lock");
    const closure = join(homeCotalDir(), ".update-closure.lock");
    const releaseGlobal = claimGlobalNpmUpdateLock(globalRoot());
    try {
      const outer = deadWriter(closure), a = deadWriter(reconcile), b = deadWriter(writer);
      if (!outer || !a || !b || [a, b].some(lock => lock.owner.pid !== outer.owner.pid || lock.owner.start !== outer.owner.start)) return;
      const releaseClosure = claimUpdateClosureAccess();
      try {
        if (readUpdateRecovery() || protectedResolvedDirectory(connectorConfigDir()) !== config || protectedResolvedDirectory(seed) !== seed) return;
        if (!matches(reconcile, a.bytes) || !matches(writer, b.bytes)) return;
        const lock = acquireLock(reconcile);
        try {
          if (!matches(writer, b.bytes)) return;
          const releaseWriter = claimExtensionMutationLock({}, config);
          try {
            for (const name of names) {
              const path = join(config, name);
              const stat = lstatSync(path, { bigint: true, throwIfNoEntry: false });
              if (stat?.isDirectory() && stat.uid === BigInt(uid) && (stat.mode & 0o077n) === 0n && stat.birthtimeNs > 0n &&
                  stat.birthtimeNs >= a.stat.mtimeNs && stat.birthtimeNs >= b.stat.mtimeNs) rmSync(path, { recursive: true, force: true });
            }
          } finally { releaseWriter(); }
        } finally { lock.release(); }
      } finally { releaseClosure(); }
    } finally { releaseGlobal(); }
  } catch { /* Cleanup never changes whether the update can proceed. */ }
}
