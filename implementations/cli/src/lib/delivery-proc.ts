import { spawn } from "node:child_process";
import { existsSync, openSync, closeSync, writeFileSync, readFileSync } from "node:fs";
import {
  DEFAULT_SERVER,
  LEASE_TTL_MS,
  mintCreds,
  newIdentity,
  waitForDeliveryLease,
  deliveryLeaseHolderFor,
} from "@cotal-ai/core";
import { DELIVERY_CREDS_KIND, DELIVERY_LOGFILE, DELIVERY_PIDFILE, authDir, canonicalLocalProcessPath, commandIsCotalDelivery, deliveryCredsKey, findCotalRoot, getSpaceAuth, listSpaceAccounts, localProcessPath, parsePid, probeLiveness, readProcessCommand, readProcessRecord, reclaimDeadPreUpgradeRecord, segmentedKey, stopReservationPath, type CommandReader, type LivenessProbe, type LocalProcess, type LocalProcessContext, type ProcessRecord, type ProcessRecordState, workspaceSecretStore, writePidPair } from "@cotal-ai/workspace";
import { selfArgv, displayCmd } from "./self-exec.js";
import { resolveRuntimeSpace } from "./status.js";
import { cotalRoot } from "./paths.js";
import { MANAGER_PID_PATH, ensureManager, managerHasDeliveryMarker, managerLiveness, managerRecordState, stopManager } from "./manager-proc.js";
import { stopLocalProcess } from "./local-process-stop.js";
import { RESPONDER_UNBOUND_CONSEQUENCE } from "./delivery-responder.js";

/** The space this folder's commands mean, and the per-space record paths over it. The daemon is
 *  minted a space-scoped cred and binds that space's durables, so a root-scoped record gave one root
 *  one daemon by filename; every helper below therefore takes the space it is answering about. */
const folderSpace = (): string => resolveRuntimeSpace(process.cwd());
const ctx = (space: string): LocalProcessContext => ({ root: cotalRoot(), space });
/** READ-resolving: also names a pre-segmentation `delivery.pid` when that is what is on disk. */
const PID_PATH = (space: string = folderSpace()): string => localProcessPath(DELIVERY_PIDFILE, ctx(space));
// The daemon's cred goes through the secret-store seam; its key comes from workspace's per-kind
// resolver (P7 §2 rule 1) — never a hand-composed path or a copied literal. The kind is per-SPACE
// now, so the file is `.cotal/space.<hex>/delivery.creds`.
const credsStore = () => workspaceSecretStore(findCotalRoot());
/** The keys a teardown must clear for this space: the segmented one this CLI writes, and the flat
 *  pre-P7 one a root no post-P7 `up` has touched still holds. Built with {@link segmentedKey}, not
 *  the migrating resolver — a deleter must not move material into the path it is about to remove. */
const deliveryCredsKeysToClear = (space: string) => [segmentedKey(DELIVERY_CREDS_KIND, space), DELIVERY_CREDS_KIND];

/** `tls` is the broker's transport decision, propagated to the daemon's argv. It is not optional
 *  information the daemon can do without: it cannot derive the transport itself (see the note at
 *  the argv site), and omitting it leaves a standing-credential daemon connecting
 *  plaintext-capable to a TLS broker while looking entirely healthy.
 *  `wsPort` is the broker's loopback websocket listener (P2 item 6), forwarded to the manager.
 *  `noManager` (#1417) is broker-only mode: ensure the delivery daemon and NOT the manager. The
 *  caller that sets it has already refused it against a live manager (a refresh under the flag
 *  exits non-zero before reaching here), so this side never silently KEEPS or STOPS one either.
 *  `onDeliveryExit` hears the exit of a daemon this process launches; only a caller that outlives
 *  the launch (foreground `up`) can act on it. */
type Opts = { space?: string; server?: string; tls?: boolean; spawn?: string[]; runtime?: string; launch?: string; attachHost?: string; resumeAttempt?: string; resumeCommitToken?: string; wsPort?: number; maxSessions?: number; noManager?: boolean; onDeliveryExit?: (code: number | null, signal: NodeJS.Signals | null) => void };

/** The recorded daemon, attributed by {@link readProcessRecord} to a `cotal deliver` process. */
function deliveryRecordState(
  probe: LivenessProbe = probeLiveness,
  space: string = folderSpace(),
  readCommand: CommandReader = readProcessCommand,
): ProcessRecord {
  return readProcessRecord(PID_PATH(space), commandIsCotalDelivery, probe, readCommand);
}

/** {@link deliveryRecordState}'s verdict alone, for the callers that only branch on it. */
export function deliveryLiveness(
  probe: LivenessProbe = probeLiveness,
  space: string = folderSpace(),
  readCommand: CommandReader = readProcessCommand,
): ProcessRecordState {
  return deliveryRecordState(probe, space, readCommand).state;
}

/** True only if the daemon is PROVABLY running. Callers that ACT on the answer take
 *  {@link deliveryLiveness} instead; this cannot express "cannot tell". */
export function deliveryUp(space: string = folderSpace()): boolean {
  return deliveryLiveness(probeLiveness, space) === "alive";
}

/** Whether `cotal down` is stopping, or has stopped, the space's dead daemon: a live process holds the
 *  `.stopping` reservation `down` takes before its first signal, or the record is gone. A missing record
 *  proves a stop only for a daemon that cannot remove its own (one killed by a signal, or a launch that
 *  never bound), which the caller establishes. The reservation is read first because `down` releases it
 *  only after removing the record, so a stop that completes between the two reads is still seen. */
export function deliveryStoppedByDown(space: string = folderSpace()): boolean {
  const p = PID_PATH(space);
  let stopper: number | undefined;
  try {
    stopper = parsePid(readFileSync(stopReservationPath(p), "utf8"));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
  return (stopper !== undefined && probeLiveness(stopper) !== "dead") || !existsSync(p);
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
 *  A guard that runs after the work is not a guard, so this one takes the tri-state directly and the
 *  caller refuses BEFORE anything is minted, written or started. */
function oldHostingManagerVerdict(
  state: ProcessRecordState,
  space: string,
): "stop-it" | "proceed" | "indeterminate" {
  if (state === "unknown" || state === "unattributable") return "indeterminate";
  if (state !== "alive") return "proceed"; // dead or absent: nothing is hosting Plane 3
  return managerHasDeliveryMarker(space) ? "proceed" : "stop-it"; // alive: the marker decides
}

/** Cutover preflight — the FIRST action, BEFORE the daemon can bind: stop any old Plane-3-hosting
 *  manager (live `manager.pid` without the delivery-aware marker) so it never double-binds the
 *  daemon's durables. A delivery-aware (this-build) manager is left running. No-op on a fresh install. */
export async function stopOldHostingManagerIfPresent(
  probe: LivenessProbe = probeLiveness,
  space: string = folderSpace(),
): Promise<void> {
  // The refusal quotes this record and never reads the file again: the manager removes its record on
  // exit and a start replaces it, so a second read can find it gone or holding other content.
  const record = managerRecordState(probe, undefined, space);
  const verdict = oldHostingManagerVerdict(record.state, space);
  // FIRST action, before any mint/write/start, so the refusal actually fences the daemon.
  if (verdict === "indeterminate") {
    const p = MANAGER_PID_PATH(space);
    const consequence = `Refusing before the daemon starts. If that manager is an old Plane-3-hosting one it is still bound to fanout/reader, and starting the daemon anyway would double-bind them; the daemon's own lease cannot detect that.\n`;
    if (record.state === "unattributable")
      throw new Error(
        `the manager pidfile at ${p} holds content that is not a pid (${JSON.stringify(record.content)}), so the delivery cutover preflight cannot run.\n` +
          consequence +
          `NEXT: find and stop that process, then remove \`${p}\` by hand.`,
      );
    throw new Error(
      `the recorded manager pid (${record.pid}) cannot be attributed, so the delivery cutover preflight cannot run: the kernel answered neither "running" nor "no such process" (a seccomp filter or LSM policy does this inside some sandboxes).\n` +
        consequence +
        `NEXT: verify the process yourself (\`ps -p <pid>\`). If it is gone, remove \`${p}\` and re-run. If it is running, stop it with \`cotal down\` first.`,
    );
  }
  if (verdict === "stop-it") {
    console.error("• stopping an old Plane-3-hosting manager before starting the delivery daemon (cutover preflight)");
    // stopManager THROWS rather than reporting a stop it did not achieve (a refused stop, or a process
    // whose death it could not confirm), so reaching the next line is the proof the old manager is gone.
    // Letting that throw propagate is the point: the daemon must not start beside a manager still bound
    // to Plane 3.
    await stopManager(space);
  }
}

/** Start the delivery daemon detached (pid in `.cotal/delivery.<spaceKey>.pid`, output to
 *  `.cotal/delivery.<spaceKey>.log`), stopped by `cotal down`. Re-execs this CLI's `deliver` command;
 *  the daemon loads the pre-minted scoped `delivery.creds` (written by {@link ensureDelivery}) — it
 *  never sees the signer. */
export function startDeliveryDetached(o: Opts = {}): number {
  const space = o.space ?? folderSpace();
  // First, for the reason startManagerDetached states: a `selfArgv` refusal (#1629) must not reclaim a
  // pre-upgrade record, or leave a delivery log and a leaked descriptor behind. Then, as there,
  // reclaim a provably dead pre-upgrade record before claiming the canonical slot, and refuse rather
  // than start a second daemon beside a live one.
  const [node, ...self] = selfArgv();
  reclaimDeadPreUpgradeRecord(DELIVERY_PIDFILE, ctx(space));
  const fd = openSync(canonicalLocalProcessPath(DELIVERY_LOGFILE, ctx(space)), "a");
  const args = [
    ...self,
    "deliver",
    "--space",
    space,
    "--server",
    o.server ?? DEFAULT_SERVER,
    // Propagate the broker's transport decision. The daemon cannot derive it: an INJECTED-store
    // (hosted) daemon learns everything from argv and the store by design, and a workstation daemon
    // resolves the recorded mesh itself (#756) without a transport-requirement API of its own - so
    // the launcher, which DOES know, tells it in both compositions.
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
  if (o.onDeliveryExit) child.on("exit", o.onDeliveryExit);
  child.unref();
  const pidPath = canonicalLocalProcessPath(DELIVERY_PIDFILE, ctx(space)); // canonical, never a pre-upgrade name
  if (!child.pid) throw new Error("delivery daemon spawned with no pid");
  // #969/#1238: publish the pair by rename so a later teardown never sees a torn pairing.
  writePidPair(pidPath, child.pid);
  return child.pid ?? 0;
}

/** Make the server-side delivery daemon available (auth mode only). FAILS CLOSED: refuses to launch
 *  while an old Plane-3-hosting manager is live (the preflight should have stopped it) so the daemon
 *  never double-binds. Mints a SCOPED `delivery` cred from the local signer ONCE, writes it to
 *  `.cotal/delivery.creds` (0600), and launches the daemon WITHOUT signer access. Best-effort — callers
 *  treat it as non-fatal (a missing daemon degrades durable delivery, never live).
 *
 *  RETURNS TWO FACTS, NOT ONE (#1576). `running` is about the PROCESS; `responderBound` is about the
 *  `ctl.delivery` responder, which is what spawn, retirement and join actually require. They are not
 *  the same question, and collapsing them into one boolean is how a mesh came to report healthy for
 *  22 hours while none of those three operations could complete. `responderBound` is false when the
 *  readiness wait elapsed without the lease flipping ready, and absent when no daemon applies. */
export async function ensureDelivery(
  o: Opts = {},
  probe: LivenessProbe = probeLiveness,
): Promise<{ running: boolean; started?: boolean; pid?: number; responderBound?: boolean }> {
  if (!hasAuth()) return { running: false }; // open dev mode — no daemon, agents are live-only

  const space = o.space ?? folderSpace();
  if (oldHostingManagerVerdict(managerLiveness(probe, undefined, space), space) === "stop-it") {
    console.error(
      "✗ delivery: an old Plane-3-hosting manager is still live (no delivery-aware marker). Refusing to start the daemon - run `cotal down` first, then retry.",
    );
    return { running: false };
  }
  // Mint a scoped delivery cred (used to probe readiness; for a NEW launch it is ALSO the daemon's cred,
  // written to disk). The daemon process reads the file and never holds the signer (a container mounts it
  // read-only). A reuse (daemon already up) mints a throwaway probe cred — the running daemon keeps its
  // own creds file.
  const auth = (await getSpaceAuth(credsStore(), space))!;
  const id = newIdentity();
  const creds = await mintCreds(auth, id, "delivery");
  const server = o.server ?? DEFAULT_SERVER;
  const delivery = deliveryRecordState(probe, space);
  // Same refusals as the manager: a record nobody can attribute must not be silently reused (a daemon
  // reported running that is not there) nor silently replaced (two daemons on one fanout).
  if (delivery.state === "unattributable")
    throw new Error(
      `the delivery daemon pidfile at ${PID_PATH(space)} holds content that is not a pid (${JSON.stringify(delivery.content)}).\n` +
        `Refusing to start a daemon over it: that record may front a live daemon nobody can identify, and starting a second would put two daemons on one fanout.\n` +
        `NEXT: find and stop that process, then remove \`${PID_PATH(space)}\` by hand.`,
    );
  if (delivery.state === "unknown")
    throw new Error(
      `the recorded delivery daemon pid (${delivery.pid}) cannot be attributed: the kernel answered neither "running" nor "no such process".\n` +
        `A seccomp filter or LSM policy that intercepts \`kill(pid, 0)\` does this, so it is expected inside some sandboxes and containers.\n` +
        `Cotal will not guess: reusing it would report a daemon that is not there, and starting a second would put two daemons on one fanout.\n` +
        `NEXT: verify the process yourself (\`ps -p <pid>\`). If it is gone, remove \`${PID_PATH(space)}\` and re-run. If it is running, use it or stop it.`,
    );
  let launched: number | undefined;
  if (delivery.state !== "alive") {
    // The store's put hardens `.cotal/` first (the cred is born under a private ACL, no race) and
    // lands it atomically — same path and bytes as before the seam.
    // Through the per-kind RESOLVER (not `segmentedKey`): this is the absent-means-mint writer for
    // the kind, so on a root whose cred is still flat the material must move here, before the put —
    // otherwise the daemon that is about to start reads the canonical location, finds nothing, and
    // this write lands a SECOND live delivery cred beside the one the flat file still holds.
    await credsStore().put(deliveryCredsKey(space, { injected: false, root: findCotalRoot() }), creds);
    launched = startDeliveryDetached({ ...o, space, server });
  }
  // ALWAYS wait for the daemon to be READY (lease flipped ready AFTER it bound ctl.delivery) before
  // returning — for a fresh launch AND a reused live daemon — so agents the manager spawns next find the
  // responder for their boot self-join. Non-fatal on timeout: the boot self-join reconciles with backoff,
  // which is the real safety net for a slow start or a later outage.
  //
  // WHOSE readiness matters. A fresh launch waits for THE DAEMON IT JUST STARTED, so the wait cannot
  // be answered by some other daemon's - or a dead one's - leftover `ready:true` record. A reuse
  // adopts a daemon that was already running and cannot know its id, so it waits for any.
  //
  // THROUGH `deliveryLeaseHolderFor`, NOT `id.id`. This asked for the bare nkey, while the daemon's
  // endpoint stamps the PRINCIPAL dot-form into the row, so the comparison could never be true: every
  // fresh launch ran the full 8s timeout and then reported a ready daemon as not-ready. It failed in
  // the safe direction, which is why it went unnoticed, but the #837 guarantee this argument exists
  // to enforce was not actually in force - it was defeated by always-false rather than by accepting
  // anything. Found in review (#1318), where the same two namespaces were confused a third time.
  const ready = await waitForDeliveryLease({ servers: server, space, creds, id: id.id, holder: launched !== undefined ? deliveryLeaseHolderFor(creds) : undefined });
  // A launch we performed whose process is GONE is not a slow start, and reporting it as one is the
  // #837 false-green: the daemon lost the single-flight CAS to a live-or-stale lease and exited (it
  // says so in `.cotal/delivery.log`), while this returned `running: true` over a pidfile fronting a
  // dead pid. No fallback — the caller hears it.
  if (!ready && launched !== undefined && probe(launched) === "dead")
    throw new Error(
      `the delivery daemon started for space "${space}" (pid ${launched}) exited without becoming ready, and the shard-0 lease is not held by it.\n` +
        `That is what a lost single-flight CAS looks like: another daemon holds the lease, or a crashed holder's lease has not yet expired (it does after ${LEASE_TTL_MS / 1000}s).\n` +
        `Refusing to report a daemon that is not running. The daemon logged its own reason to ${canonicalLocalProcessPath(DELIVERY_LOGFILE, ctx(space))}.\n` +
        `NEXT: read that log; if no other daemon is running, wait for the stale lease to expire and re-run.`,
    );
  if (!ready)
    // #1576. THIS USED TO PRINT A PROMISE AND RETURN SUCCESS, and that combination is the defect.
    // The promise was true — `reconcileBootJoin` really does retry with capped backoff and really
    // does establish the memberships once a daemon binds — but it was the ONLY thing said, at info
    // level, once, and it described the RECOVERY rather than the state. A reporter's fleet then ran
    // 22 hours in exactly this condition: `cotal up` alive, systemctl green, and spawn, retirement
    // and join all failing, with nothing anywhere naming the responder.
    //
    // So the line now names the CONSEQUENCE first (what does not work while this holds), then the
    // recovery, and it says the wait is open-ended rather than implying it has been handled. The
    // reconcile keeps its sentence because an operator who respawns agents over this loses live
    // sessions for nothing — the daemon re-mints and the agents rejoin on their own.
    console.error(
      `! delivery daemon started but its responder is NOT BOUND yet (the shard-0 lease has not flipped ready) - ${RESPONDER_UNBOUND_CONSEQUENCE}.\n` +
        `  This does not time out on its own: the boot durable joins retry with backoff and WILL reconcile when the responder binds, however long that takes, and agents rejoin WITHOUT being respawned.\n` +
        `  Check it with \`${displayCmd()} status --components\` (delivery row) and read ${canonicalLocalProcessPath(DELIVERY_LOGFILE, ctx(space))} for the daemon's own reason.`,
    );
  // The caller hears WHICH of the two states it got. `running` still means "a daemon process is
  // there" (unchanged for every existing caller), but a caller that needs the responder — anything
  // that is about to spawn, retire or join — can now ask instead of assuming, which it could not do
  // when this returned a bare `running: true` over an admittedly unbound responder.
  return { running: true, started: launched !== undefined, ...(launched !== undefined ? { pid: launched } : {}), responderBound: ready };
}

/** The delivery daemon as a local process: `cotal down` and `up`'s teardown stop it through this one
 *  descriptor, so both take the same reservation, identity check and SIGKILL escalation. */
export const DELIVERY_PROCESS: LocalProcess = {
  kind: "local-process",
  name: "delivery",
  label: "delivery daemon",
  order: 20,
  pidFile: DELIVERY_PIDFILE,
  isOwnCommand: commandIsCotalDelivery,
};

/** Stop the space's delivery daemon, then drop its creds from the store. The stop throws unless the
 *  daemon is proven gone, so the credential is never deleted from under a daemon still running. */
export async function stopDelivery(space: string = folderSpace()): Promise<void> {
  await stopLocalProcess(DELIVERY_PROCESS, ctx(space));
  for (const k of deliveryCredsKeysToClear(space)) await credsStore().delete(k);
}

/** Bring up the control plane in the correct cutover order: OLD-manager preflight → delivery daemon
 *  (auth only, fails closed on a live old manager) → manager (lifecycle, writes the delivery-aware
 *  marker). The manager no longer depends on the daemon (it hosts no Plane-3), so the daemon is started
 *  first only to close the old-manager double-bind window and so freshly-spawned agents find the
 *  `ctl.delivery` responder for their boot self-join (a miss honest-degrades to live-only).
 *  `noManager` (#1417) stops after the daemon: a broker-only host gets delivery (auth mode) and no
 *  manager, so there is no manager pidfile to leave stale and no slot to strand. The preflight still
 *  runs above it — an old Plane-3-hosting manager must not double-bind the daemon's durables even on a
 *  host that wants no manager of its own. */
export async function ensureControlPlane(
  o: Opts = {},
): Promise<{
  running: boolean;
  started?: boolean;
  pid?: number;
  delivery?: { started: boolean; pid?: number };
  responderBound?: boolean;
}> {
  // One space for all three steps. The preflight used to resolve its own from the cwd while the two
  // ensures took `o.space`; with per-space records that would preflight one tenant's manager and then
  // start another's.
  const space = o.space ?? folderSpace();
  await stopOldHostingManagerIfPresent(probeLiveness, space);
  // The delivery answer is CARRIED, not discarded (#1576). This used to drop `ensureDelivery`'s
  // result on the floor and return only the manager's, so `cotal up` had no way to say that the
  // dependency every spawn/retirement/join needs had not come up — the boot line inside
  // `ensureDelivery` was the only trace, and it read as a progress note.
  const delivery = await ensureDelivery({ ...o, space });
  const deliveryStarted = { started: delivery.started ?? false, ...(delivery.pid !== undefined ? { pid: delivery.pid } : {}) };
  if (o.noManager) return { running: false, delivery: deliveryStarted, responderBound: delivery.responderBound };
  // `started`/`pid` distinguish a manager `ensureManager` just launched from one it found already
  // alive (#883) — carried through unchanged so the caller can name a restore instead of reprinting
  // the same line for both.
  const manager = await ensureManager({ ...o, space });
  return { ...manager, delivery: deliveryStarted, responderBound: delivery.responderBound };
}
