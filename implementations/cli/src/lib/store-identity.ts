import { realpathSync, statSync } from "node:fs";
import { missingStoreWarning } from "./store-dir.js";
import type { OutputWarning } from "@cotal-ai/workspace";
import type { StackJournal } from "./stack-journal.js";

/** The directory a broker was prepared to open, independent of its contents and timestamps. */
export interface StoreIdentity { path: string; dev: string; ino: string; birthtimeNs: string }

export function readStoreIdentity(dir: string): StoreIdentity {
  const path = realpathSync.native(dir), stat = statSync(path, { bigint: true });
  if (!stat.isDirectory()) throw new Error("the recorded broker store is not a directory");
  return { path, dev: stat.dev.toString(), ino: stat.ino.toString(), birthtimeNs: stat.birthtimeNs.toString() };
}

/** Read-only diagnosis. Old journals have no identity to compare, but still report a missing store.
 *  A running broker can serve its old open files after replacement, so a live refresh must never
 *  accept the directory now at its path as the store that broker opened. */
export function stackStoreWarnings(journal: StackJournal, starting = false): OutputWarning[] {
  if (!journal.broker) return [];
  const { storeDir, storeIdentity: recorded } = journal.broker;
  const target = { root: journal.root, space: journal.space, storeDir };
  let current: StoreIdentity;
  try { current = readStoreIdentity(storeDir); }
  catch (error) {
    if (["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? ""))
      return [{ code: "STORE_MISSING", target, message: starting ? missingStoreWarning(storeDir) : `the recorded store ${storeDir} is missing; a running broker may still serve open files, but a restart opens a new empty store and this space's history starts empty` }];
    return [{ code: "STORE_UNREADABLE", target, message: `the recorded store ${storeDir} could not be inspected: ${(error as Error).message}; its retained history could not be verified` }];
  }
  if (recorded && (recorded.path !== current.path || recorded.dev !== current.dev || recorded.ino !== current.ino || recorded.birthtimeNs !== current.birthtimeNs))
    return [{ code: "STORE_REPLACED", target, message: `the recorded store ${storeDir} was replaced: its directory identity no longer matches; its retained history cannot be assumed to match the previous store, so ${starting ? "this restart may start with empty history" : "a running broker may still serve open files, but a restart may start with empty history"}` }];
  return [];
}
