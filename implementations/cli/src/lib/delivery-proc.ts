import { spawn } from "node:child_process";
import { existsSync, openSync, closeSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import {
  DEFAULT_SERVER,
  mintCreds,
  newIdentity,
  waitForDeliveryLease,
} from "@cotal-ai/core";
import { authDir, findCotalRoot, loadSpaceAuth } from "@cotal-ai/workspace";
import { selfArgv } from "./self-exec.js";
import { resolveSpace } from "./status.js";
import { cotalPath } from "./paths.js";
import { ensureManager, managerHasDeliveryMarker, managerUp, stopManager } from "./manager-proc.js";

const PID_PATH = () => cotalPath("delivery.pid");
const CREDS_PATH = () => cotalPath("delivery.creds");

type Opts = { space?: string; server?: string; spawn?: string[] };

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** True if the delivery daemon we started for this folder is still running (pid file + liveness). */
export function deliveryUp(): boolean {
  const p = PID_PATH();
  if (!existsSync(p)) return false;
  const pid = Number(readFileSync(p, "utf8").trim());
  return Number.isFinite(pid) && alive(pid);
}

/** True when this folder runs an authed mesh — the only mode with a delivery daemon (Plane-3 needs the
 *  trusted reader; open dev mode is live-only). */
function hasAuth(): boolean {
  return Boolean(loadSpaceAuth(authDir(findCotalRoot())));
}

/** True if an OLD (pre-delivery-daemon) Plane-3-hosting manager is live: a `manager.pid` that is alive
 *  but carries no delivery-aware marker. Such a manager still calls `startPlane3` and would double-bind
 *  `fanout`/`reader` against the new daemon. */
function oldHostingManagerLive(): boolean {
  return managerUp() && !managerHasDeliveryMarker();
}

/** Cutover preflight — the FIRST action, BEFORE the daemon can bind: stop any old Plane-3-hosting
 *  manager (live `manager.pid` without the delivery-aware marker) so it never double-binds the
 *  daemon's durables. A delivery-aware (this-build) manager is left running. No-op on a fresh install. */
export function stopOldHostingManagerIfPresent(): void {
  if (oldHostingManagerLive()) {
    console.error("• stopping an old Plane-3-hosting manager before starting the delivery daemon (cutover preflight)");
    stopManager();
  }
}

/** Start the delivery daemon detached (pid in `.cotal/delivery.pid`, output to `.cotal/delivery.log`),
 *  stopped by `cotal down`. Re-execs this CLI's `deliver` command; the daemon loads the pre-minted
 *  scoped `delivery.creds` (written by {@link ensureDelivery}) — it never sees the signer. */
export function startDeliveryDetached(o: Opts = {}): number {
  const fd = openSync(cotalPath("delivery.log"), "a");
  const [node, ...self] = selfArgv();
  const args = [
    ...self,
    "deliver",
    "--space",
    o.space ?? resolveSpace(process.cwd()),
    "--server",
    o.server ?? DEFAULT_SERVER,
  ];
  const child = spawn(node, args, { detached: true, stdio: ["ignore", fd, fd] });
  closeSync(fd);
  child.unref();
  writeFileSync(PID_PATH(), String(child.pid));
  return child.pid ?? 0;
}

/** Make the server-side delivery daemon available (auth mode only). FAILS CLOSED: refuses to launch
 *  while an old Plane-3-hosting manager is live (the preflight should have stopped it) so the daemon
 *  never double-binds. Mints a SCOPED `delivery` cred from the local signer ONCE, writes it to
 *  `.cotal/delivery.creds` (0600), and launches the daemon WITHOUT signer access. Best-effort — callers
 *  treat it as non-fatal (a missing daemon degrades durable delivery, never live). */
export async function ensureDelivery(o: Opts = {}): Promise<{ running: boolean }> {
  if (!hasAuth()) return { running: false }; // open dev mode — no daemon, agents are live-only
  if (oldHostingManagerLive()) {
    console.error(
      "✗ delivery: an old Plane-3-hosting manager is still live (no delivery-aware marker). Refusing to start the daemon — run `cotal down` first, then retry.",
    );
    return { running: false };
  }
  // Mint a scoped delivery cred (used to probe readiness; for a NEW launch it is ALSO the daemon's cred,
  // written to disk). The daemon process reads the file and never holds the signer (a container mounts it
  // read-only). A reuse (daemon already up) mints a throwaway probe cred — the running daemon keeps its
  // own creds file.
  const auth = loadSpaceAuth(authDir(findCotalRoot()))!;
  const id = newIdentity();
  const creds = await mintCreds(auth, id, "delivery");
  const space = o.space ?? resolveSpace(process.cwd());
  const server = o.server ?? DEFAULT_SERVER;
  if (!deliveryUp()) {
    writeFileSync(CREDS_PATH(), creds, { mode: 0o600 });
    startDeliveryDetached({ ...o, space, server });
  }
  // ALWAYS wait for the daemon to be READY (lease flipped ready AFTER it bound ctl.delivery) before
  // returning — for a fresh launch AND a reused live daemon — so agents the manager spawns next find the
  // responder for their boot self-join. Non-fatal on timeout: the boot self-join reconciles with backoff,
  // which is the real safety net for a slow start or a later outage.
  const ready = await waitForDeliveryLease({ servers: server, space, creds, id: id.id });
  if (!ready)
    console.error("• delivery daemon not yet ready (responder not bound) — boot durable joins will reconcile when it is");
  return { running: true };
}

/** Stop the detached delivery daemon if we started one, and drop its creds file. */
export function stopDelivery(): void {
  rmSync(CREDS_PATH(), { force: true });
  const p = PID_PATH();
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

/** Bring up the control plane in the correct cutover order: OLD-manager preflight → delivery daemon
 *  (auth only, fails closed on a live old manager) → manager (lifecycle, writes the delivery-aware
 *  marker). The manager no longer depends on the daemon (it hosts no Plane-3), so the daemon is started
 *  first only to close the old-manager double-bind window and so freshly-spawned agents find the
 *  `ctl.delivery` responder for their boot self-join (a miss honest-degrades to live-only). */
export async function ensureControlPlane(o: Opts = {}): Promise<{ running: boolean }> {
  stopOldHostingManagerIfPresent();
  await ensureDelivery(o);
  return ensureManager(o);
}
