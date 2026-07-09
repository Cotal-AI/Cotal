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

/** Start the provider's daemon command detached (pid + log space-scoped), stopped by `cotal down`. */
function startAuthServiceDetached(space: string, server: string, command: string): number {
  const fd = openSync(LOG_PATH(space), "a");
  const [node, ...self] = selfArgv();
  const child = spawn(node, [...self, command, "--space", space, "--server", server], {
    detached: true,
    stdio: ["ignore", fd, fd],
  });
  closeSync(fd);
  child.unref();
  writeFileSync(PID_PATH(space), String(child.pid));
  return child.pid ?? 0;
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
