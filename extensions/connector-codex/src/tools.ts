/**
 * The Cotal tool surface for Codex, rendered from the **shared** {@link cotalToolSpecs}
 * (the same source the Claude Code and OpenCode connectors render) as app-server
 * dynamic tools. One source of truth → the cotal_* surface can't drift across adapters.
 *
 * Codex wants JSON Schema (`inputSchema`); the shared specs carry Zod raw shapes, so each
 * is converted once at build time with zod's own `z.toJSONSchema`.
 *
 * The one Codex-specific override is `cotal_inbox` (same as OpenCode): automatic traffic is
 * OWNED by the host's turn loop (surfaced into turns, acked on completion), so the tool pulls
 * only quiet ambient — a destructive drain of automatic items would ack messages the loop is
 * still accountable for.
 */
import { z } from "zod";
import { cotalToolSpecs, type MeshAgent, type AgentConfig } from "@cotal-ai/connector-core";
import type { DynamicTool, ToolCall, ToolReply } from "./app-server.js";

export interface CotalToolSurface {
  /** `thread/start.dynamicTools` for the driver. */
  tools: DynamicTool[];
  /** Dispatch one `item/tool/call` into the mesh agent. Unknown tool → isError reply. */
  dispatch(call: ToolCall): Promise<ToolReply>;
}

export function buildCotalTools(agent: MeshAgent, config: AgentConfig): CotalToolSurface {
  const specs = cotalToolSpecs(config, "codex");
  const tools: DynamicTool[] = specs.map((spec) => ({
    type: "function",
    name: spec.name,
    description:
      spec.name === "cotal_inbox"
        ? "Pull and clear quiet-channel ambient waiting for you. Connector-managed automatic traffic stays queued; in focus mode, normal channel recall is also shown read-only."
        : spec.description,
    inputSchema:
      spec.name === "cotal_inbox"
        ? { type: "object", properties: {}, additionalProperties: false }
        : z.toJSONSchema(z.object(spec.schema ?? {})),
  }));
  const byName = new Map(specs.map((s) => [s.name, s]));

  return {
    tools,
    async dispatch(call: ToolCall): Promise<ToolReply> {
      const spec = byName.get(call.tool);
      if (!spec) return { text: `unknown tool: ${call.tool}`, isError: true };
      const args =
        spec.name === "cotal_inbox"
          ? { scope: "pull-only" }
          : ((call.arguments ?? {}) as Record<string, unknown>);
      const r = await spec.run(agent, config, args);
      return { text: r.text, isError: r.isError };
    },
  };
}
