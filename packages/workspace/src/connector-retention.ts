import { createHash, randomBytes } from "node:crypto";
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { globalConfigDir } from "@cotal-ai/core";
import { executionIdentity } from "./execution-identity.js";
import { acquireLock } from "./advisory-lock.js";
import { readLocalRecordSource } from "./local-record-source.js";
import { assertExtensionPrefixIdle, claimExtensionMutationLock } from "./extension-mutation.js";
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
function ownedAncestors(path: string): void {
  const config = resolve(globalConfigDir());
  for (let parent = path; parent !== config; parent = dirname(parent)) {
    if (parent === dirname(parent)) throw new Error("connector retention escaped its config directory");
    ownedDirectory(parent);
  }
}
function previousConfig(id: { entry: string; path: string }): string | undefined {
  const sets = dirname(id.path);
  const bytes = readLocalRecordSource(join(sets, "current.json"), 8192, true);
  if (!bytes) return;
  ownedAncestors(sets);
  const record = JSON.parse(bytes.toString("utf8")) as Selection;
  if (record.v !== 1 || record.entry !== id.entry || !/^\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?$/.test(record.version) || record.root !== join(sets, record.version, "cotal")) throw new Error("invalid previous connector retention selection");
  ownedAncestors(record.root);
  for (const name of ["seed", "extensions"]) {
    const path = join(record.root, name), stat = lstatSync(path, { throwIfNoEntry: false });
    if (stat && (!stat.isDirectory() || stat.isSymbolicLink())) throw new Error(`previous connector state is not a real directory: ${path}`);
  }
  return record.root;
}

/** Connector and seed state selected for this installed execution. Legacy processes keep their original paths. */
export function connectorConfigDir(): string {
  const id = identity();
  if (!id) return globalConfigDir();
  if (existsSync(id.path)) ownedAncestors(id.path);
  const bytes = readLocalRecordSource(join(id.path, "selection.json"), 8192, true);
  if (!bytes) {
    const previous = previousConfig(id);
    return previous === join(id.path, "cotal") ? previous : globalConfigDir();
  }
  ownedAncestors(id.path);
  const record = JSON.parse(bytes.toString("utf8")) as Selection;
  if (record.v !== 1 || record.entry !== id.entry || record.version !== id.version || record.root !== join(id.path, "cotal")) throw new Error("connector retention selection differs from this installation");
  ownedDirectory(record.root);
  for (const name of ["seed", "extensions"]) {
    const path = join(record.root, name);
    if (existsSync(path) && (!lstatSync(path).isDirectory() || lstatSync(path).isSymbolicLink())) throw new Error(`retained connector state is not a real directory: ${path}`);
  }
  return record.root;
}

/** A later installed generation inherits connector state without mutating an earlier retained prefix. */
export function inheritConnectorConfig(): void {
  const id = identity();
  if (id && connectorConfigDir() === globalConfigDir() && previousConfig(id)) retainConnectorConfig();
}

/** Preserve the original prefix in place and prepare a separate complete prefix for same-version repair. */
export function retainConnectorConfig(): string {
  const id = identity();
  if (!id) throw new Error("retained connector reconciliation requires an installed POSIX execution");
  const selected = connectorConfigDir();
  if (selected !== globalConfigDir()) return selected;
  const current = previousConfig(id) ?? selected;
  const releaseClosure = claimUpdateClosureAccess();
  let releaseWriter = () => {};
  let releaseSeed = () => {};
  try {
    const seed = acquireLock(join(current, "seed", "reconcile.lock"), { label: "retained connector reconciliation", waitMs: 0 });
    releaseSeed = () => seed.release();
    if (current === globalConfigDir()) releaseWriter = claimExtensionMutationLock();
    else {
      const pass = acquireLock(join(current, ".extensions.lock.update"), { label: "retained connector pass", waitMs: 0 });
      try {
        const writer = acquireLock(join(current, ".extensions.lock"), { label: "retained connector writer", waitMs: 0 });
        releaseWriter = () => { writer.release(); pass.release(); };
      } catch (error) { pass.release(); throw error; }
    }
    assertExtensionPrefixIdle(current);
    if (connectorConfigDir() !== globalConfigDir()) return connectorConfigDir();
    if ((previousConfig(id) ?? globalConfigDir()) !== current) throw new Error("connector retention source changed before its copy; retry reconciliation");
    mkdirSync(id.path, { recursive: true, mode: 0o700 });
    ownedAncestors(id.path);
    const root = join(id.path, "cotal");
    if (existsSync(root)) throw new Error(`unfinished retained connector state requires inspection: ${root}`);
    const staging = mkdtempSync(join(id.path, ".preparing-"));
    try {
      for (const name of ["seed", "extensions"]) {
        const source = join(current, name), destination = join(staging, name);
        if (!existsSync(source)) continue;
        const stat = lstatSync(source);
        if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`cannot retain non-directory connector state: ${source}`);
        cpSync(source, destination, { recursive: true, verbatimSymlinks: true, filter: path => !/^reconcile\.(?:lock(?:\..*)?|child\.json)$/.test(path.split("/").at(-1)!) });
      }
      renameSync(staging, root);
    } finally { if (existsSync(staging)) rmSync(staging, { recursive: true }); }
    if (realpathSync(root) !== root) throw new Error("retained connector state resolved through a link");
    const record: Selection = { v: 1, entry: id.entry, version: id.version, root };
    const next = join(dirname(id.path), `.current-${randomBytes(8).toString("hex")}`);
    writeFileSync(next, JSON.stringify(record), { flag: "wx", mode: 0o600 });
    renameSync(next, join(dirname(id.path), "current.json"));
    const temporary = join(id.path, `.selection-${randomBytes(8).toString("hex")}`);
    writeFileSync(temporary, JSON.stringify(record), { flag: "wx", mode: 0o600 });
    renameSync(temporary, join(id.path, "selection.json"));
    return root;
  } finally { releaseWriter(); releaseSeed(); releaseClosure(); }
}
