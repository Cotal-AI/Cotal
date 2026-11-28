import { noManagerCredentialWarning } from "../lib/daemon-credential-warning.js";
import { noteUpProjectCreated, trustFreshUpProject } from "./up-project-trust.js";
import { type ChildProcess } from "node:child_process";
import { openBrokerLog } from "../lib/broker-log.js";
import { spawnBroker } from "../lib/broker-spawn.js";
import { freezeSmokeRestoreListener, recordRestoreListenerSpawn, spawnMarkedListener } from "../lib/restore-listener-spawn.js";
import { mkdirSync, readFileSync, statSync, closeSync, realpathSync, type Stats } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import {
  isReachable,
  dialerFor,
  DEFAULT_SERVER,
  DEFAULT_SPACE,
  type BrokerTransport,
  standaloneConnectOpts,
  parseServerVersion,
  EpEnvelopeError,
  writeSecretFile,
  type AuthPrepared,
  type ChannelRegistryFile,
} from "@cotal-ai/core";
import {
  type SeatCap,
  CommandFailure,
  assertUserAuthInfo,
  authDir,
  soleSpaceOf,
  hasUserAuthState,
  listSpaceAccounts,
  canonicalRoot,
  findMesh,
  findPreparedSpace,
  homeCotalDir,
  getCurrent,
  preparedRootRemedy,
  preparedSpaceAt,
  projectRootProblem,
  projectRootProblemText,
  removePreparedSpace,
  localMeshesForRoot,
  recordMesh,
  removeMesh,
  setAdoptedCurrent,
  userAuthStateDir,
  type MeshEntry,
  type UserAuthInfo,
  readMaintenanceJournal,
  type MaintenanceLock,
  readBrokerPolicy,
  removePidPair,
  writePidPair,
  verifyIdentityPin,
  isLoopbackHost,
  recordOperationWarning,
  NATS_PIDFILE,
  MANAGER_PIDFILE,
  DELIVERY_PIDFILE,
  AUTH_PIDFILE,
  localProcessPath,
  UNTRUSTED_CERTIFICATE,
  canonicalLocalProcessPath,
  DELIVERY_LOGFILE,
  terminalWidth,
  codeSpan,
} from "@cotal-ai/workspace";
import { ensureAuthService } from "../lib/auth-proc.js";
import { c, hang, stderrLine } from "../ui.js";
import { natsServerLabel, resolveNatsServer, unreadVersion, type NatsServer } from "../lib/nats-bin.js";
import { cotalPath, cotalRoot } from "../lib/paths.js";
import { seedDefaultPersona } from "../lib/default-persona.js";
import { seedBeforeLaunch } from "../seed/launch.js";
import { deliveryUp, ensureControlPlane } from "../lib/delivery-proc.js";
import { RESPONDER_UNBOUND_CONSEQUENCE } from "../lib/delivery-responder.js";
import { displayCmd } from "../lib/self-exec.js";
import { shellWord } from "../lib/endpoint-errors.js";
import { managerUp } from "../lib/manager-proc.js";
import { recheckExistingStore, keptOnUp, selectedOnUp, type ExistingStorePin } from "./stack-up.js";
import { knownStackRecoveryHost, readStackJournal } from "../lib/stack-journal.js";
import { warnForeignStoreEntries } from "../lib/store-dir.js";
import { brokerAddressConflict } from "../lib/broker-service.js";
import { pendingOrdinaryResumes } from "./up-pending.js";
import { authTimeoutArgs, commitTransportPolicy, assertServesDialHost } from "./up-transport.js";
import { postStart, recreateMemoryBuckets } from "./up-stores.js";
import { type BrokerFacts, brokerVersion, writeOpenBrokerConf, authSetup } from "./up-broker-auth.js";
import { folderSpace } from "./up-args.js";

function waitForChildExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
  return new Promise((resolveExit) => {
    const onExit = () => finish(true);
    const timer = setTimeout(() => finish(false), timeoutMs);
    const finish = (exited: boolean) => {
      clearTimeout(timer);
      child.off("exit", onExit);
      resolveExit(exited);
    };
    child.once("exit", onExit);
  });
}

/** Listeners {@link stopFailedListener} is stopping. Their launch reports its own error, so the
 *  foreground's broker-exit handler must not report that exit as a crash and exit first. */
export const failedListeners = new WeakSet<ChildProcess>();

/**
 * Stop a listener whose launch failed before it served. A signal is not proof of exit, so SIGTERM
 * escalates to SIGKILL and `nats.pid` is removed only once the exit is observed. A listener that
 * outlives both keeps its record and fails loud with its pid. A listener whose pid publish threw
 * passes `published` false and leaves `nats.pid` as found.
 */
async function stopFailedListener(child: ChildProcess, published = true, heldLock?: MaintenanceLock): Promise<void> {
  failedListeners.add(child);
  child.kill("SIGTERM");
  if (!await waitForChildExit(child, 5_000)) {
    child.kill("SIGKILL");
    if (!await waitForChildExit(child, 5_000))
      throw new Error(`nats-server process ${child.pid ?? "unknown"} did not exit after SIGKILL`);
  }
  if (published) removePidPair(cotalPath(NATS_PIDFILE), String(child.pid));
  recordRestoreListenerSpawn(cotalRoot(), "not-started", heldLock);
}

/** Bring the space's USER-AUTH service up with the broker (user mode only — `setup.prepared` is the
 *  provider's output). Loud both ways (U5): a ready service prints the login line; a service that
 *  never became ready prints the exact consequence + recourse. Returns the registry metadata either
 *  way — the mesh IS a user-auth mesh even while its service is down (connects must say "auth
 *  service down", never fall back to static semantics) — plus `ok`, so the exiting `up` surfaces
 *  (detach / manifest / refresh-heal) turn a dead identity plane into a NON-ZERO exit: automation
 *  must not read "user mesh up" from a mesh whose every user connect will be denied. */
export async function startUserAuthService(
  space: string,
  server: string,
  setup?: { prepared?: AuthPrepared; stateDir?: string },
  publicExchange?: string[],
  quietBoot = false,
): Promise<{ userAuth?: UserAuthInfo; ok: boolean }> {
  if (!setup?.prepared || !setup.stateDir) return { ok: true };
  try {
    const raw = await ensureAuthService({ space, server, stateDir: setup.stateDir, prepared: setup.prepared, extraArgs: publicExchange });
    // The PUBLIC face's advertised URL (when enabled) supersedes the loopback bind in the registry's
    // convenience endpoint — the discovery bundle is GENERATED from what the daemon actually serves,
    // never hand-written. The provider reports it; nothing here reads provider state files.
    const base = typeof raw.publicUrl === "string" ? raw.publicUrl : String(raw.url);
    const endpoints = { url: base, ...(typeof raw.publicUrl === "string" ? { managerAuthorityUrl: `${base.replace(/\/$/, "")}/manager-service-authority` } : {}) };
    const info = assertUserAuthInfo({ ...setup.prepared.publicAuth, endpoints });
    if (!quietBoot) console.log(c.green("✓ user-auth service up") + c.dim(` - sign in with: \`cotal login --idp ${info.idp.url}\``));
    return { userAuth: info, ok: true };
  } catch (e) {
    // A typed refusal leads with its code and each detail's reason, e.g. a plane claim's
    // `unknown` liveness against its `live-peer` contention, so no caller parses the copy.
    const typed = e instanceof EpEnvelopeError
      ? ` [${[e.code, ...(e.details ?? []).map((d) => typeof d.reason === "string" ? `${d.kind}: ${d.reason}` : d.kind)].join("; ")}]`
      : "";
    stderrLine("✗ ", `user-auth service did not come up${typed} (${(e as Error).message}) - user connects to "${space}" will fail until a re-\`cotal up\` succeeds`, c.red);
    return { userAuth: assertUserAuthInfo(setup.prepared.publicAuth), ok: false };
  }
}

/** Start the CONTROL PLANE alongside the broker: old-manager preflight → delivery daemon (auth
 *  mode only) → detached manager. `up` is the launching command — since `setup` became
 *  configure-only (stage 2b), the whole local stack comes up HERE, so `spawn --detach` /
 *  cotal_spawn find a manager without any setup side effect. Coupled to the broker by the
 *  daemon's watchdog + the `up`/`down` teardown. `mgr` rides through to the manager start — the
 *  `up -f` path hands THE manager its runtime + resolved launch spec here (one manager per space,
 *  so the launch can never be a second supervise). Returns the control plane it ensured, or
 *  `undefined` when it is degraded, so a caller whose output claims a manager (the `up -f` launching
 *  line) can tell the truth. */
export async function startDeliveryWithBroker(
  space: string,
  server: string,
  /**
   * Whether this listener requires TLS, decided by the CALLER.
   *
   * NON-OPTIONAL, for exactly the reason {@link DetachOpts.transport} is. This used to be an
   * optional `transport` that the callee fell back on `readBrokerPolicy(cotalRoot())` for whenever
   * it was absent — and the refresh path (#836) never passed it. That path decides the same fact
   * from the mesh-registry entry AND the live `INFO`, refuses on any disagreement, and then handed
   * the decision to nobody: a root whose registry records `tlsRequired` while holding no
   * `broker-policy.json` (registered with `cotal meshes add --tls`, or a mesh that predates the
   * policy file) relaunched the delivery daemon FLAGLESS against a TLS broker. Nothing looked
   * wrong, because the daemon still upgrades on the server's unauthenticated INFO — and it holds a
   * STANDING credential and reconnects unattended, so that exposure repeats with nobody watching.
   *
   * A second durable record consulted in the callee is how the caller's copy went silently unused.
   * One decision, and it arrives as an argument.
   */
  tlsRequired: boolean,
  mgr?: {
    runtime?: string;
    launch?: string;
    attachHost?: string;
    resumeAttempt?: string;
    resumeCommit?: { path: string; sha256: string };
    /** P2 item 6: broker ws listener port for the console session client. */
    wsPort?: number;
    maxSessions?: number;
    managerName?: string;
    managerSeatCap?: SeatCap;
    /** #1417 broker-only mode: ensure the delivery daemon and not the manager. */
    noManager?: boolean;
    /** The mesh is open, so no delivery daemon starts, whatever accounts the root holds. */
    open?: boolean;
    /** #2469: the foreground owner's restart hook for a daemon this launch starts. */
    onDeliveryExit?: (code: number | null, signal: NodeJS.Signals | null) => void;
  },
  afterDelivery?: () => Promise<void>,
  isStopping?: () => boolean,
): Promise<Awaited<ReturnType<typeof ensureControlPlane>> | undefined> {
  try {
    const plane = await ensureControlPlane({ space, server, tls: tlsRequired, ...(mgr ?? {}) }, afterDelivery);
    // #1576: `up` either BINDS the responder or SAYS SO HERE. The delivery daemon is a hard
    // dependency of spawn, retirement and the durable backstop, and this function used to return `true` for a boot
    // that started a daemon whose responder never bound — so `cotal up` printed its success banner
    // over a control plane that could not perform any of the three. The reporter's fleet ran 22
    // hours in that state. This is not a failure of `up` (live messaging is unaffected and the
    // responder may still bind), so it does not throw; it states the condition and its consequence.
    if (plane.responderBound === false)
      console.error(
        c.yellow(`! delivery responder did not bind before this boot finished - ${RESPONDER_UNBOUND_CONSEQUENCE}`) +
          c.dim(`\n  The daemon process is running and the wait is open-ended; boot durable joins reconcile by themselves once it binds (agents do NOT need respawning).\n  Watch it with \`${displayCmd()} status --components\`.`),
      );
    return plane;
  } catch (e) {
    // A running mesh must report its missing control plane. A foreground stop can remove the
    // manager while this startup observation is still pending; that is intentional teardown.
    if (!isStopping?.()) reportDegradedControlPlane((e as Error).message);
    return undefined;
  }
}

/** The degraded control plane on stderr: each line of `why`, then its consequence, wrapped to the
 *  terminal as every other warning is. */
export function reportDegradedControlPlane(why: string): void {
  const [first, ...rest] = why.split("\n");
  stderrLine("! ", `control plane degraded: ${first}`, c.dim);
  for (const line of [...rest, "Spawn and retirement require a functioning control plane."]) stderrLine("  ", line, c.dim);
}

/**
 * Publish a spawned listener's pid, and bind a maintenance-bound one to its attempt, before anything
 * waits on it. A launch that dies before its listener serves then leaves `nats.pid` for `cotal down`
 * and a journal naming the exact process for recovery to adopt or retire. A publish or bind that
 * throws stops the listener. Both launch modes call it right after the spawn.
 */
export async function recordSpawnedListener(child: ChildProcess, startedAt: string, bound?: DetachOpts["boundListener"], heldLock?: MaintenanceLock): Promise<void> {
  if (!child.pid) throw new Error("nats-server spawned with no pid");
  try {
    writeSecretFile(cotalPath("stack-home.json"), JSON.stringify({ home: canonicalRoot(homeCotalDir()) }));
    // The listener is running and its spawn mark is durable, but its pid is not published.
    if (bound && process.env.COTAL_SMOKE_EXIT_BEFORE_RESTORE_LISTENER_PID === "1") process.exit(87);
    writePidPair(cotalPath(NATS_PIDFILE), child.pid); // #969/#1238: publish the pair by rename, never torn
  } catch (error) {
    // The entry at `nats.pid` may be the one that refused the publish (a directory there fails the
    // rename), so it is left as found: unrecording would read it and throw over this error.
    await stopFailedListener(child, false, heldLock);
    throw error;
  }
  if (!bound) return;
  if (process.env.COTAL_SMOKE_EXIT_AFTER_RESTORE_LISTENER_SPAWN === "1") process.exit(87);
  try {
    bound.onSpawn(child.pid, startedAt);
  } catch (error) {
    await stopFailedListener(child, true, heldLock);
    throw error;
  }
}

/**
 * Everything between spawning a listener and serving it: readiness, the broker version read and a
 * bound listener's identity check. Foreground `up` and {@link startMeshDetached} both call it, so a
 * guard added here reaches both launch modes (#2924).
 *
 * A listener that never answers or whose version read throws is stopped and its `nats.pid` removed
 * before `up` fails. Nothing has recorded the mesh yet, so a listener left running would hold the
 * port with no registry entry. A bound listener that fails its identity check is kept: its
 * maintenance journal is already bound to it.
 */
export async function awaitSpawnedListener(l: {
  child: ChildProcess;
  /** The nats-server that was spawned, named when its exit ends the wait. */
  executable: NatsServer;
  server: string;
  space: string;
  creds?: string;
  /** The listener serves TLS, so a certificate this client refuses ends the wait. */
  tls: boolean;
  /** Where the listener's output goes, named when it never answers. */
  log: string;
  boundListener?: DetachOpts["boundListener"];
  /** The startup lock, when this launch already holds it. */
  heldLock?: MaintenanceLock;
}): Promise<void> {
  const { child, server, space } = l;
  let facts: BrokerFacts;
  try {
    if (!(await waitReady(server, l.creds, l.tls, l.log))) throw exitedBeforeReady(l) ?? new Error(`nats-server did not become reachable at ${server} - see ${l.log}`);
    facts = await brokerVersion(server, space, l.creds);
  } catch (e) {
    await stopFailedListener(child, true, l.heldLock);
    throw e;
  }
  if (belowPresenceSafeBroker(facts.version) && facts.presenceFileBacked)
    console.error(
      c.yellow(
        `! nats-server ${facts.version} is below 2.14.5 and the presence bucket of "${space}" is file-backed: it can latch after a stall and close the mesh to new joins (#1356); put a nats-server 2.14.5 or newer on PATH (it wins over the bundled one)`,
      ),
    );
  if (l.boundListener) await l.boundListener.verify();
}

/** The failure of a listener that exited before it answered: the executable, the exit code or signal
 *  Node observed, and where its output went. Undefined when no exit was observed, so a listener that
 *  only stayed silent keeps an unconfirmed outcome. */
function exitedBeforeReady(l: { child: ChildProcess; executable: NatsServer; server: string; log: string }): CommandFailure | undefined {
  const { exitCode, signalCode } = l.child;
  if (exitCode === null && signalCode === null) return undefined;
  const exit = exitCode !== null ? `exited with code ${exitCode}` : `was stopped by ${signalCode}`;
  return new CommandFailure("failed", "OPERATION_FAILED", `${natsServerLabel(l.executable)} ${exit} before it answered at ${l.server}; see ${l.log}`, {
    target: { executable: l.executable.path, ...(exitCode !== null ? { exitCode } : { signal: signalCode }), server: l.server, log: l.log },
    remedy: listenerExitRemedy(l.executable, l.log),
  });
}

/** The next step for a listener that exited before it answered: read its output, then fix a
 *  nats-server found on PATH or take it off PATH, and start again. */
export function listenerExitRemedy(executable: NatsServer, log: string): string {
  return executable.source === "path" ? `read ${log}, then fix ${executable.path} or take it off PATH so cotal uses its bundled nats-server, and run \`cotal up\` again` : `read ${log}, then run \`cotal up\` again`;
}

/**
 * Everything a launch runs once its listener answers: the space setup, the user-auth service, the
 * mesh record, the transport commit and the control plane. Foreground `up` and
 * {@link startMeshDetached} both call it, so the two launch modes cannot drift apart (#2496).
 *
 * A fresh boot whose setup throws stops the listener and removes `nats.pid` before rethrowing the
 * original error. Nothing has recorded the mesh yet, so a listener left running would hold the port
 * with no registry entry for `cotal down` to reach. A channel seed with an unparseable value fails
 * here. A resume keeps its listener: its maintenance journal is already bound to it.
 */
export async function serveReadyListener(l: {
  child: ChildProcess;
  server: string;
  space: string;
  storeDir: string;
  setup?: Awaited<ReturnType<typeof authSetup>> & { creds: string };
  maxPayload?: number;
  seedFile?: ChannelRegistryFile;
  /** `--recreate-issued-stores`: the new backup directory the fresh boot's stream setup uses. */
  recreateIssuedStores?: string;
  /** `--recreate-membership-store`: explicit stopped-space File to Memory conversion. */
  recreateMembershipStore?: boolean;
  transport: BrokerTransport;
  /** The raw `--host` flag, so the record can tell an operator's address from the loopback default. */
  host?: string;
  maxSessions?: number;
  managerName?: string;
  managerSeatCap?: SeatCap;
  maxFileStore?: number;
  publicExchange?: string[];
  resumeAttempt?: string;
  resumeCommit?: { path: string; sha256: string };
  runtime?: string;
  launch?: string;
  noManager?: boolean;
  quietBoot?: boolean;
  onDeliveryExit?: (code: number | null, signal: NodeJS.Signals | null) => void;
  /** Suppress startup failure diagnostics while a foreground guarded stop is in progress. */
  isStopping?: () => boolean;
  /** The startup lock, when this launch already holds it. */
  heldLock?: MaintenanceLock;
}): Promise<{ authService: boolean; controlPlane: Awaited<ReturnType<typeof ensureControlPlane>> | undefined }> {
  const { child, server, space, setup, transport } = l;
  try {
    if (l.resumeAttempt) {
      const ordinaryResume = pendingOrdinaryResumes.has(l.resumeAttempt);
      await recreateMemoryBuckets(server, space, setup, ordinaryResume ? { convertMembership: l.recreateMembershipStore === true } : undefined,
        ordinaryResume ? l.seedFile : undefined);
    } else {
      await postStart(server, space, setup, l.seedFile, l.recreateIssuedStores, l.recreateMembershipStore, true);
    }
  } catch (e) {
    await stopFailedListener(child, true, l.heldLock);
    throw e;
  }
  // Register the prepared trust before delivery starts. Auth follows delivery's liveness oracle,
  // then the manager: a crashed auth claim cannot be reclaimed while that oracle is absent.
  let svc: { ok: boolean; userAuth?: UserAuthInfo } = {
    ok: setup?.prepared === undefined,
    ...(setup?.prepared ? { userAuth: assertUserAuthInfo(setup.prepared.publicAuth) } : {}),
  };
  // Record BEFORE the control plane comes up: the manager's fail-closed mode detection requires
  // an authoritative registry entry (marker-without-registry is a refused start, not a guess),
  // so the record must exist by the time it boots. A manager/delivery failure after this leaves
  // a recorded-but-degraded mesh — the documented, healable posture.
  // Read the prior host and session limit before replacing the registry entry on resume.
  const attachHost = attachHostFor(space, l.host);
  const maxSessions = maxSessionsFor(space, l.maxSessions);
  try {
    recordOurMesh({
      space, server, root: cotalRoot(),
      mode: setup?.prepared ? "user" : setup ? "auth" : "open",
      // Record the transport decision even for plaintext. Omit the host unless the operator chose one.
      tlsRequired: transport.kind === "tls-required",
      ...(svc.userAuth ? { userAuth: svc.userAuth } : {}),
      ...(attachHost ? { attachHost } : {}),
      ...(maxSessions !== undefined ? { maxSessions } : {}),
      ...(l.maxFileStore !== undefined ? { maxFileStore: l.maxFileStore } : {}),
      storeDir: l.storeDir,
      ts: new Date().toISOString(),
    }, "started", l.quietBoot);
  } catch (e) {
    await stopFailedListener(child, true, l.heldLock);
    throw e;
  }
  // Commit the policy only for a listener that is up and recorded (S5), and before the control
  // plane (S9). startDeliveryWithBroker is HANDED the transport decision, so it does not depend on
  // the file at all.
  commitTransportPolicy(cotalRoot(), transport, l.quietBoot, server, { authTimeout: setup?.authTimeout, maxPayload: l.maxPayload ?? setup?.maxPayload, accountResolver: setup?.accountResolver });
  // An open mesh has no delivery daemon. Its mode is passed down because the root can still hold a
  // static stack's accounts. Class-2 credential renewal is NOT wired here: the MANAGER is the
  // renewal owner (it is resident in every mesh mode, where a foreground `up` process is not).
  const controlPlane = await startDeliveryWithBroker(space, server, transport.kind === "tls-required", {
    open: setup === undefined,
    onDeliveryExit: l.onDeliveryExit,
    runtime: l.runtime,
    launch: l.launch,
    // The address the broker was bound to. This is what lets `cotal attach` reach this manager
    // from another machine; without it the attach face stays loopback-only, so exposing terminals
    // is never a side effect of anything but the operator binding the mesh somewhere reachable.
    attachHost,
    maxSessions,
    managerName: l.managerName,
    managerSeatCap: l.managerSeatCap,
    noManager: l.noManager,
    resumeAttempt: l.resumeAttempt,
    resumeCommit: l.resumeCommit,
    wsPort: setup?.wsPort, // P2 item 6: the console session client's broker ws port
  }, async () => {
    svc = await startUserAuthService(space, server, setup, [...(l.publicExchange ?? []), ...authTimeoutArgs(setup?.authTimeout)], l.quietBoot);
    if (svc.userAuth) recordOurMesh({ space, server, root: cotalRoot(), mode: "user", userAuth: svc.userAuth, ts: new Date().toISOString() }, "refresh", true);
  }, l.isStopping);
  const registered = findMesh(space);
  if (registered) recordOurMesh(registered, "refresh", true);
  seedPersonaAfterUp(cotalRoot(), l.quietBoot);
  return { authService: svc.ok, controlPlane };
}

export interface DetachOpts {
  /**
   * The listener's transport, resolved and validated by the CALLER.
   *
   * NON-OPTIONAL. This function used to re-derive it here from `opts`, which never carried
   * `--tls-cert`/`--tls-key` — so `cotal up --detach --tls-cert …` validated the pair, dropped it at
   * this boundary, fell through to the recorded policy (absent on a first enable), and served
   * PLAINTEXT while printing `✓ mesh up`. Re-deriving a decision in the callee is what let the
   * caller's copy be silently unused; the fix is that there is one decision and it arrives as an
   * argument.
   */
  transport: BrokerTransport;
  server?: string;
  storeDir?: string;
  /** A store that must already exist with this identity. Preparation rechecks it instead of
   *  creating the directory, and refuses a missing, replaced or relinked store. */
  existingStore?: ExistingStorePin;
  /** JetStream file storage cap in bytes (`--max-file-store`), rendered and recorded by this boot. */
  maxFileStore?: number;
  logFile?: string;
  logfileSizeLimit?: number;
  logfileMaxNum?: number;
  /** WebSocket listener port required by a controller manager that stays running. */
  wsPort?: number;
  /** The auth callout timeout in seconds (`--auth-timeout`). Absent: the root's recorded one. */
  authTimeout?: number;
  /** The broker's payload limit in bytes (`--max-payload`). Absent: the root's recorded one. */
  maxPayload?: number;
  /** How the broker resolves space accounts (`--account-resolver`). Absent: the root's recorded one. */
  accountResolver?: "memory" | "full";
  space?: string;
  open?: boolean;
  /** USER MODE: enable per-user auth (presence = on; `idpUrl` pins the IdP on first enable). */
  userAuth?: { idpUrl?: string };
  /** Rotate the space's system account before rendering the broker config, re-minting the two $SYS
   *  creds against the successor. Only this boot (and the foreground one) may set it: rotation is
   *  complete only when the broker it starts is the one carrying the rewritten config. */
  rotateSys?: boolean;
  /** `--recreate-issued-stores`: back up and delete the space's pre-retention issued-authority stores
   *  into this new directory before the fresh boot's stream setup creates them again. */
  recreateIssuedStores?: string;
  /** Explicitly replace the stopped space's legacy File membership feed during setup. */
  recreateMembershipStore?: boolean;
  host?: string;
  /** Validated channel-registry seed from the startup file or manifest. */
  seed?: ChannelRegistryFile;
  /** PUBLIC-exchange daemon argv (`--exchange-public-port` et al), threaded verbatim to the
   *  auth-service daemon when THIS boot starts it. */
  publicExchange?: string[];
  /** Manifest launch (`cotal up -f`): the ONE control-plane manager started alongside the broker
   *  carries this runtime + resolved launch-spec path — never a second supervise (singleton lease). */
  runtime?: string;
  launch?: string;
  resumeAttempt?: string;
  resumeCommit?: { path: string; sha256: string };
  maxSessions?: number;
  managerName?: string;
  managerSeatCap?: SeatCap;
  /** #1417 broker-only boot (`--no-manager`): no manager starts with this broker. An `up -f` under
   *  the flag boots the broker + channels and launches NO agents from this host — a manifest's
   *  agents are booted by its manager, so a launch spec under `--no-manager` would promise a boot
   *  nothing can deliver. Refused at the flag level; carried here so every path is explicit. */
  noManager?: boolean;
  /** Fresh-team human report owns stdout; omit helper progress notes, retain stderr failures. */
  quietBoot?: boolean;
  /** Maintenance-bound listener (restore target or ordinary-resume source): named spawn, durable
   *  ownership bind immediately after, wire verification after readiness. */
  boundListener?: {
    serverName: string;
    serverNonce: string;
    onSpawn(pid: number, startedAt: string): void;
    verify(): Promise<void>;
  };
  /** The startup lock, when this launch already holds it. The spawn mark journals under that lock. */
  heldLock?: MaintenanceLock;
}

/** Prepare the existing broker's local trust, configuration and launch inputs without starting a
 *  listener, auth service, delivery daemon or manager. This is an explicit mutating phase, not a
 *  dry-run or service-adapter planning hook. Its returned setup includes private authority material
 *  for the coordinating caller only; it must not be logged or serialized into a public receipt. */
export async function prepareBrokerStart(opts: DetachOpts) {
  const server = opts.server ?? DEFAULT_SERVER;
  const useAuth = !opts.open;
  // Belt on the one boot that both renders the broker config and can be reached by any caller: an
  // open boot skips `authSetup` entirely, so a `rotateSys` arriving here would be dropped in silence
  // rather than refused. Callers guard this too; this is the seam that cannot be bypassed.
  if (opts.rotateSys && !useAuth)
    throw new Error("startMeshDetached: --rotate-sys is for auth meshes; an open mesh has no system account or $SYS credentials to rotate");
  const space = opts.space ?? folderSpace();
  ensureRootForSpace(space); // may pin the cwd as this space's root — before any cotalPath use
  refuseStartOverUserState(Boolean(opts.open), opts.userAuth !== undefined, space);
  const root = cotalRoot();
  const storeDir = opts.storeDir ? resolve(opts.storeDir) : cotalPath("nats");
  if (opts.storeDir) warnForeignStoreEntries(storeDir);
  if (opts.existingStore) {
    if (opts.existingStore.named !== storeDir) throw new Error("prepareBrokerStart: the pinned existing store is not the store being prepared");
    recheckExistingStore(opts.existingStore, { space, storeDir });
  } else mkdirSync(storeDir, { recursive: true, mode: 0o700 });
  await claimSpace(space, server, root);
  const host = opts.host ?? "127.0.0.1";
  // The transport arrives decided. The dial-host SAN is re-checked here because THIS is where the
  // effective server is finally known — a manifest may name a different host than the flags did, and
  // a certificate that is valid for one is not thereby valid for the other.
  const transport = assertServesDialHost(opts.transport, new URL(server).hostname);
  if (opts.logFile === undefined && (opts.logfileSizeLimit !== undefined || opts.logfileMaxNum !== undefined))
    throw new Error("rotation bounds require --log-file");
  const logFile = opts.logFile === undefined ? undefined : resolve(opts.logFile);
  if (logFile !== undefined) mkdirSync(dirname(logFile), { recursive: true, mode: 0o700 });
  if (logFile !== undefined) {
    let fd: number | undefined;
    try { fd = openBrokerLog(logFile); } finally { if (fd !== undefined) closeSync(fd); }
  }
  const setup = useAuth ? await authSetup(storeDir, server, space, host, opts.userAuth, transport, opts.rotateSys, opts.maxFileStore, opts.quietBoot, { authTimeout: opts.authTimeout, maxPayload: opts.maxPayload, accountResolver: opts.accountResolver, manager: opts.noManager !== true, logFile, logfileSizeLimit: opts.logfileSizeLimit, logfileMaxNum: opts.logfileMaxNum, wsPort: opts.wsPort }) : undefined;
  const maxPayload = setup?.maxPayload ?? opts.maxPayload ?? readBrokerPolicy(root)?.maxPayload;
  const port = Number(new URL(server).port) || 4222;
  // Same rule as the foreground path: every route to a listener names its transport (see
  // `writeOpenBrokerConf`). Detach must not be the mode where the fence quietly does not apply.
  const renderingBinary = setup?.brokerBinary ?? await resolveNatsServer();
  if (!renderingBinary.version) throw unreadVersion(renderingBinary);
  const confPath = setup ? setup.confPath : writeOpenBrokerConf(storeDir, space, { brokerVersion: renderingBinary.version, port, host, transport, maxFileStore: opts.maxFileStore, maxPayload, logFile, logfileSizeLimit: opts.logfileSizeLimit, logfileMaxNum: opts.logfileMaxNum });
  // Trust preparation awaits; the pinned store is checked again before its config is handed back.
  if (opts.existingStore) recheckExistingStore(opts.existingStore, { space, storeDir });
  const args = [
    "-c", confPath,
    ...(opts.boundListener ? ["--name", opts.boundListener.serverName] : []),
  ];
  const { path: bin, source, version } = renderingBinary;
  return { root, server, space, useAuth, storeDir, host, transport, setup, maxPayload, confPath, args, bin, source, version };
}

/**
 * Start a background nats-server (JetStream), wait until it's reachable, pre-create the
 * space's streams, and leave it running detached (pid in `.cotal/nats.pid`). Used by
 * `up --detach`. The child writes to the log file, so it survives the parent exiting.
 */
export async function startMeshDetached(
  // The `= {}` default is gone with the optional transport: an options object that can be omitted
  // entirely cannot carry a mandatory decision.
  opts: DetachOpts,
): Promise<{ server: string; pid: number; executable: string; controlPlane: boolean; authService: boolean; deliveryResponderBound: boolean | null; delivery: boolean; deliveryLost?: string; manager: boolean }> {
  const { server, space, useAuth, storeDir, transport, setup: brokerSetup, maxPayload, args, bin, source, version } = await prepareBrokerStart(opts);
  await seedBeforeLaunch();
  const setup = brokerSetup && { ...brokerSetup, creds: await brokerSetup.mintProvisioner() };
  const logPath = cotalPath("nats.log");
  const fd = openBrokerLog(logPath);
  const listenerStartedAt = new Date().toISOString();
  let child: ChildProcess;
  try {
    child = spawnMarkedListener(cotalRoot(), opts.boundListener, () =>
      spawnBroker(bin, args, { cwd: cotalRoot(), detached: true, stdio: ["ignore", fd, fd], windowsHide: true }), opts.heldLock);
    freezeSmokeRestoreListener(child);
  } finally { closeSync(fd); }
  await recordSpawnedListener(child, listenerStartedAt, opts.boundListener, opts.heldLock);
  child.unref();

  await awaitSpawnedListener({ child, executable: { path: bin, source, version }, server, space, creds: setup?.creds, tls: transport.kind === "tls-required", log: logPath, boundListener: opts.boundListener, heldLock: opts.heldLock });
  const { authService, controlPlane } = await serveReadyListener({
    child, server, space, storeDir, setup, seedFile: opts.seed, transport, maxPayload,
    ...(opts.recreateIssuedStores !== undefined ? { recreateIssuedStores: opts.recreateIssuedStores } : {}),
    ...(opts.recreateMembershipStore ? { recreateMembershipStore: true } : {}),
    host: opts.host,
    maxSessions: opts.maxSessions,
    managerName: opts.managerName,
    managerSeatCap: opts.managerSeatCap,
    maxFileStore: opts.maxFileStore,
    publicExchange: opts.publicExchange,
    resumeAttempt: opts.resumeAttempt,
    resumeCommit: opts.resumeCommit,
    runtime: opts.runtime,
    launch: opts.launch,
    noManager: opts.noManager,
    quietBoot: opts.quietBoot,
    heldLock: opts.heldLock,
  });
  if (opts.noManager && useAuth && controlPlane) recordOperationWarning(await noManagerCredentialWarning(cotalRoot(), space));
  const delivery = useAuth && deliveryUp(space);
  // A daemon this boot started can still stop before the boot ends, such as on a SIGTERM while the
  // manager starts, and it removes its own record as it goes.
  const lost = controlPlane?.delivery?.started && !delivery ? controlPlane.delivery : undefined;
  return {
    server,
    pid: child.pid ?? 0,
    executable: natsServerLabel({ path: bin, source, version }),
    controlPlane: controlPlane !== undefined,
    authService,
    deliveryResponderBound: useAuth ? controlPlane?.responderBound === true : null,
    delivery,
    ...(lost ? { deliveryLost: `the delivery daemon started for space "${space}" (pid ${lost.pid}) exited before this boot finished. It logged its reason to ${canonicalLocalProcessPath(DELIVERY_LOGFILE, { root: cotalRoot(), space })}` } : {}),
    manager: managerUp(space),
  };
}

/** Refuse a broker address another program holds without answering NATS, such as a web server, as
 *  the controller stack refuses it. nats-server would exit on its bind with only a log line, and the
 *  readiness probe would wait on that program instead. `command` is the start the remedy reruns. */
export async function assertBrokerAddressFree(server: string, command: Parameters<typeof brokerAddressConflict>[1], bindHost?: string, waitForTimeWait = false): Promise<void> {
  const conflict = await brokerAddressConflict(server, command, bindHost, waitForTimeWait ? (address, seconds) => {
    process.stderr.write(`Waiting up to ${seconds} seconds for TIME-WAIT to clear on the broker address ${address}\n`);
  } : undefined);
  if (!conflict) return;
  throw new CommandFailure("refused", "CONFLICT", `${conflict.message} (bind failed: address already in use); no broker was launched`, {
    target: { root: cotalRoot(), server, bindError: "EADDRINUSE" }, remedy: conflict.remedy,
  });
}

/** THE FLIP: a start without `--user-auth` must never boot a broker over a root whose space has
 *  user-auth state on disk. `--open` would serve the space's existing JetStream store to anyone and
 *  re-record the mesh "open" over its user entry; a static start would boot without the callout that
 *  state belongs to. Refused before the store, the space claim or the trust is touched, so the
 *  refusal is a refusal and not an unconfirmed outcome. authSetup keeps the same rule for the
 *  routes that reach it without passing here. */
export function refuseStartOverUserState(open: boolean, userAuth: boolean, space: string): void {
  if (userAuth || !hasUserAuthState(cotalRoot(), space)) return;
  const stateDir = userAuthStateDir(cotalRoot(), space);
  throw new CommandFailure("refused", "CONFLICT", `space "${space}" has user auth enabled (state under ${stateDir})${open ? ", and --open would serve its streams without auth" : ""}; nothing was started`, {
    target: { root: cotalRoot(), space },
    remedy: `${open ? "replace --open with --user-auth" : "add --user-auth"} to start it with user auth, or remove ${shellWord(stateDir)} deliberately to disable user auth (existing logins and grants die with it)`,
  });
}

/** Pin cwd as its own mesh root when the nearest ancestor root already belongs to a DIFFERENT
 *  space — mode-independent.
 *
 *  Auth path: a root's `.cotal/auth` is space-bound, so an explicit `--space` naming another space
 *  cannot share that trust material. Open path: the same ancestor still owns policy, store, pid
 *  and MeshEntry; reusing it for a second space collides those (S4 open arm — child `--open --tls-*`
 *  wrote the parent's broker-policy and nats.pid while a second broker shared the JetStream store).
 *
 *  A mismatch only exists when the resolved space differs from what the ancestor already hosts.
 *  When the root was merely inherited (cwd has no `.cotal`), honor the new-space intent by making
 *  cwd its own root. Only a folder that itself holds the other space's material refuses.
 *  (When multi-space-per-root lands, that refusal becomes provision-the-new-space instead.)
 *
 *  The question this asks is "does this root hold the space being booted", NOT "what is THE space of
 *  this root". A root holding several tenants has no sole space, and asking for one there threw
 *  before the boot could reach the config render - so a `cotal up --space alpha` against a root that
 *  legitimately holds alpha and beta refused on ambiguity that its own `--space` had already
 *  resolved. The tenant list answers the real question without picking. */
export function ensureRootForSpace(space: string, separateRootNeedsPreparation = false): void {
  const root = cotalRoot();
  const cwd = process.cwd();
  // A prepared space starts only in the root `cotal space create` gave it. Checked before the mkdir
  // below, so a refused start leaves nothing behind.
  const prepared = findPreparedSpace(space);
  if (prepared && canonicalRoot(prepared.root) !== canonicalRoot(root)) {
    const problem = projectRootProblem(prepared.root);
    throw new CommandFailure("refused", "TARGET_UNAVAILABLE", `space "${space}" is prepared in ${prepared.root}${problem ? `, which ${projectRootProblemText(problem)}` : ""}`, {
      target: { space, root: prepared.root },
      remedy: problem ? preparedRootRemedy(space, problem, "start it here")
        : `start it in its folder with \`cotal up --root ${shellWord(prepared.root)} --space ${space}\`, or \`cotal space forget ${space}\` to start it here`,
    });
  }
  // Auth material, a locally started registration, or a preparation names what this root hosts.
  // A remote registration uses the root as a connection folder, not as a stack root.
  const hosted = listSpaceAccounts(authDir(root));
  if (hosted.includes(space)) return;
  const existing = hosted.length
    ? hosted
    : [localMeshesForRoot(root)[0]?.space ?? preparedSpaceAt(root)?.space].filter((s): s is string => !!s);
  if (existing.length === 0 || existing.includes(space)) return;
  const names = existing.map((s) => `"${s}"`).join(", ");
  if (root !== cwd) {
    if (mkdirSync(join(cwd, ".cotal"), { recursive: true, mode: 0o700 }) !== undefined) noteUpProjectCreated(cwd);
    console.log(c.dim(`nearest mesh root ${root} hosts ${names} - making this folder its own root for "${space}"`));
    return;
  }
  const separate = separateRootNeedsPreparation
    ? `prepare a different folder with ${codeSpan(`cotal space create --root <new-folder> -- ${shellWord(space)}`)}, then repeat the startup from the original working directory with --root set to that folder and the other options unchanged`
    : `start "${space}" from a different folder (it becomes that mesh's own root)`;
  throw new CommandFailure("refused", "CONFLICT", `this folder is the root of ${names} (${root}/.cotal), so it can't also run "${space}"`, {
    target: { space, root, hosted: existing },
    remedy: `run ${existing.length === 1 ? names : "one of those"} with ${codeSpan(`cotal up --root ${shellWord(root)} --space ${existing.length === 1 ? shellWord(existing[0]!) : "<name>"}`)}, or ${separate}`,
  });
}

/** Whether `space` is the default space a bare `up` starts because this folder names none. */
export function unnamedDefault(root: string, space: string): boolean {
  return space === DEFAULT_SPACE && soleSpaceOf(authDir(root)) === undefined && !preparedSpaceAt(root) && !localMeshesForRoot(root).length && !readStackJournal(root);
}

/** The remedy for a hand-registered (`origin === "manual"`) space `claimSpace` refuses to touch.
 *  Branches on whether the REGISTERED server is loopback, the one authority for that being
 *  `isLoopbackHost` (`@cotal-ai/workspace`) — never a second opinion here.
 *
 *  Non-loopback: the mesh runs on another machine and this one does not take over its control
 *  plane by deleting the registry route (that route is what attach, spawn-from-anywhere, and
 *  every read verb hang off) or by forking the identity under a different `--space`. The actual
 *  next step is running that control plane FROM here, against the broker the record already
 *  names: `cotal supervise` (plus `cotal deliver` for the daemon). Dropping the record
 *  (`meshes rm`) is a separate decision for a genuinely stale record, out of scope here.
 *
 *  Loopback: unchanged — a loopback registration this machine cannot reach the "real" mesh behind
 *  (or is stale) keeps the original two-way remedy, byte for byte.
 *
 *  A server string `new URL` rejects is a record shape this function never validated before
 *  (nothing here parsed it), so it keeps the loopback wording rather than growing a parser. */
function manualClaimRemedy(space: string, server: string): string {
  let loopback = true;
  try {
    loopback = isLoopbackHost(new URL(server).hostname);
  } catch {
    loopback = true;
  }
  if (!loopback)
    return `\`cotal supervise --space ${space} --server ${server}\` to run its control plane from here (and \`cotal deliver --space ${space} --server ${server}\` for the daemon)`;
  return `\`cotal meshes rm ${space}\` to drop that record first, or start this one under a different \`--space\``;
}

/** Where a prior holder's absolute root physically resolves, or undefined when it is proven gone: it
 *  does not resolve (ENOENT, ENOTDIR) or resolves to something other than a directory. Any other
 *  failure, such as EACCES, EPERM, EIO or ELOOP, proves nothing about the root or its journal, so the
 *  name is kept and the refusal says why. No lexical spelling stands in for the physical path: under
 *  an unreadable ancestor, `<root>/link/..` resolves lexically to `<root>` while it names another. */
function priorRootPath(space: string, root: string): string | undefined {
  let real: string;
  let kind: Stats;
  try {
    real = realpathSync.native(root);
    kind = statSync(real);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return undefined;
    throw new CommandFailure("refused", code === "EACCES" || code === "EPERM" ? "PERMISSION_DENIED" : "TARGET_UNAVAILABLE", `space "${space}" is registered to ${root}, which could not be resolved (${code ?? String(e)}) - \`cotal up\` did not take the name`, { target: { space, root }, remedy: `restore access to ${root} and run this again, or start this stack under a different \`--space\`` });
  }
  return kind.isDirectory() ? real : undefined;
}

/** A space name maps to one mesh in the registry (the key `--space`/`use`/`down` act on). Before
 *  starting a broker, refuse to reuse a space already claimed by a DIFFERENT live mesh — a stale/dead
 *  holder is reclaimed, and said so when it was another root's, unless that root still holds a
 *  maintenance journal. Re-`up`ping the same mesh (same server + root) is a refresh (port-reachable
 *  path). NOTE: this is a best-effort sequential guard — two `cotal up --space X` racing from
 *  different roots within the same instant can both pass the check before either records; that
 *  concurrent case is out of scope (a single-operator CLI action), not synchronized with a lock. */
export async function claimSpace(space: string, server: string, root: string): Promise<void> {
  const existing = findMesh(space);
  if (!existing) return;
  // A relative recorded root names no directory without a guess against the cwd, so it is never
  // taken as this root, compared with it or reclaimed. Its record stays until it is removed by hand.
  const relative = !isAbsolute(existing.root);
  if (!relative && existing.server === server && existing.root === root) return;
  // Every refusal below is made before the registry changes, so it is typed as refused with its own
  // remedy, and the controller and legacy routes both show the reason and exit 2.
  const target = { space, root: existing.root, server: existing.server };
  // An OPERATOR-REGISTERED holder is decided FIRST, before liveness, because liveness changes
  // nothing about it and the two outcomes would otherwise print the wrong remedy. It is never
  // reclaimed: unreachable is not proof the mesh is gone (the record describes a broker on another
  // machine), the reclaim runs BEFORE this launch starts anything, and `cotal down` — what the
  // liveness branch below would advise — cannot stop a mesh this machine does not run.
  if (existing.origin === "manual" || existing.origin === "catalog")
    throw new CommandFailure("refused", "CONFLICT", `space "${space}" is registered to a mesh at ${existing.server} (${existing.root}) - it is ${existing.origin === "catalog" ? "owned by a signed-in space catalog" : "registered by hand"}, so \`cotal up\` neither takes it over nor reclaims the name`, { target, remedy: existing.origin === "catalog" ? "use a different `--space`, or remove access at the IdP and run `cotal sync`" : manualClaimRemedy(space, existing.server) });
  if (relative)
    throw new CommandFailure("refused", "CONFLICT", `space "${space}" is registered to ${existing.root}, which is not an absolute path - \`cotal up\` did not take the name`, { target, remedy: `drop that record with \`cotal meshes rm ${space}\`, or start this stack under a different \`--space\`` });
  if (await isReachable(existing.server)) {
    // A space name is this machine's, so a separate space here needs a name of its own.
    let controller = false;
    try { controller = readStackJournal(existing.root)?.journal.space === space; } catch { /* named with the legacy stop */ }
    // THIS project's own space, running at its own address, started again with another one. The
    // refusal below belongs to a name another folder holds: it reads as if this folder were a
    // stranger to the space and offers to start a separate one here, when the folder IS that
    // space's project and a start naming no address joins the mesh already running in it. No
    // command moves a stack that ran to another address, so say which address it runs at.
    // The address must differ for this sentence to be true: the early return above compares roots
    // as written while this compares them resolved, so a record naming this root by another
    // spelling reaches here at its OWN address, and that case keeps the refusal below.
    if (canonicalRoot(existing.root) === canonicalRoot(root) && existing.server !== server)
      throw new CommandFailure("refused", "CONFLICT", `space "${space}" already runs from this project at ${existing.server}, and this start names ${server}; nothing was started`, {
        target,
        remedy: `run \`cotal up\` here with no --server or --host to reach the mesh at ${existing.server}, or stop it first with \`cotal down${controller ? " --yes" : ""}\` in ${shellWord(existing.root)}`,
      });
    throw new CommandFailure("refused", "CONFLICT", `space "${space}" is already in use by a mesh at ${existing.server} (${existing.root})`, { target, remedy: `start a separate space in a new project folder outside this one with \`cotal up --space <name>\`, using an unused name and keeping --server if you specified a free address, or stop "${space}" first with \`cotal down${controller ? " --yes" : ""}\` in ${shellWord(existing.root)}` });
  }
  // The recorded root is this root only where it physically resolves, so it is resolved before any
  // comparison, and one that cannot be resolved refuses. A dead holder at another root keeps its name
  // while that root holds a preserved cut or a restore: taking it would cut that root's recovery off
  // from its space. A journal that cannot be read keeps it too. A root proven gone or not a directory
  // has no journal to read; a readable root without one is reclaimed.
  const prior = priorRootPath(space, existing.root);
  const otherRoot = prior !== canonicalRoot(root);
  if (otherRoot && prior !== undefined) {
    let held: string | undefined;
    try { held = readMaintenanceJournal(existing.root)?.state; }
    catch { held = "unreadable"; }
    if (held)
      throw new CommandFailure("refused", "LIFECYCLE_BLOCKED", `space "${space}" is registered to ${existing.root}, whose maintenance journal holds a preserved cut or a restore (state ${held}) - \`cotal up\` did not take the name`, { target, remedy: `finish that attempt from ${existing.root}, or start this stack under a different \`--space\`` });
  }
  removeMesh(space); // the prior holder's broker is gone — reclaim the name
  if (otherRoot) console.error(`• space "${space}" was registered to ${existing.root}, whose broker at ${existing.server} is not running - this up takes the name over`);
}

/**
 * The manager attach/console BIND host for a launch into `space`.
 *
 * Exposure is an operator DECISION, made at `up --host` and recorded on the mesh entry. Every later
 * launch for the same mesh — a same-root repair, adopting a preserved or restored listener, a
 * manifest deploy — has no `--host` of its own to consult, so it reads the decision back. Without
 * this a replacement manager falls to loopback and remote `cotal attach` dies at the first repair,
 * silently: the broker and every agent stay up, only the terminal face moves.
 *
 * An explicit host on THIS invocation always wins, so an operator can widen or narrow exposure by
 * saying so. Absent both, undefined — the manager's own loopback default, unchanged.
 */
export function attachHostFor(space: string, explicit?: string): string | undefined {
  return explicit ?? findMesh(space)?.attachHost;
}

/**
 * The manager live-session ceiling for a launch into `space`.
 *
 * Like {@link attachHostFor}, this is an operator DECISION (`--max-sessions`), not something later
 * commands can reconstruct. Every later manager launch — same-root repair, resume, `spawn -f` —
 * has no flag of its own unless the operator typed one, so it reads the decision back. Without
 * this a replacement manager silently falls to 64 and the next console pane past that is refused.
 *
 * An explicit value on THIS invocation always wins. Absent both, undefined — the plane's own
 * default of 64, unchanged, and nothing is recorded as though chosen.
 */
export function maxSessionsFor(space: string, explicit?: number): number | undefined {
  return explicit ?? findMesh(space)?.maxSessions;
}

/**
 * Did THIS launch bring the broker up, or is it re-recording one that was already there?
 *
 * The distinction is provenance, and it has to come from the call site because it cannot be
 * observed here: `started` covers the paths that spawned the broker or proved a listener this
 * attempt owns, and stamps `origin: "up"` — a record this machine can always write back, so the
 * liveness sweep and `cotal down` may drop it. `refresh` is the "a broker is already on this port"
 * branch, which concludes the mesh is up from reachability alone and starts nothing; stamping `up`
 * there would silently convert a hand-registered record into one the next sweep may delete, so it
 * keeps whatever origin the record already had.
 */
type Provenance = "started" | "refresh";

/** {@link recordOurMesh} under a name that says it is a test seam: the origin rule it enforces is
 *  asserted directly by the registry smoke, since reaching each branch through a full `up` would
 *  need a live broker per case. */
export const recordOurMeshForTest = (m: MeshEntry, provenance: Provenance): void => recordOurMesh(m, provenance);

/** Record this mesh in the registry, and set it as the `current` default when there's no usable one
 *  — i.e. the first mesh, OR when `current` dangles at a space that's no longer in the registry (a
 *  ghost pointer is not a default), and say so. Never silently redirect a `current` that still resolves
 *  to a live mesh; just say another is the default and how to switch. */
export function recordOurMesh(m: MeshEntry, provenance: Provenance, quietBoot = false): void {
  const cur = getCurrent();
  const usableCurrent = cur && (findMesh(cur) || findPreparedSpace(cur)) ? cur : undefined; // compute before recording m
  const prior = findMesh(m.space);
  const origin = provenance === "refresh" && (prior?.origin === "manual" || prior?.origin === "catalog") ? prior.origin : "up";
  // A REFRESH starts nothing: it concluded the mesh is up from reachability alone, so `m` holds only
  // what THIS launch decided, and every other field is the record as it stands now. That covers the
  // operator's past decisions (origin, overlay consent, TLS requirement) and anything another writer
  // committed while the refresh ensured the control plane; rebuilding from the refresh's earlier
  // read reverted those and still exited 0. A `started` takeover may replace the record outright
  // (that launch really is the mesh now).
  if (provenance === "refresh" && !prior)
    throw new Error(`mesh "${m.space}" was removed from the registry while \`cotal up\` refreshed it - not re-recording it from an earlier read`);
  const nativeMembers: NonNullable<MeshEntry["nativeMembers"]> = [];
  for (const [role, template] of [["manager", MANAGER_PIDFILE], ["delivery", DELIVERY_PIDFILE], ["auth", AUTH_PIDFILE], ["broker", NATS_PIDFILE]] as const) {
    const pin = verifyIdentityPin(role === "broker" ? join(m.root, ".cotal", template) : localProcessPath(template, { root: m.root, space: m.space }));
    if (pin.kind === "match") nativeMembers.push({ role, process: pin.record });
  }
  const nativeHost = nativeMembers.length ? knownStackRecoveryHost() : undefined;
  const recorded: MeshEntry = { ...m, origin, ...(nativeHost !== undefined ? { nativeMembers, nativeHost } : {}) };
  if (provenance === "started") trustFreshUpProject(m.root);
  recordMesh(provenance === "refresh" ? { ...prior, ...recorded, stoppedByDown: undefined, stoppedWithAgents: undefined } : recorded);
  removePreparedSpace(m.space); // started: the registration is its record now
  if (!usableCurrent) {
    setAdoptedCurrent(m.space);
    if (!quietBoot) for (const line of hang("", selectedOnUp(m.space), terminalWidth(process.stdout), c.dim)) console.log(line);
    return;
  }
  if (usableCurrent !== m.space && !quietBoot)
    for (const line of hang("", keptOnUp(m.space, usableCurrent), terminalWidth(process.stdout), c.dim)) console.log(line);
}

/** Write the default persona into the root this `up` started or refreshed when it has none, and
 *  say so. The mesh is already up, so a write that fails is reported and the start stands. */
export function seedPersonaAfterUp(root: string, quiet = false): void {
  let written: { what: string; path: string } | undefined;
  try {
    written = seedDefaultPersona(root);
  } catch (e) {
    console.error(c.yellow(`! the default persona was not written in ${root}: ${(e as Error).message}`));
    return;
  }
  if (written && !quiet) for (const line of hang("  ", `wrote ${written.what}: ${written.path}`, terminalWidth(process.stdout))) console.log(c.dim(line));
}

async function waitReady(server: string, creds?: string, tls = false, log?: string): Promise<boolean> {
  // Fifty silent probes is the bound for a broker that is not advancing. A listener that is up, or a
  // broker log that keeps growing or recording a JetStream restore, is evidence the process is still
  // recovering, so the wait continues instead of stopping it at a fixed count.
  let evidence = 0;
  let silent = 0;
  for (let i = 0; silent < 50; i++) {
    const reachable = await isReachable(server, creds ? { creds } : undefined);
    if (tls) await refuseUntrustedListener(server, creds);
    if (reachable) return true;
    const { evidence: next, restoring } = brokerRecoveryEvidence(log);
    // Any restore evidence seen during the wait is progress, including evidence already present on
    // the first probe. A restore that has started and not finished is progress on every probe, since
    // the broker writes nothing to its log until it completes; the probe cap bounds that wait. Only a
    // probe with no new evidence and no restore in flight counts toward the silent bound.
    if (next > evidence || restoring) {
      evidence = Math.max(evidence, next);
      silent = 0;
    } else {
      silent++;
    }
    if (i >= 1_500) return false;
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
}

/** Bytes plus completed-restore lines in the broker log, and whether a restore is in flight. A
 *  foreground broker logging to the terminal has no file to read, so it keeps the silent-probe bound. */
function brokerRecoveryEvidence(log?: string): { evidence: number; restoring: boolean } {
  const none = { evidence: 0, restoring: false };
  if (!log || log.startsWith("the terminal")) return none;
  let text = "";
  let size = 0;
  try {
    const stat = statSync(log);
    if (!stat.isFile()) return none;
    size = stat.size;
    text = readFileSync(log, "utf8");
  } catch {
    return none;
  }
  const started = text.match(/Starting restore/g)?.length ?? 0;
  const restored = text.match(/Restored \d/g)?.length ?? 0;
  return { evidence: size + restored, restoring: started > restored };
}

/** Throw when the TLS listener at `server` answers and this client refuses its certificate in the
 *  handshake, which waiting does not change. It dials as the setup that follows does. */
async function refuseUntrustedListener(server: string, creds?: string): Promise<void> {
  let code: unknown, reason = "";
  try {
    const nc = await dialerFor(server)({ servers: server, timeout: 1_000, reconnect: false, maxReconnectAttempts: 0, ...standaloneConnectOpts({ creds, tls: false }) });
    await nc.close();
    return;
  } catch (e) {
    code = (e as NodeJS.ErrnoException)?.code;
    reason = e instanceof Error ? e.message.split(";")[0]! : String(e);
  }
  const untrusted = typeof code === "string" && UNTRUSTED_CERTIFICATE.has(code);
  if (!untrusted && code !== "ERR_TLS_CERT_ALTNAME_INVALID") return;
  const { hostname, port } = new URL(server);
  throw new CommandFailure("failed", "OPERATION_FAILED", `nats-server answered at ${server}, but this client refused its TLS certificate in the handshake (${reason}); up stopped it and recorded nothing`, {
    native: { code: String(code) },
    remedy: untrusted
      ? "trust the certificate's CA, or a self-signed certificate itself, by setting NODE_EXTRA_CA_CERTS to that PEM file for `cotal up` and every cotal command of this space, then run `cotal up` again"
      : /^tls:/i.test(server) ? `serve a certificate that names ${hostname}, then run \`cotal up\` again` : `pass --server tls://${hostname}:${port}, so every dial checks the certificate against ${hostname}`,
  });
}

// #1356: the presence bucket's file-backed latch is fixed in nats-server 2.14.5. Below that,
// `cotal up` warns when the space's presence bucket is file-backed (never refuses: 2.14.0 meets the
// SPEC §13.12 floor and is the bundled broker). A memory-backed bucket has no file store to latch.
export function belowPresenceSafeBroker(version: string): boolean {
  const p = parseServerVersion(version);
  if (!p) return false;
  if (p.major !== 2) return p.major < 2;
  if (p.minor !== 14) return p.minor < 14;
  return p.patch < 5;
}
