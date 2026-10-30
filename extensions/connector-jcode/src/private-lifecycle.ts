import { randomBytes } from "node:crypto";
import { readFileSync, readdirSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { writePrivateRecord, writeSecretFileAtomic } from "@cotal-ai/core";

/** Exact teardown of one seat's private Jcode process tree (#839).
 *
 * Registry PIDs are untrusted mutable input even inside the private home: a stale/reused file can
 * name another live process. Give every process this launch creates a random identity, capture each
 * PID's immutable process-start token, and signal only when both still match. A PID whose ownership
 * cannot be proved is skipped, never signalled.
 */

const isPid = (value: unknown): value is number => Number.isInteger(value) && (value as number) > 1;
const LAUNCH_IDENTITY_ENV = "JCODE_COTAL_LAUNCH_IDENTITY";

export interface ProcessIdentity {
  pid: number;
  start: string;
}

interface ProcessStat extends ProcessIdentity {
  parentPid: number;
  /** The process group, which the process table shows for any process, readable environment or not. */
  group: number;
}

function processStat(pid: number): ProcessStat | undefined {
  try {
    if (process.platform === "linux") {
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      const after = stat.lastIndexOf(") ");
      if (after < 0) return undefined;
      const fields = stat.slice(after + 2).trim().split(/\s+/u);
      const parentPid = Number(fields[1]);
      const group = Number(fields[2]);
      const start = fields[19];
      return Number.isInteger(parentPid) && parentPid >= 0 && Number.isInteger(group) && group >= 0 && start ? { pid, parentPid, group, start } : undefined;
    }
    if (process.platform === "darwin" || process.platform.endsWith("bsd")) {
      const out = execFileSync("/bin/ps", ["-o", "ppid=", "-o", "pgid=", "-o", "lstart=", "-p", String(pid)], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim();
      const match = out.match(/^(\d+)\s+(\d+)\s+(.+)$/u);
      const parentPid = Number(match?.[1]);
      const group = Number(match?.[2]);
      const start = match?.[3]?.trim();
      return Number.isInteger(parentPid) && parentPid >= 0 && Number.isInteger(group) && group >= 0 && start ? { pid, parentPid, group, start } : undefined;
    }
  } catch {
    return undefined;
  }
  return undefined;
}

export function launchIdentityEnv(): { key: string; value: string } {
  return { key: LAUNCH_IDENTITY_ENV, value: randomBytes(24).toString("base64url") };
}

/** Immutable identity of one process at capture time; throws when the platform cannot prove it. */
export function captureProcessIdentity(pid: number): ProcessIdentity {
  if (!isPid(pid)) throw new Error(`jcode connector: cannot capture invalid launch PID ${pid}`);
  const stat = processStat(pid);
  if (!stat)
    throw new Error(`jcode connector: cannot capture immutable identity for launch PID ${pid} on ${process.platform} — refusing unsafe lifecycle tracking`);
  return { pid, start: stat.start };
}

function processMatches(identity: ProcessIdentity): boolean {
  const stat = processStat(identity.pid);
  return stat !== undefined && stat.start === identity.start;
}

function processPids(): number[] {
  try {
    if (process.platform === "linux")
      return readdirSync("/proc").map(Number).filter(isPid);
    if (process.platform === "darwin" || process.platform.endsWith("bsd"))
      return execFileSync("/bin/ps", ["-axo", "pid="], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] })
        .trim().split(/\s+/u).map(Number).filter(isPid);
  } catch (error) {
    throw new Error(`jcode connector: cannot enumerate launch descendants on ${process.platform}: ${(error as Error).message}`);
  }
  throw new Error(`jcode connector: cannot prove Jcode process ownership on unsupported platform ${process.platform}`);
}

export interface ProcessIdentityProbe {
  readEnviron: (pid: number) => string;
  ps: (pid: number) => string;
  pidExists: (pid: number) => boolean;
}

const processIdentityProbe: ProcessIdentityProbe = {
  readEnviron: (pid) => readFileSync(`/proc/${pid}/environ`, "utf8"),
  ps: (pid) => execFileSync("/bin/ps", ["eww", "-p", String(pid), "-o", "command="], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  }),
  pidExists: (pid) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ESRCH") return false;
      if (code === "EPERM") return true;
      throw error;
    }
  },
};

function processHasLaunchIdentityFromPs(
  pid: number,
  identityValue: string,
  probe: Pick<ProcessIdentityProbe, "ps" | "pidExists">,
): boolean {
  try {
    const out = probe.ps(pid);
    return out.includes(`${LAUNCH_IDENTITY_ENV}=${identityValue}`);
  } catch (error) {
    // processPids() and this probe are necessarily separate snapshots. On macOS/BSD, ps reports a
    // PID that exited between them with status 1 rather than an ESRCH code on the thrown error.
    // Only an independent ESRCH re-probe proves that race; operational ps failures stay loud.
    const status = (error as { status?: unknown }).status;
    if (status === 1 && !probe.pidExists(pid)) return false;
    throw error;
  }
}

/** Whether `pid` carries this launch's identity, or `undefined` when the kernel cannot answer.
 *
 * A process releases the mm backing /proc/<pid>/environ as it exits, before it becomes the zombie
 * that `alive` reads as dead. In that window the environ read fails or returns empty while
 * /proc/<pid>/stat still reports a live state and the same start token. Reporting that as a missing
 * identity would convict a bridge that is merely dying, so it is answered as unprovable. */
function launchIdentityProof(pid: number, identityValue: string, probe: ProcessIdentityProbe): boolean | undefined {
  if (process.platform === "linux") {
    let environ: string;
    try {
      environ = probe.readEnviron(pid);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT" || code === "ESRCH" || code === "EACCES" || code === "EPERM") return undefined;
      throw error;
    }
    // An exec fixes the environ block for the life of the process, so a non-empty read against an
    // unchanged start token is authoritative; only an empty one means the mm is already gone.
    if (environ.length === 0) return undefined;
    return environ.split("\0").includes(`${LAUNCH_IDENTITY_ENV}=${identityValue}`);
  }
  if (process.platform === "darwin" || process.platform.endsWith("bsd"))
    return processHasLaunchIdentityFromPs(pid, identityValue, probe);
  throw new Error(`jcode connector: launch-bound process identity is unavailable on ${process.platform}`);
}

export const processHasLaunchIdentityForTest = (
  pid: number,
  identityValue: string,
  probe: Pick<ProcessIdentityProbe, "ps" | "pidExists">,
): boolean => processHasLaunchIdentityFromPs(pid, identityValue, probe);

function captureLaunchProcesses(identityValue: string, probe: ProcessIdentityProbe = processIdentityProbe): ProcessIdentity[] {
  const owned: ProcessIdentity[] = [];
  for (const pid of processPids()) {
    try {
      if (launchIdentityProof(pid, identityValue, probe) !== true) continue;
      const stat = processStat(pid);
      if (stat) owned.push({ pid: stat.pid, start: stat.start });
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT" || code === "ESRCH" || code === "EACCES" || code === "EPERM") continue;
      throw new Error(`jcode connector: cannot prove launch-bound identity for PID ${pid}: ${(error as Error).message}`);
    }
  }
  return owned;
}

/** Every PID this seat's private home records. The caller must still prove ownership. */
export function recordedTreePids(jcodeHome: string): number[] {
  const pids = new Set<number>();
  try {
    const registry = JSON.parse(readFileSync(join(jcodeHome, "servers.json"), "utf8")) as Record<string, { pid?: unknown }>;
    for (const entry of Object.values(registry ?? {})) {
      const pid = Number(entry?.pid);
      if (isPid(pid)) pids.add(pid);
    }
  } catch {
    /* absent, or mid-write by a daemon we are about to stop — active_pids still names it */
  }
  try {
    for (const file of readdirSync(join(jcodeHome, "active_pids"))) {
      const pid = Number(readFileSync(join(jcodeHome, "active_pids", file), "utf8").trim());
      if (isPid(pid)) pids.add(pid);
    }
  } catch {
    /* no sessions recorded yet */
  }
  pids.delete(process.pid);
  return [...pids];
}

const alive = (pid: number): boolean => {
  const stat = processStat(pid);
  if (stat) {
    try {
      if (process.platform === "linux") {
        const raw = readFileSync(`/proc/${pid}/stat`, "utf8");
        const after = raw.lastIndexOf(") ");
        if (after >= 0 && raw.slice(after + 2).startsWith("Z ")) return false;
      }
    } catch {
      return false;
    }
    return true;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
};

function signalPid(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(pid, signal);
  } catch {
    /* already gone */
  }
}

function signalTree(pids: number[], signal: NodeJS.Signals): void {
  for (const pid of pids) {
    // The daemon setsids into a group of its own, taking its MCP and keep-alive children with it,
    // so the group form stays launch-exact after the ancestry proof above; the bridge is not a
    // group leader, so it refuses the group form and gets the exact PID instead.
    try {
      process.kill(-pid, signal);
    } catch {
      try {
        process.kill(pid, signal);
      } catch {
        /* already gone */
      }
    }
  }
}

async function waitGone(pids: number[], timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (!pids.some(alive)) return true;
    if (Date.now() > deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

const LAUNCH_RECORD_FILE = "cotal-launch.json";

export interface LaunchRecord {
  /** The launch-bound environment identity only this launch's Jcode descendants carry. */
  identity: string;
  /** Immutable identity of the connector host that owns those descendants. */
  host: ProcessIdentity;
}

/** Name this launch's tree in the seat home, so the seat's NEXT launch can tell a tree an already
 * dead lifecycle left behind from one a live seat still legitimately holds. */
export function recordLaunch(home: string, record: LaunchRecord): void {
  const path = join(home, LAUNCH_RECORD_FILE);
  // The private open restates 0o600 through the descriptor on every write, so one loosened file
  // does not stay loosened for the life of the seat home, and a symlink at the name is refused.
  writePrivateRecord(path, `${JSON.stringify(record)}\n`);
}

export function readLaunchRecord(home: string): LaunchRecord | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(join(home, LAUNCH_RECORD_FILE), "utf8"));
  } catch {
    return undefined;
  }
  const record = parsed as LaunchRecord | null;
  const identity = record?.identity;
  const host = record?.host;
  if (typeof identity !== "string" || !identity) return undefined;
  return isPid(host?.pid) && typeof host?.start === "string" && host.start ? { identity, host: { pid: host.pid, start: host.start } } : undefined;
}

/** A once seat's launch evidence, keyed by its lifecycle uid rather than by its name, so a same-name
 * successor's launches never overwrite it: the host that launched, and every launch identity it
 * used, a bridge relaunch included. A proof of retirement replaces it with a receipt, which stays
 * until the manager has cleared the seat's debt and discards it. */
type OnceRecord = { uid: string; host: ProcessIdentity; launches: string[] } | { uid: string; retired: true };

const LIFECYCLE_UID = /^[a-z0-9]{26,32}$/u;

function onceRecordPath(home: string, uid: string): string {
  if (!LIFECYCLE_UID.test(uid)) throw new Error(`jcode connector: "${uid}" is not a lifecycle uid`);
  return join(home, `cotal-once-${uid}.json`);
}

/** The uid's record, or `undefined` when there is none. A record that is not well formed throws. */
function readOnceRecord(home: string, uid: string): OnceRecord | undefined {
  const path = onceRecordPath(home, uid);
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  const r = JSON.parse(raw) as { uid?: unknown; retired?: unknown; host?: { pid?: unknown; start?: unknown }; launches?: unknown };
  if (r?.uid !== uid) throw new Error(`jcode connector: ${path} does not name once seat ${uid}`);
  if (r.retired === true) return { uid, retired: true };
  const launches = r.launches;
  if (!isPid(r.host?.pid) || typeof r.host?.start !== "string" || !r.host.start
    || !Array.isArray(launches) || launches.length === 0 || !launches.every((v) => typeof v === "string" && v.length > 0))
    throw new Error(`jcode connector: ${path} is not well formed`);
  return { uid, host: { pid: r.host.pid as number, start: r.host.start }, launches };
}

/** Add one native launch to a once seat's evidence, before the launch creates anything. */
export function recordOnceLaunch(home: string, uid: string, record: LaunchRecord): void {
  const prior = readOnceRecord(home, uid);
  if (prior && "retired" in prior) throw new Error(`jcode connector: once seat ${uid} was already proved retired — refusing to launch under it again`);
  if (prior && (prior.host.pid !== record.host.pid || prior.host.start !== record.host.start))
    throw new Error(`jcode connector: once seat ${uid} was launched by another host — refusing to launch under it`);
  writeSecretFileAtomic(onceRecordPath(home, uid), `${JSON.stringify({ uid, host: record.host, launches: [...(prior?.launches ?? []), record.identity] })}\n`);
}

/** The live processes a once seat's launches own: each process that carries one of the launch
 * identities, each direct child of one, and each member of a process group one of them leads. The
 * process table shows parentage and group for every process, so a child whose environment cannot be
 * read (a setuid program, or one that turned off its own dumpable flag) is still found while it
 * keeps either link. A parent or a leader counts only while its pid still has the start token this
 * scan captured. `groups` keeps each group found led, by its leader's start token, so a later scan
 * still finds the members after the leader is gone; Linux does not reuse a group's id while a member
 * lives, and a new process on that pid shows another start token. A live process whose process table
 * entry cannot be read throws. */
function onceTree(launches: readonly string[], probe: ProcessIdentityProbe, groups: Map<number, string>): ProcessIdentity[] {
  const carriers = launches.flatMap((identity) => captureLaunchProcesses(identity, probe)).filter((p) => p.pid !== process.pid);
  const parents = new Map(carriers.map((p) => [p.pid, p] as const));
  for (const p of carriers) {
    const stat = processStat(p.pid);
    if (stat?.start === p.start && stat.group === p.pid) groups.set(p.pid, p.start);
  }
  const leads = (group: number): boolean => {
    const start = groups.get(group);
    if (start === undefined) return false;
    const leader = processStat(group);
    return leader === undefined || leader.start === start;
  };
  const tree = new Map(carriers.map((p) => [p.pid, p] as const));
  for (const pid of processPids()) {
    if (pid === process.pid || tree.has(pid)) continue;
    const stat = processStat(pid);
    if (!stat) {
      if (alive(pid)) throw new Error(`jcode connector: cannot read PID ${pid}'s process table entry to rule it out of a once launch`);
      continue;
    }
    const parent = parents.get(stat.parentPid);
    if (leads(stat.group) || (parent !== undefined && processMatches(parent))) tree.set(pid, { pid, start: stat.start });
  }
  return [...tree.values()].filter((p) => processMatches(p) && alive(p.pid));
}

/** Prove that nothing a once seat's launches own still runs outside its host, stopping what they
 * own. Returns only with that proof, recorded as a receipt so a later call gives the same answer;
 * throws when there is no evidence, when the recorded host PID is alive (the host, or a process that
 * reused its PID), or when an owned process survives. Ownership is what {@link onceTree} reads, and
 * each signalled process matches its captured start token. A process whose environment cannot be
 * read and that has left both links before this runs (it forked and called setsid, as a daemon
 * does) cannot be tied to the launch, so it is neither signalled nor counted. */
export async function retireOnceTree(
  home: string,
  uid: string,
  opts: { gracefulWaitMs?: number; killWaitMs?: number; identityProbe?: ProcessIdentityProbe } = {},
): Promise<void> {
  const { gracefulWaitMs = 3_000, killWaitMs = 2_000, identityProbe = processIdentityProbe } = opts;
  const record = readOnceRecord(home, uid);
  if (!record) throw new Error(`jcode connector: once seat ${uid} has no launch evidence in ${home} — its processes cannot be proved gone`);
  if ("retired" in record) return;
  if (alive(record.host.pid))
    throw new Error(`jcode connector: once seat ${uid}'s recorded host PID ${record.host.pid} is alive — its processes cannot be proved gone`);
  const groups = new Map<number, string>();
  const targets = onceTree(record.launches, identityProbe, groups);
  // Each signal goes only to a target that still shows its captured start token.
  const live = () => targets.filter((p) => processMatches(p) && alive(p.pid));
  if (targets.length) {
    const pids = targets.map((p) => p.pid);
    signalTree(live().map((p) => p.pid), "SIGTERM");
    if (!(await waitGone(pids, gracefulWaitMs))) {
      signalTree(live().map((p) => p.pid), "SIGKILL");
      await waitGone(pids, killWaitMs);
    }
  }
  // A child found through its parent loses that link when the parent dies, so the first scan's
  // targets are checked again by their own identity.
  const left = [...new Set([...onceTree(record.launches, identityProbe, groups), ...live()].map((p) => p.pid))];
  if (left.length) throw new Error(`jcode connector: once seat ${uid}'s Jcode processes survived teardown (pids ${left.join(", ")})`);
  writeSecretFileAtomic(onceRecordPath(home, uid), `${JSON.stringify({ uid, retired: true })}\n`);
}

/** Remove a once seat's retirement receipt, after its manager cleared the debt. Live evidence is
 * never removed here. */
export function discardOnceReceipt(home: string, uid: string): void {
  const record = readOnceRecord(home, uid);
  if (!record) return;
  if (!("retired" in record)) throw new Error(`jcode connector: once seat ${uid}'s evidence is not a retirement receipt — refusing to discard it`);
  rmSync(onceRecordPath(home, uid), { force: true });
}

export interface StopOrphanedTreeOptions {
  home: string;
  gracefulWaitMs?: number;
  killWaitMs?: number;
}

/**
 * Stop the Jcode tree a previous lifecycle of this seat home left running, and return its PIDs.
 *
 * A seat that dies without its connector's teardown — a manager restart, a SIGKILL past the grace
 * window — leaves its Jcode server alive. The server setsids into a group of its own and carries no
 * `COTAL_NAME`, so neither the manager's signal nor a name-keyed reap reaches it, and it holds the
 * seat home's runtime dir until its own five-minute idle timer (#1211).
 *
 * The recorded host PID is what keeps this from stopping a seat that is still serving, and it only
 * releases the nonce once that host is provably GONE. A PID that is still alive at the recorded
 * slot is ambiguous: it is either the connector that owns this home, or an unrelated process that
 * reused the number, and nothing on a live PID distinguishes them reliably. This mechanism's whole
 * claim is that it never signals a live seat's tree, so the ambiguous case resolves toward doing
 * nothing. Pairing liveness with the captured start token instead would resolve it toward killing:
 * a live host whose recorded token does not match would have its tree signalled while the host
 * itself was left running, which is the two-seats-under-one-name failure this exists to avoid.
 *
 * The conservative branch costs one missed reap, after which Jcode's own runtime-dir lock gives its
 * honest refusal and the next launch tries again. The permissive branch costs a seat that is still
 * serving. Only a PID that is gone releases the record's launch nonce, and one nonce is inherited
 * by one launch's descendants alone.
 */
export async function stopOrphanedTree(options: StopOrphanedTreeOptions): Promise<number[]> {
  const { home, gracefulWaitMs = 3_000, killWaitMs = 2_000 } = options;
  const record = readLaunchRecord(home);
  if (!record) return [];
  if (alive(record.host.pid)) return [];
  const targets = captureLaunchProcesses(record.identity)
    .filter((identity) => identity.pid !== process.pid && processMatches(identity) && alive(identity.pid))
    .map((identity) => identity.pid);
  if (!targets.length) return [];
  signalTree(targets, "SIGTERM");
  if (!(await waitGone(targets, gracefulWaitMs))) {
    signalTree(targets.filter(alive), "SIGKILL");
    if (!(await waitGone(targets, killWaitMs)))
      throw new Error(
        `jcode connector: a previous lifecycle's Jcode processes survived teardown (pids ${targets.filter(alive).join(", ")}) — this seat's runtime directory is still held`,
      );
  }
  return targets;
}

export interface StopPrivateTreeOptions {
  jcodeHome: string;
  /** Immutable identity of the bridge child spawned by this launch. */
  launch: ProcessIdentity;
  /** Random launch-bound environment identity inherited only by this bridge tree. */
  identityValue: string;
  gracefulWaitMs?: number;
  killWaitMs?: number;
  /** Records must remain absent for this long after the bridge is gone (default 500ms). */
  settleMs?: number;
  /** Injectable process proof source for direct lifecycle tests. */
  identityProbe?: ProcessIdentityProbe;
}

/** SIGTERM the launch-owned tree, escalate survivors to SIGKILL, and only return once its records
 * remain quiescent after the bridge is gone. A stale or reused registry PID is skipped, never
 * signalled; an unprovable live process is not converted into ownership by location alone. */
export async function stopPrivateTree(options: StopPrivateTreeOptions): Promise<void> {
  const {
    jcodeHome,
    launch,
    identityValue,
    gracefulWaitMs = 3_000,
    killWaitMs = 2_000,
    settleMs = 500,
    identityProbe = processIdentityProbe,
  } = options;
  const owned = new Map<number, ProcessIdentity>();
  const refreshOwned = (): void => {
    for (const identity of captureLaunchProcesses(identityValue, identityProbe)) owned.set(identity.pid, identity);
  };
  refreshOwned();
  // A bridge that already died (provider stall, crash) or whose PID was reused is a legal teardown
  // state: there is nothing safe to signal, and the record scan below still owns any survivors. The
  // refusal is reserved for a live bridge matching its captured start token that does not carry the
  // launch identity — broken launch wiring, where ownership cannot be proved for a process that
  // must be stopped. A bridge exiting under us reads as identity-less for a moment (#1179), so the
  // refusal takes a direct proof that the environment is readable and lacks the identity, rather
  // than the scan's absence, which cannot tell that window apart from broken wiring.
  if (alive(launch.pid) && processMatches(launch) && launchIdentityProof(launch.pid, identityValue, identityProbe) === false)
    throw new Error(`jcode connector: spawned Jcode bridge ${launch.pid} does not carry its launch-bound identity — refusing unsafe teardown`);

  if (processMatches(launch)) {
    // Stop the bridge by exact PID. It is not a daemon group leader, and its death is the event after
    // which a launch already in flight can publish the registry record the next phase must catch.
    signalPid(launch.pid, "SIGTERM");
    if (!(await waitGone([launch.pid], gracefulWaitMs))) {
      signalPid(launch.pid, "SIGKILL");
      if (!(await waitGone([launch.pid], killWaitMs)))
        throw new Error(`jcode connector: Jcode bridge survived teardown (pid ${launch.pid}) — the seat's tree is NOT stopped`);
    }
  }

  let quietSince = Date.now();
  let capturedAfterBridge = false;
  for (;;) {
    // A daemon may be forked just before bridge death but become visible only after the initial
    // capture. Refresh from the launch nonce during quiescence; PID start tokens make reuse fail.
    if (capturedAfterBridge) refreshOwned();
    else capturedAfterBridge = true;
    const recorded = recordedTreePids(jcodeHome);
    const targets = recorded
      .map((pid) => owned.get(pid))
      .filter((identity): identity is ProcessIdentity => identity !== undefined && processMatches(identity) && alive(identity.pid))
      .map((identity) => identity.pid);
    if (targets.length) {
      signalTree(targets, "SIGTERM");
      if (!(await waitGone(targets, gracefulWaitMs))) {
        signalTree(targets.filter(alive), "SIGKILL");
        if (!(await waitGone(targets, killWaitMs)))
          throw new Error(
            `jcode connector: private Jcode processes survived teardown (pids ${targets.filter(alive).join(", ")}) — the seat's tree is NOT stopped`,
          );
      }
      quietSince = Date.now();
      continue;
    }
    if (Date.now() - quietSince < settleMs) {
      await new Promise((resolve) => setTimeout(resolve, 25));
      continue;
    }

    // A launch-owned descendant with no record is still ours to stop, but only after the settle
    // window gave an in-flight daemon registration the chance to become observable and validated.
    const unrecorded = [...owned.values()]
      .filter((identity) => identity.pid !== launch.pid && processMatches(identity) && alive(identity.pid))
      .map((identity) => identity.pid);
    if (!unrecorded.length) return;
    signalTree(unrecorded, "SIGTERM");
    if (!(await waitGone(unrecorded, gracefulWaitMs))) {
      signalTree(unrecorded.filter(alive), "SIGKILL");
      if (!(await waitGone(unrecorded, killWaitMs)))
        throw new Error(
          `jcode connector: unrecorded launch-owned Jcode processes survived teardown (pids ${unrecorded.filter(alive).join(", ")}) — the seat's tree is NOT stopped`,
        );
    }
    quietSince = Date.now();
  }
}
