import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { closeSync, fstatSync, openSync, readFileSync, readSync, rmSync, statSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { basename, dirname, join } from "node:path";
import {
  CotalEndpoint,
  type PresenceView,
  spacePrefix,
  credsClaims,
  mintCreds,
  mintLifecycleUid,
  newIdentity,
  clearChannel,
  hardenPrivate,
  openPrivateAppend,
  writePrivateRecord,
  type CotalMessage,
  type MembershipChange,
  type MembershipSnapshot,
  type ParsedArgs,
} from "@cotal-ai/core";
import {
  c,
  connectOrExit,
  inputDisabledByFlag,
  localProcessPath,
  parsePid,
  probeLiveness,
  probeWebReadiness,
  webBoundUrl as boundUrl,
  readPidfile,
  readWebSession,
  removePidPair,
  userViewAuth,
  userViewAuthOrExit,
  WEB_PIDFILE,
  WEB_READINESS_HEADER,
  WEB_READINESS_PATH,
  WEB_SESSION_FILE,
  writeIdentityPin,
  type ConnectFlags,
  type Connection,
  type LocalProcess,
  type UserViewAuth,
  type WebMeta,
  type WebSession,
} from "@cotal-ai/workspace";
import {
  BadRequest,
  PayloadTooLarge,
  BodyDeadlineExceeded,
  BrokerRefused,
  MAX_BODY_BYTES,
  DELETE_BODY_DEADLINE_MS,
  BODY_ROUTES,
  quoteForOperator,
  channelNameFromPath,
  canonicalChannel,
  historyLimit,
  agentIdFromPath,
  classifyTap,
} from "./web-request.js";
export {
  BadRequest,
  BrokerRefused,
  quoteForOperator,
  MAX_HISTORY_LIMIT,
  agentIdFromPath,
  classifyTap,
} from "./web-request.js";
import {
  MEMBERSHIP_READ_FAILED,
  clientAssets,
  clientResponse,
  chatOnly,
  AGGREGATION_DEADLINE_MS,
  LATE,
  deadline,
  within,
  type FeedWrite,
  writeFeed,
  writeOpening,
  SessionWatchers,
  AgentEventsLate,
  agentEventsPage,
  eventsGrantFor,
  activityBackfill,
} from "./web-read.js";
export {
  MEMBERSHIP_READ_FAILED,
  CLIENT_NOT_BUILT,
  THEME_BOOT,
  clientAssets,
  clientResponse,
  type ActivitySource,
  chatOnly,
  AGGREGATION_DEADLINE_MS,
  AGGREGATION_CONCURRENCY,
  type FeedWrite,
  writeFeed,
  writeOpening,
  SessionWatchers,
  AgentEventsLate,
  agentEventsPage,
  eventsGrantFor,
  type ActivityPage,
  activityBackfill,
} from "./web-read.js";
import {
  type PostCapability,
  POST_OFF_SERVICE,
  postCapability,
  mintOperatorCred,
  type OperatorPoster,
  sendAsOperator,
  operatorPoster,
} from "./web-post.js";
export {
  POST_OFF_CREDS,
  POST_OFF_USER,
  OPERATOR_TTL_SECONDS,
  postCapability,
  mintOperatorCred,
  type OperatorPoster,
  POSTER_STOPPED,
  POST_OFF_EXPIRED,
  type SendAnswer,
  sendAsOperator,
  operatorPoster,
} from "./web-post.js";

const here = dirname(fileURLToPath(import.meta.url));

/** The dashboard's default port and its branded address. The server binds loopback
 *  (127.0.0.1) but serves any Host, so `cotal.localhost` — which Chrome/Firefox/Edge
 *  resolve to loopback with no DNS setup — just works. (Safari may not resolve
 *  `*.localhost`; plain http://127.0.0.1:7799 always does.) */
export const WEB_PORT = 7799;
export const WEB_HOST = "127.0.0.1";
export const WEB_URL = `http://cotal.localhost:${WEB_PORT}/`;
const WILDCARD_HOSTS = new Set(["0.0.0.0", "::"]);
const IPV4_MAPPED_WILDCARD = "::ffff:0:0";
/** The three reasons this surface refuses a request. Each names a different condition so a caller
 *  learns which one failed, and the refusal body and the smokes share these constants because a
 *  restated literal drifts silently. */
export const UNAUTHENTICATED = "unauthenticated";
export const LAUNCH_TOKEN_ALREADY_USED = "launch-token-already-used";
export const CROSS_ORIGIN = "cross-origin";
/** The cookie the session rides in. NOT `Secure`: this surface is `http://127.0.0.1`, where a Secure
 *  cookie would simply never be sent. `HttpOnly` keeps it out of page script. `SameSite=Lax` keeps it
 *  off another site's POSTs, frames and subresource requests, and sends it on a top-level GET
 *  navigation, so a link from a homepage tile opens the dashboard. Every GET route only reads, and a
 *  request another site's page sends carries an `Origin` the gate refuses. Stated here rather than
 *  discovered in review. */
const SESSION_COOKIE = "cotal_web_session";
/** The request path, without the query. This DUPLICATES the handler's own parse, deliberately: the
 *  statements ahead of the gate are pinned to an exact literal parse, because an initializer there is
 *  code that runs before the gate is consulted. So the gate derives the path itself rather than being
 *  handed one, and the two must be edited together. */
function pathOf(req: IncomingMessage): string {
  return (req.url ?? "/").split("?")[0];
}
/** The class of an error for a managed service log: its name and code when each is a short
 *  identifier. Never its message, which can carry peer-supplied text or a request target. */
export function errorClassForLog(error: unknown): string {
  const token = (value: unknown) => (typeof value === "string" || Number.isSafeInteger(value)) && /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(String(value)) ? String(value) : undefined;
  const parts = error instanceof Error ? [token(error.name), token((error as { code?: unknown }).code)] : [];
  return parts.filter(Boolean).join(" ") || "unclassified";
}
/** Keep request diagnostics useful without copying a contiguous live launch credential into the
 *  operator log, wherever it appears in the target. Match each ASCII token byte in raw or percent-
 *  encoded form so paths, unrelated query fields, mixed encodings, and hex case are covered. */
function requestTargetForLog(req: IncomingMessage, launchToken: string): string {
  const target = req.url ?? "/";
  // A substring search cannot be constant-time; unlike authentication, this does not expose a
  // boolean oracle to the caller. `secretEquals` remains the comparison at the credential boundary.
  const tokenPattern = [...launchToken]
    .map((ch) => `(?:${ch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}|%${ch.charCodeAt(0).toString(16).padStart(2, "0")})`)
    .join("");
  let safeTarget = target.replace(new RegExp(tokenPattern, "gi"), "[redacted]");
  const q = safeTarget.indexOf("?");
  if (q === -1) return safeTarget;
  const query = new URLSearchParams(safeTarget.slice(q + 1));
  const safe = new URLSearchParams();
  for (const [name, value] of query) {
    // `k` remains a belt for invalid, replayed, or otherwise non-live credential-shaped values.
    safe.append(name, name === "k" ? "[redacted]" : value);
  }
  safeTarget = `${safeTarget.slice(0, q)}?${safe.toString()}`;
  return safeTarget;
}
/** Constant-time compare of two secrets that may differ in length. `timingSafeEqual` throws on a
 *  length mismatch, and returning early on that throw would leak the length through timing, so the
 *  length check is folded into the result instead of short-circuiting it. */
function secretEquals(a: string, b: string): boolean {
  const ab = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ab.length !== bb.length) {
    // Compare against itself so the work is done either way, then fail.
    timingSafeEqual(ab, ab);
    return false;
  }
  return timingSafeEqual(ab, bb);
}

/** Parse one cookie out of a `Cookie:` header. Deliberately not a general cookie parser — this
 *  surface reads exactly one name, and a permissive parser is a place for a smuggled second value
 *  to hide. */
function cookieValue(header: string | undefined, name: string): string | undefined {
  for (const part of (header ?? "").split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return undefined;
}

/** The gate. Every request passes through it before any route runs.
 *
 *  WHY THIS EXISTS AT ALL: the default loopback bind keeps out other HOSTS, but it does not
 *  authenticate other PROCESSES on this machine or a page in the operator's own browser issuing
 *  requests to http://127.0.0.1:7799. So no mesh read and no channel delete runs for a caller this
 *  gate has not admitted.
 *
 *  ORDER IS DELIBERATE: origin is checked BEFORE the session. A request another site's page sends
 *  arrives without the cookie anyway (SameSite=Lax), so checking the session first would report every
 *  such request as `unauthenticated` and the operator would never learn that something cross-origin
 *  was talking to their console. The more specific condition wins.
 */
export function makeAuthGate(port: number, host: string = WEB_HOST, launchNonce?: string, publishLaunchUrl?: (url: string) => void) {
  // Single-use, minted per process. 32 bytes: this is the only secret standing between a local
  // process and the mesh view until the cookie exists.
  let launchToken: string | undefined = randomBytes(32).toString("base64url");
  // A SECOND secret, for the callers that must poll `/api/meta` to learn the dashboard is up and is
  // OURS rather than a squatter on the same port: `--detach`'s parent and `cotal status`. It is
  // presented as a header and is NOT exchanged for a session and NOT consumed, because they may poll
  // many times.
  //
  // Two secrets rather than exempting `/api/meta`, and the difference matters: an exempt route is
  // permanently unauthenticated for everyone, and the next person to add a field to it will not know
  // that. A second credential is scoped to the caller that needs it, opens only that one path, and
  // dies with the process.
  const readinessNonce = randomBytes(32).toString("base64url");
  const sessions = new Set<string>();
  // The full ORIGIN, not the host: `https://localhost:7799` and `http://localhost:7799` are
  // different origins to a browser, and comparing only the host would treat them as one.
  // Built through `new URL(...).origin` so the allow-list is in the SAME serialization the incoming
  // header is normalized into. A hand-written `http://localhost:80` never matches, because WHATWG
  // origin serialization drops the default port — so on `--port 80` the console would refuse its own
  // browser. Normalizing both sides is the only way the comparison means what it reads as.
  const allowedOrigins = new Set(
    (host === WEB_HOST
      ? [`http://cotal.localhost:${port}`, `http://127.0.0.1:${port}`, `http://localhost:${port}`]
      : [webUrl(host, port)])
      .map((o) => new URL(o).origin),
  );

  return {
    launchToken: launchToken!,
    readinessNonce,
    /** `undefined` = let the request through. Otherwise the named condition that refused it. */
    check(req: IncomingMessage, query: URLSearchParams): { refuse: string } | { exchange: string } | { launchUrl: string } | undefined {
      if (launchNonce && pathOf(req) === "/api/browser-launch" && req.method === "POST" &&
          typeof req.headers["x-cotal-browser-launch"] === "string" && secretEquals(req.headers["x-cotal-browser-launch"], launchNonce) &&
          req.headers.origin === undefined && req.headers["transfer-encoding"] === undefined && Number(req.headers["content-length"] ?? 0) === 0) {
        const nextToken = randomBytes(32).toString("base64url");
        const launchUrl = `${webUrl(host, port)}?k=${nextToken}`;
        // The new link becomes usable only after the private handoff succeeds.
        publishLaunchUrl?.(launchUrl);
        launchToken = nextToken;
        return { launchUrl };
      }
      const origin = req.headers.origin;
      if (origin !== undefined) {
        // A same-origin fetch from our own page sends no Origin at all for GETs, and sends our own
        // origin for POSTs. Anything else is another site's page talking to this console.
        let normalized: string | undefined;
        try { normalized = new URL(origin).origin; } catch { normalized = undefined; }
        if (normalized === undefined || !allowedOrigins.has(normalized)) return { refuse: CROSS_ORIGIN };
      }

      // Scoped to the one path its callers poll. The nonce is never consumed and lives as long
      // as the process, so accepting it on every path would leave `web.session` holding a standing
      // full-surface credential beside a link this command calls single-use.
      const readiness = req.headers[WEB_READINESS_HEADER];
      if (pathOf(req) === WEB_READINESS_PATH && typeof readiness === "string" && secretEquals(readiness, readinessNonce))
        return undefined;

      const session = cookieValue(req.headers.cookie, SESSION_COOKIE);
      if (session !== undefined && sessions.has(session)) return undefined;

      const presented = query.get("k");
      if (presented !== null) {
        if (launchToken !== undefined && secretEquals(presented, launchToken)) {
          // Single use: burn it before minting the session, so two racing requests cannot both win.
          launchToken = undefined;
          const id = randomBytes(32).toString("base64url");
          sessions.add(id);
          return { exchange: id };
        }
        // The token was spent. Named separately from `unauthenticated` because it tells the operator
        // something specific and actionable: the launch URL was replayed, by them or by something
        // else. A generic refusal here would hide a reused link inside ordinary noise.
        if (launchToken === undefined) return { refuse: LAUNCH_TOKEN_ALREADY_USED };
      }
      return { refuse: UNAUTHENTICATED };
    },
  };
}

const DETACHED_READY_TIMEOUT_MS = 30_000;
const DETACHED_STOP_TIMEOUT_MS = 3_000;
const DETACHED_ROOT_ENV = "COTAL_WEB_DETACHED_ROOT";
const DETACHED_LOG_ENV = "COTAL_WEB_DETACHED_LOG";
export const webProcess: LocalProcess = {
  kind: "local-process",
  name: "web",
  label: "web dashboard",
  order: 40,
  pidFile: WEB_PIDFILE,
  // `web.session` holds the readiness nonce, which is accepted for this process's whole lifetime.
  // The exit handler removes it, but an exit handler does not run on SIGKILL — so without this the
  // credential outlives the process it authenticates.
  artifacts: [WEB_SESSION_FILE],
};

/** Atomically claim this mesh's web pidfile so concurrent custom-port launches cannot overwrite it,
 *  then pin this process's identity beside it. The pin follows the exclusive create because
 *  `writePidPair` publishes by rename, which would replace a concurrent launch's claim. */
function claimPid(path: string): void {
  let created = false;
  try {
    const fd = openSync(path, "wx", 0o600);
    created = true;
    try { writeFileSync(fd, String(process.pid)); } finally { closeSync(fd); }
    writeIdentityPin(path, process.pid);
  } catch (e) {
    if (created) rmSync(path, { force: true });
    if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    const raw = readFileSync(path, "utf8").trim();
    const removal = raw.startsWith("removing:");
    const pid = parsePid(removal ? raw.slice("removing:".length) : raw);
    const liveness = pid === undefined ? undefined : probeLiveness(pid);
    if (liveness === "alive")
      throw new Error(
        removal
          ? `web extension removal is in progress (pid ${pid})`
          : `web dashboard is already running for this mesh (pid ${pid})`,
      );
    // Stale is advice to clean the record, so it is given only for a pid proven gone or an empty
    // husk, which has no process behind it. Anything else may still front a live process.
    if (liveness === "dead" || raw === "")
      throw new Error(
        removal
          ? `web dashboard has a stale extension-removal reservation at ${path} - remove it and retry`
          : `web dashboard has a stale pidfile at ${path} - clean it with \`cotal down web\`, then retry`,
      );
    throw new Error(`web dashboard pidfile at ${path} holds ${JSON.stringify(raw)}, which may still front a running process - stop that process and remove the file, then retry`);
  }
}

function releasePid(path: string): void {
  try {
    removePidPair(path, String(process.pid));
  } catch {
    // Unreadable or locked: leaving a record this process cannot prove is its own is the safe error.
  }
}



/** Connects the dashboard and spends the account seed on its two write creds: the channel-purger
 *  for channel delete, and the operator the dashboard posts as. The dashboard is a loopback HTTP
 *  process and the seed can mint ANY identity or role, so the seed is bound only inside this
 *  function and a request handler in {@link web} that reaches for it fails to compile. A narrowed
 *  copy made inside `web()` would leave the full value in the handlers' scope beside it. Resolves
 *  `undefined` in a parent that hands off to a `--detach` child. The mints come last, after that
 *  hand-off and the pidfile claim, because the purger has no expiry and the operator lives 24 days,
 *  and a process that detaches or is refused must not mint creds it then drops. `--creds` and open
 *  meshes have no seed and purge with the connection's own creds; user mode mints a purger view
 *  per delete instead. Posting is decided here too, and the operator poster built, so the operator
 *  credential stays in this scope with the seed. An open mesh posts with no credential. */
async function connectWithoutSeed(
  raw: readonly string[],
  values: ConnectFlags & { detach?: boolean; "no-open"?: boolean },
  host: string,
  port: number,
): Promise<{
  conn: Omit<Connection, "auth">;
  user: UserViewAuth | undefined;
  pidPath: string | undefined;
  purgeCreds: string | undefined;
  post: PostCapability;
  poster: OperatorPoster | undefined;
} | undefined> {
  const { auth, ...conn } = await connectOrExit(values, "admin");
  const detachedRoot = process.env[DETACHED_ROOT_ENV];
  if (detachedRoot && conn.root !== detachedRoot)
    throw new Error(`detached web target lost its recorded mesh root (${detachedRoot}) before startup`);
  if (values.detach) {
    if (!conn.root)
      throw new Error("`cotal web --detach` requires a recorded mesh root; start or register the mesh with `cotal up` first");
    await launchDetachedWeb(raw, conn.root, conn.space, conn.server, host, port, Boolean(values["no-open"]));
    return undefined;
  }
  const user = conn.bearer ? await userViewAuthOrExit(conn, "admin") : undefined;
  const pidPath = conn.root ? localProcessPath(webProcess.pidFile, { root: conn.root, space: conn.space }) : undefined;
  if (pidPath) {
    claimPid(pidPath);
    process.once("exit", () => releasePid(pidPath));
  }
  const purgeCreds = !user && auth ? await mintCreds(auth, newIdentity(), "channel-purger") : conn.creds;
  const post = postCapability(values.creds, user !== undefined);
  const operator = post.mode === "participant" && auth ? await mintOperatorCred(auth) : undefined;
  // The operator the dashboard posts as. Built here so its credential never enters `web()`'s scope,
  // where the request handlers are, and so its id is fixed for the process. It starts on the first
  // post, so it is not on the roster before then.
  const poster = post.mode === "participant" ? operatorPoster({ space: conn.space, server: conn.server, tls: conn.tls }, operator) : undefined;
  return { conn, user, pidPath, purgeCreds, post, poster };
}

/** Trusted native service embedding. The supplied connection is explicitly scoped by its
 *  credential file; no account signer, cached operator login or purger mint is substituted. */
interface WebServiceLifecycle {
  readonly posting?: { creds: string; expiresAt: number };
  readonly connection: Omit<Connection, "auth">;
  readonly onSession: (session: WebSession) => void | Promise<void>;
  readonly onLaunchUrl?: (url: string) => void;
  readonly onReady: () => void | Promise<void>;
  readonly onClosed: () => void | Promise<void>;
}

/** A live observability dashboard for a space, served over HTTP + SSE. A read-only
 *  observer endpoint (invisible to peers) feeds the React client in `dist/web` presence, channel
 *  history and a live message stream, with no manager required. Bound to loopback unless the
 *  operator opts in to a different host explicitly. */
export async function web(args: ParsedArgs, lifecycle?: WebServiceLifecycle): Promise<void> {
  const values = args.values as { space?: string; server?: string; host?: string; port?: string; "no-open"?: boolean; detach?: boolean; creds?: string };
  // Validate the exposure coordinates before connecting to the broker or claiming local artifacts.
  // An invalid exposure request must have no dashboard side effects.
  const host = normalizeWebHost(values.host);
  const port = parseWebPort(values.port);
  // Resolve WHICH running mesh + creds (admin god-view: shows DMs + anycast).
  //
  // USER MODE: the god view rides an exchange-gated "admin" VIEW bearer (ledger scope "admin",
  // fresh-checked at every mint and every connect) — standing via a bearer SOURCE so the tap
  // survives the ≤5-minute token life. No pre-minted purge cred: channel delete mints a one-shot
  // "channel-purger" view per action, so each destructive click is a fresh ledger check, and
  // `cotal actor revoke` kills the dashboard live (eviction) while a scope edit bites at the next
  // refresh.
  const started = lifecycle
    ? { conn: lifecycle.connection, user: undefined, pidPath: undefined, purgeCreds: undefined, post: (lifecycle.posting ? { mode: "participant" } : { mode: "off", reason: POST_OFF_SERVICE }) as PostCapability, poster: lifecycle.posting ? operatorPoster(lifecycle.connection, { ...lifecycle.posting, lifecycleUid: mintLifecycleUid() }) : undefined }
    : await connectWithoutSeed(args.raw, values, host, port);
  if (!started) return;
  const { conn, user, pidPath, purgeCreds, post, poster } = started;
  const { server, space } = conn;
  const sessionPath = !lifecycle && conn.root ? localProcessPath(WEB_SESSION_FILE, { root: conn.root, space }) : undefined;

  // Observer: never registers presence, never consumes an inbox — invisible to peers.
  const ep = new CotalEndpoint({
    space,
    servers: server,
    // The resolved transport, because the endpoint requires TLS only when told to. Against a TLS
    // broker it would still connect without this, upgrading once it reads `tls_required`, but that
    // INFO is unauthenticated plaintext: an on-path attacker strips `tls_required` and a client
    // with no requirement of its own carries on in the clear, with its credentials in the CONNECT
    // line. The client's own `tls` is the fence.
    tls: conn.tls,
    ...(user
      ? { bearer: user.source, sentinelCreds: user.sentinelCreds, card: { owner: user.owner, actor: user.actor, name: "web", kind: "endpoint" as const } }
      : { creds: conn.creds, card: { name: "web", kind: "endpoint" as const } }),
    channels: [],
    consume: false, // observer: reads via tap + history + presence-watch, binds no durables
    registerPresence: false,
    watchPresence: true,
  });
  const reportEndpoint = (e: Error) => console.error(c.red(lifecycle ? `! native dashboard endpoint reported an error (${errorClassForLog(e)}); diagnostic body omitted` : "! " + e.message));
  ep.on("error", reportEndpoint);
  ep.on("warning", (e: Error) => console.error(c.yellow(lifecycle ? `! native dashboard endpoint reported a warning (${errorClassForLog(e)}); diagnostic body omitted` : "! " + e.message)));
  await ep.start();

  // The dashboard does not yet have a manager/session-store observer. Carry the absence as data so
  // the client can say so honestly without deriving progress from the heartbeat.
  const rosterSnapshot = () => ep.getRoster().map((presence) => ({
    ...presence,
    progress: presence.status === "working" ? { kind: "unknown" as const } : undefined,
  }));

  const clients = new Set<ServerResponse>();
  const send = (res: ServerResponse, event: string, data: unknown, kind?: FeedWrite) =>
    writeFeed(res, event, data, kind);
  const broadcast = (event: string, data: unknown) => {
    for (const res of clients) if (!res.writableEnded) send(res, event, data);
  };
  // Each open feed by the id its `hello` named, so a watch request can say which feed it is for.
  // A feed leaves this map, and every watch it held, when its connection closes.
  const feeds = new Map<string, ServerResponse>();
  const watchers = new SessionWatchers<ServerResponse>();
  const grantFor = eventsGrantFor(user ? "user" : conn.creds ? "static" : "open");

  // Presence changes → push the whole roster; the client just re-renders it.
  // Trailing-edge debounce: a stall-recovery replay is one burst of N keys, and pushing
  // per key would empty-to-fill the online-only sidebar once per key. Settle first.
  const pushRoster = debounce(() => broadcast("roster", rosterSnapshot()), 150);
  ep.on("presence", () => pushRoster());
  ep.on("presence-view", (view: PresenceView) =>
    broadcast("presence-view", view),
  );

  // Broker-sourced channel membership (the authoritative graph spokes): push a `membership` SSE event
  // on every feed change (debounced; the client re-reads the snapshot). Best-effort — a space without the
  // feed (no delivery daemon, or provisioned before this feature) simply never emits, and the graph
  // degrades to traffic-only. The admin cred carries the read grant; agents never do.
  let membershipWatch: { stop(): Promise<void> } | undefined;
  let lastMembership: MembershipSnapshot | undefined;
  const pushMembership = debounce(() => {
    // A rejected membership read clears `lastMembership` and broadcasts `MEMBERSHIP_READ_FAILED`;
    // swallowing it would leave the graph showing its last good snapshot as current.
    void ep.readMembership()
      .then((m) => { lastMembership = m; broadcast("membership", m); })
      .catch((e) => { lastMembership = undefined; broadcast(MEMBERSHIP_READ_FAILED, { reason: (e as Error).message }); });
  }, 150);
  // The daemon rewrites the heartbeat key every poll with nothing else changed; re-reading the whole
  // bucket for it was a full ordered-consumer rescan per heartbeat per dashboard (#4904). The watch
  // delivers the heartbeat's `asOf`, so only a member change (or a failed last read) costs a read.
  const onMembership = (change: MembershipChange) => {
    if (change.type === "replayed") return;
    if (change.type === "heartbeat" && change.update && lastMembership) {
      lastMembership = { ...lastMembership, asOf: change.asOf };
      broadcast("membership", lastMembership);
      return;
    }
    pushMembership();
  };
  try {
    membershipWatch = await ep.watchMembership(onMembership, (e) => broadcast(MEMBERSHIP_READ_FAILED, { reason: e.message }));
  } catch (e) {
    console.error(c.dim(`• membership feed unavailable - graph shows traffic only (${(e as Error).message})`));
  }
  // Every comm on the mesh (chat / unicast / anycast) → push to the live feed. The admin cred
  // allows exactly the MESSAGING plane (SPEC 13.9/13.11: chat + inst + svc, enumerated — never
  // the space-wide `>`, which would also plain-subscribe the v0.4 endpoint request rails), so
  // the tap is one subscription per plane.
  //
  // An agent's frames go only to the feeds watching that agent, and to none when nobody watches;
  // they are never broadcast as `message` (see `classifyTap`). Everything else is broadcast.
  const onTap = (subject: string, tapped: unknown) => {
    const verdict = classifyTap(subject, tapped as CotalMessage | undefined);
    if (verdict === null) return;
    if (verdict.event === "agent-frame") {
      for (const res of watchers.targets(verdict.agent)) if (!res.writableEnded) send(res, "agent-frame", verdict.data);
      return;
    }
    const { mode, senderId, channel, msg } = verdict.data;
    broadcast("message", { mode, senderId, channel, msg });
  };
  for (const plane of ["chat", "inst", "svc"])
    ep.tap(onTap, { subject: `${spacePrefix(space)}.${plane}.>` });
  // A supplied observer credential can read only its owner's payload rail.
  const payloadPrefix = `${spacePrefix(space)}.evp.`;
  const payloadSubjects = conn.creds
    ? (credsClaims(conn.creds).nats?.sub?.allow ?? []).filter(subject => subject.startsWith(payloadPrefix))
    : [`${payloadPrefix}>`];
  for (const subject of payloadSubjects) ep.tap(onTap, { subject });

  // The client build sits beside the compiled server in `dist/web`. Run from source, as the smokes
  // run it, the server lives in `src`, so the page is read from the package's `dist/web` instead.
  const client = clientAssets(join(here, basename(here) === "src" ? "../dist/web" : "web"));

  const launchNonce = lifecycle ? randomBytes(32).toString("base64url") : undefined;
  const gate = makeAuthGate(port, host, launchNonce, lifecycle?.onLaunchUrl);

  const handleRequest = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const path = (req.url ?? "/").split("?")[0];
    const query = new URLSearchParams((req.url ?? "").split("?")[1] ?? "");

    const verdict = gate.check(req, query);
    if (verdict !== undefined && "refuse" in verdict) {
      // #2024: a refused request that announced a body is closed rather than drained; the fact is
      // read here, after the gate, so the pre-gate prefix stays a parse and nothing else.
      const announcedBody = Number(req.headers["content-length"]) > 0 || req.headers["transfer-encoding"] !== undefined;
      // A NAMED refusal, never a redirect and never an empty 200. The condition is the body, so a
      // caller that reads only the body still learns which of the three failed.
      res.writeHead(verdict.refuse === CROSS_ORIGIN ? 403 : 401, {
        "content-type": "application/json",
        // A refusal that leaves a caller uploading on a kept-alive connection is drained by Node
        // before the socket comes back, so the pre-auth corner #2024 names is an unbounded read.
        // The close header is the whole remedy; see the catch below for what it does and costs.
        ...(announcedBody ? { connection: "close" } : {}),
      });
      return void res.end(JSON.stringify({ error: verdict.refuse }));
    }
    if (verdict !== undefined && "exchange" in verdict) {
      // Redirect so the spent token leaves the address bar and the browser history. This is the one
      // redirect on this surface and it is a SUCCESS, not a refusal.
      res.writeHead(302, {
        "set-cookie": `${SESSION_COOKIE}=${verdict.exchange}; Path=/; HttpOnly; SameSite=Lax`,
        location: path,
      });
      return void res.end();
    }

    if (verdict !== undefined && "launchUrl" in verdict) {
      res.setHeader("cache-control", "no-store");
      return json(res, verdict);
    }

    // Only the `BODY_ROUTES` read a request body. Refuse an announced body before dispatch
    // everywhere else, so the next no-body route inherits the same bound instead of silently
    // letting Node drain an upload the handler will never inspect.
    const declared = Number(req.headers["content-length"]);
    const announcedBody = declared > 0 || req.headers["transfer-encoding"] !== undefined;
    const noBodyRoute = !BODY_ROUTES.has(path) || req.method !== "POST";
    if (noBodyRoute && announcedBody) throw noBody(path, declared);

    if (path === "/feed") {
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      });
      clients.add(res);
      // The feed's opening state, written as snapshots: a big mesh's roster may be larger than the
      // ceiling on its own, and holding it to the ceiling would end every new feed at once.
      const feed = randomUUID();
      feeds.set(feed, res);
      void writeOpening((event, data, kind) => send(res, event, data, kind), {
        feed,
        roster: rosterSnapshot(),
        presenceView: ep.presenceView(),
        membership: () => ep.readMembership(),
      });
      // Both ends, because either can end a feed: the browser going away closes the request, and
      // an overflow ends the response while the socket may stay open. Forgetting twice is harmless.
      const forget = () => {
        clients.delete(res);
        feeds.delete(feed);
        watchers.drop(res);
      };
      req.on("close", forget);
      res.on("close", forget);
      return;
    }
    if (path === WEB_READINESS_PATH) {
      const operatorId = poster?.operatorId();
      return json(res, { space, pid: process.pid, post, channelDeleteSupported: lifecycle === undefined, ...(operatorId ? { operatorId } : {}) });
    }
    if (path === "/api/roster") return json(res, rosterSnapshot());
    if (path === "/api/membership") {
      // Authoritative who-is-subscribed (broker-sourced); {asOf, members:[{id,live,durable,observedAt}]}.
      //
      // A FAILED READ IS NOT AN EMPTY ONE, so it answers 503 with `MEMBERSHIP_READ_FAILED` and the
      // reason. A 200 carrying `{asOf: undefined, members: []}` would serialise as `{"members":[]}`,
      // byte-identical to a successful read of a space where nobody is subscribed, because
      // `JSON.stringify` DROPS a key whose value is `undefined`. The browser could then not tell
      // "nobody subscribed" from "I could not find out", and the graph would assert the first.
      //
      // The refusal names its own condition and carries a non-200, so a caller that checks neither
      // still cannot mistake it for data.
      try { return json(res, await ep.readMembership()); }
      catch (e) {
        return json(res, { error: MEMBERSHIP_READ_FAILED, reason: (e as Error).message }, 503);
      }
    }
    if (path === "/api/channels") {
      // Resolve defaults at the endpoint so every web client renders the same channel policy the
      // core applies; the registry's `config` holds only per-channel overrides.
      const channels = chatOnly(await ep.listChannels());
      return json(res, channels.map(({ channel, messages, config }) => ({
        channel,
        messages,
        description: config?.description,
        replay: ep.channelReplay(channel),
        replayWindow: ep.channelReplayWindow(channel),
        deliveryClass: ep.channelDeliveryClass(channel),
      })));
    }
    if (path === "/api/activity") {
      // Backfill the all-activity feed: merge recent channel history with DM history (the live
      // SSE tap only carries messages from after a client connects). Entries are mode-tagged
      // ({mode, msg}) to match the live feed so DMs render as DMs.
      //
      // ONE READ FOR ALL OF CHAT. The CHAT stream interleaves every channel into one sequence space,
      // so the globally newest N is the tail of that ONE stream, filtered to the chat channels and
      // merged here. A full page per channel would move (channels + 1) times what the page displays.
      //
      // WHAT SELECTS THE PAGE, precisely. The newest `limit` chat messages in the broker's own
      // arrival order are merged with the newest `limit` DMs, ordered by `ts`, and the newest
      // `limit` of that union is the page. Because the chat half is chosen by arrival, a message
      // that arrived before the newest `limit` cannot enter the page by claiming a newer `ts`: `ts`
      // is a payload claim and the sequence is the broker's own record, so selecting on arrival is
      // the narrower of the two.
      const limit = historyLimit(query, 200);
      const page = await activityBackfill(ep, limit);
      // A partial page is worth SAYING on the server too: the operator watching this log is the one
      // who can tell a slow link from a half of the feed that refused, and the browser's marker
      // never reaches them. What `missing` names is a source, `chat` or `direct messages`, so this
      // line reports which half went unanswered and never an individual channel, each with its reason.
      if (page.partial)
        console.error(c.yellow(`~ ${req.method ?? "GET"} ${path} partial: ${page.read}/${page.of} sources within ${page.deadlineMs}ms, missing ${page.missing.map((m) => `${m} (${page.reasons[m]})`).join(", ")}`));
      return json(res, page);
    }
    if (path === "/api/dms") {
      // DM history for the Direct-messages lens (god-view); the client groups it by peer/pair.
      //
      // BOUNDED LIKE THE AGGREGATION, AND A REFUSAL RATHER THAN A PARTIAL. This is ONE read of one
      // subject, so there is no subset to serve when it runs long: it either produced the page or it
      // produced nothing. Measured across a 160ms link it took 16.59s, which is a 200 nobody is still
      // waiting for. A named 503 at the deadline lets the browser keep the DM list it already has and
      // say it is stale, which is strictly more than a page that arrives after the reader gave up.
      const limit = historyLimit(query, 500);
      const clock = deadline(AGGREGATION_DEADLINE_MS);
      try {
        const dms = await within(
          ep.dmHistory({ limit, signal: clock.signal }).catch((e: unknown) => {
            throw new Error(`direct messages: the read failed: ${e instanceof Error ? e.message : String(e)}`);
          }),
          clock.until,
        );
        if (dms === LATE)
          return json(res, { error: `direct messages: the read did not finish within ${AGGREGATION_DEADLINE_MS}ms` }, 503);
        return json(res, dms);
      } catch (e) {
        return json(res, { error: e instanceof Error ? e.message : String(e) }, 503);
      } finally {
        clock.done();
      }
    }
    if (path.startsWith("/api/channels/") && path.endsWith("/history")) {
      const name = channelNameFromPath(path.slice("/api/channels/".length, -"/history".length));
      const limit = historyLimit(query, 200);
      // BOUNDED LIKE ITS SIBLINGS, and deliberately the SAME bound rather than a new one. This is
      // one read of one channel, so like `/api/dms` it has no subset to serve when it runs long: a
      // named 503 lets the open channel keep the messages it already has and say they are stale,
      // which beats a page that arrives after the reader gave up. Measured on a modelled link
      // before this existed: 11360ms here, on a link where `/api/dms` already refused at 8005ms.
      // The client re-reads this route for the open channel on every poll, so an unbounded read
      // here is one slow channel holding the view open indefinitely.
      const clock = deadline(AGGREGATION_DEADLINE_MS);
      try {
        const page = await within(
          ep.channelHistory(name, { limit, signal: clock.signal }).catch((e: unknown) => {
            throw new Error(`#${name}: the read failed: ${e instanceof Error ? e.message : String(e)}`);
          }),
          clock.until,
        );
        if (page === LATE)
          return json(res, { error: `#${name}: the read did not finish within ${AGGREGATION_DEADLINE_MS}ms` }, 503);
        return json(res, page);
      } catch (e) {
        return json(res, { error: e instanceof Error ? e.message : String(e) }, 503);
      } finally {
        clock.done();
      }
    }
    // One agent's session: watch and unwatch its live frames on one feed, and read its history.
    // `<id>` is the roster id, `<owner>.<actor>`, percent-encoded, so a raw `/` never belongs to it.
    if (path.startsWith("/api/agents/")) {
      const rest = path.slice("/api/agents/".length);
      const cut = rest.lastIndexOf("/");
      const action = cut === -1 ? "" : rest.slice(cut + 1);
      if ((action === "watch" || action === "unwatch") && req.method === "POST") {
        // No body, so these stay out of `BODY_ROUTES`, and they change no mesh state: a watch is a
        // row in this process's map, which the feed's close removes.
        const agent = agentIdFromPath(rest.slice(0, cut));
        const feedId = query.get("feed");
        if (!feedId) throw new BadRequest("feed required: the id the feed's hello event named");
        const feed = feeds.get(feedId);
        if (feed === undefined) throw new BadRequest(`feed ${quoteForOperator(feedId)} is not an open feed`);
        if (action === "watch") watchers.watch(agent.id, feed);
        else watchers.unwatch(agent.id, feed);
        res.writeHead(204).end();
        return;
      }
      if (action === "events") {
        // A read, so GET only. Any other method is named as refused, never answered as a read.
        if (req.method !== "GET") {
          res.writeHead(405, { "content-type": "application/json", allow: "GET" });
          return void res.end(JSON.stringify({ error: "GET only" }));
        }
        const agent = agentIdFromPath(rest.slice(0, cut));
        const limit = historyLimit(query, 200);
        // BOUNDED LIKE ITS SIBLINGS, with their wording: a late read and a failed one are 503s
        // that say which, while a refusal is an answer the session view shows as it came.
        try {
          return json(res, await agentEventsPage(ep, agent, limit, grantFor));
        } catch (e) {
          if (e instanceof AgentEventsLate)
            return json(res, { error: `${agent.id} events: the read did not finish within ${AGGREGATION_DEADLINE_MS}ms` }, 503);
          return json(res, { error: `${agent.id} events: the read failed: ${e instanceof Error ? e.message : String(e)}` }, 503);
        }
      }
    }
    // Delete a channel and its content. A write path, so it's POST-gated. The client reaches it
    // only through the controller's `deleteChannel`; nothing in the phase 1 shell calls that yet, and the operator's confirm
    // arrives with the phase 2 UI. Purges with the
    // channel-purger cred minted at startup (auth mode), the connection creds (open / --creds) or a
    // per-delete channel-purger view (user mode), never the account seed. A wildcard / missing
    // channel is a 400.
    if (path === "/api/channel/delete" && req.method === "POST") {
      if (lifecycle) return json(res, { error: "this service was explicitly configured read-only; no channel-purger authority or alternate transport was acquired", code: "PERMISSION_DENIED" }, 403);
      const body = await readDeleteBody(req).catch((e: unknown) => {
        // A body this server DECLINED TO READ is not a body with no channel in it. Flattening the
        // refusal into `{}` here would answer "channel required", which tells the caller to add a
        // field it already sent and never mentions the size, so the loud refusal has to survive
        // this catch. A malformed body still means "channel required", unchanged.
        if (e instanceof PayloadTooLarge || e instanceof BodyDeadlineExceeded) throw e;
        return {} as { channel?: string };
      });
      const channel = typeof body.channel === "string" ? body.channel : "";
      if (!channel) {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "channel required" }));
        return;
      }
      // BEFORE the purge, not after: this is the destructive route, and an aliasing name here
      // deletes a channel the caller did not name. Throws a BadRequest, which the request frame
      // turns into the same 400 and the same operator line every other refusal gets.
      canonicalChannel(channel);
      try {
        // User mode mints a one-shot channel-purger VIEW per delete — the ledger is re-checked at
        // this click, and a mid-session revoke becomes this handler's 400, never a dead dashboard.
        const result = user
          ? await userViewAuth(conn, "channel-purger").then((p: UserViewAuth) =>
              clearChannel({ servers: server, space, channel, bearer: p.bearer, sentinelCreds: p.sentinelCreds }),
            )
          : await clearChannel({ servers: server, space, channel, creds: purgeCreds });
        return json(res, { ok: true, ...result });
      } catch (e) {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: (e as Error).message }));
        return;
      }
    }
    // Post as the operator: a message to one channel, or a DM to one roster member.
    if (path === "/api/send" && req.method === "POST") {
      const answer = await sendAsOperator(post, poster, (id) => ep.getRoster().some((p) => p.card.id === id), () => readBody(req));
      return json(res, answer.body, answer.status);
    }

    const answer = clientResponse(client, path);
    if (answer.status === 200) {
      const { file } = answer;
      // Read before the status line: a read that throws after `writeHead` reaches the catch below
      // with the 200 already sent, and the browser runs an empty file as a success.
      const body = readFileSync(file.path);
      // The page revalidates on every load so a `cotal` upgrade's new client is picked up; the
      // hashed assets never change under their name, so they cache for good.
      res.writeHead(200, {
        "content-type": file.type,
        "cache-control": file.immutable ? "public, max-age=31536000, immutable" : "no-cache",
      });
      res.end(body);
      return;
    }
    if (answer.status === 503) return json(res, answer.body, 503);
    res.writeHead(404).end("not found");
  };

  // A route handler talks to the broker, so ANY of them can reject — a JetStream request that
  // times out (a slow or briefly unreachable broker, e.g. a mesh reached over a relayed overlay
  // link) rejects inside the async handler. `createServer(async …)` does not await its listener,
  // so such a rejection became an unhandled rejection and killed the whole dashboard process on
  // the first slow request. The dashboard is a read-only observer: one failed route must degrade
  // to a 500, never take down the server. Reply only when nothing has been written yet — a /feed
  // stream (or any partially-sent response) is already committed to its status line.
  const httpServer = createServer((req, res) => {
    res.setHeader("content-security-policy", "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'");
    res.setHeader("referrer-policy", "no-referrer");
    res.setHeader("x-content-type-options", "nosniff");
    void handleRequest(req, res).catch((e: unknown) => {
      const why = e instanceof Error ? e.message : String(e);
      // A caller error and a server fault are different facts and must not share a status. Before
      // this split, a malformed query read in the log exactly like the dashboard breaking.
      const status = e instanceof BodyDeadlineExceeded ? 408 : e instanceof PayloadTooLarge ? 413 : e instanceof BadRequest ? 400 : e instanceof BrokerRefused ? 502 : 500;
      const caller = status < 500;
      console.error(c[caller ? "yellow" : "red"](lifecycle ? `native dashboard request ${caller ? "refused" : "failed"}; diagnostic body omitted` : `${caller ? "~" : "!"} ${req.method ?? "GET"} ${requestTargetForLog(req, gate.launchToken)} ${caller ? "refused" : "failed"}: ${why}`));
      if (res.headersSent) return void res.end();
      // END THE CONNECTION A REFUSED BODY WAS RIDING ON, or the cap bounds only what the caller
      // volunteers. On a keep-alive connection Node wants the socket back, so rather than closing
      // under a caller that is still uploading it reads and discards the rest of the body first.
      // The refusal is on the wire in 2 ms either way and the caller still gets to send all of it.
      //
      // MEASURED against the shipped route, one 30,000,000 byte post per row:
      //   connection: close        3,211,264 of 30,000,000 accepted, +0 MB,   508 ms
      //   connection: keep-alive  30,000,000 of 30,000,000 accepted, +32 MB, 6516 ms
      // and with this header the keep-alive row becomes 3,407,872 accepted, +0 MB, 505 ms.
      // The connection itself also stops lingering: a refused keep-alive request ends in 3 to 4 ms
      // rather than sitting until the platform gives up on the body it was promised, at 6003 ms.
      //
      // The trade, stated rather than assumed: a caller can now force a new connection per refusal.
      // That is cheaper than letting it spend the server's memory and six seconds of reading, and a
      // caller that wanted connection churn could open connections without our help. Section 7 of
      // the suite carries the negative arm: an ordinary within-cap request keeps its socket.
      //
      // WHAT THIS DOES NOT REACH. It is the connection this process owns. A reverse proxy that
      // buffers a request before forwarding it owns its own ingress bound, and `connection` is
      // hop-by-hop, so nothing here configures anything upstream of this server.
      res.writeHead(status, e instanceof PayloadTooLarge || e instanceof BodyDeadlineExceeded
        ? { "content-type": "application/json", connection: "close" }
        : { "content-type": "application/json" });
      res.end(JSON.stringify({ error: why }));
      // NO DRAIN HERE, DELIBERATELY. Once the refusal closes the connection, no socket is kept for
      // a drain to return to the pool, and resuming the request after answering does not help a
      // client read the 413.
      //
      // WHETHER THE UPLOADING PEER READS THE 413 IS BEST EFFORT AND NOT CLAIMED. Cutting a caller
      // off mid-upload leaves unread bytes in its receive buffer, that close goes out as an RST,
      // and an RST makes the peer discard the response it had already buffered. That is the trade
      // the cap makes over reading the body to the end. The refusal that is never lost is the
      // operator line above, written before the response is.
    });
  });

  // Comment ping keeps idle SSE connections alive through proxies.
  const ping = setInterval(() => {
    for (const res of clients) if (!res.writableEnded) res.write(": ping\n\n");
  }, 20_000);

  httpServer.on("error", (e: NodeJS.ErrnoException) => {
    if (e.code === "EADDRINUSE") console.error(c.red(lifecycle ? "native dashboard port is in use; no alternate port was selected" : `Port ${port} is in use. Pass --port <n>.`));
    else console.error(c.red(lifecycle ? "! native dashboard HTTP listener failed; diagnostic body omitted" : "! " + e.message));
    // A native listener that never bound served nothing and wrote no session, so it hands its service
    // PID custody back before exiting. Exiting here directly kept the slot, and every later start of
    // the service in this space refused LIFECYCLE_BLOCKED until `cotal down` cleared it.
    if (!lifecycle || httpServer.listening) process.exit(1);
    clearInterval(ping);
    void (async () => { await membershipWatch?.stop(); await ep.stop(); await lifecycle.onClosed(); })().then(
      () => process.exit(1),
      () => {
        console.error("! native dashboard shutdown did not confirm completion; original custody was retained");
        process.exit(1);
      },
    );
  });

  await new Promise<void>((ready) => httpServer.listen(port, host, ready));
  // The advertised coordinate is the coordinate the operator explicitly chose. The branded URL is
  // reserved for the untouched loopback default, where cotal.localhost is honest and convenient.
  const url = webUrl(host, port);
  // The launch URL carries the one-time token. It is printed as well as opened, because a browser
  // that cannot be launched (headless box, wrong default) must still have a way in — and because a
  // token the operator cannot see is a token they cannot revoke by restarting.
  const launchUrl = `${url}?k=${gate.launchToken}`;
  const boundAddress = httpServer.address() as AddressInfo;
  const browserSession: WebSession = { launchUrl, readiness: gate.readinessNonce, host: boundAddress.address, port: boundAddress.port, ...(launchNonce ? { launchNonce } : {}) };
  // Written AFTER listen() succeeded, so its existence means the port is ours. A detached parent
  // reads it for the readiness nonce and the link; an operator who lost the printed line reads it
  // for the link; `cotal status` reads it for the address to probe and the nonce to present. 0600 —
  // same trust boundary as the rest of `~/.cotal`, no wider.
  if (sessionPath) {
    // The socket's address, not the requested one: a hostname `--host` binds the address it resolved to.
    const bound = httpServer.address() as AddressInfo;
    writeWebSession(sessionPath, { launchUrl, readiness: gate.readinessNonce, host: bound.address, port: bound.port });
    process.once("exit", () => rmSync(sessionPath, { force: true }));
  }
  if (!lifecycle) {
    console.log(`${c.bold("Cotal web")} - observing space ${c.bold(space)}`);
    console.log(c.dim("  god-view - DMs + anycast visible"));
    // A detached child's stdout and stderr are the persistent web.log. The parent reads the private
    // session file and prints the link to the operator's terminal, so repeating the live credential in
    // the log adds secret-at-rest exposure and no recovery value. An attached process still prints it.
    if (!process.env[DETACHED_LOG_ENV]) {
      printLaunchLink(launchUrl, host, port, "(Ctrl-C to stop)");
      console.log(c.dim("  the link is single-use; it opens one session in one browser"));
    }
    if (!values["no-open"]) openBrowser(launchUrl);
  }

  let shuttingDown = false;
  const shutdown = async (code = 0) => {
    if (shuttingDown) return;
    shuttingDown = true;
    clearInterval(ping);
    await membershipWatch?.stop();
    for (const res of clients) res.end();
    if (lifecycle) await new Promise<void>((resolve, reject) => httpServer.close((error) => error ? reject(error) : resolve()));
    else httpServer.close();
    await poster?.stop().catch(reportEndpoint);
    await ep.stop();
    if (pidPath) releasePid(pidPath);
    await lifecycle?.onClosed();
    process.exit(code);
  };
  const stop = () => void shutdown().catch(() => {
    console.error("! native dashboard shutdown did not confirm completion; original custody was retained");
    process.exit(1);
  });
  process.on("SIGINT", lifecycle ? stop : () => void shutdown());
  process.on("SIGTERM", lifecycle ? stop : () => void shutdown());
  if (lifecycle) {
    try { await lifecycle.onSession(browserSession); await lifecycle.onReady(); }
    catch {
      try { await shutdown(1); } catch { /* Unknown close retains original process/session custody. */ }
      throw new Error("native dashboard private startup was not confirmed; no replacement was launched");
    }
  }
  await new Promise<void>(() => {});
}

/** Launch the dashboard through this exact Cotal entrypoint, then report success only after the
 * spawned PID proves it owns both the mesh pidfile and the HTTP listener. */
async function launchDetachedWeb(
  raw: readonly string[],
  root: string,
  space: string,
  server: string,
  host: string,
  port: number,
  noOpen: boolean,
): Promise<void> {
  const context = { root, space };
  const pidPath = localProcessPath(webProcess.pidFile, context);
  const logPath = localProcessPath("web.log", context);
  const logFd = openDetachedLog(logPath);
  const logOffset = fstatSync(logFd).size;
  const childArgs = detachedArgs(raw, space, server);
  let child: ChildProcess;
  try {
    child = spawn(process.execPath, [...process.execArgv, process.argv[1], "web", ...childArgs], {
      cwd: root,
      detached: true,
      env: { ...process.env, [DETACHED_ROOT_ENV]: root, [DETACHED_LOG_ENV]: "1" },
      stdio: ["ignore", logFd, logFd],
    });
  } finally {
    closeSync(logFd);
  }
  child.unref();

  const url = webUrl(host, port);
  const sessionPath = localProcessPath(WEB_SESSION_FILE, context);
  let session: WebSession;
  try {
    session = await waitForDetachedWeb(child, { pidPath, sessionPath, url: boundUrl(host, port), space, timeoutMs: DETACHED_READY_TIMEOUT_MS });
  } catch (e) {
    let cleanupError: Error | undefined;
    try { await terminateDetachedWeb(child, pidPath); }
    catch (err) { cleanupError = err as Error; }
    const tail = appendedLogTail(logPath, logOffset);
    throw new Error(`${(e as Error).message}${cleanupError ? `; ${cleanupError.message}` : ""} - see ${logPath}${tail ? `\n${tail}` : ""}`);
  }

  // The child minted the token, so the parent prints the link from the record that proved readiness
  // rather than reconstructing it. Reading the file again here, outside the cleanup above, would let a
  // read error report a failed start over a dashboard that is up.
  console.log(c.green(`✓ web dashboard ready at ${url} (pid ${child.pid})`));
  printLaunchLink(session.launchUrl, host, port, "(single-use link)");
  console.log(c.dim(`  log: ${logPath}`));
  console.log(c.dim("  stop: `cotal down web`"));
  if (!noOpen) openBrowser(session.launchUrl);
}

/** Write the session file. A stale `web.session` with a broader mode is set to 0o600 through the
 *  descriptor on every write, so the launch URL and readiness nonce never stay readable to others,
 *  and a symlink at the name is refused rather than followed. */
export function writeWebSession(path: string, session: WebSession): void {
  writePrivateRecord(path, JSON.stringify(session));
}

/** Open the persistent detached log privately even when it pre-existed with permissive metadata. */
export function openDetachedLog(logPath: string): number {
  // The private open sets a stale file to 0o600 through the descriptor before either child stream
  // can write to it, and refuses a symlink. Then apply the core secret-file ACL convention for
  // win32, where POSIX mode bits do not express privacy. Fail closed before spawning if either fails.
  const logFd = openPrivateAppend(logPath);
  try {
    if (process.platform === "win32") hardenPrivate(logPath, "file");
    return logFd;
  } catch (e) {
    closeSync(logFd);
    throw e;
  }
}

export function detachedArgs(raw: readonly string[], space: string, server: string): string[] {
  const kept: string[] = [];
  for (let i = 0; i < raw.length; i++) {
    const arg = raw[i];
    if (arg === "--detach" || arg === "--no-open") continue;
    if (arg === "--space" || arg === "--server") {
      i++;
      continue;
    }
    if (arg.startsWith("--space=") || arg.startsWith("--server=")) continue;
    kept.push(arg);
  }
  return [...kept, "--space", space, "--server", server, "--no-open"];
}

const PROBE_TEXT_MAX_BYTES = 300;

// Whatever answers the bound port controls these fields, so a mismatched /api/meta body is summarized,
// never echoed whole: a string is cut to `max` characters, a number or boolean is shown only when short,
// and anything else (object, array, null, undefined) is named by its type.
function summarizeProbeField(value: unknown, max: number): string {
  if (typeof value === "string") {
    return JSON.stringify(value.length > max ? `${value.slice(0, max)}...` : value);
  }
  if (typeof value === "number" || typeof value === "boolean") {
    const text = String(value);
    return text.length <= max ? text : `<${typeof value}>`;
  }
  return value === undefined ? "<missing>" : value === null ? "null" : `<${Array.isArray(value) ? "array" : typeof value}>`;
}

// Bounds the whole last-probe text, whatever its parts, to a few hundred bytes of UTF-8. The cut
// leaves room for the three-byte marker, because the documented cap counts the marker too.
function capProbeText(text: string): string {
  const buf = Buffer.from(text, "utf8");
  if (buf.length <= PROBE_TEXT_MAX_BYTES) return text;
  return `${buf.subarray(0, PROBE_TEXT_MAX_BYTES - 3).toString("utf8").replace(/\uFFFD+$/, "")}...`;
}

export async function waitForDetachedWeb(
  child: ChildProcess,
  opts: { pidPath: string; sessionPath: string; url: string; space: string; timeoutMs: number },
): Promise<WebSession> {
  let spawnError: Error | undefined;
  const spawnErrorPromise = new Promise<Error>((resolve) => child.once("error", (e) => {
    spawnError = e;
    resolve(e);
  }));
  const pid = child.pid;
  if (!pid) {
    const error = await Promise.race([spawnErrorPromise, sleep(100).then(() => undefined)]);
    throw new Error(`web dashboard failed to start${error ? `: ${error.message}` : " (no process id)"}`);
  }
  const deadline = Date.now() + opts.timeoutMs;
  let lastProbe: string | undefined;
  while (Date.now() < deadline) {
    if (spawnError) throw new Error(`web dashboard failed to start: ${spawnError.message}`);
    if (child.exitCode !== null || child.signalCode !== null || probeLiveness(pid) === "dead")
      throw new Error(`web dashboard exited before becoming ready (pid ${pid})`);
    // Absent is "not claimed yet". A file that exists and cannot be read is not: treating that as
    // absent waits out the whole window and then reports a timeout with no probe, over a dashboard
    // that is up. `readPidfile` throws that error, naming the path.
    const recorded = readPidfile(opts.pidPath);
    if (recorded === String(pid)) {
      // The child writes its readiness nonce only after `listen()` succeeded, so an absent, empty or
      // partial file simply means "not up yet" and the loop keeps waiting, exactly as it did
      // before this surface required authentication. The probe is otherwise unchanged: a squatter on
      // the port still answers with its own space/pid and still fails the match below.
      const session = readWebSession(opts.sessionPath);
      const probeUrl = new URL(WEB_READINESS_PATH, opts.url).href;
      let meta: WebMeta | undefined;
      try {
        const answer = await probeWebReadiness(opts.url, session?.readiness);
        meta = answer.meta;
        if (meta !== undefined) {
          lastProbe = `${probeUrl}: answered space ${summarizeProbeField(meta?.space, 40)}, pid ${summarizeProbeField(meta?.pid, 20)}`;
        } else {
          lastProbe = `${probeUrl}: HTTP ${answer.status}`;
        }
      } catch (e) {
        const cause = e instanceof Error ? (e.cause as { code?: unknown } | undefined)?.code : undefined;
        lastProbe = `${probeUrl}: ${typeof cause === "string" ? `${cause}: ` : ""}${e instanceof Error ? e.message : String(e)}`;
      }
      if (session && meta?.space === opts.space && meta.pid === pid) {
        if (child.exitCode !== null || child.signalCode !== null || probeLiveness(pid) === "dead")
          throw new Error(`web dashboard exited during readiness (pid ${pid})`);
        return session;
      }
    }
    await sleep(100);
  }
  throw new Error(`web dashboard did not become HTTP-ready within ${opts.timeoutMs}ms (pid ${pid})${lastProbe ? `; last probe ${capProbeText(lastProbe)}` : ""}`);
}

export async function terminateDetachedWeb(child: ChildProcess, pidPath: string): Promise<void> {
  const pid = child.pid;
  if (!pid) return;
  if (probeLiveness(pid) !== "dead") {
    try { child.kill("SIGTERM"); } catch { /* verify below */ }
    if (!(await waitForDeath(child, pid, DETACHED_STOP_TIMEOUT_MS))) {
      try { child.kill("SIGKILL"); } catch { /* verify below */ }
      if (!(await waitForDeath(child, pid, DETACHED_STOP_TIMEOUT_MS)))
        throw new Error(`failed to terminate detached web dashboard (pid ${pid}); ${pidPath} was preserved`);
    }
  }
  removePidPair(pidPath, String(pid));
}

async function waitForDeath(child: ChildProcess, pid: number, timeoutMs: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null || probeLiveness(pid) === "dead") return true;
  await Promise.race([
    new Promise<void>((resolve) => child.once("exit", () => resolve())),
    sleep(timeoutMs),
  ]);
  return child.exitCode !== null || child.signalCode !== null || probeLiveness(pid) === "dead";
}

export function appendedLogTail(path: string, offset: number): string {
  try {
    const size = statSync(path).size;
    if (size <= offset) return "";
    const start = Math.max(offset, size - 4096);
    const bytes = Buffer.alloc(size - start);
    const fd = openSync(path, "r");
    try { readSync(fd, bytes, 0, bytes.length, start); } finally { closeSync(fd); }
    return bytes.toString("utf8").trim();
  } catch {
    return "";
  }
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Validate and normalize one host used for both binding and browser advertisement. Wildcard binds
 *  are refused because they do not name a destination a browser or readiness probe can honestly use. */
export function normalizeWebHost(input: string | undefined): string {
  if (input === undefined) return WEB_HOST;
  if (input === "" || input !== input.trim()) throw new Error("--host must be a hostname or IP address without surrounding whitespace");
  const unbracketed = input.startsWith("[") && input.endsWith("]") ? input.slice(1, -1) : input;
  if (unbracketed.includes("[") || unbracketed.includes("]") || /[\s/?#@]/.test(unbracketed))
    throw new Error(`invalid --host ${input}`);
  let host: string;
  try {
    // WHATWG parsing canonicalizes alternate IPv4 spellings and compressed IPv6. Check the
    // canonical value so aliases such as `0` cannot bypass the wildcard refusal and advertise
    // `0.0.0.0` after URL serialization.
    const ipv6 = unbracketed.includes(":");
    const parsed = new URL(`http://${ipv6 ? `[${unbracketed}]` : unbracketed}:1/`);
    if (parsed.port !== "1" || parsed.pathname !== "/" || parsed.username || parsed.password)
      throw new Error(`invalid --host ${input}`);
    host = ipv6 ? parsed.hostname.slice(1, -1) : parsed.hostname;
  } catch {
    throw new Error(`invalid --host ${input}`);
  }
  if (WILDCARD_HOSTS.has(host) || host === IPV4_MAPPED_WILDCARD)
    throw new Error(`--host ${input} is a wildcard bind, not a browser address; pass one reachable hostname or IP address`);
  return host;
}

/** Validate the one port used for the bind, the advertised link, the Origin allow-list and the
 *  detached readiness probe. Port 0 is refused because the kernel would bind an ephemeral port that
 *  none of those, all built from the requested value, would name. */
function parseWebPort(input: string | undefined): number {
  if (input === undefined) return WEB_PORT;
  const port = Number(input);
  if (!/^[0-9]+$/.test(input) || port < 1 || port > 65535)
    throw new Error(`invalid --port ${quoteForOperator(input)}; pass a decimal port from 1 to 65535`);
  return port;
}

export function webUrl(host: string, port: number): string {
  if (host === WEB_HOST && port === WEB_PORT) return WEB_URL;
  return boundUrl(host, port);
}

/** On the branded default the link is printed a second time at the bound address, so an operator
 *  whose browser or resolver has no answer for `cotal.localhost` still has a way in. Both carry the
 *  one token, so opening either spends it. */
function printLaunchLink(launchUrl: string, host: string, port: number, note: string): void {
  console.log(`  ${c.cyan(launchUrl)}  ${c.dim(note)}`);
  const bound = boundUrl(host, port);
  if (webUrl(host, port) !== bound)
    console.log(`  ${c.cyan(`${bound}${new URL(launchUrl).search}`)}  ${c.dim("(the same link, where cotal.localhost does not resolve)")}`);
}

function json(res: ServerResponse, data: unknown, status = 200): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(data));
}

/** Trailing-edge debounce — coalesces a burst of deltas (membership feed, presence replay) into one push. */
function debounce(fn: () => void, ms: number): () => void {
  let t: ReturnType<typeof setTimeout> | undefined;
  return () => {
    if (t) clearTimeout(t);
    t = setTimeout(fn, ms);
  };
}

/** Race the whole delete upload, not the gaps between chunks. On expiry the request frame sends
 *  408 with Connection: close, ending the socket and its pending body reader after the reply.
 *  Only the winning body can reach the purge; a late completion has no effect. */
async function readDeleteBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new BodyDeadlineExceeded(
      `request body did not finish within ${DELETE_BODY_DEADLINE_MS}ms`,
    )), DELETE_BODY_DEADLINE_MS);
  });
  try {
    return await Promise.race([readBody(req), expired]);
  } finally {
    clearTimeout(timer);
  }
}

async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  // A DECLARED size over the cap is refused before a single body byte is read. A declaration can
  // lie, in either direction, so this is the cheap gate and the loop below is the real one.
  const declared = Number(req.headers["content-length"]);
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) throw tooLarge(declared, "declared");
  const chunks: Buffer[] = [];
  let seen = 0;
  for await (const chunk of req) {
    seen += (chunk as Buffer).length;
    // AT the threshold, not after it. Throwing here abandons the iterator, so the rest of the
    // upload is never read into this process, and the frame's reply closes the connection under
    // a caller that is still sending. Truncating to the cap instead would be worse than not
    // capping at all: a shortened channel name is a name the caller did not send, which is the
    // aliasing shape the validator on this same route exists to refuse.
    if (seen > MAX_BODY_BYTES) throw tooLarge(seen, "read");
    chunks.push(chunk as Buffer);
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? JSON.parse(raw) : {};
}

/** The refusal names the limit and how the limit was met, so an operator reading one line knows
 *  whether the caller announced an oversized body or simply sent one. */
function tooLarge(bytes: number, how: "declared" | "read"): PayloadTooLarge {
  return new PayloadTooLarge(
    `request body ${how === "declared" ? "declares" : "exceeds"} ${bytes} bytes, over the ${MAX_BODY_BYTES} byte limit for this route`,
  );
}

function noBody(path: string, declared: number): PayloadTooLarge {
  const announced = declared > 0 ? `${declared} bytes` : "transfer-encoding";
  return new PayloadTooLarge(
    `request body announces ${announced}, over the 0 byte limit because ${path} takes no request body`,
  );
}

/** Best-effort open of the dashboard in the default browser. The URL is already
 *  printed, so a failure here is harmless — never block startup on it. `--no-input` opens nothing. */
export function openBrowser(url: string): void {
  if (inputDisabledByFlag()) return;
  const [cmd, args] =
    process.platform === "darwin"
      ? ["open", [url]]
      : process.platform === "win32"
        ? ["cmd", ["/c", "start", "", url]]
        : ["xdg-open", [url]];
  try {
    spawn(cmd as string, args as string[], { stdio: "ignore", detached: true }).unref();
  } catch {
    /* no opener on this platform — the printed URL is the fallback */
  }
}
