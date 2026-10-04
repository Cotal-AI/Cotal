import { createHash } from "node:crypto";
import { existsSync, mkdirSync, renameSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const ILLEGAL = /[^A-Za-z0-9_-]/g;
const tok = (s: string): string => s.trim().replace(ILLEGAL, "_").slice(0, 40) || "_";
const seatId = (space: string, name: string): string =>
  createHash("sha256").update(`${space}\0${name}`).digest("hex").slice(0, 12);

/**
 * The managed seat's disposable HERMES_HOME: a Hermes named profile, `<root>/profiles/cotal-<id>`,
 * under a root of its own in tmp, `<tmp>/cotal-hermes-<id>`. The launcher runs the seat there, and
 * `buildLaunch` names the seat's fork record ({@link HERMES_FORK_RECORD}) inside it.
 *
 * Hermes names a gateway's systemd unit after its profile, and it reads a HERMES_HOME outside
 * ~/.hermes whose parent is not `profiles` as a root. A root's unit is the bare `hermes-gateway`,
 * which is the unit the operator's own gateway installs. Every `hermes gateway run` checks and
 * refreshes that unit, so a seat on a bare temp home refused to start while the operator's gateway
 * was active, and regenerated the operator's unit from this temp directory on every launch (written
 * by Hermes before 0.18, after which the unit failed at CHDIR once tmp was cleared). As a named
 * profile the seat's unit is `hermes-gateway-cotal-<id>`, which no operator unit carries. The id is
 * a digest of space and name: stable per seat, and inside Hermes' profile-name pattern.
 *
 * The root is what a stop removes, so it holds everything the gateway writes: Hermes keeps state
 * beside `profiles/` (its kanban database), and the gateway's TMPDIR is `<root>/tmp`. It is named by
 * the digest alone so that no two seats share one. A stop keeps a root whose profile holds the fork
 * record, because the seat's next launch under the same name continues that fork.
 */
export function hermesSeatHome(space: string, name: string): { root: string; home: string } {
  const id = seatId(space, name);
  const root = join(tmpdir(), `cotal-hermes-${id}`);
  return { root, home: join(root, "profiles", `cotal-${id}`) };
}

/**
 * Move a `--resume` fork left under the earlier layout, `<tmp>/cotal-hermes-<space>-<name>/profiles/cotal-<id>`,
 * to the seat's {@link hermesSeatHome}, so a relaunch under the same name continues that fork and still
 * refuses a different session. Only the seat's own profile moves, because two seats could share that
 * earlier root, and only one holding a fork record, the one profile a stop keeps. A profile already at
 * the new home without a fork record is replaced: it is disposable, left by a launch that failed or was
 * killed before its stop, and keeping it would fork the session again. Returns the path it moved, or
 * undefined when there was nothing to move or the seat already has a fork.
 */
export function moveLegacyHermesFork(space: string, name: string): string | undefined {
  const { home } = hermesSeatHome(space, name);
  const legacy = join(tmpdir(), `cotal-hermes-${tok(space)}-${tok(name)}`, "profiles", `cotal-${seatId(space, name)}`);
  if (existsSync(join(home, HERMES_FORK_RECORD)) || !existsSync(join(legacy, HERMES_FORK_RECORD))) return undefined;
  rmSync(home, { recursive: true, force: true });
  mkdirSync(dirname(home), { recursive: true });
  renameSync(legacy, home);
  return legacy;
}

/** The seat's record of a `--resume` fork, written by plugin/cotal/resume.py. */
export const HERMES_FORK_RECORD = "cotal-resume.json";
