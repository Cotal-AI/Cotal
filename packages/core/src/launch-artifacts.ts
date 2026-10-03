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
 * connection to whatever watches the child. A refusal made before any process exists is.
 *
 * WHAT IS LEFT. On a runtime with durable custody (pty on Linux) the seat's custodian, the child's
 * parent, removes them when it sees the child exit, whether or not the launcher is still alive. Its
 * custody record keeps any it could not remove, and the reap that proves the seat gone removes those
 * and the ones a custodian killed first left, against the temp dir the record names, and keeps the
 * record until it has. On any other runtime a killed launcher's artifacts, and those of a spawn that
 * threw, stay until the OS temp reaper removes them.
 *
 * WHAT OWNER-PRIVATE MEANS. Each file is 0600 inside a 0700 directory. That is OS-user isolation:
 * any process running as the same user can read the file while it exists, as it can the agent file
 * it came from.
 */
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { hardenPrivate, writeSecretFile } from "./secret-fs.js";

/** Every artifact directory name starts with this, so {@link discardLaunchArtifacts} can refuse a
 *  path this module did not create. */
const DIR_PREFIX = "cotal-";

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
 * named is the one mistake this must never make.
 */
export function discardLaunchArtifacts(artifacts: readonly string[] | undefined): void {
  if (!artifacts?.length) return;
  const root = resolve(tmpdir());
  for (const dir of artifacts) {
    if (dirname(resolve(dir)) !== root || !basename(dir).startsWith(DIR_PREFIX))
      throw new Error(`refusing to remove launch artifact ${dir}: not a ${DIR_PREFIX}* directory directly under ${root}`);
  }
  for (const dir of artifacts) rmSync(dir, { recursive: true, force: true });
}
