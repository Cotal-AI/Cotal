// The bearer and credential renewal of CotalEndpoint, as an internal component: fetch, prove, adopt
// and present the auth material, and swap the live connection onto it. Moved verbatim from endpoint.ts;
// the endpoint keeps the public methods and forwards to them. Not re-exported by the index.
import { randomUUID } from "node:crypto";
import type { NatsConnection } from "@nats-io/transport-node";
import { decodeBearerPrincipal, bearerExpiryMs, bearerRenewalDeadlineMs, bearerLifetimeMs, retryAfterMs, dialerFor, authOpts, probeConnect } from "./endpoint-dial.js";
import { MAX_TIMER_MS, type TransportState } from "./endpoint-options.js";
import { armRenewal, jitteredBackoffMs } from "./renewal.js";
import { credsClaims, credsFingerprint, credsRenewalDelayMs, idFromCreds } from "./identity.js";
import { withDeadline } from "./deadline.js";
import { requestSafeReconnect } from "./request-safe-reconnect.js";
import type { AgentCard } from "./types.js";

/** What the credentials component reads from its endpoint. State is read when it is used, never
 *  copied, a field it reassigns is written back through its setter, and every method is looked up on
 *  the endpoint at call time. */
export interface EndpointCredentialsDeps {
  nc: () => NatsConnection | undefined;
  bearerSource: () => (() => Promise<string>) | undefined;
  owner: () => string;
  actor: () => string;
  space: () => string;
  currentBearer: () => string | undefined;
  setCurrentBearer: (value: string | undefined) => void;
  bearerAdoptedAtMs: () => number;
  setBearerAdoptedAtMs: (value: number) => void;
  bearerRenewalFailures: () => number;
  setBearerRenewalFailures: (value: number) => void;
  cancelBearerRenewal: () => (() => void) | undefined;
  setCancelBearerRenewal: (value: (() => void) | undefined) => void;
  stopped: () => boolean;
  presentedExp: () => number | undefined;
  setPresentedExp: (value: number | undefined) => void;
  currentCreds: () => string | undefined;
  setCurrentCreds: (value: string | undefined) => void;
  credsSource: () => (() => Promise<string>) | undefined;
  connId: () => string;
  overlapOnConnectionRenewal: () => boolean;
  onConnection: () => ((nc: NatsConnection) => void) | undefined;
  servers: () => string;
  card: () => AgentCard;
  token: () => string | undefined;
  user: () => string | undefined;
  pass: () => string | undefined;
  userMode: () => boolean;
  sentinelCreds: () => string | undefined;
  tls: () => boolean;
  ownedConnections: () => Set<NatsConnection>;
  authExpiryReconnectTimer: () => NodeJS.Timeout | undefined;
  setAuthExpiryReconnectTimer: (value: NodeJS.Timeout | undefined) => void;
  credsTxnsRunning: () => number;
  setCredsTxnsRunning: (value: number) => void;
  credsTxn: () => Promise<unknown>;
  setCredsTxn: (value: Promise<unknown>) => void;
  reconnecting: () => boolean;
  reestablishing: () => boolean;
  requestsAwaitingReply: () => Map<NatsConnection, Set<(error: Error) => void>>;
  residentSwap: () => Promise<void> | undefined;
  setResidentSwap: (value: Promise<void> | undefined) => void;
  emitRecoverable: (err: Error) => void;
  kickBackoff: () => void;
  armCredsRefresh: (delayMs: number) => void;
  reconnect: () => Promise<void>;
  emit: (event: string, ...args: unknown[]) => boolean;
  on: (event: "transport", listener: (state: TransportState) => void) => void;
  off: (event: "transport", listener: (state: TransportState) => void) => void;
}

/** One endpoint's bearer and credential renewal: the checked getters every connect attempt presents,
 *  the timed and explicit prove-then-adopt transactions, and the controlled reconnect onto adopted
 *  material. Internal: `CotalEndpoint` keeps the fields and the public methods and forwards to it. */
export class EndpointCredentials {
  constructor(private readonly deps: EndpointCredentialsDeps) {}

  private get nc() { return this.deps.nc(); }
  private get bearerSource() { return this.deps.bearerSource(); }
  private get owner() { return this.deps.owner(); }
  private get actor() { return this.deps.actor(); }
  private get space() { return this.deps.space(); }
  private get currentBearer() { return this.deps.currentBearer(); }
  private set currentBearer(value: string | undefined) { this.deps.setCurrentBearer(value); }
  private get bearerAdoptedAtMs() { return this.deps.bearerAdoptedAtMs(); }
  private set bearerAdoptedAtMs(value: number) { this.deps.setBearerAdoptedAtMs(value); }
  private get bearerRenewalFailures() { return this.deps.bearerRenewalFailures(); }
  private set bearerRenewalFailures(value: number) { this.deps.setBearerRenewalFailures(value); }
  private get cancelBearerRenewal() { return this.deps.cancelBearerRenewal(); }
  private set cancelBearerRenewal(value: (() => void) | undefined) { this.deps.setCancelBearerRenewal(value); }
  private get stopped() { return this.deps.stopped(); }
  private get presentedExp() { return this.deps.presentedExp(); }
  private set presentedExp(value: number | undefined) { this.deps.setPresentedExp(value); }
  private get currentCreds() { return this.deps.currentCreds(); }
  private set currentCreds(value: string | undefined) { this.deps.setCurrentCreds(value); }
  private get credsSource() { return this.deps.credsSource(); }
  private get connId() { return this.deps.connId(); }
  private get overlapOnConnectionRenewal() { return this.deps.overlapOnConnectionRenewal(); }
  private get onConnection() { return this.deps.onConnection(); }
  private get servers() { return this.deps.servers(); }
  private get card() { return this.deps.card(); }
  private get token() { return this.deps.token(); }
  private get user() { return this.deps.user(); }
  private get pass() { return this.deps.pass(); }
  private get userMode() { return this.deps.userMode(); }
  private get sentinelCreds() { return this.deps.sentinelCreds(); }
  private get tls() { return this.deps.tls(); }
  private get ownedConnections() { return this.deps.ownedConnections(); }
  private get authExpiryReconnectTimer() { return this.deps.authExpiryReconnectTimer(); }
  private set authExpiryReconnectTimer(value: NodeJS.Timeout | undefined) { this.deps.setAuthExpiryReconnectTimer(value); }
  private get credsTxnsRunning() { return this.deps.credsTxnsRunning(); }
  private set credsTxnsRunning(value: number) { this.deps.setCredsTxnsRunning(value); }
  private get credsTxn() { return this.deps.credsTxn(); }
  private set credsTxn(value: Promise<unknown>) { this.deps.setCredsTxn(value); }
  private get reconnecting() { return this.deps.reconnecting(); }
  private get reestablishing() { return this.deps.reestablishing(); }
  private get requestsAwaitingReply() { return this.deps.requestsAwaitingReply(); }
  private get residentSwap() { return this.deps.residentSwap(); }
  private set residentSwap(value: Promise<void> | undefined) { this.deps.setResidentSwap(value); }
  private emitRecoverable(err: Error) { void this.deps.emitRecoverable(err); }
  private kickBackoff() { void this.deps.kickBackoff(); }
  private armCredsRefresh(delayMs: number) { void this.deps.armCredsRefresh(delayMs); }
  private reconnect() { return this.deps.reconnect(); }
  private emit(event: string, ...args: unknown[]) { return this.deps.emit(event, ...args); }
  private on(event: "transport", listener: (state: TransportState) => void) { void this.deps.on(event, listener); }
  private off(event: "transport", listener: (state: TransportState) => void) { void this.deps.off(event, listener); }

  /** The floor on a bearer renewal's delay. A token whose whole lifetime sits under it is renewed at
   *  this cadence (`expiry-renewal` mints 5s bearers). */
  private static readonly BEARER_MIN_RENEWAL_MS = 5_000;
  /** A failed bearer renewal retries after about this long, doubling per failure up to the cap. */
  private static readonly BEARER_RETRY_MS = 5_000;
  private static readonly BEARER_RETRY_CAP_MS = 60_000;

  /** Fetch a fresh bearer from the source, pin its principal to ours, arm the next renewal. On a
   *  fetch/principal failure: THROWS when `initial` (start() must fail loud before first connect);
   *  otherwise retries on a jittered, capped backoff, and warns once for the whole run of failures —
   *  the live connection keeps working until its current JWT expiry, so a dead auth service is
   *  loud without instantly dropping the mesh, and without a line per attempt. */
  async refreshBearer(initial = false): Promise<void> {
    try {
      const bearer = await this.bearerSource!();
      const claims = decodeBearerPrincipal(bearer);
      if (claims.owner !== this.owner || claims.actor !== this.actor)
        throw new Error(`bearer source returned principal ${claims.owner}.${claims.actor}, expected ${this.owner}.${this.actor}`);
      // Two refusals, answering different questions, and both of them are about protecting what is
      // ALREADY held. So both are scoped to there BEING something held, which is the same set as
      // `!initial` but names the thing the rules actually depend on: on the first fetch there is no
      // cache to lose, `start()` has to come up on whatever the source has, and the pre-dial guard
      // in {@link bindConnection} is what speaks for a dead first token.
      const expiryMs = bearerExpiryMs(bearer);
      const held = this.currentBearer;
      if (held !== undefined) {
        // ALREADY DEAD, whatever else is true of it. Advancement is deliberately not part of this
        // test: a candidate expiring at now-5s does advance a held one that died at now-60s, so an
        // advance-only rule adopts it - overwriting the cache with material nothing can dial,
        // skipping the recoverable warning because the fetch did not throw, and arming the next
        // read off a non-positive delay. The creds path draws its line on expiry alone too, in
        // {@link presentableCreds} (#1572).
        if (expiryMs <= Date.now())
          throw new Error("the bearer source returned a token that has already expired - nothing adopted");
        // THE SAME BYTES BACK AGAIN from a source whose token is already past its renewal window:
        // the renewal it arms is floored to 5s, and the next read returns that same token - a 5s
        // loop against the auth service for the rest of its life, with the retry backoff bypassed
        // because the fetch did not FAIL. It succeeded and returned nothing new (#1561).
        //
        // The test is byte identity, not expiry, and not advancement. `exp` carries one second of
        // resolution, so a key rotation re-signing the same claims under a new key - and a healthy
        // short-TTL source read twice inside one wall-clock second - both hand back a token whose
        // `exp` has not moved. That is genuinely re-issued material, which an advancement test
        // refuses and this one adopts. It is the question the creds path asks with
        // `credsFingerprint`: did the source re-issue ANYTHING (#1572).
        if (bearer === held && Date.now() >= bearerRenewalDeadlineMs(held, this.bearerAdoptedAtMs))
          throw new Error("the bearer source re-served the token already held and it cannot carry another cycle (the auth service has not issued a fresh one) - nothing adopted");
      }
      if (bearer !== held) this.bearerAdoptedAtMs = Date.now();
      this.currentBearer = bearer;
      this.bearerRenewalFailures = 0;
      // The renewal point is drawn from the middle of the token's lifetime, spaced from this
      // process's other renewals in the space: a fixed margin before `exp` kept every endpoint
      // issued in one second renewing, and rebinding through the callout, in one second for life.
      const { issuedAtMs, expiresAtMs } = bearerLifetimeMs(bearer, this.bearerAdoptedAtMs);
      this.armBearerTimer(armRenewal(this.space, issuedAtMs, expiresAtMs, () => void this.renewBearerOnTimer(), EndpointCredentials.BEARER_MIN_RENEWAL_MS));
    } catch (e) {
      if (initial) throw e;
      if (this.bearerRenewalFailures === 0)
        this.emitRecoverable(new Error(`bearer refresh failed (${e instanceof Error ? e.message : String(e)}) - retrying with backoff; this connection dies at its current token's expiry if the auth service stays down`));
      // A wait the source named is kept as named: never retried inside it, nor stretched by the backoff.
      const named = retryAfterMs(e);
      const delay = named > 0 ? named : jitteredBackoffMs(this.bearerRenewalFailures, EndpointCredentials.BEARER_RETRY_MS, EndpointCredentials.BEARER_RETRY_CAP_MS);
      this.bearerRenewalFailures++;
      const timer = setTimeout(() => void this.renewBearerOnTimer(), delay);
      timer.unref?.();
      this.armBearerTimer(() => clearTimeout(timer));
    }
  }

  private armBearerTimer(cancel: () => void): void {
    this.cancelBearerRenewal?.();
    this.cancelBearerRenewal = cancel;
    if (this.stopped) cancel();
  }

  /** The timed renewal. A new token moves the live connection onto itself at once, through the
   *  same controlled reconnect the creds path uses, so the broker never has to expire a connection
   *  this endpoint could renew. With no live connection, it ends the rebuild loop's wait instead:
   *  that loop refuses to dial an expired token and leaves the retries to this timer. */
  private async renewBearerOnTimer(): Promise<void> {
    const held = this.currentBearer;
    await this.refreshBearer();
    if (this.stopped || this.currentBearer === held) return;
    if (this.nc && !this.nc.isClosed()) await this.swapConnectionOntoFreshCreds();
    else this.kickBackoff();
  }

  /** The cached bearer, checked: every (re)connect attempt reads it, the reconnects nats.js runs
   *  on its own included, so none presents an expired token, which the callout could only deny
   *  after a full round trip. The bearer counterpart of {@link credsForWire}. */
  bearerForWire(): string {
    const bearer = this.currentBearer;
    if (bearer !== undefined && bearerExpiryMs(bearer) > Date.now()) return bearer;
    throw new Error(
      this.bearerSource
        ? "this endpoint's user bearer has expired and renewal through the auth exchange is failing - not presenting the expired token to the broker; retrying with backoff"
        : "this endpoint's user bearer has expired and it holds no bearer source to renew it - re-authenticate and rebuild the endpoint (construct it with a bearer FUNCTION for standing renewal)",
    );
  }

  /** How soon a FAILED creds refresh retries. Successful refreshes schedule by lifetime fraction
   *  (75% of iat→exp), not a fixed margin — standing creds span hours to days, bearers minutes. */
  private static readonly CREDS_RETRY_MS = 60_000;

  /** THE ONE PLACE a credential is cleared for presentation to a broker.
   *
   *  The property is unconditional — this endpoint never presents a credential it has already
   *  decoded as expired — so it is a property of the SUPPLY, not of any one dial site. It used to
   *  live inside {@link bindConnection}, which only `start()` and `doRebuild` reach; the
   *  authenticator nats.js re-evaluates on ITS OWN reconnects read the cache directly and so
   *  presented whatever was last fetched, expired included. Two such reconnects exist and neither
   *  passes through bindConnection: the one the broker forces at JWT `exp`, and an ALREADY RUNNING
   *  dial loop from an earlier drop that crosses `exp` while it retries (the pre-expiry
   *  reconnect fence flips a policy flag nats-core only reads when it observes a NEW drop, so it
   *  cannot stop a loop already in flight).
   *
   *  Putting the refusal here instead means a future caller cannot miss it: the only way to reach a
   *  dial is through {@link credsForWire}, and the one presentation that does not read the cache
   *  (the adoption preflight, which presents a fresh CANDIDATE) calls this same function on it.
   *
   *  An unbounded credential (no numeric `exp`) is presentable: bounded lifetimes are the renewal
   *  seam's concern, and a cred with no expiry has none to be past. */
  private static presentableCreds(creds: string, opts: { renewable: boolean }): string {
    const { exp } = credsClaims(creds); // throws on a structurally-unusable file (fail-loud)
    if (typeof exp === "number" && exp * 1000 <= Date.now())
      throw new Error(
        opts.renewable
          ? "this endpoint's creds have expired and renewal is failing - not presenting the expired credential to the broker; retrying with backoff"
          : "this endpoint's creds have expired and it holds no creds source to renew them - replace the credential and rebuild the endpoint (pass a creds FUNCTION for standing renewal)",
      );
    return creds;
  }

  /** The connect attempt's credential getters: what {@link credsForWire} and {@link bearerForWire}
   *  return, with its expiry recorded as {@link presentedExp}. */
  presentCreds(): string {
    const creds = this.credsForWire();
    this.presentedExp = credsClaims(creds).exp;
    return creds;
  }

  presentBearer(): string {
    const bearer = this.bearerForWire();
    this.presentedExp = bearerExpiryMs(bearer) / 1000;
    return bearer;
  }

  /** The cached credential, checked. Handed to nats.js as the authenticator's source on EVERY auth
   *  mode (renewed or static), so each (re)connect attempt — ours or the library's — re-reads a
   *  CHECKED value. A refusal throws out of the authenticator, which nats-core turns into a closed
   *  connection rather than a CONNECT carrying dead material; the endpoint's own supervisor then
   *  rebuilds on capped backoff, and {@link bindConnection} re-fetches from the source on each of
   *  those attempts, so a renewal that starts working recovers the endpoint without presenting
   *  anything expired in the meantime. Deliberately side-effect free: kicking the renewal timer
   *  from here would retry the source once per dial attempt, which is the flat load on a dead
   *  broker that {@link RETRY_BACKOFF_CAP_MS} exists to prevent. */
  private credsForWire(): string {
    if (!this.currentCreds)
      throw new Error(
        this.credsSource
          ? "this endpoint has no credential to present yet (the creds source has not returned one) - not dialing without auth material"
          : "this endpoint was constructed with an empty creds string - not dialing without auth material (an empty credential is not anonymous access)",
      );
    return EndpointCredentials.presentableCreds(this.currentCreds, { renewable: Boolean(this.credsSource) });
  }

  /** The credential this endpoint presents on its next connect, checked as {@link credsForWire}
   *  checks it. A second connection under the same identity reads it on every attempt, so it
   *  presents each credential this endpoint adopts and never an expired one. */
  wireCreds(): string {
    return this.credsForWire();
  }

  /** Refuses a fetched generation there is nothing to renew FROM, so the caller's failure posture
   *  ({@link CREDS_RETRY_MS}) applies instead of the renewal schedule (issue #1523).
   *
   *  A source that hands back the SAME generation past its own renewal point has not re-signed yet:
   *  that is a missed remint, not a candidate. Adopting it re-arms from a non-positive delay, which
   *  {@link armCredsRefresh} floors to 1s, which fetches again, which is the same generation — a 1s
   *  read loop against a store that is already having a bad day, for the JWT's remaining 25% of life,
   *  with the 60s backoff that exists for exactly this bypassed because the fetch did not FAIL.
   *
   *  The membership feed's rw-cred renewal already refuses it this way (`membership-feed.ts`,
   *  `adoptRwCreds`: "the rw source still holds the previous generation past its renewal point");
   *  this is the same rule on the endpoint's `delivery.creds` seam, so the two renewal paths answer
   *  a dead source identically.
   *
   *  An ALREADY-EXPIRED generation is refused whatever it is: the delay is non-positive for it too,
   *  but it is dead rather than merely due, so it is named separately and refused even when the
   *  source keeps returning a different one. */
  private static assertRenewableGeneration(candidate: string, current: string | undefined, delayMs: number): void {
    const { exp } = credsClaims(candidate);
    if (typeof exp === "number" && exp * 1000 <= Date.now())
      throw new Error("the creds source returned an already-expired credential (its `exp` is in the past) - nothing adopted; the renewal owner has not re-signed it, or the store is serving a stale generation");
    // Compared by GENERATION, not by envelope. `EndpointOptions.creds` takes opaque file content and
    // promises no canonical whitespace: `jwtFromCreds` pads with `\s*` and trims, so a store, editor or
    // filesystem round trip that adds a newline re-serves the SAME credential in bytes `===` calls
    // different - and the refusal would be skipped for the one case it exists to catch. The envelope
    // also carries the nkey seed, which is why `credsFingerprint` hashes the JWT instead.
    if (current !== undefined && credsFingerprint(candidate) === credsFingerprint(current) && delayMs <= 0)
      throw new Error("the creds source still holds the previous generation past its renewal point (the renewal owner has not re-signed it) - nothing adopted");
  }

  /** The disposable-preflight connect bound for the EXPLICIT reload proof (D5 class-2 adoption). A
   *  rogue or unreachable candidate must resolve well UNDER the manager's delivery-admin request
   *  bound, so this stays a few seconds and never blocks the responder. */
  private static readonly PREFLIGHT_MS = 4_000;

  /** How long the resident wire swap is deferred past the reply on the EXPLICIT reload path. The
   *  delivery-admin responder rides THIS connection, so `nc.reconnect()` must not run until the
   *  reply has flushed on the still-live old cred; the old cred stays valid until its exp, so a short
   *  deferral is safe. */
  private static readonly RESIDENT_SWAP_DEFER_MS = 250;

  /** How long a delivery-admin request read after a reload waits for the resident swap's reconnect.
   *  nats.js drops a publish made while the connection is down when it redials, so a reply sent
   *  during the swap is lost and its caller waits out its whole request timeout. Past this bound the
   *  request is answered anyway, as it was before the gate. */
  private static readonly RESIDENT_SWAP_GATE_MS = 5_000;

  /** The daemon-side deadline for the WHOLE prove-then-adopt transaction (source fetch + preflight +
   *  commit), kept strictly BELOW the manager's delivery-admin request bound so a slow or hung hosted
   *  store returns a structured component failure rather than an ambiguous client timeout, and a late
   *  fetch can never commit after the caller gave up. */
  private static readonly RELOAD_DEADLINE_MS = 12_000;

  /** Fetch fresh creds from the source, pin their identity to ours, cache them, and arm the next
   *  refresh at 75% of the new JWT's lifetime. THROWS on fetch/pin failure — the callers decide the
   *  failure posture (loud-and-retry for the timer, a structured error reply for an explicit
   *  {@link reloadCreds}). This is the PASSIVE-BACKSTOP fetch; the explicit auditable path
   *  ({@link reloadCreds}) does its own fetch so it can preflight the candidate on a disposable
   *  connection BEFORE mutating this live cache. */
  private async fetchFreshCreds(): Promise<{ iat?: number; exp?: number }> {
    const creds = await this.credsSource!();
    const id = idFromCreds(creds);
    if (id !== this.connId)
      throw new Error(`creds source returned identity ${id}, expected ${this.connId} - renewal may not swap the connection's nkey`);
    // Before the commit, so a refusal leaves the cache holding the last generation that was renewable
    // from (and, on the initial fetch, fails loud rather than dialling with dead material).
    const delay = credsRenewalDelayMs(creds);
    EndpointCredentials.assertRenewableGeneration(creds, this.currentCreds, delay);
    this.currentCreds = creds;
    this.armCredsRefresh(delay);
    const { iat, exp } = credsClaims(creds);
    return { iat, exp };
  }

  /** Swap the live connection onto the freshest cached cred or bearer with a controlled
   *  `nc.reconnect()` (nats.js re-evaluates the authenticator per attempt). Swapping now, instead of
   *  waiting for the broker to close the connection at `exp`, means the wire never carries a
   *  near-dead JWT and the operator never sees a spurious "authentication expired". After the
   *  reconnect succeeds, re-arm the expiry fence for the credential now authenticated on the wire. */
  private async swapConnectionOntoFreshCreds(): Promise<void> {
    const nc = this.nc;
    if (!(nc && !this.stopped)) return;
    const overlap = this.overlapOnConnectionRenewal && this.onConnection
      ? await this.openRenewalOverlap().catch(() => undefined)
      : undefined;
    try {
      // reconnect() resolves when the disconnect is requested, before subscriptions return.
      // A flush started now is sent after those subscriptions, so it resolves only once they
      // are on the broker. The overlap stays up until then.
      await nc.reconnect().catch(() => {});
      if (overlap && !nc.isClosed())
        await withDeadline(nc.flush(), 10_000, () => new Error("resident renewal flush did not finish")).catch(() => {});
      if (this.nc === nc && !this.stopped) this.armAuthExpiryReconnectFence(nc);
    } finally {
      if (overlap && !overlap.isClosed()) await this.closeWithoutLibraryReconnect(overlap).catch(() => {});
    }
  }

  /** A second connection whose `onConnection` subscriptions are flushed before the resident
   *  reconnect. Its inbox is not the resident connection's inbox. A flush that does not finish
   *  closes it and leaves the caller to reconnect in place. */
  private async openRenewalOverlap(): Promise<NatsConnection> {
    const overlap = await dialerFor(this.servers)({
      servers: this.servers,
      noAsyncTraces: true,
      name: `cotal:${this.card.name}:renewal`,
      inboxPrefix: `_INBOX_renew_${randomUUID()}`,
      maxReconnectAttempts: 0,
      ...authOpts({
        token: this.token, user: this.user, pass: this.pass,
        creds: this.currentCreds !== undefined || this.credsSource ? () => this.presentCreds() : undefined,
        bearer: this.userMode ? () => this.presentBearer() : undefined,
        sentinelCreds: this.sentinelCreds, tls: this.tls,
      }),
    });
    this.ownedConnections.add(overlap);
    try {
      this.onConnection?.(overlap);
      await withDeadline(overlap.flush(), 5_000, () => new Error("renewal overlap flush did not finish"));
      return overlap;
    } catch (error) {
      await this.closeWithoutLibraryReconnect(overlap).catch(() => {});
      throw error;
    }
  }

  /** nats-core keeps its reconnect switch on the protocol handler. This pinned internal shape is the
   *  same last-resort surface used by {@link closeFailedBind}; there is no public API for changing the
   *  reconnect policy of an existing connection. Disabling it does not disable Cotal self-heal: the
   *  `nc.closed()` supervisor below rebuilds the endpoint with freshly checked auth material. */
  disableLibraryReconnect(nc: NatsConnection): void {
    const protocol = (nc as unknown as { protocol?: { options?: { reconnect?: boolean } } }).protocol;
    if (protocol?.options) protocol.options.reconnect = false;
  }

  /** Close a connection whose library reconnect has already been disabled. `drain()` flushes with a
   *  PING and waits for the matching PONG; nats-core only rejects that waiter inside reconnect
   *  `prepare()`, so a half-open socket with reconnect=false leaves drain pending until the 2-minute
   *  ping interval times out. `close()` tears the transport down without that round-trip, which is
   *  the same public path {@link closeFailedBind} already uses when there is no graceful delivery
   *  contract left. */
  async closeWithoutLibraryReconnect(nc: NatsConnection | undefined): Promise<void> {
    if (!nc) return;
    this.disableLibraryReconnect(nc);
    await nc.close();
    if (!nc.isClosed()) throw new Error("endpoint connection closure is unproved; consumer custody must be retained");
    this.ownedConnections.delete(nc);
  }

  /** Disable nats-core reconnect shortly before the JWT authenticated on this wire expires. The small
   *  lead makes the policy change precede the broker's expiry close even when both timers wake in the
   *  same event-loop turn. A credential adoption does not move this fence until the resident reconnect
   *  is requested, so the old wire remains protected during the prove-then-adopt window. */
  armAuthExpiryReconnectFence(nc: NatsConnection): void {
    clearTimeout(this.authExpiryReconnectTimer);
    this.authExpiryReconnectTimer = undefined;
    const credsExp = this.currentCreds && credsClaims(this.currentCreds).exp;
    const expiryMs = this.userMode && this.currentBearer
      ? bearerExpiryMs(this.currentBearer)
      : typeof credsExp === "number"
        ? credsExp * 1000
        : undefined;
    if (expiryMs === undefined || this.stopped) return;
    // Node fires a delay above 2^31-1 ms (about 24.8 days) after 1 ms, which would disable reconnect
    // at once. A later expiry waits in steps of that bound, and the fence is armed again from there.
    const delay = Math.max(0, expiryMs - Date.now() - 500);
    this.authExpiryReconnectTimer = delay > MAX_TIMER_MS
      ? setTimeout(() => { if (this.nc === nc) this.armAuthExpiryReconnectFence(nc); }, MAX_TIMER_MS)
      : setTimeout(() => { if (this.nc === nc) this.disableLibraryReconnect(nc); }, delay);
    this.authExpiryReconnectTimer.unref?.();
  }

  /** The connectAndBind PRE-CONNECT fetch: pull the freshest source cred and pin it into
   *  {@link currentCreds} so the connect() that immediately follows presents it — that connect IS the
   *  proof, so NO preflight and NO live swap here. THROWS when `initial` (no cred to start from), else
   *  emits and retries. The LIVE-SWAP paths — the 75% timer {@link renewCredsOnTimer} and the explicit
   *  {@link reloadCreds} — preflight the candidate on a disposable connection instead, so they never
   *  reconnect the live connection onto an unproven cred. */
  async refreshCreds(initial = false): Promise<void> {
    try {
      await this.fetchFreshCreds();
    } catch (e) {
      if (initial) throw e;
      this.emitRecoverable(new Error(`creds refresh failed (${e instanceof Error ? e.message : String(e)}) - retrying; this connection dies at its current JWT's expiry if renewal keeps failing`));
      this.armCredsRefresh(EndpointCredentials.CREDS_RETRY_MS);
    }
  }

  private runCredsTxn<T>(fn: () => Promise<T>): Promise<T> {
    const counted = async (): Promise<T> => {
      this.credsTxnsRunning++;
      try { return await fn(); } finally { this.credsTxnsRunning--; }
    };
    const next = this.credsTxn.then(counted, counted);
    this.credsTxn = next.then(() => undefined, () => undefined);
    return next;
  }

  /** The one PROVE-then-adopt transaction shared by the 75% timer and the explicit reload (run under
   *  {@link runCredsTxn}). Fetch (deadline-bounded) → identity-pin → optional `expected` fingerprint →
   *  PREFLIGHT the candidate on a disposable connection → fence a late commit against the deadline →
   *  commit {@link currentCreds} → arm the next 75% timer. Because currentCreds is written ONLY after
   *  the preflight proves broker acceptance, the resident authenticator getter can never present an
   *  unproven cred (not even on an incidental reconnect), and a rejected candidate leaves the resident
   *  connection untouched on BOTH the timer and explicit paths. THROWS (structured) on any failure. */
  private async adoptFreshCreds(opts: { expected?: string; deadline?: number } = {}): Promise<{ iat?: number; exp?: number }> {
    // ABSOLUTE deadline, captured at the CALLER's entry (reloadCreds / renewCredsOnTimer) BEFORE the
    // single-flight enqueue, so the queue wait behind an in-flight transaction counts against it. A
    // reload queued behind a hung-store timer tick can never receive a FRESH budget and commit after
    // the renewal owner's request bound already elapsed.
    const deadline = opts.deadline ?? Date.now() + EndpointCredentials.RELOAD_DEADLINE_MS;
    // Fence BEFORE any source I/O: if the queue wait already burned the budget, fail structured now and
    // never touch the store, the preflight, or currentCreds.
    if (Date.now() > deadline)
      throw new Error("reloadCreds: the request deadline elapsed while queued behind another credential transaction; nothing adopted");
    const candidate = await withDeadline(this.credsSource!(), deadline - Date.now(), () => new Error("reloadCreds: the creds source did not return before the daemon deadline; nothing adopted"));
    const id = idFromCreds(candidate);
    if (id !== this.connId)
      throw new Error(`creds source returned identity ${id}, expected ${this.connId} - renewal may not swap the connection's nkey`);
    // Non-material message ON PURPOSE: this text flows to the manager's persisted
    // `RenewalRecord.adoption.error`, so neither the observed nor the expected digest may appear.
    if (opts.expected !== undefined && credsFingerprint(candidate) !== opts.expected)
      throw new Error("reloadCreds: re-read credential generation did not match the expected re-signed generation (a different store, or a torn/stale read); nothing adopted");
    // PREFLIGHT = the proof. A disposable connection presenting exactly the candidate BEFORE the live
    // cache is touched; a refused cred throws here, leaving the resident connection untouched.
    // The candidate goes through the SAME checkpoint the resident getter uses: this is the one
    // presentation that does not read the cache, so routing it here is what makes the refusal a
    // property of every path rather than of the cached one. An already-dead re-signed generation is
    // refused locally instead of spending a round trip to be told so, and — because this throws
    // BEFORE the commit below — it can never become the resident connection's next-presented cred.
    const proven = EndpointCredentials.presentableCreds(candidate, { renewable: true });
    const probe = await probeConnect(this.servers, { creds: proven, tls: this.tls, timeoutMs: Math.max(500, Math.min(EndpointCredentials.PREFLIGHT_MS, deadline - Date.now())) });
    if (!probe.ok)
      throw new Error(`reloadCreds: the broker did not accept the re-signed credential (${probe.reason}); nothing adopted`);
    if (Date.now() > deadline)
      throw new Error("reloadCreds: the proof exceeded the daemon deadline; nothing adopted"); // fence a late commit
    // Validate the bounded-window renewal delay BEFORE the commit: credsRenewalDelayMs throws on a cred
    // lacking a numeric `exp`, and that throw must not leave currentCreds flipped to a candidate the
    // authenticator would present on the next reconnect (a post-preflight validation failure is a no-op).
    const delay = credsRenewalDelayMs(candidate);
    EndpointCredentials.assertRenewableGeneration(candidate, this.currentCreds, delay);
    this.currentCreds = candidate;
    this.armCredsRefresh(delay);
    this.emit("creds-adopted", credsClaims(candidate));
    return credsClaims(candidate);
  }

  /** The 75%-of-lifetime renewal timer tick: prove + adopt + swap the LIVE connection. Preflights (it
   *  reconnects a live connection, so the candidate must be broker-proven first) and is serialized
   *  with the explicit reload. Never throws — a failed renewal logs and retries while the old cred
   *  stays live until its expiry. */
  async renewCredsOnTimer(): Promise<void> {
    // Deadline captured HERE, before the enqueue, for the same reason as the explicit reload.
    const deadline = Date.now() + EndpointCredentials.RELOAD_DEADLINE_MS;
    try {
      await this.runCredsTxn(() => this.adoptFreshCreds({ deadline }));
      await this.swapConnectionOntoFreshCreds();
    } catch (e) {
      this.emitRecoverable(new Error(`creds refresh failed (${e instanceof Error ? e.message : String(e)}) - retrying; this connection dies at its current JWT's expiry if renewal keeps failing`));
      this.armCredsRefresh(EndpointCredentials.CREDS_RETRY_MS);
    }
  }

  /** Fetch, broker-prove and adopt the source credential, then refresh the same connection
   * once outgoing mux and named-reply requests are quiet. A busy timeout retains the connection
   * and adopted credential. Call again to retry. This does not tear down endpoint bindings.
   * A dropped connection that is being re-established carries no request, so it redials now
   * instead of after its backoff; the rebuild re-fetches a stale credential from the source. */
  async refreshCredsRequestSafe(): Promise<void> {
    if (!this.credsSource) throw new Error("credential refresh requires a creds source");
    const nc = this.nc;
    if (!nc && !this.stopped && (this.reconnecting || this.reestablishing)) return await this.reconnect();
    if (!nc || this.stopped) throw new Error("credential refresh requires a running endpoint");
    const deadline = Date.now() + EndpointCredentials.RELOAD_DEADLINE_MS;
    await this.runCredsTxn(async () => {
      await this.adoptFreshCreds({ deadline });
      if (this.nc !== nc || this.stopped) throw new Error("endpoint connection changed during credential refresh");
      await requestSafeReconnect(nc, () => this.requestsAwaitingReply.get(nc)?.size ?? 0);
      if (this.nc === nc && !this.stopped) this.armAuthExpiryReconnectFence(nc);
    });
  }

  /** EXPLICIT credential reload — the auditable adoption step of D5 class-2 standing renewal (served
   *  to the renewal owner via the delivery-admin rail). The PROOF-OF-RECORD is a DISPOSABLE PREFLIGHT
   *  connection that presents exactly the candidate: it succeeds only when the BROKER accepts this
   *  re-signed generation, and it runs BEFORE the live cache is touched. So a cred the broker refuses
   *  throws HERE (structured), the resident connection — and the delivery-admin rail this very reply
   *  rides — is never disturbed, and "file re-signed" can never masquerade as "daemon adopted".
   *  `expected` is the renewal owner's generation token (SHA-256 of the JWT it re-signed): a re-read
   *  that does not match is rejected before the preflight even runs. On success the candidate becomes
   *  the resident connection's next-presented cred; the wire swap is NOT forced here — the caller
   *  ({@link handleDeliveryAdmin}) schedules it AFTER the aggregate reply, because the responder rides
   *  this connection and reconnecting before the reply flushes would strand it (see
   *  adoption-false-green.smoke.ts). Returns the BROKER-ACCEPTED generation's window (identity/iat/exp):
   *  the resident wire swap is best-effort and self-healing (the 75% timer + the broker's expiry-close),
   *  NOT witnessed, so the caller must claim broker acceptance, not verified resident reauth. NEVER a
   *  fingerprint. */
  async reloadCreds(expected?: string): Promise<{ identity: string; iat?: number; exp?: number }> {
    if (!this.credsSource)
      throw new Error("reloadCreds: this endpoint has no creds source (a static cred cannot be renewed in place)");
    // Capture the ABSOLUTE deadline at ENTRY, before enqueue, so a reload queued behind a hung-store
    // 75% timer tick is bounded by the SAME window (queue wait included) and cannot commit/swap after
    // the renewal owner's request bound has already elapsed and it recorded "no responder".
    const deadline = Date.now() + EndpointCredentials.RELOAD_DEADLINE_MS;
    // The prove-then-adopt transaction (fetch + preflight + commit) runs under the single-flight so it
    // cannot interleave with the 75% timer; the wire swap is scheduled by {@link handleDeliveryAdmin}
    // after the aggregate reply (the responder rides this connection).
    const { iat, exp } = await this.runCredsTxn(() => this.adoptFreshCreds({ expected, deadline }));
    return { identity: this.connId, iat, exp };
  }

  /** Arm the resident wire swap for the delivery-admin `reloadCreds` path. Called by
   *  {@link handleDeliveryAdmin} ONLY after BOTH component proofs have settled and immediately before
   *  the reply is returned+responded — never from inside {@link reloadCreds} while the aggregate is
   *  still open, or a slow co-component proof would let `nc.reconnect()` reconnect the admin rail
   *  before the reply flushes and silently strand it. The short deferral lets the reply flush on the
   *  still-live old cred first. Best-effort — the proof was the preflight; a transient swap failure is
   *  retried by the 75% timer and the broker's own expiry-close, both presenting the adopted candidate.
   *  Until the swapped connection is back, {@link residentSwap} holds the delivery-admin requests that
   *  arrive after this reply. */
  scheduleResidentSwap(): void {
    if (this.stopped) return;
    const swap: Promise<void> = new Promise<void>((resolve) => { setTimeout(resolve, EndpointCredentials.RESIDENT_SWAP_DEFER_MS).unref?.(); })
      .then(async () => {
        const back = this.transportBack(EndpointCredentials.RESIDENT_SWAP_GATE_MS);
        await this.swapConnectionOntoFreshCreds();
        await back;
      })
      .finally(() => { if (this.residentSwap === swap) this.residentSwap = undefined; });
    this.residentSwap = swap;
  }

  /** Resolve when this endpoint reports its transport connected again, or after `ms`. */
  private transportBack(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const done = () => { clearTimeout(timer); this.off("transport", seen); resolve(); };
      const seen = (state: TransportState) => { if (state.connected) done(); };
      const timer = setTimeout(done, ms);
      timer.unref?.();
      this.on("transport", seen);
    });
  }
}
