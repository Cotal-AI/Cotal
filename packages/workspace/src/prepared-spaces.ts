import { basename, isAbsolute, join } from "node:path";
import { readFileSync, readdirSync, renameSync, rmSync, statSync, type Stats } from "node:fs";
import { mkSecretDir, writeSecretFile } from "@cotal-ai/core";
import { spaceFromSegment, spaceSegment } from "./auth-paths.js";
import { MeshRegistryError, canonicalRoot, homeCotalDir, isMeshRegistryError } from "./mesh-registry.js";
import { recordOperationWarning } from "./output.js";
import { prepareCotalHomeForWrite } from "./protected-records.js";

/**
 * A local space `cotal space create` prepared and no `cotal up` has started: its name and root.
 *
 * Prepared spaces are kept apart from the mesh registry on purpose. The registry holds spaces a
 * command can connect to, and every reader of it may dial a record's server; a prepared space has
 * no broker yet, so a record there would let a reader, or an older binary that knows nothing of a
 * prepared state, dial the planned address as that space while another broker answers on it.
 */
export interface PreparedSpace {
  readonly space: string;
  /** Absolute path whose `.cotal/` the space will use once `cotal up` starts it there. */
  readonly root: string;
  /** ISO timestamp of when it was prepared. */
  readonly ts: string;
}

export function preparedSpacesDir(): string {
  return join(homeCotalDir(), "prepared");
}

const preparedFile = (space: string): string => join(preparedSpacesDir(), `${spaceSegment(space)}.json`);

/** The space a prepared record's file is named for, or undefined for a name no record is written under. */
export function preparedRecordSpace(file: string): string | undefined {
  return spaceFromSegment(basename(file, ".json"));
}

/** Every prepared space, with each record that cannot be read returned beside them instead of thrown,
 *  so a report can name it. A folder that exists and cannot be read throws a {@link MeshRegistryError}
 *  naming it, and so does a file in its place, with the step that moves it aside. A record removed
 *  between listing and reading is absent. */
export function readPreparedSpaces(): { spaces: PreparedSpace[]; unusable: MeshRegistryError[] } {
  let files: string[];
  try {
    files = readdirSync(preparedSpacesDir()).filter((f) => f.endsWith(".json"));
  } catch (e) {
    const dir = preparedSpacesDir(), code = (e as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return { spaces: [], unusable: [] };
    // Something other than a folder at its path holds no records: moving it aside loses none. A
    // folder above it that is not one fails the stat too, and is the read failure below.
    let stat: Stats | undefined;
    try { stat = code === "ENOTDIR" ? statSync(dir) : undefined; } catch { stat = undefined; }
    if (stat)
      throw new MeshRegistryError(dir, stat.isFile() ? `${dir} is a file, not a folder` : `${dir} is not a folder`, { cause: e, remedy: `move ${dir} aside, for example \`mv ${dir} ${dir}.old\`; Cotal makes the folder when it next prepares a space` });
    throw new MeshRegistryError(dir, `the prepared spaces folder ${dir} could not be read: ${(e as Error).message}`, { cause: e });
  }
  const spaces: PreparedSpace[] = [], unusable: MeshRegistryError[] = [];
  for (const f of files.sort()) {
    try {
      const p = readPreparedFile(join(preparedSpacesDir(), f));
      if (p) spaces.push(p);
    } catch (e) {
      if (!isMeshRegistryError(e)) throw e;
      unusable.push(e);
    }
  }
  return { spaces, unusable };
}

/** Every prepared space this build can read. A record it cannot read is skipped with a warning naming
 *  its file and the forget that removes it, so one damaged record stops only a command about its own
 *  space, which {@link findPreparedSpace} refuses. */
export function loadPreparedSpaces(): PreparedSpace[] {
  const { spaces, unusable } = readPreparedSpaces();
  for (const e of unusable) warnSkipped(e);
  return spaces;
}

/** The step that removes a damaged record: `space forget` for a file named for a space. */
const removeStep = (file: string): string => {
  const space = preparedRecordSpace(file);
  return space === undefined ? "remove it" : `remove it with \`cotal space forget ${space}\``;
};

function warnSkipped(e: MeshRegistryError): void {
  recordOperationWarning({
    code: "PREPARED_RECORD_SKIPPED",
    target: { file: e.file, space: preparedRecordSpace(e.file) ?? null },
    message: `${e.message.slice(0, -` - ${removeStep(e.file)}`.length)}, so it is skipped; ${removeStep(e.file)}`,
  });
}

function readPreparedFile(file: string): PreparedSpace | undefined {
  let doc: Partial<PreparedSpace>;
  try {
    doc = JSON.parse(readFileSync(file, "utf8")) as Partial<PreparedSpace>;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new MeshRegistryError(file, `${file} does not parse as a prepared space record (${(e as Error).message}) - ${removeStep(file)}`, { cause: e });
  }
  if (typeof doc.space !== "string" || typeof doc.root !== "string" || !isAbsolute(doc.root) || typeof doc.ts !== "string" || preparedRecordSpace(file) !== doc.space)
    throw new MeshRegistryError(file, `${file} is not a usable prepared space record - ${removeStep(file)}`);
  return { space: doc.space, root: doc.root, ts: doc.ts };
}

/** The space prepared under `space`. Its own record that cannot be read throws, naming the file; a
 *  damaged record of another space is skipped with a warning, as in {@link loadPreparedSpaces}. */
export function findPreparedSpace(space: string): PreparedSpace | undefined {
  const { spaces, unusable } = readPreparedSpaces();
  const own = unusable.find((e) => preparedRecordSpace(e.file) === space);
  if (own) throw own;
  for (const e of unusable) warnSkipped(e);
  return spaces.find((p) => p.space === space);
}

/** The space prepared at `root`, matched by its canonical path. */
export function preparedSpaceAt(root: string): PreparedSpace | undefined {
  const key = canonicalRoot(root);
  return loadPreparedSpaces().find((p) => canonicalRoot(p.root) === key);
}

/** Write a prepared space: atomic, 0600, in a directory only this user can list. Returns the file. */
export function recordPreparedSpace(p: PreparedSpace): string {
  prepareCotalHomeForWrite();
  mkSecretDir(preparedSpacesDir());
  const file = preparedFile(p.space);
  const tmp = `${file}.${process.pid}.tmp`;
  writeSecretFile(tmp, JSON.stringify(p, null, 2));
  renameSync(tmp, file);
  return file;
}

/** Drop a prepared space. Absent is a no-op. */
export function removePreparedSpace(space: string): void {
  rmSync(preparedFile(space), { force: true });
}
