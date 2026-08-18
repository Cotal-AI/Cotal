/**
 * The launch-material file — how a launcher hands a spawned session its connection material and
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
 * environment-level control can — that is the filesystem boundary the spawned-agent env allow-list
 * already documents as out of its scope. What changes is that reaching the material becomes a
 * deliberate act instead of an inheritance nobody chose. Connectors whose session runs IN the seat
 * process close the remaining hop by dropping the reference once it has been read (see
 * `scrubLaunchMaterial` in the connector runtime).
 *
 * The file is left for the OS to reap: it must outlive this call, because the readers are the
 * session's own long-lived process and, on some connectors, short-lived hook processes that start
 * later.
 */
import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hardenPrivate, writeSecretFile } from "./secret-fs.js";

/** The env var naming the launch-material file. It carries a PATH, never a secret. */
export const LAUNCH_MATERIAL_ENV = "COTAL_LAUNCH_MATERIAL";

/** What a launcher hands one spawned session. Every field is optional because the modes differ
 *  (open mesh has no creds; a static-auth launch has no user-mode identity; a launch with no
 *  control endpoint has no token), but an empty material file is refused at write time — an empty
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
 * launch — which is precisely the silent-degradation this contract is not allowed to have.
 */
export function writeLaunchMaterial(material: LaunchMaterial): string {
  const present = Object.values(material).some((v) => v !== undefined);
  if (!present)
    throw new Error(
      "launch material: refusing to write an empty material file - a launch with nothing to hand the session must not reference one at all",
    );
  const dir = mkdtempSync(join(tmpdir(), "cotal-launch-"));
  hardenPrivate(dir, "dir"); // win32: mkdtemp's 0700 is a no-op, harden the ACL before the file lands
  const path = join(dir, "material.json");
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
  return parsed as LaunchMaterial;
}
