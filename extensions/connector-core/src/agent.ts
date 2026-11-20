import { EventEmitter } from "node:events";
import { hostname } from "node:os";
import {
  resolvePeer as resolvePeerInRoster,
  peerLabel,
  CotalEndpoint,
  DmDurableMissingError,
  acquireLocalConsumer,
  type HeldLock,
  BASELINE_LIFECYCLE_ENDPOINT,
  assertLifecycleToken,
  EpEnvelopeError,
  unansweredRequest,
  type EpAttributedReply,
  type RegistryEndpointsInput,
  type RegistryEndpointsOutput,
  type EpVerbTarget,
  type ControlReply,
  type Delivery,
  type AnycastStatus,
  type MessageMeta,
  type Presence,
  type PresenceCondition,
  type PresenceStatus,
  type TransportState,
  type AttentionMode,
  type ChannelMode,
  type CotalMessage,
  type InlinePersona,
  type PersonaEndpoint,
} from "@cotal-ai/core";
import { eventPlaneArmed, type AgentConfig } from "./config.js";
import { checkEventStartup, EventStateConflictError } from "./event-startup.js";
import { claimOnceHandoff } from "./once.js";
import { AgentManagerCalls, invokeUserManager } from "./manager-call.js";
import { openAgentEndpoint, type AgentEndpoint } from "./agent-endpoint.js";
import type { CommandDispatch, CommandDispatcher } from "./agent-commands.js";
import { AgentInbox, deliveryNoticeOf, type InboxItem, type InboxSnapshot, type InboxScope, type ExactDrainResult, type RecallMark } from "./agent-inbox.js";
import { AgentSupervision } from "./agent-supervision.js";
import { AgentChannels, isLocalServer } from "./agent-channels.js";
import { AgentMessaging } from "./agent-messaging.js";
import { AgentTurns, type ActiveTurn, type SettledTurn } from "./agent-turns.js";
export { afterRecallMark, MAX_INBOX } from "./agent-inbox.js";
export type { InboxItem, InboxSnapshot, InboxScope, ExactDrainResult, RecallMark, DeliveryNotice } from "./agent-inbox.js";

// Attention modes + per-channel overrides are defined in core (they're published in presence now);
// re-exported so connector consumers keep importing them from `@cotal-ai/connector-core`.
export type { AttentionMode, ChannelMode };

/** Grace for a mesh op issued while the link is still coming up. `start()` deliberately returns
 *  immediately so the connector's MCP surface boots while the broker is absent — which means a
 *  host that auto-submits a prompt (`cotal spawn --prompt`) can call a mesh tool a second or two
 *  after launch, several seconds before the first bind lands. Failing that call on the spot
 *  reports "the mesh is down" about a mesh that is merely still connecting, and the agent then
 *  repeats it to the user as fact. Waiting the window out is the honest answer; the bound is what
 *  keeps a genuinely dead broker from becoming a hang instead of an error. */
export const CONNECT_GRACE_MS = 10_000;

/** The card key that says whether this session arms its event plane. Namespaced, because SPEC §11
 *  reserves bare meta keys to the spec. */
export const EVENTS_META_KEY = "ai.cotal.events";

/** The display-only `AgentCard.meta` for a session. Agent-file metadata is preserved, then
 *  connector-owned fields are overlaid so files cannot spoof the hosting harness. */
function buildMeta(config: AgentConfig, processCwd: boolean, eventsArmed?: boolean): Record<string, string> | undefined {
  const meta: Record<string, string> = { ...(config.meta ?? {}) };
  if (config.model) meta.model = config.model;
  if (config.variant) meta.variant = config.variant;
  if (config.connector) meta.connector = config.connector;
  // WHICH MACHINE this agent runs on. A mesh spans hosts (a manager on another box launches into
  // its own machine), so "where is this agent actually running" is not answerable from the roster
  // without it. This process IS the agent's session, so its own hostname is the authoritative
  // answer — and, like `connector`, it is overlaid LAST so an agent file cannot declare a host it
  // is not on. Advisory display metadata, never an authorization or routing input.
  meta.host = hostname();
  // A routing hint only. The broker's instance grants and the manager's live map still decide.
  delete meta["ai.cotal.manager.instance"];
  if (config.managerInstanceId) meta["ai.cotal.manager.instance"] = config.managerInstanceId;
  // Whether the session arms its event plane, from the predicate the emitting connectors branch on.
  // Overlaid with the other connector-owned keys, so an agent file cannot declare it. Advisory.
  meta[EVENTS_META_KEY] = (eventsArmed ?? eventPlaneArmed(config)) ? "on" : "off";
  // Snapshot the connector process directory when the session is constructed. This is display
  // metadata, not a model harness's later shell directory or a routing/authorization input. A
  // connector whose process directory is not the session's leaves it unknown until the harness
  // reports one (`setCwd`); an agent-file value never stands in for it.
  if (processCwd) meta.cwd = process.cwd();
  else delete meta.cwd;
  return Object.keys(meta).length ? meta : undefined;
}

/** Connector-owned construction options, never read from an agent file. */
export interface MeshAgentOptions {
  /** The connector process directory is not this session's (one process hosts several sessions),
   *  so `meta.cwd` stays unknown until the harness reports it through {@link MeshAgent.setCwd}. */
  withholdProcessCwd?: boolean;
  /** The connector already decided to arm the event plane, then removed `COTAL_EVENTS` from the
   *  process environment. The card and startup check follow this decision. */
  eventsArmed?: boolean;
  /** The event state root read by the connector before it scrubbed the process environment. */
  eventsWorkspaceRoot?: string;
  /** A once task this seat pulled and did not claim within {@link ONCE_HANDOFF_MS} is sealed and
   *  reported. For a connector whose wake for the task is a push it cannot confirm, so a dead push
   *  cannot hold a served task. */
  onceClaimBound?: boolean;
  /** Lists and starts the harness commands and skills this agent's `agent` endpoint offers. Without
   *  one, `commands` answers `supported: false` and `command` is refused. */
  commands?: CommandDispatcher;
}

/** Host-authorized participation for one native personal connection. The connector validates the
 * identity fields against the live connection before arming its existing self-only turn relay. */
export interface NativeTurnParticipationLease {
  owner: string;
  actor: string;
  lifecycleUid: string;
  name: string;
  managerInstanceId: string;
  expiresAt: number;
}

/** Reply correlation for outgoing messages (SPEC §5): `contextId` is the asker's conversation id,
 *  `replyTo` the id of the message being answered. */
export interface Correlation {
  contextId?: string;
  replyTo?: string;
  /** The peer whose conversation the call runs in, for a caller with its own `contextId`: a DM to
   *  that peer answers it, and a DM to any other peer is a new question. */
  peerId?: string;
}
/** Repeated async NATS status errors can arrive once per ordered-consumer retry. They describe one
 * fault, not one hundred useful facts; keep the first visible and summarize at most twice a minute. */
const ENDPOINT_ERROR_LOG_WINDOW_MS = 30_000;
/** How many distinct endpoint notices {@link MeshAgent.logEndpointNotice} remembers for repeat
 *  suppression, oldest forgotten first, so a server producing novel error text on every request
 *  cannot grow the map. */
const MAX_ENDPOINT_NOTICES = 16;


function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitForStop(work: Promise<unknown>): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([work, new Promise<void>((resolve) => { timer = setTimeout(resolve, 3_000); })]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The five states a caller has to tell apart, derived in one place so every consumer agrees.
 *
 * `degraded` is the one that matters and the one a single boolean gets wrong: the endpoint is bound
 * but the socket underneath it is down, so sends queue or fail while the client reconnects. It is
 * NOT the same as `disconnected`, and it is not a stopped session either. `stopped` is terminal and
 * is not a fault at all.
 */
export type ConnectionState = "ready" | "stalled" | "degraded" | "connecting" | "disconnected" | "stopped";

/**
 * How long a non-empty automatic queue may make no progress before this session stops calling
 * itself `ready` (#1233).
 *
 * Generous on purpose. A healthy seat commits automatic deliveries within seconds of the turn that
 * carries them, and the incident this bound exists for ran for HOURS: 27 deliveries held 13.8h
 * behind timed-out soft interrupts, reported `ready` throughout. Ten minutes is far outside normal
 * turn length and far inside the window in which an operator still has a healthy seat to save.
 */
export const AUTOMATIC_QUEUE_STALL_MS = 600_000;

/**
 * A thin, mesh-native agent: a {@link CotalEndpoint} plus a buffered inbox and
 * name-based peer resolution. This is the shared core behind the MCP server
 * (and, later, the lifecycle hooks) — it owns the NATS connection and presence.
 *
 * Connecting is resilient: {@link start} kicks off a background retry loop so the
 * MCP server is responsive immediately even if the mesh isn't up yet.
 *
 * Emits `"incoming"` (InboxItem) when a message is buffered or an unacked durable copy
 * redelivers, so a push layer can apply its normal delivery policy again; `"mention-wake"`
 * (InboxItem) when a `focus`-mode agent is @-mentioned on a channel — the body was
 * acked-and-dropped (not buffered), so this
 * only asks the push layer to *wake* the agent to pull it; `"wake"` (no payload) to ask that
 * layer to wake the session now (the Stop→idle flush of held messages); `"command"` (no payload)
 * when a command waits for {@link MeshAgent.dispatchNextCommand}; `"stopping"` (no payload)
 * once, when {@link MeshAgent.stop} begins, whatever the transport's state; `"error"` (Error) for
 * endpoint faults.
 */
export class MeshAgent extends EventEmitter {
  readonly ep: CotalEndpoint;
  readonly config: AgentConfig;
  private readonly launchEnv?: NodeJS.ProcessEnv;
  private readonly managerCalls: AgentManagerCalls;
  private readonly options: MeshAgentOptions;
  private readonly inboxState = new AgentInbox({
    endpoint: () => this.ep,
    config: () => this.config,
    transportConnected: () => this._transportConnected,
    emit: (event, item) => this.emit(event, item),
    warning: (error) => this.handleEndpointWarning(error),
    noteDirected: (item) => this.noteDirected(item),
    inOrder: (write) => this.inOrder(write),
    requireConnected: () => this.requireConnected(),
  });
  /** How many times the endpoint saw this session's stored copies at their limit (#5404) since a
   *  cotal_inbox reply last carried the notice. */
  private _storedCopiesFull = 0;
  /** The count those stored copies held, from the latest copy that found them full. */
  private _storedCopiesLimit = 0;
  private _connected = false;
  /** Raw NATS transport liveness, separate from `_connected` (the full Cotal bind/readiness). */
  private _transportConnected = false;
  /** Latest connection failure, retained until the endpoint binds so a bounded readiness gate can
   * explain why an otherwise healthy host never joined the mesh. */
  private lastConnectionError?: string;
  private endpointNoticeLog = new Map<string, { lastLoggedAt: number; suppressed: number }>();
  private _status: PresenceStatus = "idle";
  /** The turn relay's seat-side intake: every pulled-and-unyielded run turn, by goal id. Fed by
   *  {@link pollTurns}; surfaced into host context by {@link surfacePendingTurns}; drained by
   *  {@link yieldTurn} (explicit) and the working→idle boundary in {@link setStatus} (automatic
   *  `done`). The pull is also the reconciler: a turn settled elsewhere (deadline, another yield
   *  path) vanishes from `turn-pending`, and the manager's notice for it brings the pull that drops it. */
  private activeTurns = new Map<string, ActiveTurn>();
  /** Turns that left this seat, by goal id: the run's settlement with its deadline, or this seat's
   *  own yield, so a late yield is refused with {@link settledTurnError}. Bounded by
   *  {@link MAX_SETTLED_TURNS}. */
  private settledTurns = new Map<string, SettledTurn>();
  /** Set once the launching manager's turn notices are subscribed; the endpoint re-binds the
   *  subscription on every rebuilt connection. */
  private turnNoticeArmed = false;
  /** The single retry after a pull that failed for a reason that can pass. Unset while pulls succeed. */
  private turnRetryTimer?: ReturnType<typeof setTimeout>;
  /** The timed pull for a launching manager whose answers say it sends no turn notices: a manager
   *  from before them. Unset while the manager says it sends them. */
  private legacyTurnPoll?: ReturnType<typeof setInterval>;
  private turnPollBusy = false;
  /** By message id, oldest first: the live DMs and anycasts peers sent us that no DM back has
   *  answered yet (bounded). `pending` marks one a DM in flight is answering; `text` is the start of
   *  its body, to name it when a DM must say which one it answers. */
  private readonly unanswered = new Map<
    string,
    { fromId: string; contextId?: string; text?: string; pending?: boolean }
  >();
  private _stopping = false;
  /** Presence writes go out IN CALL ORDER (#636, #2055). setStatus is two awaited puts and every
   *  connector fires it without awaiting, so two overlapping calls interleave their puts and the
   *  record that lands last is whichever call's second put finished last, not the call made last;
   *  at a driven turn's end the measured order was working, idle, working, and the seat then read
   *  working forever. Every write below runs its whole body through this chain, so the later
   *  call's puts start only after the earlier call's have settled. A rejected write must not
   *  poison the chain: the tail is swallowed and the next write still runs. */
  private presenceChain: Promise<void> = Promise.resolve();
  /** Host lifecycle status is independent of presence-only updates such as cotal_status. */
  private turnStatus: PresenceStatus | undefined;

  /** An explicit env scopes launch metadata and bearer subprocesses. Omitted preserves process inheritance. */
  constructor(config: AgentConfig, env?: NodeJS.ProcessEnv, options: MeshAgentOptions = {}) {
    super();
    this.config = config;
    this.options = options;
    this.launchEnv = env === undefined ? undefined : { ...env };
    this.managerCalls = new AgentManagerCalls(
      () => this.config,
      () => this.ep,
      () => this.launchEnv,
      (...args) => this.invokeEndpoint(...args),
    );
    // Seed per-channel attention from the operator's file default (one-way: the runtime never writes
    // back — the persona file is a shared template). muted/quiet are validated disjoint at file load.
    this.inboxState.seedChannelModes(config);
    const userAuth = config.userAuth;
    this.ep = new CotalEndpoint({
      space: config.space,
      environment: this.launchEnv === undefined ? undefined : this.launchEnv.COTAL_ENVIRONMENT ?? null,
      servers: config.servers,
      token: config.token,
      user: config.user,
      pass: config.pass,
      creds: config.creds,
      lifecycleUid: config.lifecycleUid,
      backfillFloor: config.backfillFloor,
      acceptedToken: config.acceptedToken,
      // USER MODE: the endpoint execs the spawner-provided argv per bearer refresh — the exchange
      // protocol lives entirely behind that command, this runtime just runs it and reads a line.
      // An in-process host supplies the function itself.
      bearer: userAuth ? (userAuth.bearer ?? (() => this.execBearerCmd(userAuth.bearerCmd!))) : undefined,
      sentinelCreds: config.userAuth?.sentinelCreds,
      tls: config.tls,
      ackWaitMs: config.ackWaitMs, // undefined → endpoint default (60s); shortened in tests to observe redelivery
      channels: config.subscribe, // the endpoint's live filter = the active read set
      allowSubscribe: config.allowSubscribe, // the complete ACL decides whether a DLV durable exists
      channelModes: this.channelModeEntries(), // seed presence so file defaults are visible at boot
      // A seat reads the roster when it acts (readRoster) instead of watching it: a watch delivers
      // every member's heartbeat to every member, K² per heartbeat in a space of K (SPEC §6).
      watchPresence: false,
      beforeBind: async () => {
        const env = this.launchEnv ?? process.env;
        if (this.eventStartupChecked || !(options.eventsArmed ?? eventPlaneArmed(config, env))) return;
        try {
          await checkEventStartup(this.ep, {
            ...env,
            COTAL_WORKSPACE_ROOT: options.eventsWorkspaceRoot ?? env.COTAL_WORKSPACE_ROOT,
          });
          this.eventStartupChecked = true;
        } catch (error) {
          // A space that requires events cannot admit a seat whose transcript cannot start.
          // Where events are optional the seat still starts: the plane stays down and the reason
          // is kept, which is what a stopped event plane already does after startup.
          if (config.eventsRequired === true) throw error;
          this.eventStartupChecked = true;
          this.eventPlaneBlocked = error instanceof Error ? error.message : String(error);
          this.lastConnectionError = this.eventPlaneBlocked;
        }
      },
      card: {
        id: config.id,
        name: config.name,
        role: config.role,
        kind: config.kind,
        description: config.description,
        tags: config.tags,
        // A bearer source can't declare the principal itself — the spawner does (endpoint pins
        // every fetched bearer to it).
        owner: config.userAuth?.owner,
        actor: config.userAuth?.actor,
        // Display-only discovery metadata so observers can show which harness an agent runs on
        // and (when pinned) which model. Each is omitted when unset rather than faked.
        meta: buildMeta(config, !options.withholdProcessCwd, options.eventsArmed),
      },
    });
    this.ep.on("message", (m: CotalMessage, d: Delivery, meta?: MessageMeta) => {
      const notice = meta?.kind === "dm" ? deliveryNoticeOf(m) : undefined;
      if (notice !== undefined) void this.inboxState.ingestNotice(m, d, meta!, notice);
      else this.inboxState.ingest(m, d, meta);
    });
    this.ep.on("error", (e: Error) => this.handleEndpointError(e));
    // A warning is a condition the endpoint is already surviving. Log it through the same bounded
    // operator sink, but never turn it into connectionIssue: readiness is still true.
    this.ep.on("warning", (e: Error) => this.handleEndpointWarning(e));
    this.ep.on("stored-copies-full", (full: { limit: number }) => { this._storedCopiesFull++; this._storedCopiesLimit = full.limit; });
    // Two guards, and the comments sit out here so neither anchors a mutation on prose. An
    // in-flight initial bind or rebuild can finish after stop() cleared local state, and shutdown is
    // terminal for this MeshAgent, so a late endpoint edge must not resurrect transport. Separately,
    // nats.js and clean shutdown can both confirm the same edge; a duplicate carries no state change
    // and must not wake consumers or let an old confirmation look like a new outage.
    this.ep.on("transport", (e: TransportState) => {
      if (this._stopping) return;
      if (this._transportConnected === e.connected) return;
      this._transportConnected = e.connected;
      this.inboxState.onTransport(e.connected);
      this.emit("transport", e);
      // A notice lost while the transport was down can only matter to a turn this seat holds: the
      // manager repeats the notice for a turn the seat has not pulled yet. So only a holder pulls.
      if (e.connected && this.turnNoticeArmed && this.activeTurns.size > 0) this.requestTurnPull();
    });
    // The endpoint's (re)binds are the single source of truth for connectedness: this fires on
    // initial start, manual reconnect, AND the background self-heal — so a recovery the endpoint
    // did on its own can't leave us thinking we're offline (which would skip stop() → leak).
    // Same stop race as the transport handler above: a late connectAndBind completion is not a new
    // session. Kept out of the block so the guard can be anchored on code alone.
    this.ep.on("connection", (e: { connected: boolean }) => {
      if (this._stopping) return;
      this._connected = e.connected;
      if (e.connected) {
        this.lastConnectionError = this.eventPlaneBlocked;
        this.endpointNoticeLog.clear();
      }
      this.emit("connection", e);
      // A rebuilt connection re-bound the notice subscription first; a holder pulls for the gap.
      if (e.connected && this.turnNoticeArmed && this.activeTurns.size > 0) this.requestTurnPull();
    });
  }

  get id(): string {
    return this.ep.card.id;
  }

  get connected(): boolean {
    return this._connected;
  }

  /** Whether this session's current NATS transport is live, independent of full endpoint readiness. */
  get transportConnected(): boolean {
    return this._transportConnected;
  }

  /** Current connection failure, including repeated presence writes refused on a live transport.
   *  A successful write clears that diagnosis. Pre-bind failures survive stop for post-mortem use. */
  get connectionIssue(): string | undefined {
    const presence = this._connected && this._transportConnected && !this._stopping
      ? this.presenceWriteFailure
      : undefined;
    if (presence !== undefined && presence.consecutiveFailures >= 2) {
      return `presence writes to bucket ${JSON.stringify(presence.bucket)} have failed ${presence.consecutiveFailures} consecutive times: ${presence.error ?? "write failed"}`;
    }
    return this.lastConnectionError;
  }

  /** #1356: the space's presence bucket has been refusing writes since this time, or `undefined`.
   *
   *  The endpoint can remain bound with a live transport while JetStream refuses its writes.
   *  Two consecutive failures make the session degraded; a successful write clears the record.
   *
   *  Presence writes can fail alongside other publishes. See CotalEndpoint.presenceWriteFailure. */
  get presenceWriteFailure(): {
    since: number;
    forMs: number;
    error?: string;
    bucket: string;
    consecutiveFailures: number;
    stuck: boolean;
  } | undefined {
    return this.ep.presenceWriteFailure();
  }

  /** The latest successful, non-empty inbox drain in this session. */
  get lastInboxDrainedAt(): number | undefined {
    return this.inboxState.lastInboxDrainedAt;
  }

  /** The latest drain that committed at least one AUTOMATIC (connector-managed) delivery. */
  get lastAutomaticDrainedAt(): number | undefined {
    return this.inboxState.lastAutomaticDrainedAt;
  }

  /** The latest drain that committed the automatic delivery that was then at the FRONT of the queue
   *  (#1526). This is the fact {@link automaticQueueStalledForMs} measures progress by; the looser
   *  {@link lastAutomaticDrainedAt} is still reported beside it, because the two disagreeing is
   *  precisely the shape of a wedged head being served around. */
  get lastAutomaticHeadDrainedAt(): number | undefined {
    return this.inboxState.lastAutomaticHeadDrainedAt;
  }

  /**
   * How long a non-empty automatic queue has been making no progress, or `undefined`.
   *
   * PROGRESS AT THE HEAD, not depth and not throughput. The queue is not stalled because it is deep;
   * it is stalled because the entries at the front of it are not coming off. The clock therefore
   * starts at the later of the arrival of the oldest still-queued delivery and the last commit that
   * took the queue's head, so a seat that is steadily draining keeps resetting it however busy it
   * is, and a seat that has not moved its head since that queue formed accrues from the moment it
   * formed.
   *
   * Keyed on the HEAD rather than on any automatic commit (#1526). The reported session held 96
   * deliveries with the oldest over two hours old and reported `ready` throughout: it was committing
   * fresh arrivals, and under a looser measure each of those reset the clock for the backlog behind
   * them. A seat that serves only its newest traffic is skipping its queue, not draining it, and the
   * messages that are actually undelivered are the ones the measure must speak for.
   *
   * Measured from the oldest ARRIVAL rather than from session start so a session that never drained
   * anything is still measurable — that is precisely the shape of a seat whose first soft interrupt
   * timed out.
   */
  automaticQueueStalledForMs(now = Date.now()): number | undefined {
    return this.inboxState.automaticQueueStalledForMs(now);
  }

  /** Whether {@link stop} has been called. Terminal, and never cleared: a stopped session does not
   *  serve again. This is the ONLY way to tell a deliberate shutdown from a lost connection, because
   *  `stop()` clears readiness and transport together, so those two read identically in both cases. */
  get stopping(): boolean {
    return this._stopping;
  }

  /** How many times this session's stored copies reached their limit since a cotal_inbox reply last
   *  said so, so older channel posts may have been dropped before they reached it (#5404). Zero when
   *  there is nothing to say. */
  get storedCopiesFull(): number {
    return this._storedCopiesFull;
  }

  /** The count the stored copies held when they last reached it, from the copy that said so. */
  get storedCopiesLimit(): number {
    return this._storedCopiesLimit;
  }

  /** A reply carrying the stored-copy notice went out, read when the count was `seen`. Clear what
   *  it covered; a limit seen while that reply was being built stays for the next one. */
  clearStoredCopiesFull(seen: number): void {
    this._storedCopiesFull = Math.max(0, this._storedCopiesFull - seen);
  }

  /** Session-local channel degradation, independent of transport liveness. */
  get channelDeliveryIssue(): string | undefined {
    return this.inboxState.channelDeliveryIssue;
  }

  /** The connection, write-health and channel-delivery facts combined. Repeated presence write
   *  failures or exhausted drop tracking degrade a bound session even with a live transport.
   *  Every combination maps, so a caller never has
   *  to guess what an unlisted pair means, and a caller that disagrees with this reading can still
   *  read {@link connected}, {@link transportConnected} and {@link stopping} directly.
   *
   *  `stalled` is the fourth fact and it is not about the connection at all — see
   *  {@link automaticQueueStalledForMs}. It is reported HERE, ahead of `ready`, because #1233 was
   *  not a caller misreading the facts: a seat holding 27 undeliverable messages for 13.8 hours
   *  answered this question with `ready`, and every operator who asked it was told the seat was
   *  fine. A status that reads healthy while the thing it describes is not happening is the defect,
   *  so the one word a caller acts on has to move. It is ordered below `degraded` deliberately: a
   *  dead socket is the more specific and more actionable fault, and reporting the queue symptom
   *  over its own cause would hide it. */
  get connectionState(): ConnectionState {
    if (this._stopping) return "stopped";
    if (this._connected) {
      if (this.channelDeliveryIssue) return "degraded";
      if ((this.presenceWriteFailure?.consecutiveFailures ?? 0) >= 2) return "degraded";
      if (!this._transportConnected) return "degraded";
      const held = this.automaticQueueStalledForMs();
      return held !== undefined && held >= AUTOMATIC_QUEUE_STALL_MS ? "stalled" : "ready";
    }
    return this._transportConnected ? "connecting" : "disconnected";
  }

  /** Wait for the endpoint's real post-bind connection signal. `start()` deliberately stays
   * background for connectors whose MCP surface must boot while the broker is absent; a host that
   * advertises mesh readiness uses this bounded gate before making that claim. */
  async waitUntilConnected(timeoutMs = 15_000): Promise<void> {
    if (this._connected) return;
    await new Promise<void>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      let settled = false;
      const finish = (error?: Error): void => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        this.off("connection", onConnection);
        if (error) reject(error);
        else resolve();
      };
      const onConnection = (event: { connected: boolean }): void => {
        if (event.connected) finish();
      };
      this.on("connection", onConnection);
      timer = setTimeout(() => {
        const detail = this.connectionIssue ? ` Last error: ${this.connectionIssue}` : "";
        finish(new Error(`mesh did not become ready at ${this.config.servers} within ${timeoutMs}ms.${detail}`));
      }, Math.max(1, timeoutMs));
      // Close the check→listen race if the endpoint connected between the first guard and handler bind.
      if (this._connected) finish();
    });
  }

  /** Begin connecting with background retry. Resolves after the first completed mesh join. */
  start(retryMs = 3000): Promise<void> {
    if (this._stopping) throw new Error("cannot start a stopped mesh session");
    if (!this.consumerClaim && this.config.lifecycleUid) {
      const { owner, actor } = this.ep.principal;
      this.consumerClaim = acquireLocalConsumer(this.config.servers, this.config.space, owner, actor, this.config.lifecycleUid);
    }
    return this.connectFlight ??= this.connectLoop(retryMs);
  }

  private consumerClaim?: HeldLock;
  private connectFlight?: Promise<void>;
  private agentEndpoint?: AgentEndpoint;
  private agentEndpointOpened = false;
  private eventStartupChecked = false;
  private eventPlaneBlocked?: string;

  private async connectLoop(retryMs: number): Promise<void> {
    while (!this._stopping && !this._connected) {
      try {
        await this.ep.start();
        if (this._stopping) return;
        // _connected is set by the endpoint's "connection" event (fired inside start()), not here.
        this.log(
          `connected to ${this.config.servers} as ${peerLabel(this.config)} in space "${this.config.space}" on #${this.config.subscribe.join(", #")}`,
        );
        // The one user-visible surface of the boot backfill (M2, issue #545): the count is exact
        // right here, before anything else can drain the pull-only lane the backfill filled.
        const historicalBuffered = this.peekInbox("pull-only").filter((i) => i.historical).length;
        this.log(
          `joined ${this.config.subscribe.length} boot channel(s): ${historicalBuffered} historical message(s) buffered pull-only` +
            (this.config.backfillFloor !== undefined ? ` (backfill floor ${this.config.backfillFloor})` : ""),
        );
        this.armTurnRelay();
        void this.serveAgentEndpoint();
      } catch (e) {
        const error = e instanceof Error ? e : new Error(String(e));
        // stop() can win while the initial endpoint start is still pending. A rejection arriving
        // after that terminal decision is teardown noise, not a new connectionIssue for the stopped
        // session, and there is no next retry to explain or sleep toward.
        if (this._stopping) return;
        this.lastConnectionError = error.message;
        if (error instanceof EventStateConflictError) {
          await this.ep.stop();
          this.consumerClaim?.release();
          this.consumerClaim = undefined;
          throw error;
        }
        // #1356: "mesh unreachable" was asserted unconditionally, including while this same object
        // held `transportConnected: true` — measured against a presence bucket whose writes the
        // broker refuses: broker up, TCP connected, every sibling stream writable, and the operator
        // told the mesh was down. An anonymous error makes an operator look; a wrong one makes them
        // look in the wrong place. Both facts are already here, so report the one that is true.
        // The presence sentence CLAIMS the transport is fine, so it is reachable only while a live
        // transport observation says so. The endpoint clears the record whenever a connection is torn
        // down, which is the primary guard; this is the second one, for a transport that drops without
        // a teardown running. Belt and braces, because the failure this replaced was a confident wrong
        // answer and the cost of one redundant check is lower than the cost of another.
        const presence = this._transportConnected ? this.ep.presenceWriteFailure() : undefined;
        // "for 0s" on the first retry read like a broken template. Report a sub-second age as "<1s"
        // rather than rounding it up to a duration that has not elapsed yet.
        const forS = presence === undefined ? "" : presence.forMs < 1000 ? "<1" : String(Math.round(presence.forMs / 1000));
        const diagnosis = presence
          ? `connected, but this space's presence bucket "${presence.bucket}" has refused every write for ${forS}s (${presence.error ?? error.message}) - the transport is fine and the fault is not the network`
          : this._transportConnected
            ? `transport is connected but the mesh bind did not complete (${error.message})`
            : `mesh unreachable (${error.message})`;
        this.log(`${diagnosis}; retrying in ${retryMs}ms`);
        await sleep(retryMs);
      }
    }
  }

  /** Only a user-auth credential names who may call (SPEC 13.21), so an open or static mesh serves
   *  nothing. */
  private async serveAgentEndpoint(): Promise<void> {
    if (this.agentEndpointOpened || !this.config.userAuth) return;
    this.agentEndpointOpened = true;
    try {
      const served = await openAgentEndpoint(this.ep, {
        warn: (msg) => this.log(msg),
        dispatcher: this.options.commands,
        onQueued: () => this.emit("command"),
      });
      if (this._stopping) return void served.close();
      this.agentEndpoint = served;
      // A command that arrived before the broker confirmed the serve was announced to a connector
      // that could not take it yet.
      if (served.commands.queued > 0) this.emit("command");
    } catch (e) {
      this.log(`the agent endpoint is not served: ${(e as Error).message}`);
    }
  }

  /** Commands waiting for {@link dispatchNextCommand}. */
  get queuedCommands(): number {
    return this.agentEndpoint?.commands.queued ?? 0;
  }

  /** Hand the oldest waiting command to the connector's dispatcher. Call it only while no turn runs. */
  dispatchNextCommand(): Promise<CommandDispatch> {
    return this.agentEndpoint?.commands.dispatchNext() ?? Promise.resolve("empty");
  }

  private stopFlight?: Promise<void>;

  stop(): Promise<void> {
    return this.stopFlight ??= this.stopOnce();
  }

  private async stopOnce(): Promise<void> {
    this._stopping = true;
    this.emit("stopping");
    this.inboxState.stop();
    this.managerCalls.clear();
    if (this.turnRetryTimer !== undefined) {
      clearTimeout(this.turnRetryTimer);
      this.turnRetryTimer = undefined;
    }
    if (this.legacyTurnPoll !== undefined) {
      clearInterval(this.legacyTurnPoll);
      this.legacyTurnPoll = undefined;
    }
    const agentEndpointClosed = this.agentEndpoint?.close();
    // stop() is a local terminal fact. Do not wait for an endpoint event that intentionally ignores
    // its own stopped close, or leave a cleanly stopped session reporting either state as live.
    this._connected = false;
    if (this._transportConnected) {
      this._transportConnected = false;
      this.emit("transport", { connected: false });
    }
    // The close answers every prompt caller at once, and those replies must go out before the
    // departure closes the connection. A drain on a connection that is down settles only on its
    // close, so the wait is bounded.
    if (agentEndpointClosed) await waitForStop(agentEndpointClosed);
    // Unconditional: a background self-heal can flip _connected without us, so a `_connected`
    // guard could skip the stop and leak the live connection/heartbeat/supervisor. ep.stop()
    // coalesces its retained shutdown outcome, including an earlier closure refusal.
    // #636: departure is the last write. Running it THROUGH the chain (as its own inOrder entry,
    // not merely awaited alongside it) orders offline behind every write already admitted,
    // whichever method admitted it — setStatus's requireConnected included. The race is bounded so
    // a wedged write cannot hang shutdown; on the timeout path the chain is abandoned but the
    // endpoint must still stop, so ep.stop() runs directly once there. Every write admitted AFTER
    // this point is refused at once by inOrder() (see there) rather than queued behind departure,
    // so a straggler cannot land after offline and does not sit out setStatus's connect grace.
    const departure = this.inOrder(() => this.ep.stop(), true);
    await waitForStop(departure);
    await this.ep.stop();
    await departure;
    // A late initial bind must finish its stopped teardown before custody is released.
    // A permanent startup refusal is reported by start(); stop must still release its custody.
    await this.connectFlight?.catch(() => {});
    this.consumerClaim?.release();
    this.consumerClaim = undefined;
  }

  /** Manual reconnect: tear down the mesh connection and rebuild it in-process, WITHOUT
   *  stopping the agent (the recovery path, so it does NOT assert connected). Delegates to
   *  {@link CotalEndpoint.reconnect}, which is serialized with the self-heal supervisor and
   *  interruptible. Returns a one-line status for the caller to surface (e.g. the
   *  cotal_reconnect tool → TUI); on failure the endpoint keeps retrying in the background. */
  async reconnect(): Promise<{ ok: boolean; message: string }> {
    if (this._stopping) {
      return {
        ok: false,
        message: "This session is shutting down, so its Cotal mesh connection cannot be reconnected. Start a new session instead.",
      };
    }
    try {
      await this.ep.reconnect();
      // _connected is set by the endpoint's "connection" event on the successful rebind, not here.
      //
      // #1233: a rebuilt connection is NOT a served queue. The measured seat's transport was up the
      // whole time, so this call rebound a connection that was never broken and answered
      // "Reconnected ✓" over 27 deliveries it had not touched — a recovery path reporting success
      // while doing nothing, which sent the operator looking for a different remedy. The rebind is
      // still reported honestly as a success, because it succeeded; what is added is the fact that
      // makes the reply actionable, from the same measurement the state uses.
      const held = this.automaticQueueStalledForMs();
      const queued = this.inboxCount("automatic");
      const stalled =
        held !== undefined && held >= AUTOMATIC_QUEUE_STALL_MS && queued > 0
          ? ` Note: this session's ${queued} queued automatic ${queued === 1 ? "delivery has" : "deliveries have"} made no progress for ${Math.round(held / 60_000)} minutes. Reconnecting did not deliver ${queued === 1 ? "it" : "them"}: the connection was not what was holding ${queued === 1 ? "it" : "them"} up.`
          : "";
      const channelIssue = this.channelDeliveryIssue;
      const message = channelIssue
        ? `Transport reconnected (${this.config.name}@${this.config.space}), but this session remains degraded. ${channelIssue} Direct messages and anycast remain available. Restart this session to restore ambient channel delivery.`
        : `Reconnected ✓ (${this.config.name}@${this.config.space})`;
      return { ok: true, message: `${message}${stalled}` };
    } catch (e) {
      if (e instanceof DmDurableMissingError) {
        this.handleEndpointWarning(e);
        return { ok: false, message: `Reconnect failed: ${missingInboxIssue(e)}` };
      }
      return { ok: false, message: `Reconnect failed: ${(e as Error).message || (e as Error).name}. Still retrying automatically — or run /reconnect to retry now.` };
    }
  }

  /** Return pending messages in stable receive order. Automatic delivery excludes quiet ambient;
   *  pull-only is the explicit cotal_inbox lane.
   *
   *  A role request whose take is not yet recorded is never returned (SPEC §8.1): a host shows one
   *  only through {@link takeChosen}. */
  peekInbox(scope: InboxScope = "all"): InboxItem[] {
    return this.inboxState.peekInbox(scope);
  }

  /** Every pending message in scope as {@link peekInbox} will return it once the held role requests
   *  that may be asked about now are taken, in that order. It is for choosing what to show, never for
   *  showing: hand the choice to {@link takeChosen}. */
  inboxPreview(scope: InboxScope = "all"): InboxItem[] {
    return this.inboxState.inboxPreview(scope);
  }

  /** Choose what to show from {@link inboxPreview}, ask the delivery daemon to record the take of
   *  each held role request in the choice, wait up to `waitMs` for the answers, and return the chosen
   *  items that may be shown now, in the order chosen. A take is a claim that this session's agent is
   *  about to see the request, which ends its sender's chance to cancel it, so call this just before
   *  showing and choose only what will be shown. A request whose take is refused or not yet decided
   *  is left out. Never throws. */
  async takeChosen(
    scope: InboxScope,
    choose: (preview: InboxItem[]) => readonly InboxItem[],
    waitMs?: number,
  ): Promise<InboxItem[]> {
    return this.inboxState.takeChosen(scope, choose, waitMs);
  }

  /** How many role requests are held because their take is pending or could not be decided, and why. */
  heldTakes(): { count: number; detail?: string } {
    return this.inboxState.heldTakes();
  }

  /** Mark a surfaced batch as mid-delivery, so the overflow valve will not evict it out from under
   *  the host. Pair with {@link releaseInFlight} on the delivery verdict, whichever way it goes.
   *
   *  **Counted, not a set.** Hook frames overlap, so the same id is routinely in two open batches at
   *  once; if a hold were a boolean, the first frame's verdict would unprotect ids the second is
   *  still delivering, and an arrival between the two verdicts would ack one — the very loss this
   *  guard exists to stop, reached through the concurrency the per-frame keying deliberately allows.
   *
   *  **All or nothing, and it says which.** At the {@link MAX_IN_FLIGHT} ceiling this refuses the
   *  whole batch and returns `false`; the caller must then NOT surface it. Protecting only part of a
   *  batch, or protecting none while the caller surfaces anyway, silently reopens exactly the loss
   *  this guard exists to close — the unprotected ids sit in the inbox for the whole handoff window
   *  with the overflow valve free to ack them. Declining to surface costs a deferral: the messages
   *  stay buffered and go out on a later frame, once a verdict releases capacity. */
  holdInFlight(ids: readonly string[]): boolean {
    return this.inboxState.holdInFlight(ids);
  }

  /** Whether this id is currently protected from the overflow valve — i.e. some frame is mid-delivery
   *  holding it. Read-only observability for the property {@link holdInFlight} establishes. A caller
   *  that needs a batch to actually BE in flight before it acts must wait on this, never on a sleep:
   *  the handoff runs through a real relay process whose latency is not the caller's to predict. */
  isInFlight(id: string): boolean {
    return this.inboxState.isInFlight(id);
  }

  /** One frame's verdict is in (either way). The id is ordinary backlog again only once EVERY frame
   *  holding it has reported — a release from one must not speak for another still in flight. */
  releaseInFlight(ids: readonly string[]): void {
    return this.inboxState.releaseInFlight(ids);
  }

  /** Return scoped pending messages and ack them — call only when they're actually surfaced. */
  drainInbox(limit?: number, scope: InboxScope = "all"): InboxItem[] {
    return this.inboxState.drainInbox(limit, scope);
  }

  /** Ack exact surfaced deliveries without assuming they still form the physical inbox prefix.
   *  Takes RECEIVE keys ({@link InboxItem.recvKey}): the wire id for real messages, a minted key
   *  for id-less ones, and selects by them, so a host that surfaced one empty-id item drains THAT
   *  delivery, never its neighbors: the sweep the raw id produced (every pending empty-id item
   *  acked and marked handled in one call) is closed by construction, not by filtering. Every
   *  requested key whose item is present is acked and (for a real id) marked handled, including an
   *  item overflow-evicted during the turn. */
  drainInboxDeliveries(keys: readonly string[]): ExactDrainResult {
    return this.inboxState.drainInboxDeliveries(keys);
  }

  /** Receive keys of the pending messages in scope, role requests held for their take included,
   *  for bookkeeping that shows no body. */
  inboxKeys(scope: InboxScope = "all"): string[] {
    return this.inboxState.inboxKeys(scope);
  }

  /** The pending messages in scope, role requests held for their take included, for a notice that
   *  counts them and shows no body. A held request is shown only through {@link takeChosen}. */
  inboxPending(scope: InboxScope = "all"): InboxItem[] {
    return this.inboxState.inboxPending(scope);
  }

  /** Pending messages in scope, counting role requests still held for their take. */
  inboxCount(scope: InboxScope = "all"): number {
    return this.inboxState.inboxCount(scope);
  }

  /**
   * Read a bounded presentation snapshot without draining, acknowledging, committing, holding or
   * changing attention. Each item is a shallow copy: reassigning its fields leaves the live inbox
   * unchanged, but nested values such as `mentions` are shared, so callers must treat items as
   * read-only.
   */
  inboxSnapshot(limit = 3): InboxSnapshot {
    return this.inboxState.inboxSnapshot(limit);
  }

  /** Local receive time of the oldest still-buffered automatic delivery, if any. */
  oldestAutomaticReceivedAt(): number | undefined {
    return this.inboxState.oldestAutomaticReceivedAt();
  }

  /**
   * How far this session has read the focus-mode channel recall.
   *
   * {@link recallAmbient} re-derives the same items from an unchanged frontier on every call, so a
   * reader that shows only what fits in one response would show the same prefix forever. This mark
   * moves when a response actually delivered recall items, and it belongs to ONE walk over ONE
   * frontier: it says how far this focus episode has read, not what the stream still holds, and
   * {@link setAttention} forgets it whenever the frontier under it changes.
   *
   * WHAT THIS MARK DOES NOT OWN, said here so nothing above it claims otherwise. It orders what
   * {@link recallAmbient} hands over; it does not decide what becomes recallable. A message that only
   * becomes readable after this mark has passed its timestamp, through late persistence, is below the
   * watermark and will not be walked to. That is governed by the frontier `recallAmbient` derives from
   * ({@link chatFrontier} and the focus watermark), not here, and it is the same for any
   * timestamp-ordered reader of that stream.
   *
   * What the mark DOES own is where it can be moved to, and only this session's own traffic may move
   * it: an item stamped ahead of the local clock is walked by {@link recallAhead}, not by this mark,
   * so no sender can push it past the messages it has not read yet.
   */
  get recallCursor(): RecallMark {
    return this.inboxState.recallCursor;
  }

  /**
   * Record the last recall item actually handed to the caller.
   *
   * The mark is a PAIR, not a timestamp, because two recall items can share a millisecond: a
   * timestamp alone either filters the twin out for good, if it advances past both, or re-serves the
   * one already delivered, if it stops below them. Ordering by `(ts, id)` gives every item a place of
   * its own, so the next call resumes strictly after the last one delivered.
   */
  noteRecalled(mark: RecallMark): void {
    return this.inboxState.noteRecalled(mark);
  }

  /**
   * Does this recall item claim a time this session has not reached?
   *
   * `ts` is stamped by the SENDING endpoint, so it is neither trustworthy nor bounded, and a mark
   * that walks it is a mark a peer can move. One message stamped far ahead otherwise parks
   * {@link recallCursor} in the future: every ordinary message after it sorts below the mark, is
   * filtered out of recall for the rest of the session, and the reply says there is no chatter. That
   * is one peer suppressing OTHER peers' recall, which makes it a security property and not only a
   * clock one, and the defence has to hold when the field is chosen rather than merely wrong.
   *
   * So the walk splits. An item at or behind this session's clock is ordered by its timestamp and
   * moves the mark. An item ahead of it is not ordered at all and NEVER moves the mark: it is handed
   * over once and remembered by id ({@link noteRecalledAhead}), so it neither leads the walk nor
   * comes back on the next call.
   *
   * THE LANES SWAP MEMBERSHIP, and the record is what keeps them honest with each other. An item
   * stamped just ahead of the clock crosses into the ordered lane the moment the clock passes it,
   * arriving above a mark that never moved for it, so the reader has to consult
   * {@link recallAheadSeen} there too or hand it over a second time. That crossing is the one part of
   * this mechanism that cannot be staged by choosing timestamps, so its cell waits for real time
   * rather than reasoning about it.
   */
  recallAhead(item: { ts: number }): boolean {
    return this.inboxState.recallAhead(item);
  }

  /** Has this future-stamped recall item already been handed over in this session? */
  recallAheadSeen(id: string): boolean {
    return this.inboxState.recallAheadSeen(id);
  }

  /**
   * How many more future-stamped recall items this session will take responsibility for.
   *
   * Exactness costs memory, and that memory is what a flood of forged stamps would grow, so it is
   * bounded. A caller must not hand over what it cannot record, or it will hand it over again on
   * every call forever; past this bound it has to say so instead. Note where the cost lands: an item
   * at or behind the clock never enters this set, so a peer that spends the whole bound spends it on
   * ITS OWN messages and cannot use it to silence anyone else's.
   */
  recallAheadRoom(): number {
    return this.inboxState.recallAheadRoom();
  }

  /** Record that a future-stamped recall item was actually handed to the caller. */
  noteRecalledAhead(id: string): void {
    return this.inboxState.noteRecalledAhead(id);
  }

  /** Buffered receive-time lane for one delivery, addressed by its receive key. Undefined means it
   *  is no longer pending. */
  inboxScope(key: string): Exclude<InboxScope, "all"> | undefined {
    return this.inboxState.inboxScope(key);
  }

  /** Count of automatic messages that count as directed for a wake decision: real dm/anycast
   *  (authenticated kind) or a live channel @mention. Pull-only history never counts, including
   *  mentions retained while focused. The Stop→idle flush uses this in `dnd`/`focus`. */
  directedPendingCount(): number {
    return this.inboxState.directedPendingCount();
  }

  /** Buffered items that should WAKE a Stop→idle flush — the mode-and-channel-aware predicate the
   *  connectors use instead of branching on attention themselves:
   *  - directed (dm/anycast) or a live @mention → always (a quiet live @mention wakes; muted never buffers);
   *  - NORMAL automatic ambient → only under global `open` (today's behavior);
   *  - receive-time pull-only ambient → never.
   *  Subsumes {@link directedPendingCount}: in `dnd`/`focus` (no override) the open term is false, so it
   *  equals the directed count; in `open` it adds normal ambient but excludes quiet-channel ambient.
   *  `skip` leaves out items the caller has already woken the session for. */
  pendingWake(skip?: (item: InboxItem) => boolean): number {
    // An unsurfaced run turn is directed-strength: it wakes regardless of attention, exactly like
    // a DM — a run is waiting on this seat, and holding it costs the run its deadline.
    const turns = [...this.activeTurns.values()].filter((t) => !t.surfaced && this.offerable(t)).length;
    return turns + this.inboxWake(skip);
  }

  /** The inbox half of {@link pendingWake}: buffered items that should wake the agent, without run
   *  turns. A surface that cannot surface a run turn, such as the remote gateway, waits on this, so
   *  a turn it can never clear does not end every wait at once. */
  inboxWake(skip?: (item: InboxItem) => boolean): number {
    return this.inboxState.inboxWake(skip);
  }

  /** Ask any push layer (the channel) to wake the session now — used by the Stop→idle flush
   *  to deliver a batch of held messages. Emits `"wake"`; a no-op if nothing listens. Never acks
   *  or drains. Ack sites are now two: {@link drainInbox} (surfaced items) and the focus ingest
   *  ack-drop (ambient/@mentions a focus agent chose not to receive into context). */
  requestWake(): void {
    this.emit("wake");
  }

  // ---- attention ------------------------------------------------------------

  /** This agent's global attention mode. Authoritative here; mirrored to presence (advisory) so peers
   *  can see it. Delivery never reads it back from presence — local state wins. */
  get attention(): AttentionMode {
    return this.inboxState.attention;
  }

  /** This agent's per-channel override for `channel` (undefined ⇒ follow the global mode). */
  channelMode(channel?: string): ChannelMode | undefined {
    return this.inboxState.channelMode(channel);
  }

  /** A snapshot of every per-channel override (for the at-a-glance views). */
  channelModeEntries(): Record<string, ChannelMode> {
    return this.inboxState.channelModeEntries();
  }

  /** Set (or clear, with `"normal"`) one channel's attention override. Validates the channel is
   *  concrete and within this agent's read ACL (`allowSubscribe` — so a mode can be pre-set for a
   *  channel it may read but hasn't joined yet), updates the AUTHORITATIVE in-memory map, then mirrors
   *  the whole map to presence (best-effort; advisory). Per-instance + runtime: it NEVER writes the
   *  agent file (a shared template) and resets on restart.
   *
   *  It does not purge messages already buffered from that channel. Quiet makes its buffered ambient
   *  pull-only, and muted makes everything buffered from it pull-only, mentions included, so neither
   *  enters another turn and both stay readable with cotal_inbox. `normal` makes nothing automatic
   *  again. */
  async setChannelMode(channel: string, mode: ChannelMode | "normal"): Promise<void> {
    return this.inboxState.setChannelMode(channel, mode);
  }

  /** Set the attention mode. Entering `focus` captures the chat frontier as the focus-watermark
   *  (recall surfaces ambient published after it); leaving focus clears it. Requires a live
    *  connection only for `focus` (it reads the stream frontier). Ambient already *buffered* when
    *  focus is entered is not retroactively ack-dropped. Traffic retained during the asynchronous
    *  frontier read is tagged out of recall, so it surfaces once from its receive-time lane whether
    *  it landed just before or after the captured frontier. Only ambient arriving after the local
    *  switch is ack-dropped. */
  async setAttention(mode: AttentionMode): Promise<void> {
    return this.inboxState.setAttention(mode);
  }

  /** Focus recall: the channel ambient + @mentions ack-dropped since this agent entered focus,
   *  read back from the chat stream on demand and **replay-gated per channel** (a `replay=off`
   *  channel yields nothing, and is named in `droppedChannels` — recall must not become a history
   *  bypass, and it must not claim a suppressed channel's window was empty and complete either).
   *  Items are marked `historical` (catch-up framing). `droppedChannels` also names channels whose
   *  earliest retained message postdates the focus-watermark — older ambient may have aged out of
   *  the per-channel window — and wildcard subscriptions (`team.>`), which recall cannot read back
   *  per concrete sub-channel (#977: a wildcard join is not itself a channel ingest can consult a
   *  replay policy for) and so cannot vouch for either (never-silent throughout). Empty unless in
   *  focus. Calls run one at a time (#662). `underway` names recalled items that already went out in
   *  part: an exclusion that lands after that does not hide one, since recall would then move past
   *  the rest of it (#613). */
  async recallAmbient(underway: ReadonlySet<string> = new Set()): Promise<{ items: InboxItem[]; droppedChannels: string[] }> {
    return this.inboxState.recallAmbient(underway);
  }

  /** The live holders of `role` on a fresh roster read, or undefined when the read failed. */
  async roleHolders(role: string): Promise<{ id: string; name: string }[] | undefined> {
    const { roster, failure } = await this.readRoster();
    if (failure) return undefined;
    return roster.filter((p) => p.card.role === role && p.status !== "offline").map((p) => ({ id: p.card.id, name: p.card.name }));
  }

  private managerCallBearer(argv: string[], signal?: AbortSignal): Promise<string> {
    return this.managerCalls.managerCallBearer(argv, signal);
  }

  /** Run the spawner's bearer command with this session's environment on every credential path. */
  private async execBearerCmd(argv: string[], signal?: AbortSignal, timeoutMs?: number): Promise<string> {
    return this.managerCalls.execBearerCmd(argv, signal, timeoutMs);
  }

  /** Named seat reads use presence to select a manager, never the class queue. Presence confers
   *  no authority: an instance route or manager-call exchange the caller cannot obtain remains
   *  permission-denied. Other user-auth invocations keep their existing credential path. */
  async invokeEndpoint(
    endpoint: string,
    command: string,
    args?: Record<string, unknown>,
    opts: Parameters<CotalEndpoint["invokeService"]>[3] = {},
  ): Promise<EpAttributedReply> {
    let ownerInstance = opts.instanceId;
    const seatRead = endpoint === BASELINE_LIFECYCLE_ENDPOINT &&
      command === "inspect" && typeof args?.name === "string";
    let selected: Presence | undefined;
    let dropBearer: (() => void) | undefined;
    if (seatRead) {
      const roster = await this.ep.readPresence();
      const live = roster.filter(p => p.status !== "offline" &&
        (!this.config.userAuth || p.card.id.startsWith(`${this.config.userAuth.owner}.`)));
      const peer = resolvePeerInRoster(live, args!.name as string);
      if (!peer) throw new EpEnvelopeError("not-found", `no agent ${JSON.stringify(args!.name)} is held in live presence`, undefined, "not-executed");
      const instance = peer.card.meta?.["ai.cotal.manager.instance"];
      if (typeof instance !== "string")
        throw new EpEnvelopeError("failed-precondition", `agent ${JSON.stringify(peer.card.name)} reports no holding manager instance`, undefined, "not-executed");
      try { const holdingInstance = assertLifecycleToken(instance, "holding manager instance"); ownerInstance ??= holdingInstance; }
      catch { throw new EpEnvelopeError("failed-precondition", `agent ${JSON.stringify(peer.card.name)} reports an invalid holding manager instance`, undefined, "not-executed"); }
      selected = peer;
      opts = { ...opts, instanceId: ownerInstance };
      // Presence resolves the alias, but the manager's name lookup remains exact.
      args = { ...args, name: peer.card.name };
    }
    try {
      let reply: EpAttributedReply;
      if (seatRead && this.config.userAuth) {
        const bearerCmd = this.config.userAuth.bearerCmd;
        if (!bearerCmd)
          throw new EpEnvelopeError("failed-precondition", `${command}: this agent's bearer comes from its host, which issues no manager-call bearer, so manager operations are unavailable`, undefined, "not-executed");
        const bearerArgv = [...bearerCmd, "--manager-call", "--manager-instance", ownerInstance!];
        const bearer = (signal?: AbortSignal) => this.managerCallBearer(bearerArgv, signal).catch((e: unknown) => {
          if (e instanceof Error && e.message.startsWith("agent-bearer: exchange refused:"))
            throw new EpEnvelopeError("permission-denied", e.message, undefined, "not-executed");
          throw e;
        });
        dropBearer = () => { this.managerCalls.dropBearer(bearerArgv); };
        const { instanceId: _instanceId, classInstanceId: _classInstanceId, follow: _follow, ...invokeOpts } = opts;
        reply = await invokeUserManager({ ...this.config, managerInstanceId: ownerInstance }, bearer, command, args, invokeOpts);
      } else {
        reply = await this.ep.invokeService(endpoint, command, args, opts);
      }
      if (selected && reply.reply.ok) {
        const row = reply.reply.data as { id?: string; lifecycleUid?: string };
        if ((row.id !== selected.card.id && `${this.ep.principal.owner}.${row.id}` !== selected.card.id) || row.lifecycleUid !== selected.lifecycleUid)
          throw new EpEnvelopeError("expired", `agent ${JSON.stringify(selected.card.name)} changed lifecycle after owner resolution; no current row was accepted`, undefined, "not-executed");
      }
      return reply;
    } catch (error) {
      dropBearer?.();
      if (seatRead && ownerInstance !== undefined && unansweredRequest(error))
        throw new EpEnvelopeError("unavailable", `TARGET_UNAVAILABLE: manager instance ${ownerInstance} did not answer ${endpoint}.${command}`, (error as EpEnvelopeError).details, (error as EpEnvelopeError).outcome);
      throw error;
    }
  }

  /** One v0.4 manager-endpoint invoke (P2 item 1, 1c.2b): the generic {@link CotalEndpoint.invokeService}
   *  path (describe → §13.7 store fetch → digest-verified recompile → typed command), adapted back to
   *  the {@link ControlReply} shape every tool above consumes, with the instance that answered it. `undefined` args are stripped BEFORE the
   *  compiled input contract validates (closed schemas reject present-but-undefined keys; the ctl path
   *  shed them in JSON serialization). A broker-denied publish (a capability the caller's credential
   *  does not hold, e.g. a capability-less purge) has NO responder and surfaces as the deadline —
   *  named here so the refusal reads as the tier boundary it is. */
  private async managerInvoke(
    command: string,
    args: Record<string, unknown> | undefined,
    opts: { target?: EpVerbTarget; deadlineMs?: number; follow?: boolean; instanceId?: string } = {},
  ): Promise<ControlReply & { instanceId?: string; outcome?: "executed" | "not-executed" | "unknown" }> {
    return this.managerCalls.managerInvoke(command, args, opts);
  }

  // ---- the turn relay (seat side) ------------------------------------------------------------

  /** Whether a manager launched this seat. A manager accepts a run turn only against a seat it
   *  launched (`serveTurnGoal`), and every manager launch path (local spawn, restart, resume, and
   *  `delegatedSeatCommand` → `cotal spawn` handoff) sets `COTAL_MANAGER_INSTANCE`
   *  (`config.managerInstanceId`), so a directly connected session has no turn relay to arm. */
  private hasTurnRelay(): boolean {
    return this.config.managerInstanceId !== undefined && (this.config.turnRelay !== false || this.nativeTurnLeaseValid());
  }

  private nativeTurnLease?: NativeTurnParticipationLease;

  /** Take the permit to hand these turns to the harness, at the dispatch site, after every gate
   *  that can return without sending and right before the native send, with no await between. All
   *  or nothing for the once task among them: false means another caller holds it or its handoff
   *  already ended, and the caller sends no once task. Run turns need no permit and are offered
   *  again as before. */
  claimTurns(goalIds: readonly string[]): boolean {
    // A once task settled since the caller's peek is still a once task: its handoff has ended, and
    // it takes no permit.
    return claimOnceHandoff(this.onceUid(), goalIds.filter((id) => (this.activeTurns.get(id) ?? this.settledTurns.get(id))?.once !== undefined));
  }

  // ---- presence ------------------------------------------------------------

  /** The full roster, including ourselves, read from the broker now: a seat holds no presence watch
   *  (SPEC §6). Every roster surface reads through here (cotal_roster, the orientation card, the
   *  @mention guard, DM resolution and the anycast holder count), and calls made while a read is
   *  in flight share it. A failed read returns the roster of the last read that succeeded with
   *  the failure beside it: a name it holds is still a peer, but an absence is no verdict (#1229). */
  async readRoster(): Promise<RosterRead> {
    try {
      return { roster: await this.ep.readPresence() };
    } catch (e) {
      return { roster: this.ep.getRoster(), failure: e as Error };
    }
  }

  /** Our last self-reported presence status. */
  get status(): PresenceStatus {
    return this._status;
  }

  /** Run one presence write through the chain (#636): the write starts only after every earlier
   *  admitted write has settled, and a rejection is swallowed at the TAIL only, so it propagates
   *  to this write's own caller while the next admitted write still runs.
   *
   *  The straggler rule: departure is the last write, later writes are refused, not reordered.
   *  Once `stop()` has begun, any write admitted here rejects AT ONCE (no put queued, no wait on
   *  the chain) with a fixed error, instead of running after — or, for a write that calls
   *  `requireConnected` (e.g. `setStatus`), sitting out the ten-second connect grace before
   *  rejecting anyway. `stop()` itself submits departure's own put through this same method (the
   *  `forDeparture` escape) so departure keeps landing after every write already admitted, even
   *  though `_stopping` is already true by the time it does. */
  private inOrder(write: () => Promise<void>, forDeparture = false): Promise<void> {
    if (this._stopping && !forDeparture) return Promise.reject(new Error("agent is stopping; presence writes are refused"));
    const next = this.presenceChain.then(write, write);
    this.presenceChain = next.catch(() => {});
    return next;
  }

  /** Detach the chain from writes the CALLER has abandoned, so the next write is ordered behind
   *  what has actually settled rather than behind work nobody is waiting for any more.
   *
   *  The chain above orders departure after every admitted write, which is right while those writes
   *  are still progressing and wrong once a teardown has given up on them. A host bounds its wait on
   *  admitted intake and then attempts departure; without this, that attempt queues behind the very
   *  write the bound just abandoned, so the bound buys nothing, offline never publishes, and the seat
   *  stays at its last status until its presence TTL expires. The host says in its own log that
   *  abandoned work is uncancelled and may land after departure, and the chain quietly contradicted
   *  it.
   *
   *  ABANDONED IS NOT CANCELLED here either. The detached writes keep running and may still publish,
   *  which is the same residual the caller already announces; what changes is only that departure
   *  stops waiting on them. Call it exactly where the give-up is decided, never as a general reset:
   *  a caller that invokes this while its writes are still progressing has reintroduced the race the
   *  chain exists to close. */
  abandonPresenceWrites(): void {
    this.presenceChain = Promise.resolve();
  }

  async setStatus(status: PresenceStatus, activity?: string): Promise<void> {
    await this.inOrder(async () => {
    await this.requireConnected();
    const prev = this.turnStatus;
    try {
      if (prev !== "working" && status === "working") await this.ep.setCondition(null);
      await this.publishStatus(status, activity);
    } finally {
      // The transition is a fact about the SEAT, not about whether its presence row was written:
      // assigning before the writes meant one failed publish (which every adapter swallows) left
      // `_status` idle with no boundary run, and the next real turn end saw no transition at all.
      this._status = status;
      this.turnStatus = status;
      // The turn relay's boundary: an adapter funnels its turn-end through this transition (Stop
      // hooks set idle), so the automatic `done` yield and the immediate re-poll live here once
      // instead of per connector. `waiting` is not a boundary — a seat blocked on a permission has
      // not finished, and its deadline is what bounds a stuck one.
      if (prev === "working" && status === "idle") this.onTurnBoundary();
    }
    });
  }

  /**
   * Publish presence for something that is NOT a turn ending.
   *
   * The boundary above reads working→idle as "the seat finished its turn", and that reading holds
   * only at a real turn terminal. A session (re)start writes idle too: Claude Code fires
   * `SessionStart` on compact, clear and resume, and an auto-compaction lands in the MIDDLE of a
   * long turn. Routed through `setStatus` it yielded `done` for work the model had not finished,
   * and the run moved on. An adapter uses this for every idle that is a lifecycle event rather
   * than an ending.
   */
  async resetStatus(status: PresenceStatus, activity?: string): Promise<void> {
    await this.inOrder(async () => {
    await this.requireConnected();
    try {
      await this.publishStatus(status, activity);
    } finally {
      this._status = status;
    }
    });
  }

  private async publishStatus(status: PresenceStatus, activity?: string): Promise<void> {
    await this.ep.setStatus(status, activity);
  }

  /** Change only the activity line. Routing it through `setStatus` with the current status read the
   *  status before queued writes settled, then wrote that stale value back over them. */
  async setActivity(activity: string): Promise<void> {
    await this.inOrder(async () => {
      await this.requireConnected();
      await this.ep.setActivity(activity);
    });
  }

  /** Relay a harness-reported condition into presence, or clear it. */
  async setCondition(condition: PresenceCondition | null): Promise<void> {
    await this.inOrder(() => this.ep.setCondition(condition));
  }

  /** Relay harness-reported work progress (a turn event) as presence `activeAt`. The next heartbeat
   *  carries it, so an observer can tell a turn that stopped advancing from one that is progressing. */
  noteActivity(at?: number): void {
    this.ep.noteActivity(at);
  }

  /** The working→idle boundary: yield `done` for every SURFACED turn (its payload was in the
   *  context of the turn that just ended; ending without an explicit yield IS the done signal).
   *  The manager's notice for each settled yield brings the next queued turn. Fire-and-forget
   *  from the presence path — a yield must never block a status write. */
  private onTurnBoundary(): void {
    for (const t of [...this.activeTurns.values()]) {
      if (!t.surfaced) continue;
      void this.yieldTurn("done", { turn: t.goalId })
        .then((r) => { if (!r.ok) this.log(`turn ${t.goalId} auto-yield: ${r.error ?? "refused"}`); })
        .catch((e) => this.log(`turn ${t.goalId} auto-yield: ${(e as Error).message}`));
    }
  }

  /** Record the host's actual model and optional variant learned after launch, so peers see the
   *  selection in `cotal_roster` and the web roster even when the operator never pinned one. Explicit
   *  `model:` / `variant:` config wins; this only fills the gap. `provider` is best-effort and
   *  reported independently of the model pin: a pinned seat can still report which provider is
   *  serving it, so the early return only short-circuits when no provider was given either. Best-
   *  effort presence mirror (no `requireConnected` — safe pre-connect; it rides the first publish). */
  async setModel(model: string, variant?: string, provider?: string): Promise<void> {
    if (this.config.model && provider === undefined) return; // operator pin is authoritative for the model
    await this.inOrder(() => this.ep.setCardModel(this.config.model ?? model, this.config.variant ?? variant, provider));
  }

  /** Report the session's working directory as its harness supplied it. Advisory display data. */
  async setCwd(cwd: string): Promise<void> {
    await this.inOrder(() => this.ep.setCardCwd(cwd));
  }

  /** Channels we're currently subscribed to (live — reflects join/leave). */
  joinedChannels(): string[] {
    return this.ep.joinedChannels();
  }

  // ---- internals -----------------------------------------------------------

  /** The connectedness gate every mesh op goes through. Waits out the initial connect window
   *  rather than failing into it (see CONNECT_GRACE_MS), so the common startup race resolves as
   *  a slightly slow first call instead of a false "mesh is down". */
  private async requireConnected(): Promise<void> {
    return this.whenConnected(CONNECT_GRACE_MS);
  }

  /** Public bounded wait for the mesh link, for callers OUTSIDE the op methods that need to gate
   *  their own startup on it. The AG-UI emitter is the proven case: it lazy-starts from the first
   *  lifecycle hook, `--prompt` fires that hook within a second of launch, and its start reached
   *  the endpoint before the first bind — "endpoint not started", terminal by the holder's design,
   *  so one race at spawn silenced the event plane for the whole session. */
  async whenConnected(timeoutMs: number = CONNECT_GRACE_MS): Promise<void> {
    if (this._connected) return;
    // An endpoint waiting out its rebuild backoff would not try again inside this window (#7408).
    this.ep.retryNow();
    if (!(await this.awaitConnection(timeoutMs))) throw new Error(this.notConnectedMessage());
  }

  /** Resolves true on the endpoint's real post-bind connection signal, false if the window closes
   *  first. Listens on the ENDPOINT because its (re)binds are the single source of truth (see the
   *  constructor), and re-checks after binding the listener so a connection that lands between the
   *  guard above and the subscription cannot be missed. */
  private awaitConnection(timeoutMs: number): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      let settled = false;
      const finish = (ok: boolean): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.ep.off("connection", onConnection);
        resolve(ok);
      };
      const onConnection = (e: { connected: boolean }): void => {
        if (e.connected) finish(true);
      };
      const timer = setTimeout(() => finish(false), Math.max(1, timeoutMs));
      this.ep.on("connection", onConnection);
      if (this._connected) finish(true); // closes the check→listen race
    });
  }

  /** `cotal up` starts a broker on THIS machine, so it is only advice when the configured one is
   *  local. Someone whose agent joins a hosted mesh cannot fix it by starting their own, and being
   *  told to try sends them to repair the wrong thing entirely. */
  private notConnectedMessage(): string {
    const issue = this.connectionIssue;
    if (issue) return `not connected to the mesh at ${this.config.servers}: ${issue}`;
    const remedy = isLocalServer(this.config.servers)
      ? "is it running? (`cotal up`)"
      : "it did not become reachable — check that the mesh is up and that this machine can reach it.";
    return `not connected to the mesh at ${this.config.servers} — ${remedy}`;
  }

  /** Keep an ordered-consumer reset storm from painting hundreds of status lines through an
   * attached Codex TUI. Consumer names are generated per reset, so normalize them before
   * deduplicating; otherwise every `_71`, `_72`, ... would look like a new fault. */
  private handleEndpointError(error: Error): void {
    // connectionIssue is the bounded readiness diagnostic documented above: retain failures only
    // while the endpoint has not bound. Post-bind consumer/permission faults are still logged, but
    // presenting one as the current connection failure after readiness succeeded is stale and false.
    if (!this._connected && !this._stopping) this.lastConnectionError = error.message;
    this.logEndpointNotice("error", error);
  }

  private handleEndpointWarning(error: Error): void {
    // The rebind loop reports a failed attempt as a warning. A missing DM durable fails every attempt
    // until the session is replaced, so it is the current connection failure, not a passing one.
    if (error instanceof DmDurableMissingError && !this._connected && !this._stopping) this.lastConnectionError = missingInboxIssue(error);
    this.logEndpointNotice("warning", error);
  }

  private logEndpointNotice(kind: "error" | "warning", error: Error): void {
    const now = Date.now();
    const fingerprint = error.message.replace(/oc_[A-Za-z0-9]+_\d+/g, "oc_*");
    const prior = this.endpointNoticeLog.get(fingerprint);
    if (prior && now - prior.lastLoggedAt < ENDPOINT_ERROR_LOG_WINDOW_MS) {
      prior.suppressed++;
      return;
    }
    const suffix = prior?.suppressed ? ` (${prior.suppressed} repeats suppressed)` : "";
    this.endpointNoticeLog.set(fingerprint, { lastLoggedAt: now, suppressed: 0 });
    if (this.endpointNoticeLog.size > MAX_ENDPOINT_NOTICES) this.endpointNoticeLog.delete(this.endpointNoticeLog.keys().next().value!);
    this.log(`endpoint ${kind}: ${error.message}${suffix}`);
  }

  private log(msg: string): void {
    process.stderr.write(`[cotal-connector] ${msg}\n`);
  }

  /** The manager-facing commands: spawn, despawn, run, personas, history purge. Every dependency reads through at its use. */
  private readonly supervision = new AgentSupervision({
    config: () => this.config,
    ep: () => this.ep,
    managerCalls: () => this.managerCalls,
    managerInvoke: (...args) => this.managerInvoke(...args),
    requireConnected: (...args) => this.requireConnected(...args),
    send: (...args) => this.send(...args),
  });

  async spawn(name: string, role?: string, opts?: { agent?: string; model?: string; variant?: string; launchOptions?: Record<string, unknown>; cwd?: string; prompt?: string; events?: boolean; runtime?: string; instance?: string; join?: string[]; persona?: InlinePersona; once?: { deadlineMs?: number } }): Promise<ControlReply & { instanceId?: string }> { return this.supervision.spawn(name, role, opts); }
  async inspectModel(name: string, instance?: string): Promise<{ ok: true; model?: string } | { ok: false; error: string; unreported?: true }> { return this.supervision.inspectModel(name, instance); }
  async listManagerEndpoints(input: RegistryEndpointsInput, instance?: string): Promise<
    | { none: string }
    | { unbound: true }
    | { unbound?: false; reply: EpAttributedReply; page?: RegistryEndpointsOutput }
  > { return this.supervision.listManagerEndpoints(input, instance); }
  async despawn(name?: string, opts?: { graceful?: boolean; instance?: string }): Promise<ControlReply> { return this.supervision.despawn(name, opts); }
  async run(verb: "start" | "resume" | "answer" | "status" | "ps", args: Record<string, unknown>, instance?: string): Promise<ControlReply> { return this.supervision.run(verb, args, instance); }
  async definePersona(def: {
    name: string;
    prompt: string;
    instance?: string;
    model?: string;
    role?: string;
    agent?: string;
    subscribe?: string[];
    allowSubscribe?: string[];
    allowPublish?: string[];
    capabilities?: string[];
    endpoints?: PersonaEndpoint[];
    announce?: string;
  }): Promise<ControlReply & { definitionOutcome?: "unknown"; announceError?: string; announceOutcome?: "denied" | "unknown" }> { return this.supervision.definePersona(def); }
  async listPersonas(instance?: string): Promise<ControlReply> { return this.supervision.listPersonas(instance); }
  async showPersona(name: string, instance?: string): Promise<ControlReply> { return this.supervision.showPersona(name, instance); }
  async purgeHistory(opts?: { includeDms?: boolean }): Promise<ControlReply> { return this.supervision.purgeHistory(opts); }

  /** Channel discovery and membership: briefing, info, listing, join, leave. Every dependency reads through at its use. */
  private readonly channels = new AgentChannels({
    channelMode: (...args) => this.channelMode(...args),
    config: () => this.config,
    ep: () => this.ep,
    inboxState: () => this.inboxState,
    joinedChannels: (...args) => this.joinedChannels(...args),
    requireConnected: (...args) => this.requireConnected(...args),
  });

  channelBriefing(): string | undefined { return this.channels.channelBriefing(); }
  async readChannels(): Promise<void> { return this.channels.readChannels(); }
  channelInfo(channel: string): { description?: string; instructions?: string; replay: boolean; registered: boolean; event?: "own" | "agent" } { return this.channels.channelInfo(channel); }
  async listChannels(): Promise<
    {
      channel: string;
      description?: string;
      replay: boolean;
      joined: boolean;
      durableUnclosed: boolean;
      deliveryHealth?: "active" | "degraded" | "unknown";
      messages: number;
      mode: ChannelMode | "normal";
      event?: "own" | "agent";
      follow?: "family" | "live";
    }[]
  > { return this.channels.listChannels(); }
  async joinChannel(channel: string): Promise<{ joined: boolean; backfilled: number; durable: boolean; reason?: string }> { return this.channels.joinChannel(channel); }
  async leaveChannel(channel: string): Promise<{ left: boolean }> { return this.channels.leaveChannel(channel); }

  /** Sending: channel sends, anycasts, DMs and the reply correlation they carry. Every dependency reads through at its use. */
  private readonly messaging = new AgentMessaging({
    config: () => this.config,
    ep: () => this.ep,
    id: () => this.id,
    readRoster: (...args) => this.readRoster(...args),
    requireConnected: (...args) => this.requireConnected(...args),
    roleHolders: (...args) => this.roleHolders(...args),
    unanswered: () => this.unanswered,
  });

  setContextId(contextId: string | undefined): void { return this.messaging.setContextId(contextId); }
  withCorrelation<T>(correlation: Correlation, fn: () => T): T { return this.messaging.withCorrelation(correlation, fn); }
  answersQuestion(item: InboxItem): boolean { return this.messaging.answersQuestion(item); }
  private noteDirected(item: InboxItem): void { return this.messaging.noteDirected(item); }
  async send(text: string, channel?: string, mentions?: string[]): Promise<CotalMessage> { return this.messaging.send(text, channel, mentions); }
  async describeSendChannel(channel: string): Promise<{ known: boolean; hints: string[]; unchecked?: string }> { return this.messaging.describeSendChannel(channel); }
  async anycast(role: string, text: string): Promise<{
    msg: CotalMessage;
    ack: { seq: number; duplicate: boolean };
    /** Live roster rows holding `role`, ourselves included; absent when the roster read failed,
     *  since only a read that succeeded can say that no holder exists (#1229). */
    holdersAtSend?: { id: string; name: string }[];
  }> { return this.messaging.anycast(role, text); }
  async anycastStatus(seq: number): Promise<AnycastStatus> { return this.messaging.anycastStatus(seq); }
  async cancelAnycast(seq: number): Promise<AnycastStatus> { return this.messaging.cancelAnycast(seq); }
  resolvePeer(target: string): Presence | undefined { return this.messaging.resolvePeer(target); }
  async dm(target: string, text: string, opts: { replyTo?: string } = {}): Promise<{
    msg: CotalMessage;
    /** The roster row the target resolved to; absent when it resolved to an unrostered sender. */
    peer?: Presence;
    recipient: { id: string; name: string };
    ack: { seq: number; duplicate: boolean };
    /** `unrostered`: the recipient is a peer that messaged us and has no roster row (#384). */
    recipientStatusAtSend: Presence["status"] | "unrostered";
  }> { return this.messaging.dm(target, text, opts); }

  /** Run turns: the native lease, the turn relay and pull, surfacing, once claims and yields. Every dependency reads through at its use. */
  private readonly turns = new AgentTurns({
    _connected: () => this._connected,
    _stopping: () => this._stopping,
    activeTurns: () => this.activeTurns,
    claimTurns: (...args) => this.claimTurns(...args),
    config: () => this.config,
    ep: () => this.ep,
    hasTurnRelay: (...args) => this.hasTurnRelay(...args),
    legacyTurnPoll: () => this.legacyTurnPoll,
    setLegacyTurnPoll: (value) => { this.legacyTurnPoll = value; },
    log: (...args) => this.log(...args),
    managerInvoke: (...args) => this.managerInvoke(...args),
    nativeTurnLease: () => this.nativeTurnLease,
    setNativeTurnLease: (value) => { this.nativeTurnLease = value; },
    options: () => this.options,
    requestWake: (...args) => this.requestWake(...args),
    requireConnected: (...args) => this.requireConnected(...args),
    settledTurns: () => this.settledTurns,
    turnNoticeArmed: () => this.turnNoticeArmed,
    setTurnNoticeArmed: (value) => { this.turnNoticeArmed = value; },
    turnPollBusy: () => this.turnPollBusy,
    setTurnPollBusy: (value) => { this.turnPollBusy = value; },
    turnRetryTimer: () => this.turnRetryTimer,
    setTurnRetryTimer: (value) => { this.turnRetryTimer = value; },
  });

  authorizeNativeTurnParticipation(lease: NativeTurnParticipationLease): void { return this.turns.authorizeNativeTurnParticipation(lease); }
  async participateInTurns(): Promise<NativeTurnParticipationLease> { return this.turns.participateInTurns(); }
  nativeTurnParticipationExpiresAt(): number | undefined { return this.turns.nativeTurnParticipationExpiresAt(); }
  activeTurnCount(): number { return this.turns.activeTurnCount(); }
  private nativeTurnLeaseValid(): boolean { return this.turns.nativeTurnLeaseValid(); }
  private armTurnRelay(): void { return this.turns.armTurnRelay(); }
  private requestTurnPull(): void { return this.turns.requestTurnPull(); }
  private async pollTurns(): Promise<void> { return this.turns.pollTurns(); }
  peekPendingTurns(): { text: string; goalIds: string[]; once?: true } | undefined { return this.turns.peekPendingTurns(); }
  commitSurfacedTurns(goalIds: readonly string[]): void { return this.turns.commitSurfacedTurns(goalIds); }
  unsurfaceTurns(goalIds: readonly string[]): void { return this.turns.unsurfaceTurns(goalIds); }
  releaseTurns(goalIds: readonly string[]): void { return this.turns.releaseTurns(goalIds); }
  noteTurnsDispatched(goalIds: readonly string[]): void { return this.turns.noteTurnsDispatched(goalIds); }
  private offerable(t: ActiveTurn): boolean { return this.turns.offerable(t); }
  private onceUid(): string { return this.turns.onceUid(); }
  async yieldTurn(status: "done" | "blocked" | "handoff", opts: { to?: string; note?: string; turn?: string } = {}): Promise<ControlReply> { return this.turns.yieldTurn(status, opts); }
}

/** One {@link MeshAgent.readRoster}: the roster, and why it is last-known when the read failed. */
export interface RosterRead {
  roster: Presence[];
  failure?: Error;
}

/** Why an authenticated session whose DM durable is gone cannot reconnect, and what restores it. The
 *  route comes first because the orientation card shows only the first 300 characters. */
function missingInboxIssue(e: DmDurableMissingError): string {
  return "this session's direct-message inbox is missing on the broker, and on an authenticated mesh only a new launch " +
    "creates one, so reconnecting cannot restore it. Restart this session, or respawn it if a manager launched it. " +
    `Missing durable "${e.durable}" on stream "${e.stream}". Retries continue in case a broker restore brings it back.`;
}
