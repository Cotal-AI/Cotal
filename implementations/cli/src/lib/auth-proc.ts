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
import { closeSync, linkSync, openSync, readFileSync, rmSync, writeSync } from "node:fs";
import { type AuthPrepared } from "@cotal-ai/core";
import { spaceKey } from "@cotal-ai/workspace";
import { canonicalLocalProcessPath, localProcessPath, parsePid, probeLiveness, readPidfile, reclaimDeadPreUpgradeRecord, writePidPair, type LocalProcess, type LocalProcessContext } from "@cotal-ai/workspace";
import { stopLocalProcess } from "./local-process-stop.js";

import { selfArgv } from "./self-exec.js";
import { cotalPath, cotalRoot } from "./paths.js";

// The auth record resolves from `AUTH_PROCESS.pidFile`, the template `cotal down` stops through: starts
// WRITE `canonicalLocalProcessPath`, reads take `localProcessPath`, which also admits the pre-hex
// `auth-service.<encoded>.pid` a build before the re-key wrote, so an upgrade never orphans the live
// callout SIGNER of a pre-upgrade auth-service.
const ctx = (space: string): LocalProcessContext => ({ root: cotalRoot(), space });
const LOG_PATH = (space: string) => cotalPath(`auth-service.${spaceKey(space)}.log`);

// parsePid + probeLiveness (the pid-attribution contract) live in @cotal-ai/workspace, shared so
// there is exactly ONE parser + ONE tri-state probe across the pidfile subsystem.

// Provider resolution now lives in core (the manager needs the identical resolution); re-exported
// so existing CLI imports keep working.
export { resolveAuthProvider } from "@cotal-ai/core";

/** True if the auth service we started for THIS space is still running (pid file + liveness). */
export function authServiceUp(space: string): boolean {
  const raw = readPidfile(localProcessPath(AUTH_PROCESS.pidFile, ctx(space)));
  if (raw === undefined) return false;
  const pid = parsePid(raw); // strict positive safe integer, or undefined
  return pid !== undefined && probeLiveness(pid) === "alive"; // up only if provably present; dead/unknown → not up
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
  const target = canonicalLocalProcessPath(AUTH_PROCESS.pidFile, ctx(space));
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
      // Reclaim ONLY an empty pre-protocol slot or a pid ESRCH-proven dead. A live/EPERM holder is
      // adopted; an unattributable record (garbled/fractional/unsignalable, or a probe that is not a
      // clean ESRCH) is never stolen - yield.
      const pid = parsePid(trimmed);
      const state = pid === undefined ? undefined : probeLiveness(pid);
      if (state === "alive") return { livePid: pid! };
      if ((trimmed === "" || state === "dead") && attempt === 0) {
        try { rmSync(target); } catch { /* a sibling removed it first */ }
        continue; // empty pre-protocol slot, or ESRCH-proven-dead holder: reclaim ONCE
      }
      return undefined; // unattributable/unknown content (or still contested after the retry): never steal
    }
  }
  return undefined;
}

/** Start the provider's daemon command detached (pid + log space-scoped), stopped by `cotal down`.
 *  The pid slot is claimed exclusively before the spawn ({@link claimAuthPidSlot}); a held or
 *  contested slot yields to the existing daemon (the caller's ready() poll adjudicates liveness). */
function startAuthServiceDetached(space: string, server: string, command: string, extraArgs: string[] = []): number {
  // The entry is validated BEFORE any pidfile work (#1629). The claim below publishes a pidfile that
  // already names THIS launcher, which is alive and is not an auth service, and the reclaim deletes a
  // pre-hex record. A refusal after them left the root changed: the claimed record read as a running
  // service, so a retry started nothing and waited on readiness with no daemon behind it, and
  // teardown signalled whichever process held the launcher's pid.
  //
  // Then: a pre-hex crash leaves a dead legacy pidfile; clear it or the canonical claim produces the
  // both-present wedge localProcessPath refuses.
  const [node, ...self] = selfArgv();
  reclaimDeadPreUpgradeRecord(AUTH_PROCESS.pidFile, ctx(space));
  const slot = claimAuthPidSlot(space);
  if (slot === undefined) return 0;
  if ("livePid" in slot) return slot.livePid;
  try {
    const fd = openSync(LOG_PATH(space), "a");
    // Internal child re-exec (the `up` that reached here already seeded); the auth service does not
    // launch agents, so it skips the connector seed on boot (a direct `cotal auth-service` still seeds).
    const child = spawn(node, [...self, command, "--space", space, "--server", server, ...extraArgs], {
      detached: true,
      stdio: ["ignore", fd, fd],
      env: { ...process.env, COTAL_SKIP_CONNECTOR_SEED: "1" },
    });
    closeSync(fd);
    child.unref();
    // Replace the launcher pid with the daemon child's pid: the pair is published by rename over
    // the claimed name (#969/#1238), so a crash never leaves a torn pairing - the verify below
    // refuses a torn pairing loud regardless.
    if (!child.pid) throw new Error("auth service spawned with no pid");
    writePidPair(canonicalLocalProcessPath(AUTH_PROCESS.pidFile, ctx(space)), child.pid);
    return child.pid;
  } finally {
    closeSync(slot.fd);
  }
}

/** The pid the readiness wait should bind to, or undefined when none can be named: the pid THIS
 *  call launched (startAuthServiceDetached returns the spawned child's pid, or the live holder a
 *  claimed slot yielded to), else the live pid authServiceUp found in the pidfile. 0 means a
 *  spawn was attempted but nothing was claimed — the wait stays clock-only rather than binding
 *  to a pid nobody can attribute. */
function authServiceWaitPid(space: string, launched: number | undefined): number | undefined {
  if (launched !== undefined && launched > 0) return launched;
  const raw = readPidfile(localProcessPath(AUTH_PROCESS.pidFile, ctx(space)));
  if (raw === undefined) return undefined;
  const pid = parsePid(raw);
  return pid !== undefined && probeLiveness(pid) === "alive" ? pid : undefined;
}

/** Make the user-auth service available for a space: start the provider's daemon unless it's
 *  already up, then wait on the provider's readiness contract (both planes bound). The wait is
 *  bound to the daemon process (#1931): while the pid this call launched (or found live) is
 *  provably alive, the provider waits past the base clock to a fixed upper bound instead of
 *  misreporting a still-binding daemon as dead, and a daemon that exited refuses at once.
 *  Returns the provider-reported runtime endpoints for the mesh registry. THROWS with the
 *  reason + the log path on a service that never became ready — the caller surfaces it loudly
 *  (U5); user-mode `up` must never quietly succeed with a dead auth plane. */
export async function ensureAuthService(opts: {
  space: string;
  server: string;
  stateDir: string;
  prepared: AuthPrepared;
  /** Extra daemon argv (argv array — never shell interpolation), e.g. the public-exchange flags
   *  `up` threads through. Applied only when THIS call starts the daemon; an already-running
   *  service keeps the flags it was started with (restart via `cotal down`/`up` to change them). */
  extraArgs?: string[];
}): Promise<Record<string, unknown>> {
  let launched: number | undefined;
  if (!authServiceUp(opts.space)) launched = startAuthServiceDetached(opts.space, opts.server, opts.prepared.service.command, opts.extraArgs);
  const pid = authServiceWaitPid(opts.space, launched);
  try {
    return await opts.prepared.service.ready({ dir: opts.stateDir, pid });
  } catch (e) {
    throw new Error(`${e instanceof Error ? e.message : String(e)} - the daemon's pid is recorded at ${localProcessPath(AUTH_PROCESS.pidFile, ctx(opts.space))}, its log is at ${LOG_PATH(opts.space)}`);
  }
}

/** The user-auth service as a local process: `cotal down` and `up`'s teardown stop it through this one
 *  descriptor, so both take the same reservation, identity check and SIGKILL escalation. */
export const AUTH_PROCESS: LocalProcess = {
  kind: "local-process",
  name: "auth",
  label: "user-auth service",
  order: 30,
  pidFile: "auth-service.{space}.pid",
  visibleWhen: "user-auth",
};

/** Stop THIS space's auth service with the stop `cotal down auth` runs. Scoped by the space-carrying
 *  pidfile, never a root-global kill. Throws, with the record kept, when the stop is refused or the
 *  death is not confirmed. */
export async function stopAuthService(space: string): Promise<void> {
  await stopLocalProcess(AUTH_PROCESS, { root: cotalRoot(), space });
}
