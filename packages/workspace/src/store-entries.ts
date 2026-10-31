import { lstatSync, readdirSync, type Stats } from "node:fs";
import { join } from "node:path";

/** What a store directory holds: the broker's `jetstream` tree, Cotal's generation marker, and the
 *  `ocsp` folder nats-server makes in its store directory on every configuration reload. */
const STORE_ENTRIES = new Map<string, (stat: Stats) => boolean>([
  ["jetstream", (stat) => stat.isDirectory()],
  [".cotal-store-id", (stat) => stat.isFile()],
  ["ocsp", (stat) => stat.isDirectory()],
]);

/** The entries of the directory `dir` that are not part of a store, sorted. A store entry of the
 *  wrong kind, such as a `jetstream` link or file, is not part of it either. */
export function foreignStoreEntries(dir: string): string[] {
  return readdirSync(dir).filter((entry) => !STORE_ENTRIES.get(entry)?.(lstatSync(join(dir, entry)))).sort();
}

/** The names of the store entries, the only entries a store cleanup removes. */
export const STORE_ENTRY_NAMES: readonly string[] = [...STORE_ENTRIES.keys()];

/** The JetStream accounts that hold streams in the store folder `dir`, sorted, such as an open mesh's
 *  account beside a static space's after both ran in one folder. A folder with no `jetstream` tree,
 *  or an account with no `streams`, holds none. */
export function storeAccounts(dir: string): string[] {
  const entries = (path: string): string[] => {
    try { return readdirSync(path); }
    catch (error) { if (["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) return []; throw error; }
  };
  return entries(join(dir, "jetstream")).filter((name) => entries(join(dir, "jetstream", name, "streams")).length > 0).sort();
}
