import { chmodSync, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import { globalConfigDir } from "@cotal-ai/core";
import { protectedLocalDirectory, readUpdateRecovery, writeUpdateRecovery } from "@cotal-ai/workspace";
import { claimExtensionMutation } from "./ext-mutation.js";
import { acquireReconcileLock } from "../seed/lock.js";

export interface UpdateSnapshot {
  readonly path: string;
  restore(): void;
  discard(): void;
}

/** Capture the seed and operator prefix under their native writer barriers. */
export function snapshotUpdateClosure(): UpdateSnapshot {
  const config = globalConfigDir();
  protectedLocalDirectory(config, "the Cotal config folder");
  const lock = acquireReconcileLock();
  let release = () => {};
  let path: string;
  const present = new Set<string>();
  try {
    release = claimExtensionMutation({ waitMs: 30000 });
    path = mkdtempSync(join(config, ".update-snapshot-"));
    chmodSync(path, 0o700);
    for (const name of ["seed", "extensions"]) {
      const source = join(config, name);
      if (!existsSync(source)) continue;
      if (!lstatSync(source).isDirectory() || lstatSync(source).isSymbolicLink()) throw new Error(`cannot snapshot non-directory ${source}`);
      present.add(name);
      cpSync(source, join(path, name), { recursive: true, dereference: false, verbatimSymlinks: true, filter: candidate => !candidate.split(/[\\/]/).at(-1)!.startsWith("reconcile.lock") });
    }
  } finally { release(); lock.release(); }
  let restored = false;
  return {
    path,
    restore() {
      if (restored) throw new Error("update snapshot was already restored");
      // Keep the lock's original directory in place until its holder releases it.
      const seedLock = acquireReconcileLock();
      let releaseWriter = () => {};
      try {
        releaseWriter = claimExtensionMutation({ waitMs: 30000 });
        const recovery = readUpdateRecovery();
        if (!recovery || recovery.snapshot !== path) throw new Error("update snapshot does not match its recovery journal");
        const renames = recovery.renames ? [...recovery.renames] : [];
        if (!recovery.renames) {
          const destination = join(config, "extensions");
          if (existsSync(destination)) renames.push({ from: destination, to: join(path, "failed-extensions"), done: false });
          if (present.has("extensions")) renames.push({ from: join(path, "extensions"), to: destination, done: false });
          const seed = join(config, "seed");
          const previousSeed = join(path, "seed");
          const failedSeed = join(path, "failed-seed");
          mkdirSync(failedSeed, { mode: 0o700, recursive: true });
          for (const entry of readdirSync(seed)) {
            if (entry.startsWith("reconcile.lock")) continue;
            renames.push({ from: join(seed, entry), to: join(failedSeed, entry), done: false });
          }
          if (present.has("seed")) for (const entry of readdirSync(previousSeed)) {
            if (entry.startsWith("reconcile.lock")) continue;
            renames.push({ from: join(previousSeed, entry), to: join(seed, entry), done: false });
          }
          writeUpdateRecovery({ ...recovery, phase: "restoring", renames });
        }
        for (let index = 0; index < renames.length; index++) {
          const entry = renames[index]!;
          if (entry.done) continue;
          if (existsSync(entry.from)) {
            if (existsSync(entry.to)) throw new Error(`restore destination already exists: ${entry.to}`);
            renameSync(entry.from, entry.to);
          } else if (!existsSync(entry.to)) throw new Error(`restore entry is missing: ${entry.from}`);
          renames[index] = { ...entry, done: true };
          writeUpdateRecovery({ ...recovery, phase: "restoring", renames });
        }
        restored = true;
      } finally { releaseWriter(); seedLock.release(); }
    },
    discard() { rmSync(path, { recursive: true, force: true }); },
  };
}
