import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
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
import { dirname, isAbsolute, join, resolve } from "node:path";
import type {
  BackupStreamState,
  PersistentConsumerCheckpoint,
  SpaceBackupSelection,
} from "@cotal-ai/core";
import type { MaintenanceAuthMode, StoreIdentity } from "@cotal-ai/workspace";
import type { AuthorityFingerprint } from "./maintenance-files.js";

export const BACKUP_MANIFEST_FORMAT = "cotal-space-backup/v1" as const;
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
  format: typeof BACKUP_MANIFEST_FORMAT;
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

function safeFileName(name: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,200}$/.test(name) || name === "manifest.json")
    throw new Error(`invalid backup artifact file name ${JSON.stringify(name)}`);
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
    chmodSync(directory, 0o700);
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

function parseManifest(path: string): BackupManifest {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_MANIFEST_BYTES)
    throw new Error(`backup manifest is not a bounded regular file: ${path}`);
  const value = JSON.parse(readFileSync(path, "utf8")) as BackupManifest;
  if (value.format !== BACKUP_MANIFEST_FORMAT) throw new Error(`unsupported backup format ${JSON.stringify(value.format)}`);
  if (!value.space || !["full", "registry"].includes(value.selection) || !["auth", "open", "user"].includes(value.mode))
    throw new Error("backup manifest has invalid space, selection, or mode");
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

function copyPinnedFile(source: string, destination: string, expected: BackupFileRecord): void {
  const pathStat = lstatSync(source);
  if (!pathStat.isFile() || pathStat.isSymbolicLink()) throw new Error(`backup input is not a real file: ${source}`);
  const noFollow = process.platform === "win32" ? 0 : constants.O_NOFOLLOW;
  const sourceFd = openSync(source, constants.O_RDONLY | noFollow);
  let destinationFd: number | undefined;
  const hash = createHash("sha256");
  let size = 0;
  try {
    const before = fstatSync(sourceFd, { bigint: true });
    if (!before.isFile()) throw new Error(`backup input is not a regular file: ${source}`);
    destinationFd = openSync(destination, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
    const buffer = Buffer.allocUnsafe(COPY_BUFFER_BYTES);
    for (;;) {
      const count = readSync(sourceFd, buffer, 0, buffer.length, null);
      if (count === 0) break;
      const chunk = buffer.subarray(0, count);
      writeAll(destinationFd, chunk);
      hash.update(chunk);
      size += count;
      if (size > expected.size) throw new Error(`backup input grew while staging: ${source}`);
    }
    const after = fstatSync(sourceFd, { bigint: true });
    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mtimeNs !== after.mtimeNs)
      throw new Error(`backup input changed while staging: ${source}`);
    if (size !== expected.size || hash.digest("hex") !== expected.sha256)
      throw new Error(`backup input size or SHA-256 mismatch: ${source}`);
    fsyncSync(destinationFd);
    if (fstatSync(destinationFd).size !== size)
      throw new Error(`staged backup size mismatch after writing ${destination}`);
  } finally {
    if (destinationFd !== undefined) closeSync(destinationFd);
    closeSync(sourceFd);
  }
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
  const expected = new Set(["manifest.json", ...manifest.files.map((file) => file.path)]);
  const actual = readdirSync(artifact);
  if (new Set(actual).size !== actual.length || actual.some((name) => !expected.has(name)) || actual.length !== expected.size)
    throw new Error("backup artifact contains extra, duplicate, or missing files");
  if (new Set(manifest.files.map((file) => file.path)).size !== manifest.files.length)
    throw new Error("backup artifact file inventory contains duplicate paths");
  for (const file of manifest.files) {
    safeFileName(file.path);
    if (!Number.isSafeInteger(file.size) || file.size < 0 || !/^[0-9a-f]{64}$/.test(file.sha256) ||
        !["snapshot", "checkpoints"].includes(file.kind) ||
        (file.kind === "snapshot") !== (typeof file.stream === "string"))
      throw new Error(`backup file metadata is invalid: ${file.path}`);
    if (file.kind === "checkpoints" && file.size > MAX_CHECKPOINT_BYTES)
      throw new Error(`backup checkpoints exceed ${MAX_CHECKPOINT_BYTES} bytes`);
  }
  const checkpointFiles = manifest.files.filter((file) => file.kind === "checkpoints");
  if (checkpointFiles.length !== 1 || checkpointFiles[0].path !== manifest.checkpoints)
    throw new Error("backup manifest must name exactly one checkpoints file");
  const snapshotFiles = new Map(manifest.files.filter((file) => file.kind === "snapshot").map((file) => [file.path, file.stream]));
  if (snapshotFiles.size !== manifest.streams.length || manifest.streams.some((stream) => snapshotFiles.get(stream.snapshot) !== stream.stream))
    throw new Error("backup stream records do not match snapshot file metadata");
  const parentPath = realpathSync.native(resolve(parent));
  const parentStat = lstatSync(parentPath, { bigint: true });
  if (!parentStat.isDirectory() || parentStat.isSymbolicLink()) throw new Error(`restore staging parent is not a real directory: ${parentPath}`);
  const parentIdentity = { dev: parentStat.dev, ino: parentStat.ino };
  const directory = join(parentPath, `.cotal-restore-stage-${randomUUID()}`);
  mkdirSync(directory, { mode: 0o700 });
  chmodSync(directory, 0o700);
  const identityStat = lstatSync(directory, { bigint: true });
  const identity = { dev: identityStat.dev, ino: identityStat.ino };
  try {
    for (const file of manifest.files) copyPinnedFile(join(artifact, file.path), join(directory, file.path), file);
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

export function readStagedCheckpoints(staged: StagedArtifact): PersistentConsumerCheckpoint[] {
  const value = JSON.parse(readFileSync(join(staged.directory, staged.manifest.checkpoints), "utf8")) as unknown;
  if (!Array.isArray(value)) throw new Error("backup checkpoints must be an array");
  return value as PersistentConsumerCheckpoint[];
}

export function snapshotFileName(stream: string): string {
  return `stream-${createHash("sha256").update(stream).digest("hex").slice(0, 24)}.snap`;
}
