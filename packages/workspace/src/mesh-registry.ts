import {
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * The registry of running meshes: one record per broker `cotal up` started on this machine, so a
 * `cotal spawn` from *any* directory can find which mesh to join, with which creds and personas.
 *
 * Stored as **one JSON file per mesh** (`~/.cotal/meshes/<space>.json`) rather than a single
 * `meshes.json`: concurrent `up`/`down` never read-modify-write the same file (no lost-update race),
 * a crash damages at most one entry, and it mirrors the existing per-process pid files under
 * `~/.cotal`. A separate `~/.cotal/current-mesh` holds the default space for the N-running case
 * (the kubectl `current-context` analogue).
 *
 * Each record stores the mesh's **root path**, not its secrets — trust material stays in that
 * project's `.cotal/auth`; the registry just makes it findable from elsewhere.
 */
export interface MeshEntry {
  /** The space name — also the registry filename stem. */
  space: string;
  /** The broker URL, e.g. `nats://127.0.0.1:4222`. */
  server: string;
  /** Absolute path whose `.cotal/{auth,agents}` hold this mesh's trust material + personas. */
  root: string;
  mode: "auth" | "open";
  /** ISO timestamp of when the record was written. */
  ts: string;
}

/** The cotal machine-home dir (`~/.cotal`), overridable via `COTAL_HOME` so tests sandbox it and
 *  never touch the real one. The single source of that path for the registry, the current pointer,
 *  and the onboard marker. */
export function homeCotalDir(): string {
  return process.env.COTAL_HOME ?? join(homedir(), ".cotal");
}

/** Directory holding the per-mesh registry files (`~/.cotal/meshes`). */
export function meshesDir(): string {
  return join(homeCotalDir(), "meshes");
}

function meshFile(space: string): string {
  return join(meshesDir(), `${encodeURIComponent(space)}.json`);
}

function currentFile(): string {
  return join(homeCotalDir(), "current-mesh");
}

/** Record (or refresh) a running mesh — atomic write, 0600 (the file points at a secrets dir). */
export function recordMesh(m: MeshEntry): void {
  // 0700: the filenames in here ARE the space names, so a world-traversable dir would leak them to
  // other local users even though the file contents are 0600. Keep the dir readable only by us.
  mkdirSync(meshesDir(), { recursive: true, mode: 0o700 });
  const file = meshFile(m.space);
  // Per-process temp name so two concurrent `up`s for the same space can't stomp each other's
  // half-written file before the rename.
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(m, null, 2), { mode: 0o600 });
  renameSync(tmp, file); // atomic replace — a reader never sees a half-written record
}

/** Drop a mesh from the registry (on `cotal down` / a stale-entry prune). Absent ⇒ no-op. */
export function removeMesh(space: string): void {
  rmSync(meshFile(space), { force: true });
}

/** All currently-recorded meshes. An unparseable/partially-written entry is skipped, not fatal —
 *  one bad file must not hide the rest. */
export function loadMeshes(): MeshEntry[] {
  let files: string[];
  try {
    files = readdirSync(meshesDir()).filter((f) => f.endsWith(".json"));
  } catch {
    return []; // no registry yet
  }
  const out: MeshEntry[] = [];
  for (const f of files.sort()) {
    try {
      out.push(JSON.parse(readFileSync(join(meshesDir(), f), "utf8")) as MeshEntry);
    } catch {
      /* skip a corrupt/half-written entry rather than fail the whole listing */
    }
  }
  return out;
}

export function findMesh(space: string): MeshEntry | undefined {
  return loadMeshes().find((m) => m.space === space);
}

/** The default mesh's space name, set by `cotal use` (and by the first `cotal up`). Undefined when
 *  unset or empty. The pointer can dangle (its mesh went down); callers treat a `findMesh` miss as
 *  "no current". */
export function getCurrent(): string | undefined {
  try {
    return readFileSync(currentFile(), "utf8").trim() || undefined;
  } catch {
    return undefined;
  }
}

export function setCurrent(space: string): void {
  mkdirSync(homeCotalDir(), { recursive: true, mode: 0o700 });
  writeFileSync(currentFile(), space, { mode: 0o600 });
}

export function clearCurrent(): void {
  rmSync(currentFile(), { force: true });
}
