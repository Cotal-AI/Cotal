/**
 * The client side of the local daemon endpoint, used by `cotal daemon status`.
 *
 * It refuses before connecting unless the directory and socket pass the same ownership and mode
 * checks the server applies, and refuses after connecting, before writing a single byte, unless
 * the kernel reports the listening peer as this same uid. So a squatter under another uid, or a
 * socket in a loosened directory, never receives a request.
 */
import { connect as netConnect, type Socket } from "node:net";
import { randomUUID } from "node:crypto";
import { inspectLock, processStartToken } from "@cotal-ai/core";
import { DAEMON_PROTOCOL_VERSION, MAX_LINE_BYTES, EndpointRefusal, assertLinux, checkDir, checkSocket, type DaemonPaths, type PeerPid, type PeerUid } from "./endpoint.js";
import { encode, type ConnectCheckResult, type DaemonResponse, type DaemonStatus, type LoginPrompt, type LoginResult, type RegisterResult, type ServiceConnectionResult } from "./protocol.js";

/** Ask the daemon whether it could register with `space`. Nothing is registered either way. */
export async function connectCheckViaDaemon(opts: Pick<QueryOptions, "paths" | "peerUid" | "peerPid" | "uid"> & { readonly space: string }): Promise<
  { readonly ok: true; readonly result: ConnectCheckResult } | { readonly ok: false; readonly code: string; readonly message: string }> {
  const sock = await openVerified({ ...opts, timeoutMs: 5000 });
  try {
    sock.write(encode({ v: DAEMON_PROTOCOL_VERSION, id: randomUUID().replaceAll("-", ""), op: "connect-check", space: opts.space }));
    // The daemon's own network read is bounded by the stock client (30 s); allow a little more.
    const reply = JSON.parse(await readLine(sock, 35_000)) as DaemonResponse;
    if (!reply.ok) return { ok: false, code: reply.error.code, message: reply.error.message };
    if ("event" in reply || !("outcome" in reply.result) || !("space" in reply.result)) return { ok: false, code: "BAD_REPLY", message: "the daemon answered the connect check with something else" };
    return { ok: true, result: reply.result as ConnectCheckResult };
  } finally {
    sock.destroy();
  }
}

/** Ask the daemon to submit its own service registration for `space` and report the space's answer. */
export async function registerViaDaemon(opts: Pick<QueryOptions, "paths" | "peerUid" | "peerPid" | "uid"> & { readonly space: string }): Promise<
  { readonly ok: true; readonly result: RegisterResult } | { readonly ok: false; readonly code: string; readonly message: string }> {
  const sock = await openVerified({ ...opts, timeoutMs: 5000 });
  try {
    sock.write(encode({ v: DAEMON_PROTOCOL_VERSION, id: randomUUID().replaceAll("-", ""), op: "register", space: opts.space }));
    // Readiness read plus the stock register call, each bounded by the stock client (30 s).
    const reply = JSON.parse(await readLine(sock, 65_000)) as DaemonResponse;
    if (!reply.ok) return { ok: false, code: reply.error.code, message: reply.error.message };
    if ("event" in reply || !("outcome" in reply.result) || !("space" in reply.result)) return { ok: false, code: "BAD_REPLY", message: "the daemon answered the registration with something else" };
    return { ok: true, result: reply.result as RegisterResult };
  } finally {
    sock.destroy();
  }
}

export interface ClientCounters {
  bytesWritten: number;
}

/** Ask the daemon to connect, disconnect or report its own service connection to `space`. */
export async function serviceViaDaemon(opts: Pick<QueryOptions, "paths" | "peerUid" | "peerPid" | "uid"> & { readonly space: string; readonly op: "service-connect" | "service-disconnect" | "service-status" }): Promise<
  { readonly ok: true; readonly result: ServiceConnectionResult } | { readonly ok: false; readonly code: string; readonly message: string }> {
  const sock = await openVerified({ ...opts, timeoutMs: 5000 });
  try {
    sock.write(encode({ v: DAEMON_PROTOCOL_VERSION, id: randomUUID().replaceAll("-", ""), op: opts.op, space: opts.space }));
    // A connect runs the register replay, the first renewal, the broker connection and `ready`, each
    // bounded by its stock client (30 s); allow for all of them.
    const reply = JSON.parse(await readLine(sock, 130_000)) as DaemonResponse;
    if (!reply.ok) return { ok: false, code: reply.error.code, message: reply.error.message };
    if ("event" in reply || !("state" in reply.result) || !("space" in reply.result)) return { ok: false, code: "BAD_REPLY", message: "the daemon answered the service request with something else" };
    return { ok: true, result: reply.result as ServiceConnectionResult };
  } finally {
    sock.destroy();
  }
}

export interface QueryOptions {
  readonly paths: DaemonPaths;
  readonly peerUid: PeerUid;
  /** Required with an explicit daemon home ({@link DaemonPaths.lock}): the peer's kernel pid, which
   *  must be the live owner of that home's lifetime lock. */
  readonly peerPid?: PeerPid;
  readonly uid?: number;
  readonly timeoutMs?: number;
  /** Test hook: observe what the client wrote, including that it wrote nothing. */
  readonly counters?: ClientCounters;
  /** Test/contract hook: send this exact line instead of a well-formed status request. */
  readonly rawLine?: string;
}

function connectTo(path: string, timeoutMs: number): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const s = netConnect(path);
    const t = setTimeout(() => {
      s.destroy();
      reject(new Error(`timed out connecting to ${path}`));
    }, timeoutMs);
    s.once("connect", () => {
      clearTimeout(t);
      resolve(s);
    });
    s.once("error", (e: NodeJS.ErrnoException) => {
      clearTimeout(t);
      if (e.code === "ENOENT" || e.code === "ECONNREFUSED") reject(new EndpointRefusal("NOT_RUNNING", `no daemon answers at ${path}`));
      else reject(e);
    });
  });
}

function readLine(sock: Socket, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    let buf = "";
    const t = setTimeout(() => finish(new Error("timed out waiting for the daemon's reply")), timeoutMs);
    const finish = (err?: Error, line?: string) => {
      clearTimeout(t);
      sock.removeAllListeners("data");
      sock.removeAllListeners("end");
      sock.removeAllListeners("error");
      if (err) reject(err);
      else resolve(line!);
    };
    sock.setEncoding("utf8");
    sock.on("data", (chunk: string) => {
      buf += chunk;
      const nl = buf.indexOf("\n");
      if (nl !== -1) finish(undefined, buf.slice(0, nl));
      else if (Buffer.byteLength(buf, "utf8") > MAX_LINE_BYTES) finish(new Error("daemon reply exceeds the line limit"));
    });
    sock.once("end", () => finish(new Error("daemon closed the connection without a reply")));
    sock.once("error", (e) => finish(e));
  });
}

/** The only replies `queryDaemon` sees: it sends status (or a raw contract probe), never login-start,
 *  so no sign-in event can arrive on its connection. */
export type QueryReply = Extract<DaemonResponse, { ok: false }> | { readonly v: DaemonResponse["v"]; readonly id: string | null; readonly ok: true; readonly result: DaemonStatus };

/** Send one request and return the daemon's parsed reply. */
export async function queryDaemon(opts: QueryOptions): Promise<QueryReply> {
  const sock = await openVerified(opts);
  try {
    const line = opts.rawLine !== undefined ? `${opts.rawLine}\n` : encode({ v: DAEMON_PROTOCOL_VERSION, id: randomUUID().replaceAll("-", ""), op: "status" });
    (opts.counters ?? { bytesWritten: 0 }).bytesWritten += Buffer.byteLength(line, "utf8");
    sock.write(line);
    const reply = await readLine(sock, opts.timeoutMs ?? 5000);
    return JSON.parse(reply) as QueryReply;
  } finally {
    sock.destroy();
  }
}

/** Connect only after the directory and socket checks pass, and keep the connection only when the
 *  kernel reports the listener as this same uid. Nothing is written before both. */
async function openVerified(opts: Pick<QueryOptions, "paths" | "peerUid" | "peerPid" | "uid" | "timeoutMs">): Promise<Socket> {
  assertLinux();
  const uid = opts.uid ?? process.geteuid!();
  const { paths } = opts;
  if (paths.lock !== undefined && opts.peerPid === undefined) throw new Error("an explicit daemon home needs the peer pid check");
  try {
    if (paths.parent !== undefined) checkDir(paths.parent, uid);
    checkDir(paths.dir, uid);
    checkSocket(paths.socket, uid);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") throw new EndpointRefusal("NOT_RUNNING", `no daemon endpoint at ${paths.socket}`);
    throw e;
  }
  const sock = await connectTo(paths.socket, opts.timeoutMs ?? 5000);
  let peer: number;
  try {
    peer = opts.peerUid(sock);
  } catch (e) {
    sock.destroy();
    throw new EndpointRefusal("PEER_UID_MISMATCH", `could not read the daemon's peer credentials: ${(e as Error).message}`);
  }
  if (peer !== uid) {
    sock.destroy();
    throw new EndpointRefusal("PEER_UID_MISMATCH", `the process answering at ${paths.socket} runs as uid ${peer}, not ${uid}; nothing was sent`);
  }
  if (paths.lock !== undefined) {
    // Same uid is not enough for an explicit daemon home: the answering process must be the one
    // holding that home's lifetime lock, the same process (pid and start token) the lock recorded.
    let pid: number | undefined;
    try { pid = opts.peerPid!(sock); } catch { pid = undefined; }
    const held = inspectLock(paths.lock);
    const owner = held.state === "active" ? held.owner : undefined;
    if (pid === undefined || owner === undefined || owner.pid !== pid || owner.start === undefined || processStartToken(pid) !== owner.start) {
      sock.destroy();
      throw new EndpointRefusal("PEER_NOT_LOCK_OWNER", `the process answering at ${paths.socket} is not the daemon holding ${paths.lock}; nothing was sent`);
    }
  }
  return sock;
}

export interface LoginOptions extends Pick<QueryOptions, "paths" | "peerUid" | "peerPid" | "uid"> {
  readonly idp: string;
  readonly clientId?: string;
  readonly onPrompt: (prompt: LoginPrompt) => void;
  /** Aborting sends login-cancel for this attempt and waits for the daemon's answer. */
  readonly signal?: AbortSignal;
}

export type LoginReply =
  | { readonly ok: true; readonly attempt: string; readonly result: LoginResult }
  | { readonly ok: false; readonly code: string; readonly message: string }
  /** Aborted before the daemon named an attempt. The connection was closed, which makes the daemon
   *  cancel whatever it had started; no daemon outcome was received. */
  | { readonly ok: false; readonly code: "ABANDONED"; readonly message: string };

/** Ask the daemon to sign in, show its prompt, and return its single result. */
export async function loginViaDaemon(opts: LoginOptions): Promise<LoginReply> {
  const sock = await openVerified(opts);
  try {
    const id = randomUUID().replaceAll("-", "");
    return await new Promise<LoginReply>((resolve, reject) => {
      let buf = "";
      let attempt: string | undefined;
      const cleanup = () => { sock.removeAllListeners("data"); sock.removeAllListeners("end"); sock.removeAllListeners("error"); opts.signal?.removeEventListener("abort", onAbort); };
      const finish = (r: LoginReply | Error) => { cleanup(); if (r instanceof Error) reject(r); else resolve(r); };
      const abandoned = { ok: false as const, code: "ABANDONED" as const, message: "stopped before the daemon showed a prompt; the connection was closed, which cancels the sign-in on the daemon" };
      const onAbort = () => {
        if (!attempt) return finish(abandoned);
        sock.write(encode({ v: DAEMON_PROTOCOL_VERSION, id: `${id}c`.slice(0, 64), op: "login-cancel", attempt }));
      };
      sock.setEncoding("utf8");
      sock.on("data", (chunk: string) => {
        buf += chunk;
        if (Buffer.byteLength(buf, "utf8") > MAX_LINE_BYTES && !buf.includes("\n")) return finish(new Error("daemon reply exceeds the line limit"));
        let nl: number;
        while ((nl = buf.indexOf("\n")) !== -1) {
          const msg = JSON.parse(buf.slice(0, nl)) as DaemonResponse;
          buf = buf.slice(nl + 1);
          if (msg.id !== id) continue;
          if (!msg.ok) return finish({ ok: false, code: msg.error.code, message: msg.error.message });
          if ("event" in msg && msg.event === "login-prompt") { attempt = msg.attempt; opts.onPrompt(msg.prompt); }
          else if ("event" in msg && msg.event === "login-result") return finish({ ok: true, attempt: msg.attempt, result: msg.result });
        }
      });
      sock.once("end", () => finish(new Error("the daemon closed the connection before the sign-in finished")));
      sock.once("error", (e) => finish(e));
      if (opts.signal?.aborted) return finish(abandoned);
      opts.signal?.addEventListener("abort", onAbort, { once: true });
      sock.write(encode({ v: DAEMON_PROTOCOL_VERSION, id, op: "login-start", idp: opts.idp, ...(opts.clientId !== undefined ? { clientId: opts.clientId } : {}) }));
    });
  } finally {
    sock.destroy();
  }
}
