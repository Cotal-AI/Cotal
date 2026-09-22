/**
 * Step 7 and 8 of the preservation cut: capture one seat's repository state and harness session
 * store, then seal a checkpoint over the captured bytes.
 *
 * Ordering is the whole point and it is not negotiable. Capture runs only after
 * `Manager.awaitHandleExit` has proven every child gone (step 6). A capture before that races the
 * harness by construction: the transcript is still being written and the working tree is still
 * being edited. Nothing in this file may be called from a path that has not proven the stop.
 *
 * The git work shells out to the operator's own git rather than reimplementing bundle and diff
 * formats, so a self-hoster can verify every artifact by hand with the same commands.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { sessionContinuityClass, type Connector } from "@cotal-ai/core";
import {
  createSeatCheckpointWriter,
  type SeatCheckpoint,
  type SeatCheckpointFile,
  type SeatCheckpointSession,
} from "@cotal-ai/workspace";

/** The selection rule the untracked set is produced under, recorded in the checkpoint so a
 *  destination that cannot reproduce it refuses.
 *
 *  Two clauses, and the second is not an optimization. `--exclude-standard` honors `.gitignore`,
 *  so an ignored file the seat actually needs is outside the checkpoint and has to be named
 *  separately by the operator. The `.cotal/` exclusion is a SECRECY boundary: when a seat's cwd is
 *  also the mesh root, which is what an operator gets by running `cotal up` and `cotal spawn` in
 *  one directory, the control directory is untracked and the unfiltered selection pulls
 *  `auth/broker.json`, the space account, the manager instance identity's private seed and the
 *  seat's own `.creds` into the artifact. A checkpoint carries credential REFERENCES, never
 *  values, so the control directory never travels; the destination resolves that material itself. */
export const UNTRACKED_SELECTION = "git ls-files --others --exclude-standard -z, excluding .cotal/";

/** The control directory a checkpoint must never carry, relative to the seat's cwd. */
const CONTROL_DIR = ".cotal/";

/** Default freshness horizon: 24 hours. A property of the deployment, carried in every record so a
 *  destination and an operator cannot disagree about what was promised. */
export const DEFAULT_RECENCY_HORIZON_MS = 24 * 60 * 60 * 1000;

function git(cwd: string, args: string[]): Buffer {
  return execFileSync("git", args, { cwd, maxBuffer: 1024 * 1024 * 1024 });
}

export interface SeatCaptureRequest {
  /** The seat's working tree, from `ManagerResumeAgent.launch.cwd`. */
  readonly cwd: string;
  readonly space: string;
  readonly name: string;
  readonly lifecycleUid: string;
  /** The generation this cut is taken at. The destination advances past it. */
  readonly generation: number;
  readonly recencyHorizonMs?: number;
  readonly profile: SeatCheckpoint["profile"];
  /** The connector's declared capabilities, for `sessionContinuityClass`. Never the connector's
   *  name: a continuity promise may not be inferred from a package name. Unknown capabilities are
   *  default-deny and therefore drain-only. */
  readonly connector: Pick<Connector, "supportsResume" | "supportsSessionContinuation" | "supportsFreshStart"> | undefined;
  readonly sessionId?: string;
  /** The connector's session pointer file, when it declares one. */
  readonly sessionStatePath?: string;
  /** The harness transcript store, an operator input: this repository names the pointer file and
   *  not the store, and a default written here would be a guess presented as a fact. */
  readonly sessionStorePaths?: readonly string[];
}

/**
 * Capture and seal. Returns the sealed record. Throws, leaving no checkpoint directory behind,
 * when anything cannot be captured: a partial checkpoint that looks complete is worse than none.
 */
export function captureSeatCheckpoint<Entry>(
  destination: string,
  entry: Entry,
  request: SeatCaptureRequest,
): SeatCheckpoint<Entry> {
  const { cwd } = request;
  const base = git(cwd, ["rev-parse", "HEAD"]).toString("utf8").trim();
  if (!/^[0-9a-f]{40,64}$/.test(base))
    throw new Error(`seat checkpoint: ${cwd} did not report a full base object id (got ${JSON.stringify(base)})`);

  // git writes the bundle and the diffs here first, so the checkpoint writer only ever copies a
  // finished file and digests what it copied. The parent is the checkpoint destination's own
  // parent, which the caller may not have created yet on a first cut.
  const parent = dirname(resolve(destination));
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  const staging = mkdtempSync(join(parent, "cotal-seat-capture-"));
  const writer = createSeatCheckpointWriter(destination);
  try {
    const bundlePath = join(staging, "repo.bundle");
    git(cwd, ["bundle", "create", bundlePath, "--all"]);
    // Two diffs, not one. A single diff against the base records the difference between that
    // commit and the worktree without recording which parts were STAGED, so a restore from it
    // reports every change as unstaged. Base-to-index and index-to-worktree, applied in that
    // order, reproduce the source's `git status --porcelain`, worktree bytes and staged content
    // together.
    const indexDiffPath = join(staging, "repo.index.diff");
    writeFileSync(indexDiffPath, git(cwd, ["diff", "--binary", "--cached"]));
    const worktreeDiffPath = join(staging, "repo.worktree.diff");
    writeFileSync(worktreeDiffPath, git(cwd, ["diff", "--binary"]));
    // The untracked set has to travel as BYTES. Digesting a `git status` listing would record that
    // the files exist without recording what is in them.
    const untrackedPath = join(staging, "repo.untracked.tar");
    const names = git(cwd, ["ls-files", "--others", "--exclude-standard", "-z"])
      .toString("utf8").split("\0").filter(Boolean)
      // Drop the control directory and everything under it: see UNTRACKED_SELECTION.
      .filter((name) => name !== CONTROL_DIR.slice(0, -1) && !name.startsWith(CONTROL_DIR));
    const namesFile = join(staging, "untracked.list");
    writeFileSync(namesFile, names.length ? `${names.join("\0")}\0` : "");
    execFileSync("tar", ["--null", "--files-from", namesFile, "-cf", untrackedPath], { cwd, maxBuffer: 1024 * 1024 * 1024 });

    const bundle = writer.captureFile("repo.bundle", "bundle", bundlePath);
    const indexDiff = writer.captureFile("repo.index.diff", "index-diff", indexDiffPath);
    const worktreeDiff = writer.captureFile("repo.worktree.diff", "worktree-diff", worktreeDiffPath);
    const untracked = writer.captureFile("repo.untracked.tar", "untracked", untrackedPath);

    const continuity = sessionContinuityClass(request.connector ?? {});
    const pointer: SeatCheckpointFile | undefined = request.sessionStatePath
      ? writer.captureFile("session-pointer.json", "session-pointer", request.sessionStatePath)
      : undefined;
    const store = (request.sessionStorePaths ?? []).map((path, index) =>
      writer.captureFile(`session-store.${index}`, "session-store", path));
    const session: SeatCheckpointSession = {
      continuity,
      ...(request.sessionId ? { sessionId: request.sessionId } : {}),
      ...(pointer ? { pointer } : {}),
      store,
    };

    return writer.seal<Entry>({
      entry,
      space: request.space,
      name: request.name,
      lifecycleUid: request.lifecycleUid,
      generation: request.generation,
      capturedAt: new Date().toISOString(),
      recencyHorizonMs: request.recencyHorizonMs ?? DEFAULT_RECENCY_HORIZON_MS,
      profile: request.profile,
      repository: { base, untrackedSelection: UNTRACKED_SELECTION, bundle, indexDiff, worktreeDiff, untracked },
      session,
    });
  } catch (error) {
    writer.cleanup();
    throw error;
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}
