/**
 * The `cotal daemon serve` listener: binds the local endpoint, answers `status` once it is ready,
 * and removes only its own socket on shutdown.
 *
 * Readiness is real: `status` can only be answered by a listener that has passed the directory
 * check, found the public path empty, bound a private name, verified it is a 0600 socket owned by
 * this uid, and published it with link(2), which yields exactly one winner among concurrent
 * starters. A peer whose kernel-reported uid differs is dropped before one byte of its input is
 * decoded.
 */
import { chmodSync, linkSync, unlinkSync, lstatSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { createServer, type Server, type Socket } from "node:net";
import { DAEMON_PROTOCOL_VERSION, MAX_LINE_BYTES, EndpointRefusal, assertLinux, checkSocket, ensureDir, refuseExisting, type DaemonPaths, type PeerUid } from "./endpoint.js";
import { encode, parseRequest, type DaemonResponse, type DaemonStatus } from "./protocol.js";
import { createLoginCoordinator, type LoginCoordinator } from "./login.js";
import { homeCotalDir } from "@cotal-ai/workspace";

/** Requests one connection may send. A sign-in needs two (start, cancel); status polling a few. */
export const MAX_REQUESTS_PER_CONNECTION = 64;

/** Counters a test or `status` can read. Every security decision increments exactly one. */
export interface ServerCounters {
  accepted: number;
  peerRejected: number;
  framesDecoded: number;
  requestsRefused: number;
  statusAnswered: number;
  loginsStarted: number;
  loginsRefused: number;
  cancelsAnswered: number;
}

export interface RunningDaemon {
  readonly paths: DaemonPaths;
  readonly counters: Readonly<ServerCounters>;
  readonly dirOutcome: "created" | "existing";
  status(): DaemonStatus;
  close(): Promise<void>;
}

export interface ServeOptions {
  readonly paths: DaemonPaths;
  readonly version: string;
  readonly peerUid: PeerUid;
  readonly uid?: number;
  readonly log?: (line: string) => void;
  /** Where a sign-in persists its session. Defaults to the machine-home Cotal directory, where
   *  `cotal login` keeps it. */
  readonly sessionDir?: string;
  /** Test hook: the stock sign-in to drive. */
  readonly login?: LoginCoordinator;
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
  assertLinux();
  const uid = opts.uid ?? process.geteuid!();
  const log = opts.log ?? (() => {});
  const { paths } = opts;
  const dirOutcome = ensureDir(paths.dir, uid);
  refuseExisting(paths.socket);

  const counters: ServerCounters = { accepted: 0, peerRejected: 0, framesDecoded: 0, requestsRefused: 0, statusAnswered: 0, loginsStarted: 0, loginsRefused: 0, cancelsAnswered: 0 };
  const login = opts.login ?? createLoginCoordinator({ sessionDir: opts.sessionDir ?? homeCotalDir() });
  const startedAt = new Date();
  const status = (): DaemonStatus => ({
    state: "ready",
    protocol: DAEMON_PROTOCOL_VERSION,
    version: opts.version,
    pid: process.pid,
    startedAt: startedAt.toISOString(),
    uptimeMs: Date.now() - startedAt.getTime(),
  });

  const sockets = new Set<Socket>();
  const server = createServer({ allowHalfOpen: false, pauseOnConnect: true }, (sock) => {
    sockets.add(sock);
    sock.once("close", () => sockets.delete(sock));
    sock.on("error", () => {});
    let peer: number;
    try {
      peer = opts.peerUid(sock);
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
      if (req.op === "status") {
        counters.statusAnswered++;
        void write({ v: DAEMON_PROTOCOL_VERSION, id: req.id, ok: true, result: status() });
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
      buf += chunk;
      bufBytes += Buffer.byteLength(chunk, "utf8");
      // Enforce the line limit while buffering: an unterminated stream is cut off at the limit,
      // never accumulated.
      if (bufBytes > MAX_LINE_BYTES && !buf.includes("\n")) {
        counters.requestsRefused++;
        const r: DaemonResponse = { v: DAEMON_PROTOCOL_VERSION, id: null, ok: false, error: { code: "LINE_TOO_LONG", message: `request exceeds ${MAX_LINE_BYTES} bytes` } };
        sock.removeAllListeners("data");
        sock.end(encode(r));
        sock.destroySoon();
        buf = "";
        bufBytes = 0;
        return;
      }
      let nl: number;
      while ((nl = buf.indexOf("\n")) !== -1) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        bufBytes = Buffer.byteLength(buf, "utf8");
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
  });

  // Bind on a private name inside the verified 0700 directory, then publish it at the fixed path
  // with link(2), which refuses to replace anything already there. Node's server.close() unlinks
  // whatever sits at the path it bound (measured on Node 24), so binding the private name means
  // close() can only ever remove that name, never a socket another process later put at the
  // public path. The private name is removed as soon as the link exists.
  const bindPath = join(paths.dir, `.bind-${process.pid}-${randomBytes(6).toString("hex")}`);
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
  const bound = lstatSync(paths.socket);
  const boundDev = bound.dev, boundIno = bound.ino;
  log(`daemon: ready at ${paths.socket}`);

  let closed: Promise<void> | undefined;
  const close = (): Promise<void> => {
    closed ??= (async () => {
      // An in-flight sign-in is cancelled through the stock fence before the listener goes away.
      await login.close();
      for (const s of sockets) s.destroy();
      await new Promise<void>((r) => server.close(() => r()));
      // Remove the public socket only if it is still the exact file (dev + ino) this process
      // created; a replacement of any kind is left in place.
      try {
        const st = lstatSync(paths.socket);
        if (st.isSocket() && st.uid === uid && st.dev === boundDev && st.ino === boundIno) unlinkSync(paths.socket);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
      }
    })();
    return closed;
  };

  return { paths, counters, dirOutcome, status, close };
}

export { EndpointRefusal };
