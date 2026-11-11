/**
 * The client side of the local daemon endpoint, used by `cotal daemon status` and the other verbs.
 *
 * On Linux and macOS it refuses before connecting unless the directory and socket pass the same
 * ownership and mode checks the server applies. On every platform it refuses after connecting,
 * before writing a single byte, unless the kernel reports the answering process as this same user
 * and as the live holder of the daemon's lifetime lock. On Windows the native pipe open reads that
 * process's identity before Node sees the connection. So a squatter under another user, a process
 * that is not this daemon, or a socket in a loosened directory never receives a request.
 */
import { closeSync } from "node:fs";
import { connect as netConnect, type Socket } from "node:net";
import { validAccountComputerStatus } from "./account-state.js";
import { randomUUID } from "node:crypto";
import { connectPipe, windowsUserSid, type PipePeer } from "@cotal-ai/seat";
import { DAEMON_PROTOCOL_VERSION, MAX_LINE_BYTES, EndpointRefusal, adoptPipe, assertSupportedPlatform, checkDir, checkSocket, defaultPeerPid, defaultPeerUid, type DaemonPaths, type PeerPid, type PeerUid } from "./endpoint.js";
import { encode, type ConnectCheckResult, type DaemonRequest, type DaemonResponse, type DaemonStatus, type HostedManager, type LoginPrompt, type LoginResult, type RegisterResult, type ServiceConnectionResult } from "./protocol.js";
import { processBirth, readLifetimeRecord } from "./lifetime.js";
import { CommandFailure } from "@cotal-ai/workspace";

/** Ask the daemon whether it could register with `space`. Nothing is registered either way. */
export async function connectCheckViaDaemon(opts: Pick<QueryOptions, "paths" | "peerUid" | "peerPid" | "uid"> & { readonly space: string }): Promise<
  { readonly ok: true; readonly result: ConnectCheckResult } | { readonly ok: false; readonly code: string; readonly message: string }> {
  const sock = await openVerified({ ...opts, timeoutMs: 5000 });
  try {
    sock.write(encode({ v: DAEMON_PROTOCOL_VERSION, id: randomUUID().replaceAll("-", ""), op: "connect-check", space: opts.space }));
    // A cold readiness check exchanges the IdP token, then reads authority metadata (30 s each).
    const reply = JSON.parse(await readLine(sock, 65_000)) as DaemonResponse;
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
    // Cold readiness has two reads, followed by the stock register call (30 s each).
    const reply = JSON.parse(await readLine(sock, 95_000)) as DaemonResponse;
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

/** Send a bounded machine-control request after authenticating the daemon's live process. */
export async function managerViaDaemon(opts: Pick<QueryOptions, "paths" | "peerUid" | "peerPid">, request: { op: "manager-start" | "manager-status"; space: string } | { op: "managers-stop" | "managers-prepare-restart" | "managers-abort-restart" }): Promise<HostedManager | DaemonStatus> {
  const sock = await openVerified(opts);
  try {
    const id = randomUUID().replaceAll("-", "");
    sock.write(encode({ v: DAEMON_PROTOCOL_VERSION, id, ...request } as DaemonRequest));
    // A start may reconcile connectors for up to 120s, then wait for Manager readiness.
    const reply = JSON.parse(await readLine(sock, request.op === "manager-start" ? 250_000 : 130_000)) as DaemonResponse;
    if (!reply.ok) throw new CommandFailure("refused", "LIFECYCLE_BLOCKED", `the daemon refused ${request.op}: ${reply.error.code} ${reply.error.message}`, { native: { code: reply.error.code }, remedy: reply.error.remedy ?? (reply.error.code === "UNKNOWN_OP" ? "restart the recorded Cotal daemon user service with this platform's service manager, then retry" : "inspect the daemon's hosting records and retry the operation") });
    if (reply.id !== id || "event" in reply || !("state" in reply.result)) throw new Error("invalid Manager response");
    return reply.result as HostedManager | DaemonStatus;
  } finally { sock.destroy(); }
}

/** Ask the daemon to connect, disconnect or report its own service connection to `space`. */
export async function serviceViaDaemon(opts: Pick<QueryOptions, "paths" | "peerUid" | "peerPid" | "uid"> & { readonly space: string; readonly op: "service-connect" | "service-disconnect" | "service-status" }): Promise<
  { readonly ok: true; readonly result: ServiceConnectionResult } | { readonly ok: false; readonly code: string; readonly message: string }> {
  const sock = await openVerified({ ...opts, timeoutMs: 5000 });
  try {
    sock.write(encode({ v: DAEMON_PROTOCOL_VERSION, id: randomUUID().replaceAll("-", ""), op: opts.op, space: opts.space }));
    // A connect adds cold readiness's token exchange to the register replay, first renewal,
    // broker connection and `ready` (30 s each); allow for all of them.
    const reply = JSON.parse(await readLine(sock, 160_000)) as DaemonResponse;
    if (!reply.ok) return { ok: false, code: reply.error.code, message: reply.error.message };
    if ("event" in reply || !("state" in reply.result) || !("space" in reply.result)) return { ok: false, code: "BAD_REPLY", message: "the daemon answered the service request with something else" };
    return { ok: true, result: reply.result as ServiceConnectionResult };
  } finally {
    sock.destroy();
  }
}

export interface QueryOptions {
  readonly paths: DaemonPaths;
  /** Test hook (Linux, macOS): read the peer's kernel uid. Defaults to the native reader. Windows
   *  reads the peer inside the native pipe open and does not consult it. */
  readonly peerUid?: PeerUid;
  /** Test hook (Linux, macOS): read the peer's kernel pid, which must be the live owner of the
   *  daemon's lifetime lock. Defaults to the native reader; not consulted on Windows. */
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

/** Read one newline-terminated reply, refusing one longer than the line limit. */
export function readLine(sock: Socket, timeoutMs: number): Promise<string> {
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
    // Status includes parallel hosted-Manager observations, each bounded to fifteen seconds.
    const reply = await readLine(sock, opts.timeoutMs ?? 20_000);
    const parsed = JSON.parse(reply) as QueryReply;
    if (parsed.ok && parsed.result.account !== undefined && !validAccountComputerStatus(parsed.result.account))
      throw new Error("the daemon returned malformed account computer status");
    return parsed;
  } finally {
    sock.destroy();
  }
}

/** Connect only after the directory and socket checks pass, and keep the connection only when the
 *  kernel reports the listener as this same uid and as the holder of the daemon's lifetime lock.
 *  Nothing is written before all of them. */
export async function openVerified(opts: Pick<QueryOptions, "paths" | "peerUid" | "peerPid" | "uid" | "timeoutMs">): Promise<Socket> {
  assertSupportedPlatform();
  if (process.platform === "win32") return openPipe(opts.paths, opts.timeoutMs ?? 5000);
  const uid = opts.uid ?? process.geteuid!();
  const { paths } = opts;
  try {
    if (paths.parent !== undefined) checkDir(paths.parent, uid);
    checkDir(paths.dir!, uid);
    checkSocket(paths.socket, uid);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") throw new EndpointRefusal("NOT_RUNNING", `no daemon endpoint at ${paths.socket}`);
    throw e;
  }
  const sock = await connectTo(paths.socket, opts.timeoutMs ?? 5000);
  let peer: number;
  try {
    peer = (opts.peerUid ?? defaultPeerUid)(sock);
  } catch (e) {
    sock.destroy();
    throw new EndpointRefusal("PEER_UID_MISMATCH", `could not read the daemon's peer credentials: ${(e as Error).message}`);
  }
  if (peer !== uid) {
    sock.destroy();
    throw new EndpointRefusal("PEER_UID_MISMATCH", `the process answering at ${paths.socket} runs as uid ${peer}, not ${uid}; nothing was sent`);
  }
  // Same uid is not enough: the answering process must be the one holding this daemon's lifetime
  // lock, the same process (pid and process-start token) that lock's record names. The record is
  // read, never the lock itself, because taking the lock to test it would refuse a legitimate
  // start. The record is written only under the lock and cleared on a clean release.
  let pid: number | undefined;
  try { pid = (opts.peerPid ?? defaultPeerPid)(sock); } catch { pid = undefined; }
  if (pid === undefined || !isLockOwner(paths.lock, pid, processBirth(pid))) {
    sock.destroy();
    throw new EndpointRefusal("PEER_NOT_LOCK_OWNER", `the process answering at ${paths.socket} is not the daemon holding ${paths.lock}; nothing was sent`);
  }
  return sock;
}

/** Whether the lifetime lock at `lock` names process `pid` born at `birth`. */
function isLockOwner(lock: string, pid: number, birth: string | undefined): boolean {
  const owner = readLifetimeRecord(lock);
  return owner !== undefined && owner.pid === pid && owner.start !== undefined && birth === owner.start;
}

/** The pipe-open steps that read the server's identity. A failure in one means that identity could
 *  not be established, so nothing may be sent. */
const IDENTITY_STEPS = new Set(["GetNamedPipeServerProcessId", "OpenProcess", "GetProcessTimes", "OpenProcessToken", "GetTokenInformation", "ConvertSidToStringSidW"]);

/** Windows: open the daemon's pipe, which the native side authenticates, and keep it only when its
 *  server is this user and the holder of the lifetime lock. Nothing is written before both. */
async function openPipe(paths: DaemonPaths, timeoutMs: number): Promise<Socket> {
  let peer: PipePeer;
  try {
    peer = await connectPipe(paths.socket, timeoutMs);
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    if (err.code === "ENOENT") throw new EndpointRefusal("NOT_RUNNING", `no daemon answers at ${paths.socket}`);
    if (err.code === "ETIMEDOUT") throw new Error(`timed out connecting to ${paths.socket}`);
    // The pipe exists but its DACL does not admit this user: another account's process serves it.
    if (err.code === "EACCES" && err.syscall === "CreateFileW") throw new EndpointRefusal("PEER_UID_MISMATCH", `${paths.socket} is served by a process that does not admit this user; nothing was sent`);
    if (err.syscall !== undefined && IDENTITY_STEPS.has(err.syscall)) throw new EndpointRefusal("PEER_UID_MISMATCH", `could not read the daemon's peer identity: ${err.message}`);
    if (err.syscall === undefined) throw new EndpointRefusal("UNSUPPORTED_PLATFORM", `the daemon pipe needs this platform's native daemon helper: ${err.message}`);
    throw e;
  }
  const refuse = (code: "PEER_UID_MISMATCH" | "PEER_NOT_LOCK_OWNER", message: string): never => {
    closeSync(peer.fd);
    throw new EndpointRefusal(code, message);
  };
  const own = windowsUserSid();
  if (peer.user !== own) refuse("PEER_UID_MISMATCH", `the process answering at ${paths.socket} runs as ${peer.user}, not ${own}; nothing was sent`);
  if (!isLockOwner(paths.lock, peer.pid, peer.birth)) refuse("PEER_NOT_LOCK_OWNER", `the process answering at ${paths.socket} is not the daemon holding ${paths.lock}; nothing was sent`);
  return adoptPipe(peer.fd);
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
