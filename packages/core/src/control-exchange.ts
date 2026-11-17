/**
 * The local control exchange: how a connector's control server and each of its clients (the
 * lifecycle hook relay, the Manager's stop and session calls, the Hermes bridge) prove to each other
 * that both hold the endpoint's key. Neither side ever sends the key.
 *
 * A client used to send the key in its first frame and print whatever came back. A stand-in that
 * took the name of a server that had exited (another local user on a shared `/tmp`, or any process
 * on the Windows pipe namespace) received the key and answered the hook. With remote permission
 * answers, a hook's reply can be "allow this tool call". So the exchange proves both ends:
 *
 *   C → S  {"v":1,"nonce":"<Nc>"}\n
 *   S → C  {"v":1,"nonce":"<Ns>","mac":"<Ms>"}\n
 *   C → S  <Mc> <request JSON>\n
 *   S → C  <Mr> <reply JSON>\n
 *
 * `Nc` and `Ns` are 32 fresh random bytes each, base64url without padding (43 characters). Every
 * MAC is HMAC-SHA256 keyed with the UTF-8 bytes of the endpoint token, base64url without padding,
 * over these exact bytes (`\0` is one zero byte; the request and reply are the UTF-8 bytes between
 * the single space and the newline):
 *
 *   Ms = HMAC(K, "cotal-control/1\0server\0" Nc "\0" Ns)
 *   Mc = HMAC(K, "cotal-control/1\0client\0" Nc "\0" Ns "\0" request)
 *   Mr = HMAC(K, "cotal-control/1\0reply\0"  Nc "\0" Ns "\0" reply)
 *
 * The role word keeps one side's MAC from being reflected as the other's, and both nonces make each
 * MAC good for one connection only. MACs are compared in constant time. The exchange authenticates
 * both ends and the request and reply; it does not encrypt them.
 *
 * The version travels with the endpoint and its key (the launch material, `LaunchSpec.control`), and
 * a build speaks exactly one. A client and server of different versions refuse each other: the hello
 * and the challenge each carry `v`, a mismatch drops the connection, and the version is inside every
 * MAC. Nothing is negotiated on the wire and there is no fallback.
 *
 * Off Windows the socket also sits in a directory only its user can enter, checked for owner and
 * mode when it is made and again by every client before it connects, so another user cannot create
 * a name there at all. On Windows the pipe namespace is global, and the exchange is the boundary.
 */
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { lstatSync, mkdirSync } from "node:fs";
import { connect, type Socket } from "node:net";
import { dirname } from "node:path";

/** The one exchange version this build speaks. */
export const CONTROL_PROTOCOL_VERSION = 1;

/** A connector's local control endpoint, as it travels from the launcher to every client. */
export interface ControlEndpoint {
  /** Socket path (POSIX) or pipe name (Windows). */
  path: string;
  /** The endpoint's shared secret. It keys every MAC and never crosses the socket. */
  token: string;
  /** The exchange version both ends must speak. */
  version: number;
}

/** How long a server keeps a connection that has not yet proved it holds the key: from accept until
 *  a request with a good MAC has arrived. A silent or slow client is dropped here, so a local process
 *  cannot camp on a finite pipe instance. */
export const CONTROL_SERVER_AUTH_DEADLINE_MS = 5_000;
/** How long a client waits, from connect, for the server to prove it holds the key. Separate from
 *  the server's deadline and shorter than any caller's reply budget, so a stand-in that says nothing
 *  cannot hold a hook for its whole budget. */
export const CONTROL_CLIENT_PROOF_DEADLINE_MS = 1_000;
/** Cap on the hello and the challenge, which are a version and a nonce or two. */
const MAX_HANDSHAKE_LINE_BYTES = 1024;
/** Cap on a request line. A request is one small lifecycle event or an op. */
export const MAX_CONTROL_REQUEST_BYTES = 1 << 20;

const NONCE = /^[A-Za-z0-9_-]{43}$/;
const MAC_CHARS = 43;

/** Throw unless `version` is the one this build speaks. `where` names the carrier for the message. */
export function assertControlVersion(version: unknown, where: string): asserts version is number {
  if (version === CONTROL_PROTOCOL_VERSION) return;
  throw new Error(
    `${where} carries control protocol version ${JSON.stringify(version)}, and this build speaks only ` +
      `version ${CONTROL_PROTOCOL_VERSION}. A launcher and connector from different releases refuse each ` +
      `other instead of falling back; upgrade both to the same release.`,
  );
}

function transcriptMac(token: string, role: "server" | "client" | "reply", nc: string, ns: string, body?: string): string {
  const mac = createHmac("sha256", Buffer.from(token, "utf8"));
  mac.update(`cotal-control/${CONTROL_PROTOCOL_VERSION}\0${role}\0${nc}\0${ns}`, "utf8");
  if (body !== undefined) mac.update(`\0${body}`, "utf8");
  return mac.digest("base64url");
}

/** Constant-time match of a presented MAC against the expected one. Compared as the exact 43 ASCII
 *  characters, so a second spelling of the same bytes is refused too. */
function macMatches(presented: unknown, expected: string): boolean {
  if (typeof presented !== "string" || presented.length !== MAC_CHARS) return false;
  const a = Buffer.from(presented, "latin1");
  const b = Buffer.from(expected, "latin1");
  return a.length === b.length && timingSafeEqual(a, b);
}

const nonce = (): string => randomBytes(32).toString("base64url");

/** The directory a POSIX control socket lives in, or undefined where no directory applies. */
function socketDir(path: string): string | undefined {
  return process.platform === "win32" ? undefined : dirname(path);
}

/** Throw unless `dir` is a real directory owned by this user and closed to group and others. */
function assertPrivateDir(dir: string): void {
  const st = lstatSync(dir);
  const uid = process.getuid!();
  if (!st.isDirectory() || st.uid !== uid || (st.mode & 0o077) !== 0)
    throw new Error(
      `control socket directory ${dir} is not a private directory of this user (owner ${st.uid}, ` +
        `mode ${(st.mode & 0o7777).toString(8)}, expected owner ${uid} and no group or other access)`,
    );
}

/** Make the directory a control socket will be bound in, if it is missing, and check it is private.
 *  A server calls this before it binds, and the launcher when it mints the path. No-op on Windows. */
export function ensureControlSocketDir(path: string): void {
  if (path.startsWith("\0"))
    throw new Error("control socket path is in the Linux abstract namespace, which any local user can bind; use a path in a private directory");
  const dir = socketDir(path);
  if (!dir) return;
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  assertPrivateDir(dir);
}

/** What a client finds when it checks an endpoint's directory before dialing. `absent` means the
 *  directory does not exist (yet), which reads like a server that is not up. `refused` means it
 *  exists and is not private, and counts as no endpoint. */
export type ControlDirCheck = { ok: true } | { ok: false; absent: boolean; reason: string };

/** Check the directory a control socket lives in before connecting to it. Every client calls this
 *  right before each dial. Always ok on Windows, where the exchange is the only boundary. */
export function checkControlSocketDir(path: string): ControlDirCheck {
  if (path.startsWith("\0")) return { ok: false, absent: false, reason: "the path is in the Linux abstract namespace, which any local user can bind" };
  const dir = socketDir(path);
  if (!dir) return { ok: true };
  try {
    assertPrivateDir(dir);
    return { ok: true };
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    return { ok: false, absent: code === "ENOENT", reason: (e as Error).message };
  }
}

/** Refuse an endpoint this build cannot speak to, before any socket is opened. */
function assertEndpoint(endpoint: ControlEndpoint): void {
  assertControlVersion(endpoint.version, "the control endpoint");
  if (typeof endpoint.token !== "string" || !endpoint.token) throw new Error("the control endpoint has no key");
}

/**
 * The client half, on a socket that has just connected. Sends the hello, waits up to
 * {@link CONTROL_CLIENT_PROOF_DEADLINE_MS} for the server's proof, sends the MAC'd `request`, and
 * calls `done` with the reply's JSON text once its MAC verifies.
 *
 * Any failure (a wrong version, a bad MAC or nonce, a malformed or oversized line, the proof
 * deadline, the connection closing first) destroys the socket and calls `done(undefined, reason)`.
 * Nothing from an unproven server is ever handed back. On success the socket stays open, so a caller
 * can send its delivery receipt; the caller owns it from there, and owns the overall reply deadline.
 */
export function clientExchange(
  sock: Socket,
  endpoint: ControlEndpoint,
  request: Record<string, unknown>,
  done: (reply: string | undefined, reason?: string) => void,
  opts: { proofDeadlineMs?: number; maxReplyBytes?: number } = {},
): void {
  assertEndpoint(endpoint);
  const nc = nonce();
  let ns: string | undefined;
  let buf = "";
  let settled = false;
  const finish = (reply: string | undefined, reason?: string): void => {
    if (settled) return;
    settled = true;
    clearTimeout(proof);
    sock.off("data", onData);
    sock.off("end", onEnd);
    sock.off("close", onEnd);
    if (reply === undefined) sock.destroy();
    done(reply, reason);
  };
  const proof = setTimeout(() => finish(undefined, "the server did not prove it holds the key in time"), opts.proofDeadlineMs ?? CONTROL_CLIENT_PROOF_DEADLINE_MS);
  proof.unref?.();
  const onEnd = (): void => finish(undefined, "the connection closed before a proven reply");
  const onData = (chunk: string): void => {
    buf += chunk;
    for (let nl = buf.indexOf("\n"); nl >= 0 && !settled; nl = buf.indexOf("\n")) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      if (ns === undefined) {
        let hello: { v?: unknown; nonce?: unknown; mac?: unknown };
        try {
          hello = JSON.parse(line) as typeof hello;
        } catch {
          return finish(undefined, "the server's challenge is not JSON");
        }
        if (hello?.v !== CONTROL_PROTOCOL_VERSION) return finish(undefined, `the server speaks control protocol ${JSON.stringify(hello?.v)}, not ${CONTROL_PROTOCOL_VERSION}`);
        if (typeof hello.nonce !== "string" || !NONCE.test(hello.nonce)) return finish(undefined, "the server's nonce is malformed");
        if (!macMatches(hello.mac, transcriptMac(endpoint.token, "server", nc, hello.nonce))) return finish(undefined, "the server did not prove it holds the key");
        ns = hello.nonce;
        clearTimeout(proof);
        const body = JSON.stringify(request);
        try {
          sock.write(`${transcriptMac(endpoint.token, "client", nc, ns, body)} ${body}\n`);
        } catch {
          return finish(undefined, "the connection closed before the request was sent");
        }
        continue;
      }
      const space = line.indexOf(" ");
      const body = line.slice(space + 1);
      if (space !== MAC_CHARS || !macMatches(line.slice(0, space), transcriptMac(endpoint.token, "reply", nc, ns, body)))
        return finish(undefined, "the reply's MAC does not verify");
      return finish(body);
    }
    if (ns === undefined && buf.length > MAX_HANDSHAKE_LINE_BYTES) finish(undefined, "the server's challenge is oversized");
    else if (ns !== undefined && opts.maxReplyBytes !== undefined && buf.length > opts.maxReplyBytes) finish(undefined, "the reply is oversized");
  };
  sock.setEncoding("utf8");
  sock.on("data", onData);
  sock.on("end", onEnd);
  sock.on("close", onEnd);
  try {
    sock.write(JSON.stringify({ v: CONTROL_PROTOCOL_VERSION, nonce: nc }) + "\n");
  } catch {
    finish(undefined, "the connection closed before the hello was sent");
  }
}

/** What the server half hands over once a client has proved itself. */
export interface ProvenRequest {
  /** The request's JSON text, exactly as the client MAC'd it. */
  request: string;
  /** One reply line for this connection: `<Mr> <body>\n`. */
  seal(body: string): string;
  /** Bytes the client sent after its request line, if any. */
  rest: string;
}

/**
 * The server half, on a freshly accepted socket. Answers the hello with the server's proof, then
 * verifies the client's MAC'd request and calls `onRequest`. The socket's listeners are detached
 * first, so the caller reads the connection from there on.
 *
 * Anything else is dropped before `onRequest` runs: a wrong version, a malformed hello, a bad MAC,
 * an oversized line, or no proven request within {@link CONTROL_SERVER_AUTH_DEADLINE_MS} of accept.
 * A dropped connection gets no reply. The deadline is absolute, not idle, so a client dribbling one
 * byte at a time cannot keep resetting it.
 */
export function serverExchange(
  sock: Socket,
  endpoint: ControlEndpoint,
  onRequest: (proven: ProvenRequest) => void,
  opts: { deadlineMs?: number } = {},
): void {
  assertEndpoint(endpoint);
  let nc: string | undefined;
  const ns = nonce();
  let buf = "";
  let settled = false;
  const drop = (): void => {
    if (settled) return;
    settled = true;
    clearTimeout(deadline);
    sock.destroy();
  };
  const deadline = setTimeout(drop, opts.deadlineMs ?? CONTROL_SERVER_AUTH_DEADLINE_MS);
  deadline.unref?.(); // never hold the process open on an unproven connection
  const onClose = (): void => {
    settled = true;
    clearTimeout(deadline);
  };
  const onData = (chunk: string): void => {
    if (settled) return;
    buf += chunk;
    for (let nl = buf.indexOf("\n"); nl >= 0 && !settled; nl = buf.indexOf("\n")) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      if (nc === undefined) {
        let hello: { v?: unknown; nonce?: unknown };
        try {
          hello = JSON.parse(line) as typeof hello;
        } catch {
          return drop();
        }
        if (hello?.v !== CONTROL_PROTOCOL_VERSION || typeof hello.nonce !== "string" || !NONCE.test(hello.nonce)) return drop();
        nc = hello.nonce;
        try {
          sock.write(JSON.stringify({ v: CONTROL_PROTOCOL_VERSION, nonce: ns, mac: transcriptMac(endpoint.token, "server", nc, ns) }) + "\n");
        } catch {
          return drop();
        }
        continue;
      }
      const space = line.indexOf(" ");
      const request = line.slice(space + 1);
      if (space !== MAC_CHARS || !macMatches(line.slice(0, space), transcriptMac(endpoint.token, "client", nc, ns, request))) return drop();
      settled = true;
      clearTimeout(deadline);
      sock.off("data", onData);
      sock.off("close", onClose);
      const proven = nc;
      onRequest({ request, rest: buf, seal: (body) => `${transcriptMac(endpoint.token, "reply", proven, ns, body)} ${body}\n` });
      return;
    }
    if (buf.length > (nc === undefined ? MAX_HANDSHAKE_LINE_BYTES : MAX_CONTROL_REQUEST_BYTES)) drop();
  };
  sock.setEncoding("utf8");
  sock.on("data", onData);
  sock.on("close", onClose);
}

/**
 * One request and its proven reply over a fresh connection, for a client that needs nothing more
 * (the Manager's stop and session calls). Resolves with the reply's JSON text. Rejects when the
 * socket's directory is not private, the dial fails, the server does not prove itself, or nothing
 * proven arrives within `timeoutMs`. The key is never sent.
 */
export function controlCall(
  endpoint: ControlEndpoint,
  request: Record<string, unknown>,
  opts: { timeoutMs: number; maxReplyBytes?: number },
): Promise<string> {
  return new Promise((resolve, reject) => {
    assertEndpoint(endpoint);
    const dir = checkControlSocketDir(endpoint.path);
    if (!dir.ok) return reject(new Error(dir.reason));
    let sock: Socket | undefined;
    let settled = false;
    const finish = (error?: Error, reply?: string): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      sock?.destroy();
      if (error) reject(error);
      else resolve(reply!);
    };
    const timer = setTimeout(() => finish(new Error("control call timed out")), opts.timeoutMs);
    timer.unref?.();
    try {
      sock = connect(endpoint.path);
    } catch (e) {
      return finish(e instanceof Error ? e : new Error(String(e)));
    }
    sock.on("error", (e) => finish(e));
    sock.on("connect", () =>
      clientExchange(sock!, endpoint, request, (reply, reason) => (reply === undefined ? finish(new Error(reason)) : finish(undefined, reply)), {
        maxReplyBytes: opts.maxReplyBytes,
      }),
    );
  });
}
