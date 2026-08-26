import { randomBytes } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";

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
}

function processStat(pid: number): ProcessStat | undefined {
  try {
    if (process.platform === "linux") {
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      const after = stat.lastIndexOf(") ");
      if (after < 0) return undefined;
      const fields = stat.slice(after + 2).trim().split(/\s+/u);
      const parentPid = Number(fields[1]);
      const start = fields[19];
      return Number.isInteger(parentPid) && parentPid >= 0 && start ? { pid, parentPid, start } : undefined;
    }
    if (process.platform === "darwin" || process.platform.endsWith("bsd")) {
      const out = execFileSync("/bin/ps", ["-o", "ppid=", "-o", "lstart=", "-p", String(pid)], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim();
      const match = out.match(/^(\d+)\s+(.+)$/u);
      const parentPid = Number(match?.[1]);
      const start = match?.[2]?.trim();
      return Number.isInteger(parentPid) && parentPid >= 0 && start ? { pid, parentPid, start } : undefined;
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

interface ProcessIdentityProbe {
  ps: (pid: number) => string;
  pidExists: (pid: number) => boolean;
}

const processIdentityProbe: ProcessIdentityProbe = {
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

function processHasLaunchIdentityFromPs(pid: number, identityValue: string, probe: ProcessIdentityProbe): boolean {
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

function processHasLaunchIdentity(pid: number, identityValue: string): boolean {
  if (process.platform === "linux")
    return readFileSync(`/proc/${pid}/environ`, "utf8").split("\0").includes(`${LAUNCH_IDENTITY_ENV}=${identityValue}`);
  if (process.platform === "darwin" || process.platform.endsWith("bsd"))
    return processHasLaunchIdentityFromPs(pid, identityValue, processIdentityProbe);
  throw new Error(`jcode connector: launch-bound process identity is unavailable on ${process.platform}`);
}

export const processHasLaunchIdentityForTest = (
  pid: number,
  identityValue: string,
  probe: ProcessIdentityProbe,
): boolean => processHasLaunchIdentityFromPs(pid, identityValue, probe);

function captureLaunchProcesses(identityValue: string): ProcessIdentity[] {
  const owned: ProcessIdentity[] = [];
  for (const pid of processPids()) {
    try {
      if (!processHasLaunchIdentity(pid, identityValue)) continue;
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
}

/** SIGTERM the launch-owned tree, escalate survivors to SIGKILL, and only return once its records
 * remain quiescent after the bridge is gone. A stale or reused registry PID is skipped, never
 * signalled; an unprovable live process is not converted into ownership by location alone. */
export async function stopPrivateTree(options: StopPrivateTreeOptions): Promise<void> {
  const { jcodeHome, launch, identityValue, gracefulWaitMs = 3_000, killWaitMs = 2_000, settleMs = 500 } = options;
  const owned = new Map<number, ProcessIdentity>();
  const refreshOwned = (): void => {
    for (const identity of captureLaunchProcesses(identityValue)) owned.set(identity.pid, identity);
  };
  refreshOwned();
  // A bridge that already died (provider stall, crash) or whose PID was reused is a legal teardown
  // state: there is nothing safe to signal, and the record scan below still owns any survivors. The
  // refusal is reserved for a live bridge matching its captured start token that does not carry the
  // launch identity — broken launch wiring, where ownership cannot be proved for a process that
  // must be stopped.
  if (alive(launch.pid) && processMatches(launch) && !owned.has(launch.pid))
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
