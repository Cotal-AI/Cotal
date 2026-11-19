/**
 * The local control exchange: how a connector's control server and each of its clients (the
 * lifecycle hook relay, the Manager's stop and session calls) prove to each other that both hold the
 * endpoint's key. Neither side ever sends the key.
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
 *   C → S  <Mk>\n                      (only when the request asked for a delivery receipt)
 *
 * `Nc` and `Ns` are 32 fresh random bytes each, base64url without padding (43 characters). Every
 * MAC is HMAC-SHA256 keyed with the UTF-8 bytes of the endpoint key, base64url without padding (43
 * characters from `A-Z a-z 0-9 - _`), over these exact bytes (`\0` is one zero byte; the request and
 * reply are the bytes between the single space and the newline, and must be valid UTF-8):
 *
 *   Ms = HMAC(K, "cotal-control/1\0server\0"  Nc "\0" Ns)
 *   Mc = HMAC(K, "cotal-control/1\0client\0"  Nc "\0" Ns "\0" request)
 *   Mr = HMAC(K, "cotal-control/1\0reply\0"   Nc "\0" Ns "\0" reply)
 *   Mk = HMAC(K, "cotal-control/1\0receipt\0" Nc "\0" Ns "\0" reply)
 *
 * The role word keeps one side's MAC from being reflected as the other's, and both nonces make each
 * MAC good for one connection only. `Mk` binds the receipt to the reply it confirms, so a process
 * that forwards the connection without the key cannot confirm a reply it dropped. MACs are compared
 * in constant time, after the presented one is checked against the alphabet and length above. The
 * exchange authenticates both ends, the request, the reply and the receipt; it does not encrypt.
 *
 * Every line is bounded in bytes, complete or not, before it is parsed or a MAC is computed over
 * it: the hello and the challenge at 1 KiB, a request's JSON at {@link MAX_CONTROL_REQUEST_BYTES},
 * a reply's JSON at the caller's `maxReplyBytes`. The 44 bytes of MAC and space before a request or
 * reply do not count against its bound.
 *
 * The version travels with the endpoint and its key (the launch material, `LaunchSpec.control`), and
 * a build speaks exactly one. A client and server of different versions refuse each other: the hello
 * and the challenge each carry `v`, a mismatch drops the connection, and the version is inside every
 * MAC. Nothing is negotiated on the wire and there is no fallback.
 *
 * Off Windows the socket also sits in a directory only its user can enter, made fresh for each
 * launch under an unguessable name, and checked for owner and mode by the server before it binds and
 * by every client before it connects, so another user cannot create a name there at all. On Windows
 * the pipe namespace is global, and the exchange is the boundary.
 */
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { lstatSync } from "node:fs";
import { connect, type Socket } from "node:net";
import { dirname } from "node:path";

/** The one exchange version this build speaks. */
export const CONTROL_PROTOCOL_VERSION = 1;

/** A connector's local control endpoint, as it travels from the launcher to every client. */
export interface ControlEndpoint {
  /** Socket path (POSIX) or pipe name (Windows). */
  path: string;
  /** The endpoint's shared key. It keys every MAC and never crosses the socket. */
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
/** Cap on a request's JSON. A request is one small lifecycle event or an op. */
export const MAX_CONTROL_REQUEST_BYTES = 1 << 20;

const BASE64URL_43 = /^[A-Za-z0-9_-]{43}$/;
const MAC_CHARS = 43;
/** The MAC and the single space before a request or reply body. */
const MAC_PREFIX_BYTES = MAC_CHARS + 1;
const NEWLINE = 0x0a;
const SPACE = 0x20;
const utf8 = new TextDecoder("utf-8", { fatal: true });

/** Throw unless `version` is the one this build speaks. `where` names the carrier for the message. */
export function assertControlVersion(version: unknown, where: string): asserts version is number {
  if (version === CONTROL_PROTOCOL_VERSION) return;
  throw new Error(
    `${where} carries control protocol version ${JSON.stringify(version)}, and this build speaks only ` +
      `version ${CONTROL_PROTOCOL_VERSION}. A launcher and connector from different releases refuse each ` +
      `other instead of falling back; upgrade both to the same release.`,
  );
}

/** Refuse a reply cap that bounds nothing. The type requires one, but a JavaScript caller can omit it
 *  or pass `NaN` or `Infinity`, and every length comparison against those lets the reply through. */
function assertReplyCap(opts: { maxReplyBytes?: unknown } | undefined): void {
  const cap = opts?.maxReplyBytes;
  if (typeof cap !== "number" || !Number.isSafeInteger(cap) || cap < 0)
    throw new Error(`maxReplyBytes must be a finite, non-negative whole number of bytes, not ${typeof cap === "number" ? cap : typeof cap}`);
}

/** Refuse an endpoint this build cannot speak to, before any socket is opened or bound. */
export function assertControlEndpoint(endpoint: ControlEndpoint): void {
  assertControlVersion(endpoint.version, "the control endpoint");
  if (typeof endpoint.token !== "string" || !endpoint.token) throw new Error("the control endpoint has no key");
}

type Role = "server" | "client" | "reply" | "receipt";

function transcriptMac(token: string, role: Role, nc: string, ns: string, body?: Buffer): string {
  const mac = createHmac("sha256", Buffer.from(token, "utf8"));
  mac.update(`cotal-control/${CONTROL_PROTOCOL_VERSION}\0${role}\0${nc}\0${ns}`, "utf8");
  if (body !== undefined) mac.update("\0", "utf8").update(body);
  return mac.digest("base64url");
}

/** Constant-time match of a presented MAC against the expected one. The presented MAC must be 43
 *  characters of the base64url alphabet first, so no second spelling of the same bytes passes. */
function macMatches(presented: unknown, expected: string): boolean {
  if (typeof presented !== "string" || !BASE64URL_43.test(presented)) return false;
  return timingSafeEqual(Buffer.from(presented, "ascii"), Buffer.from(expected, "ascii"));
}

/** Split `<MAC> <body>` and verify the MAC over the body's exact bytes. Returns the body as text, or
 *  undefined when the shape, the MAC or the UTF-8 is wrong. */
function openSealed(line: Buffer, expected: (body: Buffer) => string): string | undefined {
  if (line.length < MAC_PREFIX_BYTES || line[MAC_CHARS] !== SPACE) return undefined;
  const body = line.subarray(MAC_PREFIX_BYTES);
  if (!macMatches(line.subarray(0, MAC_CHARS).toString("latin1"), expected(body))) return undefined;
  try {
    return utf8.decode(body);
  } catch {
    return undefined;
  }
}

/** Parse a handshake line as a JSON object, or undefined when it is not valid UTF-8 JSON. */
function parseHandshake(line: Buffer): Record<string, unknown> | undefined {
  try {
    const value = JSON.parse(utf8.decode(line)) as unknown;
    return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Feed a byte stream in, get newline-terminated lines out. `cap()` is the byte bound of the line
 * being read now, MAC included; a line longer than that, complete or not, calls `oversize` instead.
 * `onLine` returns false to stop reading.
 */
function lineReader(cap: () => number, onLine: (line: Buffer) => boolean, oversize: () => void): (chunk: Buffer) => void {
  let buf: Buffer = Buffer.alloc(0);
  let stopped = false;
  return (chunk) => {
    if (stopped) return;
    buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
    for (;;) {
      const limit = cap();
      const nl = buf.indexOf(NEWLINE);
      const length = nl < 0 ? buf.length : nl;
      if (length > limit) {
        stopped = true;
        return oversize();
      }
      if (nl < 0) return;
      const line = buf.subarray(0, nl);
      buf = buf.subarray(nl + 1);
      if (!onLine(line)) {
        stopped = true;
        return;
      }
    }
  };
}

const nonce = (): string => randomBytes(32).toString("base64url");

/** The directory a POSIX control socket lives in, or undefined where no directory applies. */
function socketDir(path: string): string | undefined {
  return process.platform === "win32" ? undefined : dirname(path);
}

/** Throw unless `dir` is a real directory owned by this user and closed to group and others. The
 *  message names what is wrong and how to recover. */
function assertPrivateDir(dir: string): void {
  const st = lstatSync(dir);
  const uid = process.getuid!();
  const problem = st.isSymbolicLink()
    ? "is a symbolic link, not a directory"
    : !st.isDirectory()
      ? "is not a directory"
      : st.uid !== uid
        ? `is owned by uid ${st.uid}, not by this user (uid ${uid})`
        : (st.mode & 0o077) !== 0
          ? `has mode ${(st.mode & 0o7777).toString(8)}, which lets group or others in`
          : undefined;
  if (problem)
    throw new Error(
      `control socket directory ${dir} ${problem}, so it is not a private directory of this user. ` +
        `Remove it if you did not create it, or point TMPDIR at a directory only you can write, and relaunch.`,
    );
}

/** Check the directory a control socket is about to be bound in: it must already exist, as a real
 *  directory owned by this user and closed to group and others. A server calls this before it binds.
 *  It never makes the directory, because by then the path is public: the launcher makes it when it
 *  mints the path, and a hand-driven path must name a directory its user made. No-op on Windows. */
export function assertControlSocketDir(path: string): void {
  if (path.startsWith("\0"))
    throw new Error("control socket path is in the Linux abstract namespace, which any local user can bind; use a path in a private directory");
  const dir = socketDir(path);
  if (!dir) return;
  try {
    assertPrivateDir(dir);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    throw new Error(
      `control socket directory ${dir} does not exist. The launcher makes it when it mints the endpoint; ` +
        `for a hand-driven COTAL_CONTROL_SOCKET, make it yourself with mode 0700.`,
    );
  }
}

/** What a client finds when it checks an endpoint's directory before dialing. `absent` means the
 *  directory does not exist (yet), which reads like a server that is not up. Otherwise it exists and
 *  is not private, and counts as no endpoint. */
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

/** How a client exchange ended. A refusal says whether the request had already been written, since
 *  past that point the server may have handled it even though no proven reply came back. */
export type ClientExchangeResult =
  | { ok: true; reply: string; receipt: string }
  | { ok: false; reason: string; requestSent: boolean };

/**
 * The client half, on a socket that has just connected. Sends the hello, waits up to
 * {@link CONTROL_CLIENT_PROOF_DEADLINE_MS} for the server's proof, sends the MAC'd `request`, and
 * calls `done` with the reply's JSON text once its MAC verifies, plus the receipt line (`<Mk>\n`) a
 * caller writes back when it asked for one and the reply has reached its own output. Every caller
 * bounds the reply: `maxReplyBytes` caps its JSON in bytes, complete or not, and a cap that is not a
 * finite, non-negative whole number throws before anything is sent. `onRequestSent` runs once
 * the request has been written, so a caller whose own deadline or socket error ends the exchange
 * later can say the server may have handled it.
 *
 * Any failure (a wrong version, a bad MAC or nonce, a malformed or oversized line, the proof
 * deadline, the connection closing first) destroys the socket and calls `done` with the reason.
 * Nothing from an unproven server is ever handed back. On success the socket stays open, so a caller
 * can send its receipt; the caller owns it from there, and owns the overall reply deadline.
 */
export function clientExchange(
  sock: Socket,
  endpoint: ControlEndpoint,
  request: Record<string, unknown>,
  done: (result: ClientExchangeResult) => void,
  opts: { proofDeadlineMs?: number; maxReplyBytes: number; onRequestSent?: () => void },
): void {
  assertReplyCap(opts);
  assertControlEndpoint(endpoint);
  const nc = nonce();
  let ns: string | undefined;
  let requestSent = false;
  let settled = false;
  const finish = (result: ClientExchangeResult): void => {
    if (settled) return;
    settled = true;
    clearTimeout(proof);
    sock.off("data", onData);
    sock.off("end", onEnd);
    sock.off("close", onEnd);
    if (!result.ok) sock.destroy();
    done(result);
  };
  const refuse = (reason: string): false => (finish({ ok: false, reason, requestSent }), false);
  const proof = setTimeout(() => refuse("the server did not prove it holds the key in time"), opts.proofDeadlineMs ?? CONTROL_CLIENT_PROOF_DEADLINE_MS);
  proof.unref?.();
  const onEnd = (): void => void refuse("the connection closed before a proven reply");
  const onLine = (line: Buffer): boolean => {
    if (ns === undefined) {
      const challenge = parseHandshake(line);
      if (!challenge) return refuse("the server's challenge is not JSON");
      if (challenge.v !== CONTROL_PROTOCOL_VERSION) return refuse(`the server speaks control protocol ${JSON.stringify(challenge.v)}, not ${CONTROL_PROTOCOL_VERSION}`);
      if (typeof challenge.nonce !== "string" || !BASE64URL_43.test(challenge.nonce)) return refuse("the server's nonce is malformed");
      if (!macMatches(challenge.mac, transcriptMac(endpoint.token, "server", nc, challenge.nonce))) return refuse("the server did not prove it holds the key");
      ns = challenge.nonce;
      clearTimeout(proof);
      const body = Buffer.from(JSON.stringify(request), "utf8");
      try {
        requestSent = true;
        sock.write(Buffer.concat([Buffer.from(`${transcriptMac(endpoint.token, "client", nc, ns, body)} `, "ascii"), body, Buffer.from("\n")]));
      } catch {
        return refuse("the connection closed before the request was sent");
      }
      opts.onRequestSent?.();
      return true;
    }
    const proven = ns;
    const reply = openSealed(line, (body) => transcriptMac(endpoint.token, "reply", nc, proven, body));
    if (reply === undefined) return refuse("the reply's MAC does not verify");
    const receipt = `${transcriptMac(endpoint.token, "receipt", nc, proven, line.subarray(MAC_PREFIX_BYTES))}\n`;
    finish({ ok: true, reply, receipt });
    return false;
  };
  const onData = lineReader(
    () => (ns === undefined ? MAX_HANDSHAKE_LINE_BYTES : MAC_PREFIX_BYTES + opts.maxReplyBytes),
    onLine,
    () => void refuse(ns === undefined ? "the server's challenge is oversized" : "the reply is oversized"),
  );
  sock.on("data", onData);
  sock.on("end", onEnd);
  sock.on("close", onEnd);
  try {
    sock.write(JSON.stringify({ v: CONTROL_PROTOCOL_VERSION, nonce: nc }) + "\n");
  } catch {
    refuse("the connection closed before the hello was sent");
  }
}

/** One reply for a proven connection, and the receipt that confirms it. */
export interface SealedReply {
  /** The reply line: `<Mr> <body>\n`. */
  line: string;
  /** Whether `presented` (one line, without its newline) is this connection's receipt for this reply. */
  receiptMatches(presented: string): boolean;
}

/** What the server half hands over once a client has proved itself. */
export interface ProvenRequest {
  /** The request's JSON text, exactly as the client MAC'd it. */
  request: string;
  /** Seal one reply for this connection. */
  seal(body: string): SealedReply;
}

/**
 * The server half, on a freshly accepted socket. Answers the hello with the server's proof, then
 * verifies the client's MAC'd request and calls `onRequest`. The socket's listeners are detached
 * first, so the caller reads the connection from there on, as raw bytes.
 *
 * Anything else is dropped before `onRequest` runs: a wrong version, a malformed hello, a bad MAC,
 * an oversized line, invalid UTF-8, or no proven request within
 * {@link CONTROL_SERVER_AUTH_DEADLINE_MS} of accept. A dropped connection gets no reply. The deadline
 * is absolute, not idle, so a client dribbling one byte at a time cannot keep resetting it.
 */
export function serverExchange(
  sock: Socket,
  endpoint: ControlEndpoint,
  onRequest: (proven: ProvenRequest) => void,
  opts: { deadlineMs?: number } = {},
): void {
  assertControlEndpoint(endpoint);
  let nc: string | undefined;
  const ns = nonce();
  let settled = false;
  const drop = (): false => {
    if (!settled) {
      settled = true;
      clearTimeout(deadline);
      sock.destroy();
    }
    return false;
  };
  const deadline = setTimeout(drop, opts.deadlineMs ?? CONTROL_SERVER_AUTH_DEADLINE_MS);
  deadline.unref?.(); // never hold the process open on an unproven connection
  const onClose = (): void => {
    settled = true;
    clearTimeout(deadline);
  };
  const onLine = (line: Buffer): boolean => {
    if (settled) return false;
    if (nc === undefined) {
      const hello = parseHandshake(line);
      if (!hello || hello.v !== CONTROL_PROTOCOL_VERSION || typeof hello.nonce !== "string" || !BASE64URL_43.test(hello.nonce)) return drop();
      nc = hello.nonce;
      try {
        sock.write(JSON.stringify({ v: CONTROL_PROTOCOL_VERSION, nonce: ns, mac: transcriptMac(endpoint.token, "server", nc, ns) }) + "\n");
      } catch {
        return drop();
      }
      return true;
    }
    const proven = nc;
    const request = openSealed(line, (body) => transcriptMac(endpoint.token, "client", proven, ns, body));
    if (request === undefined) return drop();
    settled = true;
    clearTimeout(deadline);
    sock.off("data", onData);
    sock.off("close", onClose);
    onRequest({
      request,
      seal: (text) => {
        const body = Buffer.from(text, "utf8");
        const receipt = transcriptMac(endpoint.token, "receipt", proven, ns, body);
        return {
          line: `${transcriptMac(endpoint.token, "reply", proven, ns, body)} ${text}\n`,
          receiptMatches: (presented) => macMatches(presented, receipt),
        };
      },
    });
    return false;
  };
  const onData = lineReader(() => (nc === undefined ? MAX_HANDSHAKE_LINE_BYTES : MAC_PREFIX_BYTES + MAX_CONTROL_REQUEST_BYTES), onLine, () => void drop());
  sock.on("data", onData);
  sock.on("close", onClose);
}

/**
 * One request and its proven reply over a fresh connection, for a client that needs nothing more
 * (the Manager's stop and session calls). Resolves with the reply's JSON text. Rejects before dialing
 * when `maxReplyBytes` is not a finite, non-negative whole number, and rejects when the socket's
 * directory is not private, the dial fails, the server does not prove itself, the reply's
 * JSON is over `maxReplyBytes`, or nothing proven arrives within `timeoutMs`. The key is never sent.
 */
export function controlCall(
  endpoint: ControlEndpoint,
  request: Record<string, unknown>,
  opts: { timeoutMs: number; maxReplyBytes: number },
): Promise<string> {
  return new Promise((resolve, reject) => {
    assertReplyCap(opts);
    assertControlEndpoint(endpoint);
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
      clientExchange(sock!, endpoint, request, (result) => (result.ok ? finish(undefined, result.reply) : finish(new Error(result.reason))), {
        maxReplyBytes: opts.maxReplyBytes,
      }),
    );
  });
}
