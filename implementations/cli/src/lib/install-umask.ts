import { chmodSync, lstatSync, readdirSync } from "node:fs";
import { join } from "node:path";

/** Run an npm spawn with 022 added to the process umask, keeping any stricter bits, then put the
 *  previous umask back as soon as the spawn call returns. The child takes its umask when it is
 *  created. Under a umask of 0002, npm makes group-writable directories, files and bin targets,
 *  and its own `--umask` setting leaves package directories and bin targets group-writable. */
export function withInstallUmask<T>(spawn: () => T): T {
  const previous = process.umask(0o022);
  process.umask(previous | 0o022);
  try {
    return spawn();
  } finally {
    process.umask(previous);
  }
}

/** Remove group and other write from every folder and file under `root` this account owns, without
 *  following a link, and return how many changed; a missing `root` changes nothing. An installer from
 *  before its 022 umask, or a seed run before its npm children got one, left Cotal's install or its
 *  config folder group-writable under a umask of 0002, and a folder another account can write makes
 *  the protected-path rule refuse what is under it, such as the runtime Node selected as a handler or
 *  a seeded extension. */
export function repairInstallModes(root: string): number {
  if (process.platform === "win32") return 0;
  let changed = 0;
  const walk = (path: string): void => {
    const stat = lstatSync(path, { throwIfNoEntry: false });
    if (!stat || stat.isSymbolicLink() || stat.uid !== process.getuid!()) return;
    if ((stat.mode & 0o022) !== 0 && (stat.isDirectory() || stat.isFile())) {
      chmodSync(path, stat.mode & 0o7755);
      changed++;
    }
    if (stat.isDirectory()) for (const name of readdirSync(path)) walk(join(path, name));
  };
  walk(root);
  return changed;
}
