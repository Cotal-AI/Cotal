
import { goalKey } from "./turn-relay.js";
import { MANAGER_ENDPOINT } from "./manager-service-contract.js";
import type { Manager } from "./manager.js";
import { DEV_OWNER, EpEnvelopeError, GOAL_TERMINAL_STATES, actionContext, clearGoalIndex, commitSiblingIssuance, credentialIdOf, drainAndClose, ensureAuthorityStores, epAuthBucket, epeSubject, goalProgressTopic, inspectCredHealth, listGoalIndex, mintCreds, newIdentity, principalKey, readGoalSpec, readGoalStatus, recordsBucket, rejectionText, serveIssuanceGateKv, settleGoalUncertain, standaloneConnectOpts } from "@cotal-ai/core";
import type { ActionContext, EpIssuanceGate, GoalIndexEntry, GoalRef, Identity } from "@cotal-ai/core";
import { jetstreamManager } from "@nats-io/jetstream";
import { Kvm } from "@nats-io/kv";
import type { KV } from "@nats-io/kv";
import type { NatsConnection } from "@nats-io/transport-node";

/** What {@link GoalWriter} reads from the Manager. Every entry is read at use, so a field the Manager
 *  assigns after construction is always current, and a Manager method a test replaces is the one that runs. */
export interface GoalWriterDeps {
  auth: () => Manager["auth"];
  goalAcceptances: () => Manager["goalAcceptances"];
  goalWriter: () => Manager["goalWriter"];
  setGoalWriter: (value: Manager["goalWriter"]) => void;
  goalWriterCreds: () => Manager["goalWriterCreds"];
  setGoalWriterCreds: (value: Manager["goalWriterCreds"]) => void;
  goalWriterIdentity: () => Manager["goalWriterIdentity"];
  leaseStopping: () => Manager["leaseStopping"];
  managerInstanceId: () => Manager["managerInstanceId"];
  readinessTimeoutMs: () => Manager["readinessTimeoutMs"];
  remoteAuthority: () => Manager["remoteAuthority"];
  serviceServe: () => Manager["serviceServe"];
  space: () => Manager["space"];
  turnRelay: () => Manager["turnRelay"];
  goalReconcileDone: () => Manager["goalReconcileDone"];
  setGoalReconcileDone: (value: Manager["goalReconcileDone"]) => void;
  adoptTurnGoal: (...args: Parameters<Manager["adoptTurnGoal"]>) => ReturnType<Manager["adoptTurnGoal"]>;
  boundedReconnect: (...args: Parameters<Manager["boundedReconnect"]>) => ReturnType<Manager["boundedReconnect"]>;
  dial: (...args: Parameters<Manager["dial"]>) => ReturnType<Manager["dial"]>;
  noticeSeatTurns: (...args: Parameters<Manager["noticeSeatTurns"]>) => ReturnType<Manager["noticeSeatTurns"]>;
  renewRemoteBeforeRedial: (...args: Parameters<Manager["renewRemoteBeforeRedial"]>) => ReturnType<Manager["renewRemoteBeforeRedial"]>;
  retireConnection: (...args: Parameters<Manager["retireConnection"]>) => ReturnType<Manager["retireConnection"]>;
  trackTransport: (...args: Parameters<Manager["trackTransport"]>) => ReturnType<Manager["trackTransport"]>;
  withEndpointServeExecutor: <T>(fn: (kvs: { recordsKv: KV; authKv: KV; nc: NatsConnection }) => Promise<T>) => Promise<T>;
}

/** The goal-writer's standing connection, its credential, and the goal index it reconciles at boot. */
export class GoalWriter {
  constructor(private readonly deps: GoalWriterDeps) {}

  // The Manager members these bodies read, under their Manager names. Each reads through its dep at
  // use, so a field the Manager assigns later is current and a method a test replaces on the Manager
  // is the one that runs.
  private get auth() { return this.deps.auth(); }
  private get goalAcceptances() { return this.deps.goalAcceptances(); }
  private get goalWriter() { return this.deps.goalWriter(); }
  private set goalWriter(value: Manager["goalWriter"]) { this.deps.setGoalWriter(value); }
  private get goalWriterCreds() { return this.deps.goalWriterCreds(); }
  private set goalWriterCreds(value: Manager["goalWriterCreds"]) { this.deps.setGoalWriterCreds(value); }
  private get goalWriterIdentity() { return this.deps.goalWriterIdentity(); }
  private get leaseStopping() { return this.deps.leaseStopping(); }
  private get managerInstanceId() { return this.deps.managerInstanceId(); }
  private get readinessTimeoutMs() { return this.deps.readinessTimeoutMs(); }
  private get remoteAuthority() { return this.deps.remoteAuthority(); }
  private get serviceServe() { return this.deps.serviceServe(); }
  private get space() { return this.deps.space(); }
  private get turnRelay() { return this.deps.turnRelay(); }
  private get goalReconcileDone() { return this.deps.goalReconcileDone(); }
  private set goalReconcileDone(value: Manager["goalReconcileDone"]) { this.deps.setGoalReconcileDone(value); }
  private adoptTurnGoal(...args: Parameters<Manager["adoptTurnGoal"]>): ReturnType<Manager["adoptTurnGoal"]> { return this.deps.adoptTurnGoal(...args); }
  private boundedReconnect(...args: Parameters<Manager["boundedReconnect"]>): ReturnType<Manager["boundedReconnect"]> { return this.deps.boundedReconnect(...args); }
  private dial(...args: Parameters<Manager["dial"]>): ReturnType<Manager["dial"]> { return this.deps.dial(...args); }
  private noticeSeatTurns(...args: Parameters<Manager["noticeSeatTurns"]>): ReturnType<Manager["noticeSeatTurns"]> { return this.deps.noticeSeatTurns(...args); }
  private renewRemoteBeforeRedial(...args: Parameters<Manager["renewRemoteBeforeRedial"]>): ReturnType<Manager["renewRemoteBeforeRedial"]> { return this.deps.renewRemoteBeforeRedial(...args); }
  private retireConnection(...args: Parameters<Manager["retireConnection"]>): ReturnType<Manager["retireConnection"]> { return this.deps.retireConnection(...args); }
  private trackTransport(...args: Parameters<Manager["trackTransport"]>): ReturnType<Manager["trackTransport"]> { return this.deps.trackTransport(...args); }
  private withEndpointServeExecutor<T>(fn: (kvs: { recordsKv: KV; authKv: KV; nc: NatsConnection }) => Promise<T>): Promise<T> { return this.deps.withEndpointServeExecutor(fn); }

  /** Mint the standing `goal-writer` credential and STAGE it into this
   *  instance's §13.1 revocation family (`epcred.<e>.<iid>`), over the passed executor's `authKv`
   *  (the scoped `endpoint-serve-executor`, which holds the epcred write grant). The GRANT profile
   *  stays goal-writer-only (Q2, disjoint from the serve credential); only the FAMILY membership
   *  is shared, so the registration barrier's existing enumerate+revoke+evict catches the
   *  goal-writer on takeover/retire with NO barrier code change. Used both at registration (the run
   *  block's `authKv`) and at renewal (a fresh executor's), re-minting the SAME stable nkey with a
   *  fresh bounded exp: `mintCreds` stamps a random `issuance:` tag on `goal-writer` (`userTags`),
   *  so each issuance signs distinct bytes and stages a distinct ledger row (per-JWT `credentialId`
   *  digest) even within one second. */
  async mintAndStageGoalWriter(authKv: KV): Promise<string> {
    const auth = this.auth!;
    const identity = this.goalWriterIdentity!;
    // The issuance gate + §13.1 revocation family are keyed by the REGISTRATION instanceId
    // (the persisted logical id), NOT the per-process lifecycleUid — the barrier
    // enumerates `epcred.<e>.<managerInstanceId>`, so the goal-writer must stage into that family.
    const iid = this.managerInstanceId;
    const creds = await mintCreds(auth, identity, "goal-writer", { goalWriter: { endpoint: MANAGER_ENDPOINT } });
    const exp = inspectCredHealth(creds).exp;
    if (exp === undefined)
      throw new Error(`the goal-writer credential for ${MANAGER_ENDPOINT}/${iid} is unbounded; the §13.1 ledger row requires an expiry`);
    const fence = serveIssuanceGateKv(authKv, this.space, { endpoint: MANAGER_ENDPOINT, instanceId: iid });
    const observed = await fence.observe();
    if (observed === null)
      throw new Error(`the issuance gate for ${MANAGER_ENDPOINT}/${iid} vanished; the goal-writer cannot join its §13.1 revocation family`);
    // The §13.1 open-and-commit fence, the SAME one the serve credential's own mint runs: a frozen
    // gate refuses, and a gate that moved under us loses the CAS and revokes the staged row. Without
    // it a barrier mid-takeover (already past its enumeration) would let this credential land
    // ACTIVE in a family nothing revokes again.
    await commitSiblingIssuance(fence, observed, {
      credentialId: credentialIdOf(creds),
      credentialKey: identity.id,
      holderPrincipal: principalKey(DEV_OWNER, identity.id).key,
      endpoint: MANAGER_ENDPOINT, lifecycleUid: iid, sourceChain: ["root"], state: "active", exp,
      generation: observed.generation, processEpoch: observed.processEpoch,
      registrationRevision: observed.registrationRevision, nameAuthorityRevision: observed.nameAuthorityRevision,
    });
    return creds;
  }
  /** #2073: dial the goal-writer's ONE standing connection and rebuild everything derived from it
   *  (the fence-resolving action context, the issuance-gate reader) — shared by the initial start
   *  and the closed-connection recovery ({@link onGoalWriterConnectionClosed}), so a redial never
   *  leaves the context bound to a dead socket. */
  async dialGoalWriter(
    gw: { nc: NatsConnection; ctx: ActionContext; creds?: string; identity: Identity; gate?: EpIssuanceGate },
  ): Promise<void> {
    const nc = await this.dial({
      ...((this.auth || this.remoteAuthority) ? standaloneConnectOpts({ creds: () => gw.creds!, tls: false }) : {}),
      inboxPrefix: `_INBOX_${gw.identity.id}`,
      maxReconnectAttempts: -1,
    });
    nc.closed().then((err) => { void this.onGoalWriterConnectionClosed(err ?? undefined); });
    this.trackTransport(nc);
    gw.nc = nc;
    // The (i) fence resolver (SPEC 13.6): resolve an executing instance's CURRENT gate
    // epoch. This manager reconciles only ITS OWN goals, so it resolves its own
    // registration instanceId to this incarnation's serve-grant epoch; a foreign/retired instance
    // is `null` (no current terminal to surface). A successor incarnation carries an ADVANCED epoch
    // here, so its reads pick the current-epoch subject and the predecessor's terminal is fenced out.
    gw.ctx = await actionContext(nc, this.space);
    // The own-issuance-gate READER for the currency belt, on BOTH mesh modes. Reads
    // `epgate.<e>.<iid>` over this connection; observe-only (stage/commit/revoke are never called
    // through it — the goal-writer holds no gate/epcred WRITE grant, so a mis-call would
    // broker-deny anyway).
    //
    // OPEN MESH IS NOT EXEMPT, and this is load-bearing. An open-mesh registration mints no
    // credentials, so the §13.1 takeover barrier's revoke-and-evict loop enumerates an EMPTY family
    // and is VACUOUS — yet it still advances processEpoch. The gate row itself DOES exist there
    // (`provisionEndpointGateOpen`, over the authority stores the open serve path ensures), and a
    // bare connection CAN read it (executed probe). So this belt is the ONLY thing standing between
    // a deposed open-mesh incarnation and a wrong terminal on the one create-only result subject.
    //
    // NAME IT HONESTLY: on an open mesh this is a COOPERATIVE fence. The broker enforces nothing, so
    // a hostile or non-conformant process can simply not run the check — the same guarantee class as
    // every other open-mesh property. It is also a read-then-CAS, so it NARROWS the commit window
    // rather than closing it. An AUTH mesh gets durable closure from the §13.1 barrier (revoke +
    // cluster-verified eviction BEFORE the epoch advance); an open mesh gets none.
    gw.gate = serveIssuanceGateKv(await new Kvm(nc).open(epAuthBucket(this.space)), this.space, { endpoint: MANAGER_ENDPOINT, instanceId: this.managerInstanceId });
  }
  /** #2073: the goal-writer rail's closed-connection fault, the same bounded shape the serve rail
   *  uses ({@link onServeConnectionClosed}) through the same {@link boundedReconnect} helper:
   *  re-dial with the current credential (a transport blip needs nothing new), re-mint through the
   *  existing goal-writer renewal branch when the credential itself has expired, then re-attach.
   *  Unlike the serve rail this never exits the process on exhaustion (brief step 4: only the serve
   *  rail is the control plane the report lost) — it logs and leaves the credential to the next
   *  scheduled renewal pass. */
  private async onGoalWriterConnectionClosed(err: Error | undefined): Promise<void> {
    if (this.leaseStopping) return;
    console.error(`! manager goal-writer connection closed: ${err?.message ?? "unknown reason"}`);
    const gw = this.goalWriter;
    const recovered = await this.boundedReconnect("goal-writer", async () => {
      if (!gw) return false;
      if (this.remoteAuthority) await this.renewRemoteBeforeRedial("goal-writer", () => gw.creds);
      else if (gw.creds !== undefined && inspectCredHealth(gw.creds).state !== "healthy") {
        gw.creds = await this.withEndpointServeExecutor(({ authKv }) => this.mintAndStageGoalWriter(authKv));
        this.goalWriterCreds = gw.creds;
      }
      await this.dialGoalWriter(gw);
      console.error("manager goal-writer re-dialed");
      return true;
    }, inspectCredHealth(gw?.creds ?? "").state === "expired");
    if (this.leaseStopping || recovered) return;
    console.error("! manager goal-writer could not be re-dialed; leaving the credential to the next renewal pass");
  }
  /** Spawn-as-action: stand up the standing self-mediated goal-writer connection +
   *  ActionContext. Mode-dual, mirroring {@link registerManagerService}: an AUTH mesh uses the
   *  scoped `goal-writer` credential already minted + family-STAGED inside registration's run block
   *  ({@link mintAndStageGoalWriter} — DISJOINT grant from the serve cred, SHARED §13.1 revocation
   *  family); an OPEN mesh uses a bare connection (no credential system to mint from - the broker
   *  enforces nothing). The connection presents the CURRENT credential on every (re)connect (a
   *  renewal is adopted without reconnecting the whole endpoint); the ActionContext bonds its
   *  KV + JS + JSM to this one connection and space (SPEC 13.4), so a composition mixup cannot splice
   *  goal state across brokers. */
  async startGoalWriter(): Promise<void> {
    const identity = (this.auth || this.remoteAuthority) ? this.goalWriterIdentity! : newIdentity();
    // The mutable holder captured by the authenticator (mirrors the serve connection): a half-TTL
    // renewal updates `gw.creds` and the next (re)connect presents the refreshed credential.
    const gw: { nc: NatsConnection; ctx: ActionContext; creds?: string; identity: Identity; gate?: EpIssuanceGate } =
      { nc: undefined as unknown as NatsConnection, ctx: undefined as unknown as ActionContext, creds: (this.auth || this.remoteAuthority) ? this.goalWriterCreds : undefined, identity };
    await this.dialGoalWriter(gw);
    this.goalWriter = gw;
    console.error(`manager goal-writer standing (endpoint ${MANAGER_ENDPOINT}, ${(this.auth || this.remoteAuthority) ? "scoped cred, §13.1 family-staged" : "open/bare"})`);
  }
  /** Retire the goal-writer connection (best-effort, both exit paths). */
  async stopGoalWriter(): Promise<void> {
    const gw = this.goalWriter;
    if (!gw) return;
    this.goalWriter = undefined;
    await this.retireConnection(gw.nc);
  }
  /** The boot reconcile: a fresh incarnation (a manager restart takes a NEW
   *  instanceId, so the in-memory acceptance map starts empty) inherits the endpoint's accepted-but-
   *  unterminal goals from any predecessor. The local signer enumerates with an ephemeral PROVISIONER.
   *  A remote manager calls the authenticated host-owned scan, which keeps the sealed consumer and its
   *  lifecycle authority on the host; the instance executor, goal-writer, and supervisor hold NO records
   *  consumer grant. Settle each orphan so an accepted goal is NEVER dropped across a restart. Open mesh:
   *  a bare connection (the broker enforces nothing). Runs ONCE at start, BEFORE spawn-as-action begins
   *  accepting (the `goalReconcileDone` gate), so it never races a live goal's acceptance. Never
   *  fatal — a reconcile failure is logged and the gate opens either way. */
  async reconcileGoalIndex(): Promise<void> {
    const gw = this.goalWriter;
    if (!gw) { this.goalReconcileDone = true; return; }
    try {
      let entries: { ref: GoalRef; iid: string; allocated?: GoalIndexEntry["allocated"]; note?: string }[] = [];
      if (this.remoteAuthority) {
        entries = (await this.remoteAuthority.scanGoalIndex()).map((entry) => ({
          ref: { endpoint: entry.endpoint, caller: { owner: entry.owner, actor: entry.actor, uid: entry.uid }, goalId: entry.goalId },
          iid: entry.iid,
          ...(entry.allocated !== undefined ? { allocated: entry.allocated } : {}),
          ...(entry.note !== undefined ? { note: entry.note } : {}),
        }));
      } else {
        const nc = this.auth
          ? await this.dial({ ...standaloneConnectOpts({ creds: await mintCreds(this.auth, newIdentity(), "provisioner"), /* not yet wired to a recorded transport */ tls: false }), maxReconnectAttempts: 0 })
          : await this.dial({ maxReconnectAttempts: 0 });
        try {
          const kvm = new Kvm(nc);
          await ensureAuthorityStores(await jetstreamManager(nc), kvm, this.space);
          entries = await listGoalIndex(await kvm.open(recordsBucket(this.space)), MANAGER_ENDPOINT);
        } finally {
          await drainAndClose(nc);
        }
      }
      // Single-manager: EVERY inherited entry belongs to a DEAD predecessor (only one manager
      // at a time), so all are reconciled. The `iid` field is the hook the multi-instance sweep
      // filters on (skip a goal whose accepting `iid` is a still-LIVE sibling — never settle its goal).
      for (const entry of entries) {
        const key = goalKey(entry.ref);
        if (this.goalAcceptances.has(key) || this.turnRelay.hasAcceptance(key)) continue; // never settle a goal THIS incarnation drives
        try {
          // A note marks a TURN entry: its relay is rebuilt (the hold is its bounded ending), never
          // settled uncertain — the spawn arm's readiness window is the wrong ending for a relay.
          if (entry.note !== undefined) await this.adoptTurnGoal(entry);
          else await this.reconcileOneGoal(entry.ref, entry.iid);
        }
        catch (e) { console.error(`! goal reconcile for ${entry.ref.goalId}: ${rejectionText(e)}`); }
      }
      if (entries.length) console.error(`goal-index boot reconcile: swept ${entries.length} inherited goal(s)`);
    } catch (e) {
      console.error(`! goal-index boot reconcile failed: ${rejectionText(e)} - accepted goals from a predecessor may stay unsettled until the next restart`);
    } finally {
      this.goalReconcileDone = true;
      this.turnRelay.markReconciled(Date.now());
      // A seat that pulled during the window was refused, and a predecessor may have died before
      // its notice went out, so every seat holding a rebuilt turn is told once.
      const seats = this.turnRelay.pendingSeats();
      for (const seat of seats) this.noticeSeatTurns(seat);
    }
  }
  /** Settle ONE inherited goal by evidence: no goal record (a crash between the index write and the
   *  goal-record create) leaves the pointer untouched (never settle a goal that was never accepted,
   *  and clearing it would race a live goal mid-creation); a TERMINAL goal clears the index
   *  (converged — the predecessor committed but died before clearing); a NON-TERMINAL goal settles
   *  `uncertain` (the accepting incarnation is gone, so the success signal will never reach us — the
   *  bounded readiness outcome the plan maps the window to). Within the readiness window it arms a
   *  bounded, unref'd timer to settle at the deadline (an early uncertain would steal a still-possible
   *  success the substrate guards against). */
  private async reconcileOneGoal(ref: GoalRef, acceptedByIid: string): Promise<void> {
    const gw = this.goalWriter;
    if (!gw) return;
    const status = await readGoalStatus(gw.ctx, ref);
    if (status === undefined) return; // index points at no goal record: a dead pointer, left for honesty
    if (GOAL_TERMINAL_STATES.includes(status.value.state)) { await clearGoalIndex(gw.ctx, ref); return; }
    const spec = await readGoalSpec(gw.ctx, ref);
    if (spec === undefined) return; // a status without its spec is garbled — leave for the next boot
    // NEVER A CROSS-INSTANCE SETTLE. The accepting incarnation is recorded on the INDEX ENTRY
    // itself (`iid`, written at accept), which is the honest coordinate: a same-instanceId restart
    // inherits its predecessor's orphans, and a goal accepted by a DIFFERENT (possibly still-live)
    // sibling is left for its owner. This replaces the goal spec's `executor` pin, which existed
    // only to epoch-scope the terminal subject and is gone with it (§13.2 reserved subjects).
    if (acceptedByIid !== this.managerInstanceId) {
      console.error(`goal reconcile ${ref.goalId}: accepted by instance "${acceptedByIid}", not this incarnation "${this.managerInstanceId}"; left for its owner (never a cross-instance settle)`);
      return;
    }
    const settle = async () => {
      // A SUCCESSOR settling work it inherited: the committer is THIS incarnation at its CURRENT
      // serve epoch, which is strictly greater than the goal's acceptedEpoch — the `committed >
      // accepted` arm of the attribution rule, and the reason that arm has to exist.
      await settleGoalUncertain(gw.ctx, { ref, now: Date.now(), committer: { instanceId: this.managerInstanceId, epoch: this.serviceServe?.grant.epoch ?? 0 } }); // first-terminal-wins: a racing terminal returns the winner, no throw
      await clearGoalIndex(gw.ctx, ref);
    };
    const remaining = spec.value.acceptedAt + (spec.value.readinessDeadlineMs ?? this.readinessTimeoutMs) - Date.now();
    if (remaining <= 0) { await settle(); return; }
    console.error(`goal reconcile ${ref.goalId}: within the readiness window (${remaining}ms) - arming a bounded settle`);
    const t = setTimeout(() => { settle().catch((e) => console.error(`! goal reconcile settle ${ref.goalId}: ${rejectionText(e)}`)); }, remaining + 100);
    t.unref?.();
  }
  /** Publish a goal PROGRESS event on the caller-scoped epe subtree, over the SERVE
   *  connection (which holds the `epe.<e>.<iid>.<epoch>.>` egress grant; the goal-writer deliberately
   *  does not). The terminal rides a final event `phase:"terminal"` (the caller follows epe to
   *  the terminal; the durable result fact + inspect/ps are the reconcile authority). A dropped event
   *  is non-fatal (the terminal is authoritative in the journal). */
  emitGoalProgress(ref: GoalRef, epoch: number, event: Record<string, unknown>): void {
    const nc = this.serviceServe?.nc;
    if (!nc) return;
    try {
      nc.publish(
        epeSubject(this.space, MANAGER_ENDPOINT, this.managerInstanceId, epoch, goalProgressTopic(ref)),
        new TextEncoder().encode(JSON.stringify({ v: 1, goalId: ref.goalId, ...event })),
      );
    } catch (e) {
      console.error(`! goal progress emit for ${ref.goalId} failed: ${rejectionText(e)}`);
    }
  }
  /** The own-gate currency belt: before the goal-writer commits a terminal fact, the manager reads
   *  its OWN issuance gate epoch and REFUSES the commit if superseded. This NARROWS the window; it
   *  is not the fence. Layer 1 below is closed by the sibling-mint fence; layers 2 and 3 are not
   *  closed by any planned slice and must not be described as temporary.
   *
   *  THE RESIDUAL, STACKED:
   *   1. SIBLING-MINT INJECTION. A §13.1 barrier's revoke/evict loop closes only over the family
   *      SNAPSHOT IT ENUMERATED, so a sibling mint that observes the gate and stages a ledger row
   *      WITHOUT the observe/open/commit fence can be staged and released AFTER that enumerate and
   *      never be revoked. This layer is closed exactly where BOTH sibling mint sites
   *      ({@link mintAndStageGoalWriter}, {@link mintAndStageSessionLedger}) route their stage
   *      through `commitSiblingIssuance` (the revision-pinned CAS that makes a losing mint release
   *      nothing), and open exactly where they do not — state the mechanism, never the branch.
   *   2. THE BARRIER WINDOW. A gate FREEZE neither kills this connection nor advances the epoch,
   *      and this belt compares `processEpoch` alone, so it still PASSES from barrier start until
   *      the reopen. A ledger revoke marks a row; it does not re-check a live JWT mid-publish. The
   *      durable kill is the CLUSTER-VERIFIED EVICTION, so a deposed manager can INITIATE new
   *      terminal publishes from barrier start until eviction is verified — not merely finish bytes
   *      already on the wire. Successor EXISTENCE and corpse DEATH are different phases, so the
   *      barrier's ordering licenses no conclusion about when the corpse stops being able to write.
   *   3. OPEN MESH. No credential family exists, so the revoke/evict loop is vacuous and this belt
   *      is COOPERATIVE only: a non-conformant process simply does not run it.
   *  The named follow-up that would close 2 and 3 is the gate-linearized commit (routing the
   *  terminal through the issuance gate's own CAS), deliberately deferred as substrate territory. */
  async assertGoalWriterEpochCurrent(epoch: number): Promise<void> {
    const gate = this.goalWriter?.gate;
    if (!gate) return; // no goal-writer standing yet
    const observed = await gate.observe();
    if (observed === null)
      throw new EpEnvelopeError("expired", `the manager's issuance gate for ${MANAGER_ENDPOINT}/${this.managerInstanceId} is gone; a retired incarnation never commits a goal terminal (SPEC 13.1/13.6)`);
    if (observed.processEpoch !== epoch)
      throw new EpEnvelopeError("expired", `the manager's issuance gate epoch is ${observed.processEpoch} but this goal was accepted under epoch ${epoch}; a superseded incarnation never commits a goal terminal (SPEC 13.6)`);
  }
}
