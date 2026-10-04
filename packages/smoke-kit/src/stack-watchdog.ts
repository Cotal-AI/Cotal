import { spawn, type ChildProcessByStdio } from "node:child_process";
import type { Writable } from "node:stream";

/**
 * The walk repeats until a pass kills nothing, because a `cotal` call the suite left running can
 * start another daemon while the first pass is still walking. The kernel reports a removed working
 * directory with ` (deleted)` appended, which is stripped so a stack whose suite already deleted
 * its tree is still found.
 */
const WATCHDOG = `
while IFS= read -r root; do set -- "$@" "$root"; done
killed=1
while [ "$killed" ]; do
  killed=
  for proc in /proc/[0-9]*; do
    cwd=$(readlink "$proc/cwd") || continue
    cwd=\${cwd% (deleted)}
    for root; do
      case $cwd in "$root" | "$root"/*) kill -KILL "\${proc#/proc/}" && killed=1 ;; esac
    done
  done
done`;

let watchdog: ChildProcessByStdio<Writable, null, null> | undefined;

/**
 * Kill whatever still works inside `root` once this process ends, however it ends. A hook in this
 * process is not enough: tsx answers a signal the suite does not acknowledge within a few tens of
 * milliseconds with SIGKILL, and a suite waiting in `spawnSync` cannot acknowledge one. The stacks
 * `cotal up --detach` starts are detached, so no handle here holds them either. The watchdog reads
 * its roots from a pipe only this process holds, which closes on any death, SIGKILL included. It
 * leads its own process group, so a runner that kills the suite's group leaves it to finish, and it
 * works from `/` so it is never inside a root it walks. It finds processes through procfs, so
 * nothing is watched off Linux.
 */
export function watchSandboxRoot(root: string): void {
  if (process.platform !== "linux") return;
  if (watchdog === undefined) {
    watchdog = spawn("sh", ["-c", WATCHDOG], { cwd: "/", detached: true, stdio: ["pipe", "ignore", "ignore"] });
    watchdog.unref();
  }
  watchdog.stdin.write(`${root}\n`);
}
