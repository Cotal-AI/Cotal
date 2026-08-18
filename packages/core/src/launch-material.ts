/**
 * The launch-material file - how a launcher hands a spawned session its connection material and
 * control token WITHOUT putting either into an environment every descendant process inherits.
 *
 * THE FAILURE THIS EXISTS TO CLOSE. A process environment is inherited transitively and invisibly.
 * A seat launched with `COTAL_CREDS` / `COTAL_SERVERS` / `COTAL_CONTROL_TOKEN` in its environment
 * hands all three to every build script, linter, test suite and third-party CLI it ever shells out
 * to. Measured on a sandbox mesh: an ordinary `node` process run by a seat's shell tool inherited
 * the whole set, read the creds file, and opened an authenticated broker connection AS THE SEAT,
 * having done no credential handling of any kind. `COTAL_SERVERS` pointing at a live broker is the
 * same defect wearing a test-isolation costume: a suite that defaults its server from the
 * environment silently targets production instead of its own fixture, and passes.
 *
 * THE SHAPE, and it is the repo's own precedent rather than a new invention: the secret rides a
 * FILE, never argv (ps-visible) and never the ambient environment (inherited). `cotal agent-bearer`
 * already reads its spawn-time secret from a 0600 token file for exactly this reason. Here the
 * launcher writes ONE 0600 JSON file inside a 0700 private directory and puts only its PATH in the
 * child environment ({@link LAUNCH_MATERIAL_ENV}); the session reads it once at startup.
 *
 * WHAT THAT DOES AND DOES NOT BUY, stated plainly so nobody reads more into it. It removes the
 * values from every descendant's environment: an `env` dump, a CI log capture, a suite that reads
 * `COTAL_SERVERS`, a tool handed the credential it never asked for. It does NOT hide the material
 * from a process running as the same user that deliberately opens the referenced file, and no
 * environment-level control can - that is the filesystem boundary the spawned-agent env allow-list
 * already documents as out of its scope. What changes is that reaching the material becomes a
 * deliberate act instead of an inheritance nobody chose. Connectors whose session runs IN the seat
 * process close the remaining hop by dropping the reference once it has been read (see
 * `scrubLaunchMaterial` in the connector runtime).
 *
 * HOW LONG THE FILE LIVES, split by connector, because there is no single answer and writing one
 * would be the overclaim this file is otherwise careful to avoid. Where the session runs in the
 * process that executes the tool calls (pi, codex, and OpenCode inside the server its shim starts)
 * there is no later reader, so that session calls {@link discardLaunchMaterial} at startup and the
 * file and its private directory cease to exist. Where readers start LATER (the Claude connector's
 * MCP server and its one-process-per-hook relays, the Hermes launcher's gateway child) the file has
 * to outlive startup, so it lives as long as the seat and the OS temp reaper is what removes it. A
 * launch that dies before its session starts leaves its file to that same reaper.
 */
import { mkdtempSync, readFileSync, realpathSync, rmdirSync, statSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { hardenPrivate, writeSecretFile } from "./secret-fs.js";

/** The prefix {@link writeLaunchMaterial} gives its private directory, and the single filename it
 *  puts inside. Named constants because {@link discardLaunchMaterial} has to recognise this module's
 *  own work, and a cleanup that recognises it by a string typed out twice is a cleanup that will one
 *  day delete something else. */
const DIR_PREFIX = "cotal-launch-";
const MATERIAL_FILE = "material.json";

/** The env var naming the launch-material file. It carries a PATH, never a secret. */
export const LAUNCH_MATERIAL_ENV = "COTAL_LAUNCH_MATERIAL";

/** What a launcher hands one spawned session. Every field is optional because the modes differ
 *  (open mesh has no creds; a static-auth launch has no user-mode identity; a launch with no
 *  control endpoint has no token), but an empty material file is refused at write time - an empty
 *  file would be a launcher bug that reads downstream as "open mode". */
export type LaunchMaterial = {
  /** Broker URL(s) the session dials. */
  servers?: string;
  /** Path to the session's NATS creds file (static auth). */
  creds?: string;
  /** Auth token (token / open modes). */
  token?: string;
  /** Shared secret authenticating the first frame on the session's local control socket. */
  controlToken?: string;
  /** User-mode launch identity: principal, sentinel creds path, and the exec-able bearer command. */
  userAuth?: { owner: string; actor: string; sentinelCredsPath: string; bearerCmd: string[] };
};

/**
 * Write one launch's material to a fresh 0600 file in a fresh 0700 directory and return its path.
 *
 * `mkdtemp` rather than a predictable name: a pre-created or symlinked path in the world-writable
 * tmpdir cannot be raced, and a fresh file guarantees the private mode applies at CREATE (a mode
 * argument is ignored on an overwrite). {@link hardenPrivate} covers win32, where the Unix mode is
 * a no-op.
 *
 * REFUSES AN EMPTY MATERIAL rather than writing a file that says nothing. A launcher that computed
 * no material has a bug, and the downstream reader cannot tell that apart from a deliberate open
 * launch - which is precisely the silent-degradation this contract is not allowed to have.
 */
export function writeLaunchMaterial(material: LaunchMaterial): string {
  const present = Object.values(material).some((v) => v !== undefined);
  if (!present)
    throw new Error(
      "launch material: refusing to write an empty material file - a launch with nothing to hand the session must not reference one at all",
    );
  const dir = mkdtempSync(join(tmpdir(), DIR_PREFIX));
  hardenPrivate(dir, "dir"); // win32: mkdtemp's 0700 is a no-op, harden the ACL before the file lands
  const path = join(dir, MATERIAL_FILE);
  writeSecretFile(path, JSON.stringify(material));
  return path;
}

/**
 * Read a launch-material file, or throw a sentence naming the path.
 *
 * FAIL-CLOSED ON A PERMISSIVE MODE. A material file readable by group or other is not a material
 * file: it is the same disclosure this carrier exists to prevent, wearing a different hat. Refusing
 * is the only honest answer, because the alternative (read it anyway, warn) leaves the operator with
 * a session that works and a disclosure they will never look at again. Checked on POSIX only, where
 * the mode bits mean what they say; win32 privacy is the ACL {@link hardenPrivate} set at write.
 */
export function readLaunchMaterial(path: string): LaunchMaterial {
  let raw: string;
  try {
    if (process.platform !== "win32") {
      const mode = statSync(path).mode & 0o777;
      if (mode & 0o077)
        throw new Error(
          `is readable beyond its owner (mode ${mode.toString(8)}) - refusing to read connection material out of a file other local users can open`,
        );
    }
    raw = readFileSync(path, "utf8");
  } catch (e) {
    throw new Error(`launch material: cannot read ${path} (${e instanceof Error ? e.message : String(e)})`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`launch material: ${path} is not valid JSON`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
    throw new Error(`launch material: ${path} must contain a JSON object`);
  return validate(parsed as Record<string, unknown>, path);
}

/**
 * Grade what came off disk, because the WRITE-side refusal is not a read-side guarantee.
 *
 * {@link writeLaunchMaterial} refuses to write an empty material, and for a while that was the only
 * check. It is the wrong place for it to be alone: the reader is handed a path by an environment
 * variable, and a file that is empty, truncated, half-written or shaped wrong reaches it without
 * ever passing through the writer. `{}` parsed cleanly, produced a material with every field
 * undefined, and `configFromEnv` then filled in its defaults - so a launch that REFERENCED material
 * and got nothing usable resolved to the default broker with no credential. Open mode, silently,
 * on a launch that asked for the opposite. That is the exact silent degradation this carrier is
 * supposed to make impossible, arriving through the one door the write-side rule does not cover.
 *
 * So every field is graded here and a bad one throws. Unknown keys are ignored on purpose (a newer
 * launcher may carry a field this reader does not know), but a material with nothing this reader
 * RECOGNISES is refused: there is no launch it could correctly describe.
 */
function validate(raw: Record<string, unknown>, path: string): LaunchMaterial {
  const material: LaunchMaterial = {};
  const str = (key: "servers" | "creds" | "token" | "controlToken"): void => {
    const v = raw[key];
    if (v === undefined) return;
    if (typeof v !== "string" || !v.trim())
      throw new Error(`launch material: ${path} has a ${key} that is not a non-empty string`);
    material[key] = v;
  };
  str("servers");
  str("creds");
  str("token");
  str("controlToken");
  if (raw.userAuth !== undefined) {
    const u = raw.userAuth;
    if (typeof u !== "object" || u === null || Array.isArray(u))
      throw new Error(`launch material: ${path} has a userAuth that is not an object`);
    const { owner, actor, sentinelCredsPath, bearerCmd } = u as Record<string, unknown>;
    const named = { owner, actor, sentinelCredsPath };
    for (const [k, v] of Object.entries(named))
      if (typeof v !== "string" || !v.trim())
        throw new Error(`launch material: ${path} has a userAuth.${k} that is not a non-empty string`);
    if (!Array.isArray(bearerCmd) || bearerCmd.length === 0 || !bearerCmd.every((a) => typeof a === "string" && a))
      throw new Error(`launch material: ${path} has a userAuth.bearerCmd that is not a non-empty array of strings`);
    material.userAuth = {
      owner: owner as string,
      actor: actor as string,
      sentinelCredsPath: sentinelCredsPath as string,
      bearerCmd: bearerCmd as string[],
    };
  }
  if (Object.keys(material).length === 0)
    throw new Error(
      `launch material: ${path} carries nothing this reader recognises. A launch that references material and supplies none is a broken launcher, not an open-mode launch, so it is refused rather than defaulted.`,
    );
  return material;
}

/**
 * Discard one launch's material: unlink the file, and remove the private directory ONLY when this
 * module can tell it wrote that directory itself.
 *
 * THIS FUNCTION EXISTS BECAUSE ITS FIRST VERSION WAS DANGEROUS, and the shape of that mistake is
 * worth keeping in front of whoever edits it next. The first version removed the parent RECURSIVELY
 * whenever its basename began with the writer's prefix, under a comment claiming that proved the
 * directory came from here. It proved that a string starts with another string. A pointer set by
 * hand at any path whose parent happened to be named `cotal-launch-anything` took that parent and
 * every sibling file with it, and the gap between the unlink and the removal turned a concurrent
 * create into collateral deletion. A cleanup added to a security change must not be the most
 * destructive thing in it.
 *
 * So the directory removal is structural rather than a name test, and all four conditions hold or
 * the directory simply stays:
 *
 *  - the file is named exactly what {@link writeLaunchMaterial} names it;
 *  - its parent carries the writer's prefix;
 *  - that parent sits DIRECTLY in the OS temp root, resolved through symlinks on both sides so
 *    `/tmp` and a `/private/tmp` style real path compare equal;
 *  - and the removal is `rmdir`, never recursive, so a directory holding anything else fails to go
 *    and is left exactly as it was found. That is also what closes the race: a file created in the
 *    window makes the removal fail rather than making it destroy more.
 *
 * The FILE is unlinked unconditionally, because the file is the secret and removing it is the whole
 * point. Only the directory is conditional. Both are best effort: a discard that throws would turn
 * tidy-up into a failed session, and the state it would fail into is the state every launch had
 * before this function existed.
 */
export function discardLaunchMaterial(path: string): void {
  const file = resolve(path);
  try {
    unlinkSync(file);
  } catch {
    /* already gone, or not ours to remove; the directory check below still refuses to guess */
  }
  const dir = dirname(file);
  if (basename(file) !== MATERIAL_FILE || !basename(dir).startsWith(DIR_PREFIX)) return;
  try {
    if (realpathSync(dirname(dir)) !== realpathSync(tmpdir())) return;
    rmdirSync(dir); // non-recursive on purpose: anything else inside means this is not ours to delete
  } catch {
    /* not empty, not there, or not resolvable: leaving it is always the safe answer */
  }
}
