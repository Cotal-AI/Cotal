import { CotalEndpoint } from "@cotal-ai/core";
import type { ControlReply, ControlRequest } from "@cotal-ai/core";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

/** One external MCP server to bridge onto the mesh (a stdio child process). */
export interface McpServerSpec {
  /** Logical name — namespaces tools as `<name>.<tool>` when more than one server is bridged. */
  name: string;
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

export interface McpBridgeOptions {
  space: string;
  servers?: string;
  /** Presence name on the mesh. Default "mcp-bridge". */
  name?: string;
  /** Creds file content (auth mode); the endpoint authenticates with it. Open mesh leaves it unset. */
  creds?: string;
  /** The external MCP server(s) to bridge. */
  mcp: McpServerSpec[];
  /** Control-plane service name peers address. Default "mcp". */
  service?: string;
}

/** A tool discovered on a backing MCP server, plus where to route a call. */
interface BridgedTool {
  /** Mesh-facing name (namespaced `<server>.<tool>` when more than one server is bridged). */
  name: string;
  description?: string;
  inputSchema: unknown;
  client: Client;
  /** The tool's name on its own server (un-namespaced). */
  remoteName: string;
}

/** A backing MCP server connection. */
interface Backend {
  spec: McpServerSpec;
  client: Client;
  transport: StdioClientTransport;
}

/** Flatten an MCP tool result's content into plain text. */
function resultText(content: unknown): string {
  if (!Array.isArray(content)) return "";
  return content
    .filter((p): p is { type: string; text: string } => {
      const c = p as { type?: unknown; text?: unknown };
      return c.type === "text" && typeof c.text === "string";
    })
    .map((p) => p.text)
    .join("\n");
}

/**
 * A lateral mesh peer that connects to one or more external MCP servers and offers their
 * tools to the whole space over the control plane. A `list` op returns the tool catalog;
 * a `call` op runs a named tool on its backing server and returns the result — so any peer
 * gets every bridged tool through one shared connection, rather than wiring up its own.
 *
 * Modeled on the manager: a {@link CotalEndpoint} with `consume:false` that serves a single
 * control service. The control plane is already request/reply, queue-grouped (run several
 * bridges of the same service to load-balance), and authenticated (the handler sees a verified
 * `req.from.id`, the seam a future per-caller ACL would gate on).
 */
export class McpBridge {
  private readonly opts: McpBridgeOptions;
  private readonly service: string;
  private readonly backends: Backend[] = [];
  private readonly tools = new Map<string, BridgedTool>();
  private ep!: CotalEndpoint;

  constructor(opts: McpBridgeOptions) {
    if (!opts.mcp.length) throw new Error("mcp-bridge: at least one MCP server is required");
    this.opts = opts;
    this.service = opts.service ?? "mcp";
  }

  /** The bridged tool catalog (mesh-facing names). */
  get catalog(): { name: string; description?: string; inputSchema: unknown }[] {
    return [...this.tools.values()].map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
    }));
  }

  async start(): Promise<void> {
    // Connect each backing MCP server first — fail loud before joining the mesh, so a broken
    // server config never shows up as an empty, half-working bridge peer.
    const multi = this.opts.mcp.length > 1;
    for (const spec of this.opts.mcp) {
      const transport = new StdioClientTransport({
        command: spec.command,
        args: spec.args,
        env: spec.env,
      });
      const client = new Client({ name: "cotal-mcp-bridge", version: "0.3.1" });
      await client.connect(transport);
      this.backends.push({ spec, client, transport });
      const { tools } = await client.listTools();
      for (const t of tools) {
        const name = multi ? `${spec.name}.${t.name}` : t.name;
        if (this.tools.has(name))
          throw new Error(`mcp-bridge: duplicate tool name "${name}" — namespace collision`);
        this.tools.set(name, {
          name,
          description: t.description,
          inputSchema: t.inputSchema,
          client,
          remoteName: t.name,
        });
      }
    }

    this.ep = new CotalEndpoint({
      space: this.opts.space,
      servers: this.opts.servers,
      creds: this.opts.creds,
      channels: [],
      // Serves control + announces presence; it never consumes chat/dm/task.
      consume: false,
      card: { name: this.opts.name ?? "mcp-bridge", role: "mcp-bridge", kind: "endpoint" },
    });
    this.ep.on("error", (e: Error) => console.error(`! mcp-bridge endpoint: ${e.message}`));
    await this.ep.start();
    const servers = this.opts.mcp.map((s) => s.name).join(", ");
    await this.ep.setActivity(`bridging ${servers} (${this.tools.size} tools)`);
    this.ep.serveControl(this.service, (req) => this.handle(req));
  }

  async stop(): Promise<void> {
    if (this.ep) await this.ep.stop();
    for (const b of this.backends) await b.client.close();
  }

  private async handle(req: ControlRequest): Promise<ControlReply> {
    const args = req.args ?? {};
    switch (req.op) {
      case "list":
        return { ok: true, data: { tools: this.catalog } };
      case "call":
        return this.opCall(args);
      default:
        return { ok: false, error: `unknown op: ${req.op}` };
    }
  }

  private async opCall(args: Record<string, unknown>): Promise<ControlReply> {
    const name = String(args.tool ?? "");
    const tool = this.tools.get(name);
    if (!tool) return { ok: false, error: `no such tool "${name}" (use op "list")` };
    const toolArgs = (args.arguments as Record<string, unknown> | undefined) ?? {};
    try {
      const res = await tool.client.callTool({ name: tool.remoteName, arguments: toolArgs });
      const text = resultText(res.content);
      if (res.isError) return { ok: false, error: text || `tool "${name}" failed` };
      return { ok: true, data: { text, content: res.content } };
    } catch (e) {
      return { ok: false, error: `tool "${name}" threw: ${(e as Error).message}` };
    }
  }
}
