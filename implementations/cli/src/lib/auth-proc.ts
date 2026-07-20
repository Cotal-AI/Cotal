/**
 * Lifecycle for the USER-AUTH service daemon — the delivery-proc pattern, but SPACE-SCOPED
 * throughout (pid/log names carry the space): `cotal down` on one space must never kill another
 * space's auth service once multi-space-per-root lands. The CLI stays provider-agnostic: it
 * resolves the ONE registered `auth-provider` extension, re-execs its self-registered daemon
 * command via {@link selfArgv} (argv array — never shell interpolation), and delegates readiness
 * to the provider's `ready()` contract. No `@cotal-ai/auth` import anywhere in this package.
 */
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { closeSync, existsSync, ftruncateSync, linkSync, openSync, readFileSync, rmSync, writeSync } from "node:fs";
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

/** EXCLUSIVE pidfile claim (#29 HIGH 3 belt): the slot is published ATOMICALLY and
 *  PRE-POPULATED, so no reader can ever observe a legitimately-empty claim and no create/write
 *  window exists to race. The claimant writes its own pid to a unique temp inode in the same
 *  directory, then publishes it with `link(2)` — an atomic no-overwrite operation — as the slot
 *  path (the held fd stays the published inode; the caller later replaces the content with the
 *  daemon child's pid through it). This is the cheap HOST-LAYER belt only — the broker-visible
 *  exclusion is the plane claim inside `openAuthAuthorityPlane` (a second plane refuses there
 *  even if it somehow gets spawned; SPEC 13.13). Outcomes:
 *   - `{ fd }`: this launcher owns the slot;
 *   - `{ livePid }`: a LIVE holder already owns it (the daemon, or a launcher mid-spawn whose
 *     daemon the caller's ready() poll adjudicates) — use that one;
 *   - `undefined`: yield — garbled content, or still contested after one retry; never steal what
 *     cannot be attributed.
 *  A slot naming a provably DEAD pid — and an EMPTY slot, which the atomic pre-populated publish
 *  makes impossible to produce except by a pre-protocol crash — is removed and the claim retried
 *  ONCE, so a crash can never wedge the slot permanently. */
export function claimAuthPidSlot(space: string): { fd: number } | { livePid: number } | undefined {
  const target = PID_PATH(space);
  for (let attempt = 0; attempt < 2; attempt++) {
    const temp = `${target}.claim.${process.pid}.${randomBytes(4).toString("hex")}`;
    let fd: number | undefined;
    try {
      fd = openSync(temp, "wx");
      writeSync(fd, String(process.pid), 0);
      linkSync(temp, target); // the atomic no-overwrite publish: EEXIST = the slot is held
      rmSync(temp); // the published name and the held fd both keep the inode alive
      return { fd };
    } catch {
      if (fd !== undefined) closeSync(fd);
      try { rmSync(temp); } catch { /* never created, or already gone */ }
      let raw: string;
      try {
        raw = readFileSync(target, "utf8");
      } catch {
        continue; // vanished between publish-refusal and read - retry the claim once
      }
      const trimmed = raw.trim();
      const pid = trimmed === "" ? Number.NaN : Number(trimmed);
      if (Number.isFinite(pid) && pid > 0 && alive(pid)) return { livePid: pid };
      if ((trimmed === "" || (Number.isFinite(pid) && pid > 0)) && attempt === 0) {
        try { rmSync(target); } catch { /* a sibling removed it first */ }
        continue; // a dead holder, or an empty pre-protocol slot: reclaim ONCE
      }
      return undefined; // garbled content (or still contested after the retry): never steal
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
    // Internal child re-exec (the `up` that reached here already seeded); the auth service does not
    // launch agents, so it skips the connector seed on boot (a direct `cotal auth-service` still seeds).
    const child = spawn(node, [...self, command, "--space", space, "--server", server], {
      detached: true,
      stdio: ["ignore", fd, fd],
      env: { ...process.env, COTAL_SKIP_CONNECTOR_SEED: "1" },
    });
    closeSync(fd);
    child.unref();
    // Replace the launcher pid with the daemon child's pid through the exclusively-created fd,
    // never a re-open (truncate first: the fd position sits past the launcher pid).
    ftruncateSync(slot.fd, 0);
    writeSync(slot.fd, String(child.pid), 0);
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
