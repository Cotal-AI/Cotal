import { spawn, spawnSync } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { capabilityToken, recordPath, seatId, socketPath, type SeatRecord, readRecord } from "./record.js";
import { unsupportedTransport } from "./protocol.js";

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

const SEAT_ID = /^[0-9a-f]{32}$/;

function packageRoot(): string {
  return dirname(dirname(fileURLToPath(import.meta.url)));
}

/** Always the compiled entry. tsx loading `src/` must not spawn a missing `src/custodian.js`. */
function custodianEntry(): string {
  const path = join(packageRoot(), "dist", "custodian.js");
  if (!existsSync(path)) throw new Error(`custodian entry missing at ${path}; build @cotal-ai/seat first`);
  return path;
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
  const id = opts.id ?? seatId();
  if (!SEAT_ID.test(id))
    throw new Error(`seat custody id ${JSON.stringify(id)} is not 32 lowercase hex characters; it names a directory under ${opts.root}`);
  const token = capabilityToken();
  const socket = socketPath(opts.root, id);
  const recPath = recordPath(opts.root, id);
  // A reserved id is spawned once. Reusing one would launch a second custodian over a live seat's
  // record, and the reference the manager already recorded would then address the wrong processes.
  if (existsSync(recPath)) throw new Error(`seat ${id} already holds a custody record at ${recPath}; a custody id is used for one launch`);
  mkdirSync(dirname(recPath), { recursive: true, mode: 0o700 });
  const logPath = join(dirname(recPath), "custodian.log");
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
  });
  // Payload carries spec.env (provider keys) and the capability token.
  // argv is world-readable via /proc/<pid>/cmdline (0444). Inherit a 0600
  // file as stdin so the JSON never appears on argv.
  const launchPath = join(dirname(recPath), "launch.json");
  writeFileSync(launchPath, payload, { mode: 0o600 });
  const launchFd = openSync(launchPath, "r");
  const child = spawn(process.execPath, [custodianEntry()], {
    detached: true,
    stdio: [launchFd, "ignore", "ignore"],
    env: { PATH: process.env.PATH ?? "" },
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
