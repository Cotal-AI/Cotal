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
