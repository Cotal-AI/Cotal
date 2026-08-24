import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

/** Exact teardown of one seat's private Jcode process tree (#839).
 *
 * The SDK stops the daemon through a servers.json lookup that must match the alias socket path
 * verbatim; a canonicalized entry or a wiped registry is a silent no-op, and the daemon runs in
 * its own session, so killing the bridge never reaches it. The connector therefore proves the
 * teardown itself, from the seat's OWN records: every PID named in the private home's
 * servers.json and active_pids/ is this seat's by construction, so signalling them — and the
 * process groups the daemon created for its children — can never touch another seat or the
 * shared manager. Never a name sweep.
 */

const isPid = (value: unknown): value is number => Number.isInteger(value) && (value as number) > 1;

/** Every PID this seat's private home records as its own. */
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
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
};

function signalTree(pids: number[], signal: NodeJS.Signals): void {
  for (const pid of pids) {
    // The daemon setsids into a group of its own, taking its MCP and keep-alive children with it,
    // so the group form stays seat-exact; a non-leader (the bridge) refuses it and gets the exact
    // PID instead.
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
  /** PIDs the connector holds first-hand (the bridge child), beyond what the home records. */
  knownPids?: Array<number | undefined>;
  gracefulWaitMs?: number;
  killWaitMs?: number;
}

/** SIGTERM the recorded tree, escalate survivors to SIGKILL, and only return once every recorded
 * PID is proven dead — throwing, never pretending, when one survives. Runs two passes so a record
 * written moments after the first read is caught, not orphaned. */
export async function stopPrivateTree(options: StopPrivateTreeOptions): Promise<void> {
  const { jcodeHome, knownPids = [], gracefulWaitMs = 3_000, killWaitMs = 2_000 } = options;
  for (let pass = 0; pass < 2; pass++) {
    const targets = [...new Set([...knownPids.filter(isPid), ...recordedTreePids(jcodeHome)])].filter(alive);
    if (!targets.length) return;
    signalTree(targets, "SIGTERM");
    if (!(await waitGone(targets, gracefulWaitMs))) {
      signalTree(targets.filter(alive), "SIGKILL");
      if (!(await waitGone(targets, killWaitMs)))
        throw new Error(
          `jcode connector: private Jcode processes survived teardown (pids ${targets.filter(alive).join(", ")}) — the seat's tree is NOT stopped`,
        );
    }
  }
}
