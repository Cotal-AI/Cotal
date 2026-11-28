/**
 * The `cotal daemon serve` listener: binds the local endpoint, answers `status` once it is ready,
 * and on shutdown removes only what it published.
 *
 * Readiness is real. On Linux and macOS `status` can only be answered by a listener that has taken
 * the lifetime lock, passed the directory check, cleared the public path, bound a private name,
 * verified it is a 0600 socket owned by this uid, and published it with link(2), which yields
 * exactly one winner among concurrent starters. On Windows it is a pipe whose first instance was
 * created first-instance-only, so a name anything else already serves is refused. A peer whose
 * kernel-reported user differs is dropped before one byte of its input is decoded.
 *
 * A restarted daemon comes back by itself. The lifetime lock is kernel-held, so a predecessor
 * killed with SIGKILL has already released it, and the record it left names the socket it published
 * by `(dev, ino)`. Holding the lock, this daemon removes that exact socket and no other (a Windows
 * pipe name dies with its holder), then resumes the service connections its predecessor held (see
 * lifetime.ts, service.ts).
 */
import { chmodSync, closeSync, linkSync, unlinkSync, lstatSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { basename, dirname, isAbsolute, join } from "node:path";
import { createServer, type Server, type Socket } from "node:net";
import { localPeerCredentials, listenPipe, windowsUserSid, type PipeListener, type PipePeer, type PipeRefused } from "@cotal-ai/seat";
import { DAEMON_PROTOCOL_VERSION, MAX_LINE_BYTES, EndpointRefusal, adoptPipe, assertSocketPathFits, assertSupportedPlatform, checkDir, checkSocket, defaultPeerUid, ensureDir, ensureStateDir, type DaemonPaths, type PeerUid } from "./endpoint.js";
import { claimSocketPath, generationOf, holdLifetime, processBirth, type HeldLifetime } from "./lifetime.js";
import { encode, parseRequest, type ConnectCheckResult, type DaemonResponse, type DaemonStatus, type HostedManager, type LogoutChange, type RegisterResult, type ServiceConnectionResult } from "./protocol.js";
import { createLoginCoordinator, type LoginCoordinator } from "./login.js";
import { connectCheck } from "./connect.js";
import { createServiceConnections } from "./service.js";
import { findMesh, homeCotalDir, isCommandFailure, isConnectRefusal, isMeshRegistryError, meshFile, readMeshRegistry, readUpdateSettings, setUpdateSetting } from "@cotal-ai/workspace";
import { NON_USER_AUTH_MESSAGE, NON_USER_AUTH_REMEDY } from "./guidance.js";
import { desktopSpaces, resolveSpaceConflict } from "./desktop-state.js";
import { idpTimeoutMs, normalizeIdpUrl, signedInMachineAccounts, signOutIdpSession, withIdpSessionDir } from "@cotal-ai/auth";
import { createHostedManagers, HostedManagerRefusal } from "./manager.js";
import { createAccountReconciler } from "./account-reconcile.js";
import { createAccountComputer } from "./account.js";

type ManagerResult = DaemonStatus | HostedManager | ServiceConnectionResult | { argv: string[] };
function managerResultError(op: string, error: unknown, log: (message: string) => void) {
  const clean = (value: string) => value.replace(/\u001b\[[0-9;]*m/g, "").replace(/eyJ[A-Za-z0-9_.-]*/g, "<redacted>").slice(0, 1000);
  const cause = clean(String(error instanceof Error ? error.message : error));
  log(`daemon: ${op} refused: ${cause}`);
  if (error instanceof HostedManagerRefusal) return { code: error.code, message: error.message.slice(0, 1500), remedy: error.remedy.slice(0, 1500) };
  if (op !== "agent-stop" && op !== "agent-terminal") return managerUnavailable(op, cause);
  const failure = isConnectRefusal(error) ? error.failure() : error;
  if (!isCommandFailure(failure)) return managerUnavailable(op, cause);
  return { code: failure.code, message: clean(failure.message), ...(failure.remedy ? { remedy: clean(failure.remedy) } : {}) };
}

function managerUnavailable(op: string, cause: string) {
  return { code: "MANAGER_UNAVAILABLE" as const, message: `the daemon could not complete ${op}: ${cause}`, remedy: "read \`cotal daemon status\`, restore the Manager connection if needed, then run the same command again" };
}

function logoutErrorResponse(id: string, idp: string, error: unknown, onCleared: () => void): DaemonResponse {
  if (isCommandFailure(error) && (error.code === "SCHEMA_INVALID" || error.code === "OPERATION_UNKNOWN" || error.code === "OPERATION_PARTIAL" || error.code === "DEPENDENCY_UNAVAILABLE")) {
    const changed: LogoutChange[] = [];
    for (const change of error.changed ?? []) {
      if (!change || typeof change !== "object" || !("idp" in change) || change.idp !== idp || !("kind" in change)) continue;
      if (change.kind === "local-login" && "cleared" in change && change.cleared === true)
        changed.push({ kind: "local-login", idp, cleared: true });
      else if (change.kind === "idp-session" && "revoked" in change && change.revoked === true)
        changed.push({ kind: "idp-session", idp, revoked: true });
    }
    if (changed.some(change => change.kind === "local-login")) onCleared();
    return { v: DAEMON_PROTOCOL_VERSION, id, ok: false, error: { code: error.code, message: error.message, remedy: error.remedy, outcome: error.outcome, ...(error.changed ? { changed } : {}) } };
  }
  return { v: DAEMON_PROTOCOL_VERSION, id, ok: false, error: { code: "OPERATION_UNKNOWN", outcome: "unknown", message: "the sign-out outcome could not be confirmed; no success is assumed" } };
}

function spacesErrorResponse(id: string, op: "spaces" | "space-conflict-resolve", error: unknown): DaemonResponse {
  if (isCommandFailure(error) && (op === "space-conflict-resolve" || error.code === "DEPENDENCY_UNAVAILABLE"))
    return { v: DAEMON_PROTOCOL_VERSION, id, ok: false, error: { code: error.code, message: error.message, remedy: error.remedy } };
  return { v: DAEMON_PROTOCOL_VERSION, id, ok: false, error: { code: "SPACES_UNAVAILABLE", message: "the daemon could not read its spaces" } };
}

/** Requests one connection may send. A sign-in needs two (start, cancel); status polling a few. */
const MAX_REQUESTS_PER_CONNECTION = 64;

/** Counters a test or `status` can read. Every security decision increments exactly one. */
interface ServerCounters {
  accepted: number;
  peerRejected: number;
  framesDecoded: number;
  requestsRefused: number;
  statusAnswered: number;
  spacesAnswered: number;
  loginsStarted: number;
  loginsRefused: number;
  cancelsAnswered: number;
  connectChecksAnswered: number;
  registersAnswered: number;
  serviceAnswered: number;
  /** Sockets a dead predecessor left that this start recovered: 0 or 1. */
  socketsRecovered: number;
  /** Service connections this start resumed from a recorded intent. */
  connectionsResumed: number;
}

export interface RunningDaemon {
  readonly paths: DaemonPaths;
  readonly counters: Readonly<ServerCounters>;
  /** Whether the socket directory was created by this start; `none` for a Windows pipe. */
  readonly dirOutcome: "created" | "existing" | "none";
  status(): DaemonStatus;
  generationSeats(): Promise<{ space: string; seats: number }[]>;
  generationPending(installed: string | undefined, waiting?: string): void;
  prepareGenerationRestart(): Promise<void>;
  abortGenerationRestart(): Promise<void>;
  close(): Promise<void>;
  readonly stopped: Promise<void>;
}

export interface ServeOptions {
  readonly paths: DaemonPaths;
  readonly version: string;
  /** Test hook (Linux, macOS): read a peer's kernel uid. Defaults to the native reader. Windows
   *  reads the peer inside the native pipe accept and does not consult it. */
  readonly peerUid?: PeerUid;
  readonly uid?: number;
  readonly log?: (line: string) => void;
  /** Where the daemon keeps its sign-in session and its own per-space state. Defaults to the
   *  machine-home Cotal directory, where `cotal login` keeps the session. An explicit `--daemon-home`
   *  passes its directory here together with {@link DaemonPaths.lock}. */
  readonly sessionDir?: string;
  readonly updateCheck?: () => Promise<NonNullable<DaemonStatus["update"]>>;
  readonly updateStatus?: () => NonNullable<DaemonStatus["update"]>;
  /** Test hook: the stock sign-in to drive. */
  readonly login?: LoginCoordinator;
  /** Shipped serve entry's receipt-verified native launch provenance. Foreground servers refuse stop. */
  readonly stopAllowed?: () => Promise<boolean | { state: "owned" | "not-owned" | "unknown" }>;
  /** Native startup admission, checked under the lifetime lock before publishing an endpoint. */
  readonly admit?: () => void;
}

/** A published endpoint: closing it stops new connections and removes only what it published. */
interface Endpoint {
  close(): Promise<void>;
}

function listen(server: Server, path: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (e: Error) => {
      server.off("listening", onListening);
      reject(e);
    };
    const onListening = () => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(path);
  });
}

export async function serveDaemon(opts: ServeOptions): Promise<RunningDaemon> {
  assertSupportedPlatform();
  // Refuse local IdP configuration before publishing readiness or resuming any connection.
  idpTimeoutMs();
  const uid = process.platform === "win32" ? undefined : (opts.uid ?? process.geteuid!());
  const { paths } = opts;
  // The lifetime lock comes before any endpoint path, for both daemon forms. A second serve for the
  // same daemon refuses here and never reaches the socket; and because publishing the socket needs
  // this lock, holding it is what makes removing a dead predecessor's socket safe below.
  ensureStateDir(paths, uid);
  const lock = holdLifetime(paths.lock);
  try {
    opts.admit?.();
    return await serveLocked(opts, uid, lock);
  } catch (e) {
    // A failed start keeps any predecessor socket evidence it has not consumed or rejected.
    // A started daemon releases the lock only in close(), clearing its own record.
    lock.release({ preservePrevious: true });
    throw e;
  }
}

async function serveLocked(opts: ServeOptions, uid: number | undefined, lock: HeldLifetime): Promise<RunningDaemon> {
  let resolveStopped!: () => void;
  const stopped = new Promise<void>(resolve => { resolveStopped = resolve; });
  const log = opts.log ?? (() => {});
  const { paths } = opts;
  let dirOutcome: RunningDaemon["dirOutcome"] = "none";
  if (paths.dir !== undefined) {
    if (paths.parent !== undefined) ensureDir(paths.parent, uid);
    dirOutcome = ensureDir(paths.dir, uid);
  }

  const counters: ServerCounters = { accepted: 0, peerRejected: 0, framesDecoded: 0, requestsRefused: 0, statusAnswered: 0, spacesAnswered: 0, loginsStarted: 0, loginsRefused: 0, cancelsAnswered: 0, connectChecksAnswered: 0, registersAnswered: 0, serviceAnswered: 0, socketsRecovered: 0, connectionsResumed: 0 };
  const machineHome = opts.sessionDir ?? homeCotalDir();
  const login = opts.login ?? createLoginCoordinator({ sessionDir: machineHome });
  let loginActive = false;
  let logoutActive = false;
  interface StatusWatcher {
    id: string;
    sock: Socket;
    write: (r: DaemonResponse) => Promise<void>;
    lastKey: string;
  }
  const watchers = new Set<StatusWatcher>();
  let watchNotifying = false;
  let watchNotifyQueued = false;
  let notifyStatusWatchers = (): void => {};
  const services = createServiceConnections(machineHome);
  const managers = createHostedManagers(machineHome, opts.version, opts.sessionDir, () => notifyStatusWatchers());
  const reconciler = createAccountReconciler(machineHome, services, managers);
  const account = createAccountComputer(machineHome, opts.version, reconciler, () => notifyStatusWatchers());
  const startedAt = new Date();
  let generation: DaemonStatus["generation"];
  const status = (): DaemonStatus => ({
    vitals: account.vitals(),
    vitalsError: account.vitalsError(),
    computer: account.name(),
    ...(account.nameWarning() ? { computerNameWarning: account.nameWarning() } : {}),
    state: "ready",
    protocol: DAEMON_PROTOCOL_VERSION,
    version: opts.version,
    pid: process.pid,
    startedAt: startedAt.toISOString(),
    uptimeMs: Date.now() - startedAt.getTime(),
    managers: managers.all(),
    account: account.status(),
    ...(opts.updateStatus ? { update: opts.updateStatus() } : {}),
    ...(generation ? { generation } : {}),
  });
  const statusWatchKey = (s: DaemonStatus): string => {
    const normAccount = (a: DaemonStatus["account"]) => a ? {
      ...a,
      lastRegistration: Boolean(a.lastRegistration),
      accounts: a.accounts?.map(item => ({ ...item, lastRegistration: Boolean(item.lastRegistration) })),
    } : undefined;
    return JSON.stringify({
      computer: s.computer,
      computerNameWarning: s.computerNameWarning,
      state: s.state,
      protocol: s.protocol,
      version: s.version,
      pid: s.pid,
      startedAt: s.startedAt,
      managers: s.managers?.map(({ observedAt: _o, ...m }) => m),
      account: normAccount(s.account),
      agents: s.agents?.map(({ observedAt: _o, ...a }) => a),
      update: s.update,
      generation: s.generation,
    });
  };
  const snapshotStatus = async (cachedAgents: boolean): Promise<DaemonStatus> => {
    if (!cachedAgents) await Promise.all(managers.all().map((manager) => managers.refresh(manager.space)));
    const result = { ...status(), agents: await managers.agents(cachedAgents) };
    if (!result.update) return result;
    // A hosted Manager that is starting or stopping cannot give restart evidence. Status still
    // answers, and an updater that needs the evidence refuses without it.
    let restartEvidence: Awaited<ReturnType<typeof managers.preparedGenerationEvidence>> | undefined;
    try { restartEvidence = await managers.preparedGenerationEvidence(); } catch { restartEvidence = undefined; }
    return { ...result, update: { ...result.update, ...(restartEvidence ? { restartEvidence } : {}) } };
  };
  notifyStatusWatchers = (): void => {
    if (watchers.size === 0) return;
    if (watchNotifying) { watchNotifyQueued = true; return; }
    watchNotifying = true;
    void (async () => {
      try {
        do {
          watchNotifyQueued = false;
          if (watchers.size === 0) break;
          const snap = await snapshotStatus(true);
          const key = statusWatchKey(snap);
          await Promise.all([...watchers].map(async (w) => {
            if (w.sock.destroyed || !w.sock.writable) { watchers.delete(w); return; }
            if (w.lastKey === key) return;
            w.lastKey = key;
            await w.write({ v: DAEMON_PROTOCOL_VERSION, id: w.id, ok: true, event: "status", result: snap });
          }));
        } while (watchNotifyQueued && watchers.size > 0);
      } catch {
      } finally {
        watchNotifying = false;
      }
    })();
  };

  const sockets = new Set<Socket>();
  const track = (sock: Socket): void => {
    sockets.add(sock);
    sock.once("close", () => sockets.delete(sock));
    sock.on("error", () => {});
  };
  // One connection whose peer the kernel already reported as this user: decode its requests.
  const daemonRestartOwner = `daemon:${process.pid}:${processBirth(process.pid)}`;
  const serveConnection = (sock: Socket, restartOwner: () => string): void => {
    counters.accepted++;
    let buf = "";
    let bufBytes = 0;
    let requests = 0;
    // Sign-in attempts this connection started that have not settled. Closing the connection
    // before the result cancels them through the stock fence, so nothing is persisted for a
    // requester that went away. Once the result is delivered the attempt is no longer here, so a
    // close after it changes nothing.
    const owned = new Set<string>();
    const write = (r: DaemonResponse): Promise<void> => new Promise((resolve) => {
      if (sock.destroyed || !sock.writable) return resolve();
      sock.write(encode(r), () => resolve());
    });
    const pendingReplies = new Set<Promise<unknown>>();
    const replyTask = (task: Promise<unknown>): void => {
      pendingReplies.add(task);
      void task.finally(() => pendingReplies.delete(task)).catch(() => {});
    };
    const closeAfterReplies = async (): Promise<void> => {
      // Stop parsing immediately, but let already accepted finite operations flush their answers.
      // Device sign-in streams are not finite replies and are cancelled when this socket closes.
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          Promise.allSettled([...pendingReplies]),
          new Promise<void>((resolve) => { timer = setTimeout(resolve, 5000); }),
        ]);
      } finally {
        if (timer) clearTimeout(timer);
      }
      sock.end();
      sock.destroySoon();
    };
    const refuse = (id: string | null, code: "LOGIN_IN_PROGRESS" | "TOO_MANY_REQUESTS", message: string) => {
      counters.requestsRefused++;
      return write({ v: DAEMON_PROTOCOL_VERSION, id, ok: false, error: { code, message } });
    };
    sock.once("close", () => {
      for (const attempt of owned) void login.cancel(attempt);
      owned.clear();
    });
    let stopPrepared = false;
    const handle = (line: string): void => {
      counters.framesDecoded++;
      const parsed = parseRequest(line);
      if (!parsed.ok) {
        counters.requestsRefused++;
        void write({ v: DAEMON_PROTOCOL_VERSION, id: parsed.id, ok: false, error: { code: parsed.code, message: parsed.message } });
        return;
      }
      const req = parsed.request;
      if (req.op === "daemon-stop") {
        // The reply acknowledges the request, not completed shutdown. The uninstaller
        // independently waits for this process and endpoint to disappear.
        void (async () => {
          const observation = req.commit ? stopPrepared : await opts.stopAllowed?.();
          const allowed = typeof observation === "object" ? observation.state === "owned" : observation === true;
          if (!allowed) {
            const unknown = typeof observation === "object" && observation.state === "unknown";
            await write({ v: DAEMON_PROTOCOL_VERSION, id: req.id, ok: false, error: { code: "DEPENDENCY_UNAVAILABLE", message: unknown
              ? "the daemon native launch provenance is still unknown; it was not stopped"
              : "the daemon has no verified native launch provenance; it was not stopped" } });
            return;
          }
          // Only an explicit commit on this prepared connection follows native removal.
          // A dropped connection or failed native step must leave the daemon running.
          stopPrepared = true;
          await write({ v: DAEMON_PROTOCOL_VERSION, id: req.id, ok: true, result: status() });
          if (req.commit) await close();
        })().catch(error => log(`daemon: shutdown failed: ${String(error)}`));
        return;
      }
      const managerResult = (run: () => ManagerResult | Promise<ManagerResult>) => {
        replyTask(Promise.resolve().then(run).then((result) => {
          if (req.op !== "status") notifyStatusWatchers();
          return write({ v: DAEMON_PROTOCOL_VERSION, id: req.id, ok: true, result });
        }, (error: unknown) => {
          counters.requestsRefused++;
          return write({ v: DAEMON_PROTOCOL_VERSION, id: req.id, ok: false, error: managerResultError(req.op, error, log) });
        }));
      };
      if (req.op === "manager-start" || req.op === "manager-status") {
        managerResult(() => req.op === "manager-start" ? managers.start(req.space) : managers.refresh(req.space));
        return;
      }
      if (req.op === "managers-stop") {
        managerResult(async () => { await Promise.all(managers.all().map((manager) => managers.disconnect(manager.space))); return status(); });
        return;
      }
      if (req.op === "managers-prepare-restart" || req.op === "managers-abort-restart") {
        managerResult(async () => {
          const owner = restartOwner();
          if (req.op === "managers-prepare-restart") await managers.prepareGenerationRestart(owner);
          else await managers.abortGenerationRestart(owner);
          return status();
        });
        return;
      }
      if (req.op === "status") {
        counters.statusAnswered++;
        managerResult(() => snapshotStatus(false));
        return;
      }
      if (req.op === "status-watch") {
        counters.statusAnswered++;
        const watcher: StatusWatcher = { id: req.id, sock, write, lastKey: "" };
        watchers.add(watcher);
        sock.once("close", () => watchers.delete(watcher));
        replyTask(snapshotStatus(true).then((initial) => {
          if (!watchers.has(watcher)) return;
          watcher.lastKey = statusWatchKey(initial);
          return write({ v: DAEMON_PROTOCOL_VERSION, id: req.id, ok: true, event: "status", result: initial });
        }).catch(() => { watchers.delete(watcher); }));
        return;
      }
      if (req.op === "update-settings" || req.op === "update-check") {
        managerResult(async () => {
          if (req.op === "update-check") {
            if (!opts.updateCheck) throw new Error("Update checks are unavailable in this daemon.");
            await opts.updateCheck();
          } else {
            readUpdateSettings();
            if (req.auto !== undefined) setUpdateSetting("auto", req.auto);
            if (req.notify !== undefined) setUpdateSetting("notify", req.notify);
          }
          return status();
        });
        return;
      }
      if (req.op === "name") {
        managerResult(async () => { if (req.name !== undefined) await account.rename(req.name); return status(); });
        return;
      }
      if (req.op === "spaces" || req.op === "space-conflict-resolve") {
        const disconnectSpace = async () => { const disc = services.disconnect(req.space); void disc.catch(() => {}); try { await managers.disconnect(req.space); } finally { await disc.catch(() => {}); } };
        const task = req.op === "spaces" ? desktopSpaces(machineHome, req.refresh === true) : reconciler.serial(() => resolveSpaceConflict(machineHome, req.space, req.idp, disconnectSpace));
        replyTask(task.then((result) => {
          counters.spacesAnswered++;
          if (req.op === "space-conflict-resolve") { account.signedIn(); notifyStatusWatchers(); }
          return write({ v: DAEMON_PROTOCOL_VERSION, id: req.id, ok: true, result });
        }, (error: unknown) => { counters.requestsRefused++; return write(spacesErrorResponse(req.id, req.op, error)); }));
        return;
      }
      if (req.op === "space-recover") {
        managerResult(async () => { await account.recover(req.space, req.candidate, req.holder); return status(); });
        return;
      }
      if (req.op === "space-intent" || req.op === "agent-stop" || req.op === "agent-terminal") {
        managerResult(() => req.op === "agent-terminal" ? managers.terminalAgent(req.space, req.lifecycleUid)
          : (req.op === "agent-stop" ? managers.stopAgent(req.space, req.lifecycleUid) : account.intent(req.space, req.enabled)).then(() => status()));
        return;
      }
      if (req.op === "connect-check") {
        replyTask(connectCheck(req.space, machineHome).catch((): ConnectCheckResult => ({ outcome: "refused", space: req.space, message: "the daemon could not complete the check" }))
          .then((result) => {
            counters.connectChecksAnswered++;
            return write({ v: DAEMON_PROTOCOL_VERSION, id: req.id, ok: true, result });
          }));
        return;
      }
      if (req.op === "register") {
        replyTask(withIdpSessionDir(machineHome, () => services.register(req.space)).catch((): RegisterResult => ({ outcome: "refused", space: req.space, message: "the daemon could not complete the registration request; nothing is connected" }))
          .then((result) => {
            counters.registersAnswered++;
            notifyStatusWatchers();
            return write({ v: DAEMON_PROTOCOL_VERSION, id: req.id, ok: true, result });
          }));
        return;
      }
      if (req.op === "service-connect" || req.op === "service-disconnect" || req.op === "service-status") {
        const notRegistered = {
          space: req.space, state: "not-registered" as const, message: `Space ${req.space} is not registered on this machine.`,
          remedy: "Check the space name or run `cotal space` to list registered spaces.",
        };
        const run = req.op === "service-status" ? Promise.resolve(services.status(req.space))
          : (async () => {
            if (req.op === "service-connect") {
              const entry = findMesh(req.space);
              if (!entry) return notRegistered;
              if (entry.mode !== "user") return {
                space: req.space, state: "unsupported" as const, message: NON_USER_AUTH_MESSAGE, remedy: NON_USER_AUTH_REMEDY,
              };
            }
            // Disconnect retires local authority even when sign-in or the account host is gone.
            // The local removal revision fences account reconciliation until a fresh enable.
            if (req.op === "service-connect" && await account.intent(req.space, true)) return services.status(req.space);
            const disconnect = req.op === "service-disconnect" ? services.disconnect(req.space) : undefined;
            void disconnect?.catch(() => {});
            return reconciler.serial(() => withIdpSessionDir(machineHome, async () => {
            if (req.op === "service-connect") {
              reconciler.localAddition(req.space);
              return services.connect(req.space);
            }
            reconciler.localRemoval(req.space);
            let disconnected: ServiceConnectionResult;
            try { await managers.disconnect(req.space); }
            finally { disconnected = await disconnect!; }
            return disconnected;
            }));
          })().catch((error: unknown): ServiceConnectionResult => ({ space: req.space, state: "unavailable", message: error instanceof Error ? error.message : "The connection could not be changed. Check daemon status and try again." }));
        managerResult(async () => {
          const result = await run;
          counters.serviceAnswered++;
          if (req.op === "service-connect" && result.state === "not-registered") return result;
          const manager = req.op === "service-status" ? await managers.refresh(req.space) : managers.status(req.space);
          // Read guidance only for these replies, after disconnect has finished removing records.
          if (!manager.registrationCleanup && ((req.op === "service-status" && (result.state === "not-requested" || result.state === "unsupported")) ||
              (req.op === "service-disconnect" && result.state === "disconnected"))) {
            let damaged = false;
            try {
              const { entries, unusable } = readMeshRegistry();
              // Keep pre-hex registrations visible without mistaking a damaged canonical record for a legacy one.
              damaged = unusable.some(error => error.file === meshFile(req.space));
              if (!damaged) {
                const entry = entries.find(entry => entry.space === req.space);
                if (req.op === "service-status" && result.state === "not-requested" && !entry) return notRegistered;
                if (entry && entry.mode !== "user") {
                  if (req.op === "service-status") return { space: req.space, state: "unsupported", message: NON_USER_AUTH_MESSAGE, remedy: NON_USER_AUTH_REMEDY };
                  return { ...result, message: result.removedRecords?.length === 0 ? "This space does not use the machine service. There was nothing to disconnect." : result.message,
                    manager: { ...manager, next: NON_USER_AUTH_REMEDY } };
                }
              }
            } catch (error) {
              if (!isMeshRegistryError(error)) throw error;
              damaged = true;
            }
            if (damaged) {
              const remedy = "run `cotal daemon spaces` to identify unreadable records, then restore the mesh registry";
              if (req.op === "service-status") return { space: req.space, state: "unavailable", message: "the mesh registry could not be read for this space", remedy };
              return { ...result, manager: { ...manager, next: remedy } };
            }
          }
          return { ...result, manager };
        });
        return;
      }
      if (req.op === "login-cancel") {
        replyTask(login.cancel(req.attempt).then((result) => {
          counters.cancelsAnswered++;
          return write({ v: DAEMON_PROTOCOL_VERSION, id: req.id, ok: true, result });
        }));
        return;
      }
      if (req.op === "logout") {
        if (loginActive || logoutActive) {
          void refuse(req.id, "LOGIN_IN_PROGRESS", "an account operation is already in progress on this daemon; wait for its result");
          return;
        }
        logoutActive = true;
        replyTask(signOutIdpSession({ dir: machineHome, idp: req.idp, local: false }).then(async (result) => {
          account.signedIn();
          await write({ v: DAEMON_PROTOCOL_VERSION, id: req.id, ok: true, result });
        }, async (error: unknown) => {
          counters.requestsRefused++;
          await write(logoutErrorResponse(req.id, req.idp, error, () => account.signedIn()));
        }).finally(() => { logoutActive = false; }));
        return;
      }
      if (logoutActive) {
        void refuse(req.id, "LOGIN_IN_PROGRESS", "a sign-out is already in progress on this daemon; wait for its result");
        return;
      }
      const started = login.start({
        idp: req.idp,
        discoveryPins: req.discoveryPins,
        ...(req.migrateFrom !== undefined ? { migrateFrom: req.migrateFrom } : {}),
        ...(req.clientId !== undefined ? { clientId: req.clientId } : {}),
        onPrompt: (attempt, prompt) => void write({ v: DAEMON_PROTOCOL_VERSION, id: req.id, ok: true, event: "login-prompt", attempt, prompt }),
        onResult: async (attempt, result) => {
          owned.delete(attempt);
          if (result.outcome === "signed-in") {
            if (req.migrateFrom !== undefined) {
              const accounts = signedInMachineAccounts(machineHome);
              const oldAcc = accounts.find((a) => a.idpUrl === normalizeIdpUrl(req.migrateFrom!));
              const newAcc = accounts.find((a) => a.idpUrl === normalizeIdpUrl(result.idp));
              if (oldAcc && newAcc && oldAcc.sub === newAcc.sub) reconciler.reconcileMigratedOwner(oldAcc.ownerKey, newAcc.ownerKey);
            }
            account.signedIn();
          }
          await write({ v: DAEMON_PROTOCOL_VERSION, id: req.id, ok: true, event: "login-result", attempt, result });
        },
      });
      if (!started) {
        counters.loginsRefused++;
        void refuse(req.id, "LOGIN_IN_PROGRESS", "a sign-in is already in progress on this daemon; cancel it or wait for its result");
        return;
      }
      loginActive = true;
      void started.settled.finally(() => { loginActive = false; }).catch(() => {});
      counters.loginsStarted++;
      owned.add(started.attempt);
    };
    sock.setEncoding("utf8");
    sock.on("data", (chunk: string) => {
      let offset = 0;
      while (offset < chunk.length) {
        const nl = chunk.indexOf("\n", offset);
        const part = chunk.slice(offset, nl === -1 ? chunk.length : nl);
        const bytes = Buffer.byteLength(part, "utf8");
        // Check this line before appending, reserving its newline even while it is incomplete.
        if (bufBytes + bytes + 1 > MAX_LINE_BYTES) {
          counters.requestsRefused++;
          const r: DaemonResponse = { v: DAEMON_PROTOCOL_VERSION, id: null, ok: false, error: { code: "LINE_TOO_LONG", message: `request exceeds ${MAX_LINE_BYTES} bytes` } };
          sock.removeAllListeners("data");
          replyTask(write(r));
          void closeAfterReplies();
          buf = "";
          bufBytes = 0;
          return;
        }
        buf += part;
        bufBytes += bytes;
        if (nl === -1) return;
        const line = buf;
        buf = "";
        bufBytes = 0;
        offset = nl + 1;
        if (++requests > MAX_REQUESTS_PER_CONNECTION) {
          // Bounded per connection: one refusal, then the connection closes and its unread input is dropped.
          sock.removeAllListeners("data");
          buf = "";
          bufBytes = 0;
          replyTask(refuse(null, "TOO_MANY_REQUESTS", `a connection may send at most ${MAX_REQUESTS_PER_CONNECTION} requests`));
          void closeAfterReplies();
          return;
        }
        handle(line);
      }
    });
    sock.resume();
  };

  let endpoint: Endpoint;
  if (paths.dir === undefined) {
    endpoint = publishPipe(paths, counters, log, (sock, peer) => {
      track(sock);
      serveConnection(sock, () => {
        if (!Number.isSafeInteger(peer.pid) || peer.pid <= 0 || !peer.birth) throw new Error("restart owner process identity is unavailable");
        return JSON.stringify(["peer", peer.user, peer.pid, peer.birth]);
      });
    });
  } else {
    const peerUid = opts.peerUid ?? defaultPeerUid;
    endpoint = await publishSocket(paths, uid!, lock, counters, log, (sock) => {
      track(sock);
      let peer: number;
      try {
        peer = peerUid(sock);
      } catch (e) {
        counters.peerRejected++;
        log(`daemon: peer credentials unreadable (${(e as Error).message}); dropped`);
        sock.destroy();
        return;
      }
      if (peer !== uid) {
        counters.peerRejected++;
        log(`daemon: peer uid ${peer} is not ${uid}; dropped before any frame was read`);
        sock.destroy();
        return;
      }
      let owner: string | undefined;
      try {
        const identity = localPeerCredentials(sock);
        const birth = processBirth(identity.pid);
        if (identity.uid === uid && Number.isSafeInteger(identity.pid) && identity.pid > 0 && birth) {
          owner = JSON.stringify(["peer", identity.uid, identity.pid, birth]);
        }
      } catch { /* Ordinary requests do not require restart ownership. */ }
      serveConnection(sock, () => {
        if (!owner) throw new Error("restart owner process identity is unavailable");
        return owner;
      });
    });
  }

  let closed: Promise<void> | undefined;
  // Read current account intent before resuming saved hosting. A successful reconciliation
  // removes withdrawn intents; an unavailable account leaves them intact for offline recovery.
  // The endpoint is already published, so account or space latency never delays local readiness.
  const resumed = account.start().then(() => reconciler.serial(async () => {
    if (closed) return;
    await Promise.all([
      managers.resume().catch(() => { log("daemon: hosted Manager records could not be resumed; inspect daemon status and the hosting records"); }),
      withIdpSessionDir(machineHome, () => services.resume()).then((spaces) => {
        counters.connectionsResumed = spaces.length;
        if (spaces.length) log(`daemon: resumed ${spaces.length} recorded service connection(s)`);
      }, () => {}),
    ]);
  }));

  const close = (): Promise<void> => {
    closed ??= (async () => {
      const servicesClosed = services.close();
      const managersClosed = managers.close();
      await account.close();
      // In-flight account work observes service cancellation before shutdown waits for it.
      // An in-flight sign-in is cancelled through the stock fence before the listener goes away.
      await login.close();
      await managersClosed;
      // Every service connection, its endpoint and its renewal source close before the socket does.
      await servicesClosed;
      await resumed;
      for (const s of sockets) s.destroy();
      await endpoint.close();
      // The lock is released only once this daemon's own endpoint is gone. If its socket is still
      // published (its removal threw), the lock stays held until this process exits, so no other
      // serve can start beside a live endpoint.
      lock.release();
      resolveStopped();
    })();
    return closed;
  };

  return { paths, counters, dirOutcome, status, close, stopped,
    generationSeats: () => managers.generationSeats(),
    generationPending(installed, waiting = "preparing activation") { generation = installed ? { installed, running: opts.version, waiting } : undefined; notifyStatusWatchers(); },
    async prepareGenerationRestart() { await resumed; await managers.prepareGenerationRestart(daemonRestartOwner); notifyStatusWatchers(); }, abortGenerationRestart: () => managers.abortGenerationRestart(daemonRestartOwner).finally(() => notifyStatusWatchers()) };
}

/** Recover a predecessor's socket before a different Linux runtime replaces its record. */
async function recoverPreviousRuntime(paths: DaemonPaths, uid: number, previous: HeldLifetime["previous"]): Promise<void> {
  const socket = previous?.socket;
  if (process.platform !== "linux" || !socket || socket.path === paths.socket || !isAbsolute(socket.path)) return;
  const dir = dirname(socket.path);
  const parent = dirname(dir);
  if (basename(socket.path) !== basename(paths.socket) || basename(dir) !== basename(paths.dir!)
    || (paths.parent !== undefined && basename(parent) !== basename(paths.parent))) return;
  try {
    const runtime = lstatSync(paths.parent === undefined ? parent : dirname(parent));
    if (!runtime.isDirectory() || runtime.uid !== uid || (runtime.mode & 0o022) !== 0) return;
    if (paths.parent !== undefined) checkDir(parent, uid);
    checkDir(dir, uid);
    checkSocket(socket.path, uid);
    if (await claimSocketPath(socket.path, socket) !== "recover") return;
    const current = lstatSync(socket.path);
    if (current.isSocket() && current.uid === uid && current.dev === socket.dev && current.ino === socket.ino) unlinkSync(socket.path);
  } catch {
    // The old runtime may be gone or inaccessible. It cannot block serving in the selected runtime.
  }
}

/** Linux and macOS: publish the unix socket, and on close remove it only if it is still ours. */
async function publishSocket(paths: DaemonPaths, uid: number, lock: HeldLifetime, counters: ServerCounters, log: (line: string) => void, accept: (sock: Socket) => void): Promise<Endpoint> {
  const server = createServer({ allowHalfOpen: false, pauseOnConnect: true }, accept);
  // Clear the public path. The lifetime lock is held, so nobody else can be publishing there, and
  // the only socket this may remove is the exact inode the dead predecessor's record names, once a
  // connect to it is refused.
  let claim: "clear" | "recover";
  try { claim = await claimSocketPath(paths.socket, lock.previous?.socket); }
  catch (error) {
    lock.discardPrevious();
    throw error;
  }
  if (claim === "recover") unlinkSync(paths.socket);
  await recoverPreviousRuntime(paths, uid, lock.previous);
  lock.discardPrevious();
  if (claim === "recover") {
    counters.socketsRecovered++;
    log(`daemon: recovered the socket its predecessor left at ${paths.socket} (its lifetime lock was already released)`);
  }

  // Bind on a private name inside the verified 0700 directory, then publish it at the fixed path
  // with link(2), which refuses to replace anything already there. Node's server.close() unlinks
  // whatever sits at the path it bound (measured on Node 24), so binding the private name means
  // close() can only ever remove that name, never a socket another process later put at the
  // public path. The private name is removed as soon as the link exists.
  // The temporary basename is 11 ASCII bytes, the same length as daemon.sock.
  const bindPath = join(paths.dir!, `.${randomBytes(7).toString("base64url")}`);
  assertSocketPathFits(bindPath);
  // umask is process-wide; it is narrowed only around listen() and restored in `finally`. The
  // directory is already verified 0700 and the bound socket is chmod-ed and re-checked below, so
  // the umask is defense in depth, not the guarantee.
  const previous = process.umask(0o177);
  try {
    await listen(server, bindPath);
  } finally {
    process.umask(previous);
  }
  const abort = async (e: unknown): Promise<never> => {
    await new Promise<void>((r) => server.close(() => r()));
    throw e;
  };
  try {
    chmodSync(bindPath, 0o600);
    checkSocket(bindPath, uid);
    // link(2) keeps the inode, so the bound name's (dev, ino) is the published socket's. Recording
    // it before the link means a crash anywhere after this point leaves a record that names the
    // socket actually at the path, which is what the next start correlates against.
    const bound = lstatSync(bindPath);
    lock.publishing({ path: paths.socket, dev: bound.dev, ino: bound.ino });
    linkSync(bindPath, paths.socket);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "EEXIST") return abort(new EndpointRefusal("ALREADY_RUNNING", `another process published ${paths.socket} first; nothing was replaced`));
    return abort(e);
  }
  unlinkSync(bindPath);
  try {
    checkSocket(paths.socket, uid);
  } catch (e) {
    return abort(e);
  }
  const { dev: boundDev, ino: boundIno } = generationOf(paths.socket);

  // Resume what this daemon home was connected to before it stopped. This runs after the endpoint
  // is published, so a space that is slow or unreachable never delays readiness; `service-status`

  return {
    async close() {
      await new Promise<void>((r) => server.close(() => r()));
      // Remove the public socket only if it is still the exact file (dev + ino) this process
      // created; a replacement of any kind is left in place.
      try {
        const st = lstatSync(paths.socket);
        if (st.isSocket() && st.uid === uid && st.dev === boundDev && st.ino === boundIno) unlinkSync(paths.socket);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
      }
    },
  };
}

/**
 * Windows: serve the pipe through the native listener, which hands over only connections whose
 * client process token it read; this keeps those whose user is this one. The name needs no cleanup:
 * it ends when the last instance closes.
 */
function publishPipe(paths: DaemonPaths, counters: ServerCounters, log: (line: string) => void, accept: (sock: Socket, peer: PipePeer) => void): Endpoint {
  let listener: PipeListener;
  try {
    listener = listenPipe(paths.socket);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "EADDRINUSE") {
      throw new EndpointRefusal("ALREADY_RUNNING", `${paths.socket} is already served by another process; nothing was replaced`,
        "find the process holding that pipe (Sysinternals `handle -a cotal-daemon` names it) and stop it, then run `cotal daemon serve` again");
    }
    throw e;
  }
  const own = windowsUserSid();
  let closing = false;
  const accepting = (async () => {
    for (;;) {
      let peer: PipePeer | PipeRefused;
      try {
        peer = await listener.accept();
      } catch (e) {
        if (!closing) log(`daemon: the pipe listener stopped (${(e as Error).message}); it accepts no more connections`);
        listener.close();
        return;
      }
      if ("refused" in peer) {
        counters.peerRejected++;
        log(`daemon: pipe peer identity unreadable (${peer.refused}); dropped before any frame was read`);
        continue;
      }
      if (peer.user !== own) {
        counters.peerRejected++;
        log(`daemon: pipe peer user ${peer.user} is not ${own}; dropped before any frame was read`);
        closeSync(peer.fd);
        continue;
      }
      let sock: Socket;
      try {
        sock = adoptPipe(peer.fd);
      } catch (e) {
        log(`daemon: could not adopt an authenticated pipe connection (${(e as Error).message}); dropped`);
        continue;
      }
      accept(sock, peer);
    }
  })();
  return {
    async close() {
      closing = true;
      listener.close();
      await accepting;
    },
  };
}

export { EndpointRefusal };
