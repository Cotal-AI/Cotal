/**
 * Restore: the destination consumes an admitted seat checkpoint before the seat is alive.
 *
 * This is section 6 step 7 of `docs/design/session-recovery.md`, which that record gives as a shell
 * sequence and calls manual only because no command carried it. Every rule stated there is a rule
 * here, and the reasons are the same ones measured there:
 *
 * - The sequence stages. A clone lands in `<cwd>.incoming`, every verification and both applies run
 *   inside it, and the two renames that promote it are the only steps that touch the path the seat
 *   will use. A failed restore leaves the live `cwd` as it was.
 * - An existing `<cwd>.incoming` refuses. A staging directory from a failed run is the only record
 *   of what failed, so nothing here removes one: an operator inspects it and removes it by hand.
 *   The shell version's `set -e` exists because a bare test reported and continued, and the final
 *   `mv` then promoted a leftover directory that was never restored. Here every step throws.
 * - `git clone` rather than a fetch into an existing repository, because the refspec form that
 *   would populate it fails against the branch HEAD is on, and clone avoids the question.
 * - The recorded base is verified in the clone. A bundle that does not contain it does not apply to
 *   the tree this checkpoint describes.
 * - Two applies, `--index` first and the worktree diff second, both `--binary --allow-empty`. The
 *   order is what puts staged content back in the index rather than only in the worktree, and
 *   `--allow-empty` is why the cleanest possible seat is still restorable.
 * - A pre-existing `cwd` is moved aside under a timestamped name rather than deleted, so a wrong
 *   checkpoint costs a rename instead of a tree.
 *
 * Two things this adds over the manual sequence. The session files travel with the tree, to the
 * paths the destination's own connector will read. And the promoted tree is re-read with
 * `git status --porcelain` and compared to what the checkpoint recorded, so a restore that applied
 * without error and still produced a different index is a refusal rather than a silent difference.
 *
 * git and tar run as child processes through `execFileSync`, never a shell string.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, constants, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import {
  assertSeatCheckpointIntegrity,
  type SeatCheckpoint,
  type SeatCheckpointDestination,
  type SeatCheckpointFile,
} from "@cotal-ai/workspace";

/** One admitted seat this restore is about to place, with the destination paths it lands on. */
export interface SeatRestoreRequest {
  readonly name: string;
  /** The directory the checkpoint was read from, re-verified here over the files as they are now. */
  readonly directory: string;
  readonly checkpoint: SeatCheckpoint;
  /** The working tree the manager will launch this seat in, from the retained inventory. */
  readonly cwd: string;
  /** The session id the retained inventory says this seat reopens, when it has one. A pointer that
   *  names a different session is not this seat's pointer. */
  readonly inventorySessionId?: string;
}

export interface SeatRestoreOptions {
  /** The destination workspace root, the anchor a `workspace-root` destination resolves against. */
  readonly root: string;
  readonly seats: readonly SeatRestoreRequest[];
  /** Reports each promoted seat, so the command can print what it placed. */
  readonly onPromoted?: (seat: { name: string; cwd: string; superseded?: string }) => void;
}

/** Every refusal below. The message names the seat, the step, and what git or tar actually said. */
export class SeatRestoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SeatRestoreError";
  }
}

function run(command: "git" | "tar", args: string[], cwd: string, seat: string, step: string): string {
  try {
    // Both streams are captured. git writes progress and advice to stderr even when it succeeds,
    // and the default here would forward that to the operator's terminal as if the resume had
    // failed; on a failure the same bytes are what the refusal has to name.
    return execFileSync(command, args, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: 1024 * 1024 * 1024,
    });
  } catch (error) {
    const failure = error as { stderr?: string | Buffer; stdout?: string | Buffer; message?: string };
    const output = `${failure.stderr ?? ""}${failure.stdout ?? ""}`.trim() || failure.message || "no output";
    throw new SeatRestoreError(`seat ${seat}: ${step} failed (${command}): ${output}`);
  }
}

/**
 * Where one captured session file lands on THIS host.
 *
 * The anchors are the destination's own: its workspace root, the account home it runs under, and
 * the seat's working tree. The record carries a relative path and the reader already refused an
 * absolute one or a `..` segment, so the result cannot leave the anchor it names.
 */
function destinationPath(destination: SeatCheckpointDestination, root: string, cwd: string): string {
  const anchor = destination.anchor === "workspace-root" ? root : destination.anchor === "home" ? homedir() : cwd;
  return join(anchor, destination.path);
}

/**
 * Write one captured session file where the connector will read it.
 *
 * Durable, private and exclusive. A file already at that path is judged by CONTENT, which is the
 * same rule the rest of the checkpoint is judged by: a destination whose file already hashes to the
 * recorded digest holds the bytes this step exists to place, and that is the ordinary same-host
 * resume, where nothing removed the transcript the seat was writing. Different bytes under the path
 * the connector is about to read are a different session, and that is refused rather than
 * clobbered: the harness transcript is the one thing here Cotal cannot reconstruct.
 */
function placeSessionFile(seat: SeatRestoreRequest, file: SeatCheckpointFile, root: string, created: string[]): void {
  const path = destinationPath(file.restore!, root, seat.cwd);
  const bytes = readFileSync(join(seat.directory, file.path));
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  let fd: number;
  try {
    fd = openSync(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      const present = createHash("sha256").update(readFileSync(path)).digest("hex");
      if (present === file.sha256) return;
      throw new SeatRestoreError(`seat ${seat.name}: ${path} already holds different bytes than the checkpoint recorded (${present} against ${file.sha256}); inspect it and move it aside before resuming`);
    }
    throw error;
  }
  created.push(path);
  try {
    writeSync(fd, bytes);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

/** The sha256-verified pointer's own session id, refused when it is not the one this seat reopens. */
function assertPointerSession(seat: SeatRestoreRequest, pointer: SeatCheckpointFile): void {
  const recorded = seat.checkpoint.session.sessionId ?? seat.inventorySessionId;
  if (!recorded) return;
  let parsed: { sessionId?: unknown };
  try {
    parsed = JSON.parse(readFileSync(join(seat.directory, pointer.path), "utf8")) as { sessionId?: unknown };
  } catch (error) {
    throw new SeatRestoreError(`seat ${seat.name}: captured session pointer is not readable JSON (${(error as Error).message})`);
  }
  if (typeof parsed.sessionId !== "string" || parsed.sessionId !== recorded)
    throw new SeatRestoreError(`seat ${seat.name}: captured session pointer names session ${JSON.stringify(parsed.sessionId)}, this resume reopens ${JSON.stringify(recorded)}`);
  if (seat.inventorySessionId && seat.checkpoint.session.sessionId && seat.inventorySessionId !== seat.checkpoint.session.sessionId)
    throw new SeatRestoreError(`seat ${seat.name}: checkpoint records session ${seat.checkpoint.session.sessionId}, the retained inventory says ${seat.inventorySessionId}`);
}

/** Stage one seat: everything up to and including the extraction, inside `<cwd>.incoming` alone. */
function stageSeat(seat: SeatRestoreRequest, staging: string): void {
  // The digests again, over the files as they are NOW. Gate 1 ran before custody moved; a
  // checkpoint that changed between the gate and the bytes being applied is not the admitted one.
  try {
    assertSeatCheckpointIntegrity(seat.directory, seat.checkpoint);
  } catch (error) {
    throw new SeatRestoreError(`seat ${seat.name}: re-verifying the checkpoint before restore failed: ${(error as Error).message}`);
  }
  // Before the clone, because this decides nothing about the tree and therefore should cost
  // nothing: a pointer that names another session leaves no staging directory to inspect for a
  // step that never ran.
  if (seat.checkpoint.session.pointer) assertPointerSession(seat, seat.checkpoint.session.pointer);
  // A leftover staging directory is evidence of a failed run, never a tree to promote, and nothing
  // here removes it.
  if (existsSync(staging))
    throw new SeatRestoreError(`seat ${seat.name}: ${staging} already exists; a staging directory from a failed restore is evidence - inspect it and remove it by hand, then resume`);
  const parent = dirname(staging);
  mkdirSync(parent, { recursive: true });
  const repository = seat.checkpoint.repository;
  run("git", ["clone", "--quiet", join(seat.directory, repository.bundle.path), staging], parent, seat.name, "cloning the bundle");
  run("git", ["rev-parse", "--verify", `${repository.base}^{commit}`], staging, seat.name, `verifying the recorded base ${repository.base}`);
  run("git", ["checkout", "--quiet", "--detach", repository.base], staging, seat.name, "checking out the recorded base");
  run("git", ["apply", "--binary", "--allow-empty", "--index", join(seat.directory, repository.indexDiff.path)], staging, seat.name, "applying the index diff");
  run("git", ["apply", "--binary", "--allow-empty", join(seat.directory, repository.worktreeDiff.path)], staging, seat.name, "applying the worktree diff");
  run("tar", ["-xf", join(seat.directory, repository.untracked.path)], staging, seat.name, "extracting the untracked archive");
}

/** The timestamped name an existing `cwd` is moved aside under. */
function supersededName(cwd: string): string {
  return `${cwd}.superseded.${new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z")}`;
}

/**
 * Restore every admitted seat, or leave every live `cwd` as it was.
 *
 * Two phases. Every seat is staged first, so a refusal on the last seat costs nothing on the first.
 * Only once every staging directory is complete does any promotion happen, and a failure during the
 * promotion phase puts back what this call moved: the renames it made are undone in reverse and the
 * session files it exclusively created are removed, so the destination is where it started and the
 * whole set can be retried once the refusal is understood.
 */
export function restoreSeatCheckpoints(options: SeatRestoreOptions): void {
  const staged = options.seats.map((seat) => ({ seat, staging: `${resolve(seat.cwd)}.incoming` }));
  for (const { seat, staging } of staged) stageSeat(seat, staging);

  const promoted: Array<{ cwd: string; staging: string; superseded?: string }> = [];
  const created: string[] = [];
  try {
    for (const { seat, staging } of staged) {
      const cwd = resolve(seat.cwd);
      const superseded = existsSync(cwd) ? supersededName(cwd) : undefined;
      if (superseded) renameSync(cwd, superseded);
      renameSync(staging, cwd);
      promoted.push({ cwd, staging, ...(superseded ? { superseded } : {}) });
      // Before the status is read, for the same reason the capture read it with the store in place:
      // a store file inside the tree is part of the state the checkpoint recorded.
      if (seat.checkpoint.session.pointer) placeSessionFile(seat, seat.checkpoint.session.pointer, options.root, created);
      for (const file of seat.checkpoint.session.store) placeSessionFile(seat, file, options.root, created);
      // The bytes landed and git accepted them; this is the only check that sees a restore which
      // applied cleanly and still produced a different index.
      const status = run("git", ["status", "--porcelain"], cwd, seat.name, "re-reading the restored working tree status");
      if (status !== seat.checkpoint.repository.status)
        throw new SeatRestoreError(`seat ${seat.name}: the restored tree reports a different status than the checkpoint recorded\n  recorded: ${JSON.stringify(seat.checkpoint.repository.status)}\n  restored: ${JSON.stringify(status)}`);
      options.onPromoted?.({ name: seat.name, cwd, ...(superseded ? { superseded } : {}) });
    }
  } catch (error) {
    for (const path of created.reverse()) rmSync(path, { force: true });
    for (const entry of promoted.reverse()) {
      renameSync(entry.cwd, entry.staging);
      if (entry.superseded) renameSync(entry.superseded, entry.cwd);
    }
    throw error;
  }
}
