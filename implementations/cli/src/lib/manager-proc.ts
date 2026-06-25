import { spawn, spawnSync } from "node:child_process";
import { existsSync, openSync, closeSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { DEFAULT_SERVER } from "@cotal-ai/core";
import { selfArgv } from "./self-exec.js";
import { resolveSpace } from "./status.js";
import { cotalPath } from "./paths.js";

const PID_PATH = () => cotalPath("manager.pid");
/** Sibling marker of `manager.pid`: written by THIS build's manager (which no longer hosts Plane-3 —
 *  the server-side delivery daemon does). Its presence beside a live `manager.pid` proves the manager is
 *  "delivery-aware" / non-hosting. A live `manager.pid` WITHOUT this marker is an OLD (pre-delivery-daemon)
 *  manager that still calls `startPlane3` — the delivery preflight stops it before the daemon binds, so an
 *  old hosting manager never double-binds `fanout`/`reader` against the new daemon. */
const DELIVERY_AWARE_MARKER = () => cotalPath("manager.delivery-aware");

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0); // signal 0: liveness probe, doesn't actually signal
    return true;
  } catch {
    return false;
  }
}

/** True if the manager we started for this folder is still running (pid file + liveness). */
export function managerUp(): boolean {
  const p = PID_PATH();
  if (!existsSync(p)) return false;
  const pid = Number(readFileSync(p, "utf8").trim());
  return Number.isFinite(pid) && alive(pid);
}

/** True if the live manager carries a delivery-aware marker BOUND to its current pid (i.e. it's THIS
 *  build, non-hosting). Fail-closed: the marker stores the pid it was written for, and this requires it
 *  to equal the live `manager.pid` — a stale marker left by a crash, a mismatch, or an unparseable file
 *  all read as NOT delivery-aware, so a live old hosting `manager.pid` can't be mistaken for non-hosting
 *  and the delivery preflight stops it. */
export function managerHasDeliveryMarker(): boolean {
  const markerPath = DELIVERY_AWARE_MARKER();
  const pidPath = PID_PATH();
  if (!existsSync(markerPath) || !existsSync(pidPath)) return false;
  const markerPid = Number(readFileSync(markerPath, "utf8").trim());
  const livePid = Number(readFileSync(pidPath, "utf8").trim());
  return Number.isFinite(markerPid) && Number.isFinite(livePid) && markerPid === livePid;
}

/** True if any process's full command line matches `pattern` (`pgrep -f`). Detects processes that
 *  have no pid file — the cmux-tab manager and the driving session — which live in cmux tabs. */
export function pgrepMatches(pattern: string): boolean {
  return spawnSync("pgrep", ["-f", pattern], { stdio: "ignore" }).status === 0;
}

/** True if a cmux-runtime manager is live for this space. Its cmux tab persists after the process
 *  exits, so a workspace listing isn't proof — the process is. A cmux manager runs `… supervise
 *  --runtime cmux … --space <space> …`; match order-independently (the session launcher emits the
 *  two flags adjacent, but a hand-typed launch may reorder them) by narrowing to `--runtime cmux`
 *  processes, then confirming the exact `--space <space>` token in each one's argv. Works for prod
 *  `cotal.js` and dev `cotal.ts` alike. */
export function cmuxManagerRunning(space: string): boolean {
  // `--` so pgrep doesn't read the leading `--runtime` as one of its own options.
  const r = spawnSync("pgrep", ["-f", "--", "--runtime cmux"], { encoding: "utf8" });
  if (r.status !== 0) return false;
  // Match the `--space` value as a whole token (space names can't contain whitespace), so `demo`
  // never matches a process serving `demo2`. Both `--space <space>` and `--space=<space>` forms.
  const servesSpace = (args: string): boolean => {
    const tokens = args.split(/\s+/);
    return tokens.some((t, i) => (t === "--space" && tokens[i + 1] === space) || t === `--space=${space}`);
  };
  return r.stdout
    .split("\n")
    .filter(Boolean)
    .some((pid) => servesSpace(spawnSync("ps", ["-p", pid, "-o", "args="], { encoding: "utf8" }).stdout));
}

/** True if a tmux-runtime manager is live for this space. Same matching logic as cmuxManagerRunning. */
export function tmuxManagerRunning(space: string): boolean {
  const r = spawnSync("pgrep", ["-f", "--", "--runtime tmux"], { encoding: "utf8" });
  if (r.status !== 0) return false;
  const servesSpace = (args: string): boolean => {
    const tokens = args.split(/\s+/);
    return tokens.some((t, i) => (t === "--space" && tokens[i + 1] === space) || t === `--space=${space}`);
  };
  return r.stdout
    .split("\n")
    .filter(Boolean)
    .some((pid) => servesSpace(spawnSync("ps", ["-p", pid, "-o", "args="], { encoding: "utf8" }).stdout));
}

/** Start the control-plane manager detached (pid in `.cotal/manager.pid`, output to
 *  `.cotal/manager.log`), stopped by `cotal down`. Re-execs this same CLI's `supervise` — the
 *  composed `cotal` binary registers it; `process.execArgv` carries the tsx loader in dev and is
 *  empty in prod. `supervise`'s auto runtime resolves to pty when detached, which answers the
 *  control plane (`cotal_spawn`/`despawn`/`purge`/`persona`) with no tmux/cmux needed. */
export function startManagerDetached(
  o: { space?: string; server?: string; spawn?: string[]; launch?: string; runtime?: string } = {},
): number {
  const fd = openSync(cotalPath("manager.log"), "a");
  const [node, ...self] = selfArgv();
  const args = [
    ...self,
    "supervise",
    "--space",
    o.space ?? resolveSpace(process.cwd()),
    "--server",
    o.server ?? DEFAULT_SERVER,
    ...(o.runtime ? ["--runtime", o.runtime] : []),
    ...(o.spawn?.length ? ["--spawn", o.spawn.join(",")] : []),
    // A resolved mesh-manifest launch spec (cotal up -f): the manager materializes + boots each agent.
    ...(o.launch ? ["--launch", o.launch] : []),
  ];
  const child = spawn(node, args, { detached: true, stdio: ["ignore", fd, fd] });
  closeSync(fd);
  child.unref();
  writeFileSync(PID_PATH(), String(child.pid));
  // Mark this manager as delivery-aware (non-hosting) so the delivery preflight can tell it apart from
  // an old Plane-3-hosting manager. Written next to the pid, removed together in stopManager / down.
  writeFileSync(DELIVERY_AWARE_MARKER(), String(child.pid));
  return child.pid ?? 0;
}

/** Make the control plane available: reuse a manager already running for this folder, else start
 *  one detached. Best-effort — callers treat it as non-fatal. */
export function ensureManager(o: { space?: string; server?: string; spawn?: string[] } = {}): { running: boolean } {
  if (managerUp()) return { running: true };
  startManagerDetached(o);
  return { running: true };
}

/** Stop the detached (pty) manager if we started one. Used when switching to the cmux-tab manager
 *  so the two don't both answer the control plane (queue-grouped requests would split between them). */
export function stopManager(): void {
  const p = PID_PATH();
  rmSync(DELIVERY_AWARE_MARKER(), { force: true }); // drop the marker with the pid (gone either way)
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
