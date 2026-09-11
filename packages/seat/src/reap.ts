import { existsSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { dirname } from "node:path";
import { processStartToken, readBootId, readRecord, recordPath, type SeatRecord } from "./record.js";
import { unsupportedTransport } from "./protocol.js";

/** What a reap proved. `absent`: no custody record exists for that seat id, so there is no process
 *  this package can address. `reaped`: every process the record names was either signalled and
 *  verified gone, or found already gone (its pid absent or held by a process with a different start
 *  identity, which is proof the recorded one exited). */
export type SeatReapEvidence =
  | { outcome: "absent" }
  | { outcome: "reaped"; custodian: "signalled" | "gone"; child: "signalled" | "gone"; group: number; detail: string };

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
  if (pid === 1 || pid === -1) throw new Error(`refusing to signal pid ${pid} (init / all-processes)`);
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

/**
 * Reap one custodied seat that this process did not spawn: a crashed manager's, or a seat whose
 * custodian is lingering after its child exited. Signals only a pid whose current start identity
 * matches the record, verifies the custodian, the child and the child's whole process group gone,
 * then removes the custody record. A record written without start identities refuses: a bare pid
 * cannot be told from an unrelated process that inherited it. Linux only, like the custodian.
 */
export async function reapSeat(root: string, id: string, opts: { graceMs?: number } = {}): Promise<SeatReapEvidence> {
  if (process.platform !== "linux") throw unsupportedTransport();
  const graceMs = opts.graceMs ?? 10_000;
  const path = recordPath(root, id);
  let rec: SeatRecord;
  try {
    rec = readRecord(path);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return { outcome: "absent" };
    throw new Error(`seat ${id} record at ${path} is unreadable: ${(e as Error).message}`);
  }
  if (rec.custodianPid <= 1 || rec.childPid <= 1)
    throw new Error(`seat ${id} record names pid ${rec.custodianPid}/${rec.childPid}; refusing to signal pid <= 1`);
  if (rec.custodianStart === undefined)
    throw new Error(`seat ${id} record carries no process start identity; refusing to signal pid ${rec.custodianPid}/${rec.childPid} (a bare pid may belong to an unrelated process)`);
  // A record with a boot id from a different kernel boot cannot be reused: pid + starttime pairs
  // reset across reboots, so the identity match would be coincidental. Refuse rather than signal.
  if (rec.bootId !== undefined) {
    const currentBoot = readBootId();
    if (currentBoot !== undefined && currentBoot !== rec.bootId)
      throw new Error(`seat ${id} was recorded under boot id ${rec.bootId} but this kernel booted as ${currentBoot}; refusing to signal across reboots (pid + starttime are not durable across boots)`);
  }
  const custodianStart = rec.custodianStart;
  // A pinned record without a child identity means the child was gone before custody began.
  const childLive = (): boolean => rec.childStart !== undefined && identityVerdict(rec.childPid, rec.childStart) === "live";

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
  if (identityVerdict(rec.custodianPid, custodianStart) === "live") custodian = signal(rec.custodianPid, "SIGKILL");

  const gone = (): boolean => !childLive() && identityVerdict(rec.custodianPid, custodianStart) === "gone";
  if (!(await until(gone, graceMs)))
    throw new Error(`seat ${id}: custodian ${rec.custodianPid} or child ${rec.childPid} still holds its recorded start identity ${graceMs}ms after SIGKILL; exit not proved`);
  // The group after the leader: a member that re-parented to init keeps the pgid, and the pgid
  // cannot be reused while any member lives, so an empty group is proof for the descendants.
  let group = 0;
  if (groupKilled) {
    const empty = await until(() => {
      const members = groupMembers(rec.childPid);
      group = members.length;
      if (members.length) for (const pid of members) signal(pid, "SIGKILL");
      return members.length === 0;
    }, graceMs);
    if (!empty) throw new Error(`seat ${id}: ${group} process(es) still in group ${rec.childPid} ${graceMs}ms after SIGKILL; exit not proved`);
  }
  const dir = dirname(path);
  if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  return {
    outcome: "reaped",
    custodian,
    child,
    group,
    detail: `custodian ${rec.custodianPid} ${custodian}, child ${rec.childPid} ${child}${groupKilled ? `, group ${rec.childPid} empty` : ""}; custody record removed`,
  };
}
