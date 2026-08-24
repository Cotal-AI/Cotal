import { spawn } from "node:child_process";
import { existsSync, openSync, closeSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import {
  DEFAULT_SERVER,
  LEASE_TTL_MS,
  mintCreds,
  newIdentity,
  waitForDeliveryLease,
} from "@cotal-ai/core";
import { DELIVERY_CREDS_KEY, authDir, findCotalRoot, getSoleSpaceAuth, listSpaceAccounts, parsePid, probeLiveness, type LivenessProbe, workspaceSecretStore } from "@cotal-ai/workspace";
import { selfArgv } from "./self-exec.js";
import { resolveSpace } from "./status.js";
import { cotalPath } from "./paths.js";
import { MANAGER_PID_PATH, ensureManager, managerHasDeliveryMarker, managerLiveness, stopManager, type SignalFn } from "./manager-proc.js";

const PID_PATH = () => cotalPath("delivery.pid");
// The daemon's cred goes through the secret-store seam; the shared key (== the filename, so the
// file stays `.cotal/delivery.creds`) comes from workspace — never a hand-copied literal.
const credsStore = () => workspaceSecretStore(findCotalRoot());

/** `tls` is the broker's transport decision, propagated to the daemon's argv. It is not optional
 *  information the daemon can do without: it cannot derive the transport itself (see the note at
 *  the argv site), and omitting it leaves a standing-credential daemon connecting
 *  plaintext-capable to a TLS broker while looking entirely healthy.
 *  `wsPort` is the broker's loopback websocket listener (P2 item 6), forwarded to the manager. */
type Opts = { space?: string; server?: string; tls?: boolean; spawn?: string[]; runtime?: string; launch?: string; attachHost?: string; resumeAttempt?: string; resumeCommitToken?: string; wsPort?: number };

/** The recorded daemon's liveness, THREE-VALUED plus absent. See {@link managerLiveness} for why the
 *  boolean collapse is the defect: `unknown` is reachable on a real kernel (a seccomp
 *  `SECCOMP_RET_ERRNO` filter or an LSM policy answers `kill(pid, 0)` with an arbitrary errno and
 *  libuv preserves it), and both ways of folding it into a boolean fail silently. */
export function deliveryLiveness(probe: LivenessProbe = probeLiveness): "alive" | "dead" | "unknown" | "absent" | "unattributable" {
  const p = PID_PATH();
  if (!existsSync(p)) return "absent";
  const raw = readFileSync(p, "utf8").trim();
  if (raw === "") return "absent";
  const pid = parsePid(raw);
  if (pid === undefined) return "unattributable"; // see managerLiveness: never fold this into absent
  return probe(pid);
}

/** True only if the daemon is PROVABLY running. Callers that ACT on the answer take
 *  {@link deliveryLiveness} instead; this cannot express "cannot tell". */
export function deliveryUp(): boolean {
  return deliveryLiveness() === "alive";
}



/** True when this folder runs an authed mesh — the only mode with a delivery daemon (Plane-3 needs the
 *  trusted reader; open dev mode is live-only). */
function hasAuth(): boolean {
  return listSpaceAccounts(authDir(findCotalRoot())).length > 0;
}

/** The cutover preflight's verdict, THREE-VALUED, because the boolean it replaced was read before the
 *  refusal boundary and therefore defeated it.
 *
 *  `managerUp()` folds `unknown` to false, so an unattributable manager with no marker (which IS the
 *  old Plane-3-hosting shape) read as "no old manager", the preflight skipped, and `ensureDelivery`
 *  went on to mint a credential, write a pidfile and start a second daemon. Only afterwards did
 *  `ensureManager` throw. Everything the refusal was supposed to prevent had already happened, and
 *  the daemon's own lease cannot help: it is a delivery-daemon-only mechanism and can neither prove
 *  nor exclude an old manager still hosting Plane 3.
 *
 *  A guard that runs after the work is not a guard, so this one reads the tri-state directly and the
 *  caller refuses BEFORE anything is minted, written or started. */
function oldHostingManagerVerdict(probe: LivenessProbe = probeLiveness): "stop-it" | "proceed" | "indeterminate" {
  const state = managerLiveness(probe);
  if (state === "unknown" || state === "unattributable") return "indeterminate";
  if (state !== "alive") return "proceed"; // dead or absent: nothing is hosting Plane 3
  return managerHasDeliveryMarker() ? "proceed" : "stop-it"; // alive: the marker decides
}

/** Cutover preflight — the FIRST action, BEFORE the daemon can bind: stop any old Plane-3-hosting
 *  manager (live `manager.pid` without the delivery-aware marker) so it never double-binds the
 *  daemon's durables. A delivery-aware (this-build) manager is left running. No-op on a fresh install. */
export async function stopOldHostingManagerIfPresent(probe: LivenessProbe = probeLiveness, signal?: SignalFn): Promise<void> {
  const verdict = oldHostingManagerVerdict(probe);
  // FIRST action, before any mint/write/start, so the refusal actually fences the daemon.
  if (verdict === "indeterminate")
    throw new Error(
      `the recorded manager pid (${readFileSync(MANAGER_PID_PATH(), "utf8").trim()}) cannot be attributed, so the delivery cutover preflight cannot run: the kernel answered neither "running" nor "no such process" (a seccomp filter or LSM policy does this inside some sandboxes).\n` +
        `Refusing before the daemon starts. If that manager is an old Plane-3-hosting one it is still bound to fanout/reader, and starting the daemon anyway would double-bind them; the daemon's own lease cannot detect that.\n` +
        `NEXT: verify the process yourself (\`ps -p <pid>\`). If it is gone, remove \`.cotal/manager.pid\` and re-run. If it is running, stop it with \`cotal down\` first.`,
    );
  if (verdict === "stop-it") {
    console.error("• stopping an old Plane-3-hosting manager before starting the delivery daemon (cutover preflight)");
    // stopManager THROWS rather than reporting a stop it did not achieve (EPERM, or a process that
    // outlived SIGTERM), so reaching the next line is the proof the old manager is gone. Letting that
    // throw propagate is the point: the daemon must not start beside a manager still bound to Plane 3.
    await stopManager(probe, signal);
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
    // Propagate the broker's transport decision. The daemon cannot derive it: it learns everything
    // from argv by design - it is a pre-minted scoped-cred client, injectable behind a SecretStore,
    // and making it read the machine-local mesh registry to pick a transport would couple a
    // hosted-composable daemon to a workstation artifact. So the launcher, which DOES know, tells it.
    //
    // Without this the daemon connects plaintext-capable to a TLS broker and nothing looks wrong,
    // because it still upgrades on the server's INFO. It holds a STANDING credential and reconnects
    // unattended, so that exposure would repeat on every reconnect with nobody watching.
    ...(o.tls ? ["--tls"] : []),
  ];
  // Internal child re-exec (the `up` that reached here already seeded); the delivery daemon does not
  // launch agents, so it skips the connector seed on boot (a direct `cotal deliver` still seeds).
  const child = spawn(node, args, { detached: true, stdio: ["ignore", fd, fd], env: { ...process.env, COTAL_SKIP_CONNECTOR_SEED: "1" } });
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
export async function ensureDelivery(o: Opts = {}, probe: LivenessProbe = probeLiveness): Promise<{ running: boolean }> {
  if (!hasAuth()) return { running: false }; // open dev mode — no daemon, agents are live-only
  if (oldHostingManagerVerdict(probe) === "stop-it") {
    console.error(
      "✗ delivery: an old Plane-3-hosting manager is still live (no delivery-aware marker). Refusing to start the daemon - run `cotal down` first, then retry.",
    );
    return { running: false };
  }
  // Mint a scoped delivery cred (used to probe readiness; for a NEW launch it is ALSO the daemon's cred,
  // written to disk). The daemon process reads the file and never holds the signer (a container mounts it
  // read-only). A reuse (daemon already up) mints a throwaway probe cred — the running daemon keeps its
  // own creds file.
  const auth = (await getSoleSpaceAuth(credsStore(), authDir(findCotalRoot())))!;
  const id = newIdentity();
  const creds = await mintCreds(auth, id, "delivery");
  const space = o.space ?? resolveSpace(process.cwd());
  const server = o.server ?? DEFAULT_SERVER;
  const deliveryState = deliveryLiveness(probe);
  // Same refusal as the manager: an unattributable pid must not be silently reused (a daemon
  // reported running that is not there) nor silently replaced (two daemons on one fanout).
  if (deliveryState === "unknown" || deliveryState === "unattributable")
    throw new Error(
      `the recorded delivery daemon pid (${readFileSync(PID_PATH(), "utf8").trim()}) cannot be attributed: the kernel answered neither "running" nor "no such process".\n` +
        `A seccomp filter or LSM policy that intercepts \`kill(pid, 0)\` does this, so it is expected inside some sandboxes and containers.\n` +
        `Cotal will not guess: reusing it would report a daemon that is not there, and starting a second would put two daemons on one fanout.\n` +
        `NEXT: verify the process yourself (\`ps -p <pid>\`). If it is gone, remove \`.cotal/delivery.pid\` and re-run. If it is running, use it or stop it.`,
    );
  let launched: number | undefined;
  if (deliveryState !== "alive") {
    // The store's put hardens `.cotal/` first (the cred is born under a private ACL, no race) and
    // lands it atomically — same path and bytes as before the seam.
    await credsStore().put(DELIVERY_CREDS_KEY, creds);
    launched = startDeliveryDetached({ ...o, space, server });
  }
  // ALWAYS wait for the daemon to be READY (lease flipped ready AFTER it bound ctl.delivery) before
  // returning — for a fresh launch AND a reused live daemon — so agents the manager spawns next find the
  // responder for their boot self-join. Non-fatal on timeout: the boot self-join reconciles with backoff,
  // which is the real safety net for a slow start or a later outage.
  //
  // WHOSE readiness matters. A fresh launch waits for THE DAEMON IT JUST STARTED: its lease holder is
  // the endpoint id of the cred written above (the daemon adopts `idFromCreds` of that file), so the
  // wait cannot be answered by some other daemon's — or a dead one's — leftover `ready:true` record.
  // A reuse adopts a daemon that was already running and cannot know its id, so it waits for any.
  const ready = await waitForDeliveryLease({ servers: server, space, creds, id: id.id, holder: launched !== undefined ? id.id : undefined });
  // A launch we performed whose process is GONE is not a slow start, and reporting it as one is the
  // #837 false-green: the daemon lost the single-flight CAS to a live-or-stale lease and exited (it
  // says so in `.cotal/delivery.log`), while this returned `running: true` over a pidfile fronting a
  // dead pid. No fallback — the caller hears it.
  if (!ready && launched !== undefined && probe(launched) === "dead")
    throw new Error(
      `the delivery daemon started for space "${space}" (pid ${launched}) exited without becoming ready, and the shard-0 lease is not held by it.\n` +
        `That is what a lost single-flight CAS looks like: another daemon holds the lease, or a crashed holder's lease has not yet expired (it does after ${LEASE_TTL_MS / 1000}s).\n` +
        `Refusing to report a daemon that is not running. The daemon logged its own reason to ${cotalPath("delivery.log")}.\n` +
        `NEXT: read that log; if no other daemon is running, wait for the stale lease to expire and re-run.`,
    );
  if (!ready)
    console.error("• delivery daemon not yet ready (responder not bound) - boot durable joins will reconcile when it is");
  return { running: true };
}

/** Stop the detached delivery daemon if we started one, and drop its creds from the store. The pid
 *  kill runs even if the creds delete fails (finally) — a delete error must never leave the daemon
 *  alive to outlive the teardown and reattach to a restarted broker; the error still propagates
 *  after the kill so the caller can surface it. */
export async function stopDelivery(probe: LivenessProbe = probeLiveness, signal?: SignalFn): Promise<void> {
  const send: SignalFn = signal ?? ((pid, sig) => process.kill(pid, sig));
  const p = PID_PATH();
  // ORDER MATTERS, AND IT USED TO BE BACKWARDS. The credential was deleted FIRST, in a try whose
  // finally then signalled and removed the pidfile unconditionally. Under a refused signal that left
  // a LIVE daemon with no pidfile and no standing credential: still connected, still serving, and its
  // reconnect and renewal source deleted out from under it, while the function returned success.
  // Nothing is removed now until the process is proven gone.
  // Once death is PROVEN, both records are stale and the pidfile goes first: a creds-delete failure
  // (a blocked path, a store error) must still propagate loudly, but it must not leave behind a
  // pidfile for a process that is definitely gone. delivery-teardown.smoke.ts pins exactly that
  // combination, and caught this when the first version of this fix ordered them the other way.
  const removeRecords = async (): Promise<void> => {
    rmSync(p, { force: true });
    await credsStore().delete(DELIVERY_CREDS_KEY);
  };
  if (!existsSync(p)) {
    await credsStore().delete(DELIVERY_CREDS_KEY); // no pid recorded: no live daemon to strand
    return;
  }
  const raw = readFileSync(p, "utf8").trim();
  const pid = parsePid(raw);
  if (pid === undefined) {
    if (raw === "") {
      await removeRecords(); // pre-protocol husk, nothing behind it
      return;
    }
    // See the manager helper: unattributable content may front a live daemon, and clearing it here
    // would also delete the standing credential of a process still using it.
    throw new Error(
      `the delivery pidfile at ${p} is unattributable (${JSON.stringify(raw)}): it may still front a running daemon nobody can identify.\n` +
        `Refusing to remove it or its standing credential, and refusing to report a clean stop.\n` +
        `NEXT: find and stop that process, then remove the file by hand.`,
    );
  }
  const before = probe(pid);
  if (before === "dead") {
    await removeRecords();
    return;
  }
  if (before === "unknown")
    throw new Error(
      `refusing to stop the delivery daemon (pid ${pid}): its liveness cannot be determined (a seccomp filter or LSM policy answers kill(pid,0) with an arbitrary errno).\n` +
        `The pidfile and standing credential are LEFT IN PLACE: removing them would strand a daemon that may still be connected, with its renewal source gone.\n` +
        `NEXT: verify with \`ps -p ${pid}\`, then stop it yourself or remove \`.cotal/delivery.pid\` if it is gone.`,
    );
  try {
    send(pid, "SIGTERM");
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "ESRCH") {
      await removeRecords(); // raced to exit between probe and signal
      return;
    }
    throw new Error(
      `refusing to stop the delivery daemon (pid ${pid}): the signal was rejected (${code ?? "unknown error"}).\n` +
        `EPERM means it belongs to another user, so it is running and not ours to stop. The pidfile and standing credential are LEFT IN PLACE.\n` +
        `NEXT: stop it as its owner, or remove \`.cotal/delivery.pid\` if you are certain it is gone.`,
    );
  }
  const deadline = Date.now() + 15_000;
  while (probe(pid) !== "dead" && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
  if (probe(pid) !== "dead")
    throw new Error(
      `the delivery daemon (pid ${pid}) accepted SIGTERM but its death could not be confirmed; its pidfile and credential were preserved rather than recording a stop that did not happen.`,
    );
  await removeRecords();
}

/** Bring up the control plane in the correct cutover order: OLD-manager preflight → delivery daemon
 *  (auth only, fails closed on a live old manager) → manager (lifecycle, writes the delivery-aware
 *  marker). The manager no longer depends on the daemon (it hosts no Plane-3), so the daemon is started
 *  first only to close the old-manager double-bind window and so freshly-spawned agents find the
 *  `ctl.delivery` responder for their boot self-join (a miss honest-degrades to live-only). */
export async function ensureControlPlane(o: Opts = {}): Promise<{ running: boolean }> {
  await stopOldHostingManagerIfPresent();
  await ensureDelivery(o);
  return ensureManager(o);
}
