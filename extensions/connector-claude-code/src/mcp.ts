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
  AguiEmitter,
  AguiEmitterHolder,
  EventWal,
  FileSubjectFrontier,
  JsonlFileSource,
  ensureEventWalDir,
  resolveEventsStateRoot,
  controlFromEnv,
} from "@cotal-ai/connector-core";
import { principalKey } from "@cotal-ai/core";
import { randomUUID } from "node:crypto";
import { basename } from "node:path";
import { createClaudeHandle, createWakePolicy, type WakePolicy } from "./hooks.js";
import { createClaudeMapper, type ClaudeEntry, type ClaudeMapper } from "./agui-map.js";

/** Publishes this session's activity as AG-UI events on `events.<owner>.<actor>` — set in main()
 *  iff COTAL_EVENTS is on (buildLaunch sets it for managed sessions; a personal session never
 *  publishes). This replaces the `tr-<name>` transcript mirror, which is gone. */
let events: AguiEmitterHolder<ClaudeEntry> | undefined;

/** Claude Code lifecycle events → presence + (on inject-capable events) queued peer messages.
 *  Read `events` lazily: main() assigns it after this handler is built. `onReply` is the commit
 *  half — an injected batch is acked only once its reply is confirmed delivered. */
const claude = createClaudeHandle({ events: () => events });

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

  if (/^(1|true|yes|on)$/i.test(process.env.COTAL_EVENTS ?? "")) {
    // The mapper is built inside the emitter factory, because it is keyed on the thread the
    // transcript names and that is not known until a hook hands one over. It is HELD here because
    // `onRunClosed` below has to reach it, and the two are assigned at different times.
    let mapper: ClaudeMapper | undefined;
    // The emitter is built LAZILY, on the first hook that hands over a transcript path: its source
    // IS that transcript, whose location this process does not know until a hook says so, and
    // `start()` reaches the broker, work that must not run for a session that never emits.
    //
    // The channel is derived inside the emitter from the endpoint's OWN principal, never from
    // `config.name`, so the subject the broker enforces a grant against and the subject this
    // publishes to are computed from the identity the connection authenticates as.
    events = new AguiEmitterHolder<ClaudeEntry>(
      async (transcriptPath: string) => {
        // The events state root. Throws rather than defaulting to the working directory, because a
        // write-ahead log written somewhere no later start looks is a silent loss.
        const workspaceRoot = resolveEventsStateRoot(process.env);

        // The native session IS the AG-UI thread, and Claude Code names the transcript after it.
        // Taken from the path rather than from any env: the hook's path is what the emitter
        // actually reads, so deriving the thread from anything else could key a log to one session
        // while consuming another's bytes.
        const threadId = basename(transcriptPath, ".jsonl");
        const principal = principalKey(agent.ep.principal.owner, agent.ep.principal.actor).key;

        // The directory chain is made durable BEFORE the first transition, so a crash cannot lose
        // the thread directory's own link and let a published thread reboot as virgin.
        const { walPath, subjectPath } = await ensureEventWalDir({ workspaceRoot, space: config.space, principal, threadId });

        // The subject is per PRINCIPAL and the log is per thread, so the expectation a publish
        // carries lives beside the thread directories rather than inside one of them. Without it a
        // second session of this agent opens virgin, expects an empty subject its own first session
        // filled, and halts for good.
        const subjectFrontier = await FileSubjectFrontier.open(subjectPath, { space: config.space, principal });

        // `subjectMayExist: false` is an honest claim rather than a convenient default: this is a
        // native session id, so nothing published under this (principal, thread) pair before this
        // log existed, and a same-session connector restart finds the log on disk and never
        // consults the flag. The case it would be wrong for, a session that published and then
        // lost its log, does not fail silently: the first frame goes out expecting sequence 0 on a
        // subject that already has one, the broker refuses it, and the emitter halts.
        const wal = await EventWal.open(walPath, { space: config.space, threadId, principal, subjectMayExist: false });

        mapper = createClaudeMapper({ threadId, mintRunId: () => randomUUID() });
        return AguiEmitter.start<ClaudeEntry>({
          endpoint: agent.ep,
          wal,
          subjectFrontier,
          source: new JsonlFileSource<ClaudeEntry>(transcriptPath),
          map: mapper.map,
        });
      },
      // Required, and not defaulted to a swallow: this runs behind a hook that must not throw, so
      // a failure reaches a human only if it is written somewhere. The holder is terminal on
      // error, it does not retry, so this line is the whole record of why events stopped.
      (e: Error) => process.stderr.write(`[cotal-connector] AG-UI emitter stopped: ${e.message}\n`),
      // The turn terminal closes a run the record stream never described, so the mapper still
      // believes that run is open. Without this it would attribute the next records to a run the
      // published stream has already finished and the emitter would refuse the batch. Keyed on the
      // id, so a newer run opened in between is left alone.
      (runId: string) => mapper?.forgetOpenRun(runId),
    );
  }

  // Local control plane for the lifecycle hooks (presence + message injection) and the manager's
  // cooperative shutdown. The SOCKET PATH comes from the launch env; the first-frame TOKEN comes
  // from the launch-material file that env points at, which is also where the hooks read it. A
  // managed session without both is misconfigured, so fail loud rather than serve an
  // unauthenticated (or no) control plane.
  const control = controlFromEnv();
  if (!control) {
    process.stderr.write(
      "[cotal-connector] managed session missing its control socket path or its control token - cannot serve the control plane\n",
    );
    process.exit(1);
  }
  const controlPath = control.path;
  const controlToken = control.token;
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
