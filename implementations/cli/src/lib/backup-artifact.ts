import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  readSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, parse, resolve, sep } from "node:path";
import {
  hardenPrivate,
  type BackupStreamState,
  type PersistentConsumerCheckpoint,
  type SpaceBackupSelection,
  realDirNoSymlink,
  spaceBackupInventory,
} from "@cotal-ai/core";
import { CommandFailure, protectedLocalEntries, readLocalRecordSource, readMaintenanceJournal, type MaintenanceAuthMode, type StoreIdentity } from "@cotal-ai/workspace";
import type { AuthorityFingerprint } from "./maintenance-files.js";

export const BACKUP_MANIFEST_FORMAT = "cotal-space-backup/v2" as const;
/** The format before full backups held workflow runs. Such an artifact still restores; its full
 *  selection is the message, registry and authorization streams, and the run stores come back empty. */
export const BACKUP_MANIFEST_FORMAT_V1 = "cotal-space-backup/v1" as const;
const MAX_MANIFEST_BYTES = 1024 * 1024;
const MAX_CHECKPOINT_BYTES = 16 * 1024 * 1024;
const COPY_BUFFER_BYTES = 1024 * 1024;

export interface BackupFileRecord {
  path: string;
  size: number;
  sha256: string;
  kind: "snapshot" | "checkpoints";
  stream?: string;
}

export interface BackupStreamRecord {
  stream: string;
  snapshot: string;
  config: Record<string, unknown>;
  state: BackupStreamState;
}

export interface BackupManifest {
  format: typeof BACKUP_MANIFEST_FORMAT | typeof BACKUP_MANIFEST_FORMAT_V1;
  createdAt: string;
  space: string;
  selection: SpaceBackupSelection;
  mode: MaintenanceAuthMode;
  source: StoreIdentity;
  authority?: AuthorityFingerprint;
  streams: BackupStreamRecord[];
  checkpoints: string;
  files: BackupFileRecord[];
}

export interface ArtifactWriter {
  directory: string;
  identity: { dev: bigint; ino: bigint };
  writeFile(name: string, kind: BackupFileRecord["kind"], source: AsyncIterable<Uint8Array> | Uint8Array | string, stream?: string): Promise<BackupFileRecord>;
  publish(manifest: Omit<BackupManifest, "format" | "createdAt" | "files">, files: BackupFileRecord[]): BackupManifest;
  cleanup(): void;
}

function fsyncDirectory(path: string): void {
  let fd: number | undefined;
  try {
    fd = openSync(path, constants.O_RDONLY);
    fsyncSync(fd);
  } catch (error) {
    if (process.platform !== "win32") throw error;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function isSafeFileName(name: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9_.-]{0,200}$/.test(name) && name !== "manifest.json";
}

function safeFileName(name: string): void {
  if (!isSafeFileName(name)) throw new ArtifactFileFault(null, "invalid-name");
}

export type ArtifactFault = "missing" | "undeclared" | "mismatch" | "not-regular" | "invalid-name" | "manifest-not-regular" | "manifest-too-large" | "manifest-invalid";

/** One artifact file at fault: missing, undeclared, not a regular file, not the declared size and
 *  SHA-256, a declared name that is not a plain name in the folder, or a manifest that is not a
 *  regular file, too large or not valid. `file` is null for a name that is not a valid artifact file
 *  name, so it is never printed, and `reason` never carries a manifest value. */
export class ArtifactFileFault extends Error {
  constructor(readonly file: string | null, readonly fault: ArtifactFault, reason?: string) {
    super(fault === "missing" ? `backup artifact is missing its declared file ${file}`
      : fault === "undeclared" ? `backup artifact contains an undeclared file ${file ?? "with an invalid name"}`
      : fault === "not-regular" ? `backup artifact file ${file} is not a regular file, such as a symbolic link, FIFO or device; it was not read`
      : fault === "invalid-name" ? "backup manifest declares a file name that is not a plain name in the artifact folder, such as a path with ../ or an absolute path; the name was not printed"
      : fault === "manifest-not-regular" ? "backup artifact manifest.json is not a regular file, such as a symbolic link; it was not read"
      : fault === "manifest-too-large" ? `backup artifact manifest.json is larger than its ${MAX_MANIFEST_BYTES / 1024 / 1024} MiB limit; it was not read`
      : fault === "manifest-invalid" ? `backup artifact manifest.json is not a valid cotal-space-backup manifest${reason ? `: ${reason}` : ""}`
      : `backup artifact file ${file} does not match its declared size and SHA-256`);
    this.name = "ArtifactFileFault";
  }
}

/** A manifest whose content is not a valid inventory. `reason` names no manifest value beyond a
 *  declared file name already checked to be plain. */
const invalidManifest = (reason: string) => new ArtifactFileFault("manifest.json", "manifest-invalid", reason);

/** Refuse a manifest.json that is not a bounded regular file before any read follows it. */
function assertManifestFile(path: string): void {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new ArtifactFileFault("manifest.json", "manifest-not-regular");
  if (stat.size > MAX_MANIFEST_BYTES) throw new ArtifactFileFault("manifest.json", "manifest-too-large");
}

function writeAll(fd: number, chunk: Uint8Array): void {
  let offset = 0;
  while (offset < chunk.byteLength) {
    const written = writeSync(fd, chunk, offset, chunk.byteLength - offset);
    if (written <= 0) throw new Error("backup artifact write made no progress");
    offset += written;
  }
}

function sameDirectoryIdentity(path: string, identity: { dev: bigint; ino: bigint }): boolean {
  try {
    const stat = lstatSync(path, { bigint: true });
    return stat.isDirectory() && !stat.isSymbolicLink() && stat.dev === identity.dev && stat.ino === identity.ino;
  } catch {
    return false;
  }
}

export function createArtifactWriter(destination: string): ArtifactWriter {
  const directory = resolve(destination);
  try {
    mkdirSync(directory, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST")
      throw new Error(`backup destination already exists: ${directory}`);
    throw error;
  }
  let identity: { dev: bigint; ino: bigint };
  try {
    // The artifact holds whole-stream snapshots (chat, DMs) — the most sensitive bytes we write.
    // `hardenPrivate` reasserts 0700 on POSIX and sets the win32 ACL, where the create mode above is
    // a no-op; the dir grant is inheritable, so every file written below is born private too.
    hardenPrivate(directory, "dir");
    fsyncDirectory(dirname(directory));
    const stat = lstatSync(directory, { bigint: true });
    identity = { dev: stat.dev, ino: stat.ino };
  } catch (error) {
    // The directory was exclusively created by this call and nothing has been written into it:
    // a failed post-create step must not leak it and block a same-destination retry.
    try {
      const current = lstatSync(directory, { bigint: true });
      if (current.isDirectory() && !current.isSymbolicLink()) rmSync(directory, { recursive: true });
    } catch { /* already absent */ }
    throw error;
  }
  let published = false;

  return {
    directory,
    identity,
    async writeFile(name, kind, source, stream) {
      if (published) throw new Error("backup manifest is already published");
      safeFileName(name);
      const path = join(directory, name);
      const fd = openSync(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
      const hash = createHash("sha256");
      let size = 0;
      try {
        const write = (chunk: Uint8Array) => {
          writeAll(fd, chunk);
          hash.update(chunk);
          size += chunk.byteLength;
        };
        if (typeof source === "string") write(Buffer.from(source));
        else if (source instanceof Uint8Array) write(source);
        else for await (const chunk of source) write(chunk);
        fsyncSync(fd);
        if (fstatSync(fd).size !== size) throw new Error(`backup artifact size mismatch after writing ${name}`);
      } finally {
        closeSync(fd);
      }
      return { path: name, size, sha256: hash.digest("hex"), kind, ...(stream ? { stream } : {}) };
    },
    publish(input, files) {
      if (published) throw new Error("backup manifest is already published");
      const manifest: BackupManifest = {
        format: BACKUP_MANIFEST_FORMAT,
        createdAt: new Date().toISOString(),
        ...input,
        files: [...files].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0),
      };
      // The manifest is the completion marker, so it must appear ATOMICALLY: durable bytes first
      // at a temp name, then one rename. A crash can never leave a truncated manifest.json.
      const path = join(directory, "manifest.json");
      const tmp = join(directory, `manifest.json.${process.pid}.${randomUUID()}.tmp`);
      const fd = openSync(tmp, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
      try {
        writeFileSync(fd, `${JSON.stringify(manifest, null, 2)}\n`);
        fsyncSync(fd);
        closeSync(fd);
      } catch (error) {
        try { closeSync(fd); } catch { /* already closed */ }
        try { rmSync(tmp); } catch { /* best effort for the exclusively-created temp */ }
        throw error;
      }
      renameSync(tmp, path);
      fsyncDirectory(directory);
      published = true;
      return manifest;
    },
    cleanup() {
      if (published || !sameDirectoryIdentity(directory, identity)) return;
      rmSync(directory, { recursive: true });
      fsyncDirectory(dirname(directory));
    },
  };
}

function parseManifest(path: string, pinnedBytes?: Buffer): BackupManifest {
  assertManifestFile(path);
  let value: BackupManifest;
  // The parser's own message quotes the input, so only the fact is reported.
  try { value = JSON.parse(pinnedBytes === undefined ? readFileSync(path, "utf8") : new TextDecoder("utf-8", { fatal: true }).decode(pinnedBytes)) as BackupManifest; }
  catch { throw new ArtifactFileFault("manifest.json", "manifest-invalid", "it is not UTF-8 JSON"); }
  try { return validManifest(value); }
  catch (error) {
    if (error instanceof ArtifactFileFault) throw error;
    throw new ArtifactFileFault("manifest.json", "manifest-invalid", (error as Error).message.replace(/^backup manifest /, "it "));
  }
}

/** The streams an artifact holds for its selection. A user-mode artifact holds no workflow store:
 *  the records store's lifecycle heads name credential ledger rows in the auth store, which a backup
 *  does not carry, so a restored head would name a row that is gone. */
export function artifactStreams(manifest: Pick<BackupManifest, "format" | "space" | "selection" | "mode">): readonly string[] {
  const inventory = spaceBackupInventory(manifest.space);
  if (manifest.selection !== "full") return inventory.registry;
  return manifest.format === BACKUP_MANIFEST_FORMAT_V1 || manifest.mode === "user" ? inventory.backedUp.filter((stream) => stream.class !== "workflow").map((stream) => stream.name) : inventory.full;
}

/** The manifest's shape, format, inventory and source identity. Messages name no manifest value. */
function validManifest(value: BackupManifest): BackupManifest {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("backup manifest is not a JSON object");
  if (value.format !== BACKUP_MANIFEST_FORMAT && value.format !== BACKUP_MANIFEST_FORMAT_V1) throw new Error("backup manifest names an unsupported format");
  if (!value.space || !["full", "registry"].includes(value.selection) || !["auth", "open", "user"].includes(value.mode))
    throw new Error("backup manifest has invalid space, selection, or mode");
  if (typeof value.space !== "string" || value.space.length > 200) throw new Error("backup manifest names an invalid space");
  if (!Array.isArray(value.files) || !Array.isArray(value.streams) || typeof value.checkpoints !== "string")
    throw new Error("backup manifest has invalid inventory");
  safeFileName(value.checkpoints);
  for (const stream of value.streams) {
    if (!stream || typeof stream !== "object" || typeof stream.stream !== "string" || typeof stream.snapshot !== "string")
      throw new Error("backup manifest has an invalid stream record");
    safeFileName(stream.snapshot);
  }
  const keys = Object.keys(value).sort().join(",");
  const expectedKeys = ["authority", "checkpoints", "createdAt", "files", "format", "mode", "selection", "source", "space", "streams"]
    .filter((key) => key !== "authority" || value.authority !== undefined).sort().join(",");
  if (keys !== expectedKeys || !Number.isFinite(Date.parse(value.createdAt)))
    throw new Error("backup manifest has unknown fields or an invalid timestamp");
  if (!value.source || typeof value.source.path !== "string" || !isAbsolute(value.source.path) ||
      !/^\d+$/.test(value.source.dev) || !/^\d+$/.test(value.source.ino) ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value.source.generation))
    throw new Error("backup manifest has an invalid source identity");
  return value;
}

function copyPinnedFile(source: string, destination: string | undefined, expected: BackupFileRecord): void {
  const pathStat = lstatSync(source);
  if (!pathStat.isFile() || pathStat.isSymbolicLink()) throw new ArtifactFileFault(expected.path, "not-regular");
  const noFollow = process.platform === "win32" ? 0 : constants.O_NOFOLLOW;
  const sourceFd = openSync(source, constants.O_RDONLY | noFollow | (destination === undefined ? constants.O_NONBLOCK : 0));
  let destinationFd: number | undefined;
  const hash = createHash("sha256");
  let size = 0;
  try {
    const before = fstatSync(sourceFd, { bigint: true });
    if (!before.isFile()) throw new ArtifactFileFault(expected.path, "not-regular");
    if (destination === undefined && (before.dev !== BigInt(pathStat.dev) || before.ino !== BigInt(pathStat.ino))) throw new Error("backup input changed before verification");
    if (destination !== undefined) destinationFd = openSync(destination, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
    const buffer = Buffer.allocUnsafe(COPY_BUFFER_BYTES);
    for (;;) {
      const count = readSync(sourceFd, buffer, 0, buffer.length, null);
      if (count === 0) break;
      const chunk = buffer.subarray(0, count);
      if (destinationFd !== undefined) writeAll(destinationFd, chunk);
      hash.update(chunk);
      size += count;
      if (size > expected.size) throw new ArtifactFileFault(expected.path, "mismatch");
    }
    const after = fstatSync(sourceFd, { bigint: true });
    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mtimeNs !== after.mtimeNs)
      throw new Error(`backup input changed while staging: ${source}`);
    if (size !== expected.size || hash.digest("hex") !== expected.sha256) throw new ArtifactFileFault(expected.path, "mismatch");
    if (destinationFd !== undefined) {
      fsyncSync(destinationFd);
      if (fstatSync(destinationFd).size !== size) throw new Error(`staged backup size mismatch after writing ${destination}`);
    }
  } finally {
    if (destinationFd !== undefined) closeSync(destinationFd);
    closeSync(sourceFd);
  }
}

/** The existing exact-name/metadata checks shared by staging and read-only inspection. */
function validateArtifactInventory(artifact: string, manifest: BackupManifest): void {
  for (const file of manifest.files) safeFileName(file.path);
  const expected = new Set(["manifest.json", ...manifest.files.map((file) => file.path)]);
  const actual = readdirSync(artifact);
  const missing = [...expected].find((name) => !actual.includes(name));
  if (missing !== undefined) throw new ArtifactFileFault(missing, "missing");
  const undeclared = actual.find((name) => !expected.has(name));
  if (undeclared !== undefined) throw new ArtifactFileFault(isSafeFileName(undeclared) ? undeclared : null, "undeclared");
  if (new Set(actual).size !== actual.length || actual.length !== expected.size)
    throw invalidManifest("its file inventory does not match the folder");
  if (new Set(manifest.files.map((file) => file.path)).size !== manifest.files.length)
    throw invalidManifest("it declares a file more than once");
  for (const file of manifest.files) {
    if (!Number.isSafeInteger(file.size) || file.size < 0 || !/^[0-9a-f]{64}$/.test(file.sha256) ||
        !["snapshot", "checkpoints"].includes(file.kind) ||
        (file.kind === "snapshot") !== (typeof file.stream === "string"))
      throw invalidManifest(`its record for ${file.path} has an invalid size, SHA-256, kind or stream`);
    if (file.kind === "checkpoints" && file.size > MAX_CHECKPOINT_BYTES)
      throw invalidManifest(`it declares a checkpoints file larger than its ${MAX_CHECKPOINT_BYTES / 1024 / 1024} MiB limit`);
  }
  const checkpointFiles = manifest.files.filter((file) => file.kind === "checkpoints");
  if (checkpointFiles.length !== 1 || checkpointFiles[0].path !== manifest.checkpoints)
    throw invalidManifest("it does not name exactly one checkpoints file");
  const snapshotFiles = new Map(manifest.files.filter((file) => file.kind === "snapshot").map((file) => [file.path, file.stream]));
  if (snapshotFiles.size !== manifest.streams.length || manifest.streams.some((stream) => snapshotFiles.get(stream.snapshot) !== stream.stream))
    throw invalidManifest("its stream records do not match its snapshot files");
}

/** The hashes detect corruption, not a consistent rewrite, so an artifact that verify vouches for or
 *  a restore reads must be one no other local account can write: its directory, each file in it and
 *  each directory above it follow the protected-path rule. */
function assertArtifactProtected(artifact: string, manifest: BackupManifest): void {
  protectedLocalEntries(artifact, ["manifest.json", ...manifest.files.map((file) => file.path)], "the backup artifact");
}

/** Whether an artifact restores only into a root that still holds the trust state it was taken
 *  under: a full artifact of an authenticated space commits to that root's trust chain, so it cannot
 *  move to another machine or a fresh root. */
export function isTrustBound(selection: string, mode: string): boolean {
  return selection === "full" && mode !== "open";
}

/** The receipt line for a trust-bound artifact. */
export const TRUST_BOUND_TEXT = "only a root that still holds the trust state it was taken under, not another machine or a fresh root";

/** Inspect manifest bytes, or hash every named file, without staging, starting a broker or restoring. */
export function inspectBackupArtifact(artifactPath: string, verify: boolean) {
  // A path through a linked folder names the artifact create published and restore stages, so it is
  // read at its real path, as restore reads it.
  const artifact = realpathSync.native(resolve(artifactPath));
  const volume = parse(artifact).root;
  if (!realDirNoSymlink(volume, ...artifact.slice(volume.length).split(sep).filter(Boolean))) throw new Error("backup artifact is not a physical directory");
  const before = lstatSync(artifact, { bigint: true });
  if (!before.isDirectory() || before.isSymbolicLink()) throw new Error("backup artifact directory changed before inspection");
  const path = join(artifact, "manifest.json");
  if (lstatSync(path, { throwIfNoEntry: false })) assertManifestFile(path);
  const bytes = readLocalRecordSource(path, MAX_MANIFEST_BYTES, false);
  if (!bytes) throw new Error("backup manifest is absent");
  const manifest = parseManifest(path, bytes);
  validateArtifactInventory(artifact, manifest);
  if (verify) for (const file of manifest.files) copyPinnedFile(join(artifact, file.path), undefined, file);
  const after = lstatSync(artifact, { bigint: true });
  const current = readLocalRecordSource(path, MAX_MANIFEST_BYTES, false);
  if (before.dev !== after.dev || before.ino !== after.ino || !current?.equals(bytes)) throw new Error("backup artifact changed during inspection");
  validateArtifactInventory(artifact, manifest);
  if (verify) assertArtifactProtected(artifact, manifest);
  return {
    kind: verify ? "backup-integrity" as const : "backup-inspection" as const,
    directory: artifact, format: manifest.format, createdAt: manifest.createdAt,
    space: manifest.space, selection: manifest.selection, mode: manifest.mode,
    sourcePath: manifest.source.path, sourceGeneration: manifest.source.generation,
    authorityRecorded: manifest.authority !== undefined, authorityValidated: false,
    trustBound: isTrustBound(manifest.selection, manifest.mode),
    integrity: verify ? "matched-declared-sizes-and-sha256" as const : "not-checked" as const,
    manifestSha256: createHash("sha256").update(bytes).digest("hex"),
    fileCount: manifest.files.length, bytesDeclared: manifest.files.reduce((total, file) => total + BigInt(file.size), 0n).toString(),
    files: manifest.files.map((file) => ({ path: file.path, kind: file.kind, stream: file.stream ?? null, size: file.size, sha256: file.sha256 })),
    streams: manifest.streams.map((stream) => ({ stream: stream.stream, snapshot: stream.snapshot })),
    brokerStarted: false, staged: false, restored: false, restorationProven: false,
  };
}

export interface StagedArtifact {
  manifest: BackupManifest;
  directory: string;
  cleanup(): void;
}

/** Validate exact names and pin verified bytes into a private attempt directory before any mutation. */
export function stageArtifact(artifactPath: string, parent: string): StagedArtifact {
  const artifact = resolve(artifactPath);
  const artifactStat = lstatSync(artifact);
  if (!artifactStat.isDirectory() || artifactStat.isSymbolicLink()) throw new Error(`backup artifact is not a real directory: ${artifact}`);
  const manifest = parseManifest(join(artifact, "manifest.json"));
  validateArtifactInventory(artifact, manifest);
  const parentPath = realpathSync.native(resolve(parent));
  const parentStat = lstatSync(parentPath, { bigint: true });
  if (!parentStat.isDirectory() || parentStat.isSymbolicLink()) throw new Error(`restore staging parent is not a real directory: ${parentPath}`);
  const parentIdentity = { dev: parentStat.dev, ino: parentStat.ino };
  const directory = join(parentPath, `.cotal-restore-stage-${randomUUID()}`);
  mkdirSync(directory, { mode: 0o700 });
  hardenPrivate(directory, "dir"); // staged snapshots are the same secret bytes — private on win32 too
  const identityStat = lstatSync(directory, { bigint: true });
  const identity = { dev: identityStat.dev, ino: identityStat.ino };
  try {
    for (const file of manifest.files) copyPinnedFile(join(artifact, file.path), join(directory, file.path), file);
    assertArtifactProtected(artifact, manifest);
    writeFileSync(join(directory, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, { flag: "wx", mode: 0o600 });
    fsyncDirectory(directory);
  } catch (error) {
    if (sameDirectoryIdentity(parentPath, parentIdentity) && sameDirectoryIdentity(directory, identity)) rmSync(directory, { recursive: true });
    throw error;
  }
  return {
    manifest,
    directory,
    cleanup() {
      if (sameDirectoryIdentity(parentPath, parentIdentity) && sameDirectoryIdentity(directory, identity)) rmSync(directory, { recursive: true });
    },
  };
}

/** Why a backup path names nothing: the folder that would hold it is not there (`folder`), or only
 *  its last name is missing (`artifact`). `undefined` when the path exists. */
export function missingBackupPath(path: string): "folder" | "artifact" | undefined {
  if (statSync(path, { throwIfNoEntry: false })) return undefined;
  return statSync(dirname(path), { throwIfNoEntry: false })?.isDirectory() ? "artifact" : "folder";
}

/** What a {@link missingBackupPath} answer means, naming the missing folder or artifact. */
export function missingBackupPathText(path: string, missing: "folder" | "artifact"): string {
  return missing === "folder" ? `there is no folder ${dirname(path)}, so there is no backup artifact ${path}` : `the folder ${dirname(path)} holds no backup artifact ${basename(path)}`;
}

/** The refusal for a path that is not a backup artifact, or for one a backup create never finished,
 *  or `undefined` when it may be an artifact. `outcome` ends its message, saying what did not run. A
 *  file, or a folder no backup create wrote to, is not an artifact, and the refusal says which it
 *  is. The folder of a create interrupted before it wrote a file, which the claim on `root` names, is
 *  an incomplete artifact, as is a real folder with no manifest: create writes the manifest last. */
export function notAnArtifactRefusal(root: string, path: string, outcome: string, target: Readonly<Record<string, unknown>> = {}): CommandFailure | undefined {
  if (notAnArtifact(path) && !claimedDestination(root, path)) {
    const stat = statSync(path);
    const what = !stat.isDirectory() ? (stat.isFile() ? "is a file" : "is not a folder") : readdirSync(path).length === 0 ? "is an empty folder" : "holds no manifest.json and no file a backup create writes";
    return new CommandFailure("refused", "TARGET_NOT_FOUND", `${path} is not a backup artifact: it ${what}; ${outcome}`, { target: { ...target, directory: path }, remedy: "name the folder backup create wrote" });
  }
  if (manifestMissing(path)) return new CommandFailure("refused", "SCHEMA_INVALID", `${path} has no manifest.json, so it is an incomplete artifact, as an interrupted backup create leaves one; ${outcome}`, { target: { ...target, directory: path, fault: "manifest-missing" }, remedy: "it cannot be verified or restored. In the folder it was created from, `cotal status` names the interrupted backup attempt, and `cotal backup recover <attempt> --yes` removes this directory; then create a new backup" });
  return undefined;
}

/** Whether `path` is not a folder, or is a folder, linked or not, with no manifest that holds none of
 *  the files a backup create writes: snapshots, the checkpoints file or a manifest's temporary name. */
function notAnArtifact(path: string): boolean {
  try {
    if (!statSync(path).isDirectory()) return true;
    if (lstatSync(join(path, "manifest.json"), { throwIfNoEntry: false })) return false;
    return !readdirSync(path).some((name) => /^stream-[0-9a-f]{24}\.snap$/.test(name) || name === "checkpoints.json" || /^manifest\.json\..+\.tmp$/.test(name));
  } catch { return false; }
}

/** Whether the claim on `root` names `path` as its backup destination. */
function claimedDestination(root: string, path: string): boolean {
  try {
    const journal = readMaintenanceJournal(root);
    return journal?.state === "claimed" && !!journal.claim.ownedPaths?.some((owned) => owned.label === "destination" && owned.path === path);
  } catch { return false; }
}

/** A real directory with no `manifest.json`: create writes the manifest last, so this is a backup that
 *  never published. */
function manifestMissing(directory: string): boolean {
  try { return lstatSync(directory).isDirectory() && !lstatSync(join(directory, "manifest.json"), { throwIfNoEntry: false }); }
  catch { return false; }
}

export function readStagedCheckpoints(staged: StagedArtifact): PersistentConsumerCheckpoint[] {
  const value = JSON.parse(readFileSync(join(staged.directory, staged.manifest.checkpoints), "utf8")) as unknown;
  if (!Array.isArray(value)) throw new Error("backup checkpoints must be an array");
  return value as PersistentConsumerCheckpoint[];
}

export function snapshotFileName(stream: string): string {
  return `stream-${createHash("sha256").update(stream).digest("hex").slice(0, 24)}.snap`;
}
