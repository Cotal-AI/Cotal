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
import type { PresenceCondition, PresenceConditionCode, PresenceStatus } from "@cotal-ai/core";
import {
  formatInjection,
  fmtFrom,
  fmtChannel,
  fmtKind,
  channelMeta,
  type MeshAgent,
  type InboxItem,
  type HookEvent,
  type HookHandle,
} from "@cotal-ai/connector-core";
import type { AguiEmitterHolder } from "@cotal-ai/connector-core";
import type { ClaudeEntry } from "./agui-map.js";
import { recordCarriedFork } from "./carried.js";

/**
 * The failure a `StopFailure` hook reports, or `undefined` for any other turn end.
 *
 * **THE DECIDING RULE, and it is written down because "which harness signals mean the run failed"
 * is precisely the judgment a connector must make explicitly rather than by accident.** Claude Code
 * chooses between `Stop` and `StopFailure` ITSELF and fires exactly one of them: `Stop` when the
 * model finished responding, `StopFailure` when the turn ended on an error. So EVERY `StopFailure`
 * closes the run with `RUN_ERROR`, and the harness's own `error` value rides along as the code,
 * UNJUDGED. This connector is not claiming to know what a rate limit means; it is relaying a
 * classification the harness already made, on the hook it made it with.
 *
 * The eleven values `error` can take are `authentication_failed`, `oauth_org_not_allowed`,
 * `account_on_hold`, `billing_error`, `rate_limit`, `overloaded`, `invalid_request`,
 * `model_not_found`, `server_error`, `max_output_tokens` and `unknown` (read off the shipped
 * harness's own hook schema, not inferred from a page about it).
 *
 * **TWO OF THEM ARE ARGUABLE AND ARE DECIDED HERE RATHER THAN LEFT IMPLICIT.** `max_output_tokens`
 * is a turn that produced real output and was then cut off, and `rate_limit` is a turn nobody got
 * wrong. Calling either of those "finished" would be this connector overriding the harness on a
 * question the harness had already answered — the exact claim-about-a-harness that kept `RUN_ERROR`
 * unreachable in the first place. Publishing the distinction and letting the reader classify is the
 * cheaper mistake: a consumer holding the code can treat a truncation differently from an auth
 * failure, and a consumer told `RUN_FINISHED` has nothing to treat differently at all.
 *
 * Shape-tolerant on the way in, like every other read of a hook payload here: `error` is required by
 * the harness's schema, and a payload that somehow arrives without one is still a failed turn, just
 * one that cannot name its kind.
 */
function stopFailure(ev: HookEvent): { message: string; code?: string } | undefined {
  if (ev.hook_event_name !== "StopFailure") return undefined;
  const code = typeof ev.error === "string" && ev.error ? ev.error : undefined;
  const detail = typeof ev.error_details === "string" ? ev.error_details.trim() : "";
  return {
    message: detail || `claude turn ended on ${code ?? "an unreported error"}`,
    ...(code ? { code } : {}),
  };
}

const CLAUDE_FAILURE_CONDITIONS: Record<string, PresenceConditionCode> = {
  rate_limit: "rate_limit",
  overloaded: "overloaded",
  authentication_failed: "auth",
  oauth_org_not_allowed: "auth",
  cloud_credential_error: "auth",
  account_on_hold: "billing",
  billing_error: "billing",
  invalid_request: "request",
  model_not_found: "model",
  server_error: "server",
  max_output_tokens: "context",
  unknown: "failed",
};

/** Relay Claude Code's closed StopFailure vocabulary without reclassifying absent or unknown input. */
function failureCondition(ev: HookEvent): PresenceCondition | undefined {
  if (ev.hook_event_name !== "StopFailure") return undefined;
  const source = typeof ev.error === "string" && ev.error ? ev.error : undefined;
  const message = typeof ev.error_details === "string" && ev.error_details.trim() ? ev.error_details.trim() : undefined;
  return {
    code: source === undefined ? "failed" : (CLAUDE_FAILURE_CONDITIONS[source] ?? "failed"),
    ...(source ? { source } : {}),
    ...(message ? { message } : {}),
    since: Date.now(),
  };
}

export interface ClaudeHandleDeps {
  /** Launch environment for a hosted session's carried-fork record. Omitted uses the process env. */
  env?: NodeJS.ProcessEnv;
  /** The session's AG-UI emitter, read lazily — `mcp.ts` assigns it after the handler exists. */
  events?: () => AguiEmitterHolder<ClaudeEntry, unknown> | undefined;
  /** Told which inbox items a frame surfaced; pass {@link WakePolicy.surfaced}. */
  surfaced?: (items: readonly InboxItem[]) => void;
  /** False when native ingress owns delivery and these hooks observe lifecycle only. */
  delivery?: boolean;
  /** Allow run-turn lifecycle and exact yield correlation while peer inbox delivery stays disabled. */
  turns?: boolean;
  /** This seat's orientation card, or undefined while the seat is not bound yet. Handed over at
   *  every session start (startup, resume, fork, clear, compact), so the model has its bearings
   *  without asking for them; a card not ready at the start is owed to the next prompt. */
  orientation?: () => Promise<string | undefined>;
}

/** Prefixed to a batch containing anything whose previous delivery went unconfirmed. */
const REPEAT_NOTE = "(A previous delivery of one or more of these was not confirmed, so they may be a repeat.)";
/** Bound on the advisory repeat labels. Only grows on undelivered replies, so it is normally empty. */
const REPEAT_LABEL_CAP = 512;

// Claude Code caps each additionalContext string at 10,000 characters. Keep headroom for
// host framing and count the assembled context, including briefing, run turns and notices.
export const HOOK_CONTEXT_CHARS = 9_000;
const WAITING_NOTE_RESERVE = 160;

/** The hook side of the connector: the handler plus the delivery callback that commits what it
 *  injected. Both must be wired into {@link startControlServer} — the handler surfaces, the
 *  callback is the only place a peer message is ever acked. */
export interface ClaudeHooks {
  /** Adopt a native transcript when a personal connection starts mid-session. No synthetic
   * lifecycle event is needed, and the source decides the pre-connection privacy boundary. */
  adoptTranscript(path: string, source: unknown): void;
  handle: HookHandle;
  /** Pass as {@link ControlServerOpts.onReply}. */
  onReply: (ev: HookEvent, delivered: boolean, handoff?: boolean) => void;
  /** Receipt for an empty inbox after a confirmed hook handoff. Contains no peer content. */
  inboxDeliveryNote(): string | undefined;
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
  const events = (): AguiEmitterHolder<ClaudeEntry, unknown> | undefined => deps.events?.();

  /**
   * Claude runs each hook in a separate process. Their control-socket relays can therefore arrive
   * out of lifecycle order even though the hooks themselves fired in order: measured live on a
   * positional prompt, `UserPromptSubmit` reached this handler before `SessionStart`. Letting that
   * first flush start the holder passes `undefined` as its immutable start context; the later adopt
   * cannot replace it, and the source correctly fails loud because it cannot decide new vs retained.
   *
   * Before the first SessionStart, collapse flushes into one cumulative source read and retain the
   * one terminal if it already arrived. SessionStart then enqueues adopt → flush → close on the
   * holder's own serialized chain. No record is lost by collapsing: a source read is from its durable
   * cursor through every complete record available at pump time.
   */
  let adoptedTranscript: string | undefined;
  let deferredFlush: { path: unknown } | undefined;
  let deferredClose: { timestamp: number; error?: { message: string; code?: string } } | undefined;

  const adoptEvents = (path: unknown, source: unknown): void => {
    const holder = events();
    if (!holder) return;
    holder.adopt(path, source);
    if (typeof path !== "string" || path.length === 0) return;
    adoptedTranscript ??= path;
    if (deferredFlush) {
      holder.flush(deferredFlush.path);
      deferredFlush = undefined;
    }
    if (deferredClose) {
      holder.closeRun(deferredClose.timestamp, deferredClose.error);
      deferredClose = undefined;
    }
  };

  const flushEvents = (path: unknown): void => {
    const holder = events();
    if (!holder) return;
    if (adoptedTranscript === undefined) {
      deferredFlush ??= { path };
      return;
    }
    holder.flush(path);
  };

  /** Resolves once the holder has taken the transcript's position for the terminal, so the hook
   *  replies, and the harness goes on to the next turn, only after that. */
  const closeEvents = (timestamp: number, error?: { message: string; code?: string }): Promise<void> => {
    const holder = events();
    if (!holder) return Promise.resolve();
    if (adoptedTranscript === undefined) {
      // Exactly one terminal should exist. If a malformed host sends two before SessionStart, the
      // first is the only one that can describe how that run ended; never turn an earlier error into
      // a later success by overwriting it.
      deferredClose ??= { timestamp, ...(error ? { error } : {}) };
      return Promise.resolve();
    }
    return holder.closeRun(timestamp, error);
  };
  /**
   * Last tool Claude tried to use, captured on PreToolUse. When a permission Notification
   * fires moments later, publish only its name. Tool input can carry commands, paths or
   * private question text and must not become activity visible to every roster reader.
   */
  let pendingTool: string | undefined;
  /** SessionStart can arrive during an open turn, including after compaction. */
  let turnOpen = false;
  /** A session start found the seat unbound, so its card goes with the next prompt instead. */
  let cardOwed = false;
  const orientation = async (): Promise<string | undefined> => {
    const card = await deps.orientation?.();
    cardOwed = deps.orientation !== undefined && card === undefined;
    return card;
  };
  /** A Notification raised a prompt in this turn that no main-agent tool batch has resolved yet. Kept
   *  here rather than read off `agent.status`: relays overlap, and a batch that arrives while the
   *  `waiting` write is still in flight would read `working` and miss the wait it resolves. It opens
   *  only inside a turn and every terminal closes it, so a batch relayed after one cannot bring the
   *  seat back. */
  let promptOpen = false;
  /** Batches awaiting a delivery verdict, keyed by the EVENT OBJECT the control server passes to
   *  both `handle` and `onReply`. Frames are separate socket connections and can overlap (a
   *  `PreToolUse` from a parallel tool batch while a `UserPromptSubmit` reply is still being
   *  written), so a single mutable slot would let one frame's verdict commit another frame's ids —
   *  the same mis-ack this file exists to prevent, just with a new cause. The event identity is the
   *  only thing that correlates a verdict to the reply that carried the batch. A WeakMap so an
   *  event whose verdict never arrives is collected rather than leaked. */
  const inFlight = new WeakMap<HookEvent, { ids: string[]; agent: MeshAgent; turnIds?: string[]; onceIds?: string[] }>();
  /** Once tasks this session's frames claimed whose delivery verdict has not arrived. A turn end,
   *  a session end or a replaced session before the verdict seals them, so a late receipt cannot
   *  confirm a task whose turn already ended. */
  const awaitingVerdict = new Map<string, MeshAgent>();
  const sealAwaiting = (): void => {
    for (const [id, agent] of awaitingVerdict) agent.releaseTurns([id]);
    awaitingVerdict.clear();
  };
  /** Ids whose delivery could not be confirmed, so they are being surfaced again. Advisory only —
   *  it labels a possible repeat for the model. Bounded; on overflow the label is dropped (never
   *  the message), because the label is a courtesy and the message is the product. */
  const unconfirmed = new Set<string>();
  let lastDelivery: { count: number; event: string } | undefined;

  /** Flag deliveries whose confirmation this process could not obtain (keyed by receive key, #624:
   *  an id-less item's wire id is "", so raw-id keying would label EVERY later id-less message a
   *  repeat), so a re-surface is labelled a possible repeat. Past the cap the labels go, never the
   *  messages: an unlabelled repeat is cosmetic, a dropped message is not. */
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

  const safeCondition = async (agent: MeshAgent, condition: PresenceCondition | null): Promise<void> => {
    try {
      await agent.setCondition(condition);
    } catch {
      /* best-effort */
    }
  };

  /** Format the automatic batch WITHOUT acking it; the ids ride on THIS frame's delivery verdict. */
  const surfaceAutomatic = (agent: MeshAgent, ev: HookEvent, reserved = 0): string | undefined => {
    if (deps.delivery === false) return undefined;
    const pending = agent.peekInbox("automatic");
    if (!pending.length) return undefined;
    const budget = HOOK_CONTEXT_CHARS - reserved - WAITING_NOTE_RESERVE - REPEAT_NOTE.length - 1;
    const items: InboxItem[] = [];
    for (const item of pending) {
      const candidate = formatInjection([...items, item]);
      if (candidate && candidate.length <= budget) items.push(item);
    }
    const remaining = pending.length - items.length;
    const waiting = remaining
      ? `${remaining} Cotal message${remaining === 1 ? " is" : "s are"} still waiting. Read with cotal_inbox; messages too large for a hook remain there.`
      : undefined;
    const body = formatInjection(items);
    if (!body) return waiting;
    const ids = items.map((i) => i.recvKey);
    // These stay in the inbox until the verdict, so the overflow valve could otherwise ack one out
    // from under us mid-delivery — unrecoverable, since an acked id is never redelivered. If the
    // agent cannot protect the whole batch (too many frames already open), DO NOT SURFACE IT: an
    // unprotected in-flight batch is the very loss this guards against. The messages stay buffered
    // and go out on a later frame once a verdict frees capacity.
    if (!agent.holdInFlight(ids)) return undefined;
    inFlight.set(ev, { ids, agent });
    deps.surfaced?.(items);
    // At-least-once, deliberately: an unconfirmed batch is re-surfaced rather than dropped, so a
    // reply that DID land but whose confirmation was lost shows the model the same message twice.
    // Say so, so a repeat reads as a repeat instead of as a peer sending twice.
    const delivered = ids.some((id) => unconfirmed.has(id)) ? `${REPEAT_NOTE}\n${body}` : body;
    return waiting ? `${delivered}\n${waiting}` : delivered;
  };

  /** Peek this seat's pending run turns for injection, riding THIS frame's delivery verdict: the
   *  goal ids commit as surfaced (arming the automatic `done`) only when the reply reached the
   *  runtime — a lost frame re-surfaces them instead of yielding for work the model never saw. */
  const surfaceTurns = (agent: MeshAgent, ev: HookEvent): string | undefined => {
    if (deps.delivery === false && deps.turns !== true) return undefined;
    const peek = agent.peekPendingTurns();
    if (!peek) return undefined;
    const rec = inFlight.get(ev);
    if (rec) rec.turnIds = peek.goalIds;
    else inFlight.set(ev, { ids: [], agent, turnIds: peek.goalIds });
    return peek.text;
  };

  /** One injectable frame. A once task takes the hook budget first; the card and briefing that still
   *  fit come next, then peer messages in what is left. The task is claimed once the text is fixed,
   *  with nothing awaited between the claim and the reply. A task that does not fit, or whose claim
   *  fails, leaves the frame without it, claimed by nothing. */
  const injectFrame = (agent: MeshAgent, ev: HookEvent, event: string, extras: (string | undefined)[]): Record<string, unknown> => {
    const peek = agent.peekPendingTurns();
    if (peek?.once && peek.text.length <= HOOK_CONTEXT_CHARS) {
      const join = (parts: (string | undefined)[]): string => parts.filter(Boolean).join("\n\n");
      const kept: string[] = [];
      for (const x of extras) if (x && join([...kept, x, peek.text]).length <= HOOK_CONTEXT_CHARS) kept.push(x);
      const messages = surfaceAutomatic(agent, ev, join([...kept, peek.text]).length + 2);
      const text = join([...kept, messages, peek.text]);
      if (text.length <= HOOK_CONTEXT_CHARS && agent.claimTurns(peek.goalIds)) {
        const rec = inFlight.get(ev);
        if (rec) rec.onceIds = peek.goalIds;
        else inFlight.set(ev, { ids: [], agent, onceIds: peek.goalIds });
        for (const id of peek.goalIds) awaitingVerdict.set(id, agent);
        return { hookSpecificOutput: { hookEventName: event, additionalContext: text } };
      }
      return withContextFor(agent, ev, event, join([...kept, messages]) || undefined);
    }
    // surfaceAutomatic first: it creates this frame's inFlight record, and surfaceTurns extends it.
    const reserved = extras.reduce((n, x) => n + (x?.length ?? 0) + 2, 0) + (peek && !peek.once ? peek.text.length + 2 : 0);
    const parts = [...extras, surfaceAutomatic(agent, ev, reserved), peek?.once ? undefined : surfaceTurns(agent, ev)].filter(Boolean);
    return withContextFor(agent, ev, event, parts.length ? parts.join("\n\n") : undefined);
  };

  /** The reply for `text`, which must fit the hook's cap. A frame over it carries a short note in
   *  place of its context, and nothing it surfaced commits: the peer messages and run turns go back
   *  for a later read. */
  const withContextFor = (agent: MeshAgent, ev: HookEvent, event: string, text: string | undefined): Record<string, unknown> => {
    if (!text) return {};
    if (text.length > HOOK_CONTEXT_CHARS) {
      // The other context can itself exceed the host cap. Never commit peer bodies or run
      // turns from a frame the host would replace with a preview. Leave both for a later read.
      const batch = inFlight.get(ev);
      if (batch) {
        inFlight.delete(ev);
        batch.agent.releaseInFlight(batch.ids);
      }
      text = `${agent.inboxCount("automatic")} Cotal messages still waiting. Read with cotal_inbox. Additional session context did not fit in this hook.`;
    }
    return { hookSpecificOutput: { hookEventName: event, additionalContext: text } };
  };

  const handle: HookHandle = async (agent: MeshAgent, ev: HookEvent): Promise<Record<string, unknown>> => {
    const event = ev.hook_event_name ?? "";
    try {
      switch (event) {
        case "SessionStart": {
          // `source` is the runtime's explicit new-vs-retained discriminator. A startup prompt may
          // already be in the file before this hook; resume/fork/clear/compact must still adopt at the
          // current boundary and never republish history. The holder carries the value opaquely to
          // the connector-owned source factory.
          adoptEvents(ev.transcript_path, ev.source);
          recordCarriedFork(deps.env ?? process.env, ev);
          // Claude Code reports the session's actual model here (the ONLY hook that carries it; absent
          // after /clear or conversation recovery, so guard on string). Surface it in presence when the
          // operator didn't pin one. A mid-session /model switch fires no hook, so this holds until the
          // next (re)start — acceptable for a display-only discovery field. setModel keeps the pin wins.
          if (typeof ev.model === "string") await agent.setModel(ev.model).catch(() => {});
          // The session's directory, from the harness (`cwd` on every hook). Only a session start
          // (startup, resume, fork) sets it: clear and compact carry the directory after any later
          // `cd`, and the card shows where the session started, not a live shell path.
          if (typeof ev.cwd === "string" && (ev.source === "startup" || ev.source === "resume" || ev.source === "fork"))
            await agent.setCwd(ev.cwd).catch(() => {});
          // NOT a turn ending. `SessionStart` fires on compact, clear and resume, and a compaction
          // lands mid-turn: routed through the boundary this published `done` for a run turn the
          // model was still working on.
          // Preserve working or waiting until the turn's own terminal hook arrives.
          if (!turnOpen) {
            try { await agent.resetStatus("idle"); } catch { /* best-effort */ }
          }
          // Reset to fail-open on every (re)start — a crashed/restarted agent must not stay silently
          // deaf. Advisory: the local default is already "open", so a failed write changes nothing.
          try {
            await agent.setAttention("open");
          } catch {
            /* best-effort */
          }
          // A new session replaces the one an earlier frame's once task rode on.
          sealAwaiting();
          // Boot push: the orientation card, a one-line note per subscribed channel (if the
          // registry has loaded), plus any messages waiting and any turn. All advisory context.
          const card = await orientation();
          return injectFrame(agent, ev, event, [card, agent.channelBriefing()]);
        }
        case "UserPromptSubmit": {
          turnOpen = true;
          pendingTool = undefined; // new turn — the previous block (if any) is resolved
          promptOpen = false;
          flushEvents(ev.transcript_path);
          await safeStatus(agent, "working");
          // Run turns ride the same frame as peer messages: this is an injectable boundary, and
          // the frame's delivery verdict is what commits them as surfaced (arming the automatic
          // `done` at the coming Stop).
          const card = cardOwed ? await orientation() : undefined;
          return injectFrame(agent, ev, event, [card]);
        }
        case "PreToolUse":
          // A channel-started turn can reach its first tool without UserPromptSubmit. The
          // main agent's tool is evidence of work; a successful nudge alone is not. Do not
          // let a subagent open the main turn or a later tool clear an unresolved prompt.
          if (!turnOpen && ev.agent_id === undefined) {
            turnOpen = true;
            promptOpen = false;
            await safeStatus(agent, "working");
          }
          // Remember what Claude is about to do; if it needs permission, the Notification
          // below names it without publishing its input. Auto-approved tools overwrite it.
          pendingTool = typeof ev.tool_name === "string" && ev.tool_name ? ev.tool_name : undefined;
          flushEvents(ev.transcript_path); // near-live: each tool boundary ships the turn so far
          return {};
        case "PostToolBatch":
          // Every tool in the batch resolved, so a prompt raised during it was answered and the turn
          // went on. Left `waiting`, its Stop would be `waiting → idle`, which is no turn boundary:
          // the run turn never yields and the condition outlives the turn. `working` also clears it.
          // A subagent's batch carries `agent_id` and answers nothing the main agent is blocked on.
          if (!promptOpen || ev.agent_id !== undefined) return {};
          promptOpen = false;
          await safeStatus(agent, "working");
          return {};
        case "Notification": {
          // Claude Code's Notification carries the human-readable reason the session is
          // blocked in `message`. Name a pending tool without exposing any tool arguments.
          // Otherwise (idle-input / elicitation, no tool) the message itself is the content.
          const msg = typeof ev.message === "string" ? ev.message : undefined;
          const activity = pendingTool ?? msg;
          promptOpen = turnOpen;
          // Both writes are queued before either settles, so a batch relayed meanwhile queues its
          // `working` behind the condition; queued between them, the condition would outlive the turn.
          const writes = [safeStatus(agent, "waiting", activity)];
          const notificationType = typeof ev.notification_type === "string" ? ev.notification_type : undefined;
          if (notificationType === "permission_prompt" || notificationType === "agent_needs_input")
            writes.push(safeCondition(agent, {
              code: notificationType === "permission_prompt" ? "approval" : "input",
              source: notificationType,
              ...(msg ? { message: msg } : {}),
              since: Date.now(),
            }));
          await Promise.all(writes);
          return {};
        }
        case "Stop":
        case "StopFailure": // turn died on an API error — Stop won't fire, so reset here too
          sealAwaiting();
          turnOpen = false;
          promptOpen = false;
          pendingTool = undefined; // turn ended — don't let a stale tool attach to an idle-wait notification
          flushEvents(ev.transcript_path);
          // THE TURN TERMINAL, and it has to be a second call rather than part of the flush. The
          // records this hook fires after do not say the turn ended: the harness knows, and the
          // file does not. So the run is closed from HERE, after the flush has consumed every
          // record the turn produced, or the closing frame would land while a message or a tool
          // call was still open and the emitter would refuse it. It republishes the source cursor
          // unchanged, because advancing it would mark records consumed that were never mapped.
          //
          // AND ON `StopFailure` IT CLOSES WITH `RUN_ERROR` RATHER THAN `RUN_FINISHED`. Both hooks
          // land here because both end a turn and both must reset presence; only one of them ends a
          // turn that FAILED, and publishing them identically told a reader of the plane that a turn
          // killed by a rate limit or a billing error had simply finished. See {@link stopFailure}
          // for which signals count and why. `RUN_ERROR` closes the run on its own, so there is no
          // second terminal to follow it.
          await closeEvents(Date.now(), stopFailure(ev));
          if (event === "StopFailure") await safeCondition(agent, failureCondition(ev) ?? null);
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
          sealAwaiting();
          turnOpen = false;
          promptOpen = false;
          flushEvents(ev.transcript_path); // best-effort — the process may exit before it lands
          await safeStatus(agent, "offline");
          return {};
        default:
          return {};
      }
    } catch {
      // The `{}` below carries nothing, but its write still yields a delivered verdict. Drop this
      // frame's record first, or onReply would ack a batch the model never saw. The ids go back to
      // ordinary backlog and surface on a later frame.
      const rec = inFlight.get(ev);
      if (rec) {
        inFlight.delete(ev);
        if (rec.ids.length) rec.agent.releaseInFlight(rec.ids);
        if (rec.onceIds?.length) {
          for (const id of rec.onceIds) awaitingVerdict.delete(id);
          rec.agent.releaseTurns(rec.onceIds);
        }
      }
      return {}; // never block the session
    }
  };

  /**
   * The reply carrying an injected batch either reached the runtime or it did not. Delivered ⇒
   * commit exactly those ids (the sole ack site for automatic peer messages). Not delivered ⇒
   * abandon them un-acked, so JetStream redelivers, `incoming` fires again, and the peer is nudged
   * again — a dropped reply costs a round trip, never the message.
   */
  const onReply = (ev: HookEvent, delivered: boolean, handoff = false): void => {
    const batch = inFlight.get(ev);
    if (!batch) return; // this frame carried no peer messages or turns (PreToolUse, Notification, Stop, …)
    inFlight.delete(ev);
    const { ids, agent, turnIds, onceIds } = batch;
    // A once task confirms only on the relay's receipt that its write to Claude's pipe completed.
    // Anything else, a terminal that already sealed it included, seals it and reports.
    if (onceIds?.length) {
      const pending = onceIds.filter((id) => awaitingVerdict.delete(id));
      if (delivered && handoff && pending.length === onceIds.length) agent.commitSurfacedTurns(onceIds);
      else agent.releaseTurns(onceIds);
    }
    // Run turns commit only on a delivered frame; an undelivered one leaves them unsurfaced, so
    // they re-inject on a later frame instead of auto-yielding `done` for unseen work.
    if (delivered && turnIds?.length) agent.commitSurfacedTurns(turnIds);
    if (!ids.length) return; // a turn-only frame holds no inbox batch to release or ack
    agent.releaseInFlight(ids); // verdict is in, either way — ordinary backlog again
    if (!delivered) {
      markUnconfirmed(ids);
      return;
    }
    for (const id of ids) unconfirmed.delete(id);
    try {
      const committed = agent.drainInboxDeliveries(ids);
      if (committed.items.length)
        lastDelivery = { count: committed.items.length, event: ev.hook_event_name ?? "" };
    } catch {
      // The ack itself failed — a JetStream ack publishes, so a closed connection throws. Whatever
      // did not ack is also not marked handled, so JetStream redelivers it and nothing is lost. But
      // it WAS shown, so re-flag the batch: the repeat arrives labelled instead of looking fresh.
      // Imprecise on purpose — a mid-batch throw may have acked a prefix we cannot identify from
      // here, so ids already committed linger as stale labels until the cap clears them.
      markUnconfirmed(ids);
    }
  };

  return {
    handle, onReply, adoptTranscript: adoptEvents,
    inboxDeliveryNote: () => lastDelivery
      ? `No unread messages remain. The most recent confirmed Claude Code hook handoff carried ${lastDelivery.count} message${lastDelivery.count === 1 ? "" : "s"} as additionalContext (${lastDelivery.event}). This is a delivery receipt, not a new message.`
      : undefined,
  };
}

/** One `claude/channel` push. A rejection is surfaced to the caller. */
export type ChannelNotify = (params: { content: string; meta: Record<string, string> | { kind: string } }) => Promise<void>;

export interface WakePolicy {
  /** Flip once the MCP handshake confirms the client speaks `claude/channel`. */
  setChannelActive(active: boolean): void;
  /** These items rode a hook frame, which spends the nudge that announced them. If that frame's
   *  reply never reached the runtime, their next redelivery is news to the session again. */
  surfaced(items: readonly InboxItem[]): void;
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
 * then it simply no-ops; the false-to-true activation reconciles the remembered mention first,
 * otherwise one buffered wake. A focus @mention needs that reconcile because its body was already
 * ack-dropped at ingest (not buffered), so there is no local copy or durable redelivery to wake the
 * session later.
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
  /** Items a nudge announced that no hook frame has carried since, each mapped to the covered list of
   *  the push that announced it. Each JetStream redelivery of a pending item re-emits `incoming`;
   *  while the session still holds that nudge (a long tool call), printing it again only queues a
   *  duplicate per ack wait (#2584). Recorded when the push is made, not when it resolves: a push
   *  still queued behind a full stdout can complete after a frame carried the item and lost its
   *  reply, and recording it then would bury the redelivery that recovers that loss. Keyed by the
   *  item, so a message re-buffered after it left the inbox is announced afresh. */
  const announced = new WeakMap<InboxItem, readonly InboxItem[]>();
  /** Wake-eligible work, run turns included, that no live notice covers: what a retry still owes. */
  const owed = (): number => agent.pendingWake((item) => announced.has(item));

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
    // An item a live notice still announces is owed nothing, so a rejection that a newer push
    // superseded schedules no retry.
    if (owed() === 0 && !pendingMentionWake) return;
    const delay = retryMs;
    retryMs = Math.min(retryMs * 2, NUDGE_RETRY_MAX_MS);
    retryTimer = setTimeout(() => {
      retryTimer = undefined;
      // The mention goes FIRST when both are outstanding. A buffered message still has JetStream
      // behind it — un-acked, it redelivers and re-announces itself — whereas the ack-dropped mention
      // has nothing but this timer. Checking the inbox first meant any buffered DM starved the
      // mention retry indefinitely, since the batch nudge kept succeeding and rescheduling itself.
      // The retry stands in for lost notices, so its batch counts only what no live notice announces.
      if (pendingMentionWake) nudge(pendingMentionWake.item, pendingMentionWake.hint, true);
      else if (owed() > 0) nudge(undefined, undefined, false, agent.peekInbox("automatic").filter((it) => !announced.has(it)));
    }, delay);
    retryTimer.unref?.(); // a pending retry must never hold the process open
  };

  const nudge = (item?: InboxItem, pullHint?: string, isMentionWake = false, batch?: readonly InboxItem[]): void => {
    if (!channelActive) return;
    // A batch notice announces every automatic item it counts.
    const covered = item ? [item] : batch ?? agent.peekInbox("automatic");
    const n = covered.length;
    for (const it of covered) announced.set(it, covered);
    const content = pullHint
      ? `📨 ${pullHint}`
      : item
      ? `📨 New ${fmtKind(item.kind)}${item.mentionsMe ? " — you were mentioned" : ""} from ${fmtFrom(item)} — delivering your Cotal inbox now.`
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
        // The session never saw this push, so its redelivery is news again, unless a later push
        // announced the item since.
        for (const it of covered) if (announced.get(it) === covered) announced.delete(it);
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
    if (announced.has(item)) return;
    const automatic = agent.inboxScope(item.recvKey) === "automatic";
    const directedOrMention = item.kind !== "channel" || item.mentionsMe;
    const ambientWakes = agent.attention === "open" && agent.status !== "working";
    if (automatic && (directedOrMention || ambientWakes)) nudge(item);
  });
  // Focus-only: a channel @mention was acked-and-dropped (not buffered) but still wakes us to PULL it
  // — F4=B (wake-only). Its body isn't injected; cotal_inbox recalls it.
  agent.on("mention-wake", (item: InboxItem) => {
    const hint = `You were mentioned by ${fmtFrom(item)} on #${fmtChannel(item.channel)} — pull it with cotal_inbox.`;
    pendingMentionWake = { item, hint }; // remembered BEFORE the push, so a rejection is retryable
    nudge(item, hint, true);
  });
  agent.on("wake", () => nudge());

  return {
    setChannelActive(active: boolean): void {
      const activated = active && !channelActive;
      channelActive = active;
      if (!active) clearRetry(true);
      else if (activated) {
        if (pendingMentionWake) nudge(pendingMentionWake.item, pendingMentionWake.hint, true);
        else if (agent.pendingWake() > 0) nudge();
      }
    },
    surfaced(items: readonly InboxItem[]): void {
      for (const item of items) announced.delete(item);
    },
    stop(): void {
      clearRetry(true);
    },
  };
}
