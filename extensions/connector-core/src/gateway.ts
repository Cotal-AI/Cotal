/**
 * The Cotal tool surface for a REMOTE MCP server: one server, many conversations.
 *
 * A stdio connector is one process per session, so its tools reach the mesh through the one
 * {@link MeshAgent} that process owns. A remote server has no such anchor. A hosted MCP client such
 * as Claude pools one OAuth bearer and one MCP transport session across every conversation of an
 * account, so nothing on a request says which conversation sent it. Each conversation therefore
 * opens its own connection with `cotal_connect` and names it on every later call. A missing or
 * foreign handle refuses and runs nothing. No call falls back to the account's last, only or most
 * recent connection, because that would put one conversation's words under another's identity.
 *
 * The embedder owns everything account-shaped through {@link GatewayHost}: authentication,
 * credential issuance and revocation, and durable records. This module owns the surface, the name
 * rule and, through {@link handleGatewayRequest}, the MCP server itself, so an embedder never needs
 * an MCP SDK of its own.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Readable, Writable } from "node:stream";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import type { ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { assertValidName } from "@cotal-ai/core";
import { DOCS_VERSION } from "./docs.js";
import { cotalToolSpecs, parseToolArgs, type CotalToolSpec, type ToolResult } from "./tool-specs.js";
import type { MeshAgent } from "./agent.js";
import type { AgentConfig } from "./config.js";
import { renderInboxPreview, type RenderedInboxPreview } from "./framing.js";

/** Thrown by {@link GatewayHost.open} when, and only when, the issuer reports that the name already
 *  exists. It is the one failure that moves `cotal_connect` to the next candidate name. An auth,
 *  quota, permission or network failure must be any other error, so it reaches the caller instead
 *  of being retried under a different name. */
export class NameTaken extends Error {
  constructor(readonly taken: string) {
    super(`name ${JSON.stringify(taken)} is taken`);
    this.name = "NameTaken";
  }
}

/** One live connection: a mesh identity serving one conversation. */
export interface GatewayConnection {
  readonly id: string;
  readonly agent: MeshAgent;
  readonly config: AgentConfig;
}

/** What the embedding service supplies. Every method receives the authenticated account, never a
 *  value a tool argument chose. */
export interface GatewayHost {
  /** The account the request authenticated as. Throw when the request carries no valid
   *  authentication; the tool then runs nothing. */
  account(auth: AuthInfo | undefined): string;
  /** Open a fresh connection for `account` named exactly `name`. Throw {@link NameTaken} only for
   *  an authoritative name collision. The collision check and the issue must be one atomic step per
   *  account: an `open` racing another for the same name throws `NameTaken` rather than also
   *  succeeding, or two conversations end up sharing one name. Error messages reach the caller,
   *  so they must not carry secrets. */
  open(account: string, name: string, context?: string): Promise<GatewayConnection>;
  /** The connection `id` if `account` owns it, otherwise undefined. Never a default. */
  find(account: string, id: string): Promise<GatewayConnection | undefined>;
  /** Stop and release one connection `account` owns. False when it owns no such connection. */
  close(account: string, id: string): Promise<boolean>;
}

/** The mesh tools a remote conversation may call. Process and seat authority (spawn, despawn,
 *  persona, run, yield, reconnect) belongs to a supervised local seat and is not offered here. */
export const GATEWAY_TOOLS: ReadonlySet<string> = new Set([
  "cotal_orientation",
  "cotal_connection_status",
  "cotal_roster",
  "cotal_inbox",
  "cotal_send",
  "cotal_dm",
  "cotal_anycast",
  "cotal_status",
  "cotal_channel_info",
  "cotal_channels",
  "cotal_channel_mode",
  "cotal_join",
  "cotal_leave",
]);

const READ_ONLY = { readOnlyHint: true, destructiveHint: false };
const ADDITIVE = { readOnlyHint: false, destructiveHint: false };
const UPDATING = { readOnlyHint: false, destructiveHint: true };

// Inbox and wait consume messages. Status can change attention, and disconnect, leave and channel
// mode can remove a connection or subscription. None of those are read-only queries.
const GATEWAY_ANNOTATIONS: Readonly<Record<string, ToolAnnotations>> = {
  cotal_connect: ADDITIVE,
  cotal_disconnect: UPDATING,
  cotal_wait: UPDATING,
  cotal_orientation: READ_ONLY,
  cotal_connection_status: READ_ONLY,
  cotal_roster: READ_ONLY,
  cotal_inbox: UPDATING,
  cotal_send: ADDITIVE,
  cotal_dm: ADDITIVE,
  cotal_anycast: ADDITIVE,
  cotal_status: UPDATING,
  cotal_channel_info: READ_ONLY,
  cotal_channels: READ_ONLY,
  cotal_channel_mode: UPDATING,
  cotal_join: ADDITIVE,
  cotal_leave: UPDATING,
};

function gatewayAnnotations(name: string): ToolAnnotations {
  const annotations = GATEWAY_ANNOTATIONS[name];
  if (!annotations) throw new Error(`Missing gateway tool annotations for ${name}`);
  return annotations;
}

/** How many names `cotal_connect` tries: the requested one, then `_2` up to this suffix. */
export const GATEWAY_NAME_ATTEMPTS = 20;

/** The longest `cotal_wait` holds one call when the embedder sets no bound, in seconds. A held call
 *  has to end before anything in front of the gateway does. The reply is one JSON body, so its first
 *  byte goes out when the wait ends: Claude Code gives a remote server 60 seconds to that byte,
 *  Cloudflare ends an origin response after about 100, and claude.ai ends a tool call after 240. */
export const GATEWAY_WAIT_SECONDS = 50;

/** How an embedder tunes the surface for what sits in front of it. */
export interface GatewayOptions {
  /** A native embedder binds the connect call to a host-observed conversation. The value is only
   * a routing key, never authentication; the host must validate its own binding before issue. */
  connectContext?: boolean;
  /** The longest `cotal_wait` may hold one call, in whole seconds. Defaults to
   *  {@link GATEWAY_WAIT_SECONDS}. Keep it under every proxy and client timeout on the path. */
  waitSeconds?: number;
  /** A way to wake the client other than a held `cotal_wait`, for an embedder whose client can be
   *  woken. Without it a conversation hears messages only when it calls a tool. */
  wake?: GatewayWake;
}

/** How an embedder wakes its client when a connection has something to read. */
export interface GatewayWake {
  /** Called when a connection gets something that ends a `cotal_wait` while none holds it, and
   *  not again for that connection until a `cotal_inbox` or `cotal_wait` reads its messages.
   *  Return false when no client heard it, so the next rewake signals it again. */
  signal(connection: GatewayConnection, preview: RenderedInboxPreview): boolean;
  /** What `cotal_connect` adds about listening, read when the connection opens: whether this
   *  client will be woken. */
  listening(): string;
  /** Called once with the rewake: call it when a client starts listening, and every connection
   *  with something to read that no client heard about is signalled. */
  attach?(rewake: () => void): void;
}

/** The names `cotal_connect` tries for `base`, in order. */
export function gatewayNames(base: string, attempts = GATEWAY_NAME_ATTEMPTS): string[] {
  return [base, ...Array.from({ length: attempts - 1 }, (_, i) => `${base}_${i + 2}`)];
}

const CONNECTION_REQUIRED =
  "CONNECTION_REQUIRED: no connection with that connection_id belongs to this account. Call cotal_connect " +
  "for this conversation and pass the connection_id it returns. Nothing was done.";

/** One tool list serves every connection, so the advertised shapes come from a configuration with
 *  no identity and no channels. Each call still runs against its connection's own configuration. */
const ADVERTISED: AgentConfig = {
  space: "",
  name: "",
  servers: "",
  subscribe: [],
  allowSubscribe: [],
  allowPublish: [],
  kind: "agent",
  tls: false,
};

/** `cotal_send`'s channel description is the one advertised text that names a configuration's
 *  default channel. Connections can read different channels, so the advertised text names none. */
const SEND_CHANNEL =
  "Channel to send on. Omit it to use this connection's default, the first concrete channel it reads and " +
  "may post to (cotal_orientation lists both); with none, an omitted channel is refused. Concrete only, not " +
  "a wildcard like team.>; reply on the channel you received a message on.";

const CONNECTION_ID = z
  .string()
  .min(1)
  .describe("The connection_id cotal_connect returned in THIS conversation. Never reuse another conversation's.");

function toContent(r: ToolResult) {
  const content = [{ type: "text" as const, text: r.text }];
  return r.isError ? { content, isError: true as const } : { content };
}

const refuse = (text: string) => toContent({ text, isError: true });

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** Focus @mentions per agent since a gateway read last cleared them. In `focus` an @mention is
 *  acked at ingest and recalled by the next `cotal_inbox`, so nothing buffered marks it, and one
 *  that arrives between two waits would otherwise end neither. */
const focusMentions = new WeakMap<MeshAgent, { count: number }>();

/** `agent`'s focus @mention count, counted from the first time the gateway asks. Attention reaches
 *  `focus` only through a gateway call, and every call asks, so the count starts in time. */
function mentionsOf(agent: MeshAgent): { count: number } {
  let mentions = focusMentions.get(agent);
  if (!mentions) {
    const m = { count: 0 };
    agent.on("mention-wake", () => (m.count += 1));
    focusMentions.set(agent, (mentions = m));
  }
  return mentions;
}

/** What should wake a gateway connection: {@link MeshAgent.inboxWake}, the rule a local seat's push
 *  follows (direct messages, role requests and @mentions always, other channel traffic only in
 *  `open`), plus the focus @mentions it has not read. */
function wakeCount(agent: MeshAgent): number {
  return agent.inboxWake() + mentionsOf(agent).count;
}

/**
 * Resolve true once `agent` has something that should wake it, or false after `ms`, on abort, or
 * when the agent stops.
 *
 * The SDK aborts `signal` when the request's connection closes, so a wait its client gave up on
 * stops listening instead of taking the next message to a closed socket. The signal belongs to that
 * one request, so its listener ends with the request and needs no removal. The handler awaits the
 * host first, so the signal can already be aborted and the agent already stopped here, and neither
 * then fires an event.
 */
function waitForWake(agent: MeshAgent, ms: number, signal: AbortSignal): Promise<boolean> {
  if (signal.aborted || agent.stopping) return Promise.resolve(false);
  if (wakeCount(agent) > 0) return Promise.resolve(true);
  return new Promise((resolve) => {
    const check = () => {
      if (wakeCount(agent) > 0) finish(true);
    };
    const mentioned = () => finish(true);
    const stopped = () => finish(false);
    const abort = () => finish(false);
    const timer = setTimeout(() => finish(false), ms);
    function finish(woke: boolean) {
      clearTimeout(timer);
      agent.off("incoming", check);
      agent.off("mention-wake", mentioned);
      agent.off("stopping", stopped);
      resolve(woke);
    }
    agent.on("incoming", check);
    agent.on("mention-wake", mentioned);
    agent.on("stopping", stopped);
    signal.addEventListener("abort", abort, { once: true });
  });
}

/** Run `spec` for a connection with the request's signal, so a read whose client is gone clears
 *  nothing. A `cotal_inbox` read that clears also clears the focus @mention count, since its recall
 *  carries them. */
async function runFor(spec: CotalToolSpec, c: GatewayConnection, args: Record<string, unknown>, signal: AbortSignal): Promise<ToolResult> {
  const result = await spec.run(c.agent, c.config, parseToolArgs(spec, args), { signal });
  if (spec.name === "cotal_inbox" && !args.peek && !signal.aborted) mentionsOf(c.agent).count = 0;
  return result;
}

/** The line every routed tool except `cotal_inbox` adds when messages are waiting, so a
 *  conversation that never polls still learns of them on its next call. */
function waitingNotice(agent: MeshAgent): { type: "text"; text: string } | undefined {
  const n = wakeCount(agent);
  if (!n) return undefined;
  return { type: "text", text: `${n} new message${n === 1 ? "" : "s"} waiting. Read ${n === 1 ? "it" : "them"} with cotal_inbox.` };
}

/**
 * Register the remote surface on `server`: `cotal_connect`, `cotal_disconnect`, `cotal_wait`, and
 * each tool in {@link GATEWAY_TOOLS} with a required `connection_id`.
 *
 * Each call is parsed and run against the spec built from that connection's own configuration, so a
 * connection's channels and grants decide what the call does.
 *
 * A remote MCP client gives the server no way to start a turn, so a conversation hears a message
 * only when it calls a tool. `cotal_wait` is the call that listens: it holds until a message
 * arrives and then returns it, and every other routed tool says when messages are waiting.
 */
export function registerCotalGatewayTools(
  server: McpServer,
  host: GatewayHost,
  source = "gateway",
  options: GatewayOptions = {},
): void {
  const waitSeconds = options.waitSeconds ?? GATEWAY_WAIT_SECONDS;
  if (!Number.isInteger(waitSeconds) || waitSeconds < 1) {
    throw new Error(`waitSeconds must be a whole number of seconds, at least 1; got ${waitSeconds}`);
  }
  const wake = options.wake;
  // Connections signalled and not read since, how many cotal_wait calls hold each one, and the
  // check for each watched connection, which the rewake runs again.
  const signalled = new WeakSet<MeshAgent>();
  const holding = new WeakMap<MeshAgent, number>();
  const watched = new Set<() => void>();
  wake?.attach?.(() => {
    for (const fire of watched) fire();
  });
  const watch = (c: GatewayConnection) => {
    if (!wake) return;
    // Counted before `fire` runs, so a focus @mention is in the count `fire` reads.
    mentionsOf(c.agent);
    const fire = () => {
      if (c.agent.stopping || signalled.has(c.agent) || (holding.get(c.agent) ?? 0) > 0 || wakeCount(c.agent) === 0) return;
      if (wake.signal(c, renderInboxPreview(c.agent.inboxSnapshot()))) signalled.add(c.agent);
    };
    const replay = () => {
      // A previous reader may have exited before its client started a turn.
      signalled.delete(c.agent);
      fire();
    };
    watched.add(replay);
    c.agent.on("incoming", fire);
    c.agent.on("mention-wake", fire);
    c.agent.once("stopping", () => {
      watched.delete(replay);
      c.agent.off("incoming", fire);
      c.agent.off("mention-wake", fire);
    });
  };

  server.registerTool(
    "cotal_connect",
    {
      title: "Cotal: connect this conversation",
      annotations: gatewayAnnotations("cotal_connect"),
      description:
        "Join the Cotal mesh as a new agent for THIS conversation and return its connection_id. Call it once per " +
        "conversation, keep the connection_id, and pass it on every other cotal_* call. If the name is taken, the " +
        "next free name is chosen (name_2, name_3, ...) and reported. Never reuse a connection_id from another " +
        "conversation, and call this again if you no longer have this conversation's connection_id.",
      inputSchema: z.strictObject({
        name: z.string().min(1).describe("The agent name to request, for example claude_web."),
        ...(options.connectContext ? { context: z.string().min(1).max(128).optional().describe("Conversation binding supplied by the native host.") } : {}),
      }),
    },
    async ({ name, ...input }, extra) => {
      let account: string;
      try {
        account = host.account(extra.authInfo);
      } catch (e) {
        return refuse(`not authenticated: ${errorText(e)}`);
      }
      for (const candidate of gatewayNames(name)) {
        // A name the mesh would refuse is the caller's to fix, not a collision to rename around.
        try {
          assertValidName(candidate);
        } catch (e) {
          return refuse(`cotal_connect: ${errorText(e)}`);
        }
        try {
          const c = await host.open(account, candidate, "context" in input && typeof input.context === "string" ? input.context : undefined);
          watch(c);
          const renamed = candidate === name ? "" : ` (${JSON.stringify(name)} was taken)`;
          const listening = wake ? `\n${wake.listening()}` : "";
          return toContent({
            text: `Connected as ${c.config.name}${renamed}.\nconnection_id: ${c.id}\nPass this connection_id on every cotal_* call in this conversation.${listening}`,
          });
        } catch (e) {
          if (e instanceof NameTaken) continue;
          return refuse(`cotal_connect failed for ${JSON.stringify(candidate)}: ${errorText(e)}`);
        }
      }
      return refuse(`cotal_connect: ${JSON.stringify(name)} and its next ${GATEWAY_NAME_ATTEMPTS - 1} variants are all taken. Choose another name.`);
    },
  );

  server.registerTool(
    "cotal_disconnect",
    {
      title: "Cotal: disconnect this conversation",
      annotations: gatewayAnnotations("cotal_disconnect"),
      description: "Leave the mesh for this conversation's connection. Other conversations stay connected.",
      inputSchema: z.strictObject({ connection_id: CONNECTION_ID }),
    },
    async ({ connection_id }, extra) => {
      let account: string;
      try {
        account = host.account(extra.authInfo);
      } catch (e) {
        return refuse(`not authenticated: ${errorText(e)}`);
      }
      return (await host.close(account, connection_id))
        ? toContent({ text: `Disconnected ${connection_id}.` })
        : refuse(CONNECTION_REQUIRED);
    },
  );

  server.registerTool(
    "cotal_wait",
    {
      title: "Cotal: wait for a message",
      annotations: gatewayAnnotations("cotal_wait"),
      description:
        `Wait for a message to this connection, and return it as cotal_inbox would. It returns at once when one is ` +
        `already waiting, and otherwise as soon as one arrives, or after at most ${waitSeconds} seconds with none. ` +
        "Call it again to keep listening. Direct messages, role requests and @mentions always end the wait; other " +
        "channel traffic ends it only in open attention (cotal_status sets attention).",
      inputSchema: z.strictObject({
        connection_id: CONNECTION_ID,
        seconds: z
          .number()
          .int()
          .min(1)
          .max(waitSeconds)
          .optional()
          .describe(`The longest to wait, in seconds. Defaults to ${waitSeconds}, the most allowed.`),
      }),
    },
    async ({ connection_id, seconds }, extra) => {
      let account: string;
      try {
        account = host.account(extra.authInfo);
      } catch (e) {
        return refuse(`not authenticated: ${errorText(e)}`);
      }
      const c = await host.find(account, connection_id);
      if (!c) return refuse(CONNECTION_REQUIRED);
      const inbox = cotalToolSpecs(c.config, source, undefined, GATEWAY_TOOLS).find((s) => s.name === "cotal_inbox");
      if (!inbox) return refuse("cotal_wait is not available on this connection.");
      const limit = seconds ?? waitSeconds;
      holding.set(c.agent, (holding.get(c.agent) ?? 0) + 1);
      let woke: boolean;
      try {
        woke = await waitForWake(c.agent, limit * 1000, extra.signal);
      } finally {
        holding.set(c.agent, (holding.get(c.agent) ?? 1) - 1);
      }
      if (c.agent.stopping) return refuse(CONNECTION_REQUIRED);
      if (!woke) {
        return toContent({ text: `No new messages in ${limit} second${limit === 1 ? "" : "s"}. Call cotal_wait again to keep listening.` });
      }
      signalled.delete(c.agent);
      try {
        return toContent(await runFor(inbox, c, {}, extra.signal));
      } catch (e) {
        return refuse(errorText(e));
      }
    },
  );

  for (const spec of cotalToolSpecs(ADVERTISED, source, undefined, GATEWAY_TOOLS)) {
    const channel = spec.name === "cotal_send" ? (spec.schema.shape.channel as z.ZodType | undefined) : undefined;
    const shape = channel ? spec.schema.extend({ channel: channel.describe(SEND_CHANNEL) }) : spec.schema;
    server.registerTool(
      spec.name,
      {
        title: spec.title,
        annotations: gatewayAnnotations(spec.name),
        description: `${spec.description} Requires this conversation's connection_id from cotal_connect.`,
        inputSchema: shape.extend({ connection_id: CONNECTION_ID }),
      },
      async (args: Record<string, unknown>, extra) => {
        const { connection_id, ...rest } = args as { connection_id: string } & Record<string, unknown>;
        let account: string;
        try {
          account = host.account(extra.authInfo);
        } catch (e) {
          return refuse(`not authenticated: ${errorText(e)}`);
        }
        const c = await host.find(account, connection_id);
        if (!c) return refuse(CONNECTION_REQUIRED);
        const own = cotalToolSpecs(c.config, source, undefined, GATEWAY_TOOLS).find((s) => s.name === spec.name);
        // Unreachable while GATEWAY_TOOLS holds no capability-gated tool; a future one refuses here.
        if (!own) return refuse(`${spec.name} is not available on this connection.`);
        let result: ReturnType<typeof toContent>;
        if (spec.name === "cotal_inbox") signalled.delete(c.agent);
        try {
          result = toContent(await runFor(own, c, rest, extra.signal));
        } catch (e) {
          result = refuse(errorText(e));
        }
        // cotal_inbox already says what it left buffered.
        const notice = spec.name === "cotal_inbox" ? undefined : waitingNotice(c.agent);
        return notice ? { ...result, content: [...result.content, notice] } : result;
      },
    );
  }
}

/** How a conversation hears messages when nothing can wake it: the last part of
 *  {@link GATEWAY_INSTRUCTIONS}. */
export const GATEWAY_LISTENING =
  "Messages reach you only when you call a tool: to listen, call cotal_wait, which returns as soon as a " +
  "message arrives. When the person asks you to stay on Cotal or keep listening, call cotal_wait again each " +
  "time it returns and handle each message as it arrives, until they ask you to stop.";

/** How a conversation joins and names its connection: the first part of {@link GATEWAY_INSTRUCTIONS}. */
export const GATEWAY_CONNECTING =
  "Cotal connects this conversation to the person's Cotal space. Call cotal_connect once with a short name " +
  "for this conversation, then pass the returned connection_id on every other cotal tool call. Each " +
  "conversation needs its own connection. Never reuse another conversation's connection_id.";

/** The server instructions {@link handleGatewayRequest} sends when the embedder gives none. */
export const GATEWAY_INSTRUCTIONS = `${GATEWAY_CONNECTING} ${GATEWAY_LISTENING}`;

/** One HTTP request to a gateway endpoint. */
export interface GatewayRequest {
  req: IncomingMessage;
  res: ServerResponse;
  /** The parsed JSON body, for a framework that already read the request stream. Omit it and the
   *  body is read from `req`. */
  body?: unknown;
  /** What the embedder authenticated this request as, handed to {@link GatewayHost.account}.
   *  Without it every tool refuses and runs nothing. */
  auth?: AuthInfo;
  /** The source tag on messages this endpoint sends. */
  source?: string;
  instructions?: string;
  /** See {@link GatewayOptions.connectContext}. */
  connectContext?: boolean;
  /** See {@link GatewayOptions.waitSeconds}. */
  waitSeconds?: number;
}

/**
 * Serve one HTTP request to a gateway endpoint with this package's own MCP server and Streamable
 * HTTP transport. The embedder authenticates and routes. It never builds an MCP server, so its own
 * SDK or zod version cannot disagree with the one these tools were written against.
 *
 * The endpoint is stateless. Each POST gets a fresh server and transport and a JSON response, so
 * nothing survives between requests except what the host stores. There is no server-initiated
 * stream and no session to end, so every other method answers 405, as the Streamable HTTP
 * transport allows. A `cotal_wait` call holds its POST open for up to `waitSeconds`.
 */
export async function handleGatewayRequest(host: GatewayHost, r: GatewayRequest): Promise<void> {
  if (r.req.method !== "POST") {
    r.res
      .writeHead(405, { allow: "POST", "content-type": "application/json" })
      .end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed." }, id: null }));
    return;
  }
  const server = new McpServer({ name: "cotal", version: DOCS_VERSION }, { instructions: r.instructions ?? GATEWAY_INSTRUCTIONS });
  registerCotalGatewayTools(server, host, r.source, r.waitSeconds === undefined ? {} : { waitSeconds: r.waitSeconds });
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  r.res.on("close", () => {
    void transport.close();
    void server.close();
  });
  // The transport hands `req.auth` to each tool as `extra.authInfo`.
  (r.req as IncomingMessage & { auth?: AuthInfo }).auth = r.auth;
  await server.connect(transport);
  await transport.handleRequest(r.req, r.res, r.body);
}

/** One local client that launches the gateway as a process and speaks MCP over its pipes. */
export interface GatewayStdio {
  /** Defaults to `process.stdin`. */
  input?: Readable;
  /** Defaults to `process.stdout`, so every diagnostic must go to stderr. */
  output?: Writable;
  /** The source tag on messages this server sends. */
  source?: string;
  instructions?: string;
  /** See {@link GatewayOptions.connectContext}. */
  connectContext?: boolean;
  /** See {@link GatewayOptions.waitSeconds}. */
  waitSeconds?: number;
  /** See {@link GatewayOptions.wake}. */
  wake?: GatewayWake;
}

/**
 * Serve the gateway surface over stdio with this package's own MCP server, for a client such as
 * Claude Desktop that runs one local process for every conversation. A stdio request carries no
 * authentication, so `host.account` receives `undefined` and names the local user. A client that
 * cancels a call aborts its signal, as a closed HTTP request does.
 */
export async function serveGatewayStdio(host: GatewayHost, o: GatewayStdio = {}): Promise<{ close(): Promise<void> }> {
  const server = new McpServer({ name: "cotal", version: DOCS_VERSION }, { instructions: o.instructions ?? GATEWAY_INSTRUCTIONS });
  registerCotalGatewayTools(server, host, o.source, {
    ...(o.connectContext ? { connectContext: true } : {}),
    ...(o.waitSeconds === undefined ? {} : { waitSeconds: o.waitSeconds }),
    ...(o.wake ? { wake: o.wake } : {}),
  });
  await server.connect(new StdioServerTransport(o.input, o.output));
  return { close: () => server.close() };
}
