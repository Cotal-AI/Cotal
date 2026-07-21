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
import { closeSync, existsSync, ftruncateSync, linkSync, openSync, readdirSync, readFileSync, rmSync, writeSync } from "node:fs";
import { basename, dirname } from "node:path";
import { type AuthPrepared } from "@cotal-ai/core";
import { spaceKey } from "@cotal-ai/workspace";
import { selfArgv } from "./self-exec.js";
import { cotalPath } from "./paths.js";

const PID_PATH = (space: string) => cotalPath(`auth-service.${spaceKey(space)}.pid`);
const LOG_PATH = (space: string) => cotalPath(`auth-service.${spaceKey(space)}.log`);

/** The pidfile to READ for a space's auth service: the canonical hex name, or the pre-hex
 *  `auth-service.<encoded>.pid` a build before the re-key wrote. `up`'s restart and its stop read
 *  this so an upgrade never orphans the live callout SIGNER of a pre-upgrade auth-service. Byte-
 *  exact (a bare `existsSync` case-folds a sibling space's file on macOS/Windows); both present is
 *  ambiguous and fails loud. Starts always WRITE the canonical PID_PATH. */
function readPidPath(space: string): string {
  const canonical = PID_PATH(space);
  const legacy = cotalPath(`auth-service.${encodeURIComponent(space)}.pid`);
  if (legacy === canonical) return canonical;
  const exact = (p: string) => { try { return readdirSync(dirname(p)).includes(basename(p)); } catch { return false; } };
  const c = exact(canonical), l = exact(legacy);
  if (c && l) throw new Error(`both ${canonical} and the pre-hex ${legacy} exist for space "${space}" - ambiguous auth-service record; remove the stale one`);
  return l && !c ? legacy : canonical;
}

/** Whether a process EXISTS - the hardened probe shared with `down` (`commands/down.ts:170`): a
 *  successful `kill(pid,0)` OR an EPERM (the process exists but is owned by another user, so we
 *  cannot signal it) both mean alive; only ESRCH (and other definitely-gone errnos) mean dead.
 *  Mapping EPERM to "dead" is the bug the reclaim/stop contract cannot tolerate - it would treat a
 *  live-but-unsignalable signer as reclaimable and orphan it. Callers additionally require a
 *  POSITIVE pid before probing (a 0/negative value signals a whole process group). */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM"; // exists, just not ours to signal
  }
}

// Provider resolution now lives in core (the manager needs the identical resolution); re-exported
// so existing CLI imports keep working.
export { resolveAuthProvider } from "@cotal-ai/core";

/** Reclaim a DEAD pre-hex pidfile before a fresh start claims the canonical (hex) slot. A crash on
 *  a pre-upgrade build leaves `auth-service.<encoded>.pid`; the new start claims
 *  `auth-service.<hex>.pid` and, without this, BOTH would then exist - which `readPidPath` correctly
 *  refuses as ambiguous, wedging every later status/down.
 *
 *  It reclaims ONLY what the canonical claim ({@link claimAuthPidSlot}) would: an empty slot (a
 *  pre-protocol crash) or a positive finite PID proven DEAD. It NEVER deletes an unattributable
 *  record - garbled/non-numeric/non-positive content, or a still-LIVE legacy holder - because that
 *  is exactly the live pre-hex signer this whole path exists not to orphan (a torn or tampered
 *  pidfile of a running service reads as garbled). Those cases THROW so the start aborts loud rather
 *  than delete the record and launch a competing service. Byte-exact match, no case-fold. Exported
 *  for the boundary smoke, which must exercise the real reclaim, not a stand-in. */
export function reclaimDeadLegacyPid(space: string): void {
  const legacy = cotalPath(`auth-service.${encodeURIComponent(space)}.pid`);
  if (legacy === PID_PATH(space)) return;
  try {
    if (!readdirSync(dirname(legacy)).includes(basename(legacy))) return; // byte-exact absent
  } catch {
    return; // parent dir gone → nothing to reclaim
  }
  const trimmed = readFileSync(legacy, "utf8").trim();
  if (trimmed === "") {
    rmSync(legacy, { force: true }); // empty = pre-protocol husk, safe to reclaim (as the canonical claim does)
    return;
  }
  const pid = Number(trimmed);
  if (!Number.isFinite(pid) || pid <= 0)
    throw new Error(
      `pre-hex auth-service pidfile ${legacy} holds unattributable content ${JSON.stringify(trimmed)} - refusing to reclaim it or start a competing service; inspect or remove it manually`,
    );
  if (alive(pid))
    throw new Error(
      `a pre-hex auth-service is already running (pid ${pid}) at ${legacy} - refusing to start a second; run \`cotal down\` to stop it, then retry`,
    );
  rmSync(legacy, { force: true }); // a positive PID proven dead - reclaim it
}

/** True if the auth service we started for THIS space is still running (pid file + liveness). */
export function authServiceUp(space: string): boolean {
  const p = readPidPath(space);
  if (!existsSync(p)) return false;
  const pid = Number(readFileSync(p, "utf8").trim());
  return Number.isFinite(pid) && pid > 0 && alive(pid); // a 0/negative pid would probe a process GROUP
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
  reclaimDeadLegacyPid(space); // a pre-hex crash leaves a dead legacy pidfile; clear it or the
                               // canonical claim below produces the both-present wedge readPidPath refuses
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
 *  a root-global kill. Honors the same attribution contract as {@link claimAuthPidSlot}: it only
 *  removes a record it can ACT on. An empty slot is a husk (nothing to signal, safe to clear); a
 *  positive PID is signalled then removed; unattributable content (garbled, or a non-positive value
 *  that would make `process.kill` signal a whole process GROUP) is NEVER removed and fails loud -
 *  silently dropping it would orphan a live signer behind a torn/tampered pidfile while reporting a
 *  clean stop. */
export function stopAuthService(space: string): void {
  const p = readPidPath(space); // find a pre-hex pidfile too, or an upgrade leaks the signer
  if (!existsSync(p)) return;
  const trimmed = readFileSync(p, "utf8").trim();
  if (trimmed === "") {
    rmSync(p, { force: true }); // empty husk: no process to signal
    return;
  }
  const pid = Number(trimmed);
  if (!Number.isFinite(pid) || pid <= 0)
    throw new Error(
      `auth-service pidfile ${p} holds unattributable content ${JSON.stringify(trimmed)} - refusing to remove a record for a process it cannot identify or signal; inspect or remove it manually`,
    );
  try {
    process.kill(pid, "SIGTERM");
  } catch (e) {
    // ESRCH = already gone, so removing its record is safe. EPERM (exists, another user's) or any
    // other errno means we could NOT stop it - removing the record would orphan a live signer while
    // reporting a clean stop, so preserve it and fail loud.
    if ((e as NodeJS.ErrnoException).code !== "ESRCH")
      throw new Error(
        `could not stop auth-service (pid ${pid}) at ${p} (${(e as NodeJS.ErrnoException).code ?? "unknown error"}) - refusing to remove a record for a process it could not signal; stop it manually`,
      );
  }
  rmSync(p, { force: true });
}
