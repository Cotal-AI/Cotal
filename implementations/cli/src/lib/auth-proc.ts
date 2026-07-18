/**
 * Lifecycle for the USER-AUTH service daemon — the delivery-proc pattern, but SPACE-SCOPED
 * throughout (pid/log names carry the space): `cotal down` on one space must never kill another
 * space's auth service once multi-space-per-root lands. The CLI stays provider-agnostic: it
 * resolves the ONE registered `auth-provider` extension, re-execs its self-registered daemon
 * command via {@link selfArgv} (argv array — never shell interpolation), and delegates readiness
 * to the provider's `ready()` contract. No `@cotal-ai/auth` import anywhere in this package.
 */
import { spawn } from "node:child_process";
import { closeSync, existsSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { type AuthPrepared } from "@cotal-ai/core";
import { selfArgv } from "./self-exec.js";
import { cotalPath } from "./paths.js";

const PID_PATH = (space: string) => cotalPath(`auth-service.${encodeURIComponent(space)}.pid`);
const LOG_PATH = (space: string) => cotalPath(`auth-service.${encodeURIComponent(space)}.log`);

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// Provider resolution now lives in core (the manager needs the identical resolution); re-exported
// so existing CLI imports keep working.
export { resolveAuthProvider } from "@cotal-ai/core";

/** True if the auth service we started for THIS space is still running (pid file + liveness). */
export function authServiceUp(space: string): boolean {
  const p = PID_PATH(space);
  if (!existsSync(p)) return false;
  const pid = Number(readFileSync(p, "utf8").trim());
  return Number.isFinite(pid) && alive(pid);
}

/** EXCLUSIVE pidfile claim (#29 HIGH 3 belt): the slot is created with `wx` BEFORE any spawn, so
 *  two concurrent launchers cannot both pass a check-then-spawn race and double-launch the auth
 *  service. This is the cheap HOST-LAYER belt only — the broker-visible exclusion is the plane
 *  claim inside `openAuthAuthorityPlane` (a second plane refuses there even if it somehow gets
 *  spawned; SPEC 13.13). Outcomes:
 *   - `{ fd }`: this launcher owns the slot (write the child pid through the fd, then close it);
 *   - `{ livePid }`: a LIVE daemon already holds it — use that one;
 *   - `undefined`: yield — the file is unreadable/fresh (a sibling launcher between its exclusive
 *     create and its pid write) or still contested after one stale-removal retry; never steal.
 *  A file naming a provably DEAD pid is removed and the claim retried ONCE. */
export function claimAuthPidSlot(space: string): { fd: number } | { livePid: number } | undefined {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      return { fd: openSync(PID_PATH(space), "wx") };
    } catch {
      let pid = Number.NaN;
      try {
        pid = Number(readFileSync(PID_PATH(space), "utf8").trim());
      } catch { /* vanished between open and read - retry the claim */ }
      if (Number.isFinite(pid) && pid > 0 && alive(pid)) return { livePid: pid };
      if (Number.isFinite(pid) && pid > 0 && attempt === 0) {
        try { rmSync(PID_PATH(space)); } catch { /* a sibling removed it first */ }
        continue;
      }
      return undefined; // unreadable/empty: a sibling is mid-claim - let its daemon come up
    }
  }
  return undefined;
}

/** Start the provider's daemon command detached (pid + log space-scoped), stopped by `cotal down`.
 *  The pid slot is claimed exclusively FIRST ({@link claimAuthPidSlot}); a held or contested slot
 *  yields to the existing daemon (the caller's ready() poll adjudicates liveness). */
function startAuthServiceDetached(space: string, server: string, command: string): number {
  const slot = claimAuthPidSlot(space);
  if (slot === undefined) return 0;
  if ("livePid" in slot) return slot.livePid;
  try {
    const fd = openSync(LOG_PATH(space), "a");
    const [node, ...self] = selfArgv();
    const child = spawn(node, [...self, command, "--space", space, "--server", server], {
      detached: true,
      stdio: ["ignore", fd, fd],
    });
    closeSync(fd);
    child.unref();
    writeFileSync(slot.fd, String(child.pid)); // through the exclusively-created fd, never a re-open
    return child.pid ?? 0;
  } finally {
    closeSync(slot.fd);
  }
}

/** Make the user-auth service available for a space: start the provider's daemon unless it's
 *  already up, then wait on the provider's readiness contract (both planes bound). Returns the
 *  provider-reported runtime endpoints for the mesh registry. THROWS with the reason + the log
 *  path on a service that never became ready — the caller surfaces it loudly (U5); user-mode `up`
 *  must never quietly succeed with a dead auth plane. */
export async function ensureAuthService(opts: {
  space: string;
  server: string;
  stateDir: string;
  prepared: AuthPrepared;
}): Promise<Record<string, unknown>> {
  if (!authServiceUp(opts.space)) startAuthServiceDetached(opts.space, opts.server, opts.prepared.service.command);
  try {
    return await opts.prepared.service.ready({ dir: opts.stateDir });
  } catch (e) {
    throw new Error(`${e instanceof Error ? e.message : String(e)} - see ${LOG_PATH(opts.space)}`);
  }
}

/** Stop THIS space's auth service if we started one. Scoped by the space-carrying pid file — never
 *  a root-global kill. */
export function stopAuthService(space: string): void {
  const p = PID_PATH(space);
  if (!existsSync(p)) return;
  const pid = Number(readFileSync(p, "utf8").trim());
  if (Number.isFinite(pid)) {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      /* already gone */
    }
  }
  rmSync(p);
}
