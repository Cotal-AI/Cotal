import { randomBytes } from "node:crypto";
import { chmodSync, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync, type Stats } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { connectorConfigDir, canRecoverConnectorConfig, claimUpdateClosureAccess, inspectLock, processStartToken, protectedLocalDirectory, assertProtectedFileAccess, readLocalRecordSource, loadExtensionsManifest, type ExtensionsManifest } from "@cotal-ai/workspace";
import { claimExtensionMutation } from "./ext-mutation.js";
import { repairInstallModes } from "./install-umask.js";

interface Promotion {
  readonly v: 1;
  readonly root: string;
  readonly stage: string;
  readonly old: string;
  readonly stageIdentity: { readonly dev: string; readonly ino: string; readonly birth: number };
  readonly oldIdentity?: { readonly dev: string; readonly ino: string; readonly birth: number };
}
const journalPath = (config = connectorConfigDir()): string => join(config, ".extensions-promotion.json");
function save(record: Promotion): void {
  const path = journalPath(), temp = `${path}.${randomBytes(6).toString("hex")}.tmp`;
  writeFileSync(temp, JSON.stringify(record), { flag: "wx", mode: 0o600 });
  renameSync(temp, path);
}
function checkedRecord(config = resolve(connectorConfigDir()), sourceConfig = config): Promotion | undefined {
  const path = journalPath(sourceConfig);
  const stat = lstatSync(path, { throwIfNoEntry: false });
  if (!stat) return undefined;
  if (!stat.isFile()) throw new Error("extension promotion journal is not a regular file");
  assertProtectedFileAccess();
  const source = readLocalRecordSource(path, 64 * 1024);
  if (!source) throw new Error("extension promotion journal disappeared");
  const record = JSON.parse(Buffer.from(source).toString("utf8")) as Promotion;
  if (record.v !== 1 || !record.stageIdentity || resolve(record.root) !== join(config, "extensions") ||
      dirname(record.stage) !== config || !record.stage.startsWith(join(config, ".extensions.stage-")) ||
      dirname(record.old) !== config || !record.old.startsWith(join(config, ".extensions.rollback-"))) throw new Error("invalid extension promotion journal");
  return record;
}

/** Read the inventory recovery would publish, without taking a writer lock or importing code. */
export function setupExtensionInventory(): ExtensionsManifest {
  const { config, source, recoverPromotion } = connectorConfigDir({ observeRecovery: true });
  const record = recoverPromotion ? checkedRecord(resolve(config), source) : undefined;
  const prefix = record ? checkedPromotion(record).verified : join(source, "extensions");
  const before = lstatSync(prefix, { throwIfNoEntry: false });
  const manifest = loadExtensionsManifest({ prefix, staged: record !== undefined });
  const after = lstatSync(prefix, { throwIfNoEntry: false });
  if ((record && JSON.stringify(before && statIdentity(before)) !== JSON.stringify(record.stageIdentity)) ||
      JSON.stringify(before && statIdentity(before)) !== JSON.stringify(after && statIdentity(after)) ||
      (!record && recoverPromotion && existsSync(journalPath(source))))
    throw new Error("extension promotion changed while setup read its inventory; retry setup");
  return manifest;
}
/** Complete a journaled directory promotion while holding the ordinary closure and prefix barriers. */
export function recoverExtensionPromotion(prepareForUpdate = false, validate?: () => void): boolean {
  if (!canRecoverConnectorConfig() || !checkedRecord()) return false;
  const releaseClosure = claimUpdateClosureAccess(true);
  try {
    if (!canRecoverConnectorConfig()) return false;
    const release = claimExtensionMutation();
    try {
      const record = checkedRecord();
      if (!record) return false;
      // Setup checks once without locks to reject typos without writes, then checks the inventory
      // again under the writer barrier before a concurrent promotion can publish different bytes.
      validate?.();
      finish(record, prepareForUpdate);
      return true;
    }
    finally { release(); }
  } finally { releaseClosure(); }
}
function statIdentity(stat: Stats): Promotion["stageIdentity"] {
  return { dev: String(stat.dev), ino: String(stat.ino), birth: stat.birthtimeMs };
}
function promotionDirectory(path: string): Stats | undefined {
  const stat = lstatSync(path, { throwIfNoEntry: false });
  if (stat && !stat.isDirectory()) throw new Error("extension promotion directory is not a real directory");
  return stat;
}
function checkedPromotion(record: Promotion): { verified: string; moveOld: boolean } {
  const root = promotionDirectory(record.root), stage = promotionDirectory(record.stage), old = promotionDirectory(record.old);
  const verified = stage ?? root;
  if (!verified || JSON.stringify(statIdentity(verified)) !== JSON.stringify(record.stageIdentity)) throw new Error("extension promotion no longer names its verified prefix");
  const previous = old ?? (stage && root);
  if (previous && JSON.stringify(statIdentity(previous)) !== JSON.stringify(record.oldIdentity)) throw new Error("extension promotion no longer names its previous prefix");
  if (stage && root && old) throw new Error("ambiguous extension promotion directories");
  return { verified: stage ? record.stage : record.root, moveOld: stage !== undefined && root !== undefined };
}

function finish(record: Promotion, prepareForUpdate = false): void {
  const { verified, moveOld } = checkedPromotion(record);
  if (moveOld) renameSync(record.root, record.old);
  if (verified === record.stage) renameSync(record.stage, record.root);
  // After promotion the journal can only name a complete verified new prefix. Old bytes remain
  // available until that rename is observable, including if the process exits between these calls.
  if (existsSync(record.old)) {
    try {
      if (prepareForUpdate && process.getuid) {
        const writable = (path: string): void => {
          const stat = lstatSync(path);
          if (!stat.isDirectory() || stat.uid !== process.getuid!()) throw new Error(`cannot repair unowned rollback directory: ${path}`);
          if ((stat.mode & 0o200) === 0) chmodSync(path, (stat.mode & 0o7777) | 0o200);
          for (const entry of readdirSync(path, { withFileTypes: true })) if (entry.isDirectory()) writable(join(path, entry.name));
        };
        writable(record.old);
      }
      rmSync(record.old, { recursive: true, force: true });
    } catch (error) {
      if (prepareForUpdate) throw error;
      console.error(`! could not remove the previous copy of the extensions at ${record.old} (${error instanceof Error ? error.message : String(error)}); remove it by hand`);
    }
  }
  rmSync(journalPath());
}
export interface ExtensionStage {
  readonly config: string;
  readonly prefix: string;
  promote(): void;
  discard(): void;
  retain(): void;
}
/** Copy the prefix once. The caller holds the writer throughout staging, verification and promotion. */
export function stageExtensions(): ExtensionStage {
  const config = connectorConfigDir(), root = join(config, "extensions");
  if (checkedRecord()) throw new Error("an unfinished extension promotion must be recovered before staging");
  mkdirSync(config, { recursive: true, mode: 0o700 });
  protectedLocalDirectory(realpathSync(config));
  const stage = mkdtempSync(join(config, ".extensions.stage-"));
  const stageConfig = join(stage, "config"), prefix = join(stageConfig, "cotal", "extensions");
  mkdirSync(dirname(prefix), { recursive: true, mode: 0o700 });
  if (existsSync(root)) cpSync(root, prefix, { recursive: true, verbatimSymlinks: true });
  else { mkdirSync(prefix, { mode: 0o755 }); writeFileSync(join(prefix, "package.json"), JSON.stringify({ name: "cotal-extensions", private: true })); }
  // The stage is this process's own: under a umask of 0002 the folder above, and on Node before
  // 24.22 every copied folder, would be group-writable and the protected-path rule would refuse it.
  repairInstallModes(prefix);
  let promoted = false;
  return {
    config: stageConfig, prefix,
    promote() {
      const old = join(config, `.extensions.rollback-${randomBytes(8).toString("hex")}`);
      // Move the verified prefix out of the stage's config wrapper before the journal. This is
      // still invisible to readers. Only the final pair of whole-directory renames touches live.
      const ready = `${stage}.ready`;
      renameSync(prefix, ready);
      if (existsSync(old)) throw new Error("extension rollback destination already exists");
      const record: Promotion = { v: 1, root, stage: ready, old, stageIdentity: statIdentity(lstatSync(ready)), ...(existsSync(root) ? { oldIdentity: statIdentity(lstatSync(root)) } : {}) };
      save(record);
      promoted = true;
      finish(record);
      try { rmSync(stage, { recursive: true, force: true }); }
      catch (error) { console.error(`! could not remove completed extension stage ${stage} (${error instanceof Error ? error.message : String(error)}); remove it by hand`); }
    },
    retain() { promoted = true; },
    discard() { if (!promoted) rmSync(stage, { recursive: true, force: true }); },
  };
}
/** Bind an isolated staged verifier to its live parent's original writer lock. */
export function assertStageVerifier(parent: number, config: string, nonce: string): void {
  const found = inspectLock(join(config, ".extensions.lock"));
  if (parent !== process.ppid || found.state !== "active" || found.owner.pid !== parent || found.owner.nonce !== nonce || found.owner.start !== processStartToken(parent)) throw new Error("staged extension verifier has no live prefix writer");
}
