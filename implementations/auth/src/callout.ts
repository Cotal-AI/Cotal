/**
 * Plane-2 auth-callout bridge (ADR-26, operator mode) — the server-side service that turns a
 * validated user bearer into a scoped, short-lived NATS user JWT at connect time.
 *
 * Operator-mode topology (the sentinel pattern):
 *  - a DEDICATED auth account quarantines callout traffic ({@link createCalloutAuth}): the callout
 *    service is its only privileged user, plus a shared deny-all "sentinel" user whose creds
 *    agents present alongside the real bearer in `auth_token`;
 *  - the auth account's JWT carries `authorization { auth_users, allowed_accounts, xkey }`, so the
 *    server routes connects landing there to `$SYS.REQ.USER.AUTH` and lets the response re-bind
 *    the client into the DATA account (`issuer_account` + a user JWT signed by the data account's
 *    signing key);
 *  - the **xkey is mandatory**: {@link startAuthCallout} refuses to start without one, and drops
 *    any request that arrives unsealed or whose signed `server_id.xkey` doesn't match the sealing
 *    header key — without this the bearer crosses the auth path in cleartext (TLS protects the
 *    transport, not this payload).
 *
 * Fail-closed at every step: protocol-shape violations (bad seal, bad signature, key mismatch)
 * get NO response (the server denies on timeout — we cannot authenticate the peer, so we do not
 * talk to it); authenticated-but-invalid bearers get a signed, sealed ERROR response; only a fully
 * validated principal gets a mint. The minted user JWT's expiry is BOUND to the bearer's, so
 * broker access dies with the token (the v1 revocation lever — nats-server disconnects clients at
 * user-JWT expiry). An authenticated request the callout cannot answer inside the broker's
 * `authorization { timeout }` gets a signed timeout denial instead of silence.
 */
import {
  Algorithms,
  encodeAccount,
  encodeAuthorizationResponse,
  encodeUser,
  fmtCreds,
  type AuthorizationRequest,
} from "@nats-io/jwt";
import { createAccount, createCurve, fromCurveSeed, fromPublic, fromSeed } from "@nats-io/nkeys";
import { assertInboxConnId, calloutReaderId, decodeNatsJwt, nativeNkeySigner, newIdentity, principalKey, principalTags, token } from "@cotal-ai/core";
import type { JWTVerifyGetKey, CryptoKey } from "jose";
import { expiredBearerPrincipal, validateUserToken, type ValidatedUserToken } from "./token.js";
import { ConnectLimiter, ConnectRateLimited } from "./connect-limit.js";
import { SESSION_EXP, ENDPOINT_CALLER_EXP, ENDPOINT_CALLER_RECHECK } from "./permissions.js";
import type { NativeIssuanceRecorder } from "./native-issuance.js";
import { assertNativeServiceCalloutAuthority, issueNativeServiceCallout, type NativeServiceCalloutAuthority } from "./native-service-callout.js";

/** The one subject the callout serves (ADR-26). */
export const AUTH_CALLOUT_SUBJECT = "$SYS.REQ.USER.AUTH";

/** Header carrying the server's public curve key on sealed callout requests. */
const SERVER_XKEY_HEADER = "Nats-Server-Xkey";

/** The error a callout answers when it cannot answer inside the broker's auth timeout. */
export const CALLOUT_TIMEOUT_REASON = "timeout: the auth callout could not answer inside the broker's authorization timeout";

/** Taken off the broker's auth timeout so a timeout denial still reaches the broker in time. */
const DEADLINE_MARGIN_MS = 250;

/** Per-service callout limits. Every field is optional and has a default. */
export interface AuthCalloutLimits {
  /** The broker's `authorization { timeout }`, in milliseconds. Set it to the broker's value: a
   *  request not answered 250 ms before it gets a signed timeout denial. Default 2000, the
   *  nats-server default. */
  authTimeoutMs?: number;
  /** Requests worked on at once. The rest wait in arrival order. Default 32. */
  maxInFlight?: number;
  /** A callout that takes longer than this, in milliseconds, logs its line at warn. Default 500. */
  slowMs?: number;
}

/** Resolve limits against their defaults. Throws on a value out of range. */
export function calloutLimits(limits: AuthCalloutLimits = {}): Required<AuthCalloutLimits> {
  const { authTimeoutMs = 2000, maxInFlight = 32, slowMs = 500 } = limits;
  if (!Number.isSafeInteger(authTimeoutMs) || authTimeoutMs < 2 * DEADLINE_MARGIN_MS)
    throw new Error(`auth callout: authTimeoutMs must be a whole number of milliseconds of at least ${2 * DEADLINE_MARGIN_MS}, got ${authTimeoutMs}`);
  if (!Number.isSafeInteger(maxInFlight) || maxInFlight < 1)
    throw new Error(`auth callout: maxInFlight must be a positive whole number, got ${maxInFlight}`);
  if (!Number.isSafeInteger(slowMs) || slowMs < 1)
    throw new Error(`auth callout: slowMs must be a positive whole number of milliseconds, got ${slowMs}`);
  return { authTimeoutMs, maxInFlight, slowMs };
}

// The auth account is a quarantine: no JetStream, unlimited conns (every callout-mode connect
// transits it). Mirrors core's account limits shape (which is module-private there on purpose —
// the auth account is this package's concern, not part of the wire standard).
const AUTH_ACCOUNT_LIMITS = {
  subs: -1, conn: -1, leaf: -1, imports: -1, exports: -1,
  data: -1, payload: -1, wildcards: true, mem_storage: 0, disk_storage: 0,
} as const;

/** The trust material of the dedicated auth-callout account. */
export interface CalloutAuth {
  /** The auth account: operator-signed JWT carrying `authorization { auth_users, allowed_accounts, xkey }`. */
  account: { pub: string; seed: string; signingSeed: string; signingPub: string; jwt: string };
  /** The callout service's own connection creds (the sole `auth_users` entry). */
  calloutCreds: string;
  /** Shared, deny-all sentinel creds agents present alongside their bearer. Powerless by design. */
  sentinelCreds: string;
  /** The callout curve keypair (xkey). The seed stays with the callout service only. */
  xkey: { seed: string; pub: string };
}

/** EXACTLY what minting the callout account requires — a deliberate capability boundary (the
 *  auth-provider seam passes this, never the whole space bundle): the operator seed signs the new
 *  account into the trust chain; the data-account PUB is what `allowed_accounts` re-binds into. */
export interface CalloutProvisionInput {
  space: string;
  /** The space operator's signing seed — only the operator can sign a new account. */
  operatorSeed: string;
  /** The data account callout responses may bind users into (public key only). */
  accountPub: string;
}

/** Generate the dedicated auth-callout account for a space: account + signing key, the callout
 *  service user, the deny-all sentinel, and the xkey — `authorization` wired so the server seals
 *  requests and lets responses bind users into the data account. */
export async function createCalloutAuth(input: CalloutProvisionInput): Promise<CalloutAuth> {
  if (!input.operatorSeed) throw new Error("createCalloutAuth: the operator signing seed is required - a stripped space bundle cannot sign a new account");
  if (!input.accountPub) throw new Error("createCalloutAuth: the data account public key is required");
  const okp = fromSeed(new TextEncoder().encode(input.operatorSeed));
  const akp = createAccount();
  const askp = createAccount();
  const xkp = createCurve();
  const callout = newIdentity();
  const sentinel = newIdentity();

  const accountJwt = await encodeAccount(
    `AUTH_${token(input.space)}`,
    akp,
    {
      limits: { ...AUTH_ACCOUNT_LIMITS },
      signing_keys: [askp.getPublicKey()],
      authorization: {
        auth_users: [callout.id],
        allowed_accounts: [input.accountPub],
        xkey: xkp.getPublicKey(),
      },
    },
    { signer: okp },
  );

  const dec = (u: Uint8Array) => new TextDecoder().decode(u);
  const signer = askp;
  // The callout user: subscribe ONLY the callout subject; publish everywhere it might need to send
  // a reply (server-chosen inbox) EXCEPT the callout subject itself — denying pub on
  // $SYS.REQ.USER.AUTH means even a leaked callout cred cannot inject a forged auth request into
  // its own service (defense-in-depth behind the iss/server-id provenance check in the handler).
  // The sentinel: deny-all both ways — it exists only so a connect can carry a bearer; any
  // capability here would be pre-auth surface.
  const calloutJwt = await encodeUser("callout", fromPublic(callout.id), fromPublic(akp.getPublicKey()), {
    sub: { allow: [AUTH_CALLOUT_SUBJECT] },
    pub: { allow: [">"], deny: [AUTH_CALLOUT_SUBJECT] },
  }, { signer });
  const sentinelJwt = await encodeUser("sentinel", fromPublic(sentinel.id), fromPublic(akp.getPublicKey()), {
    sub: { deny: [">"] },
    pub: { deny: [">"] },
  }, { signer });

  return {
    account: { pub: akp.getPublicKey(), seed: dec(akp.getSeed()), signingSeed: dec(askp.getSeed()), signingPub: askp.getPublicKey(), jwt: accountJwt },
    calloutCreds: dec(fmtCreds(calloutJwt, fromSeed(new TextEncoder().encode(callout.seed)))),
    sentinelCreds: dec(fmtCreds(sentinelJwt, fromSeed(new TextEncoder().encode(sentinel.seed)))),
    xkey: { seed: dec(xkp.getSeed()), pub: xkp.getPublicKey() },
  };
}

/** The minimal connection surface the callout needs — structurally satisfied by a nats.js
 *  `NatsConnection` without this package depending on a transport. */
export interface CalloutConnection {
  subscribe(subject: string, opts?: { queue?: string }): AsyncIterable<CalloutMsg>;
}
export interface CalloutMsg {
  data: Uint8Array;
  headers?: { get(key: string): string | undefined };
  respond(data: Uint8Array): unknown;
}

/** Hooks for distinct connections may run concurrently. Each connection still awaits its own
 *  authority checks and durable issuance before its encrypted response is released. */
export interface StartAuthCalloutOpts {
  /** The callout xkey SEED — MANDATORY. No xkey, no service (fail startup, never plaintext). */
  xkeySeed: string;
  /** The auth account (response issuer): its pub + the signing seed the response is signed with. */
  authAccount: { pub: string; signingSeed: string };
  /** The data account users are bound into: its pub + the signing seed that mints user JWTs. */
  dataAccount: { pub: string; signingSeed: string };
  /** The space — enforced as the bearer's audience. */
  space: string;
  /** Pinned bearer verification: the key resolver (pinned JWKS/local key) + exact issuer. */
  token: { key: JWTVerifyGetKey | CryptoKey; issuer: string };
  /** The spawn-ledger hook: THROW to deny. Client-supplied actor claims are only as good as this
   *  server-side check — the flip wires the manager's authenticated spawn ledger in here. */
  authorizeActor: (t: ValidatedUserToken) => void | Promise<void>;
  /** Allow-list of trusted nats-server ids (`server_id.id`) — the tightest request-provenance pin:
   *  a request whose server id is not listed is dropped (no response). STRONGLY RECOMMENDED for any
   *  hardened / multi-server deploy. When omitted, the ONLY barrier left is NATS $SYS system-subject
   *  isolation (no in-account user can publish `$SYS.REQ.USER.AUTH`, and the callout user is even
   *  explicitly pub-denied it) — the app-layer `iss === server_id.id` + `N…`-prefix check is NOT
   *  independently sufficient, since an attacker who could reach the subject could present their own
   *  `createServer()` key and matching sealing xkey. That isolation holds single-broker, so omitting
   *  the list is safe today; startup logs a WARNING so the over-trust is never silent. */
  expectedServerIds?: string[];
  /** Permission builder for a validated principal (the flip feeds core's `permissionsFor` via a thin
   *  `@cotal-ai/auth` adapter). `connId` is the client-chosen inbox nonce (`req.connect_opts.name`), NOT
   *  the NATS-minted `req.user_nkey` — the builder scopes the private reply inbox `_INBOX_<connId>.>` on
   *  it. The client picks and passes this nonce because neither it nor this callout knows the per-connect
   *  nkey pre-connect; core's `assertInboxConnId` rejects a nonce with subject metacharacters, so it
   *  cannot widen the grant. An absent/invalid nonce makes the builder throw → a signed deny.
   *  `readerId` is core's `calloutReaderId` of this connection, which keys the observer and admin
   *  profiles' history-reader deletes: the client chooses the nonce, so the nonce cannot key them. */
  permissionsFor: (t: ValidatedUserToken, connId: string, readerId: string) => Record<string, unknown> | Promise<Record<string, unknown>>;
  /** REQUIRED: durably record the minted JWT's broker user key (`req.user_nkey`) against the validated
   *  principal BEFORE the response leaves (SPEC 13.1 `natkey.`). Awaited; a throw becomes the signed
   *  deny and the minted JWT is never sent. A thrown record write may still have landed: evidence of
   *  an issuance, never proof a client received the JWT or the connection was accepted. */
  recordIssuance: NativeIssuanceRecorder;
  /** Optional sealed native service path. Absent means service-endpoint continues to refuse. */
  serviceAuthority?: NativeServiceCalloutAuthority;
  /** The connect limits, shared with the exchange so an actor limited here is refused there too.
   *  Absent: a limiter of this callout's own at the default limits. */
  connectLimiter?: ConnectLimiter;
  /** Diagnostics sink (default: console.error). Never carries bearer contents. Each answered
   *  request writes one `auth callout: level=…` line, whose fields docs/identity-and-auth.md names. */
  log?: (line: string) => void;
  /** Deadline, concurrency and slow-line limits. Absent: every default. */
  limits?: AuthCalloutLimits;
  /** Audit hook fired on each successful mint, BEFORE the response is sent — the minted user JWT
   *  plus its principal and bound expiry. For metering/audit and for asserting the revocation lever
   *  (the mint's `exp` is bound to the bearer's, so broker access dies with the bearer). */
  onMint?: (info: { jwt: string; principal: string; exp: number }) => void;
}

type CalloutPhase = "verify" | "ledger" | "policy" | "sign";
type CalloutOutcome = "minted" | "denied" | "timeout" | "shed";

/** One authenticated request, from its arrival to its one answer. */
interface Callout {
  msg: CalloutMsg;
  req: AuthorizationRequest;
  serverXkey: string;
  /** The user key the broker generated for this connect, which the response is addressed to. */
  id: string;
  arrivedAt: number;
  queuedAt: number;
  startedAt?: number;
  /** Unix seconds, for the native service path. */
  admittedAt: number;
  deadline?: ReturnType<typeof setTimeout>;
  answered: boolean;
  phase: CalloutPhase | "queue";
  ms: Record<CalloutPhase, number>;
  owner?: string;
  actor?: string;
}

/** Thrown out of a callout's work once something else answered it: the work stops there. */
const ANSWERED = Symbol("answered");

/** A log field value, quoted when it is not a plain token. */
const field = (s: string) => (/^[\w.:@|-]+$/.test(s) ? s : JSON.stringify(s));

/** Serve the auth callout on an existing (auth-account) connection. Resolves setup synchronously —
 *  throws on missing/invalid xkey or signing material; returns the running service.
 *
 *  Requests are worked on oldest first, at most `maxInFlight` at a time. Each one's deadline is the
 *  broker's auth timeout less 250 ms after it arrived. A request still unanswered then gets a signed
 *  timeout denial, and its work stops at its next step. While the oldest request still waiting for a
 *  slot has waited more than half that budget, a new request gets the same denial at once. */
export function startAuthCallout(nc: CalloutConnection, opts: StartAuthCalloutOpts): { done: Promise<void> } {
  if (!opts.xkeySeed) throw new Error("auth callout: xkey seed is required - refusing to start a callout that would receive bearer tokens unsealed");
  const xkp = fromCurveSeed(new TextEncoder().encode(opts.xkeySeed)); // throws on non-curve seeds
  const responseSigner = nativeNkeySigner(new TextEncoder().encode(opts.authAccount.signingSeed));
  const userSigner = nativeNkeySigner(new TextEncoder().encode(opts.dataAccount.signingSeed));
  if (!opts.space) throw new Error("auth callout: space is required");
  if (typeof opts.recordIssuance !== "function") throw new Error("auth callout: recordIssuance is required - refusing to start a callout whose successes leave no native-key issuance evidence");
  const serviceAuthority = opts.serviceAuthority;
  if (serviceAuthority) assertNativeServiceCalloutAuthority(serviceAuthority, opts.space, opts.dataAccount.pub);
  const limits = calloutLimits(opts.limits);
  const budgetMs = limits.authTimeoutMs - DEADLINE_MARGIN_MS;
  const log = opts.log ?? ((l: string) => console.error(l));
  const limiter = opts.connectLimiter ?? new ConnectLimiter();
  const enc = (s: string) => new TextEncoder().encode(s);
  const dec = (u: Uint8Array) => new TextDecoder().decode(u);
  if (!opts.expectedServerIds?.length)
    log("auth callout: WARNING - no expectedServerIds allow-list set; request provenance rests on $SYS system-subject isolation alone (safe single-broker, but set expectedServerIds for hardened/multi-server deploys)");

  const sub = nc.subscribe(AUTH_CALLOUT_SUBJECT, { queue: "cotal-auth-callout" });
  const queue: Callout[] = []; // admitted and not started, oldest first
  const running = new Set<Promise<void>>();
  let stopped = false;
  let workerFailed = false;
  let workerError: unknown;
  let rejectWorker!: (error: unknown) => void;
  const workerFailure = new Promise<never>((_resolve, reject) => { rejectWorker = reject; });

  /** The one line an answered request writes. */
  const journal = (c: Callout, outcome: CalloutOutcome, extra: string) => {
    const now = performance.now();
    const total = now - c.arrivedAt;
    const level = total > limits.slowMs || outcome === "timeout" || outcome === "shed" ? "warn" : "info";
    const ms = (n: number) => Math.round(n);
    log(`auth callout: level=${level} outcome=${outcome} req=${field(c.id)} cid=${c.req.client_info?.id ?? "-"}` +
      ` owner=${field(c.owner ?? "-")} actor=${field(c.actor ?? "-")} queue_ms=${ms((c.startedAt ?? now) - c.queuedAt)}` +
      ` verify_ms=${ms(c.ms.verify)} ledger_ms=${ms(c.ms.ledger)} policy_ms=${ms(c.ms.policy)} sign_ms=${ms(c.ms.sign)} total_ms=${ms(total)}${extra}`);
  };

  /** Sign and seal a response to one request. */
  const seal = async (c: Callout, data: { jwt?: string; error?: string }): Promise<Uint8Array> => {
    const resp = await encodeAuthorizationResponse(
      fromPublic(c.req.user_nkey),
      fromPublic(c.req.server_id.id),
      responseSigner,
      { ...data, issuer_account: opts.authAccount.pub },
      { algorithm: Algorithms.v2 },
    );
    return xkp.seal(enc(resp), c.serverXkey);
  };

  /** Release a sealed response unless the request is already answered. `beforeSend` runs only
   *  for the response that goes out; a throw from it leaves the request unanswered. */
  const send = (c: Callout, sealed: Uint8Array, outcome: CalloutOutcome, extra = "", beforeSend?: () => void): boolean => {
    if (c.answered) return false;
    beforeSend?.();
    c.answered = true;
    clearTimeout(c.deadline);
    try {
      c.msg.respond(sealed);
    } catch (e) {
      log(`auth callout: failed to send the ${outcome} response to ${c.id}: ${e instanceof Error ? e.message : String(e)}`);
    }
    journal(c, outcome, extra);
    return true;
  };

  /** Answer the signed timeout denial: at the deadline, or at once when admission sheds. */
  const refuse = async (c: Callout, outcome: "timeout" | "shed", extra: string) => {
    if (c.answered) return;
    try {
      send(c, await seal(c, { error: CALLOUT_TIMEOUT_REASON }), outcome, extra);
    } catch (e) {
      log(`auth callout: failed to send the ${outcome} response to ${c.id}: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  /** One timed step of a callout's work. Stops the work once something else answered it. */
  const step = async <T>(c: Callout, phase: CalloutPhase, f: () => T | Promise<T>): Promise<T> => {
    c.phase = phase;
    const t = performance.now();
    let out: T;
    try {
      out = await f();
    } finally {
      c.ms[phase] += performance.now() - t;
    }
    if (c.answered) throw ANSWERED;
    return out;
  };

  /** Authenticate a request as it arrives. Shape violations get NO response. */
  function admit(msg: CalloutMsg, arrivedAt: number): Callout | undefined {
    const serverXkey = msg.headers?.get(SERVER_XKEY_HEADER);
    if (!serverXkey) {
      log("auth callout: dropped an UNSEALED request (no Nats-Server-Xkey header) - check the account xkey config");
      return;
    }
    let claims;
    try {
      const plain = xkp.open(msg.data, serverXkey);
      if (plain === null) throw new Error("xkey open failed");
      claims = decodeNatsJwt<AuthorizationRequest>(dec(plain)); // the issuer's ed25519 signature, verified natively
    } catch (e) {
      log(`auth callout: dropped an undecryptable/unverifiable request (${e instanceof Error ? e.message : String(e)})`);
      return;
    }
    const req = (claims as { nats?: AuthorizationRequest }).nats;
    if (!req?.user_nkey || !req.server_id?.id) {
      log("auth callout: dropped a request without user_nkey/server_id");
      return;
    }
    // Request provenance — prove nats-server sent this, not an in-account publisher. `decodeNatsJwt()`
    // verified the signature against the embedded `iss`, but that alone accepts ANY self-signed
    // JWT; without pinning, a holder of callout creds could publish a sealed forged request to a
    // reply subject it controls and be minted a data-account JWT. So: the issuer must be the
    // request's own server id AND a server-prefixed (`N…`) nkey, and — when configured — one of
    // the trusted server ids.
    const issuer = (claims as { iss?: string }).iss;
    if (issuer !== req.server_id.id || !req.server_id.id.startsWith("N")) {
      log("auth callout: dropped a request whose issuer is not its own server identity (forgery guard)");
      return;
    }
    if (opts.expectedServerIds && !opts.expectedServerIds.includes(req.server_id.id)) {
      log(`auth callout: dropped a request from an untrusted server id ${req.server_id.id}`);
      return;
    }
    if (req.server_id.xkey !== serverXkey) {
      // The signed payload must vouch for the key that sealed it — otherwise a relay could
      // re-seal someone else's request under its own key.
      log("auth callout: dropped a request whose signed server_id.xkey != sealing header key");
      return;
    }
    const queuedAt = performance.now();
    return {
      msg, req, serverXkey,
      id: req.user_nkey,
      arrivedAt, queuedAt,
      admittedAt: Math.floor(Date.now() / 1000),
      answered: false,
      phase: "queue",
      ms: { verify: queuedAt - arrivedAt, ledger: 0, policy: 0, sign: 0 },
    };
  }

  // ---- validate the bearer; failures are authenticated denials (signed error response) ----
  async function work(c: Callout): Promise<void> {
    const { req } = c;
    try {
      const bearer = req.connect_opts?.auth_token;
      let validated: ValidatedUserToken;
      try {
        if (!bearer) throw new Error("no user token presented (auth_token empty)");
        validated = await step(c, "verify", () => validateUserToken(bearer, {
          key: opts.token.key,
          issuer: opts.token.issuer,
          audience: opts.space,
        }));
      } catch (e) {
        if (e === ANSWERED) throw e;
        // A refused bearer still spends a callout. Charge it to the principal its signature names
        // when only its expiry failed, and otherwise to the client host the broker saw.
        const principal = expiredBearerPrincipal(e, opts.token.issuer);
        if (principal) {
          c.owner = principal.owner;
          c.actor = principal.actor;
        }
        limiter.take(principal ?? { host: req.client_info?.host ?? "(none)" });
        throw e;
      }
      c.owner = validated.owner;
      c.actor = validated.act.actor;
      // Before any ledger read or issuance write: a reconnect loop stops here once it is limited.
      limiter.take({ owner: validated.owner, actor: validated.act.actor });
      if (validated.act.view === "service-endpoint") {
        if (!serviceAuthority)
          throw new Error("callout: service-endpoint requires dedicated native service authority; ordinary actor hooks refuse it");
        const clientId = req.client_info?.id;
        if (typeof clientId !== "number" || !Number.isSafeInteger(clientId) || clientId <= 0)
          throw new Error("service callout requires an authenticated broker client id");
        const minted = await step(c, "ledger", () => issueNativeServiceCallout(serviceAuthority, validated, {
          connection: { userNkey: req.user_nkey, serverId: req.server_id.id, clientId },
          inboxNonce: assertInboxConnId(req.connect_opts?.name ?? ""), admittedAt: c.admittedAt,
        }));
        const sealed = await step(c, "sign", () => seal(c, { jwt: minted.jwt }));
        if (minted.exp <= Math.floor(Date.now() / 1000))
          throw new Error("service callout expired before encrypted response release");
        send(c, sealed, "minted", "", () => opts.onMint?.(minted));
        return;
      }
      await step(c, "ledger", () => opts.authorizeActor(validated));
      // The private reply-inbox (`_INBOX_<connId>.>`) must scope on a token the CLIENT knows pre-connect
      // — but under the callout the connection nkey (`req.user_nkey`) is minted per-connect by NATS, so
      // the client cannot set its `inboxPrefix` to match it. So the client picks its own random inbox
      // nonce and passes it as the connection `name`; we scope the grant on THAT (empirically: a scoped
      // `_INBOX_<nonce>.>` round-trips through the rebind, and the nonce is a per-connection secret, the
      // same security model as NATS's default random mux inbox). core's `assertInboxConnId` (via
      // permissionsFor) rejects a nonce carrying subject metacharacters, so a client cannot widen the
      // grant to `_INBOX_>.>`; a missing/garbled name throws → this becomes a signed deny (fail-closed).
      // Validate the nonce HERE, at the boundary where untrusted client input enters — not inside the
      // injected permissionsFor hook (which could be any implementation). assertInboxConnId throws on a
      // missing/wildcard name → the catch below turns it into a signed deny (fail-closed).
      const inboxNonce = assertInboxConnId(req.connect_opts?.name ?? "");
      // The history-reader deletes key on what the SERVER assigned this connection, never on the
      // nonce: a client that named another connection's nonce would otherwise be granted the
      // deletes of that connection's readers. A request without a client id throws → signed deny.
      const readerId = calloutReaderId(req.server_id.id, req.client_info?.id as number);
      const { [SESSION_EXP]: sessionExp, [ENDPOINT_CALLER_EXP]: endpointExp, [ENDPOINT_CALLER_RECHECK]: endpointRecheck, ...perms } =
        await step(c, "policy", () => opts.permissionsFor(validated, inboxNonce, readerId));
      // #2312: a session-caller connection carries EXACTLY the static arm's expiry, the grant's,
      // and only when the permission builder vouched for it from the live session row.
      const exp = validated.act.view === "session-caller" ? sessionExp : endpointExp === undefined ? validated.exp : Math.min(validated.exp, endpointExp as number);
      if (typeof exp === "number" && exp <= Math.floor(Date.now() / 1000)) throw new Error("callout: endpoint caller authority expired before signing");
      if (typeof exp !== "number" || !Number.isSafeInteger(exp)) throw new Error("callout: no bound expiry for this connection");
      // Stamp the principal into the minted JWT so the live identity is recoverable server-side: the
      // connection's `user_nkey` is a per-connect ephemeral the SERVER generated, not the principal,
      // so CONNZ-based attribution (the membership feed, live eviction) needs owner+actor carried
      // here. What actually surfaces in CONNZ for a CALLOUT connection (proven live, nats-server
      // 2.10/2.14) is the JWT `name` as `authorized_user` — the principal NAME-form — NOT the `tags`
      // (those surface for static mints; see core's `principalFromConnz`). We set BOTH via core's
      // single sources for shape-consistency with the static path, but attribution reads
      // `authorized_user` here. The name is the principal name-form (JetStream-safe), a stable label.
      const { key, name } = principalKey(validated.owner, validated.act.actor);
      const { userJwt, iat } = await step(c, "sign", async () => {
        const jwt = await encodeUser(
          name,
          fromPublic(req.user_nkey),
          fromPublic(opts.dataAccount.pub),
          { ...perms, tags: principalTags(validated.owner, validated.act.actor) },
          { signer: userSigner, exp }, // NATS access dies with the bearer (a session-caller: with its grant)
        );
        return { userJwt: jwt, iat: signedIat(jwt) };
      });
      await step(c, "ledger", () => opts.recordIssuance({ userNkey: req.user_nkey, token: validated, connId: inboxNonce, iat, exp }));
      if (endpointRecheck !== undefined) {
        if (typeof endpointRecheck !== "function") throw new Error("callout: invalid endpoint caller final check");
        await step(c, "policy", () => endpointRecheck());
      }
      const sealed = await step(c, "sign", () => seal(c, { jwt: userJwt }));
      if (exp <= Math.floor(Date.now() / 1000)) throw new Error("callout: authority expired before response release");
      send(c, sealed, "minted", "", () => opts.onMint?.({ jwt: userJwt, principal: key, exp }));
    } catch (e) {
      if (e === ANSWERED || c.answered) return;
      const reason = e instanceof ConnectRateLimited
        ? `${e.code} retry-after ${e.retryAfterSeconds}s: ${e.message}`
        : e instanceof Error ? e.message : String(e);
      try {
        // The deny response MUST always encode: a denied connect that can't be answered TIMES OUT
        // instead of getting a legible signed refusal, which breaks the fail-closed "refuse, never
        // hang" contract. The auth-response JWT claim encoder is Latin1-limited (btoa-style — a
        // non-ASCII char like the em-dash in many of our throw messages raises "Invalid character"),
        // so coerce the reason to ASCII at this boundary. It is a human-readable hint, not a security
        // token, so lossy folding (em-dash → "-", smart quotes → ASCII, else "?") is fine.
        send(c, await seal(c, { error: asciiFold(reason) }), "denied", ` reason=${JSON.stringify(reason)}`);
      } catch (re) {
        log(`auth callout: failed to send deny response to ${c.id} (${reason}): ${re instanceof Error ? re.message : String(re)}`);
      }
    }
  }

  const start = (c: Callout) => {
    c.startedAt = performance.now();
    const task: Promise<void> = work(c)
      .catch((error: unknown) => {
        stopped = true;
        if (!workerFailed) {
          workerFailed = true;
          workerError = error;
        }
        rejectWorker(error);
      })
      .finally(() => {
        running.delete(task);
        drain();
      });
    running.add(task);
  };
  const drain = () => {
    while (!stopped && running.size < limits.maxInFlight && queue.length) {
      const c = queue.shift()!;
      if (!c.answered) start(c);
    }
  };

  // Awaiting one ledger or issuer must not consume every other client's broker auth deadline, and
  // a request the broker will have given up on must not take a slot or the CPU from one it has not.
  const pump = (async () => {
    for await (const msg of sub) {
      if (stopped) break;
      const arrivedAt = performance.now();
      const c = admit(msg, arrivedAt);
      if (!c) continue;
      const left = budgetMs - (performance.now() - arrivedAt);
      c.deadline = setTimeout(() => {
        const queued = queue.indexOf(c);
        if (queued >= 0) queue.splice(queued, 1);
        void refuse(c, "timeout", ` at=${c.phase}`);
      }, left);
      // While the oldest request still waiting for a slot has waited more than half the budget, the
      // queue is not draining in time, and a new request is refused at once instead of joining it.
      const waited = queue.length ? performance.now() - queue[0].queuedAt : 0;
      if (waited > budgetMs / 2) {
        void refuse(c, "shed", ` waited_ms=${Math.round(waited)} ahead=${running.size + queue.length}`);
        continue;
      }
      queue.push(c);
      drain();
    }
  })();
  // Requests admitted before the input ended are still answered: each finish starts the next queued.
  const done = Promise.race([pump, workerFailure]).finally(async () => {
    while (running.size) await Promise.all(running);
    stopped = true;
    if (workerFailed) throw workerError;
  });

  return { done };
}

/** The `iat` `encodeUser` stamped into a JWT this process just signed, read from its claims: the
 *  signature is ours, so verifying it again would only spend time. */
function signedIat(jwt: string): number {
  const { iat } = JSON.parse(Buffer.from(jwt.split(".")[1] ?? "", "base64url").toString("utf8")) as { iat?: unknown };
  if (typeof iat !== "number") throw new Error("callout: the minted user JWT carries no iat");
  return iat;
}

/** Fold a string to ASCII so the Latin1-limited auth-response encoder can always send it (a denied
 *  connect must get a legible signed refusal, never hang). Common Unicode punctuation maps to its ASCII
 *  stand-in; anything else outside 0x20–0x7E becomes "?". Used only for the human-readable deny reason. */
function asciiFold(s: string): string {
  return s
    .replace(/[‐-―]/g, "-") // hyphens/dashes incl. em-dash
    .replace(/[‘’‛]/g, "'") // single smart quotes
    .replace(/[“”‟]/g, '"') // double smart quotes
    .replace(/…/g, "...") // ellipsis
    .replace(/[^\x20-\x7E]/g, "?"); // any remaining non-ASCII-printable
}
