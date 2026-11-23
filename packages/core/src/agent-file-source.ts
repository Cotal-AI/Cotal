import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync, readSync, realpathSync, statSync, type BigIntStats } from "node:fs";
import { hostname } from "node:os";
import { basename, dirname, join } from "node:path";
import { contractDigest, isContractDigest } from "./canonical.js";
import { writeSecretFileAtomic } from "./secret-fs.js";

export const AGENT_FILE_SOURCE_META_KEY = "ai.cotal.agent-file.source";
export const AGENT_FILE_SOURCE_ENV = "COTAL_AGENT_FILE_SOURCE";
export const UNKNOWN_AGENT_FILE_SOURCE = "unknown";

export class AgentFileCatalogChanged extends Error {
  constructor(path: string) { super(`persona catalog changed while reading: ${path}`); }
}

export class AgentFileNotRegular extends Error {
  constructor(path: string) { super(`persona is not a regular file: ${path}`); }
}

export function agentFileDirectory(path: string) {
  const real = realpathSync.native(path);
  const info = statSync(real, { bigint: true });
  const pin = filePin(info);
  return { real, pin, stamp: `${real}:${info.dev}:${info.ino}:${info.birthtimeNs}:${info.ctimeNs}` };
}

type Directory = ReturnType<typeof agentFileDirectory>;

function filePin(info: BigIntStats): string {
  return info.ino && info.birthtimeNs ? `${info.dev}:${info.ino}:${info.birthtimeNs}` : "";
}

function markerPath(path: string): string {
  return join(dirname(path), `.persona-source-${contractDigest(basename(path)).slice("sha256:".length)}.json`);
}

// The pin binds the local marker to the actual inode, so a stale marker cannot bless a new file.
// Keep both pins during atomic replacement so concurrent readers can resolve either complete inode.
function lineage(path: string, pin: string): string | undefined {
  let fd: number;
  try { fd = openSync(markerPath(path), constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return contractDigest(pin);
    return undefined;
  }
  try {
    const info = fstatSync(fd);
    if (!info.isFile() || info.size > 512) return undefined;
    const bytes = Buffer.alloc(513);
    const size = readSync(fd, bytes, 0, bytes.length, 0);
    if (size > 512) return undefined;
    const record = JSON.parse(bytes.subarray(0, size).toString("utf8")) as { before?: unknown; after?: unknown; id?: unknown } | null;
    if (!record || typeof record.before !== "string" || typeof record.after !== "string" || !isContractDigest(record.id))
      return undefined;
    return record.before === pin || record.after === pin ? record.id : contractDigest(pin);
  } catch { return undefined; }
  finally { closeSync(fd); }
}

/** Keep a supported atomic edit associated with the existing entry without embedding IDs in user files. */
export function replaceAgentFile(path: string, bytes: Buffer, expected: Pick<BigIntStats, "ino" | "dev" | "ctimeNs" | "birthtimeNs">): void {
  const pathAtStart = join(agentFileDirectory(dirname(path)).real, basename(path));
  const current = lstatSync(pathAtStart, { bigint: true });
  if (!current.isFile()) throw new Error(`persona is not a regular file: ${path}`);
  if (!sameFileState(current, expected)) throw new AgentFileCatalogChanged(path);
  writeSecretFileAtomic(pathAtStart, bytes, staged => {
    if (!sameFileState(current, lstatSync(path, { bigint: true }))) throw new AgentFileCatalogChanged(path);
    const before = filePin(current);
    const after = filePin(lstatSync(staged, { bigint: true }));
    if (!before || !after) return;
    const id = lineage(pathAtStart, before);
    if (id === undefined) throw new Error(`cannot read persona source record for ${path}`);
    writeSecretFileAtomic(markerPath(pathAtStart), JSON.stringify({ before, after, id }));
  });
}

/** Read one regular file and capture the source from that read. Symlink aliases keep separate IDs. */
export function readAgentFileSnapshot(path: string, directory?: Directory): { bytes: Buffer; sourceId?: string } {
  const parent = directory ?? agentFileDirectory(dirname(path));
  const entry = join(parent.real, basename(path));
  const named = lstatSync(entry, { bigint: true });
  const target = named.isSymbolicLink() ? realpathSync.native(entry) : entry;
  return readRegularAgentFile(target, path, (fd, info) => {
    const bytes = readFileSync(fd);
    const sourceId = snapshotSource(parent, entry, target, named, info);
    if (!directory) assertAgentFileDirectory(dirname(path), parent.stamp);
    return { bytes, sourceId };
  }, constants.O_NOFOLLOW);
}

export function createdAgentFileSource(path: string, directory: Directory, fd: number): string | undefined {
  const info = fstatSync(fd, { bigint: true });
  const entry = join(directory.real, basename(path));
  return snapshotSource(directory, entry, entry, info, info);
}

export function readAgentFileBytes(path: string): Buffer {
  return readRegularAgentFile(path, path, fd => readFileSync(fd));
}

function readRegularAgentFile<T>(file: string, label: string, read: (fd: number, stat: BigIntStats) => T, flags = 0): T {
  if (!statSync(file).isFile()) throw new AgentFileNotRegular(label);
  const fd = openSync(file, constants.O_RDONLY | constants.O_NONBLOCK | flags);
  try {
    const info = fstatSync(fd, { bigint: true });
    if (!info.isFile()) throw new AgentFileNotRegular(label);
    return read(fd, info);
  } finally { closeSync(fd); }
}

export function assertAgentFileDirectory(dir: string, stamp: string): void {
  try {
    if (agentFileDirectory(dir).stamp === stamp) return;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
  throw new AgentFileCatalogChanged(dir);
}

function sameFileState(a: BigIntStats, b: Pick<BigIntStats, "ino" | "dev" | "ctimeNs" | "birthtimeNs">): boolean {
  return a.dev === b.dev && a.ino === b.ino && a.ctimeNs === b.ctimeNs && a.birthtimeNs === b.birthtimeNs;
}

function snapshotSource(parent: Directory, entry: string, target: string, named: BigIntStats, info: BigIntStats): string | undefined {
  const pin = filePin(info);
  const link = named.isSymbolicLink();
  const aliasPin = link ? filePin(named) : undefined;
  const id = pin && parent.pin && aliasPin !== "" ? lineage(target, pin) : undefined;
  if (!sameFileState(named, lstatSync(entry, { bigint: true })) || !sameFileState(info, statSync(entry, { bigint: true }))) throw new AgentFileCatalogChanged(entry);
  return id === undefined ? undefined : contractDigest([hostname(), parent.real, parent.pin, basename(entry), aliasPin ?? null, id]);
}
