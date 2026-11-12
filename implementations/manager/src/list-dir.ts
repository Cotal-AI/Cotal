import { opendir, stat } from "node:fs/promises";
import { dirname, join } from "node:path";

export interface DirectoryListing {
  path: string;
  parent: string | null;
  directories: { name: string; symlink: boolean }[];
  truncated: boolean;
  roots: string[];
}

/** Lists directory names without retaining an unbounded directory entry array. */
export async function listDirectory(path: string, includeHidden: boolean, limit: number): Promise<DirectoryListing> {
  const directories: DirectoryListing["directories"] = [];
  let count = 0;
  const directory = await opendir(path);
  for await (const entry of directory) {
    if (!includeHidden && entry.name.startsWith(".")) continue;
    const symlink = entry.isSymbolicLink();
    if (!entry.isDirectory()) {
      if (!symlink) continue;
      try {
        if (!(await stat(join(path, entry.name))).isDirectory()) continue;
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === "ENOENT" || code === "ENOTDIR" || code === "ELOOP") continue;
        throw error;
      }
    }
    count++;
    const row = { name: entry.name, symlink };
    const index = directories.findIndex((item) => item.name > row.name);
    if (index === -1) directories.push(row);
    else directories.splice(index, 0, row);
    if (directories.length > limit) directories.pop();
  }
  const roots: string[] = [];
  if (process.platform === "win32") {
    for (const letter of "ABCDEFGHIJKLMNOPQRSTUVWXYZ") {
      const root = `${letter}:\\`;
      try {
        if ((await stat(root)).isDirectory()) roots.push(root);
      } catch {
        // Drive letters include empty, locked and disconnected volumes. Only usable roots belong here.
      }
    }
  } else {
    roots.push("/");
    if (process.platform === "darwin") roots.push("/Volumes");
  }
  const parent = dirname(path);
  return { path, parent: parent === path ? null : parent, directories, truncated: count > limit, roots };
}
