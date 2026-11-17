import { spawn, type SpawnOptions } from "node:child_process";

/** Give the broker an owner-private umask for files it creates later, including rotated logs.
 *  Spawn is synchronous: restore the caller's mask before any asynchronous work can run. */
export function spawnBroker(program: string, args: readonly string[], options: SpawnOptions) {
  const previous = process.umask(0o077);
  try {
    process.umask(previous | 0o077);
    return spawn(program, args, options);
  } finally {
    process.umask(previous);
  }
}
