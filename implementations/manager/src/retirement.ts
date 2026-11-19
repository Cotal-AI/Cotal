import { rmSync } from "node:fs";
import { credsAuthenticator, type NatsConnection } from "@nats-io/transport-node";
import {
  DEFAULT_SERVER, DEV_OWNER, DeprovisionError, deprovisionAgent, isConcreteChannel,
  managedRetirementOpId, mintCreds, newIdentity, parsePrincipalKey, principalKey,
  resolveAuthProvider, AUTH_ENDPOINT, EP_CMD_RETIRE_LIFECYCLE, resolveService, invokeCommand,
  rejectionText, attemptCleanup, describeCleanupFailures,
  type CleanupFailure, type DeprovisionResourceAccounting, type Identity, type RuntimeReference,
  type SecretStore, type SpaceAuth, type dialerFor,
} from "@cotal-ai/core";
import { agentLifecycleSecretFilePaths, agentSecretKeyForFile, userAuthStateDir } from "@cotal-ai/workspace";
import { MANAGER_ENDPOINT } from "./manager-service-contract.js";
import type { ManagerOptions } from "./manager.js";
import type { AgentHandle } from "./runtime/index.js";

/** What the teardown chain (trackDeprovision → deprovision → driveDeprovision →
 *  driveStaticRetirement) needs to tear one incarnation down. Each hop passes the value on as a
 *  variable, which TypeScript does not excess-check, so the hops share this one declaration. */
export interface TeardownTarget {
  id: string;
  name: string;
  lifecycleUid: string;
  userOwner?: string;
  delegated?: true;
  secretPaths?: { creds?: string; actorToken?: string; sentinelCreds?: string; health?: string };
  runtime?: RuntimeReference;
  delegatedHandle?: AgentHandle;
  launch?: { allowSubscribe: readonly string[] };
  /** The departed agent's admitted renewal, which the static terminal drains before it begins. */
  staticCredentialRenewal?: Promise<void>;
  /** Set when this lifecycle's inline snapshot is settled: the file is gone, or the lifecycle never
   *  had one. A live slot's free and a manager shutdown set it once they removed the seat's own, and
   *  a spawn's rollback once it removed the one it wrote or its write was refused, since a file that
   *  write refused was never this lifecycle's. Absent after a removal that failed, and for a
   *  lifecycle known only by its slot row; the static terminal then removes the uid's path. */
  snapshotSettled?: true;
}

/** A name held pending its incarnation's retirement. It keeps the teardown target whole, so a
 *  same-name spawn or a resume re-drives the same teardown the first drive ran. */
export interface RetirementHold {
  opId: string;
  owner: string;
  actor: string;
  target: TeardownTarget;
  startedAt: number;
  lastError?: string;
  standingAuthorityLive?: boolean;
  lastResources?: DeprovisionResourceAccounting;
}

/** The retirement coordinator reads current authority at each call and delegates process and
 * maintenance ownership to its manager. */
export interface RetirementDeps {
  auth(): SpaceAuth | undefined;
  remoteAuthority(): Pick<NonNullable<ManagerOptions["remoteAuthority"]>, "owner" | "actors" | "prepareAgentRetirement" | "mintRetirementRequester"> | undefined;
  userMode(): boolean;
  workspaceRoot(): string;
  space(): string;
  servers(): string | undefined;
  secrets(): SecretStore;
  serveIdentity(): Identity | undefined;
  lifecycleUid(): string;
  instanceId(): string;
  serveEpoch(): number | undefined;
  dial(opts: Parameters<ReturnType<typeof dialerFor>>[0]): Promise<NatsConnection>;
  withRetirementSlot<T>(run: () => Promise<T>): Promise<T>;
  driveStaticRetirement(a: TeardownTarget): Promise<void>;
  awaitHandleExit(handle: AgentHandle): Promise<void>;
  shredUserSecrets(failures: CleanupFailure[], family: { actorToken?: string; sentinelCreds?: string; health?: string }): Promise<void>;
  dropSeatRecord(a: { name: string; lifecycleUid: string }): void;
  fenceRetiringAcl(a: { id: string; lifecycleUid: string }): Promise<string | undefined>;
  lifecycleMembershipInventory(a: { id: string; lifecycleUid: string }): Promise<{ complete: boolean; channels: string[]; reason?: string }>;
  brokerTeardown<T>(task: Promise<T>, message: string): Promise<T>;
  trackLifecycle(): () => void;
}

/** Retirement holds, exact-lifecycle teardown flights and confirmed predecessor coordinates. */
export class Retirement {
  /** Names RESERVED PENDING RETIREMENT: a despawned agent's name stays held until
   *  the auth plane confirms its lifecycle's retirement TERMINAL over the auth-admin rail - the
   *  alias-reuse gate that closes the same-name despawn→respawn race at its root. An UNCERTAIN
   *  outcome (rail down, timeout) keeps the hold with the last attempt's copy; a same-name spawn
   *  refuses legibly AND re-fires the request. In-memory: across a manager restart the durable
   *  truth is the auth-side lifecycle head itself (an unretired head refuses issuance - the
   *  named residual this belt narrows, not replaces). */
  private retiring = new Map<string, RetirementHold>();
  /** SINGLE-FLIGHT guard for {@link requestRetirement} (audit #1): one in-flight rail round-trip per
   *  (name, lifecycleUid). The detached `deprovision` call and every same-name-spawn nudge for THAT
   *  lifecycle JOIN the same promise instead of stacking independent requests that dual-enter the
   *  barrier; a fresh trigger after it settles re-drives. Keyed by (name, uid) - NOT name alone - so a
   *  same-name SUCCESSOR (which can spawn after the hold clears but before this flight's `nc.close`
   *  yield settles) never joins the predecessor's rail request and skips its own retirement. */
  private retiringFlight = new Map<string, Promise<void>>();
  /** Wire principals of RETIRED static incarnations: populated at every completed
   *  static terminal and from the boot sweep's retired slot rows, so a copied credential of a
   *  retired incarnation is refused at the control surface even across a manager restart. The
   *  durable truth is the slot row + principal-keyed head; this set is the in-memory index of it
   *  (one string per retired incarnation - bounded by lifecycle count, never pruned in-process). */
  private readonly retiredPrincipals = new Set<string>();
  /** Exact predecessor incarnations whose full hosted retirement reached a terminal answer. Presence
   *  is advisory and can retain that old lifecycle briefly after its process exits. Resume may ignore
   *  only this exact (alias, principal, lifecycleUid) row when adopting a different lifecycle; every
   *  unknown, current, or differently identified live row still refuses. A later retirement of the
   *  same alias replaces its prior predecessor coordinate. */
  private readonly confirmedRetiredPredecessors = new Map<string, { principal: string; lifecycleUid: string }>();
  /** SINGLE-FLIGHT guard for {@link deprovision} (INT-2/C): one in-flight teardown per
   *  (name, lifecycleUid). The detached freeSlot teardown and every same-name-spawn nudge that
   *  re-drives it JOIN one promise instead of launching a SECOND, concurrent teardown. Without it,
   *  two teardowns race the NAME-KEYED ledger revoke: once the first frees the alias and a successor
   *  mints its own row, the second's delayed revoke (which carries no lifecycle coordinate) would
   *  delete the SUCCESSOR's standing authority. Keyed by (name, uid) so a later same-name lifecycle
   *  gets its own flight; a fresh trigger after settle re-drives only if the hold still stands. */
  private deprovisioningFlight = new Map<string, Promise<void>>();

  constructor(private readonly deps: RetirementDeps) {}

  private get auth() { return this.deps.auth(); }
  private get remoteAuthority() { return this.deps.remoteAuthority(); }
  private get userMode() { return this.deps.userMode(); }
  private get workspaceRoot() { return this.deps.workspaceRoot(); }
  private get space() { return this.deps.space(); }
  private get servers() { return this.deps.servers(); }
  private get secrets() { return this.deps.secrets(); }
  private get managerServeIdentity() { return this.deps.serveIdentity(); }
  private get managerLifecycleUid() { return this.deps.lifecycleUid(); }
  private get managerInstanceId() { return this.deps.instanceId(); }
  private dial(opts: Parameters<ReturnType<typeof dialerFor>>[0]) { return this.deps.dial(opts); }
  private withRetirementSlot<T>(run: () => Promise<T>) { return this.deps.withRetirementSlot(run); }
  private driveStaticRetirement(a: TeardownTarget) { return this.deps.driveStaticRetirement(a); }
  private awaitHandleExit(handle: AgentHandle) { return this.deps.awaitHandleExit(handle); }
  private shredUserSecrets(failures: CleanupFailure[], family: { actorToken?: string; sentinelCreds?: string; health?: string }) { return this.deps.shredUserSecrets(failures, family); }
  private dropSeatRecord(a: { name: string; lifecycleUid: string }) { return this.deps.dropSeatRecord(a); }
  private fenceRetiringAcl(a: { id: string; lifecycleUid: string }) { return this.deps.fenceRetiringAcl(a); }
  private lifecycleMembershipInventory(a: { id: string; lifecycleUid: string }) { return this.deps.lifecycleMembershipInventory(a); }

  hold(name: string, hold: RetirementHold): void { this.retiring.set(name, hold); }
  held(name: string): RetirementHold | undefined { return this.retiring.get(name); }
  hasHold(name: string): boolean { return this.retiring.has(name); }
  predecessor(name: string): { principal: string; lifecycleUid: string } | undefined { return this.confirmedRetiredPredecessors.get(name); }
  get pendingCount(): number { return this.retiring.size; }
  get inFlightCount(): number { return this.deprovisioningFlight.size; }
  rememberRetired(principal: string): void { this.retiredPrincipals.add(principal); }

  recordStaticRetirement(a: { id: string; name: string; lifecycleUid: string }): void {
    const principal = principalKey(DEV_OWNER, a.id).key;
    this.retiredPrincipals.add(principal);
    const cur = this.retiring.get(a.name);
    if (cur && cur.target.lifecycleUid === a.lifecycleUid) {
      this.retiring.delete(a.name); // ABA-guarded hold clear
      this.confirmedRetiredPredecessors.set(a.name, { principal, lifecycleUid: a.lifecycleUid });
    }
  }

  membershipRefusal(caller: string): string | undefined {
    for (const [name, hold] of this.retiring) {
      const held = hold.target.userOwner ? hold.target.id : principalKey(DEV_OWNER, hold.target.id).key;
      if (held === caller)
        return `the caller's lifecycle ${hold.target.lifecycleUid} (name "${name}") is retiring; a retiring incarnation's credential holds no control authority`;
    }
    if (this.retiredPrincipals.has(caller))
      return "the caller's lifecycle is retired; a retired incarnation's credential holds no control authority";
    return undefined;
  }

  /** Tear down a departed agent's minted footprint (#159 B2, auth mode): its local-principal durables
   *  (`dm_local-<id>`, `dlv_local-<id>`), its read-ACL row, and its creds file - everything the spawn's
   *  `provisionAgent` + creds-write left behind. Mints an EPHEMERAL, TARGET-PINNED `deprovisioner` cred
   *  (mirrors the ephemeral `provisioner`/`purger`): it can delete only THIS agent's local-principal footprint,
   *  never a peer's and never the role-shared `svc_<role>` (which its siblings still bind). Open mesh →
   *  no-op (nothing was minted). Idempotent at the broker (missing consumer / ACL row = no-op) and on
   *  disk (`force` tolerates an absent creds file, e.g. a ledgered deploy that wrote none).
   *
   *  Removing the creds file is footprint REDUCTION, not revocation: a JWT copied off disk before exit
   *  keeps its inline publish/live-sub/control grants until key rotation or JWT expiry - cred revocation
   *  is the separate per-user-auth work, not this. Tearing down the durables + ACL row still shrinks the
   *  delivery surface a stale copy could use. */
  async deprovision(a: TeardownTarget): Promise<void> {
    if (!this.auth && !this.remoteAuthority) return; // open mesh mints no creds/durables - nothing to tear down
    // SINGLE-FLIGHT per (name, lifecycleUid) (INT-2/C): join an in-flight teardown for this exact
    // lifecycle rather than launching a second concurrent one whose delayed name-keyed revoke could
    // outlive the hold-clear and delete a successor's row. A fresh trigger after settle re-drives.
    const key = JSON.stringify([a.name, a.lifecycleUid]); // ASCII-safe, delimiter-collision-free
    const inflight = this.deprovisioningFlight.get(key);
    if (inflight) return inflight;
    const flight = this.withRetirementSlot(() => this.driveDeprovision(a)).finally(() => {
      if (this.deprovisioningFlight.get(key) === flight) this.deprovisioningFlight.delete(key);
    });
    this.deprovisioningFlight.set(key, flight);
    return flight;
  }

  /** The actual footprint teardown (wrapped by {@link deprovision}'s single-flight). */
  async driveDeprovision(a: TeardownTarget): Promise<void> {
    if (this.remoteAuthority) {
      if (a.delegated) {
        // The agent is its user's: only that user's retirement intent retires it, so the name stays
        // held until retireDelegatedAgent confirms the host retired this UID.
        const held = this.retiring.get(a.name);
        if (held?.target.lifecycleUid === a.lifecycleUid)
          held.lastError = `"${a.name}" was launched under a delegated user intent and retires only through its user's retirement intent`;
        return;
      }
      // A hosted composition owns grant revocation and resumable footprint release. It calls this
      // prerequisite before the terminal rail. The callback must preserve this UID and its pending
      // state until the host decides terminal retirement, never map deprovisioning to suspension.
      const target = parsePrincipalKey(a.id);
      if (!target) throw new Error(`hosted retirement cannot derive the managed principal ${a.id}`);
      await this.remoteAuthority.prepareAgentRetirement({
        target: { owner: target.owner, actor: target.actor, lifecycleUid: a.lifecycleUid },
        opId: managedRetirementOpId(a.lifecycleUid),
      });
      // A delegated seat's fenced close runs only now, after the grant is revoked so its child can
      // obtain no fresh bearer, and before the barrier, which must never run ahead of a create that
      // could still land. A close that cannot prove that yet throws here and keeps the alias held.
      if (a.delegatedHandle) {
        a.delegatedHandle.stop({ graceful: true });
        await this.awaitHandleExit(a.delegatedHandle);
      }
      // THE LOCAL FAMILY IS THIS PARTICIPANT'S, not the host's (#3055). The hosted enrollment wrote
      // it here, so the host's release cannot remove it, and returning after the terminal request
      // left every hosted seat's actor token, sentinel and health file on disk. It goes once the
      // grant is released and the child is gone, by the same rule as the local arm below: every
      // removal is attempted, and a failure keeps the name held instead of reaching the terminal.
      const unshredded: CleanupFailure[] = [];
      await this.shredUserSecrets(unshredded, a.secretPaths ?? agentLifecycleSecretFilePaths(this.workspaceRoot, this.space, a.name, a.lifecycleUid));
      if (unshredded.length) throw new Error(`could not shred "${a.name}": ${describeCleanupFailures(unshredded)}`);
      await this.requestRetirement(a);
      return;
    }
    if (!this.auth) return; // guaranteed by deprovision; re-checked for the deprovisionBroker narrowing
    if (!this.userMode && !a.userOwner) {
      // A STATIC lifecycle retires through the terminal barrier - freeze → head
      // retiring → B1 ledger revoke → footprint cleanup (creds file + broker durables/ACL, INSIDE
      // the barrier) → gate retired → head retired → alias free. The eviction step is the process
      // kill the stop path already performed (static's best-effort eviction).
      return this.driveStaticRetirement(a);
    }
    // Drop the local creds file FIRST + unconditionally - it is a usable identity on disk, useless for a
    // departed agent, so it must not survive even if the broker teardown below fails or times out. The
    // teardown mints its OWN deprovisioner cred (not this file), so removing it early is independent.
    // Migrated kinds: the store delete is the authoritative removal; the rmSync clears the FS
    // materialization (a byte-identical no-op under the local composition, real once the manager
    // `secretStore` is a non-FS store).
    //
    // LIFECYCLE-OWNED (SPEC 13.1, the manager-local half): the family deleted here is the RECORDED
    // one (spawn/adoption), else the lifecycle-keyed derivation for THIS uid - never a name-only
    // derivation, so a stale/replayed teardown addresses only names a same-alias successor never
    // uses. It deliberately CANNOT remove a name-keyed family it holds no record of (an operator's
    // standing `cotal mint` cred, a seeded workstation cred, a pre-split leftover): deleting an
    // unowned same-name file is the exact successor-clobber this ownership discipline removes.
    const secrets = this.secrets;
    const files = a.secretPaths ?? agentLifecycleSecretFilePaths(this.workspaceRoot, this.space, a.name, a.lifecycleUid);
    // Every removal is attempted, and a failed one is thrown only after the broker teardown below,
    // so a file fault cannot strand the agent's durables and ACL row on the broker.
    const unshredded: CleanupFailure[] = [];
    if (files.creds) {
      const creds = files.creds;
      await attemptCleanup(unshredded, `secret ${creds}`, () => secrets.delete(agentSecretKeyForFile(creds, this.space)));
      await attemptCleanup(unshredded, `file ${creds}`, () => rmSync(creds, { force: true }));
    }
    if (a.userOwner) {
      // USER MODE: this teardown IS revocation, not just footprint reduction - the ledger row is
      // the agent's standing mint authority, so delete it (next exchange refused, next connect
      // denied) and shred the secret/sentinel/health files. A copied actor token dies here; a
      // still-LIVE connection ends at its bearer-bound JWT expiry (≤ the agent TTL).
      await this.shredUserSecrets(unshredded, files);
      // The ledger row IS the agent's STANDING mint authority (a different store from the auth-plane
      // cred ledger the rail retirement covers): while it lives, a copied actor token can still mint a
      // fresh connect credential. So a FAILED revoke must NOT be swallowed into a clean terminal (INT-2):
      // mark the standing authority live on the hold so the retirement can never free the name (a freed
      // name says "this lifecycle is fully gone" - false while the mint authority stands), and carry a
      // legible operator copy. A retry re-drives this whole teardown (the same-name-spawn nudge routes
      // through deprovision, not the rail alone), so the revoke is re-attempted, not stranded.
      const holdRevoke = this.retiring.get(a.name);
      if (holdRevoke && holdRevoke.target.lifecycleUid === a.lifecycleUid) holdRevoke.standingAuthorityLive = true;
      try {
        await resolveAuthProvider().revokeAgent({
          dir: userAuthStateDir(this.workspaceRoot, this.space),
          owner: a.userOwner,
          actor: a.name,
        });
        const done = this.retiring.get(a.name);
        if (done && done.target.lifecycleUid === a.lifecycleUid) done.standingAuthorityLive = false;
      } catch (e) {
        const h = this.retiring.get(a.name);
        if (h && h.target.lifecycleUid === a.lifecycleUid)
          h.lastError = `the agent's standing mint authority could not be revoked (${rejectionText(e)}); the name stays held so a copied actor token cannot mint fresh credentials. NEXT: a same-name spawn re-drives the full teardown (including the revoke), or recover the auth state.`;
        console.error(`revoke agent grant ${a.name}: ${rejectionText(e)}`);
      }
    }
    const shredFailure = unshredded.length ? `could not shred "${a.name}": ${describeCleanupFailures(unshredded)}` : undefined;
    try {
      const res = await this.deprovisionBroker(a);
      const h = this.retiring.get(a.name);
      if (h && h.target.lifecycleUid === a.lifecycleUid) h.lastResources = res;
    } catch (e) {
      const h = this.retiring.get(a.name);
      if (h && h.target.lifecycleUid === a.lifecycleUid) {
        h.lastError = rejectionText(e);
        if (e instanceof DeprovisionError) h.lastResources = e.accounting;
      }
      if (shredFailure) throw new Error(`${rejectionText(e)}; ${shredFailure}`, { cause: e });
      throw e;
    }
    if (shredFailure) throw new Error(shredFailure);
    // After the footprint teardown, ask the AUTH plane to RETIRE the lifecycle over
    // the auth endpoint rail. The rail re-checks the SERVE-ISSUANCE GATE at serve time (not the
    // space-manager lease - that check was replaced in 02794b2f) and refuses unless the registration
    // this request names belongs to our own principal; the terminal (or an already-retired answer)
    // clears the name reservation. Failures keep the hold with
    // their operator copy - legible, retryable, never a silent half-state.
    await this.requestRetirement(a);
  }

  /** Request the auth-side retirement of a departed agent's lifecycle: an ephemeral
   *  `retirement-requester` credential (request + reply only), the generic `retireLifecycle` op,
   *  a STABLE opId (derived from the lifecycleUid, so every retry re-drives the SAME operation),
   *  and the four-outcome handling in operator vocabulary. */
  async requestRetirement(a: { id: string; name: string; lifecycleUid: string }): Promise<void> {
    if (!this.userMode) return; // NEW-1: lifecycle retirement is a user-mesh concept; a static mint has no head to retire
    // SINGLE-FLIGHT per (name, lifecycleUid) (audit #1): the detached deprovision call and every
    // same-name-spawn nudge for THIS lifecycle share ONE in-flight retirement, so concurrent triggers
    // never stack independent rail requests that dual-enter runAgentRetirementBarrier. Keyed by
    // (name, uid), NOT name alone: driveRetirement clears the hold on rail ok but then yields at
    // `nc.close()` with the flight still stored, so the alias can free and a SUCCESSOR (new uid) spawn.
    // A name-only key would let that successor's own teardown JOIN the predecessor's still-pending
    // flight and never send its OWN retirement - leaving the successor's lifecycle unretired. The uid in
    // the key gives the successor a disjoint flight (mirrors {@link deprovisioningFlight}). A fresh
    // trigger after settle re-drives (a still-present hold => retirement not yet confirmed).
    const key = JSON.stringify([a.name, a.lifecycleUid]);
    const inflight = this.retiringFlight.get(key);
    if (inflight) return inflight;
    const flight = this.driveRetirement(a).finally(() => {
      if (this.retiringFlight.get(key) === flight) this.retiringFlight.delete(key);
    });
    this.retiringFlight.set(key, flight);
    return flight;
  }

  /** The rail round-trip for one retirement (wrapped by {@link requestRetirement}'s single-flight). */
  async driveRetirement(a: { id: string; name: string; lifecycleUid: string }): Promise<void> {
    if (!this.auth && !this.remoteAuthority) return;
    const held = this.retiring.get(a.name);
    const target = parsePrincipalKey(a.id);
    if (!target) {
      if (held) held.lastError = "the target principal could not be derived; the retirement was not requested";
      return;
    }
    // The SERVE identity, not the endpoint identity, is who this request speaks as (#549). The field
    // is declared `!:`, which asserts to the type system what the ordering happens to provide, so it
    // is read here as what it actually is. On today's ordering this guard cannot fire: `start()`
    // assigns the identity before it connects anything, and a retirement needs an agent that only a
    // started manager can hold. It is kept as a fail-closed assertion rather than a live face,
    // because the alternative is carrying `undefined` into the caller triple and surfacing the
    // result as "the rail could not be reached", which would name the wrong cause.
    const serveIdentity = this.managerServeIdentity as Identity | undefined;
    if (!serveIdentity?.id) {
      if (held) held.lastError = `the retirement was NOT requested: this manager has no serve identity yet, so it cannot speak as the registered serving instance. The despawn stopped "${a.name}" and the name stays held. NEXT: let the manager finish registering, then re-attempt the same-name spawn to re-drive the teardown.`;
      return;
    }
    const reportFailure = (why: string, unconfirmed = false): void => {
      // An orphan rollback owns no name hold. Re-read after the rail awaits so a successor's
      // hold never receives the predecessor's error or supplies its despawn/retry claims.
      const current = this.retiring.get(a.name);
      const held = current?.target.lifecycleUid === a.lifecycleUid ? current : undefined;
      const copy = !unconfirmed ? why : held
        ? `the despawn stopped "${a.name}", but the retirement's completion could NOT be confirmed (${why}). The name stays held - not failed, not done - and a same-name spawn re-drives the same teardown; the auth service also finishes any started retirement on its next boot. NEXT: if the auth rail stays unreachable, recover the stack (\`cotal supervise\`), then re-attempt the same-name spawn.`
        : `the retirement's completion could NOT be confirmed (${why}). No hold reserves the name for this lifecycle.`;
      if (held) held.lastError = copy;
      const prefix = held ? `despawn ${a.name}` : `retire ${a.name}: lifecycle ${a.lifecycleUid}`;
      console.error(`${prefix}: ${copy}`);
    };
    try {
      // The caller triple and the TARGET are both grant-pinned now (#350): the `handle` target
      // rides the subject, so this ephemeral credential can ask to retire exactly this
      // incarnation and nothing else.
      //
      // THE TRIPLE IS THE SERVE PRINCIPAL, and it has to be (#549). The auth rail authorizes this
      // request by comparing the caller's `<owner>.<actor>` against the serve issuance gate's bound
      // principal, and that gate is opened with `principalKey(DEV_OWNER, serveIdentity.id)` (see the
      // registration block). Deriving the caller from `ep.ref().id` instead put the manager's
      // ENDPOINT identity nkey on the wire, which is a different, equally real identity of the same
      // manager, so the comparison was unsatisfiable and EVERY user-mesh retirement was refused as a
      // full no-op. Measured before the fix: 8 refusals in one suite run across 5 agents, with the
      // epoch and the instance id both matching and only the principal disagreeing.
      //
      // Both halves come from the gate's own sources rather than from `ep.ref()`: `DEV_OWNER` is
      // hard-coded at the gate site, so taking the owner from `ep.ref().id` would re-open the same
      // mismatch in the owner half the moment a manager ran under a user-shaped identity. This is
      // also the more honest attribution: the authority being exercised is "I am the registered
      // serving instance", which is exactly what the gate records.
      const caller = this.remoteAuthority
        ? { owner: this.remoteAuthority.owner, actor: this.remoteAuthority.actors.serve, uid: this.managerLifecycleUid }
        : { owner: DEV_OWNER, actor: serveIdentity.id, uid: this.managerLifecycleUid };
      const requestIdentity = newIdentity();
      const retirementTarget = { owner: target.owner, actor: target.actor, lifecycleUid: a.lifecycleUid };
      const opId = managedRetirementOpId(a.lifecycleUid);
      const serveEpoch = this.deps.serveEpoch() ?? 0;
      const creds = this.remoteAuthority
        ? await this.remoteAuthority.mintRetirementRequester({ identity: requestIdentity, target: retirementTarget, opId, serveEpoch })
        : await mintCreds(this.auth!, requestIdentity, "retirement-requester", {
            retirementRequester: { ...caller, target: retirementTarget },
          });
      // The requester grant subscribes `_INBOX_<id>.>` only (provision.ts): the endpoint path's
      // JetStream API requests (the contract-store read inside resolveService) must reply under it, not under the client default `_INBOX.`.
      const nc = await this.dial({ authenticator: credsAuthenticator(new TextEncoder().encode(creds)), inboxPrefix: `_INBOX_${requestIdentity.id}`, maxReconnectAttempts: 0 });
      try {
        // The service resolves FRESH on every attempt (never cached on `this`): a plane restart
        // mid-despawn then lands on the new epoch through an ordinary resolve, rather than a
        // caller pinned to a now-superseded incarnation.
        const service = await resolveService(nc, this.space, AUTH_ENDPOINT, caller, { deadlineMs: 10_000, commands: [EP_CMD_RETIRE_LIFECYCLE] });
        // The TARGET rides the invoke's own target (authz mode `exact`, arity 3) - broker-enforced,
        // and pinned by the grant minted above, so it is not a body claim the caller can vary.
        const attributed = await invokeCommand(nc, this.space, service, EP_CMD_RETIRE_LIFECYCLE, {
          opId,
          serveEndpoint: MANAGER_ENDPOINT, serveInstanceId: this.managerInstanceId, serveEpoch,
        }, {
          target: { mode: "exact", owner: target.owner, actor: target.actor, lifecycleUid: a.lifecycleUid },
          deadlineMs: 20_000,
        });
        const r = attributed.reply;
        if (r.ok) {
          this.confirmRetirement(a);
        } else if (r.error?.code === "expired") {
          // A stale-epoch refusal cannot confirm retirement. The retry copy follows the
          // current lifecycle's hold, which an orphan rollback does not create.
          reportFailure(r.error.message, true);
        } else {
          // The rail's refusal is already the operator copy (lease-loss/stale/foreign-op faces,
          // full-no-op statements included) - surface it INTACT, never flattened.
          const message = r.error?.message ?? "the auth service refused the retirement without a reason";
          reportFailure(message);
        }
      } finally {
        await nc.close().catch(() => {});
      }
    } catch (e) {
      reportFailure(rejectionText(e), true);
    }
  }

  /** Apply one terminal retirement answer. The predecessor coordinate is recorded only when the
   *  answer clears this exact lifecycle's hold, never for an ABA-late answer or an incomplete hosted
   *  teardown whose standing authority still lives. */
  confirmRetirement(a: { id: string; name: string; lifecycleUid: string }): void {
    // CAS the hold clear (audit #1 ABA): free the alias ONLY if the current hold is still THIS
    // lifecycle's. A late reply for a retired predecessor must never clear a successor's newer hold.
    const cur = this.retiring.get(a.name);
    // The record names this incarnation only, so a confirmed retirement removes it and a successor's
    // record stays. A mint authority that is still live keeps the record: the seat is gone, and the
    // next manager has to be able to re-drive the revoke.
    if (!(cur?.target.lifecycleUid === a.lifecycleUid && cur.standingAuthorityLive)) this.dropSeatRecord(a);
    if (cur && cur.target.lifecycleUid === a.lifecycleUid) {
      if (cur.standingAuthorityLive) {
        // INT-2: the auth-plane lifecycle retired, but the manager-side STANDING mint authority is
        // not yet revoked. A copied token could still mint, so neither free the alias nor classify
        // its presence as a completed predecessor.
        console.error(`despawn ${a.name}: the auth-plane lifecycle retired, but the standing mint authority is not yet revoked; the name stays held. ${cur.lastError ?? ""}`);
      } else {
        this.confirmedRetiredPredecessors.set(a.name, { principal: a.id, lifecycleUid: a.lifecycleUid });
        this.retiring.delete(a.name);
        console.error(`despawn ${a.name}: the agent's retirement completed; the name is free for reuse`);
      }
    } else if (cur) {
      console.error(`despawn ${a.name}: retirement confirmed for a prior lifecycle of "${a.name}"; the current hold is left intact`);
    } else {
      // No hold stands, as after an orphaned spawn's rollback: that lifecycle was never despawned and
      // has no successor, so this line names neither.
      console.error(`retire ${a.name}: lifecycle ${a.lifecycleUid} retired; the name had no hold to clear`);
    }
  }

  /** The teardown's ASYNC BROKER PHASE: mint the ephemeral target-pinned deprovisioner cred and
   *  delete the agent's broker footprint (dm_/dlv_ durables + read-ACL row). Split from
   *  {@link deprovision} because it runs LAST in the ordered teardown chain - after the creds/secret
   *  shred and the awaited ledger revoke, which precede it in that same single-flighted chain (the
   *  revoke is awaited and can be deliberately slow, so it is not merely a synchronous prefix). The name
   *  is NOT freed while any teardown phase is still in flight - the hold clears only after the
   *  standing-authority revoke AND the lifecycle retirement both confirm (see {@link driveRetirement}) -
   *  but the deletes here are still lifecycle-uid-pinned so even a replayed/stale teardown can never
   *  reach a same-name successor's footprint (its names embed a different uid). Each call reports its
   *  own accounting: the return value, or the {@link DeprovisionError} it throws once the deletes ran. */
  async deprovisionBroker(a: { id: string; name: string; lifecycleUid: string; launch?: { allowSubscribe: readonly string[] } }): Promise<DeprovisionResourceAccounting> {
    // LIFECYCLE-PINNED (SPEC 13.1): both the credential's exact-name grants and the delete names
    // carry a.lifecycleUid, so a stale/replayed teardown for this retired incarnation is broker-denied
    // against a same-name successor's footprint (its names embed a different uid).
    // Durable membership rows are lifecycle-keyed per concrete channel. Start with the launch's
    // concrete read channels, then include wildcard-covered and unnamed channels from the inventory.
    const memberChannels = new Set((a.launch?.allowSubscribe ?? []).filter(isConcreteChannel));
    // Fence the lifecycle before its inventory is read: its read-ACL row narrowed to no reads, which
    // every durable join re-reads around the row it writes, so a join the inventory does not see
    // removes its own row. A fence that cannot be written makes the inventory incomplete.
    const unfenced = await this.fenceRetiringAcl(a);
    // Complete the set from the delivery daemon's lifecycle-exact inventory, which covers rows on
    // wildcard-granted channels and teardowns that carry no launch spec. An inventory that cannot be
    // read leaves those rows RETAINED and says so; it never widens the delete beyond exact keys.
    const listed = await this.lifecycleMembershipInventory(a);
    const inventory = unfenced === undefined ? listed : { ...listed, complete: false, reason: `the ACL fence was not written (${unfenced})${listed.complete ? "" : `; ${listed.reason}`}` };
    for (const ch of inventory.channels) memberChannels.add(ch);
    if (!inventory.complete)
      console.error(`deprovision ${a.name} (${a.id}): membership inventory incomplete (${inventory.reason}); rows on channels outside its launch policy stay RETAINED for uid ${a.lifecycleUid}`);
    const creds = await mintCreds(this.auth!, newIdentity(), "deprovisioner", {
      deprovisionTarget: { principal: a.id, lifecycleUid: a.lifecycleUid, memberChannels: [...memberChannels] },
    });
    // Bound the detached broker teardown so a wedged broker can't leave the deprovision promise pending
    // forever with no log - the timeout rejects into freeSlot's fail-loud `.catch` (paired with the
    // helper's own fail-fast connect). The durables/ACL row still fall to space teardown as a backstop.
    const accounting = await this.deps.brokerTeardown(
      deprovisionAgent({
        servers: this.servers ?? DEFAULT_SERVER,
        space: this.space,
        targetId: a.id,
        lifecycleUid: a.lifecycleUid,
        memberChannels: [...memberChannels],
        creds,
      }),
      `deprovision ${a.name} (${a.id}): broker teardown timed out`,
    );
    if (!inventory.complete)
      throw new DeprovisionError(`membership inventory incomplete (${inventory.reason}); rows on channels outside its launch policy stay RETAINED for uid ${a.lifecycleUid}`, accounting);
    return accounting;
  }

  /** A cleanup spawned by accepted active-mode work is part of that work for maintenance draining,
   * even where the ordinary control reply remains fire-and-forget. */
  trackDeprovision(a: TeardownTarget, context = ""): void {
    const release = this.deps.trackLifecycle();
    void this.deprovision(a)
      .catch((e) => console.error(`deprovision${context ? ` ${context}` : ""} ${a.name} (${a.id}): ${rejectionText(e)}`))
      .finally(release);
  }
}
