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
 * connection to whatever watches the child. A failure before the runtime has handed the spec's
 * command to anything that could start it is: a runtime says so by throwing {@link SpawnRefused},
 * and the launcher removes the files on that error only. A removal that fails leaves them owned, and
 * the owner tries again.
 *
 * WHAT IS LEFT. On a custodial runtime the seat's custodian, the child's parent, removes them when it
 * sees the child exit, whether or not the launcher is still alive. Its custody record keeps any it
 * could not remove, and the reap that proves the seat gone removes those and the ones a custodian
 * killed first left, against the temp dir the record names, and keeps the record until it has. Every
 * other launcher starts the child through {@link reclaimWithChild}, so a watcher beside the child
 * removes them once the child is gone, even when the launcher was killed.
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
 * Thrown by a runtime's `spawn` for a failure before it handed the spec's command to anything that
 * could start it (an unsafe name, a backend that is not reachable, a launch script it could not
 * write). It is the one spawn failure that proves no child will read the spec's artifacts, so the
 * launcher removes them on it. Throw it only from code that runs before that handoff.
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

/** The shell execs the agent in place, so its pid stays valid until the agent exits. Only ESRCH
 *  proves the pid is gone. PID reuse or a permission change can delay removal, never hasten it.
 *  Once the agent is gone, retry any failed removal every five seconds. */
const RECLAIM_WATCHER = `import { rmSync } from "node:fs";
import { setTimeout as wait } from "node:timers/promises";
const pid = Number(process.argv[1]);
let dirs = JSON.parse(process.argv[2]);
while (true) {
  try { process.kill(pid, 0); }
  catch (error) { if (error.code === "ESRCH") break; }
  await wait(1_000);
}
while (dirs.length) {
  dirs = dirs.filter((dir) => {
    try { rmSync(dir, { recursive: true, force: true }); return false; }
    catch { return true; }
  });
  if (dirs.length) await wait(5_000);
}`;

/** Start the watcher in its own session so terminal and process-group signals cannot stop it.
 *  Wait for this bootstrap before the shell execs the agent. A spawn refusal is reported on stderr
 *  and fails the launch. Neither process needs an executable from PATH. */
const START_RECLAIM_WATCHER = `import { spawn } from "node:child_process";
const watcher = spawn(process.execPath, ["--input-type=module", "-e", ${JSON.stringify(RECLAIM_WATCHER)}, "--", ...process.argv.slice(1)], {
  detached: true, stdio: "ignore", env: {},
});
watcher.once("error", (error) => {
  console.error("could not start the launch artifact watcher: " + error.message);
  process.exitCode = 1;
});
watcher.unref();`;

/** Run as `/bin/sh -c <script> cotal-launch <node> <bootstrap> <dirs-json> <command> <args...>`. */
const RECLAIM_SCRIPT = `NODE_OPTIONS= "$1" --input-type=module -e "$2" -- "$$" "$3" </dev/null >/dev/null || exit $?
shift 3
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
  const paths = JSON.stringify(dirs.map((dir) => resolve(dir)));
  return {
    ...spec,
    command: "/bin/sh",
    args: ["-c", RECLAIM_SCRIPT, "cotal-launch", process.execPath, START_RECLAIM_WATCHER, paths, spec.command, ...spec.args],
  };
}

/** Payload serialized into the private Node launcher script built by {@link launcherSource}. */
export interface LauncherPayload {
  cwd: string;
  command: string;
  args: string[];
  env: Record<string, string>;
}

/**
 * Build the private `.mjs` launcher script that runtimes without an inline-free spawn API
 * (`@cotal-ai/orca`, `@cotal-ai/herdr`) write through {@link writeSecretFile}. The script removes
 * its own directory on load, changes to `payload.cwd`, spawns `payload.command` with `payload.args`
 * and `payload.env`, forwards `SIGINT` and `SIGTERM`, prints `<label> <command>: <message>` with
 * exit 127 on a spawn error, and exits 128 on a signalled child or the child's exit code.
 */
export function launcherSource(label: string, payload: LauncherPayload): string {
  if (!label || label !== label.trim() || /[\r\n]/.test(label))
    throw new Error("launcherSource requires a single-line diagnostic label");
  return `import { spawn } from "node:child_process";\n` +
    `import { rmSync } from "node:fs";\n` +
    `const launch = ${JSON.stringify(payload)};\n` +
    `try { rmSync(new URL(".", import.meta.url), { recursive: true, force: true }); } catch {}\n` +
    `process.chdir(launch.cwd);\n` +
    `const child = spawn(launch.command, launch.args, { env: launch.env, stdio: "inherit", windowsHide: false });\n` +
    `let exiting = false;\n` +
    `const forward = (signal) => { if (!exiting && child.pid) child.kill(signal); };\n` +
    `process.on("SIGINT", () => forward("SIGINT"));\n` +
    `process.on("SIGTERM", () => forward("SIGTERM"));\n` +
    `child.on("error", (err) => { console.error(${JSON.stringify(`${label} `)} + launch.command + ": " + err.message); process.exit(127); });\n` +
    `child.on("exit", (code, signal) => { exiting = true; if (signal) process.exit(128); process.exit(code ?? 0); });\n`;
}
