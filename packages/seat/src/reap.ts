import { existsSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { dirname } from "node:path";
import { discardSeatArtifacts } from "./artifacts.js";
import { bootToken, exitPath, isSeatId, processStartToken, readRecord, recordPath, type SeatRecord } from "./record.js";
import { RUN_MARKER_FLAG } from "./launcher.js";
import { unsupportedTransport, type SeatExit } from "./protocol.js";

/** What a reap proved. `absent`: no custody record exists for that seat id, so there is no process
 *  this package can address. `reaped`: every process the record names was either signalled and
 *  verified gone, or found already gone (its pid absent, held by a process with a different start
 *  identity, or recorded on an earlier boot, each of which is proof the recorded one exited). */
export type SeatReapEvidence =
  | { outcome: "absent" }
  | { outcome: "reaped"; custodian: "signalled" | "gone"; child: "signalled" | "gone"; group: number; exit?: SeatExit; detail: string };

/** How the child ended, as its custodian recorded it; why a record that exists cannot be read; or
 *  neither when no record exists (the child was still running, or its custodian never wrote one). */
function recordedExit(file: string): { exit?: SeatExit; unreadable?: string } {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, "utf8"));
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "ENOENT" ? {} : { unreadable: (e as Error).message };
  }
  if (typeof raw !== "object" || raw === null) return { unreadable: "not a JSON object" };
  const { code, signal, diagnostic } = raw as Record<string, unknown>;
  return {
    exit: {
      ...(Number.isInteger(code) ? { code: code as number } : {}),
      ...(Number.isInteger(signal) ? { signal: signal as number } : {}),
      ...(typeof diagnostic === "string" ? { diagnostic } : {}),
    },
  };
}

/** A pid's standing against a recorded start identity. `live` only when the process exists AND
 *  carries the recorded start token; a different token means the pid was reused by an unrelated
 *  process, which is never signalled. */
export function identityVerdict(pid: number, start: string): "live" | "gone" {
  const now = processStartToken(pid);
  return now !== undefined && now === start ? "live" : "gone";
}

function processGroupOf(pid: number): number | undefined {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const after = stat.lastIndexOf(") ");
    if (after < 0) return undefined;
    const pgrp = Number(stat.slice(after + 2).split(" ")[2]);
    return Number.isInteger(pgrp) ? pgrp : undefined;
  } catch {
    return undefined;
  }
}

/** Every live pid whose process group is `pgid`. Bounded by the process table; read once per poll. */
function groupMembers(pgid: number): number[] {
  const out: number[] = [];
  for (const entry of readdirSync("/proc")) {
    if (!/^\d+$/.test(entry)) continue;
    const pid = Number(entry);
    if (processGroupOf(pid) === pgid) out.push(pid);
  }
  return out;
}

function signal(pid: number, sig: NodeJS.Signals): "signalled" | "gone" {
  try {
    process.kill(pid, sig);
    return "signalled";
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ESRCH") return "gone";
    throw new Error(`cannot signal pid ${pid}: ${(e as Error).message}`);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function until(predicate: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) return false;
    await sleep(50);
  }
  return true;
}

/** One live custodian as a census sees it: its pid and the run that started it. */
export interface CustodianSighting {
  pid: number;
  run: string;
}

/**
 * Every live seat custodian on this host, with the run that started it (#1648).
 *
 * This reads `/proc/<pid>/cmdline` only, which is world-readable, so a census costs one readdir plus
 * one small read per pid and never needs the uid of the process it is looking at. That is the whole
 * reason the marker is on argv: the orphans carried their worktree only as their CWD, and
 * `/proc/<pid>/cwd` is a readlink the owner alone may follow, so a census of somebody else's
 * leftovers could not even see them.
 *
 * `run` filters to one run's custodians. Omitted, it reports every one on the host, which is what a
 * reaper sweeping before a run wants. A custodian started before this change carries no marker and
 * is not reported: it cannot be attributed, and claiming it as the caller's would be a guess.
 */
export function censusCustodians(run?: string): CustodianSighting[] {
  if (process.platform !== "linux") throw unsupportedTransport();
  const out: CustodianSighting[] = [];
  for (const entry of readdirSync("/proc")) {
    if (!/^\d+$/.test(entry)) continue;
    const pid = Number(entry);
    let cmdline: string;
    try {
      cmdline = readFileSync(`/proc/${pid}/cmdline`, "utf8");
    } catch {
      continue; // exited between the readdir and the read, or not ours to read
    }
    const argv = cmdline.split("\0").filter((s) => s.length > 0);
    // Both halves are required. The entry path alone matches any process whose argv happens to name
    // the file; the marker alone would match this package's own tests.
    if (!argv.some((a) => a.endsWith("/dist/custodian.js"))) continue;
    const at = argv.indexOf(RUN_MARKER_FLAG);
    if (at < 0) continue;
    const marker = argv[at + 1];
    if (marker === undefined) continue;
    if (run !== undefined && marker !== run) continue;
    out.push({ pid, run: marker });
  }
  return out;
}

/** Why `rec`'s pids cannot be tied to the processes it recorded, or undefined when they can. A
 *  start token counts ticks since ITS OWN boot, so it only tells two processes apart within one boot,
 *  and a record may have outlived a reboot on disk. A record with no start identity or no boot
 *  identity proves nothing about whatever holds those pid numbers now, so it is neither signalled nor
 *  reported as running or gone. */
function unprovedIdentity(id: string, rec: SeatRecord): string | undefined {
  if (rec.custodianStart === undefined)
    return `seat ${id} record carries no process start identity; refusing to signal pid ${rec.custodianPid}/${rec.childPid} (a bare pid may belong to an unrelated process)`;
  if (rec.bootId === undefined)
    return `seat ${id} record carries no boot identity; refusing to signal pid ${rec.custodianPid}/${rec.childPid} (its start tokens cannot be compared across a reboot)`;
  return undefined;
}

/** Whether `rec` was written on an earlier boot. No process outlives a reboot, so every process it
 *  names is gone, and whatever holds those pid numbers now is one of this boot's and is never signalled. */
function fromEarlierBoot(rec: SeatRecord): boolean {
  const boot = bootToken();
  return boot !== undefined && rec.bootId !== boot;
}

/**
 * Reap one custodied seat: a crashed manager's orphan, a lingering custodian, or a cleanly exited seat
 * whose custodian unlinked its on-disk record.
 *
 * When the record exists on disk, it is verified against the live kernel state. When the on-disk record
 * is absent, `opts.pinnedRecord` allows the launching/adopting runtime to supply its authoritative pinned
 * start identities to execute the same kernel identity and group checks. An unknown reference with neither
 * on-disk file nor pinned record returns `absent` (failing closed as RuntimeReapUnproven).
 *
 * Signals the custodian and the child only while their current start identity matches the record. The
 * child's descendants are not in the record, so its process group is signalled by pgid and then swept by
 * membership alone, and the record's contents are trusted as written; docs/security.md lists both as
 * accepted residuals. Verifies the custodian, the child and the child's whole process group gone, then
 * removes the custody record directory.
 */
export async function reapSeat(root: string, id: string, opts: { graceMs?: number; pinnedRecord?: SeatRecord } = {}): Promise<SeatReapEvidence> {
  if (process.platform !== "linux") throw unsupportedTransport();
  const graceMs = opts.graceMs ?? 10_000;
  const path = recordPath(root, id);
  let rec: SeatRecord;
  try {
    rec = readRecord(path);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") {
      if (opts.pinnedRecord && opts.pinnedRecord.id === id) {
        rec = opts.pinnedRecord;
      } else {
        return { outcome: "absent" };
      }
    } else {
      throw new Error(`seat ${id} record at ${path} is unreadable: ${(e as Error).message}`);
    }
  }
  const unproved = unprovedIdentity(id, rec);
  if (unproved !== undefined) throw new Error(unproved);
  const custodianStart = rec.custodianStart!;
  const earlierBoot = fromEarlierBoot(rec);
  // Read before anything is signalled, so a SIGKILL sent below is never reported as how the child ended.
  const recorded = recordedExit(exitPath(path));
  const exit = recorded.exit;
  // A pinned record without a child identity means the child was gone before custody began.
  const childLive = (): boolean => !earlierBoot && rec.childStart !== undefined && identityVerdict(rec.childPid, rec.childStart) === "live";
  const custodianLive = (): boolean => !earlierBoot && identityVerdict(rec.custodianPid, custodianStart) === "live";

  // The child first: node-pty made it a session and process-group leader, so signalling the group
  // takes its descendants (a connector host's TUI and bridges) with it. A child that is no longer a
  // group leader is signalled alone and its group is not claimed.
  let child: "signalled" | "gone" = "gone";
  let groupKilled = false;
  if (childLive()) {
    const leader = processGroupOf(rec.childPid) === rec.childPid;
    child = leader ? signal(-rec.childPid, "SIGKILL") : signal(rec.childPid, "SIGKILL");
    groupKilled = leader && child === "signalled";
  }
  let custodian: "signalled" | "gone" = "gone";
  if (custodianLive()) custodian = signal(rec.custodianPid, "SIGKILL");

  const gone = (): boolean => !childLive() && !custodianLive();
  if (!(await until(gone, graceMs)))
    throw new Error(`seat ${id}: custodian ${rec.custodianPid} or child ${rec.childPid} still holds its recorded start identity ${graceMs}ms after SIGKILL; exit not proved`);
  // The group after the leader: a member that re-parented to init keeps the pgid, and the pgid
  // cannot be reused while any member lives, so an empty group is proof for the descendants.
  // A retained record may outlive its original group and numeric PGID. Without a live leader
  // identity, remaining members might belong to a later generation, so retain unproved custody.
  let group = 0;
  if (!earlierBoot && !groupKilled && processStartToken(rec.childPid) === undefined && groupMembers(rec.childPid).length > 0)
    throw new Error(`seat ${id}: group ownership is unproved for absent leader ${rec.childPid}; custody retained`);
  if (groupKilled) {
    const empty = await until(() => {
      const members = groupMembers(rec.childPid);
      group = members.length;
      if (members.length) for (const pid of members) signal(pid, "SIGKILL");
      return members.length === 0;
    }, graceMs);
    if (!empty) throw new Error(`seat ${id}: ${group} process(es) still in group ${rec.childPid} ${graceMs}ms after SIGKILL; exit not proved`);
  }
  // The launch artifacts the record still lists, read again now that the custodian is proved gone and
  // can no longer change it: ones it had not removed when it died, or could not remove. Never the
  // pinned copy, which still lists what the custodian has since removed, so its names may have been
  // reused. A failed removal keeps the record, so a later reap of this reference tries again.
  let latest: SeatRecord | undefined;
  try {
    latest = readRecord(path);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT")
      throw new Error(`seat ${id}: exit proved, but its record at ${path} is unreadable: ${(e as Error).message}; custody record kept`);
  }
  try {
    discardSeatArtifacts(latest?.artifacts, latest?.artifactRoot);
  } catch (e) {
    throw new Error(`seat ${id}: exit proved, but ${(e as Error).message}; custody record kept so a later reap retries`);
  }
  const hadPath = existsSync(path);
  const dir = dirname(path);
  if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  // A child already gone when the reap began ended on its own, and its custodian's record is the
  // only account of how, so a missing or unreadable one is said rather than left out.
  const ended = exit
    ? `; its custodian recorded exit code ${exit.code ?? "unknown"}${exit.signal === undefined ? "" : `, signal ${exit.signal}`}${exit.diagnostic ? `, last connector diagnostic: ${exit.diagnostic}` : ""}`
    : recorded.unreadable !== undefined
      ? `; its custodian's exit record is unreadable: ${recorded.unreadable}`
      : child === "gone"
        ? "; no exit record from its custodian was found"
        : "";
  return {
    outcome: "reaped",
    custodian,
    child,
    group,
    ...(exit ? { exit } : {}),
    detail: `custodian ${rec.custodianPid} ${custodian}, child ${rec.childPid} ${child}${earlierBoot ? ` with boot ${rec.bootId}` : ""}${groupKilled || group > 0 ? `, group ${rec.childPid} empty` : ""}; custody record ${hadPath ? "removed" : "verified gone"}${ended}`,
  };
}

/** One custody record as {@link drainSeats} found it. `live-child`: the child still holds its
 *  recorded start identity, so the seat is a running agent and is never signalled. `childless`: the
 *  child is gone, so a drain would retire the seat. `drained`: a drain proved the seat gone and
 *  removed its record. `refused`: the record could not be read, carries no start or boot identity,
 *  or the reap did not prove exit; the record stays on disk. */
export interface SeatInventoryEntry {
  id: string;
  state: "live-child" | "childless" | "drained" | "refused";
  name?: string;
  custodianPid?: number;
  childPid?: number;
  detail: string;
}

/**
 * List the custody records under `root`, and with `drain` retire every seat whose child is gone
 * (#1391).
 *
 * A seat whose child still holds its recorded start identity is reported and left alone: it is a
 * running agent, and a manager may still adopt it. Only a seat whose child is proved gone reaches
 * {@link reapSeat}. A record is written once, and a start identity that is gone never comes back, so
 * the reap that follows finds the child gone too and signals at most a custodian whose identity
 * matches the record. A record from an earlier boot names processes that ended with that boot, so it
 * is childless and its reap signals nothing. A record that cannot be read or whose identity proves
 * nothing, or a reap that does not prove exit, is refused and left on disk for the operator.
 */
export async function drainSeats(root: string, opts: { drain?: boolean; graceMs?: number } = {}): Promise<SeatInventoryEntry[]> {
  if (process.platform !== "linux") throw unsupportedTransport();
  let ids: string[];
  try {
    ids = readdirSync(root).filter(isSeatId).sort();
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw e;
  }
  const out: SeatInventoryEntry[] = [];
  for (const id of ids) {
    let rec: SeatRecord;
    try {
      rec = readRecord(recordPath(root, id));
    } catch (e) {
      out.push({ id, state: "refused", detail: `record unreadable: ${(e as Error).message}` });
      continue;
    }
    const seen = { id, name: rec.name, custodianPid: rec.custodianPid, childPid: rec.childPid };
    const unproved = unprovedIdentity(id, rec);
    if (unproved !== undefined) {
      out.push({ ...seen, state: "refused", detail: unproved });
      continue;
    }
    const earlierBoot = fromEarlierBoot(rec);
    if (!earlierBoot && rec.childStart !== undefined && identityVerdict(rec.childPid, rec.childStart) === "live") {
      out.push({ ...seen, state: "live-child", detail: `child ${rec.childPid} is running; kept` });
      continue;
    }
    if (!opts.drain) {
      const custodian = !earlierBoot && rec.custodianStart !== undefined && identityVerdict(rec.custodianPid, rec.custodianStart) === "live" ? "running" : "gone";
      out.push({ ...seen, state: "childless", detail: `child ${rec.childPid} is gone; custodian ${rec.custodianPid} ${custodian}${earlierBoot ? ` with boot ${rec.bootId}` : ""}` });
      continue;
    }
    try {
      const evidence = await reapSeat(root, id, opts.graceMs === undefined ? {} : { graceMs: opts.graceMs });
      out.push(
        evidence.outcome === "reaped"
          ? { ...seen, state: "drained", detail: evidence.detail }
          : { ...seen, state: "refused", detail: "record vanished before the reap; nothing was signalled" },
      );
    } catch (e) {
      out.push({ ...seen, state: "refused", detail: (e as Error).message });
    }
  }
  return out;
}
