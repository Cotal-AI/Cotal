import { isAbsolute, join } from "node:path";
import { readFileSync, readdirSync, renameSync, rmSync } from "node:fs";
import { mkSecretDir, writeSecretFile } from "@cotal-ai/core";
import { spaceSegment } from "./auth-paths.js";
import { canonicalRoot, homeCotalDir } from "./mesh-registry.js";

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

/** Every prepared space. A file that is not a prepared space record throws naming it, as the
 *  registry does, so a damaged record is never read as an absent one. */
export function loadPreparedSpaces(): PreparedSpace[] {
  let files: string[];
  try {
    files = readdirSync(preparedSpacesDir()).filter((f) => f.endsWith(".json"));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw e;
  }
  return files.sort().map((f) => readPreparedFile(join(preparedSpacesDir(), f)));
}

function readPreparedFile(file: string): PreparedSpace {
  let doc: Partial<PreparedSpace>;
  try {
    doc = JSON.parse(readFileSync(file, "utf8")) as Partial<PreparedSpace>;
  } catch (e) {
    throw new Error(`${file} does not parse as a prepared space record (${(e as Error).message}) - remove it`);
  }
  if (typeof doc.space !== "string" || typeof doc.root !== "string" || !isAbsolute(doc.root) || typeof doc.ts !== "string" || file !== preparedFile(doc.space))
    throw new Error(`${file} is not a usable prepared space record - remove it`);
  return { space: doc.space, root: doc.root, ts: doc.ts };
}

export function findPreparedSpace(space: string): PreparedSpace | undefined {
  return loadPreparedSpaces().find((p) => p.space === space);
}

/** The space prepared at `root`, matched by its canonical path. */
export function preparedSpaceAt(root: string): PreparedSpace | undefined {
  const key = canonicalRoot(root);
  return loadPreparedSpaces().find((p) => canonicalRoot(p.root) === key);
}

/** Write a prepared space: atomic, 0600, in a directory only this user can list. */
export function recordPreparedSpace(p: PreparedSpace): void {
  mkSecretDir(preparedSpacesDir());
  const file = preparedFile(p.space);
  const tmp = `${file}.${process.pid}.tmp`;
  writeSecretFile(tmp, JSON.stringify(p, null, 2));
  renameSync(tmp, file);
}

/** Drop a prepared space. Absent is a no-op. */
export function removePreparedSpace(space: string): void {
  rmSync(preparedFile(space), { force: true });
}
