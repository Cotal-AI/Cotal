import { createHash, randomBytes } from "node:crypto";
import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { globalConfigDir } from "@cotal-ai/core";
import { executionIdentity } from "./execution-identity.js";
import { acquireLock } from "./advisory-lock.js";
import { readLocalRecordSource } from "./local-record-source.js";
import { claimExtensionMutationLock } from "./extension-mutation.js";
import { claimUpdateClosureAccess } from "./update-closure.js";

interface Selection { readonly v: 1; readonly entry: string; readonly version: string; readonly root: string }
function identity(): { entry: string; version: string; path: string } | undefined {
  if (process.platform !== "linux" && process.platform !== "darwin") return;
  const execution = executionIdentity();
  if (!execution) return;
  const loaded = dirname(dirname(execution.loadedEntry));
  if (existsSync(join(loaded, "desktop-runtime.json")) || existsSync(join(dirname(dirname(execution.logicalEntry)), "desktop-runtime.json"))) return;
  const meta = JSON.parse(readFileSync(join(loaded, "package.json"), "utf8")) as { version?: unknown };
  if (typeof meta.version !== "string" || !/^\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?$/.test(meta.version)) throw new Error("connector selection has no valid loaded version");
  const entry = execution.logicalEntry;
  const key = createHash("sha256").update(entry).digest("hex");
  return { entry, version: meta.version, path: join(globalConfigDir(), "installs", key, "sets", meta.version) };
}
function ownedDirectory(path: string): void {
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0) throw new Error(`connector retention directory is not private: ${path}`);
}

/** Connector and seed state selected for this installed execution. Legacy processes keep their original paths. */
export function connectorConfigDir(): string {
  const id = identity();
  if (!id) return globalConfigDir();
  const bytes = readLocalRecordSource(join(id.path, "selection.json"), 8192, true);
  if (!bytes) return globalConfigDir();
  ownedDirectory(id.path);
  const record = JSON.parse(bytes.toString("utf8")) as Selection;
  if (record.v !== 1 || record.entry !== id.entry || record.version !== id.version || record.root !== join(id.path, "cotal")) throw new Error("connector retention selection differs from this installation");
  ownedDirectory(record.root);
  return record.root;
}

/** Preserve the original prefix in place and prepare a separate complete prefix for same-version repair. */
export function retainConnectorConfig(): string {
  const id = identity();
  if (!id) throw new Error("retained connector reconciliation requires an installed POSIX execution");
  const current = connectorConfigDir();
  if (current !== globalConfigDir()) return current;
  const releaseClosure = claimUpdateClosureAccess();
  let releaseWriter = () => {};
  let releaseSeed = () => {};
  try {
    const seed = acquireLock(join(current, "seed", "reconcile.lock"), { label: "retained connector reconciliation", waitMs: 0 });
    releaseSeed = () => seed.release();
    releaseWriter = claimExtensionMutationLock();
    if (connectorConfigDir() !== current) return connectorConfigDir();
    mkdirSync(id.path, { recursive: true, mode: 0o700 });
    for (let path = id.path; path !== resolve(globalConfigDir()); path = dirname(path)) ownedDirectory(path);
    const root = join(id.path, "cotal");
    mkdirSync(root, { mode: 0o700, recursive: true });
    ownedDirectory(root);
    for (const name of ["seed", "extensions"]) {
      const source = join(current, name), destination = join(root, name);
      if (!existsSync(source)) continue;
      const stat = lstatSync(source);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`cannot retain non-directory connector state: ${source}`);
      if (existsSync(destination)) throw new Error(`unfinished retained connector state requires inspection: ${destination}`);
      cpSync(source, destination, { recursive: true, verbatimSymlinks: true, filter: path => !/reconcile\.(?:lock|child\.json)/.test(path.split("/").at(-1)!) });
    }
    if (realpathSync(root) !== root) throw new Error("retained connector state resolved through a link");
    const record: Selection = { v: 1, entry: id.entry, version: id.version, root };
    const temporary = join(id.path, `.selection-${randomBytes(8).toString("hex")}`);
    writeFileSync(temporary, JSON.stringify(record), { flag: "wx", mode: 0o600 });
    renameSync(temporary, join(id.path, "selection.json"));
    return root;
  } finally { releaseWriter(); releaseSeed(); releaseClosure(); }
}
