import { drainAndClose } from "@cotal-ai/core";
import { rmSync } from "node:fs";
import { CotalEndpoint, lowerPersonaEndpoints, DEFAULT_SERVER, DEV_OWNER, dialerFor, DeprovisionError, addDeprovisionAccounting, type DeprovisionResourceAccounting, mintCreds, type IssuanceSeam, type IssuedStore, mintLifecycleUid, managedRetirementOpId, newIdentity, principalKey, provisionAgent, grantOverreach, withIssuerSession } from "@cotal-ai/core";
import { agentLifecycleSecretFilePaths, agentSecretKeyForFile, materializeSecretToFile } from "@cotal-ai/workspace";
import type { EpCapability, RuntimeReference, SecretStore, SpaceAuth } from "@cotal-ai/core";
import { makeManagerEndpointEvictionEvidence } from "./endpoint-evict.js";
import { inlineSnapshotPath, removeInlineSnapshot } from "./launch.js";
import { rejectionText, attemptCleanup, describeCleanupFailures, type CleanupFailure } from "@cotal-ai/core";
import { type SeatRecord } from "./resume.js";
import { jetstreamManager } from "@nats-io/jetstream";
import { Kvm } from "@nats-io/kv";
import { recordsBucket, epAuthBucket, ensureAuthorityStores, standaloneConnectOpts, credentialIdOf, STANDING_RENEWABLE_TTL_SEC as MANAGED_STATIC_TTL_SEC, STATIC_GENERATION_HORIZON_SEC, issuedHorizon, type LifecycleStateTransport, type StaticManagedSlotRow } from "@cotal-ai/core";
import { EpEnvelopeError, lifecycleBlockedFrom } from "@cotal-ai/core";
import { type ManagerStaticReconciliationFailure, type ManagerStaticReconciliationStatus, type ManagerStaticReconciliationSweep } from "./manager-service-contract.js";
import type { NatsConnection } from "@nats-io/transport-node";
import type { KV } from "@nats-io/kv";
import { staticLifecycleTransport, activateStaticLifecycle, runStaticTerminal, readStaticSlot, casStaticSlot, recordSlotCredential, appendStaticCredentialRow, planStaticSlotResume, ownedBySibling, walkStaticSlots } from "./static-lifecycle.js";
import { CHAT_EXPIRY_CONCURRENCY, ChatSessionExpiry, chatOpenLists, chatRetireRefusal, drawChatAlias, isChatAlias, readChatOpenInput, readChatRetireInput, sealChatAdmission, type ExpiringChatSession } from "./chat-session.js";
import type { Manager, ManagedAgent } from "./manager.js";
import type { TeardownTarget, RetirementHold } from "./retirement.js";
import type { EvictionResult } from "@cotal-ai/core";
import { foreignEventChannels } from "./seat-launch.js";


/** One initial terminal entry plus three re-drives. The short first retry absorbs a one-shot
 *  broker/eviction blip; the wider later spacing avoids hammering a persistently unavailable
 *  authority. The finite ~36s window is intentionally not a liveness inference: exhausting it
 *  leaves the durable alias held and requires a later manager start. */
export const STATIC_RECONCILE_RETRY_DELAYS_MS = [1_000, 5_000, 30_000] as const;

const STATIC_RECONCILE_MAX_ATTEMPTS = STATIC_RECONCILE_RETRY_DELAYS_MS.length + 1;


type StaticReconcileItem = ManagerStaticReconciliationFailure & {
  owner: string;
  timer?: ReturnType<typeof setTimeout>;
  flight?: Promise<StaticReconcileAttempt>;
  retryFlight?: Promise<void>;
};


/** One exact-terminal attempt's outcome, with the accounting of the broker teardown that attempt
 *  ran, whether it succeeded or failed. Absent when the attempt reached no broker teardown. */
interface StaticReconcileAttempt {
  succeeded: boolean;
  deprovision?: DeprovisionResourceAccounting;
}
const DEPROVISION_TIMEOUT_MS = 15_000;

/** Manager-owned authority, runtime and retirement operations for static lifecycle work. */
export interface ManagedStaticLifecycleDeps {
  space: () => string;
  servers: () => string | undefined;
  auth: () => SpaceAuth | undefined;
  secrets: () => SecretStore;
  workspaceRoot: () => string;
  instanceId: () => string;
  processUid: () => string;
  userMode: () => boolean;
  eventPayloadsWithheld: () => boolean;
  evictor: () => ((principal: string) => Promise<EvictionResult>) | undefined;
  retryDelays: () => readonly number[];
  resumeRequired: () => boolean;
  records: () => KV | undefined;
  agentFor: (name: string) => ManagedAgent | undefined;
  retirementFor: (name: string) => RetirementHold | undefined;
  recordStaticRetirement: (a: { id: string; name: string; lifecycleUid: string }) => void;
  noteRetiredPrincipal: (principal: string) => void;

  foreignEventChannels: (channels: readonly string[], owner: string, actor: string) => string[];
  withIssuer: <T>(fn: (i: { store: IssuedStore; accepted: KV }) => Promise<T>) => Promise<T>;
  deprovisionBroker: (a: { id: string; name: string; lifecycleUid: string; launch?: { allowSubscribe: readonly string[] } }) => Promise<DeprovisionResourceAccounting>;
  reapOrphanSeat: (a: { name: string; runtime?: RuntimeReference }) => Promise<void>;
  withLifecycleExecutor: <T>(pin: { owner: string; actor: string; lifecycleUid: string; alias: string }, fn: (t: LifecycleStateTransport) => Promise<T>) => Promise<T>;
  readerRemedy: (owner: string, channel: string) => string;
  withProvisioner: <T>(fn: (prov: CotalEndpoint) => Promise<T>) => Promise<T>;
  beginLifecycle: (resumeOperation?: boolean) => (() => void) | undefined;
  maintenanceError: () => string;
  withRetirementSlot: <T>(run: () => Promise<T>) => Promise<T>;
  managedStaticInstanceReads: (capabilities: readonly string[] | undefined) => EpCapability[];
  issuanceSeam: (i: { store: IssuedStore; accepted: KV }, mode: "issue" | "renew", a: { name: string; id: string; lifecycleUid: string }, exp: number) => IssuanceSeam;
  refreshSeatRecord: (a: ManagedAgent) => void;
  dial: (opts: Parameters<ReturnType<typeof dialerFor>>[0]) => Promise<NatsConnection>;
  seatRecordFor: (row: StaticManagedSlotRow) => SeatRecord | undefined;
  restartSupervisedSeat: (row: StaticManagedSlotRow, record: SeatRecord) => Promise<string | undefined>;
  adoptSeat: (row: StaticManagedSlotRow, record: SeatRecord) => Promise<string | undefined>;
  dropSeatRecord: (a: { name: string; lifecycleUid: string }) => void;
}

/** Builds the {@link ManagedStaticLifecycleDeps} for a Manager. It reads Manager members by name at each use, so a
 *  field the Manager assigns later is current and a member a test replaces on the instance is the one that runs. */
export function managedStaticLifecycleDeps(m: Manager): ManagedStaticLifecycleDeps {
  return {
    space: () => m["space"],
    servers: () => m["servers"],
    auth: () => m["auth"],
    secrets: () => m["secrets"],
    workspaceRoot: () => m["workspaceRoot"],
    instanceId: () => m["managerInstanceId"],
    processUid: () => m["managerLifecycleUid"],
    userMode: () => m["userMode"],
    eventPayloadsWithheld: () => m["eventPayloadsWithheld"],
    evictor: () => m["staticLifecycleEvict"],
    retryDelays: () => m["staticReconcileRetryDelaysMs"],
    resumeRequired: () => m["resumeRequired"],
    records: () => m["goalWriter"]?.ctx.kv,
    agentFor: (name) => m["agents"].get(name),
    retirementFor: (name) => m["retirement"].held(name),
    recordStaticRetirement: (a) => m["retirement"].recordStaticRetirement(a),
    noteRetiredPrincipal: (principal) => { m["retirement"].rememberRetired(principal); },

    foreignEventChannels: (channels, owner, actor) => foreignEventChannels(channels, owner, actor),
    withIssuer: (fn) => m["withIssuer"](fn),
    deprovisionBroker: (a) => m["deprovisionBroker"](a),
    reapOrphanSeat: (a) => m["reapOrphanSeat"](a),
    withLifecycleExecutor: (pin, fn) => m["withLifecycleExecutor"](pin, fn),
    readerRemedy: (owner, channel) => m["readerRemedy"](owner, channel),
    withProvisioner: (fn) => m["withProvisioner"](fn),
    beginLifecycle: (resumeOperation) => m["beginLifecycle"](resumeOperation),
    maintenanceError: () => m["maintenanceError"](),
    withRetirementSlot: (run) => m["withRetirementSlot"](run),
    managedStaticInstanceReads: (capabilities) => m["managedStaticInstanceReads"](capabilities),
    issuanceSeam: (i, mode, a, exp) => m["issuanceSeam"](i, mode, a, exp),
    refreshSeatRecord: (a) => m["refreshSeatRecord"](a),
    dial: (opts) => m["dial"](opts),
    seatRecordFor: (row) => m["seatRecordFor"](row),
    restartSupervisedSeat: (row, record) => m["restartSupervisedSeat"](row, record),
    adoptSeat: (row, record) => m["adoptSeat"](row, record),
    dropSeatRecord: (a) => m["dropSeatRecord"](a),
  };
}

/** Static chat admission, credential renewal, terminal cleanup and resumable reconciliation. */
export class ManagedStaticLifecycle {

  /** Static aliases whose startup exact-op terminal is still in flight. Scoped per alias: control
   * serves during the sweep, but no caller can reuse or attach an alias the sweep still owns. */
  private readonly reconcilingAliases = new Set<string>();
  /** In-flight static chat-session terminals, by lifecycle UID, so every caller that retires one
   *  session joins one terminal instead of racing its CAS sequence. */
  private readonly chatRetirements = new Map<string, Promise<void>>();
  /** The expiry side of every chat session this process admitted and nothing retired sooner. */
  private readonly chatExpiry = new ChatSessionExpiry((session) => this.expireStaticChatSession(session), {
    retryDelaysMs: STATIC_RECONCILE_RETRY_DELAYS_MS,
    concurrency: CHAT_EXPIRY_CONCURRENCY,
    log: (line) => console.error(line),
  });
  /** Current failed/recovered static reconciliation coordinates. This is an operator snapshot, not
   *  lifecycle authority: every re-drive re-reads broker KV and re-runs planStaticSlotResume. */
  private readonly staticReconcileItems = new Map<string, StaticReconcileItem>();
  private staticReconcileLastSweep?: ManagerStaticReconciliationSweep;
  private staticReconcileLastSweepResources?: {
    slots: {
      examined: number;
      retired: number;
      preservedForeign: number;
      preservedAdopted: number;
      deferred: number;
      terminalized: number;
      failed: number;
    };
    deprovision?: DeprovisionResourceAccounting;
  };
  private staticReconcileSweepsInFlight = 0;
  private staticReconcileDrainWaiters: Array<() => void> = [];
  private staticReconcileStopping = false;
  constructor(private readonly deps: ManagedStaticLifecycleDeps) {}

  start(): void { this.staticReconcileStopping = false; }
  get stopping(): boolean { return this.staticReconcileStopping; }
  isReconciling(alias: string): boolean { return this.reconcilingAliases.has(alias); }
  get sweepsInFlight(): number { return this.staticReconcileSweepsInFlight; }
  pendingLifecycle(uid: string): boolean {
    return this.staticReconcileSweepsInFlight > 0 || [...this.staticReconcileItems.values()].some((item) => item.lifecycleUid === uid && item.disposition !== "recovered");
  }
  resources(): Manager["staticReconcileLastSweepResources"] { return this.staticReconcileLastSweepResources; }
  setResources(value: Manager["staticReconcileLastSweepResources"]): void { this.staticReconcileLastSweepResources = value; }
  stop(): void {
    this.staticReconcileStopping = true;
    this.chatExpiry.stop();
    for (const item of this.staticReconcileItems.values()) {
      if (item.timer) clearTimeout(item.timer);
      item.timer = undefined;
      item.nextRetryAt = undefined;
    }
  }

  /** The static terminal for one departed incarnation: delegates the gate/head CAS
   *  sequence to the shared core saga over the executor transport; the footprint teardown (creds
   *  file + broker durables/ACL) runs INSIDE the barrier as its cleanup step. On completion the
   *  wire principal joins {@link retiredPrincipals} (the retired-principal refusal index) and the name hold
   *  clears (ABA-guarded by uid). A lifecycle with no slot row (spawned before the
   *  durable registry existed) has nothing to terminalize: its footprint teardown runs directly
   *  and the hold clears, the honest upgrade path. `onDeprovision` receives the accounting of the
   *  broker teardown this call ran, on success or on a {@link DeprovisionError}. */
  async driveStaticRetirement(a: TeardownTarget, surfaceFailure = false, onDeprovision?: (accounting: DeprovisionResourceAccounting) => void): Promise<void> {
    // A renewal that published its flight before the synchronous terminal latch is accepted work.
    // Drain it before the durable terminal enumerates credential ids and before cleanup deletes its
    // material; a failed renewal must not block retirement because it may still have staged an id.
    const acceptedRenewal = a.staticCredentialRenewal;
    if (acceptedRenewal) await acceptedRenewal.catch(() => {});
    const opId = managedRetirementOpId(a.lifecycleUid);
    const evict = this.deps.evictor() ?? makeManagerEndpointEvictionEvidence({
      space: this.deps.space(),
      servers: this.deps.servers() ?? DEFAULT_SERVER,
      auth: this.deps.auth()!,
      log: (line) => console.error(`static retirement ${a.name}: ${line}`),
      // A daemon credential reload briefly removes its responder while it reconnects.
      unreachableWaitMs: DEPROVISION_TIMEOUT_MS,
    });
    const cleanup = async (): Promise<void> => {
      // SPEC 13.15: every issuance bound to this incarnation's ledger family is retired here,
      // inside the barrier and after the ledger rows were revoked (the source is frozen first,
      // then the index is walked). A retirement that lost is surfaced, never skipped: an active
      // attempt row on a retired lifecycle would authorize a run the credential no longer can.
      const retired = await this.deps.withIssuer((i) => i.store.retireSource({ space: this.deps.space(), bucket: epAuthBucket(this.deps.space()), key: `cred.${a.lifecycleUid}` }));
      if (retired > 0) console.error(`static retirement ${a.name}: retired ${retired} issuance(s) bound to uid ${a.lifecycleUid}`);
      const secrets = this.deps.secrets();
      const files = a.secretPaths ?? agentLifecycleSecretFilePaths(this.deps.workspaceRoot(), this.deps.space(), a.name, a.lifecycleUid);
      // The broker teardown mints its own credential, so a creds file that cannot be removed must not
      // skip it. The failures are thrown together, so the terminal still stops at an incomplete cleanup.
      const failed: CleanupFailure[] = [];
      if (files.creds) {
        const creds = files.creds;
        await attemptCleanup(failed, `secret ${creds}`, () => secrets.delete(agentSecretKeyForFile(creds, this.deps.space())));
        await attemptCleanup(failed, `file ${creds}`, () => rmSync(creds, { force: true }));
      }
      // The lifecycle's inline snapshot, when no earlier step settled it. Keyed by the uid, so a boot
      // sweep or a reconcile that knows only the slot row removes it too.
      if (!a.snapshotSettled) {
        const snapshot = inlineSnapshotPath(this.deps.workspaceRoot(), a.lifecycleUid);
        await attemptCleanup(failed, `file ${snapshot}`, () => removeInlineSnapshot(this.deps.workspaceRoot(), a.lifecycleUid));
      }
      await attemptCleanup(failed, "broker teardown", async () => {
        try {
          const accounting = await this.deps.deprovisionBroker(a);
          onDeprovision?.(accounting);
        } catch (e) {
          if (e instanceof DeprovisionError) onDeprovision?.(e.accounting);
          throw e;
        }
      });
      if (failed.length) throw new Error(`cleanup failed: ${describeCleanupFailures(failed)}`);
    };
    // The process goes before its footprint: reap the orphan seat by reference, then tear down.
    const reapThenCleanup = async (): Promise<void> => {
      await this.deps.reapOrphanSeat(a);
      await cleanup();
    };
    try {
      await this.deps.withLifecycleExecutor({ owner: DEV_OWNER, actor: a.id, lifecycleUid: a.lifecycleUid, alias: a.name }, async (t) => {
        const slot = await readStaticSlot(t, DEV_OWNER, a.name);
        if (slot === undefined || slot.row.lifecycleUid !== a.lifecycleUid) {
          // No durable registration for THIS incarnation: a spawn from before the registry (or a slot already
          // replaced by a successor - then this stale teardown must not touch the registry at all).
          await reapThenCleanup();
          return;
        }
        await runStaticTerminal(
          t,
          {
            owner: DEV_OWNER, alias: a.name, actor: a.id, lifecycleUid: a.lifecycleUid, opId,
            managerInstance: this.deps.instanceId(), managerProcessUid: this.deps.processUid(),
          },
          { cleanup: reapThenCleanup, evict, log: (line) => console.error(`static retirement ${a.name}: ${line}`) },
        );
      });
      this.deps.recordStaticRetirement(a);
    } catch (e) {
      const h = this.deps.retirementFor(a.name);
      if (h && h.target.lifecycleUid === a.lifecycleUid)
        h.lastError = `the static retirement did not complete (${rejectionText(e)}); the name stays held - a same-name spawn retries the same terminal (op ${opId})`;
      console.error(`static retirement ${a.name} (${a.id}): ${rejectionText(e)}`);
      if (surfaceFailure) throw e;
    }
  }

  /** `chat-session-open`: admit one static chat session. The manager draws the `chat_` alias and a
   *  fresh nkey identity, then runs the same native steps a static spawn does: the slot intent and
   *  the shared activation saga, the provisioner's bind-only DM and DELIVER durables plus the ACL
   *  row, and the agent-profile mint. The leaf carries the spawn's three lists under the spawn's
   *  rules (`resolveReadAcl`, a default-deny post list, the foreign event-channel refusal) and
   *  nothing else: no role (so no TASK queue), no capabilities, no endpoint rows, no issuance. It
   *  expires at `ttl` with no renewal, because no managed row exists to renew it.
   *
   *  The session is registered with the tracker before the first durable write and scheduled for
   *  its expiry before the reply is sent, or after a rollback that did not complete, so this
   *  process retires it at the expiry even when the reply is lost or the client never retires.
   *
   *  The credential is ledgered before it leaves this process (slot credentialId, then the `cred.`
   *  row), so the static terminal marks the row revoked and verify-evicts the session's principal;
   *  the broker keeps accepting the leaf until its expiry. The direct ledger write is deliberate:
   *  the leaf is not an issuance, so the issuance seam, which writes the same row inside its
   *  finalization, never runs for it, and without the row the terminal's eviction set would be
   *  empty. The credential leaves only sealed to `sealTo`, bound to the space, this instance and
   *  the reply's fields, so a reply printed anywhere carries no usable credential. A failure at
   *  any step drives the terminal before the refusal is returned, and the refusal says whether it
   *  completed. */
  async openStaticChatSession(raw: unknown): Promise<{ alias: string; actor: string; lifecycleUid: string; expiresAt: number; sealer: string; sealed: string }> {
    if (!this.deps.auth() || this.deps.userMode())
      throw new EpEnvelopeError("unimplemented", "chat-session-open admits static chat sessions only, and this manager is not a static-auth manager", undefined, "not-executed");
    const input = readChatOpenInput(raw);
    if ("error" in input) throw new EpEnvelopeError("bad-request", input.error, undefined, "not-executed");
    const lists = chatOpenLists(input);
    if ("error" in lists) throw new EpEnvelopeError("bad-request", lists.error, undefined, "not-executed");
    const alias = drawChatAlias();
    const identity = newIdentity();
    // The spawn's rule, against the drawn actor: a concrete event channel of any other principal is
    // refused, and a wildcard is an ordinary grant.
    const foreign = this.deps.foreignEventChannels([...lists.allowSubscribe, ...lists.allowPublish], DEV_OWNER, identity.id);
    if (foreign.length)
      throw new EpEnvelopeError("bad-request",
        `chat-session-open asks for another agent's event channel: ${foreign.join(", ")}. A session may be granted its OWN event plane and no other, because that plane carries the session's tool inputs and outputs. Grant a reader out of band rather than through a chat session: ${this.deps.readerRemedy(DEV_OWNER, foreign[0]!)}`,
        undefined, "not-executed");
    const lifecycleUid = mintLifecycleUid();
    const exp = Math.floor(Date.now() / 1000) + input.ttl;
    const pin = { owner: DEV_OWNER, actor: identity.id, lifecycleUid, alias };
    const session: ExpiringChatSession = { alias, actor: identity.id, lifecycleUid, channels: lists.allowSubscribe, expiresAt: exp * 1000 };
    // Registered before the first durable write, so the startup sweep never mistakes this opening's
    // provisioning row for a crashed spawn, and the stop knows it.
    try {
      this.chatExpiry.register(session);
    } catch (e) {
      throw new EpEnvelopeError("unavailable", rejectionText(e), undefined, "not-executed");
    }
    try {
      await this.deps.withLifecycleExecutor(pin, (t) =>
        activateStaticLifecycle(t, { owner: DEV_OWNER, alias, actor: identity.id, lifecycleUid, managerInstance: this.deps.processUid(), ownerInstanceId: this.deps.instanceId() }),
      );
      const creds = await this.deps.withProvisioner((prov) =>
        provisionAgent(prov, this.deps.auth()!, identity, { subscribe: lists.subscribe, allowSubscribe: lists.allowSubscribe, allowPublish: lists.allowPublish, lifecycleUid, expiresAt: exp }),
      );
      // The same credential id the issuance path derives, so a re-sent identical credential maps to
      // the same row.
      const credentialId = credentialIdOf(creds);
      await this.deps.withLifecycleExecutor(pin, async (t) => {
        await recordSlotCredential(t, DEV_OWNER, alias, lifecycleUid, credentialId);
        await appendStaticCredentialRow(t, { lifecycleUid, credentialId, holderPrincipal: principalKey(DEV_OWNER, identity.id).key, exp });
        const slot = await readStaticSlot(t, DEV_OWNER, alias);
        if (slot === undefined || slot.row.lifecycleUid !== lifecycleUid || slot.row.phase !== "provisioning")
          throw new Error(`the static slot for "${alias}" is ${slot === undefined ? "absent" : `${slot.row.phase} at uid ${slot.row.lifecycleUid}`}, not this opening's provisioning intent`);
        await casStaticSlot(t, { ...slot.row, phase: "active" }, slot.revision);
      });
      const { sealer, sealed } = sealChatAdmission({
        space: this.deps.space(), managerInstanceId: this.deps.instanceId(), alias, actor: identity.id, lifecycleUid, expiresAt: exp * 1000, sealTo: input.sealTo, creds,
      });
      this.chatExpiry.arm(lifecycleUid);
      console.error(`chat session ${alias} admitted as ${identity.id} (uid ${lifecycleUid}), expires ${new Date(exp * 1000).toISOString()}`);
      return { alias, actor: identity.id, lifecycleUid, expiresAt: exp * 1000, sealer, sealed };
    } catch (e) {
      // A confirmed rollback leaves a known state, a retired slot. An unconfirmed one does not, so
      // the session stays registered and its expiry, or the stop, retries the same terminal.
      let rollback: string | undefined;
      try {
        await this.chatTerminal(session);
      } catch (r) {
        rollback = rejectionText(r);
        try {
          this.chatExpiry.arm(lifecycleUid);
        } catch (t) {
          rollback += `; ${rejectionText(t)}`;
        }
      }
      throw new EpEnvelopeError(e instanceof EpEnvelopeError ? e.code : "unavailable",
        `chat-session-open did not complete for ${alias}: ${rejectionText(e)}; ${rollback === undefined ? "its rollback retired the slot" : `its rollback was not confirmed (${rollback}), so the slot stays held until a retire, its expiry here, this manager's stop, or the next start of this manager instance`}`,
        undefined, rollback === undefined ? "executed" : "unknown");
    }
  }

  /** `chat-session-retire`: end one static chat session through the native static terminal (ledger
   *  row marked revoked, verified eviction of its principal's live connections, footprint cleanup,
   *  gate and head retirement). It refuses before any effect unless {@link admitChatRetirement}
   *  admits the request. A terminal that cannot complete answers `failed` with the reason, never
   *  success; the slot stays held. The broker keeps accepting the leaf until its expiry either way. */
  async retireStaticChatSession(raw: unknown): Promise<{ outcome: "retired" | "alreadyRetired" | "failed"; reason?: string }> {
    if (!this.deps.auth() || this.deps.userMode())
      throw new EpEnvelopeError("unimplemented", "chat-session-retire retires static chat sessions only, and this manager is not a static-auth manager", undefined, "not-executed");
    const input = readChatRetireInput(raw);
    if ("error" in input) throw new EpEnvelopeError("bad-request", input.error, undefined, "not-executed");
    if (await this.admitChatRetirement(input) === "alreadyRetired") return { outcome: "alreadyRetired" };
    try {
      await this.chatTerminal({ ...input, channels: this.chatExpiry.channels(input.lifecycleUid) });
    } catch (e) {
      return { outcome: "failed", reason: `retirement pending: ${rejectionText(e)}` };
    }
    return { outcome: "retired" };
  }

  /** The expiry cleanup's retirement of one session this process admitted. It is lifecycle work, so
   *  it is admitted like a control call and a stop drains it. A throw is a failure the tracker
   *  retries; a slot that is no longer this instance's to retire ends the tracking instead. */
  async expireStaticChatSession(session: ExpiringChatSession): Promise<void> {
    const release = this.deps.beginLifecycle();
    if (!release) throw new Error(this.deps.maintenanceError());
    try {
      console.error(`chat session ${session.alias} (uid ${session.lifecycleUid}) reached its expiry; retiring it`);
      let admitted: "admitted" | "alreadyRetired";
      try {
        admitted = await this.admitChatRetirement(session);
      } catch (e) {
        if (e instanceof EpEnvelopeError && (e.code === "not-found" || e.code === "failed-precondition")) {
          console.error(`! chat session ${session.alias} expired, but its slot is not this instance's to retire (${e.message}); expiry tracking ends`);
          return;
        }
        throw e;
      }
      if (admitted === "admitted") await this.chatTerminal(session);
    } finally {
      release();
    }
  }

  /** The ownership admission shared by `chat-session-retire`, the expiry and the stop. It throws a
   *  not-executed refusal unless the alias is a chat alias whose slot this logical instance owns
   *  at the requested UID and actor. An already retired slot ends its expiry tracking. */
  async admitChatRetirement(s: { alias: string; actor: string; lifecycleUid: string }): Promise<"admitted" | "alreadyRetired"> {
    if (!isChatAlias(s.alias))
      throw new EpEnvelopeError("permission-denied", `"${s.alias}" is not a chat session alias`, undefined, "not-executed");
    if (this.reconcilingAliases.has(s.alias))
      throw new EpEnvelopeError("unavailable", `the chat session "${s.alias}" is still reconciling at manager startup; that terminal owns it`, undefined, "not-executed");
    const recordsKv = this.deps.records();
    if (!recordsKv)
      throw new EpEnvelopeError("unavailable", `the durable static slot store is not ready while retiring "${s.alias}"`, undefined, "not-executed");
    let slot;
    try {
      slot = await readStaticSlot(staticLifecycleTransport(recordsKv, recordsKv), DEV_OWNER, s.alias);
    } catch (e) {
      throw new EpEnvelopeError("unavailable", `the durable slot for "${s.alias}" could not be read: ${rejectionText(e)}`, undefined, "not-executed");
    }
    const refused = chatRetireRefusal(slot?.row, s, this.deps.instanceId());
    if (refused) throw new EpEnvelopeError(refused.code, refused.message, undefined, "not-executed");
    if (slot!.row.phase !== "retired") return "admitted";
    this.chatExpiry.forget(s.lifecycleUid);
    return "alreadyRetired";
  }

  /** One static terminal per chat session UID, however many callers ask: the explicit retire, the
   *  expiry cleanup and the open's rollback join it instead of racing its CAS sequence. A completed
   *  terminal ends the expiry tracking. `channels` names the membership rows to delete by name;
   *  without it the delivery inventory alone finds them. */
  chatTerminal(s: { alias: string; actor: string; lifecycleUid: string; channels?: readonly string[] }): Promise<void> {
    let flight = this.chatRetirements.get(s.lifecycleUid);
    if (!flight) {
      flight = this.deps.withRetirementSlot(() => this.driveStaticRetirement({ id: s.actor, name: s.alias, lifecycleUid: s.lifecycleUid, secretPaths: {}, ...(s.channels ? { launch: { allowSubscribe: s.channels } } : {}) }, true))
        .then(() => this.chatExpiry.forget(s.lifecycleUid))
        .finally(() => this.chatRetirements.delete(s.lifecycleUid));
      this.chatRetirements.set(s.lifecycleUid, flight);
    }
    return flight;
  }

  /** Whether `row` is a chat slot this process registered, at its exact alias, actor and UID,
   *  under this logical instance and this process's incarnation. */
  holdsLiveChatSlot(row: StaticManagedSlotRow): boolean {
    return row.ownerInstanceId === this.deps.instanceId() && row.managerInstance === this.deps.processUid() && this.chatExpiry.holdsExact(row);
  }

  /** The stop's retirement of every chat session this process still tracks, through the same
   *  ownership admission and terminal as `chat-session-retire`, at most
   *  {@link CHAT_EXPIRY_CONCURRENCY} at a time. It runs after the lifecycle fence closed and every
   *  admitted operation drained, as the seat teardown does, and mints nothing the terminal does not
   *  already mint. Every outcome is logged. It throws, naming each one, when any session was not
   *  retired; that session stays held until the next start of this manager instance. */
  async retireChatSessionsOnStop(): Promise<void> {
    const queue = this.chatExpiry.remaining();
    const failed: string[] = [];
    const retireOne = async (session: ExpiringChatSession): Promise<void> => {
      const at = `chat session ${session.alias} (uid ${session.lifecycleUid})`;
      try {
        if (await this.admitChatRetirement(session) === "alreadyRetired") {
          console.error(`${at} was already retired at stop`);
          return;
        }
        await this.chatTerminal(session);
        console.error(`${at} retired at stop`);
      } catch (e) {
        if (e instanceof EpEnvelopeError && (e.code === "not-found" || e.code === "failed-precondition")) {
          this.chatExpiry.forget(session.lifecycleUid);
          console.error(`! ${at} was not retired at stop: its slot is not this instance's to retire (${e.message})`);
          return;
        }
        failed.push(`${session.alias} (uid ${session.lifecycleUid}): ${rejectionText(e)}`);
        console.error(`! ${at} was not retired at stop (${rejectionText(e)}); it stays held until the next start of this manager instance`);
      }
    };
    await Promise.all(Array.from({ length: Math.min(CHAT_EXPIRY_CONCURRENCY, queue.length) }, async () => {
      for (let next = queue.shift(); next !== undefined; next = queue.shift()) await retireOne(next);
    }));
    if (failed.length)
      throw new Error(`${failed.length} chat session(s) were not retired and stay held until the next start of this manager instance: ${failed.join("; ")}`);
  }

  /** Name, at a stop that does not retire them, each chat session this process still tracks. */
  reportChatSessionsLeftAtStop(why: string): void {
    for (const session of this.chatExpiry.remaining())
      console.error(`! chat session ${session.alias} (uid ${session.lifecycleUid}) was not retired because ${why}; the next start of this manager instance retires it`);
  }

  /** Push renewal of ONE live managed-static credential: re-mint the SAME nkey
   *  identity with the SAME scope (recorded on the managed row at spawn) and a fresh bounded
   *  exp, ledger the new credentialId (slot record first, then the row, then the file - a
   *  credential is never materialized before its ledger row exists), and re-sign the SAME
   *  lifecycle-keyed file the agent endpoint's source seam re-reads. Never advances the epoch;
   *  renewal remains the THIRD transition. */
  async renewManagedStaticCred(a: ManagedAgent): Promise<void> {
    if (!this.deps.auth() || !a.seed || !a.secretPaths?.creds) throw new Error("renewManagedStaticCred: not a renewable managed-static agent");
    // Admission is synchronous. An accepted renewal publishes its flight before its first caller can
    // terminalize the agent; terminalization rejects later callers and drains this flight before the
    // durable terminal starts, giving renewal-before-terminal and terminal-before-renewal one order.
    if (a.terminalizing) throw new Error("renewManagedStaticCred: the lifecycle is terminalizing; no credential is minted after the terminal begins");
    if (a.staticCredentialRenewal) return a.staticCredentialRenewal;
    const renewal = this.driveManagedStaticCredRenewal(a).finally(() => {
      if (a.staticCredentialRenewal === renewal) a.staticCredentialRenewal = undefined;
    });
    a.staticCredentialRenewal = renewal;
    return renewal;
  }

  async driveManagedStaticCredRenewal(a: ManagedAgent): Promise<void> {
    // The SAME permission scope the spawn minted (recorded on the managed row): allowSubscribe/
    // allowPublish/role/capabilities are the JWT-shaping inputs; `subscribe` (the active read
    // set) shapes durable membership only and is not a mint input.
    if (!a.issued)
      throw new Error(`renewManagedStaticCred: ${a.name} carries no issuance; a static credential minted before SPEC 13.15 is not renewed under an unbound generation - respawn the agent`);
    // A renewal never outlives the generation's horizon, and none is minted at or past it: the
    // generation then authorizes nothing and its rows are being removed (SPEC 13.15).
    const now = Math.floor(Date.now() / 1000);
    const horizon = issuedHorizon(a.issued.generation);
    if (now >= horizon)
      throw new Error(`renewManagedStaticCred: ${a.name}'s issued generation reached its horizon ${new Date(horizon * 1000).toISOString()} (${STATIC_GENERATION_HORIZON_SEC / 86_400} days after its spawn) and is not renewed - respawn the agent (rotation instead of this cap: Cotal-AI/Cotal#4942)`);
    const exp = Math.min(now + MANAGED_STATIC_TTL_SEC, horizon);
    // A RENEWAL keeps the generation (SPEC 13.15): the same JWT-shaping inputs produce the same
    // ceiling, which `confirm` verifies against the recorded evidence before the ledger append. A
    // changed ceiling is refused there: that is a fresh issuance on a new connection, never a renewal.
    const issued = a.issued;
    const endpoints = lowerPersonaEndpoints(a.launch.endpoints);
    const reads = this.deps.managedStaticInstanceReads(a.launch.capabilities);
    if (reads.length) {
      // Resolve this incarnation's original issuance, not its current spawner or a reconstructed
      // run admission. Old seats and run helpers keep the exact ceiling they were minted with.
      const caller = { owner: DEV_OWNER, actor: a.id, uid: a.lifecycleUid, generation: issued.generation };
      const { evidence } = await withIssuerSession({ servers: this.deps.servers() ?? DEFAULT_SERVER, space: this.deps.space(), auth: this.deps.auth()!, tls: false }, (s) =>
        s.store.resolve({ space: this.deps.space(), ...caller }, s.sourceIsLive));
      if (!grantOverreach(this.deps.space(), caller, evidence.permissions, { endpoints: reads }).length)
        endpoints.push(...reads);
    }
    const creds = await this.deps.withIssuer((i) =>
      mintCreds(this.deps.auth()!, { id: a.id, seed: a.seed! }, "agent", {
        eventPayloads: this.deps.eventPayloadsWithheld() ? false : a.launch.eventPayloads,
        allowSubscribe: a.launch.allowSubscribe,
        allowPublish: a.launch.allowPublish,
        role: a.role,
        capabilities: a.launch.capabilities,
        ...(endpoints.length ? { endpointCapabilities: endpoints } : {}),
        lifecycleUid: a.lifecycleUid,
        expiresAt: exp,
        issued,
        issuance: this.deps.issuanceSeam(i, "renew", a, exp),
      }),
    );
    const secrets = this.deps.secrets();
    const credsPath = a.secretPaths!.creds!;
    await secrets.put(agentSecretKeyForFile(credsPath, this.deps.space()), creds);
    await materializeSecretToFile(secrets, agentSecretKeyForFile(credsPath, this.deps.space()), credsPath);
    // The record pins the credential's digest, so it follows the re-signed file.
    this.deps.refreshSeatRecord(a);
    console.error(`managed cred renewal ${a.name}: re-signed for the same identity (exp +${exp - now}s); the agent endpoint's source re-read adopts it`);
  }

  /** Render the current operator snapshot. Recovered rows live until the next sweep starts, then
   *  clear, so recovery is visible without becoming stale process-lifetime history. */
  staticReconciliationStatus(): ManagerStaticReconciliationStatus {
    const failures = [...this.staticReconcileItems.values()]
      .map(({ owner: _owner, timer: _timer, flight: _flight, retryFlight: _retryFlight, ...item }) => ({ ...item }))
      .sort((a, b) => a.alias.localeCompare(b.alias));
    const state: ManagerStaticReconciliationStatus["state"] =
      this.staticReconcileLastSweep?.error !== undefined ? "failed" :
      failures.some((item) => item.disposition === "retrying") ? "retrying" :
      failures.some((item) => item.disposition === "retry-scheduled") ? "retry-wait" :
      failures.some((item) => item.disposition === "refused" || item.disposition === "refused-foreign" || item.disposition === "retry-exhausted") ? "failed" :
      this.staticReconcileSweepsInFlight > 0 ? "running" :
      failures.some((item) => item.disposition === "recovered") ? "recovered" : "idle";
    return {
      state,
      ...(this.staticReconcileLastSweep ? { lastSweep: { ...this.staticReconcileLastSweep } } : {}),
      failures,
    };
  }

  /** The static-slot reconciliation ("no active orphan"): ensure the authority stores, then sweep
   *  every durable slot row and act by the TOTAL resume table - `provisioning`/`terminalizing`
   *  re-drive the exact-op terminal; an `active` row survives ONLY when a LIVE managed agent this
   *  manager process owns backs it at the same uid (`adopted`), else no managed owner claimed it and
   *  its broker authority is contained and terminalized; `retired` rows seed the retired-principal refusal index. Two call sites: the BOOT sweep
   *  (`postAdoption=false`, under the lease before control serving) DEFERS active-non-adopted
   *  slots while a resume is still pending (adoption runs after it); the POST-ADOPTION sweep
   *  (`postAdoption=true`, inside finalizeResume while `resumeRequired` still fences ordinary
   *  spawns) terminalizes any active slot the resume did not claim. */
  staticReconcileKey(row: Pick<StaticManagedSlotRow, "owner" | "alias" | "lifecycleUid">): string {
    return JSON.stringify([row.owner, row.alias, row.lifecycleUid]);
  }

  /** Read one retry coordinate from the durable slot store. The status snapshot never authorizes a
   *  re-drive: every timer comes through this fresh read before the planner and exact terminal. */
  async readStaticReconcileSlot(alias: string): Promise<StaticManagedSlotRow | undefined> {
    if (!this.deps.auth()) return undefined;
    const identity = newIdentity();
    const creds = await mintCreds(this.deps.auth()!, identity, "provisioner");
    const nc = await this.deps.dial({ ...standaloneConnectOpts({ creds, /* not yet wired to a recorded transport */ tls: false }), maxReconnectAttempts: 0 });
    try {
      const recordsKv = await new Kvm(nc).open(recordsBucket(this.deps.space()));
      return (await readStaticSlot(staticLifecycleTransport(recordsKv, recordsKv), DEV_OWNER, alias))?.row;
    } finally {
      await drainAndClose(nc);
    }
  }

  scheduleStaticReconcileRetry(key: string, item: StaticReconcileItem): void {
    if (this.staticReconcileStopping || item.timer || item.attempts >= item.maxAttempts) return;
    const delay = this.deps.retryDelays()[item.attempts - 1];
    if (delay === undefined) return;
    const nextRetryAtMs = Date.now() + delay;
    item.disposition = "retry-scheduled";
    item.nextRetryAt = new Date(nextRetryAtMs).toISOString();
    item.timer = setTimeout(() => {
      item.timer = undefined;
      item.nextRetryAt = undefined;
      const run = async (): Promise<void> => {
        // The timer may fire while the failed attempt is still unwinding, especially in compressed
        // smoke schedules. Join that flight before consuming another budget entry; never overlap it.
        if (item.flight) await item.flight;
        await this.retryStaticReconcile(key);
      };
      void run().catch((error) => {
        item.lastError = `retry driver failed before the exact terminal: ${rejectionText(error)}`;
        item.disposition = "retry-exhausted";
        item.remedy = "restart this manager for a fresh per-process retry budget";
        console.error(`! static reconcile retry-exhausted alias=${item.alias} phase=${item.phase} uid=${item.lifecycleUid}: ${item.lastError}; NEXT: restart this manager for a fresh per-process retry budget`);
      });
    }, delay);
    item.timer.unref?.();
    console.error(`! static reconcile retry-scheduled alias=${item.alias} phase=${item.phase} uid=${item.lifecycleUid} attempt=${item.attempts + 1}/${item.maxAttempts} nextRetryAt=${item.nextRetryAt}`);
  }

  retryStaticReconcile(key: string): Promise<void> {
    const item = this.staticReconcileItems.get(key);
    if (!item || this.staticReconcileStopping || item.disposition === "recovered") return Promise.resolve();
    if (item.retryFlight) return item.retryFlight;
    const flight = this.driveStaticReconcileRetry(key, item);
    let wrapped!: Promise<void>;
    wrapped = flight.finally(() => {
      if (item.retryFlight === wrapped) item.retryFlight = undefined;
    });
    item.retryFlight = wrapped;
    return wrapped;
  }

  async driveStaticReconcileRetry(key: string, item: StaticReconcileItem): Promise<void> {
    if (item.flight) await item.flight;
    if (this.staticReconcileStopping || item.disposition === "recovered") return;
    // A retry trigger consumes one finite budget entry even if the authoritative re-read itself
    // fails. Otherwise a broker outage before the planner could reschedule forever without ever
    // incrementing `attempts`, violating the bounded-retry guarantee.
    item.attempts++;
    item.disposition = "retrying";
    item.remedy = undefined;
    console.error(`static reconcile retrying alias=${item.alias} phase=${item.phase} uid=${item.lifecycleUid} attempt=${item.attempts}/${item.maxAttempts}`);
    let row: StaticManagedSlotRow | undefined;
    try {
      row = await this.readStaticReconcileSlot(item.alias);
    } catch (error) {
      item.lastError = `durable slot re-read failed: ${rejectionText(error)}`;
      if (item.attempts >= item.maxAttempts) {
        item.disposition = "retry-exhausted";
        item.remedy = "restart this manager for a fresh per-process retry budget";
        console.error(`! static reconcile retry-exhausted alias=${item.alias} phase=${item.phase} uid=${item.lifecycleUid}: ${item.lastError}; NEXT: restart this manager for a fresh per-process retry budget`);
      } else {
        this.scheduleStaticReconcileRetry(key, item);
      }
      return;
    }
    if (row === undefined || row.owner !== item.owner || row.actor !== item.actor || row.lifecycleUid !== item.lifecycleUid) {
      item.disposition = "refused";
      item.remedy = "inspect the durable slot; reconciliation will not cross incarnations";
      item.lastError = row === undefined
        ? "the durable slot vanished; reconciliation never acts from the in-memory snapshot"
        : `the durable slot moved to actor ${row.actor} uid ${row.lifecycleUid}; reconciliation never crosses incarnations`;
      console.error(`! static reconcile refused alias=${item.alias} phase=${item.phase} uid=${item.lifecycleUid}: ${item.lastError}`);
      return;
    }
    item.phase = row.phase;
    if (row.phase === "retired") {
      item.disposition = "recovered";
      item.recoveredAt = new Date().toISOString();
      item.lastError = undefined;
      console.error(`✓ static reconcile recovered alias=${item.alias} phase=retired uid=${item.lifecycleUid} attempts=${item.attempts}/${item.maxAttempts}`);
      return;
    }
    if (ownedBySibling(row, this.deps.instanceId())) {
      item.disposition = "refused";
      item.remedy = "the owning manager must reconcile or an operator must perform an explicit CAS takeover";
      item.lastError = `the durable slot belongs to manager instance ${row.ownerInstanceId}, not ${this.deps.instanceId()}`;
      console.error(`! static reconcile refused alias=${item.alias} phase=${item.phase} uid=${item.lifecycleUid}: ${item.lastError}`);
      return;
    }
    const live = this.deps.agentFor(row.alias);
    const adopted = live !== undefined && live.lifecycleUid === row.lifecycleUid;
    if (planStaticSlotResume(row, adopted) !== "drive-terminal") {
      item.disposition = "refused";
      item.remedy = adopted ? "leave the adopted live lifecycle running" : "inspect the fresh durable slot state";
      item.lastError = adopted
        ? "the durable lifecycle is now backed by an adopted live managed agent"
        : `the fresh durable phase ${row.phase} is not terminal-plannable`;
      console.error(`! static reconcile refused alias=${item.alias} phase=${item.phase} uid=${item.lifecycleUid}: ${item.lastError}`);
      return;
    }
    await this.attemptStaticReconcile(key, item, row, false);
  }

  /** Enter one exact terminal at most once per coordinate. Sweep and timer triggers join the same
   *  promise. A settled failed item keeps its original per-process budget; a restart builds a fresh
   *  map from the still-authoritative durable row. */
  attemptStaticReconcile(key: string, item: StaticReconcileItem, row: StaticManagedSlotRow, countAttempt = true): Promise<StaticReconcileAttempt> {
    if (item.flight) return item.flight;
    if (item.timer) return Promise.resolve({ succeeded: false });
    // A timer/retry driver increments before its mandatory durable re-read, then calls with
    // countAttempt=false. Let that already-consumed budget entry enter the terminal. Only a fresh
    // sweep entry (countAttempt=true) is refused once the per-process budget is exhausted.
    if (countAttempt && item.attempts >= item.maxAttempts) return Promise.resolve({ succeeded: false });
    const flight = (async (): Promise<StaticReconcileAttempt> => {
      if (countAttempt) item.attempts++;
      item.phase = row.phase;
      item.disposition = "retrying";
      item.nextRetryAt = undefined;
      this.reconcilingAliases.add(row.alias);
      console.error(`static reconcile terminal alias=${row.alias} phase=${row.phase} uid=${row.lifecycleUid} attempt=${item.attempts}/${item.maxAttempts}`);
      let deprovision: DeprovisionResourceAccounting | undefined;
      try {
        await this.deps.withRetirementSlot(() => this.driveStaticRetirement({ id: row.actor, name: row.alias, lifecycleUid: row.lifecycleUid, runtime: row.runtime }, true, (accounting) => { deprovision = accounting; }));
        if (item.attempts === 1) {
          this.staticReconcileItems.delete(key);
        } else {
          item.phase = "retired";
          item.disposition = "recovered";
          item.recoveredAt = new Date().toISOString();
          item.lastError = undefined;
          console.error(`✓ static reconcile recovered alias=${item.alias} phase=retired uid=${item.lifecycleUid} attempts=${item.attempts}/${item.maxAttempts}`);
        }
        return { succeeded: true, deprovision };
      } catch (error) {
        item.lastError = rejectionText(error);
        try {
          const fresh = await this.readStaticReconcileSlot(item.alias);
          if (fresh?.lifecycleUid === item.lifecycleUid && fresh.actor === item.actor) item.phase = fresh.phase;
        } catch { /* the terminal error remains primary; the next retry re-reads authoritatively */ }
        const blocked = lifecycleBlockedFrom(error);
        const ownOp = managedRetirementOpId(item.lifecycleUid);
        const foreign = blocked !== undefined && (blocked.blockedOp !== "retirement" || blocked.opId !== ownOp);
        if (foreign) {
          item.disposition = "refused-foreign";
          item.remedy = blocked?.remedy ?? "resolve the foreign durable operation; it is never force-cleared";
          console.error(`! static reconcile refused-foreign alias=${item.alias} phase=${item.phase} uid=${item.lifecycleUid}: ${item.lastError}`);
        } else if (item.attempts >= item.maxAttempts) {
          item.disposition = "retry-exhausted";
          item.remedy = "restart this manager for a fresh per-process retry budget";
          console.error(`! static reconcile retry-exhausted alias=${item.alias} phase=${item.phase} uid=${item.lifecycleUid}: ${item.lastError}; NEXT: restart this manager for a fresh per-process retry budget`);
        } else {
          // The initial serial sweep must publish its complete failed aggregate before any timer can
          // re-enter a middle row. Mark it now; the sweep arms the timer after its last planned row.
          if (this.staticReconcileSweepsInFlight > 0) item.disposition = "retry-scheduled";
          else this.scheduleStaticReconcileRetry(key, item);
        }
        return { succeeded: false, deprovision };
      } finally {
        this.reconcilingAliases.delete(row.alias);
      }
    })();
    item.flight = flight.finally(() => {
      if (item.flight === wrapped) item.flight = undefined;
    });
    const wrapped = item.flight;
    return wrapped;
  }

  releaseStaticReconcileSweep(): void {
    this.staticReconcileSweepsInFlight--;
    if (this.staticReconcileSweepsInFlight !== 0) return;
    const waiters = this.staticReconcileDrainWaiters;
    this.staticReconcileDrainWaiters = [];
    for (const wake of waiters) wake();
  }

  /** Shutdown accepts no new static reconciliation work, then drains every sweep and exact-terminal
   * flight that crossed the fence before stop(). A sweep can discover several rows before its first
   * await, so the serial loop also consults the fence and never starts a later row after shutdown. */
  async awaitStaticReconcileDrain(): Promise<void> {
    while (true) {
      if (this.staticReconcileSweepsInFlight > 0)
        await new Promise<void>((resolve) => this.staticReconcileDrainWaiters.push(resolve));
      const flights: Array<Promise<StaticReconcileAttempt> | Promise<void>> = [];
      for (const item of this.staticReconcileItems.values()) {
        if (item.flight) flights.push(item.flight);
        if (item.retryFlight) flights.push(item.retryFlight);
      }
      if (flights.length === 0 && this.staticReconcileSweepsInFlight === 0) return;
      await Promise.allSettled(flights);
    }
  }

  async reconcileStaticLifecycles(postAdoption = false): Promise<void> {
    if (!this.deps.auth() || this.staticReconcileStopping) return;
    // Admission is synchronous with the shutdown fence. Once this increments, stop() must drain the
    // whole accepted sweep even if it is still minting its short-lived provisioner credential.
    this.staticReconcileSweepsInFlight++;
    try {
      // Recovered is a transition report, not permanent history. The next sweep clears it before
      // deriving a fresh plan; failed coordinates keep their per-process budget and are joined.
      for (const [key, item] of this.staticReconcileItems) {
        if (item.disposition === "recovered") this.staticReconcileItems.delete(key);
      }
      const sweep: ManagerStaticReconciliationSweep = {
        kind: postAdoption ? "post-adoption" : "startup",
        startedAt: new Date().toISOString(),
        attempted: 0,
        succeeded: 0,
        failed: 0,
      };
      this.staticReconcileLastSweep = sweep;
      const slotRows: StaticManagedSlotRow[] = [];
      // A sweep that stops before it plans any alias records why on the sweep itself: otherwise
      // `status` cannot tell it from a sweep that collected and found nothing.
      try {
        const identity = newIdentity();
        const creds = await mintCreds(this.deps.auth()!, identity, "provisioner");
        const nc = await this.deps.dial({ ...standaloneConnectOpts({ creds, /* not yet wired to a recorded transport */ tls: false }), maxReconnectAttempts: 0 });
        try {
          const jsm = await jetstreamManager(nc);
          const kvm = new Kvm(nc);
          await ensureAuthorityStores(jsm, kvm, this.deps.space());
          const recordsKv = await kvm.open(recordsBucket(this.deps.space()));
          for (const slot of await walkStaticSlots(recordsKv, DEV_OWNER)) slotRows.push(slot.row);
        } finally {
          await drainAndClose(nc);
        }
      } catch (error) {
        sweep.completedAt = new Date().toISOString();
        sweep.error = rejectionText(error);
        throw error;
      }
      let retiredSlots = 0;
      let preservedForeign = 0;
      let preservedAdopted = 0;
      let deferredSlots = 0;
      const terminalRows: StaticManagedSlotRow[] = [];
      const restartRows: Array<{ row: StaticManagedSlotRow; record: SeatRecord }> = [];
      for (const row of slotRows) {
        if (row.phase === "retired") {
          // A retirement is a GLOBAL refusal fact - seed the retired-principal index for EVERY retired incarnation
          // regardless of which instance owned it, so a sibling-retired incarnation's copied credential
          // is refused at this control surface too. Ownership gates only the DESTRUCTIVE sweep below.
          this.deps.noteRetiredPrincipal(principalKey(row.owner, row.actor).key);
          retiredSlots++;
          continue;
        }
        // RECONCILE OWNERSHIP (multi-manager-per-space): a manager adjudicates ONLY the non-retired
        // rows THIS logical instance owns. A SIBLING manager's active/provisioning row is LEFT UNTOUCHED -
        // sweep-terminalizing it would destroy the sibling's live agent (the historical all-agents-kill
        // hazard, now cross-instance). A legacy row (no owner recorded) predates multi-manager,
        // so this manager is its legitimate single-manager-past successor and reconciles it. An orphaned
        // sibling row is reclaimed only by an explicit operator CAS takeover, never here.
        if (ownedBySibling(row, this.deps.instanceId())) {
          preservedForeign++;
          continue;
        }
        // A chat session this process is opening or holds is live membership, as an adopted seat
        // is: its own open, expiry or stop runs its terminal, which this sweep must not race. The
        // match is the exact registered alias, actor and UID under this logical instance and this
        // process's incarnation, so a foreign, legacy or unrecorded row, or any UID this process
        // did not register, falls through to the ordinary plan below.
        if (this.holdsLiveChatSlot(row)) {
          preservedAdopted++;
          continue;
        }
        // ADOPTION is genuine membership: a slot backed by a live managed agent THIS process owns
        // at the SAME uid is never an orphan (empty at boot; exactly the adopted set at the
        // post-adoption sweep - the fix for the resume hole).
        const live = this.deps.agentFor(row.alias);
        const adopted = live !== undefined && live.lifecycleUid === row.lifecycleUid;
        if (adopted) {
          preservedAdopted++;
        }
        // Boot sweep with a resume PENDING: an active slot may yet be adopted (the resume path runs
        // AFTER this boot sweep), so DEFER it - the post-adoption sweep terminalizes any the resume
        // did not claim. provisioning/terminalizing NEVER defer (they are crashed operations, never
        // an agent to adopt). At `postAdoption` (or a non-resume boot) nothing defers.
        if (!postAdoption && row.phase === "active" && !adopted && this.deps.resumeRequired()) {
          deferredSlots++;
          continue;
        }
        // A boot after this instance's manager ended without stopping its seats: a seat with a record
        // is taken back instead of retired, restarted under its policy when supervised (#4094) and
        // adopted while it still runs otherwise (#4095).
        if (!postAdoption && row.phase === "active" && !adopted) {
          const record = this.deps.seatRecordFor(row);
          if (record) {
            restartRows.push({ row, record });
            continue;
          }
        }
        if (planStaticSlotResume(row, adopted) !== "none") terminalRows.push(row);
      }
      try {
        // Mark the complete planned set before the first terminal awaits. A timer owns only its own
        // alias, but the initial serial sweep must close every discovery-to-await gap up front.
        for (const row of terminalRows) this.reconcilingAliases.add(row.alias);
        for (const { row } of restartRows) this.reconcilingAliases.add(row.alias);
        // Restarts run first; one that cannot restart joins the terminals below.
        for (const { row, record } of restartRows) {
          if (this.staticReconcileStopping) break;
          // A supervised seat is restarted; any other seat is adopted while it still runs.
          const refusal = record.supervise ? await this.deps.restartSupervisedSeat(row, record) : await this.deps.adoptSeat(row, record);
          if (refusal === undefined) {
            this.reconcilingAliases.delete(row.alias);
            continue;
          }
          console.error(record.supervise
            ? `! ${row.alias}: the supervised seat its previous manager left was not restarted (${refusal}); retiring the lifecycle`
            : `! ${row.alias}: the seat its previous manager left was not adopted (${refusal}); retiring the lifecycle`);
          this.deps.dropSeatRecord({ name: row.alias, lifecycleUid: row.lifecycleUid });
          terminalRows.push(row);
        }
        const sweepDeprovision: DeprovisionResourceAccounting = {
          examined: 0,
          deleted: 0,
          absent: 0,
          refused: 0,
          acknowledged: 0,
          disappeared: 0,
          consumers: { examined: 0, deleted: 0, absent: 0, refused: 0, acknowledged: 0, disappeared: 0 },
          acls: { examined: 0, deleted: 0, absent: 0, refused: 0, disappeared: 0 },
          members: { examined: 0, deleted: 0, absent: 0, refused: 0, disappeared: 0 },
        };
        for (const row of terminalRows) {
          if (this.staticReconcileStopping) break;
          sweep.attempted++;
          const key = this.staticReconcileKey(row);
          let item = this.staticReconcileItems.get(key);
          if (!item) {
            item = {
              owner: row.owner,
              alias: row.alias,
              actor: row.actor,
              lifecycleUid: row.lifecycleUid,
              phase: row.phase,
              attempts: 0,
              maxAttempts: STATIC_RECONCILE_MAX_ATTEMPTS,
              disposition: "retrying",
            };
            this.staticReconcileItems.set(key, item);
          }
          const attempt = await this.attemptStaticReconcile(key, item, row);
          if (attempt.deprovision) addDeprovisionAccounting(sweepDeprovision, attempt.deprovision);
          if (attempt.succeeded) sweep.succeeded++;
          else sweep.failed++;
          this.reconcilingAliases.delete(row.alias);
        }
        sweep.completedAt = new Date().toISOString();
        this.staticReconcileLastSweepResources = {
          slots: {
            examined: slotRows.length,
            retired: retiredSlots,
            preservedForeign,
            preservedAdopted,
            deferred: deferredSlots,
            terminalized: sweep.succeeded,
            failed: sweep.failed,
          },
          deprovision: sweepDeprovision,
        };
        for (const row of terminalRows) {
          const key = this.staticReconcileKey(row);
          const item = this.staticReconcileItems.get(key);
          if (item?.disposition === "retry-scheduled" && !item.timer) this.scheduleStaticReconcileRetry(key, item);
        }
        const failed = terminalRows.flatMap((row) => {
          const item = this.staticReconcileItems.get(this.staticReconcileKey(row));
          return item && item.disposition !== "recovered" ? [`${item.alias}:${item.phase}:${item.disposition}`] : [];
        });
        if (sweep.failed === 0) {
          console.error(`✓ static reconcile completed: ${sweep.attempted} attempted, ${sweep.succeeded} succeeded, 0 failed`);
        } else {
          console.error(`! static reconcile completed: ${sweep.attempted} attempted, ${sweep.succeeded} succeeded, ${sweep.failed} failed; failed=${failed.join(",")}`);
        }
      } finally {
        for (const row of terminalRows) this.reconcilingAliases.delete(row.alias);
        for (const { row } of restartRows) this.reconcilingAliases.delete(row.alias);
      }
    } finally {
      this.releaseStaticReconcileSweep();
    }
  }
}
