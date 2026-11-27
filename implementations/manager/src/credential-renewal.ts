import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { accountFromCreds, credsClaims, credsRenewalDelayMs, DEFAULT_SERVER, divergentSecretStoreNotice, EpEnvelopeError, inspectCredHealth, mintCreds, parseDaemonStoreAnswer, parseSecretStoreIdentity, rejectionText, REMOTE_MANAGER_IDENTITY_NAMES, requestSafeReconnect, sameSecretStoreIdentity, serveIssuanceGateKv, STANDING_RENEWABLE_TTL_SEC, type ControlReply, type CredHealth, type DaemonStoreAnswer, type DeliveryLeaseInfo, type EpServeHandle, type SecretStoreIdentity } from "@cotal-ai/core";
import { agentSecretKeyForFile, DAEMON_ENDPOINT_BOOTSTRAPS, DELIVERY_CREDS_KIND, getSpaceAuth, MEMBERSHIP_RW_CREDS_KIND, readDaemonEndpointInstanceId, remintDaemonCreds, renewDaemonEndpoint, spaceMaterialKey, SYSTEM_CREDS_FILES, writeRenewalRecord, type RemintResult, type RenewalRecord } from "@cotal-ai/workspace";
import type { KV } from "@nats-io/kv";
import { credsAuthenticator, RequestError, type NatsConnection } from "@nats-io/transport-node";
import { isUnansweredDeliveryAdmin, untilDeliveryAdminAnswers } from "./endpoint-evict.js";
import { STATIC_RECONCILE_RETRY_DELAYS_MS } from "./managed-static-lifecycle.js";
import { MANAGER_ENDPOINT } from "./manager-service-contract.js";
import { withTimeout } from "./manager-timeout.js";
import type { Manager } from "./manager.js";
import type { ManagerConfig } from "./manager-config.js";
import type { ManagerStartState } from "./manager-start-state.js";
import type { ManagerParts } from "./manager-parts.js";

/** The delivery-admin `reloadCreds` request bound — STRICTLY GREATER than the daemon's internal
 * per-component preflight bound (4s each, run in parallel) so a slow or refused proof returns the
 * daemon's STRUCTURED per-component failure, never a client-side timeout that the catch below would
 * misrecord as "no delivery-admin responder" (a false negative while the daemon is mid-proof). */
const DELIVERY_ADMIN_RELOAD_TIMEOUT_MS = 15_000;

/** Pick a `setInterval` period for {@link Manager.renewDaemonCreds} that guarantees at least one
 * tick lands inside every renewal owner's `[renewAt, exp)` window.
 *
 * `inspectCredHealth` marks a credential `near-expiry` at 75% of its iat-to-exp lifetime and
 * `expired` at 100%, so the window width is TTL/4. Ticks TTL/4 apart therefore land at least once
 * inside every window; ticks TTL/2 apart (the old schedule) can miss it entirely for any TTL. That
 * is the cause of Cotal #457, reproduced at both TTL=86400 and TTL=20 (the compressed-ratio probe).
 *
 * Deriving from the caller's TTL keeps the schedule correct for any credential class: the 24h
 * `STANDING_RENEWABLE_TTL_SEC` and the 30-day `ROTATION_RENEWED_TTL_SEC` both get a tick inside
 * their own renewal window without a hardcoded number. Post-boot responsiveness is already
 * covered by the caller invoking `renewDaemonCreds` once synchronously before starting the timer,
 * so no separate floor is needed. The pass is idempotent, since `renewDaemonCreds` no-ops each
 * credential when its state is `healthy`, so a tick that lands before the window costs one health
 * check per owner. A managed seat's credential is judged as of the next tick instead, because the
 * seat re-reads its file only once a minute and nothing pushes the renewal to it: a tick that
 * lands in the window's last minute can come too late for the seat to adopt it. */
export function credRenewIntervalMs(ttlSeconds: number): number {
  return Math.max(1, Math.floor((ttlSeconds / 4) * 1000));
}

export const REMOTE_STANDING_BUDGET_MS = 10_000;

/** One absolute budget across authority, preflight and adoption waits, or one closed-serve attempt. */
export function remoteStandingTimeLeft(deadline: number): number {
  const left = deadline - performance.now();
  if (left <= 0) throw new Error("remote manager standing operation exceeded its 10000ms aggregate budget");
  return Math.ceil(left);
}

export function sameStrings(a: readonly string[] | undefined, b: readonly string[] | undefined): boolean {
  return JSON.stringify([...(a ?? [])].sort()) === JSON.stringify([...(b ?? [])].sort());
}

/** True only when the delivery-admin rail has no bound responder. A timeout is a hung rail, not absence. */
function isAbsentDeliveryAdmin(error: unknown): boolean {
  return error instanceof RequestError && error.isNoResponders();
}

/** The store challenge went UNANSWERED while a delivery daemon exists: the rail timed out, or it had
 *  no responder while the lease row names a holder. Both are what a daemon that is starting or
 *  re-acquiring its lease looks like, so manager boot waits them out (#871); a renewal pass still
 *  refuses on the first one. A reply that does not decode was answered and is never this. */
class DeliveryAdminUnanswered extends Error {}

/** How long one store challenge waits for the delivery daemon's answer. */
const STORE_CHALLENGE_TIMEOUT_MS = 5_000;

/** What {@link CredentialRenewal} reads from and writes to the Manager. Every entry is read at
 *  use, so a field the Manager or a test assigns is always current, and a Manager method a test
 *  replaces is the one that runs. */
export interface CredentialRenewalDeps {
  agents: () => Manager["agents"];
  ep: () => Manager["ep"];
  leaseStopping: () => Manager["leaseStopping"];
  runHosting: () => Manager["runHosting"];
  deliveryShard: () => (typeof Manager)["DELIVERY_SHARD"];
  beginLifecycle: (...args: Parameters<Manager["beginLifecycle"]>) => ReturnType<Manager["beginLifecycle"]>;
  dialRemoteStanding: (...args: Parameters<Manager["dialRemoteStanding"]>) => ReturnType<Manager["dialRemoteStanding"]>;
  dialServeConnection: (...args: Parameters<Manager["dialServeConnection"]>) => ReturnType<Manager["dialServeConnection"]>;
  mintAndStageGoalWriter: (...args: Parameters<Manager["mintAndStageGoalWriter"]>) => ReturnType<Manager["mintAndStageGoalWriter"]>;
  mintAndStageSessionLedger: (...args: Parameters<Manager["mintAndStageSessionLedger"]>) => ReturnType<Manager["mintAndStageSessionLedger"]>;
  probeStaticCredential: (...args: Parameters<Manager["probeStaticCredential"]>) => ReturnType<Manager["probeStaticCredential"]>;
  renewManagedStaticCred: (...args: Parameters<Manager["renewManagedStaticCred"]>) => ReturnType<Manager["renewManagedStaticCred"]>;
  withEndpointServeExecutor: <T>(fn: (kvs: { recordsKv: KV; authKv: KV; nc: NatsConnection }) => Promise<T>) => Promise<T>;
  renewRemoteStandingBundle: (...args: Parameters<Manager["renewRemoteStandingBundle"]>) => ReturnType<Manager["renewRemoteStandingBundle"]>;
}

/** Builds the {@link CredentialRenewalDeps} for a Manager. It reads Manager members by name at each use, so a
 *  field the Manager assigns later is current and a member a test replaces on the instance is the one that runs. */
export function credentialRenewalDeps(m: Manager): CredentialRenewalDeps {
  return {
    agents: () => m["agents"],
    ep: () => m["ep"],
    leaseStopping: () => m["leaseStopping"],
    runHosting: () => m["runHosting"],
    deliveryShard: () => (m.constructor as typeof Manager).DELIVERY_SHARD,
    beginLifecycle: (...args) => m["beginLifecycle"](...args),
    dialRemoteStanding: (...args) => m["dialRemoteStanding"](...args),
    dialServeConnection: (...args) => m["dialServeConnection"](...args),
    mintAndStageGoalWriter: (...args) => m["mintAndStageGoalWriter"](...args),
    mintAndStageSessionLedger: (...args) => m["mintAndStageSessionLedger"](...args),
    probeStaticCredential: (...args) => m["probeStaticCredential"](...args),
    renewManagedStaticCred: (...args) => m["renewManagedStaticCred"](...args),
    withEndpointServeExecutor: (fn) => m["withEndpointServeExecutor"](fn),
    renewRemoteStandingBundle: (...args) => m["renewRemoteStandingBundle"](...args),
  };
}

/** Renewal of the manager's own standing credentials: the delivery daemon's reload, the remote
 *  standing bundle, and the pushes of renewed credentials to the live connections. */
export class CredentialRenewal {
  constructor(private readonly config: Readonly<ManagerConfig>, private readonly deps: CredentialRenewalDeps, private readonly parts: Pick<ManagerParts, "brokerTransport" | "goalWriter" | "servePlane">, private readonly state: ManagerStartState) {}

  /** Named identity of {@link ManagerConfig.secrets}: the same coordinate the delivery daemon must reload from.
   *  Set at construction for an injected store; the workspace store is named on first challenge. */
  secretStoreIdentity?: SecretStoreIdentity;
  /** #2073: the `endpoint-serve` credential's OWN renewal, armed from its `[renewAt, exp)` window
   *  (`credsRenewalDelayMs`) rather than left to `credRenewTimer`'s boot-phased TTL/4 tick, which can
   *  miss the window by ordering. Re-armed at registration and after every successful re-mint;
   *  cleared in `stop()` beside `credRenewTimer`. */
  endpointServeRenewalTimer?: ReturnType<typeof setTimeout>;
  /** #1634: does THIS manager own the delivery daemon's credential renewal? True only while the
   *  daemon reloads from this manager's store AND this manager holds the per-space renewal lease.
   *  Starts false: a manager that has not proved both must not remint. */
  daemonRenewalOwner: boolean = false;
  /** #2561: may the lease heartbeat contend at all? Set by every claim, false while the daemon names
   *  another store or the challenge refused. Without it the heartbeat re-takes the lease the claim
   *  just released and holds it against every manager and `doctor auth --fix` that can remint. */
  daemonRenewalEligible: boolean = false;
  remoteExecutorCreds?: string;
  remoteSupervisorCreds?: string;
  remoteBundleRenewal?: Promise<void>;
  remoteBundleAdoption?: Promise<void>;
  finishRemoteBundleAdoption?: () => void;
  /** A refused or failed standing candidate is cleanup debt, never a silent loss: the last-good
   * family stays live and this records what the host may have signed but the manager never adopted. */
  remoteRenewalDebt?: { at: number; processEpoch: number; reason: string; unadoptedSubjects: string[] };
  private credentialPushRetry?: ReturnType<typeof setTimeout>;
  private remoteStandingRetry?: ReturnType<typeof setTimeout>;
  readonly credentialPushes: Map<NatsConnection, Promise<void>> = new Map<NatsConnection, Promise<void>>();
  supervisorCredentialPush?: Promise<void>;
  readonly pendingCredentialPushes: Set<NatsConnection> = new Set<NatsConnection>();
  supervisorCredentialPushPending: boolean = false;

  // The Manager members these bodies use, under their Manager names. Each reads or writes through
  // its dep at use.
  private get agents() { return this.deps.agents(); }
  private get auth() { return this.state.auth; }
  private get ep() { return this.deps.ep(); }
  private get leaseStopping() { return this.deps.leaseStopping(); }
  private get managerInstanceId() { return this.state.managerInstanceId!; }
  private get remoteAuthority() { return this.config.remoteAuthority; }
  private get runHosting() { return this.deps.runHosting(); }
  private get userMode() { return this.state.userMode; }
  private beginLifecycle(...args: Parameters<Manager["beginLifecycle"]>): ReturnType<Manager["beginLifecycle"]> { return this.deps.beginLifecycle(...args); }
  private dialRemoteStanding(...args: Parameters<Manager["dialRemoteStanding"]>): ReturnType<Manager["dialRemoteStanding"]> { return this.deps.dialRemoteStanding(...args); }
  private dialServeConnection(...args: Parameters<Manager["dialServeConnection"]>): ReturnType<Manager["dialServeConnection"]> { return this.deps.dialServeConnection(...args); }
  private mintAndStageGoalWriter(...args: Parameters<Manager["mintAndStageGoalWriter"]>): ReturnType<Manager["mintAndStageGoalWriter"]> { return this.deps.mintAndStageGoalWriter(...args); }
  private mintAndStageSessionLedger(...args: Parameters<Manager["mintAndStageSessionLedger"]>): ReturnType<Manager["mintAndStageSessionLedger"]> { return this.deps.mintAndStageSessionLedger(...args); }
  private probeStaticCredential(...args: Parameters<Manager["probeStaticCredential"]>): ReturnType<Manager["probeStaticCredential"]> { return this.deps.probeStaticCredential(...args); }
  renewManagedStaticCred(...args: Parameters<Manager["renewManagedStaticCred"]>): ReturnType<Manager["renewManagedStaticCred"]> { return this.deps.renewManagedStaticCred(...args); }
  private withEndpointServeExecutor<T>(fn: (kvs: { recordsKv: KV; authKv: KV; nc: NatsConnection }) => Promise<T>): Promise<T> { return this.deps.withEndpointServeExecutor(fn); }

  /** Proof that this manager remints into the store the delivery daemon reloads from.
   *  Fingerprint-only `reloadCreds` is safe only after this. Two named, different stores
   *  refuse the pass. A daemon that is not bound yet is not a named store: start and
   *  remint still proceed (tests, delayed delivery), writing this manager's store. The
   *  challenge runs again before every remint, so a later daemon on a foreign store is
   *  refused then rather than certified by an earlier absence. A request timeout is not
   *  absence: a hung rail would skip the proof, so it fails closed.
   *
   *  ABSENCE IS READ OFF THE LEASE ROW, never off the rail's no-responder shape alone (#1694).
   *  The rail is queue-grouped, so "no responder answered" is itself something the rail reports,
   *  and a responder that answers in a shape the client turns into that error makes the pass read
   *  "absent" while a holder is live on the row — certifying every later remint with no proof at
   *  all. So a no-responder outcome is decided by the row: a row that names a holder makes the
   *  pass refuse (undetermined — a live daemon went unanswered, which must not read as "no
   *  daemon"), and only a row that is absent or holderless settles "absent", the state start()
   *  treats as not-yet-bound. An unreadable row (a failed read, or a key that exists but does not
   *  parse) is a genuine unknown and refuses fail-closed, like a hung rail. */
  private async daemonStoreRelation(timeoutMs: number): Promise<"shared" | "absent" | "divergent"> {
    let reply: ControlReply;
    try {
      reply = await this.ep.requestDeliveryAdmin("reloadStoreIdentity", {}, timeoutMs);
    } catch (e) {
      const msg = rejectionText(e);
      if (isAbsentDeliveryAdmin(e)) return this.absentByLeaseRow(isUnansweredDeliveryAdmin(e));
      const failure = `could not challenge the delivery daemon's SecretStore: ${msg}`;
      throw isUnansweredDeliveryAdmin(e) ? new DeliveryAdminUnanswered(failure) : new Error(failure);
    }
    if (!reply.ok)
      throw new Error(
        reply.error ?? "delivery daemon refused to name the SecretStore it reloads from",
      );
    let answer: DaemonStoreAnswer;
    try {
      answer = parseDaemonStoreAnswer(reply.data);
    } catch (e) {
      throw new Error(
        `delivery daemon named an unreadable SecretStore: ${rejectionText(e)}. Nothing reminted. ` +
          `Check that delivery and manager use the same Cotal version, then restart delivery through its supervisor. ` +
          `For a saved local delivery service: \`cotal down delivery --space ${this.config.space}\`, ` +
          `then \`cotal up --space ${this.config.space}\``,
      );
    }
    // The answerer's own claim first, so an honest non-holder is refused by its own admission and
    // the operator-facing reason names that. This is the CHEAP half of the test and NOT the binding
    // one: a responder that does not hold the lease can assert `true` here just as easily.
    if (!answer.holdsDeliveryLease)
      throw new Error(
        "the delivery-admin rail was answered by a responder that does not hold this space's " +
          "delivery lease, so its SecretStore is not the store the daemon reloads from - nothing reminted",
      );
    // THE BINDING TEST, measured by this manager rather than asserted by the answerer. The lease
    // row's holder is read here under this manager's own credential; the answerer must BE that
    // principal. A reply asserting the claim while some other process holds the shard fails here,
    // which is the case a bare store identity could not see. An unreadable row is an unknown and
    // refuses too: this test may never be satisfied by failing to run.
    const holder = await this.ep.deliveryLeaseHolder(this.deps.deliveryShard());
    if (holder === undefined)
      throw new Error(
        "this manager could not read the delivery lease row, so it cannot verify that the answering " +
          "responder is the process that reloads the standing credentials - nothing reminted",
      );
    if (holder !== answer.responder)
      throw new Error(
        `the delivery-admin rail was answered by ${answer.responder}, which is not the holder of ` +
          `this space's delivery lease (${holder}), so its SecretStore is not the store the daemon ` +
          `reloads from - nothing reminted`,
      );
    const daemon = answer.identity;
    // The workspace store records its id the first time it is named, so it is named here, where
    // only an auth manager reaches, rather than in a constructor every open-mode manager runs.
    this.secretStoreIdentity ??= parseSecretStoreIdentity(this.config.secrets.identity);
    if (!sameSecretStoreIdentity(this.secretStoreIdentity, daemon)) {
      console.error(`! ${divergentSecretStoreNotice(this.secretStoreIdentity, daemon)}`);
      return "divergent";
    }
    return "shared";
  }

  /** Settle a no-responder challenge outcome from the lease row, never from the rail's own
   *  reporting shape (#1694). The three cases:
   *
   *  1. The row READS but names a holder: a live daemon holds the shard and the rail went
   *     unanswered. That is undetermined, not "no daemon" — treating it as absent would let this
   *     manager remint with no proof while a reloading daemon runs, which is exactly what the
   *     challenge exists to prevent. Refuse.
   *  2. The row is unreadable — a read that fails (a denied or erroring bucket) OR a key that
   *     exists but does not parse as a lease record (`readDeliveryLeaseEntry` throws for both):
   *     undetermined, and it refuses the same fail-closed way a hung rail does. Never a silent
   *     "absent" over a row the manager could not read.
   *  3. The row is absent or holderless (no key, a DEL/PURGE tombstone, or a row that names no
   *     holder): today's "absent", the state start() treats as a daemon that is not bound yet.
   *
   *  `deliveryLeaseHolder` swallows its read failures into `undefined`, which would fold case 2
   *  into case 3 — so this reads the entry directly and lets the read's own failure refuse. */
  async absentByLeaseRow(unanswered: boolean): Promise<"absent"> {
    let entry: { info: DeliveryLeaseInfo } | undefined;
    try {
      entry = await this.ep.readDeliveryLeaseEntry(this.deps.deliveryShard());
    } catch (e) {
      throw new Error(
        `could not read the delivery lease row to settle whether the delivery daemon is absent ` +
          `(${rejectionText(e)}) - absence is undetermined, nothing reminted`,
      );
    }
    const holder = entry?.info.holder;
    if (holder !== undefined && holder !== "") {
      const refusal =
        `the delivery-admin rail reported no responder while the delivery lease names a holder ` +
        `(${holder}) - absence cannot be read off the rail alone, and nothing reminted`;
      throw unanswered ? new DeliveryAdminUnanswered(refusal) : new Error(refusal);
    }
    return "absent";
  }

  /** Keep this manager's renewal lease alive between credential passes (#1634). The manager bucket
   *  expires keys at MANAGER_LEASE_TTL_MS, far below the credential pass's cadence, so the lease
   *  needs its own heartbeat like the per-instance liveness lease. A non-owner calls this too: the
   *  CAS is how a survivor picks up a dead owner's expired lease with no operator step. Never
   *  throws; a failed heartbeat leaves ownership to the next pass rather than ending the process. */
  async keepDaemonRenewalLease(): Promise<void> {
    if (!this.auth || !this.daemonRenewalEligible) return;
    try {
      const held = await this.ep.holdDaemonRenewalLease(this.managerInstanceId);
      if (this.daemonRenewalOwner && !held)
        console.error(`! daemon credential renewal for space "${this.config.space}" passed to another manager (this one lost the renewal lease) - it keeps serving its seats`);
      this.daemonRenewalOwner = held;
    } catch (e) {
      console.error(`! could not refresh the daemon renewal lease: ${rejectionText(e)} - ownership is re-decided on the next pass`);
    }
  }

  /** Decide whether THIS manager owns the daemon's credential renewal (#1634). Both conditions are
   *  required, because each answers a question the other cannot:
   *
   *  1. The daemon must reload from this manager's store (#1447). Reminting into a store the daemon
   *     never reads writes bytes nobody adopts, and fingerprint-only `reloadCreds` would then name a
   *     generation the daemon cannot see.
   *  2. This manager must hold the per-space renewal lease. Store identity CANNOT pick one owner on
   *     its own: `sameSecretStoreIdentity` is pure equality with no holder and no tiebreak, so every
   *     manager sharing one store passes it, and two owners reminting on independent timers have no
   *     ordering between them - one's write lands between the other's re-sign and its adoption
   *     request, which is the #773 refusal the challenge exists to prevent.
   *
   *  A manager failing either test serves the space normally and skips only the daemon remint. */
  async claimDaemonRenewalOwnership(waitMs = 0): Promise<void> {
    // EVERY refusal outcome drops a held lease, not only "divergent". The refusal paths THROW
    // (#1694: a non-holder answer, an unbindable answerer, an unreadable or holder-naming row on a
    // no-responder rail), and a thrown refusal caught by renewDaemonCreds would otherwise leave a
    // manager that once owned the renewal still holding the lease behind its own heartbeat — the
    // pass refuses, the log says so, and the space keeps a renewal owner that must not remint.
    // Deciding here, inside the claim, is what keeps the release on the refusal path itself.
    let relation: "shared" | "absent" | "divergent";
    try {
      // Only the read-only challenge is retried, so a wait that ends mid-attempt abandons a read,
      // never the lease work below.
      relation = await untilDeliveryAdminAnswers(
        waitMs,
        (requestMs) => this.daemonStoreRelation(requestMs(STORE_CHALLENGE_TIMEOUT_MS)),
        (reason, delayMs) => console.error(`! delivery-admin rail did not answer the store challenge (${reason}); retrying in ${delayMs / 1000}s`),
        (e) => e instanceof DeliveryAdminUnanswered,
      );
    } catch (e) {
      this.daemonRenewalEligible = false;
      if (this.daemonRenewalOwner) await this.ep.releaseDaemonRenewalLease().catch(() => {});
      this.daemonRenewalOwner = false;
      throw e;
    }
    this.daemonRenewalEligible = relation !== "divergent";
    if (relation === "divergent") {
      // Not our daemon's store: drop any lease we hold rather than sit on it, so the manager that
      // CAN remint is not blocked behind us.
      if (this.daemonRenewalOwner) await this.ep.releaseDaemonRenewalLease();
      this.daemonRenewalOwner = false;
      return;
    }
    await this.keepDaemonRenewalLease();
  }

  /** #2073: arm the `endpoint-serve` credential's own renewal from its `[renewAt, exp)` window
   *  instead of `credRenewTimer`'s boot-phased TTL/4 tick, which can miss that window depending on
   *  when the timer happened to start relative to the credential's `iat`. Called after the initial
   *  mint (`registerManagerService`) and after every successful re-mint in the serve branch below,
   *  so the schedule always tracks the CURRENT credential. `credsRenewalDelayMs` is the same 75%
   *  convention the endpoint's delivery renewal and the membership feed use (`@cotal-ai/core`); no
   *  second copy of that arithmetic lives here. */
  scheduleServeRenewal(creds: string): void {
    if (this.endpointServeRenewalTimer) clearTimeout(this.endpointServeRenewalTimer);
    const delay = Math.max(1_000, credsRenewalDelayMs(creds));
    const renewAt = new Date(Date.now() + delay).toISOString();
    this.endpointServeRenewalTimer = setTimeout(() => { void this.renewDaemonCreds(); }, delay);
    this.endpointServeRenewalTimer.unref?.();
    console.error(`manager endpoint-serve renewal scheduled at ${renewAt}`);
  }

  private scheduleCredentialPushRetry(): void {
    if (this.credentialPushRetry || this.leaseStopping) return;
    this.credentialPushRetry = setTimeout(() => {
      this.credentialPushRetry = undefined;
      if (this.leaseStopping) return;
      void Promise.all([
        ...[...this.pendingCredentialPushes].map((nc) => this.pushRenewedCreds(nc)),
        ...(this.supervisorCredentialPushPending ? [this.pushSupervisorCreds()] : []),
      ]);
    }, 1_000);
    this.credentialPushRetry.unref();
  }

  stopRetries(): void {
    clearTimeout(this.credentialPushRetry);
    this.credentialPushRetry = undefined;
    clearTimeout(this.remoteStandingRetry);
    this.remoteStandingRetry = undefined;
  }

  private scheduleRemoteStandingRetry(): void {
    if (this.remoteStandingRetry || this.leaseStopping) return;
    this.remoteStandingRetry = setTimeout(() => {
      this.remoteStandingRetry = undefined;
      const release = this.beginLifecycle();
      if (!release) return;
      void this.deps.renewRemoteStandingBundle().catch((error) => {
        console.error(`! remote manager renewal pass failed: ${rejectionText(error)}`);
      }).finally(release);
    }, 2_000);
    this.remoteStandingRetry.unref();
  }

  /** Retain a busy transport and retry its adopted credential without replaying requests. */
  private pushRenewedCreds(nc: NatsConnection): Promise<void> {
    const active = this.credentialPushes.get(nc);
    if (active) return active;
    const push = this.pushRenewedCredsOnce(nc).finally(() => { this.credentialPushes.delete(nc); });
    this.credentialPushes.set(nc, push);
    return push;
  }

  private async pushRenewedCredsOnce(nc: NatsConnection): Promise<void> {
    this.pendingCredentialPushes.add(nc);
    try {
      await requestSafeReconnect(nc);
      this.pendingCredentialPushes.delete(nc);
    } catch (e) {
      if (nc.isClosed()) this.pendingCredentialPushes.delete(nc);
      console.error(`! manager credential push deferred: ${rejectionText(e)}`);
      if (!nc.isClosed()) this.scheduleCredentialPushRetry();
    }
  }

  private pushSupervisorCreds(): Promise<void> {
    if (this.supervisorCredentialPush) return this.supervisorCredentialPush;
    const push = this.pushSupervisorCredsOnce().finally(() => { this.supervisorCredentialPush = undefined; });
    this.supervisorCredentialPush = push;
    return push;
  }

  private async pushSupervisorCredsOnce(): Promise<void> {
    this.supervisorCredentialPushPending = true;
    try {
      await this.ep.refreshCredsRequestSafe();
      this.supervisorCredentialPushPending = false;
    } catch (e) {
      console.error(`! remote manager supervisor credential push deferred: ${rejectionText(e)}`);
      this.scheduleCredentialPushRetry();
    }
  }

  /** #2073: the shared bounded-retry shape for a closed standing connection: wait out each of
   *  {@link STATIC_RECONCILE_RETRY_DELAYS_MS}, trying `attempt` after each. Waiting does not repair
   *  two closes, so they skip the first delay. One that closes while an all-duty renewal is in flight,
   *  as one the broker expires just before adoption, tries when that renewal adopts. One whose
   *  credential has `expired` tries at once, because its attempt renews the credential. A stop landing
   *  while this loop waits is not a fault this loop reports (the caller re-checks `leaseStopping`). */
  async boundedReconnect(label: string, attempt: () => Promise<boolean>, expired = false): Promise<boolean> {
    let first = this.remoteBundleAdoption ?? (expired ? Promise.resolve() : undefined);
    for (const delayMs of STATIC_RECONCILE_RETRY_DELAYS_MS) {
      await (first ?? new Promise((r) => setTimeout(r, delayMs)));
      first = undefined;
      if (this.leaseStopping) return true;
      try {
        if (await attempt()) return true;
      } catch (e) {
        console.error(`! manager ${label} re-dial attempt failed: ${rejectionText(e)}`);
      }
    }
    return false;
  }

  /** Renew each registered delivery-served endpoint (A1). An endpoint this space never registered (no
   *  persisted instance id) is skipped, so a daemon not asked to serve it is left alone. Never throws:
   *  each outcome is one record row, and a failure is logged loudly. */
  private async renewDaemonEndpoints(): Promise<RemintResult[]> {
    const out: RemintResult[] = [];
    let auth: Awaited<ReturnType<typeof getSpaceAuth>>;
    try { auth = await getSpaceAuth(this.config.secrets, this.config.space); }
    catch (e) { return [{ file: "endpoints", ok: false, error: rejectionText(e) }]; }
    if (!auth) return [];
    for (const [name, spec] of Object.entries(DAEMON_ENDPOINT_BOOTSTRAPS)) {
      const file = `endpoints/${name}`;
      try {
        if (await readDaemonEndpointInstanceId(this.config.secrets, this.config.space, name) === undefined) continue;
        await renewDaemonEndpoint({
          auth, servers: this.config.servers ?? DEFAULT_SERVER, space: this.config.space, store: this.config.secrets,
          log: (line) => console.error(line),
        }, spec());
        out.push({ file, ok: true });
      } catch (e) {
        console.error(`! credential renewal: endpoint ${name} was not renewed (${rejectionText(e)}); its last-good serve connection keeps serving until its credential expires`);
        out.push({ file, ok: false, error: rejectionText(e) });
      }
    }
    return out;
  }

  /** One class-2 renewal pass: re-sign `.cotal/delivery.creds` + `.cotal/membership-rw.creds`
   *  for their existing nkeys, then request the delivery daemon's EXPLICIT `reloadCreds` adoption on the
   *  delivery-admin rail and persist the audit record (`.cotal/renewal.<spaceKey>.json`) that `cotal doctor auth`
   *  renders — so "file re-signed" and "daemon adopted" are distinguishable states. A missing daemon
   *  (no responder) is recorded honestly: each daemon's own 75% renewal timer remains the adoption backstop.
   *  Never throws — renewal failure must be LOUD (log + record), not fatal to the supervisor. */
  async renewDaemonCreds(): Promise<void> {
    const release = this.beginLifecycle();
    if (!release) return;
    try {
      // #1634: re-decide every pass, so a daemon that moved onto this manager's store becomes
      // ownable, one that moved off retires this manager's ownership, and a crashed owner's expired
      // lease is taken over by a survivor.
      await this.claimDaemonRenewalOwnership();
      // Re-sign through the manager's ONE store — the SAME store the delivery daemon reads
      // (`runDelivery(args, store)`), so a hosted remint writes the store the daemon renews from,
      // never a divergent one. Locally this is the workstation FS store (`.cotal/*.creds`).
      // `this.config.space` gates cross-space signer swaps; the `preflight` proves broker acceptance before
      // overwriting from ANY signer form (full or stripped). A same-label alternate full bundle is
      // self-bound, not broker-bound, so the manager-hosted path proves every re-sign before it could
      // clobber the last-good with a broker-dead cred; a wrong-account signer's cred is refused here.
      const results = this.daemonRenewalOwner
        ? await remintDaemonCreds(this.config.workspaceRoot, this.config.space, this.config.secrets, {
            preflight: (creds) => this.probeStaticCredential(creds).then((r) => r.ok),
          })
        : [];
      const resigned = results.filter((r) => r.ok);
      let adoption: RenewalRecord["adoption"];
      if (resigned.length) {
        // Hand the daemon the EXPECTED generation per component (SHA-256 of the JWT we just
        // re-signed) so its reply proves it adopted THIS generation, not merely re-read some file.
        const expected: { delivery?: string; membership?: string } = {};
        for (const r of resigned) {
          if (r.file === DELIVERY_CREDS_KIND && r.fingerprint) expected.delivery = r.fingerprint;
          else if (r.file === MEMBERSHIP_RW_CREDS_KIND && r.fingerprint) expected.membership = r.fingerprint;
        }
        try {
          const reply = await this.ep.requestDeliveryAdmin("reloadCreds", { expected }, DELIVERY_ADMIN_RELOAD_TIMEOUT_MS);
          // Keep the per-component aggregate on BOTH outcomes: on a top-level failure `reply.data`
          // still carries which component adopted and which was refused, which `doctor auth` renders.
          adoption = reply.ok
            ? { ok: true, detail: reply.data }
            : { ok: false, error: reply.error, detail: reply.data };
        } catch (e) {
          adoption = { ok: false, error: `no delivery-admin responder (${rejectionText(e)}) - the daemon's 75% re-read backstop adopts the re-signed file` };
        }
      }
      for (const r of results.filter((x) => !x.ok && !x.skipped))
        console.error(`! credential renewal: could not re-sign ${r.file}: ${r.error} - the daemon dies loud at this cred's expiry unless it is reminted`);
      if (adoption && !adoption.ok) console.error(`! credential renewal: daemon adoption failed: ${adoption.error}`);
      // The delivery-served endpoints' three credentials (A1): renewed by the same owner, in the same
      // pass, and adopted only on the daemon's own bind proof. One that fails leaves its last-good
      // connection serving and is recorded beside the daemon's own results.
      if (this.daemonRenewalOwner) results.push(...await this.renewDaemonEndpoints());
      // `writeRenewalRecord` redacts the ephemeral fingerprint at the persistence boundary (covering
      // the `doctor auth --fix` writer too), so the results pass straight through.
      // A non-owner (#1634) re-signed nothing, so it writes no record: an empty one renders in
      // `doctor auth` as a pass that never ran.
      if (this.daemonRenewalOwner)
        writeRenewalRecord(this.config.workspaceRoot, this.config.space, { ts: new Date().toISOString(), owner: "manager", results, adoption });
      this.warnOnSystemCredExpiry();
      // The MANAGER is the renewal owner for its managed-static agent creds —
      // supervisor-side PUSH remint for recorded LIVE slots (the child JWT is never proof of
      // incarnation; a copied credential cannot drive this and is stranded at its own row's TTL).
      // Same class-2 mechanics as the daemon creds: re-sign the file for the SAME nkey; the
      // agent endpoint's 75% source re-read adopts it.
      //
      // Each credential is judged as of the NEXT pass, so one whose renewal point falls before it
      // is re-signed now, ahead of the endpoint's re-read. Judged as of now, a credential whose
      // renewal point lands just after a pass waited a whole interval: the endpoint warned every
      // minute that the file still held the old generation, and when the next pass came in the
      // credential's last minute, the endpoint's one-minute retry could miss it and the connection
      // expired.
      const nextPassSec = Math.floor(Date.now() / 1000) + Math.ceil(credRenewIntervalMs(STANDING_RENEWABLE_TTL_SEC) / 1000);
      if (!this.userMode) {
        for (const a of [...this.agents.values()]) {
          // The `terminalizing` test here is an OPTIMISATION, NOT THE GUARD. There are awaits below
          // it, so an agent can latch mid-iteration and this filter will have already let it
          // through — what actually refuses is the same test at the top of
          // {@link renewManagedStaticCred}, which every renewal on this path goes through.
          // COUPLING: deleting or weakening that check silently promotes this line from an
          // optimisation into the whole guard, and nothing fails at the moment of the change.
          if (a.userOwner || a.terminalizing || !a.seed || !a.secretPaths?.creds) continue;
          try {
            const stored = await this.config.secrets.get(agentSecretKeyForFile(a.secretPaths.creds, this.config.space));
            if (stored === undefined) continue; // no materialized cred (never minted here) - nothing to renew
            const health = inspectCredHealth(stored, nextPassSec);
            if (health.state === "healthy") continue;
            if (health.state === "unbounded" || health.state === "unreadable") {
              console.error(`! managed cred renewal ${a.name}: credential is ${health.state}${health.error ? ` (${health.error})` : ""} - not renewed (a pre-TTL credential stays as minted until respawn)`);
              continue;
            }
            await this.renewManagedStaticCred(a);
          } catch (e) {
            console.error(`! managed cred renewal ${a.name}: ${rejectionText(e)} - the agent dies loud at this cred's expiry unless it is reminted`);
          }
        }
      }
      // The manager is the `endpoint-serve` renewal owner for its own
      // service credential: re-mint the same serve identity with a fresh bounded exp through the
      // §13.1 mint fence over a scoped one-shot executor (staging a new ledger row in a later
      // second or idempotently re-staging the active row within the same second, and releasing only
      // on winning the gate CAS; never the standing connection). The serve connection's
      // authenticator presents the refreshed credential on its next (re)connect.
      if (this.parts.servePlane.serviceServe?.creds && this.auth) {
        const s = this.parts.servePlane.serviceServe;
        const authRef = this.auth;
        try {
          const health = inspectCredHealth(this.parts.servePlane.serviceServe.creds);
          if (health.state !== "healthy") {
            s.creds = await this.withEndpointServeExecutor(({ authKv }) =>
              mintCreds(authRef, s.identity, "endpoint-serve", {
                serveIssuance: serveIssuanceGateKv(authKv, this.config.space, { endpoint: MANAGER_ENDPOINT, instanceId: this.managerInstanceId }),
                endpointServe: s.grant,
              }));
            // #2073: a superseded instance's re-mint fails the gate CAS above and lands in the
            // catch below, not here — this re-mint already re-checks the issuance gate through
            // the SAME executor a fresh registration would use, so there is no second epoch read
            // to add before re-binding after a re-dial.
            await this.pushRenewedCreds(s.nc);
            this.scheduleServeRenewal(s.creds);
          }
        } catch (e) {
          console.error(`! endpoint-serve renewal: ${rejectionText(e)} - the manager's service endpoint dies loud at this cred's expiry unless it is re-registered`);
        }
      }
      // The manager is also the goal-writer's renewal owner — re-mint the SAME
      // goal-writer nkey with a fresh bounded exp AND re-stage its new credId into the §13.1 family,
      // through the scoped executor (never the standing seed). Without this the standing goal-writer
      // connection dies at its TTL and spawn-as-action stops accepting until a restart. The
      // connection's authenticator presents the refreshed credential on its next (re)connect.
      if (this.parts.goalWriter.goalWriter && this.parts.goalWriter.goalWriterCreds && this.auth) {
        const gw = this.parts.goalWriter.goalWriter;
        try {
          if (inspectCredHealth(this.parts.goalWriter.goalWriterCreds).state !== "healthy") {
            const fresh = await this.withEndpointServeExecutor(({ authKv }) => this.mintAndStageGoalWriter(authKv));
            this.parts.goalWriter.goalWriterCreds = fresh;
            gw.creds = fresh;
            await this.pushRenewedCreds(gw.nc);
          }
        } catch (e) {
          console.error(`! goal-writer renewal: ${rejectionText(e)} - spawn-as-action stops accepting at this cred's expiry unless the manager restarts`);
        }
      }
      // The manager is also the session-ledger's renewal owner — re-mint the SAME nkey
      // with a fresh bounded exp AND re-stage its new credId into the §13.1 family, through the
      // scoped executor. Without this the standing session-ledger connection dies at its TTL and
      // `attach` stops establishing sessions until a restart. The connection's authenticator presents
      // the refreshed credential on its next (re)connect.
      // SPEC 14.6: every hosted drive's per-run `run-driver` credential is the manager's to renew
      // for the same nkey; a run parked in a pause for days must not die at the credential's TTL.
      await this.runHosting?.renew();
      if (this.parts.servePlane.sessionLedgerConn && this.parts.servePlane.sessionLedgerCreds && this.auth) {
        const sw = this.parts.servePlane.sessionLedgerConn;
        try {
          if (inspectCredHealth(this.parts.servePlane.sessionLedgerCreds).state !== "healthy") {
            const fresh = await this.withEndpointServeExecutor(({ authKv }) => this.mintAndStageSessionLedger(authKv));
            this.parts.servePlane.sessionLedgerCreds = fresh;
            sw.creds = fresh;
            await this.pushRenewedCreds(sw.nc);
          }
        } catch (e) {
          console.error(`! session-ledger renewal: ${rejectionText(e)} - attach stops establishing sessions at this cred's expiry unless the manager restarts`);
        }
      }
    } catch (e) {
      console.error(`! credential renewal pass failed: ${rejectionText(e)}`);
    } finally {
      release();
    }
  }

  /** Renew the remote registration executor through the typed host protocol. A healthy credential
   * is retained; near-expiry and expired credentials are replaced for the same nkey. */
  async renewRemoteExecutor(force = false): Promise<void> {
    if (!this.remoteAuthority) return;
    const current = this.remoteExecutorCreds;
    if (!force && current && inspectCredHealth(current).state === "healthy") return;
    try {
      this.remoteExecutorCreds = await this.remoteAuthority.renewExecutor();
    } catch (e) {
      console.error(`! remote manager executor renewal: ${rejectionText(e)} - registration maintenance and clean deregistration remain unavailable until renewal succeeds`);
      if (force) throw e;
    }
  }

  /** An active signerless manager renews its standing duties together. The issuer stages the closed
   * credential family first; broker preflight proves every JWT and existing caller-held nkey
   * before any mutable holder changes. A failed candidate leaves all current creds intact. */
  async renewRemoteStandingBundle(force = false): Promise<void> {
    if (this.remoteBundleRenewal) return this.remoteBundleRenewal;
    if (this.leaseStopping) return;
    clearTimeout(this.remoteStandingRetry);
    this.remoteStandingRetry = undefined;
    this.remoteBundleAdoption = new Promise<void>((resolve) => { this.finishRemoteBundleAdoption = resolve; });
    const renewal = this.renewRemoteStandingBundleOnce(force, performance.now() + REMOTE_STANDING_BUDGET_MS);
    this.remoteBundleRenewal = renewal;
    try { await renewal; } finally {
      this.finishRemoteBundleAdoption?.();
      if (this.remoteBundleRenewal === renewal) {
        this.remoteBundleRenewal = undefined;
        this.remoteBundleAdoption = undefined;
        this.finishRemoteBundleAdoption = undefined;
      }
    }
  }

  /** A signerless manager's closed standing connection re-dials through the all-duty family only.
   *  A healthy holder re-dials as is. An unhealthy one waits for the closed renewal and adoption,
   *  and a refusal fails this attempt with last-good and debt kept. Nothing is minted locally. */
  async renewRemoteBeforeRedial(label: string, read: () => string | undefined): Promise<void> {
    if (inspectCredHealth(read() ?? "").state === "healthy") return;
    await this.deps.renewRemoteStandingBundle(true);
    if (inspectCredHealth(read() ?? "").state !== "healthy")
      throw new Error(`the ${label} credential is not healthy after all-duty renewal; last-good is kept and nothing is minted locally`);
  }

  private async renewRemoteStandingBundleOnce(force: boolean, deadline: number): Promise<void> {
    const remote = this.remoteAuthority;
    if (!remote?.renewStandingBundle || !this.parts.servePlane.serviceServe) return;
    const current = [this.remoteSupervisorCreds, this.remoteExecutorCreds, this.parts.servePlane.serviceServe.creds,
      this.parts.goalWriter.goalWriterCreds, this.parts.servePlane.sessionLedgerCreds];
    if (!force && current.every((cred) => cred && inspectCredHealth(cred).state === "healthy")) {
      await Promise.all([
        ...[...this.pendingCredentialPushes].map((nc) => this.pushRenewedCreds(nc)),
        ...(this.supervisorCredentialPushPending ? [this.pushSupervisorCreds()] : []),
      ]);
      return;
    }
    const processEpoch = this.parts.servePlane.serviceServe.grant.epoch;
    let candidate: Awaited<ReturnType<NonNullable<typeof remote.renewStandingBundle>>> | undefined;
    const serving = this.parts.servePlane.serviceServe;
    const previous = { nc: serving.nc, handle: serving.handle };
    let replacement: { nc: NatsConnection; handle: EpServeHandle } | undefined;
    let adopted = false;
    try {
      // Only this continuation can adopt. A host operation may still issue after this wait times
      // out, but its late result cannot re-enter preflight or change any Manager holder.
      candidate = await withTimeout(remote.renewStandingBundle(processEpoch), remoteStandingTimeLeft(deadline),
        "remote manager standing authority exceeded its 10000ms aggregate budget; issuance outcome is unknown");
      if (Object.keys(candidate).sort().join(",") !== [...REMOTE_MANAGER_IDENTITY_NAMES].sort().join(","))
        throw new Error("host returned an incomplete or widened standing credential family");
      for (const name of REMOTE_MANAGER_IDENTITY_NAMES) {
        if (typeof candidate[name] !== "string" || inspectCredHealth(candidate[name]).state === "unreadable")
          throw new Error(`host returned an unreadable ${name} credential`);
        if (!remote.accountPublicKey || accountFromCreds(candidate[name]) !== remote.accountPublicKey)
          throw new Error(`host returned a ${name} credential for another account`);
        if (credsClaims(candidate[name]).sub !== remote.identities[name].id)
          throw new Error(`host returned a ${name} credential for a different nkey than the held identity`);
        const staged = candidate[name];
        const nc = await this.dialRemoteStanding({ authenticator: (nonce?: string) => credsAuthenticator(new TextEncoder().encode(staged))(nonce), maxReconnectAttempts: 0 }, deadline);
        await nc.close();
      }
      remoteStandingTimeLeft(deadline);
      if (this.leaseStopping || this.parts.servePlane.serviceServe !== serving || serving.nc !== previous.nc || serving.grant.epoch !== processEpoch)
        throw new Error("manager changed its active serve epoch or connection while standing renewal was in flight");
      const stagedServeCreds = candidate.serve;
      replacement = await this.dialServeConnection({ ...serving, creds: stagedServeCreds },
        () => adopted ? serving.creds! : stagedServeCreds, deadline);
      remoteStandingTimeLeft(deadline);
      if (this.leaseStopping || this.parts.servePlane.serviceServe !== serving || serving.nc !== previous.nc || serving.grant.epoch !== processEpoch)
        throw new Error("manager changed its active serve epoch or connection while standing renewal was in flight");
      if (REMOTE_MANAGER_IDENTITY_NAMES.some((name) => inspectCredHealth(candidate![name]).state !== "healthy"))
        throw new Error("standing candidate is no longer healthy after broker preflight");
      serving.nc = replacement.nc;
      serving.handle = replacement.handle;
      replacement = undefined;
      this.remoteSupervisorCreds = candidate.supervisor;
      this.remoteExecutorCreds = candidate.executor;
      this.parts.servePlane.serviceServe.creds = candidate.serve;
      adopted = true;
      this.parts.goalWriter.goalWriterCreds = candidate.goalWriter;
      this.parts.servePlane.sessionLedgerCreds = candidate.sessionLedger;
      if (this.parts.goalWriter.goalWriter) this.parts.goalWriter.goalWriter.creds = candidate.goalWriter;
      if (this.parts.servePlane.sessionLedgerConn) this.parts.servePlane.sessionLedgerConn.creds = candidate.sessionLedger;
      // Adoption is committed above; a connection that cannot come back yet is a push failure the
      // endpoint's own reconnect loop retries with the adopted credential, not unadopted debt.
      this.remoteRenewalDebt = undefined;
      // Maintenance needed by admitted handlers must not wait for those same handlers to drain.
      this.finishRemoteBundleAdoption?.();
      await withTimeout(Promise.all([
        this.pushSupervisorCreds(),
        (async () => {
          try {
            // A handler or a lost broker PONG can keep stop/flush pending forever. Only the
            // retired transport is expendable: never retry its requests or close the replacement.
            await withTimeout((async () => {
              await previous.handle.stop();
              await previous.nc.flush();
            })(), 5_000, "old serve drain unfinished after 5000ms; closing retired transport, in-flight request outcomes are unknown and must not be retried");
          } finally {
            await previous.nc.close();
          }
        })().catch((e) => console.error(`! remote manager retired serve drainage after renewal: ${rejectionText(e)}`)),
        ...(this.parts.goalWriter.goalWriter ? [this.pushRenewedCreds(this.parts.goalWriter.goalWriter.nc)] : []),
        ...(this.parts.servePlane.sessionLedgerConn ? [this.pushRenewedCreds(this.parts.servePlane.sessionLedgerConn.nc)] : []),
      ]), remoteStandingTimeLeft(deadline), "remote manager standing reconnect exceeded its 10000ms aggregate budget; adopted transports keep their native reconnect ownership");
    } catch (e) {
      if (replacement) {
        await this.parts.brokerTransport.discardServeCandidate(replacement.nc, replacement.handle);
      }
      if (adopted) {
        console.error(`! remote manager adopted standing family: ${rejectionText(e)}`);
        return;
      }
      const unadoptedSubjects = candidate && typeof candidate === "object"
        ? Object.values(candidate).flatMap((cred) => { try { return typeof cred === "string" && credsClaims(cred).sub ? [credsClaims(cred).sub!] : []; } catch { return []; } })
        : REMOTE_MANAGER_IDENTITY_NAMES.map((name) => remote.identities[name].id);
      this.remoteRenewalDebt = { at: Date.now(), processEpoch, reason: rejectionText(e), unadoptedSubjects };
      console.error(`! remote manager all-duty renewal: ${this.remoteRenewalDebt.reason} - no unsigned or local replacement is available`);
      if (candidate === undefined && e instanceof EpEnvelopeError && e.code === "unavailable") this.scheduleRemoteStandingRetry();
      if (force) throw e;
    }
  }

  /** Warn, on every renewal pass, when a $SYS credential is at or past its renewal point.
   *
   *  The manager is the renewal owner for every credential it CAN re-sign, and these two are the ones
   *  it cannot: they are `rotation-renewed`, so no resident process re-mints them and they simply die
   *  on their 30-day horizon. Before this, a mesh that never ran `doctor auth` got no signal at all,
   *  it discovered the expiry as an "Authorization Violation" in the delivery log and a refused
   *  membership adoption, weeks after the warning would have been actionable (#338). The pass runs
   *  every half-TTL of the 24h class, so this repeats about twice a day for the ~7 days between the
   *  renewal point and expiry: loud enough to be seen, bounded enough not to be noise.
   *
   *  Diagnostic only, and deliberately non-fatal: renewal is an operator action (`cotal down` then
   *  `cotal up --rotate-sys`, which needs a broker restart), so the manager must report it, never
   *  attempt it. An absent file is the unprovisioned space, reported by the daemon that needs it. */
  private warnOnSystemCredExpiry(): void {
    for (const file of SYSTEM_CREDS_FILES) {
      let health: CredHealth;
      try {
        // The pair is PER-SPACE, so the location comes from the resolver and never from a
        // path built here (§2 rule 1). Building `.cotal/<kind>` instead would not warn on a wrong
        // file — it would silently warn on NOTHING, for every provisioned root, forever, which is
        // exactly the signal #338 added this for. The resolver may also refuse (§2 rules 3, 4); that
        // refusal is caught with the unreadable case for the reason on the tin — the daemon that
        // NEEDS the pair resolves it through the same function and reports it loudly there, so a
        // diagnostic pass has nothing to add by crashing renewal.
        const path = join(this.config.workspaceRoot, ".cotal", spaceMaterialKey(file, this.config.space, { injected: false, root: this.config.workspaceRoot }));
        if (!existsSync(path)) continue;
        health = inspectCredHealth(readFileSync(path, "utf8"));
      } catch {
        continue; // an unreadable $SYS file is the daemon's loud failure, not a renewal-pass crash
      }
      const when = health.exp ? new Date(health.exp * 1000).toISOString() : "an unknown date";
      if (health.state === "expired")
        console.error(
          `! $SYS credential ${file} EXPIRED ${when} - the broker denies it, and NOTHING renews it in place (it is rotation-renewed). Live eviction and the membership feed stay down until: \`cotal down\` then \`cotal up --rotate-sys\` (agents, creds and data survive)`,
        );
      else if (health.state === "near-expiry")
        console.error(
          `! $SYS credential ${file} expires ${when} and nothing renews it in place (it is rotation-renewed) - schedule: \`cotal down\` then \`cotal up --rotate-sys\` (agents, creds and data survive)`,
        );
    }
  }
}
