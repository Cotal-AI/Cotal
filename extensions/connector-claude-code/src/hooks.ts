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
import {
  formatInjection,
  fmtFrom,
  channelMeta,
  type MeshAgent,
  type InboxItem,
  type HookEvent,
  type HookHandle,
} from "@cotal-ai/connector-core";
import type { TranscriptMirror } from "./transcript.js";

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
  /** The session's transcript mirror, read lazily — `mcp.ts` assigns it after the handler exists. */
  mirror?: () => TranscriptMirror | undefined;
}

/** Claude Code lifecycle events → presence + (on inject-capable events) queued peer messages. */
export function createClaudeHandle(deps: ClaudeHandleDeps = {}): HookHandle {
  const mirror = (): TranscriptMirror | undefined => deps.mirror?.();
  /**
   * Last tool Claude tried to use, captured on PreToolUse. When a permission Notification
   * fires moments later, this is *what* it's blocked on — so the dashboard shows the actual
   * command/action awaiting approval, not just "Claude needs your permission".
   */
  let pendingTool: { name: string; detail: string } | undefined;

  return async (agent: MeshAgent, ev: HookEvent): Promise<Record<string, unknown>> => {
    const event = ev.hook_event_name ?? "";
    const withContext = (text: string | undefined): Record<string, unknown> =>
      text ? { hookSpecificOutput: { hookEventName: event, additionalContext: text } } : {};
    try {
      switch (event) {
        case "SessionStart": {
          mirror()?.adopt(ev.transcript_path); // mirror from HERE — a resumed session never rebroadcasts
          // Claude Code reports the session's actual model here (the ONLY hook that carries it; absent
          // after /clear or conversation recovery, so guard on string). Surface it in presence when the
          // operator didn't pin one. A mid-session /model switch fires no hook, so this holds until the
          // next (re)start — acceptable for a display-only discovery field. setModel keeps the pin wins.
          if (typeof ev.model === "string") await agent.setModel(ev.model);
          await agent.setStatus("idle");
          await agent.setAttention("open"); // F3: reset to fail-open on every (re)start — a crashed/restarted agent must not stay silently deaf
          // Boot push: a one-line note per subscribed channel (if the registry has loaded),
          // plus any messages waiting. Both are advisory context.
          const parts = [agent.channelBriefing(), formatInjection(agent.drainInbox(undefined, "automatic"))].filter(Boolean);
          return withContext(parts.length ? parts.join("\n\n") : undefined);
        }
        case "UserPromptSubmit":
          pendingTool = undefined; // new turn — the previous block (if any) is resolved
          mirror()?.flush(ev.transcript_path);
          await agent.setStatus("working");
          return withContext(formatInjection(agent.drainInbox(undefined, "automatic")));
        case "PreToolUse":
          // Remember what Claude is about to do; if it needs permission, the Notification
          // below turns this into the "blocked on" detail. Auto-approved tools just overwrite it.
          pendingTool = toolDetail(ev.tool_name, ev.tool_input);
          mirror()?.flush(ev.transcript_path); // near-live mirror: each tool boundary ships the turn so far
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
          await agent.setStatus("waiting", activity);
          return {};
        }
        case "Stop":
        case "StopFailure": // turn died on an API error — Stop won't fire, so reset here too
          pendingTool = undefined; // turn ended — don't let a stale tool attach to an idle-wait notification
          mirror()?.flush(ev.transcript_path);
          await agent.setStatus("idle");
          // Now idle: if ambient channel chatter was held while we were busy, ask the channel to
          // wake one turn so its UserPromptSubmit drains+acks the batch. (Ack sites are two:
          // drainInbox for surfaced items, and the focus ingest ack-drop for ambient/mentions a
          // focus agent declined.) Stop can't inject context itself, so we must NOT drain here —
          // that would ack with no vehicle to the model and silently lose the messages.
          // Mode-and-channel-aware (pendingWake): open flushes held normal ambient too; dnd/focus and
          // per-channel `quiet` wake only for held DIRECTED items (quiet ambient remains pull-only).
          if (agent.pendingWake() > 0) agent.requestWake();
          return {};
        case "SessionEnd":
          mirror()?.flush(ev.transcript_path); // best-effort — the process may exit before it lands
          await agent.setStatus("offline");
          return {};
        default:
          return {};
      }
    } catch {
      return {}; // never block the session
    }
  };
}

/** One `claude/channel` push. A rejection is surfaced to the caller. */
export type ChannelNotify = (params: { content: string; meta: Record<string, string> | { kind: string } }) => Promise<void>;

export interface WakePolicy {
  /** Flip once the MCP handshake confirms the client speaks `claude/channel`. */
  setChannelActive(active: boolean): void;
  /** Teardown hook. */
  stop(): void;
}

/**
 * The push side of the wake path: turn mesh events into `claude/channel` notifications.
 *
 * A nudge only ever *wakes* a turn — the body is surfaced by the hook handler above (or by an
 * explicit `cotal_inbox` pull). It stays gated on a *mutable* `channelActive` flag (flipped true
 * only after the MCP handshake confirms the client speaks claude/channel). If it fires before
 * then it simply no-ops; a *buffered* message waits in the inbox and is drained at the next
 * UserPromptSubmit, so nothing is lost. This only ever *wakes* a turn (drainInbox and the focus
 * ingest ack-drop are the ack sites). One exception: a focus @mention's body was already
 * ack-dropped at ingest (not buffered), so a missed mention-wake is recoverable only by an
 * explicit cotal_inbox pull (recall) — there is no buffered copy to drain.
 */
export function createWakePolicy(agent: MeshAgent, notify: ChannelNotify, log: (msg: string) => void = () => {}): WakePolicy {
  let channelActive = false;

  const nudge = (item?: InboxItem, pullHint?: string): void => {
    if (!channelActive) return;
    const n = agent.inboxCount("automatic");
    const content = pullHint
      ? `📨 ${pullHint}`
      : item
      ? `📨 New ${item.kind}${item.mentionsMe ? " — you were mentioned" : ""} from ${fmtFrom(item)} — delivering your Cotal inbox now.`
      : `📨 ${n} Cotal message${n === 1 ? "" : "s"} waiting — delivering your inbox now.`;
    void notify({ content, meta: item ? channelMeta(item) : { kind: "batch" } }).catch((e: Error) =>
      log(`channel nudge failed: ${e.message}`),
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
  agent.on("mention-wake", (item: InboxItem) =>
    nudge(item, `You were mentioned by ${fmtFrom(item)} on #${item.channel ?? "?"} — pull it with cotal_inbox.`),
  );
  agent.on("wake", () => nudge());

  return {
    setChannelActive(active: boolean): void {
      channelActive = active;
    },
    stop(): void {
      /* nothing to tear down */
    },
  };
}
