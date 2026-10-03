/**
 * Launch artifacts: the private temporary directories a connector writes for ONE launch's child to
 * read, such as a persona carrier or an MCP config file. They keep text off the process argv, which
 * every same-host observer can read.
 *
 * WHO OWNS THEM. The connector creates them in `buildLaunch` and lists them on
 * `LaunchSpec.artifacts`; it cannot remove them itself, because the child reads them after
 * `buildLaunch` returns (Claude re-reads its MCP config on `/mcp reconnect`). The launcher that
 * spawns the spec owns them from then on: it removes them once it has proved the child gone. Nothing
 * earlier is safe, since the child may read them at any point in its life. A spawn that throws is not
 * that proof, since a backend can fail after its child has started, and neither is losing the
 * connection to whatever watches the child. A refusal made before any process exists is: a runtime
 * says so by throwing {@link SpawnRefused}, and the launcher removes the files on that error only.
 * A removal that fails leaves them owned, and the owner tries again.
 *
 * WHAT IS LEFT. On a runtime with durable custody (pty on Linux) the seat's custodian, the child's
 * parent, removes them when it sees the child exit, whether or not the launcher is still alive. Its
 * custody record keeps any it could not remove, and the reap that proves the seat gone removes those
 * and the ones a custodian killed first left, against the temp dir the record names, and keeps the
 * record until it has. Every other launcher starts the child through {@link reclaimWithChild}, so a
 * watcher beside the child removes them once the child is gone, even when the launcher was killed.
 * What stays until the OS temp reaper removes it: the files of a spawn that threw anything but
 * {@link SpawnRefused} before its child started, those of a watcher that was itself SIGKILLed while
 * its launcher was dead, and on Windows, which has no POSIX shell to run the watcher, those of a
 * killed launcher.
 *
 * WHAT OWNER-PRIVATE MEANS. Each file is 0600 inside a 0700 directory. That is OS-user isolation:
 * any process running as the same user can read the file while it exists, as it can the agent file
 * it came from.
 */
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import type { LaunchSpec } from "./connector.js";
import { hardenPrivate, writeSecretFile } from "./secret-fs.js";

/** Every artifact directory name starts with this, so {@link discardLaunchArtifacts} can refuse a
 *  path this module did not create. */
const DIR_PREFIX = "cotal-";

/**
 * Thrown by a runtime's `spawn` for a refusal it made before starting any process (an unsafe name, a
 * backend that is not reachable). It is the one spawn failure that proves no child will read the
 * spec's artifacts, so the launcher removes them on it. Throw it only from checks that run before the
 * first side effect.
 */
export class SpawnRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SpawnRefused";
  }
}

/**
 * Write `body` to `<fresh private dir>/<file>` and return the file path. The directory is appended to
 * `artifacts` as soon as it exists, so a write that fails afterwards still leaves it owned; on a
 * failure every artifact recorded so far is removed before the error propagates, because the launch
 * that would have owned them is not going to happen.
 *
 * `mkdtemp` rather than a predictable name: a pre-created or symlinked path in the world-writable
 * tmpdir cannot be raced, and a fresh file guarantees the private mode applies at create. The name
 * also carries 128 random bits, which makes it this launch's identity: a stale list of directories
 * already removed (a custodian killed between removing them and updating its record) cannot name a
 * later launch's directory, because no later launch draws the same name.
 */
export function writeLaunchArtifact(artifacts: string[], prefix: string, file: string, body: string): string {
  if (!prefix.startsWith(DIR_PREFIX)) throw new Error(`launch artifact prefix must start with "${DIR_PREFIX}": ${prefix}`);
  try {
    const dir = mkdtempSync(join(tmpdir(), `${prefix}${randomBytes(16).toString("hex")}-`));
    artifacts.push(dir);
    hardenPrivate(dir, "dir"); // win32: mkdtemp's 0700 is a no-op, so harden the ACL before the file lands
    const path = join(dir, file);
    writeSecretFile(path, body);
    return path;
  } catch (e) {
    discardLaunchArtifacts(artifacts);
    throw e;
  }
}

/**
 * Remove a launch's artifact directories. Call it only once the child is gone or never started.
 * Refuses, before removing anything, a path that is not a `cotal-` directory directly under the OS
 * temp dir: a spec carrying anything else is a connector bug, and recursive removal of whatever it
 * named is the one mistake this must never make. Otherwise it tries every directory and then throws
 * naming each one it could not remove, so the caller can keep them owned and try again.
 */
export function discardLaunchArtifacts(artifacts: readonly string[] | undefined): void {
  if (!artifacts?.length) return;
  assertArtifactDirs(artifacts);
  const failed: string[] = [];
  for (const dir of artifacts) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch (e) {
      failed.push(`${dir} (${(e as Error).message})`);
    }
  }
  if (failed.length) throw new Error(`could not remove launch artifact ${failed.join(", ")}`);
}

/** Refuse any path that is not a `cotal-` directory directly under the OS temp dir. */
function assertArtifactDirs(artifacts: readonly string[]): void {
  const root = resolve(tmpdir());
  for (const dir of artifacts) {
    if (dirname(resolve(dir)) !== root || !basename(dir).startsWith(DIR_PREFIX))
      throw new Error(`refusing to remove launch artifact ${dir}: not a ${DIR_PREFIX}* directory directly under ${root}`);
  }
}

/** Run by `/bin/sh -c` as `<script> cotal-launch <n> <n dirs> <command> <args...>`. The watcher
 *  ignores the hangup, interrupt and terminate signals a closing terminal or a stop sends to the
 *  child's process group, holds no terminal, and polls the shell's pid, which `exec` hands to the
 *  command. A reused pid only delays the removal. */
const RECLAIM_SCRIPT = `p=$$ n=$1
shift
(
  trap '' HUP INT QUIT TERM
  while kill -0 "$p" 2>/dev/null; do sleep 1; done
  while [ "$n" -gt 0 ]; do rm -rf -- "$1"; shift; n=$((n - 1)); done
) </dev/null >/dev/null 2>&1 &
shift "$n"
exec "$@"`;

/**
 * Wrap a spec so its child owns its own artifacts. `/bin/sh` starts a watcher and then `exec`s the
 * spec's command, so the agent keeps the shell's pid, its argv after the wrapper, its signals and its
 * exit status. The watcher removes this launch's directories, and no other, once that pid is gone,
 * whether or not the launcher is still alive. Use it wherever the launcher is the only other owner
 * (every runtime but one with durable custody, and the foreground `cotal spawn`). The launcher still
 * removes them on its own proof of exit; both removals are idempotent. A spec with no artifacts, and
 * any spec on Windows, which has no POSIX shell, comes back unchanged.
 */
export function reclaimWithChild(spec: LaunchSpec): LaunchSpec {
  const dirs = spec.artifacts;
  if (!dirs?.length || process.platform === "win32") return spec;
  assertArtifactDirs(dirs);
  return {
    ...spec,
    command: "/bin/sh",
    args: ["-c", RECLAIM_SCRIPT, "cotal-launch", String(dirs.length), ...dirs, spec.command, ...spec.args],
  };
}
