import { lstatSync, mkdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";

/**
 * Create a directory chain under `parent`, one component at a time, **refusing to follow a
 * symlink**: an existing component that is a symlink (or a non-directory) is a hard error. A
 * pre-planted symlink parent would otherwise let an exclusive-create (`wx`) write land outside the
 * intended Cotal-owned tree — `wx` only guards the final path, not its parents, and a lexical
 * `dirname` check doesn't catch symlink traversal. Missing components are created `0700`.
 *
 * Narrow by design: it closes the pre-planted-symlink hole (the local single-user threat), not a
 * racing attacker (check→create isn't atomic). Returns the final directory path.
 */
export function ensureDirNoSymlink(parent: string, ...segments: string[]): string {
  let dir = parent;
  for (const seg of segments) {
    dir = join(dir, seg);
    let st;
    try {
      st = lstatSync(dir);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") {
        mkdirSync(dir, { mode: 0o700 });
        continue;
      }
      throw e;
    }
    if (st.isSymbolicLink()) throw new Error(`refusing to write under "${dir}": it is a symlink`);
    if (!st.isDirectory()) throw new Error(`refusing to write under "${dir}": not a directory`);
  }
  return dir;
}

/**
 * Walk a directory chain under `parent` one component at a time **without following symlinks**, for
 * a *destructive* caller (e.g. `cotal down -f` removing run artifacts). An existing component that is
 * a symlink or a non-directory is a hard error — so a recursive delete can't be redirected outside
 * the intended tree through a pre-planted symlinked parent. Returns the resolved final path if it
 * exists (a real directory), or `null` if any component is absent (nothing to delete — not an error).
 */
export function realDirNoSymlink(parent: string, ...segments: string[]): string | null {
  let dir = parent;
  for (const seg of segments) {
    dir = join(dir, seg);
    let st;
    try {
      st = lstatSync(dir);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return null; // a missing component ⇒ nothing there
      throw e;
    }
    if (st.isSymbolicLink()) throw new Error(`refusing to delete under "${dir}": it is a symlink`);
    if (!st.isDirectory()) throw new Error(`refusing to delete under "${dir}": not a directory`);
  }
  return dir;
}

/**
 * Delete a single **regular file** at `path` without following a symlink: `lstat` it first and
 * refuse (throw) if it's a symlink or anything other than a regular file, so a destructive caller
 * (cred cleanup in `cotal down -f`) can't be tricked into unlinking a symlink target elsewhere.
 * Returns `true` if a file was removed, `false` if nothing was there (`ENOENT`). The caller is
 * responsible for proving `path`'s parent chain is symlink-free (e.g. derived under a known root).
 */
export function unlinkFileNoFollow(path: string): boolean {
  let st;
  try {
    st = lstatSync(path);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw e;
  }
  if (st.isSymbolicLink()) throw new Error(`refusing to delete "${path}": it is a symlink`);
  if (!st.isFile()) throw new Error(`refusing to delete "${path}": not a regular file`);
  unlinkSync(path);
  return true;
}
