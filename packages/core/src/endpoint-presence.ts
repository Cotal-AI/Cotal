import type { ConsumerInfo } from "@nats-io/jetstream";
import type { KV, KvEntry } from "@nats-io/kv";
import { TimeoutError, type NatsConnection } from "@nats-io/transport-node";
import type { AgentCard, Presence, PresenceStatus, PresenceCondition, PresencePrompts, AttentionMode, ChannelMode } from "./types.js";
import { processRuntime } from "./process-runtime.js";
import { lastKvEntries } from "./kv-scan.js";
import { TTL_RECONCILE_CANARY_KEY } from "./streams.js";
import { presenceBucket } from "./subjects.js";
import { isPresenceRow, assertPresenceRow } from "./subjects.js";
import type { CotalEndpoint } from "./endpoint.js";
import { isPublishPermissionDenied } from "./endpoint-dial.js";

type PresenceWatch = Awaited<ReturnType<KV["watch"]>>;

/** Live connection dependencies shared with the endpoint's other broker readers. */
export interface EndpointPresenceDeps {
  card: () => AgentCard;
  space: () => string;
  bucket: () => KV | undefined;
  connection: () => NatsConnection | undefined;
  lifecycleUid: () => string | undefined;
  /** The `prompts` field this process's presence carries now, or none (SPEC §6). */
  prompts: () => PresencePrompts | undefined;
  ttlMs: () => number;
  registers: () => boolean;
  watches: () => boolean;
  readsOnce: () => boolean;
  stopped: () => boolean;
  reconnecting: () => boolean;
  epoch: () => number;
  notLiveMsg: () => string;
  bindWatch: (kv: KV) => Promise<{ iter: PresenceWatch; info: ConsumerInfo } | undefined>;
  retireWatch: (iter: PresenceWatch) => void;
  emit: (event: string, value: unknown) => boolean;
  recoverable: (error: Error) => void;
  isPublishPermissionDenied: (error: unknown) => boolean;
}

/** Trust state of this endpoint's local presence roster. `fresh` remains for older consumers:
 * unpopulated is deliberately false so they fail toward unknown rather than treating a partial
 * reconnect snapshot as an authoritative absence verdict. */
export type PresenceView =
  | { state: "current"; fresh: true }
  | { state: "unpopulated"; fresh: false }
  | { state: "stale"; fresh: false; staleSince: number };

/** A presence bucket that has refused consecutive writes for at least one full presence TTL.
 * The condition is non-transient: ordinary heartbeat retry has already failed for the whole
 * liveness window, so callers should report the roster as last-known until a write succeeds. */
export class PresenceWriteStuckError extends Error {
  readonly code = "presence-write-stuck" as const;
  readonly transient = false as const;

  constructor(
    readonly bucket: string,
    readonly since: number,
    readonly consecutiveFailures: number,
    readonly ttlMs: number,
    readonly lastError?: string,
  ) {
    super(
      `presence writes to bucket ${JSON.stringify(bucket)} have failed ${consecutiveFailures} consecutive times for at least one TTL (${ttlMs}ms); the presence view is not live until a write succeeds or the broker store is repaired${lastError ? ` (last refusal: ${lastError})` : ""}`,
    );
    this.name = "PresenceWriteStuckError";
  }
}

/** Presence publication, local roster materialization and observer freshness for one endpoint. */
export class EndpointPresence {

  /** #1356: when the presence bucket started refusing writes; undefined once one succeeds. */
  private presenceWriteFailingSince?: number;

  /** #1356: the broker's last refusal message, kept alongside the start time for diagnosis. */
  private lastPresenceWriteError?: string;

  /** Consecutive latest-evidence refusals on the current connection epoch. A success resets it. */
  private presenceWriteFailures = 0;

  /** One named non-transient warning per failed run. A success re-arms it. */
  private presenceWriteEscalated = false;

  /** #1461: monotonic per-put generation on the presence path, so a settle can tell whether it is
   *  the latest evidence on its epoch. {@link publishPresence} snapshots it at put start and every
   * settle records its generation here: a settle is the latest evidence only while no put that
   * started after it has already settled. */
  private presencePutGeneration = 0;

  /** #1461: the generation of the newest presence put that has SETTLED (succeeded or rejected),
   * or `undefined` when none ever has. A put that is merely in flight is not evidence yet. */
  private presencePutSettled?: number;

  private readonly roster = new Map<string, Presence>();

  /** The {@link readPresence} in flight; calls made before it settles share it. */
  private presenceRead?: Promise<Presence[]>;

  /** Orders {@link readPresence} merges: a read that settles after a newer one was applied is dropped. */
  private presenceReadGeneration = 0;

  private presenceReadApplied = 0;

  /** Resolves when the current presence watch has consumed its complete initial KV snapshot. */
  private presenceSnapshot = Promise.resolve();

  /** False from connection reset until the watch marks the last entry in its initial replay. */
  private presenceSnapshotPopulated = false;

  /**
   * Observer-local age of the last presence-KV delivery (any key, including DEL/PURGE). Distinct
   * from each peer's `ts`: that is the publisher's heartbeat. Whole-bucket silence past TTL is
   * the observer going deaf, not  N  simultaneous deaths, and sweep must not treat it as the
   * latter (#1045).
   */
  private lastPresenceWatchAt = 0;

  /** Last emitted presence-view state. Suppresses duplicate `presence-view` events. */
  private presenceViewState: PresenceView["state"] = "unpopulated";

  /** A presence-watch rebind in flight (see {@link rebindStalePresenceWatch}); one at a time. */
  private presenceRebind?: Promise<void>;

  /** The current watch was bound onto a bucket with NO keys (see {@link markPresenceBucketEmpty}).
   *  Such a watch cannot deliver until someone writes, so its silence is not staleness. */
  private presenceWatchEmpty = false;

  /** Wall-clock of the last rebind attempt, so a bucket that is silent because it is EMPTY (or a
   *  broker that keeps refusing the consumer create) is retried once per TTL, not per sweep tick. */
  private presenceRebindAt = 0;

  private status: PresenceStatus = "idle";

  private activity?: string;

  /** When {@link status} or {@link activity} last changed. Heartbeats republish it unchanged. */
  private statusSince = Date.now();

  /** When {@link activity} last changed. A status change leaves it alone. */
  private activitySince?: number;

  /** Last harness-reported work progress. Carried by the next heartbeat, never published per event. */
  private activeAt?: number;

  private condition?: PresenceCondition;

  /** Advances on every condition change so an older in-flight put cannot be the final KV state. */
  private conditionRevision = 0;

  /** Read once at construction. Core publishes this opaque provider reference and never parses it. */
  private environment?: string;

  /** Mirror of the connector's authoritative attention state, published in presence (advisory). The
   *  endpoint never reads these back into delivery - they exist only to broadcast. */
  private attentionMode?: AttentionMode;

  private channelModes?: Record<string, ChannelMode>;

  /** Presence rows rejected because their embedded id did not match the ACL-scoped KV key, or because
   *  a field the observer computes with was malformed. */
  private presenceBindingDrops = 0;

  /** The presence/channel-registry watches' own handles. Each is an ORDERED push consumer: its idle
   *  heartbeat monitor lives on a JS timer independent of the connection, so a drain that doesn't
   *  `.stop()` it first leaves the monitor to fire into a closing connection every 30s, throwing
   *  `DrainingConnectionError` out of `reset()` on a timer nothing awaits. */
  private presenceWatchIter?: Awaited<ReturnType<KV["watch"]>>;

  constructor(private readonly deps: EndpointPresenceDeps) {}

  private get card() { return this.deps.card(); }
  private get space() { return this.deps.space(); }
  private get kv() { return this.deps.bucket(); }
  private get nc() { return this.deps.connection(); }
  private get ownLifecycleUid() { return this.deps.lifecycleUid(); }
  private get ttlMs() { return this.deps.ttlMs(); }
  private get doRegister() { return this.deps.registers(); }
  private get doWatch() { return this.deps.watches(); }
  private get readOnce() { return this.deps.readsOnce(); }
  private get stopped() { return this.deps.stopped(); }
  private get reconnecting() { return this.deps.reconnecting(); }
  private get presenceEpoch() { return this.deps.epoch(); }
  private notLiveMsg() { return this.deps.notLiveMsg(); }
  private bindKvWatch(kv: KV) { return this.deps.bindWatch(kv); }
  private retireKvWatch(iter: PresenceWatch) { this.deps.retireWatch(iter); }
  private emit(event: string, value: unknown) { return this.deps.emit(event, value); }
  private emitRecoverable(error: Error) { this.deps.recoverable(error); }

  configureEnvironment(environment: string | undefined): void { this.environment = environment; }
  seedChannelModes(modes: Record<string, ChannelMode> | undefined): void {
    this.channelModes = modes && Object.keys(modes).length ? modes : undefined;
  }
  get bindingDropCount(): number { return this.presenceBindingDrops; }
  values(): IterableIterator<Presence> { return this.roster.values(); }
  cancelRebind(): void { this.presenceRebind = undefined; }
  retireWatch(): void {
    if (this.presenceWatchIter) this.retireKvWatch(this.presenceWatchIter);
    this.presenceWatchIter = undefined;
  }
  async publishOffline(): Promise<void> {
    this.status = "offline";
    await this.publishPresence();
  }
  resetConnection(): void {
    this.roster.clear();
    // A read in flight on the old connection must not land in the new connection's roster.
    this.presenceRead = undefined;
    this.presenceReadGeneration++;
    this.presenceReadApplied = this.presenceReadGeneration;
    // #1356: the presence-refusal record is connection-scoped like everything else torn down here.
    // It says "the broker on THIS connection refuses writes to this bucket", so it cannot outlive the
    // connection that observed it. Left behind, a later failure on a different connection inherits it
    // and is reported as a bucket refusal - measured: a failed bind against an unreachable server
    // still printed the refusal sentence while `connectionIssue` already said "connection refused".
    this.clearPresenceWriteFailure();
    this.lastPresenceWatchAt = 0;
    this.presenceRebindAt = 0;
    this.presenceWatchEmpty = false;
    this.presenceSnapshotPopulated = false;
    this.emitPresenceViewIfChanged();
  }

  // ---- presence ------------------------------------------------------------

  getRoster(): Presence[] {
    return [...this.roster.values()].sort((a, b) =>
      a.card.name.localeCompare(b.card.name),
    );
  }

  /**
   * Read the roster from the broker now, for an endpoint that does not watch presence (SPEC §6). One
   * batched Direct Get of the bucket that binds no consumer, decoded and dropped as the watch decodes.
   * A record that says `offline` or whose `ts` is past the liveness window reads offline. A peer an
   * earlier read saw that is gone from the bucket stays in the roster as offline, as a watch keeps
   * it. The result is also what {@link getRoster} returns until the next read.
   *
   * Calls made while a read is in flight share it, and every other call reads anew, so a verdict
   * never rests on a read that settled before it was asked. A failed read throws and changes
   * nothing. A credential that may not make the read is refused with the grant it lacks.
   */
  async readPresence(): Promise<Presence[]> {
    if (this.doWatch && !this.readOnce)
      throw new Error("readPresence is for an endpoint that does not watch presence; this one keeps its roster live (getRoster)");
    const kv = this.kv;
    if (!kv) throw new Error(this.nc ? "readPresence needs the presence bucket open (registerPresence or watchPresence)" : this.notLiveMsg());
    if (this.presenceRead) return this.presenceRead;
    const generation = ++this.presenceReadGeneration;
    const roster = (async () => {
      let entries: KvEntry[];
      try {
        entries = await lastKvEntries(kv);
      } catch (e) {
        if (!this.deps.isPublishPermissionDenied(e)) throw e;
        throw new Error(
          `presence read refused for ${this.card.id}: this credential may not publish $JS.API.DIRECT.GET.KV_${presenceBucket(this.space)}, the on-demand roster read (SPEC Appendix B). A credential minted by an older issuer can lack this grant even when newly minted; upgrade the manager or auth service that issues credentials, then mint a new credential. Reusing credentials or reconnecting does not add the grant.`,
          { cause: e },
        );
      }
      const at = Date.now();
      const read = new Map<string, Presence>();
      for (const e of entries) {
        if (e.key === TTL_RECONCILE_CANARY_KEY || e.operation === "DEL" || e.operation === "PURGE") continue;
        const p = this.decodePresence(e);
        if (p) read.set(e.key, p.status === "offline" || at - p.ts > this.ttlMs ? this.toOffline(p) : p);
      }
      if (generation > this.presenceReadApplied) {
        this.presenceReadApplied = generation;
        for (const [id, p] of this.roster) if (!read.has(id)) read.set(id, p.status === "offline" ? p : this.toOffline(p));
        this.roster.clear();
        for (const [id, p] of read) this.roster.set(id, p);
      }
      return this.getRoster();
    })();
    this.presenceRead = roster;
    const settled = () => { if (this.presenceRead === roster) this.presenceRead = undefined; };
    roster.then(settled, settled);
    return roster;
  }

  /**
   * Trust state of THIS observer's presence watch, not of any peer. `unpopulated` means the
   * current watch has not completed its initial snapshot, so {@link getRoster} may be partial and
   * cannot support an absence verdict. `stale` means the whole bucket has been silent past the
   * liveness window, so the roster is last-known as of `staleSince`. `fresh` is false for both
   * unsafe states so consumers written before `state` was added degrade in the safe direction.
   */
  presenceView(): PresenceView {
    if (!this.doWatch) return { state: "current", fresh: true };
    if (!this.presenceSnapshotPopulated) return { state: "unpopulated", fresh: false };
    if (this.presenceWatchEmpty) return { state: "current", fresh: true };
    const staleSince = this.lastPresenceWatchAt + this.ttlMs;
    if (Date.now() < staleSince) return { state: "current", fresh: true };
    return { state: "stale", fresh: false, staleSince };
  }

  /** Wait until the current presence watch has consumed its initial KV snapshot. An observer that
   * does not register completes on an empty bucket at once. A registering one completes when its
   * own record arrives, and the timeout bounds that wait. */
  async waitForPresenceSnapshot(timeoutMs = 1_000): Promise<"snapshot" | "timeout"> {
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        this.presenceSnapshot.then(() => "snapshot" as const),
        new Promise<"timeout">((resolve) => { timer = setTimeout(() => resolve("timeout"), timeoutMs); }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private assertPresenceUpdate(update: Partial<Presence>): void {
    assertPresenceRow({ card: this.card, status: this.status, activity: this.activity,
      condition: this.condition, attention: this.attentionMode, ts: Date.now(), ...update }, this.card.id);
  }

  async setActivity(activity: string): Promise<void> {
    this.assertPresenceUpdate({ activity });
    if (activity !== this.activity) this.statusSince = this.activitySince = Date.now();
    this.activity = activity;
    await this.publishPresence();
  }

  /** Set the status, and with `activity` the activity line too, in one presence write, so no peer sees
   *  the new activity beside the old status. */
  async setStatus(status: PresenceStatus, activity?: string): Promise<void> {
    this.assertPresenceUpdate({ status, ...(activity === undefined ? {} : { activity }) });
    if (activity !== undefined && activity !== this.activity) this.statusSince = this.activitySince = Date.now();
    if (activity !== undefined) this.activity = activity;
    if (status !== this.status) this.statusSince = Date.now();
    this.status = status;
    await this.publishPresence();
  }

  /** Record harness-reported work progress as `activeAt`. It writes nothing itself: the next heartbeat
   *  carries it, so a stream of events costs no presence writes. */
  noteActivity(at: number = Date.now()): void {
    if (Number.isFinite(at) && at > (this.activeAt ?? 0)) this.activeAt = at;
  }

  /** Publish a harness-reported condition, or clear it. Core stores the relay without interpretation. */
  async setCondition(condition: PresenceCondition | null): Promise<void> {
    this.assertPresenceUpdate({ condition: condition ?? undefined });
    this.condition = condition ?? undefined;
    this.conditionRevision++;
    await this.publishPresence();
  }

  /** Publish the agent's global attention mode into presence (advisory observability). Mirror only -
   *  delivery decisions stay in the connector's authoritative state. */
  async setAttention(attention: AttentionMode): Promise<void> {
    this.assertPresenceUpdate({ attention });
    this.attentionMode = attention;
    await this.publishPresence();
  }

  /** Publish the agent's per-channel attention overrides into presence (advisory). An empty map drops
   *  the field. Mirror only - never read back into delivery. */
  async setChannelModes(modes: Record<string, ChannelMode>): Promise<void> {
    this.channelModes = Object.keys(modes).length ? modes : undefined;
    await this.publishPresence();
  }

  /** Overlay the host's live model and optional variant onto the card's display-only metadata, then
   *  republish presence. For connectors that learn their actual selection only after launch (e.g.
   *  Claude Code's `SessionStart` hook). The mutated card is read live by every later publish, so even
   *  a pre-connect call surfaces on the first presence write. `provider` is the effective provider
   *  the connector reported serving the model; when omitted an existing `meta.provider` is left
   *  untouched (unlike `variant`, it is never deleted, since a caller that does not know the
   *  provider says nothing about whether one still applies). */
  async setCardModel(model: string, variant?: string, provider?: string): Promise<void> {
    const m = model.trim();
    const v = variant?.trim();
    const p = provider?.trim();
    if (!m || (this.card.meta?.model === m && this.card.meta.variant === v && (p === undefined || this.card.meta?.provider === p)))
      return;
    const meta: Record<string, unknown> = { ...(this.card.meta ?? {}), model: m };
    if (v) meta.variant = v;
    else delete meta.variant;
    if (p) meta.provider = p;
    this.card.meta = meta;
    await this.publishPresence();
  }

  /** Overlay the session's working directory onto the card's display-only `meta.cwd`, then
   *  republish presence. For connectors that learn the directory from the harness after launch (e.g.
   *  Claude Code's `SessionStart` hook) rather than from their own process. Advisory display data,
   *  never a routing or access input. The pathname is kept byte for byte: a directory name may hold
   *  or end in whitespace, so it is never trimmed or normalized. An empty string names no directory
   *  and leaves the card unchanged. */
  async setCardCwd(cwd: string): Promise<void> {
    if (!cwd || this.card.meta?.cwd === cwd) return;
    this.card.meta = { ...(this.card.meta ?? {}), cwd };
    await this.publishPresence();
  }

  async publishPresence(): Promise<void> {
    if (!this.doRegister || !this.kv) return; // observers watch but never publish their own record
    const p: Presence = {
      card: this.card,
      // SPEC §6: presence carries the incarnation's lifecycle UID (MUST in auth mode from v0.4);
      // omitted only where the endpoint has none (a pure operator/daemon connection never registers).
      ...(this.ownLifecycleUid !== undefined ? { lifecycleUid: this.ownLifecycleUid } : {}),
      runtime: processRuntime(this.ownLifecycleUid),
      status: this.status,
      condition: this.condition,
      environment: this.environment,
      activity: this.activity,
      statusSince: this.statusSince,
      activitySince: this.activitySince,
      activeAt: this.activeAt,
      attention: this.attentionMode,
      channelModes: this.channelModes,
      prompts: this.deps.prompts(),
      ts: Date.now(),
    };
    // Wire contract (SPEC §6): an OFFLINE record must not carry the advisory attention fields or
    // `statusSince`. Scrub at the publisher - this covers stop(), setStatus("offline"), and any future
    // offline publish site, so the raw KV record is compliant, not only the observer-side roster
    // materialization.
    const record = this.status === "offline" ? this.toOffline(p) : p;
    assertPresenceRow(record, this.card.id);
    // #1356: this put can still be in flight when a teardown runs, because a rebind reaches
    // publishPresence through onPresenceBucketEmpty and no teardown awaits that flight. Take the same
    // epoch fence {@link startPresenceWatch} takes, so a put that outlives its epoch still throws to
    // its caller but no longer writes presence-refusal state belonging to a later connection. Without
    // it, a heartbeat put (default 2s) whose ~5s JetStream timeout elapses after a rebuild plants a
    // refusal on the connection that just published successfully.
    const epoch = this.presenceEpoch;
    const conditionRevision = this.conditionRevision;
    // #1461: snapshot the put's generation BEFORE the put. A settle (success or rejection) is the
    // latest evidence on its epoch only while no put that started after it has ALREADY settled -
    // a newer put merely in flight is not evidence yet. Same-epoch puts overlap routinely
    // (heartbeat 2s against a ~5s JetStream put timeout), so "succeeded" alone is not "newest".
    const generation = ++this.presencePutGeneration;
    try {
      await this.kv.put(this.card.id, JSON.stringify(record));
    } catch (e) {
      // #1356: a broker can put this bucket into a state where it refuses every write and never
      // recovers, and the write is the ONLY thing that fails - open and watch both still succeed, so
      // nothing else here notices. Record WHEN the refusals started, at the one site that knows the
      // failing write was a presence write; a caller cannot infer that from the generic `warning`
      // stream, which carries any recoverable error.
      //
      // #1461: a rejection speaks when it is the newest SETTLED evidence - a newer put that has
      // merely started does not silence it, but a newer put that already settled (either way)
      // does.
      const superseded = (this.presencePutSettled ?? 0) > generation;
      this.presencePutSettled = Math.max(this.presencePutSettled ?? 0, generation);
      if (epoch === this.presenceEpoch && !this.stopped && !superseded) {
        this.presenceWriteFailingSince ??= Date.now();
        this.lastPresenceWriteError = (e as Error)?.message ?? String(e);
        this.presenceWriteFailures++;
        this.escalatePresenceWriteFailureIfStuck();
      }
      if (e instanceof TimeoutError)
        throw new Error(
          `${e.message}. The presence write outcome is unknown: the broker may have stored the update. Read the roster before retrying.`,
          { cause: e },
        );
      throw e;
    }
    // A late SUCCESS cannot erase a refusal from newer evidence. Two fences, each answering half:
    // the epoch fence (#1356) keeps a put that outlives its connection from writing or erasing a
    // record that belongs to a later connection; the generation fence (#1461) orders puts WITHIN
    // one epoch by SETTLE order, not start order: a settle is the latest evidence only while no
    // put that started after it has already settled, whichever way that newer put settled. So an
    // earlier put settling AFTER a later put settled no longer speaks - success cannot clear a
    // newer refusal (#1461's original case), and a newer settle is not blocked by being merely
    // started (panel round 1). Without the fence, an earlier put succeeding late cleared a later
    // put's refusal while the bucket still refused writes (heartbeat 2s against a ~5s put timeout,
    // so the overlap is routine rather than a corner).
    const superseded = (this.presencePutSettled ?? 0) > generation;
    this.presencePutSettled = Math.max(this.presencePutSettled ?? 0, generation);
    if (epoch !== this.presenceEpoch || this.stopped || superseded) return;
    // Presence writes may overlap. If this put carried an older condition, repair the KV with the
    // latest local state before returning so a late failure publish cannot resurrect after a new
    // turn cleared it. The revision is condition-specific; unrelated heartbeat overlap is unchanged.
    if (conditionRevision !== this.conditionRevision) {
      await this.publishPresence();
      return;
    }
    this.clearPresenceWriteFailure();
  }

  /** #1356: drop the presence-refusal record when the connection that OBSERVED those refusals goes
   *  away. "This bucket is refusing writes" is a claim about a specific broker connection; once that
   *  connection is torn down or rebuilt the claim has no remaining basis, and a later failure on a
   *  fresh connection must establish it again from its own evidence.
   *
   *  Cleared at the SOURCE rather than guarded at each reader, because a guard protects one consumer
   *  and clearing protects every consumer, including ones not yet written. Measured: without this, a
   *  failed bind against an unreachable server still reported the presence-refusal sentence while the
   *  endpoint's own `connectionIssue` already said "connection refused". */
  clearPresenceWriteFailure(): void {
    this.presenceWriteFailingSince = undefined;
    this.lastPresenceWriteError = undefined;
    this.presenceWriteFailures = 0;
    this.presenceWriteEscalated = false;
  }

  /** A heartbeat retry remains recoverable inside one TTL. Once two or more consecutive writes have
   * failed across the full window, ordinary retry has exhausted the roster's liveness budget: raise
   * one named, non-transient warning. Later failures keep the duration/count current without flooding
   * the operator log; the next successful write clears and re-arms the condition. */
  private escalatePresenceWriteFailureIfStuck(): void {
    if (
      this.presenceWriteEscalated ||
      this.presenceWriteFailingSince === undefined ||
      this.presenceWriteFailures < 2 ||
      Date.now() - this.presenceWriteFailingSince < this.ttlMs
    ) return;
    this.presenceWriteEscalated = true;
    this.emitRecoverable(new PresenceWriteStuckError(
      presenceBucket(this.space),
      this.presenceWriteFailingSince,
      this.presenceWriteFailures,
      this.ttlMs,
      this.lastPresenceWriteError,
    ));
  }

  /** #1356: the presence bucket has been refusing writes since this time, or `undefined` when the
   *  last publish succeeded. Cleared by a successful write that is the latest evidence on its
   *  epoch (#1461), so a survived blip reads as healthy and only a SUSTAINED failure carries a
   *  duration.
   *
   *  Presence writes are the CANARY, not the scope: the broker can disable JetStream account-wide
   *  while the NATS connection stays up, so a caller must not read this as "only presence is
   *  affected". It reports what was observed, not how far the fault extends. */
  presenceWriteFailure(): {
    since: number;
    forMs: number;
    error?: string;
    bucket: string;
    consecutiveFailures: number;
    stuck: boolean;
  } | undefined {
    if (this.presenceWriteFailingSince === undefined) return undefined;
    return {
      since: this.presenceWriteFailingSince,
      forMs: Date.now() - this.presenceWriteFailingSince,
      error: this.lastPresenceWriteError,
      bucket: presenceBucket(this.space),
      consecutiveFailures: this.presenceWriteFailures,
      stuck: this.presenceWriteEscalated,
    };
  }

  /** Bind a presence watch on the current connection. Resolves the bound consumer's info when
   *  the watch was installed, undefined when the endpoint stopped or rebuilt while the bind was
   *  in flight: that bind's watch is retired by {@link bindKvWatch} and nothing is installed,
   *  because the epoch that asked for it is gone and the epoch that replaced it binds its own
   *  watch through the endpoint connection bind. Without this fence a bind that completes after
   *  endpoint shutdown would resurrect a watch on a stopped endpoint, and one that completes after a
   *  rebuild would overwrite the fresh epoch's watch with a dead-connection iterator. */
  async startPresenceWatch(): Promise<ConsumerInfo | undefined> {
    if (!this.kv) return undefined;
    let hydrated!: () => void;
    this.presenceSnapshot = new Promise<void>((resolve) => { hydrated = resolve; });
    const bound = await this.bindKvWatch(this.kv);
    if (!bound) {
      hydrated();
      return undefined;
    }
    const { iter, info } = bound;
    this.presenceWatchIter = iter;
    // A bucket with no keys replays nothing, so no entry carries the end-of-replay marker. For an
    // observer that does not register, that empty replay is the whole snapshot: nobody is present.
    // A registering observer is populated by its own record instead (see onPresenceBucketEmpty).
    const empty = info.num_pending === 0 && !this.doRegister;
    if (empty) {
      this.presenceSnapshotPopulated = true;
      hydrated();
      this.markPresenceBucketEmpty();
    }
    void (async () => {
      let ready = empty;
      for await (const e of iter) {
        // A rebind bound a newer watch: this one's remaining entries belong to a retired epoch.
        // Stop consuming them (the rebind stops the iterator too; this ends the loop first).
        if (this.presenceWatchIter !== iter) break;
        this.handleKvEntry(e);
        // @nats-io/kv marks the final initial replay entry isUpdate=true. Later updates stay true.
        if (!ready && e.isUpdate) {
          ready = true;
          this.presenceSnapshotPopulated = true;
          hydrated();
          this.emitPresenceViewIfChanged();
        }
      }
      hydrated();
    })().catch((e) => this.emit("error", e as Error));
    return info;
  }

  /** `readOnce`: fill the roster from one read of the presence bucket. Stale
   *  and offline records resolve as they do in a watch's initial replay. */
  async readPresenceOnce(): Promise<void> {
    if (!this.kv) return;
    for (const e of await lastKvEntries(this.kv)) this.handleKvEntry(e);
    this.presenceSnapshotPopulated = true;
    // No record reached the roster (an empty bucket, or only the TTL canary): nobody is present.
    if (this.lastPresenceWatchAt === 0) this.markPresenceBucketEmpty();
    else this.emitPresenceViewIfChanged();
  }

  /**
   * Replace a presence watch that has gone silent past TTL while the connection is up. The new
   * ordered consumer starts from the bucket's current last-per-subject state, so a peer that is
   * heartbeating is re-observed within one replay and a peer that is gone is aged out by the
   * next sweep exactly as if the watch had never stalled. Rate-limited to one attempt per TTL
   * per observer, never overlapping, never on a stopped or rebuilding endpoint (those own their
   * watch through the endpoint connection bind). A stop or rebuild that lands while the bind is in
   * flight retires it: {@link startPresenceWatch} retires the late watch and reports
   * nothing, since the epoch that was silent no longer exists. A failed bind is reported and
   * the view stays stale.
   */
  private rebindStalePresenceWatch(now: number): void {
    if (this.stopped || this.reconnecting || !this.kv || !this.nc || this.nc.isClosed()) return;
    if (this.presenceRebind || now - this.presenceRebindAt < this.ttlMs) return;
    this.presenceRebindAt = now;
    const old = this.presenceWatchIter;
    const epoch = this.presenceEpoch;
    this.presenceRebind = (async () => {
      try {
        const silentMs = now - this.lastPresenceWatchAt;
        // Bind the replacement FIRST. A rebind the broker refuses (stream gone, create denied) or
        // one a held link never answers must leave the old watch in place: on a plain stall that
        // watch is the one that recovers by itself, and its replay is still guarded against
        // expired PUTs. Only a successfully bound watch retires its predecessor.
        const info = await this.startPresenceWatch();
        // Retired mid-bind (stop or rebuild moved the epoch): the late watch is already
        // retired and the old watch was torn down by whoever moved the epoch. Nothing to
        // retire, nothing to report.
        if (!info) return;
        // The predecessor's consumer goes with it: left alone, every rebind of a silent bucket
        // would add one idle consumer to the presence stream per TTL (#3914).
        if (old && old !== this.presenceWatchIter) this.retireKvWatch(old);
        // A bucket with no keys replays nothing, so the new watch cannot refresh
        // `lastPresenceWatchAt` by delivering. It IS current knowledge: nobody is present. The
        // bind's consumer info carries the initial pending count for that one fact; nats.js's KV
        // watch placed the isUpdate marker from the same `info(true)`.
        if (info.num_pending === 0) await this.onPresenceBucketEmpty();
        this.emit("warning", new Error(
          `presence watch silent for ${silentMs}ms with the connection up; rebound it from the bucket's current state`,
        ));
      } catch (e) {
        // A bind the epoch swap itself rejected (connection drained under it) is not a fault of
        // the epoch that replaced it; only a refusal on a still-current epoch is reported.
        if (epoch === this.presenceEpoch) this.emit("error", e as Error);
      } finally {
        // An epoch swap already disowned this flight (and may own a successor's by now); only
        // a flight still in its own epoch clears the slot. Within one epoch there is one flight.
        if (epoch === this.presenceEpoch) this.presenceRebind = undefined;
      }
    })();
  }

  /** The watch was just bound onto a bucket with no keys.
   *
   *  A NON-REGISTERING observer (a `cotal status` probe, a lease checker) has real knowledge:
   *  nobody is present. Every peer still in its roster is known gone (its key is not there to
   *  replay), so it is marked offline now rather than aged out against a delivery that cannot
   *  come; the silence gate is disarmed and the view reads current until the first write lands.
   *  Without that the empty-bucket view relapsed to stale one window later and rebound again on
   *  every window, one consumer create and one warning per TTL for as long as the mesh was empty.
   *
   *  A REGISTERING observer (the manager) is itself one of the keys that should be there. An
   *  empty bucket under it means the bucket was wiped since its last heartbeat (the stream
   *  recreation), and the same wipe took every peer's record: their absence says the bucket is
   *  new, not that they left. a reviewer reproduced the previous behaviour at default timing:
   *  the rebind landed ~0.9s after the recreation, the observer marked every peer AND ITSELF
   *  offline, and held the view current for up to one heartbeat, a false verdict `cotal ps`
   *  would print as `mesh offline`. So a registering observer re-publishes its own record NOW,
   *  which the new watch delivers, and lets the ordinary per-peer age-out run from that delivery:
   *  a peer that is still heartbeating rewrites its key within its own heartbeat interval and is
   *  re-observed live; one that is gone ages out exactly as after a plain rebind. The roster is
   *  not touched here and the view is not held; the delivery is what makes it current.
   *
   *  What neither branch covers: a consumer that dies again while the bucket is still empty is
   *  not detectable by silence, so the first write after that is missed until the observer
   *  restarts. */
  private async onPresenceBucketEmpty(): Promise<void> {
    if (this.doRegister) {
      // Our own key is missing from a bucket we write to: put it back. publishPresence throws on
      // a refused write; that surfaces through the rebind flight's error path with the epoch
      // fence intact, and the view stays stale, which is the honest state for an observer that
      // cannot even record itself.
      await this.publishPresence();
      return;
    }
    this.markPresenceBucketEmpty();
  }

  /** See {@link onPresenceBucketEmpty}: the non-registering branch. */
  private markPresenceBucketEmpty(): void {
    this.presenceWatchEmpty = true;
    this.lastPresenceWatchAt = 0;
    let changed = false;
    for (const [id, p] of this.roster) {
      if (p.status === "offline") continue;
      const offline = this.toOffline(p);
      this.roster.set(id, offline);
      this.emit("presence", { type: "offline", presence: offline });
      changed = true;
    }
    if (changed) this.emit("roster", this.getRoster());
    this.emitPresenceViewIfChanged();
  }

  private handleKvEntry(e: KvEntry): void {
    // Provisioning uses this one reserved key to prove the bucket's max_age is enforced (#404).
    // It is maintenance traffic, never a peer identity, an offline transition, or view freshness.
    if (e.key === TTL_RECONCILE_CANARY_KEY) return;
    this.lastPresenceWatchAt = Date.now();
    this.presenceWatchEmpty = false;
    if (e.operation === "DEL" || e.operation === "PURGE") {
      this.markOffline(e.key);
      return;
    }
    const p = this.decodePresence(e);
    if (p) this.applyPresence(e.key, p);
  }

  /** The record a presence PUT carries, or undefined when a reader must drop it (SPEC §6). The watch
   *  and {@link readPresence} decode through this one gate, so they drop the same records. */
  private decodePresence(e: KvEntry): Presence | undefined {
    let p: unknown;
    try {
      p = e.json<unknown>();
    } catch {
      return undefined;
    }
    if (!isPresenceRow(p, e.key)) {
      this.presenceBindingDrops++;
      this.emitRecoverable(new Error(`dropped presence entry for key ${JSON.stringify(e.key)}: not a usable presence row (a record with card.id equal to its KV key, a non-blank string card.name, a known status, a finite ts, string display fields and a condition with a string code)`));
      return undefined;
    }
    // isPresenceRow is the one gate: it refuses a row whose card.id disagrees with the KV key, so a
    // forged or mis-keyed record never surfaces a spoofed roster identity. The write-side scoping
    // ($KV.<presenceBucket>.<own-id>) is the primary guard.
    return p;
  }

  private applyPresence(id: string, raw: Presence): void {
    const prev = this.roster.get(id);
    const stale = Date.now() - raw.ts > this.ttlMs;
    // A watch recovering from a stall replays the bucket. Those PUTs still carry the publisher's
    // pre-stall timestamps, so they look TTL-expired even though the peers kept heartbeating on
    // the broker. Materializing them as offline is the empty-to-full flicker #1045 named: the
    // observer's catch-up, not N deaths. Keep last-known rows, stay view-stale, and wait for a
    // live timestamp (or an explicit offline/delete) before changing a known peer.
    if (stale && raw.status !== "offline") {
      if (prev) return;
      this.roster.set(id, this.toOffline(raw));
      this.emit("roster", this.getRoster());
      return;
    }
    if (this.presenceSnapshotPopulated) this.emitPresenceViewIfChanged();
    // Any offline materialization (a stale snapshot OR a graceful-leave record) drops the advisory
    // attention fields - an offline peer must not carry a stale `[focus]`/`locally muted` hint.
    const p: Presence =
      stale || raw.status === "offline" ? this.toOffline(raw) : raw;

    // First time we hear about an already-offline peer (stale snapshot): record quietly.
    if (!prev && p.status === "offline") {
      this.roster.set(id, p);
      this.emit("roster", this.getRoster());
      return;
    }

    // Heartbeat refresh with no real change: bump liveness quietly and don't
    // emit - otherwise the periodic keep-alive looks like a stream of "updates".
    // A CHANGED lifecycleUid is never a heartbeat: it is a NEW LIFECYCLE reusing the same principal (a
    // terminal same-name recreation - in user mode a retired lifecycle and its same-name successor
    // share `<owner>.<actor>`; a supervised respawn keeps the uid and is unaffected), so it MUST notify
    // watchers even when its status/activity match the prior lifecycle's lingering record. Omitting this
    // left a same-principal successor invisible to presence-event consumers (e.g. the manager's
    // readiness race), which then timed out "uncertain" on a healthy agent (#29).
    if (
      prev &&
      prev.status !== "offline" &&
      p.status !== "offline" &&
      prev.lifecycleUid === p.lifecycleUid &&
      sameRuntime(prev.runtime, p.runtime) &&
      prev.status === p.status &&
      prev.activity === p.activity &&
      sameCondition(prev.condition, p.condition) &&
      prev.environment === p.environment &&
      prev.attention === p.attention &&
      sameChannelModes(prev.channelModes, p.channelModes) &&
      prev.prompts?.open === p.prompts?.open &&
      prev.prompts?.seq === p.prompts?.seq
    ) {
      this.roster.set(id, p);
      return;
    }

    this.roster.set(id, p);
    const type: "join" | "update" | "offline" =
      p.status === "offline"
        ? "offline"
        : !prev || prev.status === "offline"
          ? "join"
          : "update";
    this.emit("presence", { type, presence: p });
    this.emit("roster", this.getRoster());
  }

  /** Materialize an OFFLINE presence record: drop the advisory attention fields. An offline peer must
   *  not show a stale `[focus]` or "locally muted #x" hint - SPEC: attention removed on offline sweep,
   *  channel modes reset on restart. `statusSince` goes too: it dated the live status, and an observer
   *  that derives offline from a stale heartbeat does not know when the peer left. `prompts` goes as
   *  well: an offline process serves nothing. card/activity/ts are kept. */
  private toOffline(p: Presence): Presence {
    return { ...p, status: "offline", statusSince: undefined, attention: undefined, channelModes: undefined, prompts: undefined };
  }

  /** Mark a known peer offline (on KV delete/purge), keeping it in the roster. */
  private markOffline(id: string): void {
    const prev = this.roster.get(id);
    if (!prev || prev.status === "offline") return;
    const offline = this.toOffline(prev);
    this.roster.set(id, offline);
    this.emit("presence", { type: "offline", presence: offline });
    this.emit("roster", this.getRoster());
  }

  private emitPresenceViewIfChanged(): void {
    const view = this.presenceView();
    if (view.state === this.presenceViewState) return;
    this.presenceViewState = view.state;
    this.emit("presence-view", view);
  }

  sweep(): void {
    const now = Date.now();
    // Whole-bucket silence past TTL is THIS observer going deaf. Real rosters do not lose every
    // peer in one window, and treating that silence as N offline verdicts empties an online-only
    // sidebar with nothing saying the window went blind (#1045). Gate the per-peer age-out on
    // watch freshness; surface the view as stale instead.
    if (this.lastPresenceWatchAt !== 0 && now - this.lastPresenceWatchAt > this.ttlMs) {
      this.emitPresenceViewIfChanged();
      // Staying stale is the right verdict for a held link (#1045), and the wrong END STATE when
      // the transport is up and the watch's own consumer is what died. Measured on a live deployment
      // 2026-09-09: the presence stream was deleted and recreated, its sequence restarted, and
      // every observer's ORDERED consumer re-created itself at the OLD start sequence (nats.js
      // 3.4.0 resets from its cursor). The broker kept sending idle heartbeats, so the client
      // never reset again, the iterator never closed, and the manager's roster stayed frozen at
      // the pre-recreation snapshot for hours: `cotal ps` read every older seat "mesh offline"
      // and every newer seat "not in roster" while all of them were heartbeating. The same
      // end state follows a plain consumer delete (an operator, or the 5-minute inactive
      // threshold after a long stall). Rebind the watch from the bucket's CURRENT state; a held
      // link's rebind fails or stays silent and the view simply stays stale, as before.
      this.rebindStalePresenceWatch(now);
      return;
    }
    let changed = false;
    for (const [id, p] of this.roster) {
      // A peer's own `ts` always trails the observer's last delivery, so "older than TTL by the
      // wall clock" alone ages peers out on the tick just before the whole-bucket gate above
      // trips (#1311's flap; measured as 3 offline verdicts per silence in the rebind suite).
      // Require that the watch itself delivered for a full TTL after this peer's last heartbeat:
      // then other peers were heard and this one was not, which is the only silence that is the
      // peer's rather than the observer's.
      if (p.status !== "offline" && now - p.ts > this.ttlMs && this.lastPresenceWatchAt - p.ts > this.ttlMs) {
        const offline = this.toOffline(p);
        this.roster.set(id, offline);
        this.emit("presence", { type: "offline", presence: offline });
        changed = true;
      }
    }
    if (changed) this.emit("roster", this.getRoster());
  }
}

/** Shallow-equal two per-channel-mode maps (presence dedup): a change must re-emit, so an attention
 *  toggle isn't swallowed as a quiet heartbeat. Absent and empty compare equal. */
function sameChannelModes(
  a?: Record<string, ChannelMode>,
  b?: Record<string, ChannelMode>,
): boolean {
  const ak = a ? Object.keys(a) : [];
  const bk = b ? Object.keys(b) : [];
  if (ak.length !== bk.length) return false;
  return ak.every((k) => a![k] === b?.[k]);
}

function sameRuntime(a: Presence["runtime"], b: Presence["runtime"]): boolean {
  return a?.id === b?.id && a?.startedAt === b?.startedAt && a?.source === b?.source;
}

function sameCondition(a: PresenceCondition | undefined, b: PresenceCondition | undefined): boolean {
  return a?.code === b?.code
    && a?.source === b?.source
    && a?.message === b?.message
    && a?.since === b?.since;
}

/** The deps of one endpoint's {@link EndpointPresence}. Every value is read from `ep` when it is used, so a field
 *  assigned after construction is seen, and a member a caller replaced on the endpoint is the one that runs. */
export function endpointPresenceDeps(ep: CotalEndpoint): EndpointPresenceDeps {
  return {
    card: () => ep["card"],
    space: () => ep["space"],
    bucket: () => ep["kv"],
    connection: () => ep["nc"],
    lifecycleUid: () => ep["ownLifecycleUid"],
    prompts: () => ep["servedPrompts"](),
    ttlMs: () => ep["ttlMs"],
    registers: () => ep["doRegister"],
    watches: () => ep["doWatch"],
    readsOnce: () => ep["readOnce"],
    stopped: () => ep["stopped"],
    reconnecting: () => ep["reconnecting"],
    epoch: () => ep["presenceEpoch"],
    notLiveMsg: () => ep["notLiveMsg"](),
    bindWatch: (kv) => ep["bindKvWatch"](kv),
    retireWatch: (iter) => ep["retireKvWatch"](iter),
    emit: (event, value) => ep["emit"](event, value),
    recoverable: (error) => ep["emitRecoverable"](error),
    isPublishPermissionDenied,
  };
}
