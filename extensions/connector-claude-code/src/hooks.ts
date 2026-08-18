/**
 * The Claude Code connector's wake path, split out of the MCP entry point so it can be
 * exercised without a real `claude`:
 *
 *  • {@link createClaudeHandle} — the lifecycle-hook handler: Claude Code events → presence,
 *    context injection, and the turn-end flush.
 *  • {@link createWakePolicy} — the push side: `claude/channel` nudges for arriving peer
 *    messages plus the Stop→idle wake.
 *
 * Both are plain factories over a {@link MeshAgent}; `mcp.ts` is the composition root that
 * binds them to the real MCP server. The behaviour lives here so `smoke/wake-path.smoke.ts`
 * drives the SHIPPED code rather than a copy of it.
 */
import type { PresenceStatus } from "@cotal-ai/core";
import {
  formatInjection,
  fmtFrom,
  channelMeta,
  type MeshAgent,
  type InboxItem,
  type HookEvent,
  type HookHandle,
} from "@cotal-ai/connector-core";
import type { AguiEmitterHolder } from "@cotal-ai/connector-core";
import type { ClaudeEntry } from "./agui-map.js";

/** A short, human-readable preview of a tool call: its most salient input, else compact JSON. */
function toolDetail(name: unknown, input: unknown): { name: string; detail: string } | undefined {
  if (typeof name !== "string" || !name) return undefined;
  const i = (input ?? {}) as Record<string, unknown>;
  const salient = i.command ?? i.file_path ?? i.path ?? i.url ?? i.pattern ?? i.description;
  let detail = typeof salient === "string" ? salient : Object.keys(i).length ? JSON.stringify(i) : "";
  if (detail.length > 300) detail = `${detail.slice(0, 299)}…`;
  return { name, detail };
}

export interface ClaudeHandleDeps {
  /** The session's AG-UI emitter, read lazily — `mcp.ts` assigns it after the handler exists. */
  events?: () => AguiEmitterHolder<ClaudeEntry> | undefined;
}

/** Prefixed to a batch containing anything whose previous delivery went unconfirmed. */
const REPEAT_NOTE = "(A previous delivery of one or more of these was not confirmed, so they may be a repeat.)";
/** Bound on the advisory repeat labels. Only grows on undelivered replies, so it is normally empty. */
const REPEAT_LABEL_CAP = 512;

/** The hook side of the connector: the handler plus the delivery callback that commits what it
 *  injected. Both must be wired into {@link startControlServer} — the handler surfaces, the
 *  callback is the only place a peer message is ever acked. */
export interface ClaudeHooks {
  handle: HookHandle;
  /** Pass as {@link ControlServerOpts.onReply}. */
  onReply: (ev: HookEvent, delivered: boolean) => void;
}

/**
 * Claude Code lifecycle events → presence + (on inject-capable events) queued peer messages.
 *
 * Two properties keep an unattended peer answering:
 *
 * **Presence never gates delivery.** `setStatus`/`setAttention` are broker round-trips that throw
 * while the endpoint is mid-reconnect ({@link MeshAgent.setStatus} calls `assertConnected`). They
 * used to sit inside the same try/catch as the delivery work that followed them, so a single failed
 * presence write skipped the injection on `UserPromptSubmit` and — worse — the `Stop` wake flush,
 * leaving held messages with nothing left to deliver them. Presence is observability; the wake path
 * is the product, so presence failures are swallowed here and nothing is sequenced behind them.
 *
 * **Peer messages are surfaced, then committed on handoff.** The injection is built with
 * {@link MeshAgent.peekInbox} and the ids are remembered, not acked. A hook reply still has to reach
 * the runtime through the relay (which abandons the exchange after 2s) and the ids are committed
 * only once {@link ClaudeHooks.onReply} says it did. Acking at format time was silent loss: the
 * message was already in `handledIds`, so its durable redelivery was acked and discarded on arrival
 * and no retry could ever surface it — the peer just never replied.
 *
 * **This is a deliberate choice of at-least-once over at-most-once.** The delivery verdict is not
 * perfectly two-sided, so pick which way it errs:
 *   • reply landed, confirmation lost  ⇒ the batch is surfaced again and the model reads it twice;
 *   • reply lost, treated as delivered ⇒ the message is buried and the peer never answers.
 * The first costs a duplicate injection (labelled — see {@link REPEAT_NOTE}); the second costs the
 * workflow. Do not "fix" the duplicate by committing optimistically: that is the burial this whole
 * file exists to prevent.
 *
 * Deferring the ack to turn completion (the OpenCode connector's `ackSurfaced` on `session.idle`)
 * does NOT substitute for this. `Stop` fires whether or not the reply survived, so it would commit a
 * batch the model never saw — the same loss, later. OpenCode can bind its ack to the turn because
 * `drive()` OWNS delivery; this connector only hands a reply off, so the ack binds to the handoff.
 */
export function createClaudeHandle(deps: ClaudeHandleDeps = {}): ClaudeHooks {
  const events = (): AguiEmitterHolder<ClaudeEntry> | undefined => deps.events?.();
  /**
   * Last tool Claude tried to use, captured on PreToolUse. When a permission Notification
   * fires moments later, this is *what* it's blocked on — so the dashboard shows the actual
   * command/action awaiting approval, not just "Claude needs your permission".
   */
  let pendingTool: { name: string; detail: string } | undefined;
  /** Batches awaiting a delivery verdict, keyed by the EVENT OBJECT the control server passes to
   *  both `handle` and `onReply`. Frames are separate socket connections and can overlap (a
   *  `PreToolUse` from a parallel tool batch while a `UserPromptSubmit` reply is still being
   *  written), so a single mutable slot would let one frame's verdict commit another frame's ids —
   *  the same mis-ack this file exists to prevent, just with a new cause. The event identity is the
   *  only thing that correlates a verdict to the reply that carried the batch. A WeakMap so an
   *  event whose verdict never arrives is collected rather than leaked. */
  const inFlight = new WeakMap<HookEvent, { ids: string[]; agent: MeshAgent }>();
  /** Ids whose delivery could not be confirmed, so they are being surfaced again. Advisory only —
   *  it labels a possible repeat for the model. Bounded; on overflow the label is dropped (never
   *  the message), because the label is a courtesy and the message is the product. */
  const unconfirmed = new Set<string>();

  /** Flag ids whose delivery this process could not confirm, so a re-surface is labelled a possible
   *  repeat. Past the cap the labels go, never the messages: an unlabelled repeat is cosmetic, a
   *  dropped message is not. */
  const markUnconfirmed = (ids: readonly string[]): void => {
    if (unconfirmed.size + ids.length <= REPEAT_LABEL_CAP) for (const id of ids) unconfirmed.add(id);
    else unconfirmed.clear();
  };

  /** Presence is advisory — never let a failed publish skip the delivery work around it. */
  const safeStatus = async (agent: MeshAgent, status: PresenceStatus, activity?: string): Promise<void> => {
    try {
      await agent.setStatus(status, activity);
    } catch {
      /* best-effort */
    }
  };

  /** Format the automatic batch WITHOUT acking it; the ids ride on THIS frame's delivery verdict. */
  const surfaceAutomatic = (agent: MeshAgent, ev: HookEvent): string | undefined => {
    const items = agent.peekInbox("automatic");
    if (!items.length) return undefined;
    const body = formatInjection(items);
    if (!body) return undefined;
    const ids = items.map((i) => i.id);
    // These stay in the inbox until the verdict, so the overflow valve could otherwise ack one out
    // from under us mid-delivery — unrecoverable, since an acked id is never redelivered. If the
    // agent cannot protect the whole batch (too many frames already open), DO NOT SURFACE IT: an
    // unprotected in-flight batch is the very loss this guards against. The messages stay buffered
    // and go out on a later frame once a verdict frees capacity.
    if (!agent.holdInFlight(ids)) return undefined;
    inFlight.set(ev, { ids, agent });
    // At-least-once, deliberately: an unconfirmed batch is re-surfaced rather than dropped, so a
    // reply that DID land but whose confirmation was lost shows the model the same message twice.
    // Say so, so a repeat reads as a repeat instead of as a peer sending twice.
    return ids.some((id) => unconfirmed.has(id)) ? `${REPEAT_NOTE}\n${body}` : body;
  };

  const handle: HookHandle = async (agent: MeshAgent, ev: HookEvent): Promise<Record<string, unknown>> => {
    const event = ev.hook_event_name ?? "";
    const withContext = (text: string | undefined): Record<string, unknown> =>
      text ? { hookSpecificOutput: { hookEventName: event, additionalContext: text } } : {};
    try {
      switch (event) {
        case "SessionStart": {
          events()?.adopt(ev.transcript_path); // read from HERE — a resumed session never republishes history
          // Claude Code reports the session's actual model here (the ONLY hook that carries it; absent
          // after /clear or conversation recovery, so guard on string). Surface it in presence when the
          // operator didn't pin one. A mid-session /model switch fires no hook, so this holds until the
          // next (re)start — acceptable for a display-only discovery field. setModel keeps the pin wins.
          if (typeof ev.model === "string") await agent.setModel(ev.model).catch(() => {});
          await safeStatus(agent, "idle");
          // Reset to fail-open on every (re)start — a crashed/restarted agent must not stay silently
          // deaf. Advisory: the local default is already "open", so a failed write changes nothing.
          try {
            await agent.setAttention("open");
          } catch {
            /* best-effort */
          }
          // Boot push: a one-line note per subscribed channel (if the registry has loaded),
          // plus any messages waiting. Both are advisory context.
          const parts = [agent.channelBriefing(), surfaceAutomatic(agent, ev)].filter(Boolean);
          return withContext(parts.length ? parts.join("\n\n") : undefined);
        }
        case "UserPromptSubmit":
          pendingTool = undefined; // new turn — the previous block (if any) is resolved
          events()?.flush(ev.transcript_path);
          await safeStatus(agent, "working");
          return withContext(surfaceAutomatic(agent, ev));
        case "PreToolUse":
          // Remember what Claude is about to do; if it needs permission, the Notification
          // below turns this into the "blocked on" detail. Auto-approved tools just overwrite it.
          pendingTool = toolDetail(ev.tool_name, ev.tool_input);
          events()?.flush(ev.transcript_path); // near-live: each tool boundary ships the turn so far
          return {};
        case "Notification": {
          // Claude Code's Notification carries the human-readable reason the session is
          // blocked in `message`. When a tool permission is pending, lead with *what* it's
          // waiting on (the actual command) so a one-line card preview stays informative — the
          // `waiting` status + the dashboard's "BLOCKED ON" label already convey the *why*.
          // Otherwise (idle-input / elicitation, no tool) the message itself is the content.
          const msg = typeof ev.message === "string" ? ev.message : undefined;
          const activity = pendingTool
            ? `${pendingTool.name}${pendingTool.detail ? `: ${pendingTool.detail}` : ""}`
            : msg;
          await safeStatus(agent, "waiting", activity);
          return {};
        }
        case "Stop":
        case "StopFailure": // turn died on an API error — Stop won't fire, so reset here too
          pendingTool = undefined; // turn ended — don't let a stale tool attach to an idle-wait notification
          events()?.flush(ev.transcript_path);
          // THE TURN TERMINAL, and it has to be a second call rather than part of the flush. The
          // records this hook fires after do not say the turn ended: the harness knows, and the
          // file does not. So the run is closed from HERE, after the flush has consumed every
          // record the turn produced, or the closing frame would land while a message or a tool
          // call was still open and the emitter would refuse it. It republishes the source cursor
          // unchanged, because advancing it would mark records consumed that were never mapped.
          events()?.closeRun(Date.now());
          await safeStatus(agent, "idle");
          // Now idle: if ambient channel chatter was held while we were busy, ask the channel to
          // wake one turn so its UserPromptSubmit surfaces the batch. (Ack sites are two: the
          // delivery verdict in onReply, and the focus ingest ack-drop for ambient/mentions a focus
          // agent declined.) Stop can't inject context itself, so we must NOT surface here — that
          // would open a batch with no vehicle to the model.
          // Mode-and-channel-aware (pendingWake): open flushes held normal ambient too; dnd/focus and
          // per-channel `quiet` wake only for held DIRECTED items (quiet ambient remains pull-only).
          // This runs after a presence write that can fail; it must NOT be sequenced behind one.
          if (agent.pendingWake() > 0) agent.requestWake();
          return {};
        case "SessionEnd":
          events()?.flush(ev.transcript_path); // best-effort — the process may exit before it lands
          await safeStatus(agent, "offline");
          return {};
        default:
          return {};
      }
    } catch {
      return {}; // never block the session
    }
  };

  /**
   * The reply carrying an injected batch either reached the runtime or it did not. Delivered ⇒
   * commit exactly those ids (the sole ack site for automatic peer messages). Not delivered ⇒
   * abandon them un-acked, so JetStream redelivers, `incoming` fires again, and the peer is nudged
   * again — a dropped reply costs a round trip, never the message.
   */
  const onReply = (ev: HookEvent, delivered: boolean): void => {
    const batch = inFlight.get(ev);
    if (!batch) return; // this frame carried no peer messages (PreToolUse, Notification, Stop, …)
    inFlight.delete(ev);
    const { ids, agent } = batch;
    agent.releaseInFlight(ids); // verdict is in, either way — ordinary backlog again
    if (!delivered) {
      markUnconfirmed(ids);
      return;
    }
    for (const id of ids) unconfirmed.delete(id);
    try {
      agent.drainInboxIds(ids);
    } catch {
      // The ack itself failed — a JetStream ack publishes, so a closed connection throws. Whatever
      // did not ack is also not marked handled, so JetStream redelivers it and nothing is lost. But
      // it WAS shown, so re-flag the batch: the repeat arrives labelled instead of looking fresh.
      // Imprecise on purpose — a mid-batch throw may have acked a prefix we cannot identify from
      // here, so ids already committed linger as stale labels until the cap clears them.
      markUnconfirmed(ids);
    }
  };

  return { handle, onReply };
}

/** One `claude/channel` push. A rejection is surfaced to the caller. */
export type ChannelNotify = (params: { content: string; meta: Record<string, string> | { kind: string } }) => Promise<void>;

export interface WakePolicy {
  /** Flip once the MCP handshake confirms the client speaks `claude/channel`. */
  setChannelActive(active: boolean): void;
  /** Teardown: stop the retry timer. */
  stop(): void;
}

const NUDGE_RETRY_INITIAL_MS = 1_000;
const NUDGE_RETRY_MAX_MS = 30_000;

/**
 * The push side of the wake path: turn mesh events into `claude/channel` notifications.
 *
 * A nudge only ever *wakes* a turn — the body is surfaced by the hook handler above (or by an
 * explicit `cotal_inbox` pull). It stays gated on a *mutable* `channelActive` flag (flipped true
 * only after the MCP handshake confirms the client speaks claude/channel). If it fires before
 * then it simply no-ops; a *buffered* message waits in the inbox and is surfaced at the next
 * UserPromptSubmit, so nothing is lost. One exception: a focus @mention's body was already
 * ack-dropped at ingest (not buffered), so a missed mention-wake is recoverable only by an
 * explicit cotal_inbox pull (recall) — there is no buffered copy to surface.
 *
 * **A rejected push is retried.** The notification can fail (a closed or wedged stdio pipe), and it
 * is the ONLY thing that wakes an idle session: no later hook fires on its own, so a dropped nudge
 * used to mean silence until a human typed. A bounded backoff re-nudges while anything is still
 * pending, mirroring the OpenCode connector's `scheduleErrorRetry`. It is driven off
 * {@link MeshAgent.pendingWake}, so it stops as soon as the batch is delivered and committed, and
 * it never wakes for held ambient the agent's attention mode says to hold.
 */
export function createWakePolicy(agent: MeshAgent, notify: ChannelNotify, log: (msg: string) => void = () => {}): WakePolicy {
  let channelActive = false;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  let retryMs = NUDGE_RETRY_INITIAL_MS;
  /** The one wake with no second chance: a focus-mode @mention, already acked and dropped at ingest,
   *  so it is in no inbox and no stream. Held until THIS mention's own notice succeeds — an
   *  unrelated push landing means the session woke for something else, and that notice carries no
   *  pull hint, so it reschedules this rather than discharging it. */
  let pendingMentionWake: { item: InboxItem; hint: string } | undefined;

  const clearRetry = (resetDelay: boolean): void => {
    if (retryTimer) clearTimeout(retryTimer);
    retryTimer = undefined;
    if (resetDelay) retryMs = NUDGE_RETRY_INITIAL_MS;
  };

  const scheduleRetry = (): void => {
    if (retryTimer || !channelActive) return;
    // A focus-mode @mention is ack-dropped at ingest, not buffered, so `pendingWake()` is 0 for it and
    // JetStream will never redeliver it either: the push we just failed to make WAS its only notice.
    // Gating the retry on the inbox alone therefore drops precisely the wake with no other recovery.
    if (agent.pendingWake() === 0 && !pendingMentionWake) return;
    const delay = retryMs;
    retryMs = Math.min(retryMs * 2, NUDGE_RETRY_MAX_MS);
    retryTimer = setTimeout(() => {
      retryTimer = undefined;
      // The mention goes FIRST when both are outstanding. A buffered message still has JetStream
      // behind it — un-acked, it redelivers and re-announces itself — whereas the ack-dropped mention
      // has nothing but this timer. Checking the inbox first meant any buffered DM starved the
      // mention retry indefinitely, since the batch nudge kept succeeding and rescheduling itself.
      if (pendingMentionWake) nudge(pendingMentionWake.item, pendingMentionWake.hint, true);
      else if (agent.pendingWake() > 0) nudge();
    }, delay);
    retryTimer.unref?.(); // a pending retry must never hold the process open
  };

  const nudge = (item?: InboxItem, pullHint?: string, isMentionWake = false): void => {
    if (!channelActive) return;
    const n = agent.inboxCount("automatic");
    const content = pullHint
      ? `📨 ${pullHint}`
      : item
      ? `📨 New ${item.kind}${item.mentionsMe ? " — you were mentioned" : ""} from ${fmtFrom(item)} — delivering your Cotal inbox now.`
      : `📨 ${n} Cotal message${n === 1 ? "" : "s"} waiting — delivering your inbox now.`;
    void notify({ content, meta: item ? channelMeta(item) : { kind: "batch" } }).then(
      () => {
        // ONLY the mention's own notice discharges it. Waking for a DM tells the session about the
        // DM: that notice carries no pull hint, and the ack-dropped mention is in no inbox to be
        // found by accident. Treating any success as "awake, will pull" cancelled the sole recovery
        // for the one wake nothing else can replay.
        if (isMentionWake) pendingMentionWake = undefined;
        clearRetry(true);
        if (pendingMentionWake) scheduleRetry(); // someone else's success is not this one's delivery
      },
      (e: Error) => {
        log(`channel nudge failed: ${e.message}`);
        scheduleRetry();
      },
    );
  };

  // Mode-aware wake. A *directed* message (DM, anycast, or an @mention of us) always nudges, so the
  // addressee sees it promptly — woken now if idle, at the next turn boundary if busy. *Ambient*
  // channel chatter nudges only in `open` while idle (suppressed mid-turn, never in dnd/focus), and a
  // receive-time pull-only ambient never nudges (a quiet @mention remains automatic). `muted` never reaches
  // here (ack-dropped at ingest); in `focus`, ambient/mentions never reach "incoming" either.
  agent.on("incoming", (item: InboxItem) => {
    const automatic = agent.inboxScope(item.id) === "automatic";
    const directedOrMention = item.kind !== "channel" || item.mentionsMe;
    const ambientWakes = agent.attention === "open" && agent.status !== "working";
    if (automatic && (directedOrMention || ambientWakes)) nudge(item);
  });
  // Focus-only: a channel @mention was acked-and-dropped (not buffered) but still wakes us to PULL it
  // — F4=B (wake-only). Its body isn't injected; cotal_inbox recalls it.
  agent.on("mention-wake", (item: InboxItem) => {
    const hint = `You were mentioned by ${fmtFrom(item)} on #${item.channel ?? "?"} — pull it with cotal_inbox.`;
    pendingMentionWake = { item, hint }; // remembered BEFORE the push, so a rejection is retryable
    nudge(item, hint, true);
  });
  agent.on("wake", () => nudge());

  return {
    setChannelActive(active: boolean): void {
      channelActive = active;
      if (!active) clearRetry(true);
    },
    stop(): void {
      clearRetry(true);
    },
  };
}
