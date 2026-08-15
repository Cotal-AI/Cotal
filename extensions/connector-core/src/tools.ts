/**
 * MCP renderer for the Cotal tool surface.
 *
 * The tools themselves are defined once, platform-neutrally, in {@link cotalToolSpecs}
 * ({@link ./tool-specs.ts}); this just renders each onto an {@link McpServer}. The
 * Claude Code connector builds its own server (with platform-specific capabilities) and
 * calls {@link registerCotalTools}. The OpenCode connector renders the same specs as
 * native plugin tools — so the surface stays identical across adapters.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { cotalToolSpecs, type ToolResult } from "./tool-specs.js";
import type { MeshAgent } from "./agent.js";
import type { AgentConfig } from "./config.js";

function toContent(r: ToolResult) {
  const content = [{ type: "text" as const, text: r.text }];
  return r.isError ? { content, isError: true as const } : { content };
}

/** Register the Cotal tool surface (roster, inbox, send, dm, anycast, status, channels,
 *  channel_info, join, leave, spawn, feedback) on an MCP server. `source` names the
 *  hosting connector for outgoing feedback. */
export function registerCotalTools(server: McpServer, agent: MeshAgent, config: AgentConfig, source?: string): void {
  // No schemaless branch. Registering a tool WITHOUT an `inputSchema` is what let a no-argument
  // tool accept `{owner, actor}` and drop it: the host has nothing to check against, so it forwards
  // whatever arrived. Every spec now carries a closed object, empty ones included, and the host
  // refuses the extras for us.
  for (const spec of cotalToolSpecs(config, source)) {
    server.registerTool(
      spec.name,
      { title: spec.title, description: spec.description, inputSchema: spec.schema },
      async (args: Record<string, unknown>) => toContent(await spec.run(agent, config, args)),
    );
  }
}
