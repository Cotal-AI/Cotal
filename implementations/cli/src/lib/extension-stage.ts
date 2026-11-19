import { randomBytes } from "node:crypto";
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { connectorConfigDir, canRecoverConnectorConfig, claimUpdateClosureAccess, inspectLock, processStartToken, protectedLocalDirectory, assertProtectedFileAccess, readLocalRecordSource } from "@cotal-ai/workspace";
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
const journalPath = (): string => join(connectorConfigDir(), ".extensions-promotion.json");

/** Report a journal's presence without reading or acting on the paths it records. */
export function extensionPromotionProblem(): string | undefined {
  try {
    const path = journalPath();
    if (lstatSync(path, { throwIfNoEntry: false })) return `an extension promotion is pending at ${path}`;
  } catch (error) {
    return `could not check for a pending extension promotion: ${error instanceof Error ? error.message : String(error)}`;
  }
  return undefined;
}

function save(record: Promotion): void {
  const path = journalPath(), temp = `${path}.${randomBytes(6).toString("hex")}.tmp`;
  writeFileSync(temp, JSON.stringify(record), { flag: "wx", mode: 0o600 });
  renameSync(temp, path);
}
function checkedRecord(): Promotion | undefined {
  const path = journalPath();
  if (!existsSync(path)) return undefined;
  if (!lstatSync(path).isFile() || lstatSync(path).isSymbolicLink()) throw new Error("extension promotion journal is not a regular file");
  assertProtectedFileAccess();
  const source = readLocalRecordSource(path, 64 * 1024);
  if (!source) throw new Error("extension promotion journal disappeared");
  const record = JSON.parse(Buffer.from(source).toString("utf8")) as Promotion;
  const config = resolve(connectorConfigDir());
  if (record.v !== 1 || !record.stageIdentity || resolve(record.root) !== join(config, "extensions") ||
      dirname(record.stage) !== config || !record.stage.startsWith(join(config, ".extensions.stage-")) ||
      dirname(record.old) !== config || !record.old.startsWith(join(config, ".extensions.rollback-"))) throw new Error("invalid extension promotion journal");
  return record;
}
/** Complete a journaled directory promotion while holding the ordinary closure and prefix barriers. */
export function recoverExtensionPromotion(): void {
  if (!canRecoverConnectorConfig()) return;
  if (!checkedRecord()) return;
  const releaseClosure = claimUpdateClosureAccess(true);
  try {
    if (!canRecoverConnectorConfig()) return;
    const release = claimExtensionMutation();
    try { const record = checkedRecord(); if (record) finish(record); }
    finally { release(); }
  } finally { releaseClosure(); }
}
function identity(path: string): Promotion["stageIdentity"] {
  const stat = lstatSync(path);
  return { dev: String(stat.dev), ino: String(stat.ino), birth: stat.birthtimeMs };
}
function finish(record: Promotion): void {
  const root = existsSync(record.root), stage = existsSync(record.stage), old = existsSync(record.old);
  for (const path of [record.root, record.stage, record.old]) if (existsSync(path) && (!lstatSync(path).isDirectory() || lstatSync(path).isSymbolicLink())) throw new Error("extension promotion directory is not a real directory");
  const verified = stage ? record.stage : root ? record.root : undefined;
  if (!verified || JSON.stringify(identity(verified)) !== JSON.stringify(record.stageIdentity)) throw new Error("extension promotion no longer names its verified prefix");
  const previous = old ? record.old : stage && root ? record.root : undefined;
  if (previous && (!record.oldIdentity || JSON.stringify(identity(previous)) !== JSON.stringify(record.oldIdentity))) throw new Error("extension promotion no longer names its previous prefix");
  if (stage && root && !old) renameSync(record.root, record.old);
  else if (stage && root) throw new Error("ambiguous extension promotion directories");
  else if (!root && !stage) throw new Error("extension promotion has no complete prefix");
  if (stage) renameSync(record.stage, record.root);
  // After promotion the journal can only name a complete verified new prefix. Old bytes remain
  // available until that rename is observable, including if the process exits between these calls.
  rmSync(journalPath());
  if (existsSync(record.old)) {
    try { rmSync(record.old, { recursive: true, force: true }); }
    catch (error) { console.error(`! could not remove the previous copy of the extensions at ${record.old} (${error instanceof Error ? error.message : String(error)}); remove it by hand`); }
  }
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
      const record: Promotion = { v: 1, root, stage: ready, old, stageIdentity: identity(ready), ...(existsSync(root) ? { oldIdentity: identity(root) } : {}) };
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
