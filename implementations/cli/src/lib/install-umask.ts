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
