import { spawn, spawnSync } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { assertSeatId, capabilityToken, recordPath, seatId, socketPath, type SeatRecord, readRecord } from "./record.js";
import { unattendedMs, assertSocketPathFits, unsupportedTransport } from "./protocol.js";

export interface SeatLaunchSpec {
  command: string;
  args: string[];
  env?: Record<string, string>;
  confirm?: string;
}

export interface LaunchSeatOpts {
  root: string;
  name: string;
  spec: SeatLaunchSpec;
  cwd: string;
  /** A custody id the caller minted BEFORE this launch, so a durable record of the seat can exist
   *  before its processes do. Omitted mints one here, as before. It names a directory under
   *  `root`, so it must carry the seat-id shape and must not already hold a record. */
  id?: string;
}

function packageRoot(): string {
  return dirname(dirname(fileURLToPath(import.meta.url)));
}

/** Always the compiled entry. tsx loading `src/` must not spawn a missing `src/custodian.js`. */
function custodianEntry(): string {
  const path = join(packageRoot(), "dist", "custodian.js");
  if (!existsSync(path)) throw new Error(`custodian entry missing at ${path}; build @cotal-ai/seat first`);
  return path;
}

/**
 * The RUN this launch belongs to, as an argv marker a census can read straight out of
 * `/proc/<pid>/cmdline` (#1648).
 *
 * Orphan custodians carried the worktree path only as their cwd, so finding them meant walking
 * `/proc/*\/cwd`, which needs the right uid for every pid on the box and cannot say WHICH run left
 * one behind. `COTAL_RUN` names the run when a caller sets it (a suite runner, a CI job); otherwise
 * the launching process's own pid names it, which is still enough to tell one run's orphans from
 * another's. It goes on ARGV, not only in the environment: `/proc/<pid>/cmdline` is world-readable
 * while `/proc/<pid>/environ` is readable by the owner alone, so argv is the half a census can rely
 * on. It carries no secret: the launch JSON (token, provider keys) still arrives on stdin.
 */
export const RUN_MARKER_FLAG = "--cotal-run";

/** This process's parent, from `/proc/<pid>/stat` field 4. Undefined when the pid is gone. */
function parentOf(pid: number): number | undefined {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const ppid = Number(stat.slice(stat.lastIndexOf(") ") + 2).split(" ")[1]);
    return Number.isInteger(ppid) && ppid > 1 ? ppid : undefined;
  } catch {
    return undefined;
  }
}

/**
 * `COTAL_RUN` as the nearest ancestor set it, when this process no longer has it.
 *
 * A suite that builds a child environment scrubs every `COTAL_` key, which is the correct rule for
 * connection material and takes `COTAL_RUN` with it. The run is then invisible to the launcher, the
 * marker degrades to this process's pid, and the runner's census cannot attribute the custodian to
 * the run that started it. Measured: a child spawned through that scrub reported
 * `child_saw_COTAL_RUN: null` and `claimed_by_run_census: false`.
 *
 * The environment of an ancestor still has it, because the scrub copies rather than edits the
 * parent. `/proc/<pid>/environ` is readable by its owner, and every process in this chain belongs to
 * the same uid, so a short walk recovers the run without weakening the scrub or asking every suite
 * to remember an exception. Bounded to 16 hops so a pathological chain cannot spin, and it stops at
 * pid 1, which owns no run.
 */
function inheritedRun(startPid: number): string | undefined {
  let pid = parentOf(startPid);
  for (let hop = 0; hop < 16 && pid !== undefined; hop++) {
    try {
      const entry = readFileSync(`/proc/${pid}/environ`, "utf8")
        .split("\0")
        .find((s) => s.startsWith("COTAL_RUN="));
      const value = entry?.slice("COTAL_RUN=".length).trim();
      if (value) return value;
    } catch {
      // Not ours to read, or it exited mid-walk. Keep climbing: a readable ancestor may be further up.
    }
    pid = parentOf(pid);
  }
  return undefined;
}

export function runMarker(env: NodeJS.ProcessEnv = process.env, pid: number = process.pid): string {
  const named = env.COTAL_RUN?.trim() ?? (env === process.env ? inheritedRun(pid) : undefined);
  // Newlines and spaces would split one marker into two argv-looking tokens in a census.
  return named ? named.replace(/\s+/g, "_") : `pid-${pid}`;
}

/** The run marker carried by a live custodian, read back from its argv. Undefined when that pid is
 *  not a custodian started with one. This is the read side of {@link runMarker}: the census a
 *  reaper takes is this call over the pids it is considering. */
export function runMarkerOf(pid: number): string | undefined {
  let cmdline: string;
  try {
    cmdline = readFileSync(`/proc/${pid}/cmdline`, "utf8");
  } catch {
    return undefined;
  }
  const argv = cmdline.split("\0").filter((s) => s.length > 0);
  const at = argv.indexOf(RUN_MARKER_FLAG);
  if (at < 0) return undefined;
  return argv[at + 1];
}

function pidLive(pid: number | undefined): boolean {
  if (typeof pid !== "number" || pid <= 0) return false;
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const state = stat.slice(stat.lastIndexOf(") ") + 2).split(" ")[0];
    return state !== "Z";
  } catch {
    return false;
  }
}

export function launchSeat(opts: LaunchSeatOpts): SeatRecord {
  if (process.platform !== "linux") throw unsupportedTransport();
  mkdirSync(opts.root, { recursive: true, mode: 0o700 });
  const id = assertSeatId(opts.id ?? seatId());
  const token = capabilityToken();
  const socket = assertSocketPathFits(socketPath(opts.root, id));
  const recPath = recordPath(opts.root, id);
  // A reserved id is spawned once. Reusing one would launch a second custodian over a live seat's
  // record, and the reference the manager already recorded would then address the wrong processes.
  if (existsSync(recPath)) throw new Error(`seat ${id} already holds a custody record at ${recPath}; a custody id is used for one launch`);
  mkdirSync(dirname(recPath), { recursive: true, mode: 0o700 });
  const logPath = join(dirname(recPath), "custodian.log");
  const run = runMarker();
  const payload = JSON.stringify({
    id,
    name: opts.name,
    command: opts.spec.command,
    args: opts.spec.args,
    env: opts.spec.env ?? {},
    cwd: opts.cwd,
    socket,
    token,
    recordPath: recPath,
    logPath,
    confirm: opts.spec.confirm,
    run,
    // Resolved HERE, not in the custodian: the custodian's environment is scrubbed to `PATH` plus the
    // run marker, so it cannot read an override the caller set.
    unattendedMs: unattendedMs(),
  });
  // Payload carries spec.env (provider keys) and the capability token.
  // argv is world-readable via /proc/<pid>/cmdline (0444). Inherit a 0600
  // file as stdin so the JSON never appears on argv.
  //
  // The run marker is the one thing deliberately ON argv, because that is the point of it: a census
  // must be able to attribute an orphan without the uid needed to read `/proc/<pid>/cwd`. It names a
  // run, never a credential.
  const launchPath = join(dirname(recPath), "launch.json");
  writeFileSync(launchPath, payload, { mode: 0o600 });
  const launchFd = openSync(launchPath, "r");
  const child = spawn(process.execPath, [custodianEntry(), RUN_MARKER_FLAG, run], {
    detached: true,
    stdio: [launchFd, "ignore", "ignore"],
    // COTAL_RUN is re-exported so a custodian's own descendants stay attributable to the same run,
    // and so `/proc/<pid>/environ` answers the same question argv does for a reader who can read it.
    env: { PATH: process.env.PATH ?? "", COTAL_RUN: run },
  });
  closeSync(launchFd);
  try {
    unlinkSync(launchPath);
  } catch {
    /* child still holds the fd */
  }
  child.unref();
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try {
      const rec = readRecord(recPath);
      if (rec.custodianPid > 0 && rec.childPid > 0) {
        return rec;
      }
    } catch {
      /* record not written yet */
    }
    if (!pidLive(child.pid)) {
      let err = "";
      try {
        err = readFileSync(logPath, "utf8").trim();
      } catch {
        /* no log */
      }
      throw new Error(`custodian exited before ready: ${err || `pid ${String(child.pid)} gone`}`);
    }
    spawnSync("sleep", ["0.025"], { stdio: "ignore" });
  }
  throw new Error(`custodian did not write a seat record at ${recPath}`);
}

export function loadSeat(root: string, id: string): SeatRecord {
  return readRecord(recordPath(root, id));
}

export function readSeatFile(path: string): SeatRecord {
  return JSON.parse(readFileSync(path, "utf8")) as SeatRecord;
}
