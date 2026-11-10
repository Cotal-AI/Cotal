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
import { join } from "node:path";
import { createServer, type Server, type Socket } from "node:net";
import { listenPipe, windowsUserSid, type PipeListener, type PipePeer, type PipeRefused } from "@cotal-ai/seat";
import { DAEMON_PROTOCOL_VERSION, MAX_LINE_BYTES, EndpointRefusal, adoptPipe, assertSocketPathFits, assertSupportedPlatform, checkSocket, defaultPeerUid, ensureDir, ensureStateDir, type DaemonPaths, type PeerUid } from "./endpoint.js";
import { claimSocketPath, generationOf, holdLifetime, type HeldLifetime } from "./lifetime.js";
import { encode, parseRequest, type ConnectCheckResult, type DaemonResponse, type DaemonStatus, type HostedManager, type RegisterResult, type ServiceConnectionResult } from "./protocol.js";
import { createLoginCoordinator, type LoginCoordinator } from "./login.js";
import { connectCheck } from "./connect.js";
import { registerDaemon } from "./register.js";
import { createServiceConnections } from "./service.js";
import { homeCotalDir } from "@cotal-ai/workspace";
import { desktopSpaces } from "./desktop-state.js";
import { withIdpSessionDir } from "@cotal-ai/auth";
import { createHostedManagers, HostedManagerRefusal } from "./manager.js";

/** Requests one connection may send. A sign-in needs two (start, cancel); status polling a few. */
export const MAX_REQUESTS_PER_CONNECTION = 64;

/** Counters a test or `status` can read. Every security decision increments exactly one. */
export interface ServerCounters {
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
  /** Test hook: the stock sign-in to drive. */
  readonly login?: LoginCoordinator;
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
  const uid = process.platform === "win32" ? undefined : (opts.uid ?? process.geteuid!());
  const { paths } = opts;
  // The lifetime lock comes before any endpoint path, for both daemon forms. A second serve for the
  // same daemon refuses here and never reaches the socket; and because publishing the socket needs
  // this lock, holding it is what makes removing a dead predecessor's socket safe below.
  ensureStateDir(paths, uid);
  const lock = holdLifetime(paths.lock);
  try {
    return await serveLocked(opts, uid, lock);
  } catch (e) {
    // A failed start keeps any predecessor socket evidence it has not consumed or rejected.
    // A started daemon releases the lock only in close(), clearing its own record.
    lock.release({ preservePrevious: true });
    throw e;
  }
}

async function serveLocked(opts: ServeOptions, uid: number | undefined, lock: HeldLifetime): Promise<RunningDaemon> {
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
  const services = createServiceConnections(machineHome);
  const managers = createHostedManagers(machineHome, opts.version, opts.sessionDir);
  const startedAt = new Date();
  let generation: DaemonStatus["generation"];
  const status = (): DaemonStatus => ({
    state: "ready",
    protocol: DAEMON_PROTOCOL_VERSION,
    version: opts.version,
    pid: process.pid,
    startedAt: startedAt.toISOString(),
    uptimeMs: Date.now() - startedAt.getTime(),
    managers: managers.all(),
    ...(generation ? { generation } : {}),
  });

  const sockets = new Set<Socket>();
  const track = (sock: Socket): void => {
    sockets.add(sock);
    sock.once("close", () => sockets.delete(sock));
    sock.on("error", () => {});
  };
  // One connection whose peer the kernel already reported as this user: decode its requests.
  const serveConnection = (sock: Socket): void => {
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
    const refuse = (id: string | null, code: "LOGIN_IN_PROGRESS" | "TOO_MANY_REQUESTS", message: string) => {
      counters.requestsRefused++;
      return write({ v: DAEMON_PROTOCOL_VERSION, id, ok: false, error: { code, message } });
    };
    sock.once("close", () => {
      for (const attempt of owned) void login.cancel(attempt);
      owned.clear();
    });
    const handle = (line: string): void => {
      counters.framesDecoded++;
      const parsed = parseRequest(line);
      if (!parsed.ok) {
        counters.requestsRefused++;
        void write({ v: DAEMON_PROTOCOL_VERSION, id: parsed.id, ok: false, error: { code: parsed.code, message: parsed.message } });
        return;
      }
      const req = parsed.request;
      const managerResult = (run: () => DaemonStatus | HostedManager | ServiceConnectionResult | Promise<DaemonStatus | HostedManager | ServiceConnectionResult>) => {
        void Promise.resolve().then(run).then((result) => write({ v: DAEMON_PROTOCOL_VERSION, id: req.id, ok: true, result }), (error: unknown) => {
          counters.requestsRefused++;
          if (error instanceof HostedManagerRefusal) return write({ v: DAEMON_PROTOCOL_VERSION, id: req.id, ok: false, error: { code: error.code, message: error.message.slice(0, 1500), remedy: error.remedy.slice(0, 1500) } });
          return write({ v: DAEMON_PROTOCOL_VERSION, id: req.id, ok: false, error: { code: "MANAGER_UNAVAILABLE", message: "the daemon could not complete the Manager operation; inspect its hosting records and retry" } });
        });
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
          if (req.op === "managers-prepare-restart") await managers.prepareGenerationRestart();
          else await managers.abortGenerationRestart();
          return status();
        });
        return;
      }
      if (req.op === "status") {
        counters.statusAnswered++;
        managerResult(async () => { await Promise.all(managers.all().map((manager) => managers.refresh(manager.space))); return status(); });
        return;
      }
      if (req.op === "spaces") {
        void desktopSpaces(machineHome, req.refresh === true).then((result) => {
          counters.spacesAnswered++;
          return write({ v: DAEMON_PROTOCOL_VERSION, id: req.id, ok: true, result });
        }, () => {
          counters.requestsRefused++;
          return write({ v: DAEMON_PROTOCOL_VERSION, id: req.id, ok: false, error: { code: "SPACES_UNAVAILABLE", message: "the daemon could not read its spaces" } });
        });
        return;
      }
      if (req.op === "connect-check") {
        void connectCheck(req.space, machineHome).catch((): ConnectCheckResult => ({ outcome: "refused", space: req.space, message: "the daemon could not complete the check" }))
          .then((result) => {
            counters.connectChecksAnswered++;
            return write({ v: DAEMON_PROTOCOL_VERSION, id: req.id, ok: true, result });
          });
        return;
      }
      if (req.op === "register") {
        void withIdpSessionDir(machineHome, () => registerDaemon(req.space, machineHome)).catch((): RegisterResult => ({ outcome: "refused", space: req.space, message: "the daemon could not complete the registration request; nothing is connected" }))
          .then((result) => {
            counters.registersAnswered++;
            return write({ v: DAEMON_PROTOCOL_VERSION, id: req.id, ok: true, result });
          });
        return;
      }
      if (req.op === "service-connect" || req.op === "service-disconnect" || req.op === "service-status") {
        const run = req.op === "service-status" ? Promise.resolve(services.status(req.space))
          : withIdpSessionDir(machineHome, async () => {
            if (req.op === "service-connect") return services.connect(req.space);
            await managers.disconnect(req.space);
            return services.disconnect(req.space);
          })
            .catch((): ServiceConnectionResult => ({ space: req.space, state: "unavailable", message: "the daemon could not complete the request; nothing is connected" }));
        managerResult(async () => {
          const result = await run;
          counters.serviceAnswered++;
          return { ...result, manager: req.op === "service-status" ? await managers.refresh(req.space) : managers.status(req.space) };
        });
        return;
      }
      if (req.op === "login-cancel") {
        void login.cancel(req.attempt).then((result) => {
          counters.cancelsAnswered++;
          return write({ v: DAEMON_PROTOCOL_VERSION, id: req.id, ok: true, result });
        });
        return;
      }
      const started = login.start({
        idp: req.idp,
        ...(req.clientId !== undefined ? { clientId: req.clientId } : {}),
        onPrompt: (attempt, prompt) => void write({ v: DAEMON_PROTOCOL_VERSION, id: req.id, ok: true, event: "login-prompt", attempt, prompt }),
        onResult: async (attempt, result) => {
          owned.delete(attempt);
          await write({ v: DAEMON_PROTOCOL_VERSION, id: req.id, ok: true, event: "login-result", attempt, result });
        },
      });
      if (!started) {
        counters.loginsRefused++;
        void refuse(req.id, "LOGIN_IN_PROGRESS", "a sign-in is already in progress on this daemon; cancel it or wait for its result");
        return;
      }
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
          sock.end(encode(r));
          sock.destroySoon();
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
          void refuse(null, "TOO_MANY_REQUESTS", `a connection may send at most ${MAX_REQUESTS_PER_CONNECTION} requests`).then(() => sock.end());
          return;
        }
        handle(line);
      }
    });
    sock.resume();
  };

  let endpoint: Endpoint;
  if (paths.dir === undefined) {
    endpoint = publishPipe(paths, counters, log, (sock) => { track(sock); serveConnection(sock); });
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
      serveConnection(sock);
    });
  }

  // Resume what this daemon home was connected to before it stopped. This runs after the endpoint
  // is published, so a space that is slow or unreachable never delays readiness; `service-status`
  // reports each one's real state. A space with no recorded intent is not connected.
  const managersResumed = managers.resume().catch(() => { log("daemon: hosted Manager records could not be resumed; inspect daemon status and the hosting records"); });
  const resumed = withIdpSessionDir(machineHome, () => services.resume()).then((spaces) => {
    counters.connectionsResumed = spaces.length;
    if (spaces.length) log(`daemon: resumed ${spaces.length} recorded service connection(s)`);
  }, () => {});

  let closed: Promise<void> | undefined;
  const close = (): Promise<void> => {
    closed ??= (async () => {
      // A resume still in flight is awaited first, so a stop never races a connect it started.
      await resumed;
      // An in-flight sign-in is cancelled through the stock fence before the listener goes away.
      await login.close();
      await managers.close();
      await managersResumed;
      // Every service connection, its endpoint and its renewal source close before the socket does.
      await services.close();
      for (const s of sockets) s.destroy();
      await endpoint.close();
      // The lock is released only once this daemon's own endpoint is gone. If its socket is still
      // published (its removal threw), the lock stays held until this process exits, so no other
      // serve can start beside a live endpoint.
      lock.release();
    })();
    return closed;
  };

  return { paths, counters, dirOutcome, status, close,
    generationSeats: () => managers.generationSeats(),
    generationPending(installed, waiting = "preparing activation") { generation = installed ? { installed, running: opts.version, waiting } : undefined; },
    async prepareGenerationRestart() { await managersResumed; await managers.prepareGenerationRestart(); }, abortGenerationRestart: () => managers.abortGenerationRestart() };
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
  const bindPath = join(paths.dir!, `.bind-${process.pid}-${randomBytes(6).toString("hex")}`);
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
function publishPipe(paths: DaemonPaths, counters: ServerCounters, log: (line: string) => void, accept: (sock: Socket) => void): Endpoint {
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
      accept(sock);
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
