import { spawnSync } from "node:child_process";
import { lstatSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { CommandFailure, decodeLocalJson, protectedLocalDirectory, readLocalRecordSource } from "@cotal-ai/workspace";
import { seedGeneration } from "../seed/paths.js";
import { selfArgv } from "./self-exec.js";
import { renderSystemdServiceEnvironment } from "./service-systemd-unit.js";

/** A stamp is a source-generation observation, not proof that every payload is intact. A
 *  retained cursor or recovery obligation prevents treating it as a settled private store. */
export function assertPrivateSystemdGeneration(privateHome: string, generation: string, entry: string): void {
  try {
    const dir = join(privateHome, "config", "cotal", "seed");
    protectedLocalDirectory(dir);
    for (const name of ["reconcile.cursor.json", "reconcile.recovery.json", "reconcile.child.json", "reconcile.lock"]) {
      try { lstatSync(join(dir, name)); throw new Error("unsettled seed marker"); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    }
    const bytes = readLocalRecordSource(join(dir, "stamp.json"), 8192, true);
    const stamp = bytes && decodeLocalJson(bytes) as { generation?: unknown; writtenBy?: unknown };
    if (!stamp || stamp.generation !== generation || stamp.writtenBy !== realpathSync(entry)) throw new Error("private generation or entry mismatch");
  } catch {
    throw new CommandFailure("refused", "LIFECYCLE_BLOCKED", "the private connector store has no settled stamp for this executable generation; no unit launch was submitted", { target: { privateHome, generation } });
  }
}

/** Seed only the new unit's isolated XDG config root. The caller records `seed: submitted`
 *  first; a failed child may have written a seed cursor and is never retried automatically. */
export function seedPrivateSystemdStore(privateHome: string, controlHome: string, searchPath: string): string {
  protectedLocalDirectory(privateHome);
  const owner = lstatSync(privateHome);
  if (process.platform !== "linux" || process.getuid === undefined || !owner.isDirectory() || owner.isSymbolicLink() || owner.uid !== process.getuid() || (owner.mode & 0o077) !== 0) throw new CommandFailure("refused", "PERMISSION_DENIED", "the unit's private state root is not owned and mode 0700; no connector seed was launched");
  renderSystemdServiceEnvironment({ controlHome, configHome: join(privateHome, "config"), searchPath });
  const cli = selfArgv();
  if (cli.length !== 2) throw new CommandFailure("refused", "UNSUPPORTED", "private unit seeding needs an installed CLI entry without a transient loader");
  const generation = seedGeneration();
  // The seed child never touches the controller's COTAL_HOME; the unit entry later
  // uses that protected home to read its instance, while both share only private XDG.
  const env: NodeJS.ProcessEnv = {
    PATH: searchPath, COTAL_HOME: privateHome, XDG_CONFIG_HOME: join(privateHome, "config"),
  };
  for (const key of ["HOME", "USER", "LOGNAME", "TMPDIR", "LANG", "LC_ALL"]) if (process.env[key] !== undefined) env[key] = process.env[key];
  const result = spawnSync(cli[0]!, [cli[1]!, "ext", "seed"], { env, timeout: 10 * 60_000, maxBuffer: 128 * 1024, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  if (result.error || result.signal || result.status !== 0) throw new CommandFailure("unknown", "OPERATION_UNKNOWN", "the private connector seed did not confirm completion; its partial store or crash cursor was retained and no seed was retried", { target: { privateHome, generation }, remedy: "inspect this unit's private store and its retained installation intent before another action" });
  try { assertPrivateSystemdGeneration(privateHome, generation, cli[1]!); }
  catch { throw new CommandFailure("unknown", "OPERATION_UNKNOWN", "the completed private seed did not leave an attributable current-generation stamp; it was not retried", { target: { privateHome, generation } }); }
  return generation;
}
