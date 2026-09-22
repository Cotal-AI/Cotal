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
import { mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { sessionContinuityClass, type Connector, type SessionContinuityClass } from "@cotal-ai/core";
import {
  createSeatCheckpointWriter,
  type SeatCheckpoint,
  type SeatCheckpointDestination,
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
  /** The workspace root this cut was taken in. A pointer under it travels anchored on the
   *  DESTINATION's root, which is the only spelling that survives a different host. */
  readonly workspaceRoot?: string;
  /** The harness transcript store, an operator input: this repository names the pointer file and
   *  not the store, and a default written here would be a guess presented as a fact. */
  readonly sessionStorePaths?: readonly string[];
}

/**
 * Where one captured session file lands on the destination.
 *
 * Anchored, never absolute: the destination has its own workspace root, its own account home and
 * its own seat working tree, and the source host's spelling for any of them is a path the
 * destination may not have or may not own. The anchors are tried innermost first, so a file inside
 * the seat's tree travels with the tree rather than with the root it happens to sit under.
 * A file under none of them has no destination-relative spelling and the cut refuses, rather than
 * recording an absolute path a restore would write blind.
 */
function restoreDestination(path: string, what: string, cwd: string, workspaceRoot?: string): SeatCheckpointDestination {
  const target = resolve(path);
  const anchors: Array<[SeatCheckpointDestination["anchor"], string | undefined]> = [
    ["cwd", cwd],
    ["workspace-root", workspaceRoot],
    ["home", homedir()],
  ];
  for (const [anchor, base] of anchors) {
    if (!base) continue;
    const rel = relative(resolve(base), target);
    if (rel && !rel.startsWith("..") && !rel.startsWith(sep) && rel !== ".")
      return { anchor, path: rel.split(sep).join("/") };
  }
  throw new Error(`seat checkpoint: ${what} ${target} is under neither the seat's working tree, the workspace root, nor this account's home, so no destination-relative path can be recorded for it`);
}

/** Every regular file under one operator-named store path, relative to that path. A store is a
 *  directory of opaque harness bytes; nothing here parses one. */
function storeFiles(path: string): string[] {
  const root = resolve(path);
  const found: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) found.push(full);
      else throw new Error(`seat checkpoint: session store entry ${full} is neither a regular file nor a directory`);
    }
  };
  if (!statSync(root).isDirectory())
    throw new Error(`seat checkpoint: session store ${root} is not a directory`);
  walk(root);
  return found;
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
    // The status a destination compares its promoted tree against, read under the same selection
    // rule the untracked set was produced under. `git status --porcelain` reports the control
    // directory the capture deliberately excludes, so a raw reading would describe a tree these
    // bytes cannot reproduce and every restore would refuse.
    const status = git(cwd, ["status", "--porcelain"]).toString("utf8")
      .split("\n").filter(Boolean)
      .filter((line) => !(line.startsWith("?? ") && (line.slice(3) === CONTROL_DIR || line.slice(3).startsWith(CONTROL_DIR))))
      .map((line) => `${line}\n`).join("");

    const bundle = writer.captureFile("repo.bundle", "bundle", bundlePath);
    const indexDiff = writer.captureFile("repo.index.diff", "index-diff", indexDiffPath);
    const worktreeDiff = writer.captureFile("repo.worktree.diff", "worktree-diff", worktreeDiffPath);
    const untracked = writer.captureFile("repo.untracked.tar", "untracked", untrackedPath);

    const untrackedSet = new Set(names);
    // A store file the untracked archive already carries would be captured twice and restored
    // twice, and the second placement would land on a file the extraction just wrote. Refuse at
    // the cut rather than produce an artifact whose own restore cannot complete.
    const destinationFor = (path: string, what: string): SeatCheckpointDestination => {
      const destination = restoreDestination(path, what, cwd, request.workspaceRoot);
      if (destination.anchor === "cwd" && untrackedSet.has(destination.path))
        throw new Error(`seat checkpoint: ${what} ${resolve(path)} is already carried by the untracked capture of ${cwd}; name a store outside the seat's working tree`);
      return destination;
    };
    const pointer: SeatCheckpointFile | undefined = request.sessionStatePath
      ? writer.captureFile("session-pointer.json", "session-pointer", request.sessionStatePath,
          destinationFor(request.sessionStatePath, "the connector session pointer"))
      : undefined;
    // Each operator-named store path is a directory of opaque harness bytes, captured file by file
    // so every one travels by size and digest like everything else in the record.
    const store: SeatCheckpointFile[] = [];
    for (const path of request.sessionStorePaths ?? []) {
      for (const file of storeFiles(path)) {
        store.push(writer.captureFile(`session-store.${store.length}`, "session-store", file,
          destinationFor(file, "a session store file")));
      }
    }
    // What the connector DECLARES, capped by what this cut actually carried. A class is a promise
    // a destination is entitled to act on, and `exact` or `fork` with no pointer and no store
    // promises a session that can be reopened from bytes this checkpoint does not contain. Capping
    // here keeps the promise answerable to the artifact rather than to the declaration.
    const declared = sessionContinuityClass(request.connector ?? {});
    const carriesSession = pointer !== undefined || store.length > 0;
    const continuity: SessionContinuityClass =
      !carriesSession && (declared === "exact" || declared === "fork")
        ? (request.connector?.supportsFreshStart ? "fresh" : "drain-only")
        : declared;
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
      repository: { base, untrackedSelection: UNTRACKED_SELECTION, status, bundle, indexDiff, worktreeDiff, untracked },
      session,
    });
  } catch (error) {
    writer.cleanup();
    throw error;
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}
