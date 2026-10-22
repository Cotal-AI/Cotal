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
import { DAEMON_PROTOCOL_VERSION, MAX_LINE_BYTES, EndpointRefusal, assertLinux, checkDir, checkSocket, type DaemonPaths, type PeerUid } from "./endpoint.js";
import { encode, type DaemonResponse } from "./protocol.js";

export interface ClientCounters {
  bytesWritten: number;
}

export interface QueryOptions {
  readonly paths: DaemonPaths;
  readonly peerUid: PeerUid;
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

/** Send one request and return the daemon's parsed reply. */
export async function queryDaemon(opts: QueryOptions): Promise<DaemonResponse> {
  assertLinux();
  const uid = opts.uid ?? process.geteuid!();
  const timeoutMs = opts.timeoutMs ?? 5000;
  const counters = opts.counters ?? { bytesWritten: 0 };
  const { paths } = opts;
  try {
    checkDir(paths.dir, uid);
    checkSocket(paths.socket, uid);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") throw new EndpointRefusal("NOT_RUNNING", `no daemon endpoint at ${paths.socket}`);
    throw e;
  }
  const sock = await connectTo(paths.socket, timeoutMs);
  try {
    let peer: number;
    try {
      peer = opts.peerUid(sock);
    } catch (e) {
      throw new EndpointRefusal("PEER_UID_MISMATCH", `could not read the daemon's peer credentials: ${(e as Error).message}`);
    }
    if (peer !== uid) throw new EndpointRefusal("PEER_UID_MISMATCH", `the process answering at ${paths.socket} runs as uid ${peer}, not ${uid}; nothing was sent`);
    const line = opts.rawLine !== undefined ? `${opts.rawLine}\n` : encode({ v: DAEMON_PROTOCOL_VERSION, id: randomUUID().replaceAll("-", ""), op: "status" });
    counters.bytesWritten += Buffer.byteLength(line, "utf8");
    sock.write(line);
    const reply = await readLine(sock, timeoutMs);
    return JSON.parse(reply) as DaemonResponse;
  } finally {
    sock.destroy();
  }
}
