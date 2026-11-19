// Dialing, auth options, bearer lifetimes and the reachability probes, moved verbatim from endpoint.ts.
// endpoint.ts re-exports the names it exported before, so the package's export set is unchanged.
import { createConnection, isIP } from "node:net";
import {
  connect,
  tokenAuthenticator,
  AuthorizationError,
  PermissionViolationError,
  UserAuthenticationExpiredError,
  TimeoutError,
  ConnectionError,
} from "@nats-io/transport-node";
import { wsconnect } from "@nats-io/nats-core";
import { type PushConsumer } from "@nats-io/jetstream";
import { type KV } from "@nats-io/kv";
import { nativeCredsAuthenticator } from "./creds-authenticator.js";
import { renewalDeadlineMs } from "./renewal.js";
import { inspectCredHealth } from "./provision.js";

export const DEFAULT_SERVER = "nats://127.0.0.1:4222";

/** Auth subset of connect() options, shared by the endpoint and isReachable. `bearer` may be a
 *  sync GETTER — nats.js re-evaluates token authenticators per (re)connect attempt, which is how a
 *  refreshing endpoint presents its freshest bearer without rebuilding the connection options. */
interface AuthOpts {
  token?: string;
  user?: string;
  pass?: string;
  /** May be a sync GETTER (like `bearer`) — the authenticator then re-reads it per (re)connect
   *  attempt, which is how a standing-renewal endpoint presents its freshest cred. */
  creds?: string | (() => string);
  /** Observe only the credential actually presented, including native reconnect authentication. */
  onCreds?: (creds: string) => void;
  bearer?: string | (() => string);
  sentinelCreds?: string;
  tls?: boolean;
}

export function authOpts(a: AuthOpts) {
  const tls = a.tls ? {} : undefined;
  // USER MODE: present the shared auth-account sentinel creds AND the user bearer as `auth_token` (an
  // authenticator ARRAY — nats.js merges them into one CONNECT). The connect lands in the callout
  // account, which validates the bearer and re-binds the client into the data account with a scoped JWT.
  if (a.bearer) {
    if (a.creds || a.token || a.user || a.pass)
      throw new Error("bearer (user-mode auth) is mutually exclusive with creds/token/user/pass");
    if (!a.sentinelCreds)
      throw new Error("user-mode bearer requires sentinelCreds");
    return {
      authenticator: [nativeCredsAuthenticator(a.sentinelCreds), tokenAuthenticator(a.bearer)],
      tls,
    };
  }
  // creds (JWT/nkey) are mutually exclusive with token/user/pass — reject rather than
  // silently pick one, so a misconfigured caller fails loud.
  if (a.creds) {
    if (a.token || a.user || a.pass)
      throw new Error("creds are mutually exclusive with token/user/pass auth");
    const creds = a.creds;
    // A getter re-wraps per (re)connect attempt so each attempt signs with the freshest cred;
    // nats.js invokes the authenticator function on every attempt, including internal reconnects.
    const authenticator = (nonce?: string) => {
      const presented = typeof creds === "function" ? creds() : creds;
      const authenticated = nativeCredsAuthenticator(presented)(nonce);
      a.onCreds?.(presented);
      return authenticated;
    };
    return { authenticator, tls };
  }
  return { token: a.token, user: a.user, pass: a.pass, tls };
}

/** The bearer's `exp` as epoch ms — what the refresh schedule keys on. A bearer without a numeric
 *  `exp` is structurally unusable for a refreshing endpoint (fail-loud, like the principal decode). */
export function bearerExpiryMs(bearer: string): number {
  return bearerLifetimeMs(bearer, 0).expiresAtMs;
}

/** The bearer's lifetime as epoch ms: `iat` to `exp`, starting at `adoptedAtMs` when it carries no
 *  `iat`. */
export function bearerLifetimeMs(bearer: string, adoptedAtMs: number): { issuedAtMs: number; expiresAtMs: number } {
  const payload = bearer.split(".")[1];
  if (!payload) throw new Error("user-mode bearer is not a JWT (no payload segment)");
  let claims: { exp?: unknown; iat?: unknown };
  try {
    claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    throw new Error("user-mode bearer payload is not valid base64url JSON");
  }
  if (typeof claims.exp !== "number") throw new Error("user-mode bearer is missing a numeric exp claim");
  const expiresAtMs = claims.exp * 1000;
  return { issuedAtMs: Math.min(typeof claims.iat === "number" ? claims.iat * 1000 : adoptedAtMs, expiresAtMs), expiresAtMs };
}

/** Past this point a held bearer is overdue: its renewal should already have replaced it. */
export function bearerRenewalDeadlineMs(bearer: string, adoptedAtMs: number): number {
  const { issuedAtMs, expiresAtMs } = bearerLifetimeMs(bearer, adoptedAtMs);
  return renewalDeadlineMs(issuedAtMs, expiresAtMs);
}

/** A refusal already surfaced once for this outage. The rebuild loop retries it without a notice,
 *  so an endpoint that cannot renew shows one status line rather than one per attempt. */
export class RepeatedRefusal extends Error {}

/** Decode the owner+actor PRINCIPAL from a user bearer WITHOUT verifying it — the client trusts its own
 *  bearer only to build its subjects; the broker's minted grant (from the callout, which DOES verify the
 *  bearer) is the real boundary, so a client that lied to itself would just be denied. Per the token
 *  claim semantics the OWNER is the JWT `sub` (`act.owner` merely restates it) and the ACTOR is
 *  `act.actor`. Throws on a structurally-unusable bearer (fail-loud). */
export function decodeBearerPrincipal(bearer: string): { owner: string; actor: string } {
  const payload = bearer.split(".")[1];
  if (!payload) throw new Error("user-mode bearer is not a JWT (no payload segment)");
  let claims: { sub?: unknown; act?: { actor?: unknown } };
  try {
    claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    throw new Error("user-mode bearer payload is not valid base64url JSON");
  }
  const owner = claims.sub, actor = claims.act?.actor;
  if (typeof owner !== "string" || typeof actor !== "string")
    throw new Error("user-mode bearer is missing a string sub (owner) / act.actor claim");
  return { owner, actor };
}

/** Turn a raw async-status error into one whose message says *why* — a permission
 *  violation looks like absence unless it's named as a denial. */
export function describeStatusError(err: Error): Error {
  if (err instanceof PermissionViolationError) {
    return new Error(
      `NATS permission denied: cannot ${err.operation} "${err.subject}" - check this ` +
        `endpoint's ACLs (a denied peer looks "absent" rather than blocked)`,
      { cause: err },
    );
  }
  return err;
}

/** The ordered consumer behind a KV watch, which nats.js keeps on the iterator and the KV types hide. */
export function kvWatchConsumer(iter: Awaited<ReturnType<KV["watch"]>>): PushConsumer {
  const consumer = (iter as { _data?: PushConsumer })._data;
  if (!consumer) throw new Error("KV watch carries no consumer - the pinned nats.js changed shape");
  return consumer;
}

/** True ONLY for a denial on a **publish** — the single case that proves the message was never
 *  ACCEPTED or stored. (Not "never reached the server": the server necessarily received enough of
 *  it to reject it. The distinction matters precisely here, because this helper exists to separate
 *  provably-not-stored from possibly-stored, and the looser phrasing overstates the very thing
 *  being measured.) {@link isPermissionDenied} deliberately does not look at the operation: it exists to
 *  separate "denied" from "service down", and that answer is the same either way. The operation
 *  matters enormously to a caller that reports *delivery*, because a JetStream publish is
 *  request/PubAck and the subscription half is the reply inbox — a denial THERE rejects
 *  `js.publish()` while the stream may already hold the message. Verified against a live broker: a
 *  user allowed to publish but denied its `_INBOX` subscription got
 *  `Permissions Violation for Subscription to "_INBOX.….*"` back from `js.publish()`, and an
 *  unrestricted observer then read `messages: 1` off the stream.
 *
 *  Note what is deliberately NOT accepted: the untyped text fallback above. A permission-shaped
 *  message string carries no operation, so it cannot prove non-delivery, and guessing "publish"
 *  from wording would reintroduce exactly the false certainty this exists to prevent. Anything not
 *  provably a publish denial is unknown, and a caller reporting delivery must fail toward
 *  "I could not confirm" rather than toward "it did not happen" — the costly mistake is telling
 *  someone to re-send a message that was in fact stored. */
export function isPublishPermissionDenied(e: unknown): boolean {
  const typed =
    e instanceof PermissionViolationError
      ? e
      : (e as { cause?: unknown } | null)?.cause instanceof PermissionViolationError
        ? ((e as { cause: PermissionViolationError }).cause)
        : undefined;
  return typed?.operation === "publish";
}

/** Whether a server list dials over websocket: the FIRST entry's scheme decides (one list, one
 *  transport — a mixed tcp+ws list would race two transports over one identity). */
export function wsServers(servers: string): boolean {
  return /^wss?:\/\//i.test((servers.split(",")[0] ?? "").trim());
}

/** Default probe budget by TRANSPORT. 1s was tuned for the loopback/LAN TCP brokers every local
 *  probe dials; a ws(s) broker is by definition published through an HTTPS edge (CDN tunnel,
 *  reverse proxy), where TLS + upgrade + INFO + the auth round-trip routinely exceeds 1s cold —
 *  measured ~60% spurious "not reachable" against a Cloudflare-fronted broker. Callers passing an
 *  explicit `timeoutMs` are untouched.
 *
 *  EXPORTED because a caller that judges a probe by WHEN it answered has to compare against the
 *  deadline this function actually handed the probe. The delivery watchdog does exactly that, and
 *  hardcoding 1000 there silently misread every ws broker: honest refusals arrive at 2-5s, past a
 *  budget that was never theirs, and would be classified as this process's starvation rather than
 *  the server's refusal. The budget and the judgment must come from one place. */
export function defaultProbeTimeoutMs(servers: string): number {
  return wsServers(servers) ? 5000 : 1000;
}

/** Pick the dial function by SCHEME: `ws://`/`wss://` servers go through nats-core's
 *  `wsconnect` (the websocket transport - e.g. a broker published through an HTTPS edge at
 *  `wss://host/path`), everything else through the TCP transport. The websocket dial OWNS its
 *  transport options: a required TLS connection refuses any `ws://` target before dialing.
 *  `wss://` performs TLS itself, and the w3c transport refuses a `tls` block outright
 *  ("'tls' is not configurable"), so the block is removed after that check.
 *  A TCP dial that requires TLS to one IP address names that address as the host its certificate
 *  must cover (see {@link withDialedTlsHost}). */
export function dialerFor(servers: string): typeof connect {
  if (!wsServers(servers)) return ((opts?: Parameters<typeof connect>[0]) => connect(withDialedTlsHost(servers, opts))) as typeof connect;
  return ((opts: Parameters<typeof connect>[0]) => {
    const { tls, ...rest } = (opts ?? {}) as Record<string, unknown>;
    const targets = Array.isArray(rest.servers) ? rest.servers : String(rest.servers ?? servers).split(",");
    if (tls && targets.some((target) => !/^wss:\/\//i.test(String(target).trim())))
      return Promise.reject(new Error("TLS-required WebSocket connections must use wss:// for every server"));
    return (wsconnect as unknown as typeof connect)(rest as Parameters<typeof connect>[0]);
  }) as typeof connect;
}

/** `opts` for a dial to `servers`, with the IP address it names as the host a TLS certificate must
 *  cover when the dial requires TLS: a `tls` block, or a `tls://` address. The TCP transport upgrades
 *  to TLS with no server name for an IP, and Node then checks the certificate against "localhost":
 *  a certificate for the dialed address alone is refused, and one naming localhost passes for any
 *  address. A dial that does not require TLS keeps its options, because a `tls` block refuses a
 *  plaintext broker, and so does a list of several servers, whose one host the options cannot name. */
function withDialedTlsHost(servers: string, opts: Parameters<typeof connect>[0]): Parameters<typeof connect>[0] {
  const urls = servers.split(",").map((url) => url.trim()).filter(Boolean);
  const tls = opts?.tls;
  if (urls.length !== 1 || tls === null || tls === undefined && !/^tls:\/\//i.test(urls[0]!)) return opts;
  let host: string;
  try { ({ host } = hostPort(urls[0]!)); } catch { return opts; }
  // Node checks an upgraded socket's certificate against `host` when no server name is set.
  return isIP(host) ? { ...opts, tls: { host, ...tls } as NonNullable<typeof tls> } : opts;
}

/** Parse a NATS server URL (`nats://host:port`, `host:port`, a bare host, or a comma list — the
 *  first entry wins) into a host+port for {@link tcpInfoProbe}. Defaults the port to 4222. */
function hostPort(server: string): { host: string; port: number } {
  const raw = (server.split(",")[0] ?? "").trim();
  const scheme = raw.match(/^([a-z][a-z0-9+.-]*):\/\//i)?.[1]?.toLowerCase();
  const first = raw.replace(/^[a-z][a-z0-9+.-]*:\/\//i, ""); // strip scheme
  const u = new URL(`http://${first}`); // http:// so .hostname/.port resolve (incl. bracketed IPv6)
  // A websocket broker rides the web's ports, not NATS's: `wss://host/path` reaches TCP 443.
  const fallback = scheme === "wss" ? 443 : scheme === "ws" ? 80 : 4222;
  return { host: u.hostname, port: u.port ? Number(u.port) : fallback };
}

/** Silent credless liveness probe. Opens a plain TCP connection and confirms a NATS server is there
 *  by reading its UNPROMPTED `INFO {…}` greeting — which the server sends on accept, BEFORE the
 *  client's CONNECT/auth (per the NATS client protocol) — then closes immediately without
 *  authenticating. Since it never sends CONNECT, an auth broker has nothing to reject, so this emits
 *  NO broker-side auth-error/auth-timeout log line (unlike a credless `connect()`, which an auth
 *  broker rejects and logs). It is a *plaintext NATS* liveness check only:
 *    • a TLS-first (`handshake_first`, NATS ≥ 2.10.4) listener sends its TLS handshake before INFO,
 *      so the read won't match → returns false (a documented false-negative for that broker config);
 *    • a non-NATS listener never sends a valid `INFO {` → also false, and a silent one resolves
 *      `"silent"` (we require the real greeting, never "any open port is reachable").
 *  Closes well within the server's ~1s authorization timeout, so it cannot trip a timeout log.
 *  A live server resolves to what its greeting said about auth. A peer that accepted the connection
 *  and sent no full line before the deadline, as a stopped or overloaded broker does, resolves
 *  `"silent"`; anything else resolves `false`. */
function tcpInfoProbe(server: string, timeoutMs: number): Promise<false | "silent" | { authRequired: boolean }> {
  return new Promise<false | "silent" | { authRequired: boolean }>((resolve) => {
    let socket: ReturnType<typeof createConnection> | undefined;
    let done = false;
    let connected = false;
    const finish = (live: false | "silent" | { authRequired: boolean }) => {
      if (done) return;
      done = true;
      try { socket?.destroy(); } catch { /* already gone */ }
      resolve(live);
    };
    let host: string, port: number;
    try { ({ host, port } = hostPort(server)); } catch { return resolve(false); }
    socket = createConnection({ host, port });
    socket.setTimeout(timeoutMs);
    let buf = "";
    socket.on("data", (chunk: Buffer) => {
      buf += chunk.toString("utf8");
      const nl = buf.indexOf("\r\n");
      if (nl === -1) { if (buf.length > 4096) finish(false); return; } // no real INFO line is 4KB+
      const line = buf.slice(0, nl);
      const brace = line.indexOf("{"); // greeting is `INFO {json}` (the server appends a trailing space)
      if (!/^INFO\b/.test(line) || brace === -1) return finish(false); // not NATS (incl. a TLS-first handshake)
      try { finish({ authRequired: (JSON.parse(line.slice(brace)) as { auth_required?: unknown })?.auth_required === true }); } // require a real INFO greeting, not arbitrary bytes
      catch { finish(false); }
    });
    socket.on("connect", () => { connected = true; });
    socket.on("timeout", () => finish(connected ? "silent" : false));
    socket.on("error", () => finish(false)); // refused / reset / DNS failure
    socket.on("close", () => finish(false)); // closed before a full INFO line arrived
  });
}

/** Bounded TCP reachability on a socket we OWN: does a handshake to `server` complete within
 *  `timeoutMs`? Deliberately narrower than {@link tcpInfoProbe} — it asks only whether the
 *  transport can be reached, never whether NATS is speaking there, so the TLS-first listener that
 *  `tcpInfoProbe` reports false for still passes this gate and goes on to a real connect.
 *
 *  It exists because `connect()` cannot be trusted to release a connection it never established.
 *  `@nats-io/transport-node`'s `NodeTransport.dial()` keeps its socket in a local until the
 *  handshake resolves (`this.socket = await this.dial(hp)`), so `this.socket` is STILL UNDEFINED
 *  when the client's own connect timeout wins the race in `protocol.ts`'s `dial` and the catch
 *  calls `transport.close()` — whose teardown is `this.socket?.destroy()`, i.e. a destroy of
 *  nothing. Against an address that BLACKHOLES (SYN unanswered) rather than REFUSES (RST), the
 *  socket is orphaned in libuv until the OS SYN timeout, and the process cannot exit for minutes
 *  after the probe already returned its answer. That is issue #389, and it is upstream: nothing a
 *  caller passes (`reconnect: false`, `timeout`) reaches the orphan. Our socket, our `destroy()`,
 *  on every exit path — never an `unref`/force-exit, which would hide the symptom and a future
 *  real hang with it. A second orphan case (#2156) needs a greeting, not just a handshake, so it is
 *  gated by {@link tcpInfoProbe} instead wherever the dial will be plaintext. */
function tcpDialable(server: string, timeoutMs: number): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    let socket: ReturnType<typeof createConnection> | undefined;
    let done = false;
    const finish = (dialable: boolean) => {
      if (done) return;
      done = true;
      try { socket?.destroy(); } catch { /* already gone */ }
      resolve(dialable);
    };
    let host: string, port: number;
    try { ({ host, port } = hostPort(server)); } catch { return resolve(false); }
    socket = createConnection({ host, port });
    socket.setTimeout(timeoutMs);
    socket.on("connect", () => finish(true));
    socket.on("timeout", () => finish(false)); // blackhole: SYN unanswered inside our deadline
    socket.on("error", () => finish(false)); // refused / reset / DNS failure
    socket.on("close", () => finish(false));
  });
}

/** Whether a failed connect was the server refusing these credentials: a server answered, so it is
 *  up. The same errors {@link isReachable} reads as up after its own authenticated connect. */
export function isAuthRejection(e: unknown): boolean {
  return e instanceof AuthorizationError || e instanceof UserAuthenticationExpiredError;
}

/** The wait a credential source asked for with a numeric `retryAfterSeconds` on its error, in
 *  milliseconds, or 0. */
export function retryAfterMs(e: unknown): number {
  const seconds = (e as { retryAfterSeconds?: unknown } | undefined)?.retryAfterSeconds;
  return typeof seconds === "number" && Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : 0;
}

/** Whether a NATS server is *running* at `servers`. With NO creds this is a SILENT plaintext
 *  liveness check ({@link tcpInfoProbe}): it reads the server's pre-auth `INFO` greeting and closes
 *  WITHOUT authenticating, so a live broker (open OR auth — INFO precedes auth) returns true while
 *  emitting no broker auth-error log. It may return false for a TLS-first listener — the credless
 *  probe is plaintext-only. With creds/token/tls supplied it is instead the AUTHORITATIVE identity
 *  check: a real authenticated connect, true on success AND on an auth rejection (a server that
 *  refuses these creds is still up — so the caller surfaces the real auth failure, and `up` won't
 *  start a duplicate on the bound port). Only a genuine connection failure (refused/timeout) is false. */
export async function isReachable(
  servers: string = DEFAULT_SERVER,
  opts: AuthOpts & { timeoutMs?: number } = {},
): Promise<boolean> {
  const timeoutMs = opts.timeoutMs ?? defaultProbeTimeoutMs(servers);
  if (!opts.creds && !opts.token && !opts.user && !opts.pass && !opts.tls) {
    // A websocket broker rides an HTTPS edge: the plaintext INFO probe reads TLS bytes and
    // declares a perfectly live broker down (which then blocks spawn/connect with a wrong
    // remedy). Dial the ws transport credless instead — an auth broker REJECTING the bare
    // connect still proves it is there, the same reading the authed branch below gives its
    // catch. Costs one broker-side auth-error log line per probe, which the INFO probe was
    // designed to avoid; on a ws broker there is no silent alternative.
    if (wsServers(servers)) {
      try {
        const nc = await dialerFor(servers)({ servers, timeout: timeoutMs, reconnect: false, maxReconnectAttempts: 0 });
        await nc.close();
        return true;
      } catch (e) {
        return e instanceof AuthorizationError || e instanceof UserAuthenticationExpiredError;
      }
    }
    return typeof (await tcpInfoProbe(servers, timeoutMs)) === "object";
  }
  // The credless branch above already owns its socket. This one reaches `connect()`, so it carries
  // the same orphaned-socket defects probeConnect did (#389, and the slow-greeting case #2156) and
  // takes the same gate choice: reach the address on a socket we own first, requiring the NATS
  // greeting for a plaintext dial (the upstream transport orphans a socket whose handshake
  // completed but whose greeting came late) and only the handshake for a TLS-required or websocket
  // dial (no plaintext greeting to read), then give `connect()` the remainder of the budget its own
  // timeout always covered. A gate failure is a genuine connection failure, which is exactly the
  // `false` the catch below already returns for one — an auth rejection cannot reach us from an
  // address that never completed a handshake.
  const started = Date.now();
  const gate = opts.tls || wsServers(servers) ? tcpDialable : tcpInfoProbe;
  const reached = await gate(servers, timeoutMs);
  if (!reached || reached === "silent") return false;
  try {
    const nc = await dialerFor(servers)({
      servers,
      timeout: Math.max(1, timeoutMs - (Date.now() - started)),
      reconnect: false,
      maxReconnectAttempts: 0,
      ...authOpts(opts),
    });
    await nc.close();
    return true;
  } catch (e) {
    return e instanceof AuthorizationError || e instanceof UserAuthenticationExpiredError;
  }
}

/** What a connect attempt told us about the server — the distinction {@link isReachable} flattens.
 *  `auth-required` means a server answered but rejected these creds (so it IS up); `stale-auth`
 *  means the PRESENTED CREDENTIAL ITSELF is dead — expired by its bounded lifetime, either because
 *  the broker said "authentication expired" or because the cred is LOCALLY PROVABLY expired (its own
 *  JWT `exp` is past). The local check is decided without a round-trip, so a slow or failed connect
 *  never downgrades a dead cred to `unreachable`; the repair is `doctor auth` either way, never a
 *  registry prune (the D5 credential-death event). `unreachable` means nothing usable answered and
 *  the cred is not provably dead (refused / timeout / a stale registry entry). `timeout` means the
 *  dial ran out of its own budget before anything conclusive came back — never a trust or credential
 *  verdict, just "try again with more time" (#851). `inferred` marks an `auth-required` read from
 *  the broker's greeting rather than from a rejection: the greeting asked for auth and the handshake
 *  was then reset. The greeting is unauthenticated, so that verdict may name a failure but must never
 *  be grounds for deleting state. */
export type ProbeResult =
  | { ok: true }
  | { ok: false; reason: "auth-required"; inferred?: true }
  | { ok: false; reason: "stale-auth" }
  | { ok: false; reason: "unreachable" }
  | { ok: false; reason: "tls-unsupported" }
  | { ok: false; reason: "timeout" };

/** Like {@link isReachable}, but distinguishes "up but won't take these creds" from "nothing there".
 *  `spawn` needs the difference: auth-required → name the trust dir + next step; unreachable → the
 *  mesh is down (prune the stale entry, tell the user to `cotal up`). Pass `creds` to confirm a
 *  specific identity is accepted (`ok`); omit them to probe mere liveness (an auth broker answers
 *  `auth-required`, which still proves it's up). */
export async function probeConnect(
  server: string = DEFAULT_SERVER,
  opts: AuthOpts & { timeoutMs?: number } = {},
): Promise<ProbeResult> {
  const timeoutMs = opts.timeoutMs ?? defaultProbeTimeoutMs(server);
  const started = Date.now();
  // Reach the address on a socket we own BEFORE handing it to `connect()`, which orphans the
  // connection it never established (see {@link tcpDialable} for the upstream mechanism, #389,
  // and {@link tcpInfoProbe} for the second orphan case below, #2156). For a plaintext dial the
  // gate must see the server's NATS greeting, not just the handshake: `connect()`'s own timeout
  // can fire while it is still waiting on that greeting, and the upstream transport only destroys
  // a socket whose handshake never completed, not one whose greeting came late (`_closed`'s guard
  // on `connected`, which is set only after the greeting is read) — so `tcpInfoProbe` (which owns
  // its socket and requires the greeting) is the gate there, while a TLS-required or websocket
  // dial has no plaintext greeting to read and keeps the handshake-only `tcpDialable` gate. This
  // cannot change any verdict: every address that gets past here had to complete a TCP handshake
  // for `connect()` to have gotten anywhere either, and a gate failure is routed through the SAME
  // classification the catch uses — so a locally-dead cred is still `stale-auth` and not silently
  // downgraded to `unreachable` by the address being dark. The cost is one extra handshake (and,
  // off TLS/ws, one extra greeting read) on the reachable path; the deadline below is the
  // REMAINDER of the budget, because `connect()`'s own `timeout` always covered its handshake too.
  const gate = opts.tls || wsServers(server) ? tcpDialable : tcpInfoProbe;
  const greeting = await gate(server, timeoutMs);
  if (!greeting) return classifyProbeFailure(undefined, opts);
  // A peer that took the connection and never greeted is there but not answering, as a stopped or
  // overloaded broker is. That is the same latency verdict as a dial that ran out of its budget.
  if (greeting === "silent") return classifyProbeFailure(undefined, opts, false, "timeout");
  try {
    const nc = await dialerFor(server)({
      servers: server,
      timeout: Math.max(1, timeoutMs - (Date.now() - started)),
      reconnect: false,
      maxReconnectAttempts: 0,
      ...authOpts(opts),
    });
    await nc.close();
    return { ok: true };
  } catch (e) {
    return classifyProbeFailure(e, opts, greeting !== true && greeting.authRequired);
  }
}

/** Why a {@link probeConnect} attempt did not end in `ok`. Shared by the pre-connect reachability
 *  gate and the connect catch so both classify identically — the gate must never turn a diagnosable
 *  credential death into a bare `unreachable` just because the address went dark.
 *
 *  A presented cred that is PROVABLY expired by its own JWT is stale-auth (credential death) — and
 *  that is knowable LOCALLY, without the network, so it is decided FIRST, before the error type. On
 *  the wire the broker's rejection and the socket close race: a slow CI/Windows handshake can
 *  surface a bare transport failure (→ "unreachable") instead of a clean AuthorizationError, which
 *  used to misclassify a dead cred. Reading the cred removes that timing dependency entirely, so the
 *  classification is deterministic. Unreadable content falls through to the wire truth (no false
 *  stale diagnosis from garbage). `e` is undefined when the gate refused before any connect.
 *  `authRequired` is true when the gate read a greeting that asked for auth. `otherwise` is the
 *  verdict when nothing more specific applies. */
function classifyProbeFailure(e: unknown, opts: AuthOpts, authRequired = false, otherwise: "unreachable" | "timeout" = "unreachable"): ProbeResult {
  if (typeof opts.creds === "string") {
    try {
      if (inspectCredHealth(opts.creds).state === "expired") return { ok: false, reason: "stale-auth" };
    } catch { /* not introspectable — keep the wire truth */ }
  }
  if (e instanceof UserAuthenticationExpiredError) return { ok: false, reason: "stale-auth" };
  // The broker answered but rejected these creds (so it IS up) — auth-required, not stale-auth.
  if (e instanceof AuthorizationError) return { ok: false, reason: "auth-required" };
  // A dial that ran out of its own budget is neither a refusal nor a dead broker — it is latency,
  // and grading it `unreachable` made a TLS-required target read as a trust failure (#851). Only
  // nats-core's TimeoutError means that: a peer's `-ERR` that mentions a timeout answered at once.
  if (e instanceof TimeoutError) return { ok: false, reason: "timeout" };
  // The native client read a greeting without TLS support and refused the TLS requirement.
  // That is a transport mismatch, not an unreachable listener or proof of mesh identity.
  if (e instanceof ConnectionError && e.message === "server does not support 'tls'")
    return { ok: false, reason: "tls-unsupported" };
  // A broker that greeted us asking for auth and then reset the handshake most likely refused it.
  // Windows can discard its `-ERR 'Authorization Violation'` when the reset lands, so the client
  // sees only ECONNRESET, and a running auth broker used to read as gone. No rejection was read, so
  // the verdict is marked inferred.
  if (authRequired && (e as { code?: unknown } | undefined)?.code === "ECONNRESET") return { ok: false, reason: "auth-required", inferred: true };
  return { ok: false, reason: otherwise };
}
