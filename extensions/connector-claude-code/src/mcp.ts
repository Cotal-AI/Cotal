/**
 * Cotal Claude Code connector — MCP (stdio) server.
 *
 * Turns the Claude Code session that launches it into a first-class Cotal mesh
 * peer: presence + the shared cotal_* tools (from @cotal-ai/connector-core), plus
 * Claude's `claude/channel` push so an idle session wakes the instant a peer
 * message arrives. Identity comes from `COTAL_*` env.
 *
 * stdio transport owns stdout for JSON-RPC — ALL diagnostics go to stderr.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  configFromEnv,
  hasIdentity,
  MeshAgent,
  startControlServer,
  registerCotalTools,
  feedbackLine,
  ORIENTATION_BOOTSTRAP,
  formatInjection,
  fmtFrom,
  channelMeta,
  type InboxItem,
  type HookHandle,
} from "@cotal-ai/connector-core";
import { TranscriptMirror, transcriptChannel } from "./transcript.js";

/** Mirrors this session's transcript to `tr-<name>` — set in main() iff COTAL_TRANSCRIPT
 *  is on (buildLaunch sets it for managed sessions; personal sessions never mirror). */
let mirror: TranscriptMirror | undefined;

/**
 * Last tool Claude tried to use, captured on PreToolUse. When a permission Notification
 * fires moments later, this is *what* it's blocked on — so the dashboard shows the actual
 * command/action awaiting approval, not just "Claude needs your permission".
 */
let pendingTool: { name: string; detail: string } | undefined;

/** A short, human-readable preview of a tool call: its most salient input, else compact JSON. */
function toolDetail(name: unknown, input: unknown): { name: string; detail: string } | undefined {
  if (typeof name !== "string" || !name) return undefined;
  const i = (input ?? {}) as Record<string, unknown>;
  const salient = i.command ?? i.file_path ?? i.path ?? i.url ?? i.pattern ?? i.description;
  let detail = typeof salient === "string" ? salient : Object.keys(i).length ? JSON.stringify(i) : "";
  if (detail.length > 300) detail = `${detail.slice(0, 299)}…`;
  return { name, detail };
}

/** Claude Code lifecycle events → presence + (on inject-capable events) queued peer messages. */
const claudeHandle: HookHandle = async (agent, ev) => {
  const event = ev.hook_event_name ?? "";
  const withContext = (text: string | undefined): Record<string, unknown> =>
    text ? { hookSpecificOutput: { hookEventName: event, additionalContext: text } } : {};
  try {
    switch (event) {
      case "SessionStart": {
        mirror?.adopt(ev.transcript_path); // mirror from HERE — a resumed session never rebroadcasts
        // Claude Code reports the session's actual model here (the ONLY hook that carries it; absent
        // after /clear or conversation recovery, so guard on string). Surface it in presence when the
        // operator didn't pin one. A mid-session /model switch fires no hook, so this holds until the
        // next (re)start — acceptable for a display-only discovery field. setModel keeps the pin wins.
        if (typeof ev.model === "string") await agent.setModel(ev.model);
        await agent.setStatus("idle");
        await agent.setAttention("open"); // F3: reset to fail-open on every (re)start — a crashed/restarted agent must not stay silently deaf
        // Boot push: a one-line note per subscribed channel (if the registry has loaded),
        // plus any messages waiting. Both are advisory context.
        const parts = [agent.channelBriefing(), formatInjection(agent.drainInbox())].filter(Boolean);
        return withContext(parts.length ? parts.join("\n\n") : undefined);
      }
      case "UserPromptSubmit":
        pendingTool = undefined; // new turn — the previous block (if any) is resolved
        mirror?.flush(ev.transcript_path);
        await agent.setStatus("working");
        return withContext(formatInjection(agent.drainInbox()));
      case "PreToolUse":
        // Remember what Claude is about to do; if it needs permission, the Notification
        // below turns this into the "blocked on" detail. Auto-approved tools just overwrite it.
        pendingTool = toolDetail(ev.tool_name, ev.tool_input);
        mirror?.flush(ev.transcript_path); // near-live mirror: each tool boundary ships the turn so far
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
        mirror?.flush(ev.transcript_path);
        await agent.setStatus("idle");
        // Now idle: if ambient channel chatter was held while we were busy, ask the channel to
        // wake one turn so its UserPromptSubmit drains+acks the batch. (Ack sites are two:
        // drainInbox for surfaced items, and the focus ingest ack-drop for ambient/mentions a
        // focus agent declined.) Stop can't inject context itself, so we must NOT drain here —
        // that would ack with no vehicle to the model and silently lose the messages.
        // Mode-and-channel-aware (pendingWake): open flushes held normal ambient too; dnd/focus and
        // per-channel `quiet` wake only for held DIRECTED items (held quiet/dnd ambient alone must not
        // wake — it would empty-wake busy-loop; it rides the next human turn).
        if (agent.pendingWake() > 0) agent.requestWake();
        return {};
      case "SessionEnd":
        mirror?.flush(ev.transcript_path); // best-effort — the process may exit before it lands
        await agent.setStatus("offline");
        return {};
      default:
        return {};
    }
  } catch {
    return {}; // never block the session
  }
};

async function main(): Promise<void> {
  // No identity → this is a plain `claude`, not a launcher-spawned agent. Stay
  // inert: never connect to the mesh, so an installed plugin can't make the
  // operator's own sessions join as stray peers.
  if (!hasIdentity()) {
    process.stderr.write("[cotal-connector] no COTAL_NAME — not a managed session; staying off the mesh\n");
    return;
  }
  const config = configFromEnv();
  config.connector = "claude"; // advertise the host harness on our AgentCard (meta.connector)
  const agent = new MeshAgent(config);
  agent.start(); // background connect with retry — never blocks tool serving

  if (/^(1|true|yes|on)$/i.test(process.env.COTAL_TRANSCRIPT ?? ""))
    mirror = new TranscriptMirror(agent, transcriptChannel(config.name));

  // Local control plane for the lifecycle hooks (presence + message injection) and the manager's
  // cooperative shutdown. Path + token come from the launch env (buildLaunch set them, and the hooks
  // inherit this process's env) — a managed session without them is misconfigured, so fail loud
  // rather than serve an unauthenticated/no control plane.
  const controlPath = process.env.COTAL_CONTROL_SOCKET;
  const controlToken = process.env.COTAL_CONTROL_TOKEN;
  if (!controlPath || !controlToken) {
    process.stderr.write(
      "[cotal-connector] managed session missing COTAL_CONTROL_SOCKET/COTAL_CONTROL_TOKEN — cannot serve the control plane\n",
    );
    process.exit(1);
  }
  // Defined before the server so it can be the cooperative-shutdown handler; only ever CALLED after
  // `controlServer` is assigned (on a signal or an authed `{op:"shutdown"}`), so the forward ref is safe.
  let controlServer: ReturnType<typeof startControlServer> | undefined;
  const shutdown = async () => {
    try {
      controlServer?.close();
    } catch {
      /* ignore */
    }
    try {
      await agent.stop();
    } finally {
      process.exit(0);
    }
  };
  controlServer = startControlServer(
    agent,
    { path: controlPath, token: controlToken },
    claudeHandle,
    { fatalBind: true, onShutdown: () => void shutdown() },
  );

  const server = new McpServer(
    { name: "cotal", version: "0.0.0" },
    {
      // `claude/channel` makes this MCP server a Claude Code *channel*: peer
      // messages can be pushed straight into the session (waking it if idle).
      capabilities: { experimental: { "claude/channel": {} } },
      instructions:
        `You are connected to the Cotal mesh as "${config.name}"` +
        `${config.role ? ` (role: ${config.role})` : ""} in space "${config.space}". ` +
        `${ORIENTATION_BOOTSTRAP} ` +
        feedbackLine(config) +
        `Other agents coordinate with you here as lateral peers. ` +
        `Peer messages may arrive as <channel source="cotal" from="<name>" role="<role>" ` +
        `kind="dm|channel|anycast" channel="<name>">…</channel> — read them and, when a reply is ` +
        `warranted, respond with cotal_dm (back to that peer), cotal_send (to a channel), or ` +
        `cotal_anycast (to a role). Use cotal_roster to see who is present, cotal_inbox to pull ` +
        `anything you may have missed, and cotal_status to report what you are doing. ` +
        `If you need to concentrate, cotal_status also sets your attention — dnd (channel ` +
        `chatter stops waking you; it still arrives on your next turn) or focus (only DMs and ` +
        `@mentions reach your context — pull the held chatter with cotal_inbox). ` +
        `To silence one channel instead of all of them, cotal_channel_mode sets it quiet (still ` +
        `delivered + readable, never wakes you; @mentions still wake) or muted (you stop receiving ` +
        `it, @mentions included). ` +
        `Reply only when a reply is actually needed — a silent acknowledgement is correct; ` +
        `"agreed/thanks/good point" messages are noise. And @-mention a peer only when you need ` +
        `THAT specific peer to act: a mention wakes them, so mentioning in acknowledgements or ` +
        `sign-offs makes peers ping-pong wake-ups in an endless loop.`,
    },
  );

  registerCotalTools(server, agent, config, "claude-code");

  // One wake-nudge path, shared by incoming messages and the Stop→idle flush. It stays a stable
  // function gated on a *mutable* `channelActive` flag (flipped true only after the MCP
  // handshake confirms the client speaks claude/channel — see below). If it fires before then it
  // simply no-ops; a *buffered* message waits in the inbox and is drained at the next
  // UserPromptSubmit, so nothing is lost. This only ever *wakes* a turn (drainInbox and the focus
  // ingest ack-drop are the ack sites). One exception: a focus @mention's body was already
  // ack-dropped at ingest (not buffered), so a missed mention-wake is recoverable only by an
  // explicit cotal_inbox pull (recall) — there is no buffered copy to drain.
  let channelActive = false;
  const nudge = (item?: InboxItem, pullHint?: string): void => {
    if (!channelActive) return;
    const n = agent.inboxCount();
    const content = pullHint
      ? `📨 ${pullHint}`
      : item
      ? `📨 New ${item.kind}${item.mentionsMe ? " — you were mentioned" : ""} from ${fmtFrom(item)} — delivering your Cotal inbox now.`
      : `📨 ${n} Cotal message${n === 1 ? "" : "s"} waiting — delivering your inbox now.`;
    void server.server
      .notification({
        method: "notifications/claude/channel",
        params: { content, meta: item ? channelMeta(item) : { kind: "batch" } },
      })
      .catch((e) => process.stderr.write(`[cotal-connector] channel nudge failed: ${(e as Error).message}\n`));
  };

  // Mode-aware wake. A *directed* message (DM, anycast, or an @mention of us) always nudges, so the
  // addressee sees it promptly — woken now if idle, at the next turn boundary if busy. *Ambient*
  // channel chatter nudges only in `open` while idle (suppressed mid-turn, never in dnd/focus), and a
  // per-channel `quiet` channel never ambient-nudges (its ambient was buffered to read on the agent's
  // own terms; a `quiet` @mention still nudges via directedOrMention). `muted` ambient never reaches
  // here (ack-dropped at ingest); in `focus`, ambient/mentions never reach "incoming" either.
  agent.on("incoming", (item: InboxItem) => {
    const directedOrMention = item.kind !== "channel" || item.mentionsMe;
    const quiet = item.kind === "channel" && agent.channelMode(item.channel) === "quiet";
    const ambientWakes = !quiet && agent.attention === "open" && agent.status !== "working";
    if (directedOrMention || ambientWakes) nudge(item);
  });
  // Focus-only: a channel @mention was acked-and-dropped (not buffered) but still wakes us to PULL it
  // — F4=B (wake-only). Its body isn't injected; cotal_inbox recalls it.
  agent.on("mention-wake", (item: InboxItem) =>
    nudge(item, `You were mentioned by ${fmtFrom(item)} on #${item.channel ?? "?"} — pull it with cotal_inbox.`),
  );
  agent.on("wake", () => nudge());

  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());

  const transport = new StdioServerTransport();
  await server.connect(transport);

  // Is this session consuming us as a channel? Only now (post-handshake) can we read the
  // client's capabilities, so we flip the mutable flag the nudge path is gated on. The handlers
  // were registered above and simply no-op'd until this point.
  const clientCaps = server.server.getClientCapabilities();
  const envFlag = process.env.COTAL_CHANNEL;
  channelActive = envFlag
    ? /^(1|true|yes|on)$/i.test(envFlag)
    : Boolean((clientCaps?.experimental as Record<string, unknown> | undefined)?.["claude/channel"]);
  process.stderr.write(
    `[cotal-connector] client capabilities: ${JSON.stringify(clientCaps ?? {})} → channel ${channelActive ? "ACTIVE" : "off"}\n`,
  );

  process.stderr.write(
    `[cotal-connector] MCP ready (stdio) — space="${config.space}" name="${config.name}"${config.role ? ` role="${config.role}"` : ""}\n`,
  );
}

main().catch((e) => {
  process.stderr.write(`[cotal-connector] fatal: ${(e as Error).stack ?? String(e)}\n`);
  process.exit(1);
});
