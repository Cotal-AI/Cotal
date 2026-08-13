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
  MESH_FIRST_STEER,
} from "@cotal-ai/connector-core";
import { createClaudeHandle, createWakePolicy, type WakePolicy } from "./hooks.js";
import { TranscriptMirror, transcriptChannel } from "./transcript.js";

/** Mirrors this session's transcript to `tr-<name>` — set in main() iff COTAL_TRANSCRIPT
 *  is on (buildLaunch sets it for managed sessions; personal sessions never mirror). */
let mirror: TranscriptMirror | undefined;

/** Claude Code lifecycle events → presence + (on inject-capable events) queued peer messages.
 *  Read `mirror` lazily: main() assigns it after this handler is built. `onReply` is the commit
 *  half — an injected batch is acked only once its reply is confirmed delivered. */
const claude = createClaudeHandle({ mirror: () => mirror });

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
  // `wake` is likewise assigned later — declared with `let` (not `const` further down) so a shutdown
  // frame arriving before the MCP server exists reads `undefined` instead of hitting the TDZ.
  let controlServer: ReturnType<typeof startControlServer> | undefined;
  let wake: WakePolicy | undefined;
  const shutdown = async () => {
    try {
      controlServer?.close();
    } catch {
      /* ignore */
    }
    wake?.stop();
    try {
      await agent.stop();
    } finally {
      process.exit(0);
    }
  };
  controlServer = startControlServer(
    agent,
    { path: controlPath, token: controlToken },
    claude.handle,
    { fatalBind: true, onShutdown: () => void shutdown(), onReply: claude.onReply },
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
        `${MESH_FIRST_STEER} ` +
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
        `buffered but pull-only via cotal_inbox; @mentions still wake and inject) or muted (you stop receiving ` +
        `it, @mentions included). ` +
        `Reply only when a reply is actually needed — a silent acknowledgement is correct; ` +
        `"agreed/thanks/good point" messages are noise. And @-mention a peer only when you need ` +
        `THAT specific peer to act: a mention wakes them, so mentioning in acknowledgements or ` +
        `sign-offs makes peers ping-pong wake-ups in an endless loop.`,
    },
  );

  registerCotalTools(server, agent, config, "claude-code");

  // The wake policy owns every `claude/channel` push (arriving messages + the Stop→idle flush).
  // It stays inert until the handshake below confirms the client speaks claude/channel.
  wake = createWakePolicy(
    agent,
    (params) => server.server.notification({ method: "notifications/claude/channel", params }),
    (msg) => process.stderr.write(`[cotal-connector] ${msg}\n`),
  );

  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());

  const transport = new StdioServerTransport();
  await server.connect(transport);

  // Is this session consuming us as a channel? Only now (post-handshake) can we read the
  // client's capabilities, so we flip the flag the nudge path is gated on. The handlers
  // were registered above and simply no-op'd until this point.
  const clientCaps = server.server.getClientCapabilities();
  const envFlag = process.env.COTAL_CHANNEL;
  const channelActive = envFlag
    ? /^(1|true|yes|on)$/i.test(envFlag)
    : Boolean((clientCaps?.experimental as Record<string, unknown> | undefined)?.["claude/channel"]);
  wake?.setChannelActive(channelActive);
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
