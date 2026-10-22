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
import type { Readable, Writable } from "node:stream";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  configFromEnv,
  envFlag,
  eventPlaneArmed,
  hasIdentity,
  MeshAgent,
  startControlServer,
  registerCotalTools,
  feedbackLine,
  ORIENTATION_BOOTSTRAP,
  MESH_FIRST_STEER,
  WORKFLOW_STEER,
  CHANNEL_GUIDANCE,
  type AguiEmitterHolder,
  controlFromEnv,
  GATEWAY_CONNECTING,
  GATEWAY_INSTRUCTIONS,
  GATEWAY_LISTENING,
  NATIVE_GATEWAY_TOOLS,
  serveGatewayStdio,
  DOCS_VERSION,
} from "@cotal-ai/connector-core";
import { homedir } from "node:os";
import { dirname, parse } from "node:path";
import { createClaudeHandle, createWakePolicy, type WakePolicy } from "./hooks.js";
import type { ClaudeEntry } from "./agui-map.js";
import { createClaudeEventPlane } from "./claude-events.js";
import { createAppHost } from "./app-host.js";
import { readCliRecord } from "./cli-record.js";
import { openWakeFeed } from "./wake-feed.js";

/** What a plain session's local server tells the model ahead of the gateway's own steps. */
const LOCAL =
  "This is the Cotal server on this computer. It joins the person's local Cotal mesh. If a hosted " +
  "Cotal connector is also available, use this one unless the person asks for the hosted one: a " +
  "conversation uses one Cotal path. ";

/** How a Claude Code conversation hears messages through its native hooks module. */
const CODE_LISTENING =
  "This plugin's native hooks module submits a Cotal-attributed notification when a message arrives: " +
  'it begins with "Cotal:" and names the connection_id, and you read the message with cotal_inbox. ' +
  "cotal_connect reports whether its incoming-message reader is connected. Where it is not: " +
  GATEWAY_LISTENING;


/** A plain session, one the launcher did not start: a Claude Code session, or Claude Desktop through
 *  its extension (`--desktop`). It serves the gateway surface over stdio with a local host, so a
 *  conversation joins the local mesh only when it calls `cotal_connect`, as an identity of its own.
 *  Nothing reaches a broker before that. */
async function serveLocal(desktop: boolean): Promise<void> {
  const host = createAppHost({
    cotal: () => readCliRecord(dirname(process.argv[1] ?? "")),
    // Claude Desktop's working directory is not the person's project, so the mesh is found from a
    // directory that is no project: the `cotal use` mesh, else the only one running.
    cwd: desktop ? parse(homedir()).root : process.cwd(),
    env: process.env,
  });
  // Desktop Chat runs no native hooks module. In Code, the server and native wake reader are
  // children of the same host process, which names their private feed.
  const feed = desktop ? undefined : await openWakeFeed(process.ppid);
  feed?.onNative((event) => host.nativeEvent(event));
  const served = await serveGatewayStdio(host, {
    source: "claude-local",
    connectContext: !desktop,
    // A signed-in Code conversation asks for its own grant and calls with it; see the host. Its
    // native module delivers an adopted persona's instructions, which Desktop has no module for.
    ...(desktop ? {} : { tools: NATIVE_GATEWAY_TOOLS, selection: true, persona: true }),
    ...(feed
      ? {
          instructions: `${LOCAL}${GATEWAY_CONNECTING} ${CODE_LISTENING}`,
          wake: {
            signal: (c, preview) => feed.send(c.id, preview, host.sessionFor(c.id)),
            attach: (rewake) => feed.onReader(rewake),
            listening: () =>
              feed.watched()
                ? "The Cotal incoming-message reader is connected. New messages can start a turn, subject to Claude's Stop and organization policies."
                : "Automatic incoming messages are unavailable in this session. Check that the Cotal plugin and its native hooks module are enabled; call cotal_wait to listen.",
          },
        }
      : { instructions: `${LOCAL}${GATEWAY_INSTRUCTIONS}` }),
  });
  let ending: Promise<void> | undefined;
  const end = () =>
    (ending ??= host
      .closeAll()
      .then(() => served.close())
      .finally(() => {
        feed?.close();
        process.exit(0);
      }));
  process.stdin.on("end", end);
  process.on("SIGINT", end);
  process.on("SIGTERM", end);
}

async function main(): Promise<void> {
  // No identity → this is a plain `claude`, not a launcher-spawned agent. It stays
  // off the mesh until the conversation calls `cotal_connect`, so an installed
  // plugin can't make the operator's own sessions join as stray peers.
  if (!hasIdentity()) {
    process.stderr.write("[cotal-connector] no COTAL_NAME — not a managed session; serving cotal_connect for this computer's meshes\n");
    await serveLocal(process.argv.includes("--desktop"));
    return;
  }
  const session = await serveClaudeSession({
    env: process.env,
    input: process.stdin,
    output: process.stdout,
    fatalBind: true,
    onShutdown: (code) => process.exit(code),
  });
  const stop = () => void session.close().finally(() => process.exit(0));
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}

/** One managed session: its launch env (read only from here) and its MCP stream pair. */
export interface ClaudeSessionOptions {
  env: NodeJS.ProcessEnv;
  input: Readable;
  output: Writable;
  /** Exit the process when the control socket cannot be bound. A host serving several sessions
   *  leaves it off, and the call rejects instead. */
  fatalBind?: boolean;
  /** A shutdown frame or the end or closure of `input` ended the session. Called once after teardown;
   *  `code` is 1 if teardown failed, or the requested exit code otherwise. */
  onShutdown?: (code: number) => void;
}

export interface ClaudeSession {
  name: string;
  /** Leave the mesh and stop serving. Idempotent; may reject if teardown fails.
   *  The streams stay open; the caller owns them. */
  close(): Promise<void>;
}

/** Serve one managed Claude Code session over `input`/`output`. Every per-session object lives in
 *  the call, so one process can serve several sessions. A startup failure closes what was started
 *  before the call rejects. */
export async function serveClaudeSession(opts: ClaudeSessionOptions): Promise<ClaudeSession> {
  let close: (() => Promise<void>) | undefined;
  try {
    return await startSession(opts, (c) => (close = c));
  } catch (e) {
    await close?.();
    throw e;
  }
}

async function startSession(
  opts: ClaudeSessionOptions,
  setClose: (close: () => Promise<void>) => void,
): Promise<ClaudeSession> {
  const env = { ...opts.env };
  if (opts.input.readableEnded || opts.input.destroyed)
    throw new Error("hosted MCP input is already ended or destroyed");
  /** Publishes this session's activity as AG-UI events on `events.<owner>.<actor>` — set below
   *  when launch policy arms it. Personal native connections use the same recorder through the
   *  app host, with a boundary captured when that conversation connects. */
  let events: AguiEmitterHolder<ClaudeEntry> | undefined;

  /** The `claude/channel` push side — set below once the MCP server exists. */
  let wake: WakePolicy | undefined;

  /** Claude Code lifecycle events → presence + (on inject-capable events) queued peer messages.
   *  Read `events` and `wake` lazily: they are assigned after this handler is built. `onReply` is
   *  the commit half — an injected batch is acked only once its reply is confirmed delivered. */
  const claude = createClaudeHandle({ env, events: () => events, surfaced: (items) => wake?.surfaced(items) });

  const config = configFromEnv(env);
  config.connector = "claude"; // advertise the host harness on our AgentCard (meta.connector)
  // Parsed here, not in the handshake handler that applies it: the SDK routes a throw from that
  // handler to its error hook and the session would run on with the flag unread.
  const channelFlag = envFlag(env, "COTAL_CHANNEL");
  // One process may host several sessions, so its own directory is not a session's: the card's
  // directory comes from that session's SessionStart hook instead.
  const agent = new MeshAgent(config, env, { withholdProcessCwd: true });
  const plane = eventPlaneArmed(config, env) ? createClaudeEventPlane(agent, config, env) : undefined;
  events = plane?.events;

  // Local control plane for the lifecycle hooks (presence + message injection) and the manager's
  // cooperative shutdown. The SOCKET PATH comes from the launch env; the first-frame TOKEN comes
  // from the launch-material file that env points at, which is also where the hooks read it, or from
  // COTAL_CONTROL_TOKEN in a session driven by hand. The hooks are what advance presence and inject
  // peer messages, so a session without the pair is refused, naming it, rather than served with an
  // unauthenticated (or no) control plane.
  const control = controlFromEnv(env);
  if (!control) {
    throw new Error(
      "no control endpoint for the lifecycle hooks: set COTAL_CONTROL_SOCKET to a socket path and COTAL_CONTROL_TOKEN to a random secret",
    );
  }
  const controlPath = control.path;
  const controlToken = control.token;
  // Defined before the server so it can be the cooperative-shutdown handler; only ever CALLED after
  // `controlServer` is assigned (on a signal or an authed `{op:"shutdown"}`), so the forward ref is safe.
  // `wake` is likewise assigned later, so a shutdown frame arriving before the MCP server exists
  // reads `undefined`.
  let controlServer: ReturnType<typeof startControlServer> | undefined;
  let mcp: McpServer | undefined;
  let stopping: Promise<void> | undefined;
  let shuttingDown = false;
  const onInputClose = () => shutdown();
  const close = (): Promise<void> =>
    (stopping ??= (async () => {
      opts.input.off("end", onInputClose);
      opts.input.off("close", onInputClose);
      plane?.stop();
      try {
        controlServer?.close();
      } catch {
        /* ignore */
      }
      wake?.stop();
      try {
        await events?.close();
        await agent.stop();
      } finally {
        await mcp?.close().catch(() => {});
      }
    })());
  const shutdown = (code = 0): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    void close().then(
      () => opts.onShutdown?.(code),
      (e) => {
        process.stderr.write(`[cotal-connector] session shutdown failed: ${String(e)}\n`);
        opts.onShutdown?.(1);
      },
    );
  };
  setClose(close);
  controlServer = startControlServer(
    agent,
    { path: controlPath, token: controlToken },
    claude.handle,
    { fatalBind: opts.fatalBind ?? false, onShutdown: () => void shutdown(), onReply: claude.onReply },
  );
  await new Promise<void>((resolve, reject) => {
    controlServer!.once("listening", resolve);
    controlServer!.once("error", reject);
  });
  if (opts.input.readableEnded || opts.input.destroyed)
    throw new Error("hosted MCP input ended before startup completed");
  agent.start(); // custody is claimed before background broker connect, after control bind

  const server = new McpServer(
    // The Cotal release this process loaded, the same value cotal_orientation reports.
    { name: "cotal", version: DOCS_VERSION },
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
        `${WORKFLOW_STEER} ` +
        `${CHANNEL_GUIDANCE} ` +
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

  mcp = server;
  registerCotalTools(server, agent, config, "claude-code", env);

  // The wake policy owns every `claude/channel` push (arriving messages + the Stop→idle flush).
  // It stays inert until the handshake below confirms the client speaks claude/channel.
  wake = createWakePolicy(
    agent,
    (params) => server.server.notification({ method: "notifications/claude/channel", params }),
    (msg) => process.stderr.write(`[cotal-connector] ${msg}\n`),
  );

  // A client ends a stdio session by closing our stdin, and so does a harness that dies. The mesh
  // connection would keep this process alive past it, heartbeating a presence no session backs,
  // which every peer's roster reads as a live agent (#544).
  opts.input.once("end", onInputClose);
  opts.input.once("close", onInputClose);

  // Is this session consuming us as a channel? Decided once the client finishes the handshake,
  // after its `initialize` has carried its capabilities: `connect()` resolves as soon as stdio is
  // attached, before any client message has been read. The handlers registered above no-op until then.
  server.server.oninitialized = () => {
    const clientCaps = server.server.getClientCapabilities();
    const channelActive =
      channelFlag ?? Boolean((clientCaps?.experimental as Record<string, unknown> | undefined)?.["claude/channel"]);
    wake?.setChannelActive(channelActive);
    process.stderr.write(
      `[cotal-connector] client capabilities: ${JSON.stringify(clientCaps ?? {})} → channel ${channelActive ? "ACTIVE" : "off"}\n`,
    );
  };

  const transport = new StdioServerTransport(opts.input, opts.output);
  await server.connect(transport);

  process.stderr.write(
    `[cotal-connector] MCP ready (stdio) — space="${config.space}" name="${config.name}"${config.role ? ` role="${config.role}"` : ""}\n`,
  );
  return { name: config.name, close };
}

// The bundle is CommonJS: required by a host it only exports. Run from source (`tsx src/mcp.ts`)
// it is an ES module, where `require` is undefined, and serves as before.
if (typeof require === "undefined" || require.main === module) {
  main().catch((e) => {
    process.stderr.write(`[cotal-connector] fatal: ${(e as Error).stack ?? String(e)}\n`);
    process.exit(1);
  });
}
