/**
 * The Cotal tool surface for OpenCode, rendered from the **shared** {@link cotalToolSpecs}
 * (the same source the Claude Code MCP connector renders) as OpenCode-native plugin
 * tools (the `tool()` helper). One source of truth → the cotal_* surface can't drift across
 * adapters: an OpenCode peer gets the same tools (incl. channels / join / leave / channel_info).
 *
 * The one OpenCode-specific tool is `cotal_inbox`: automatic traffic remains owned by the driver,
 * while the tool destructively pulls only quiet ambient (plus read-only focus recall).
 */
import { tool, type ToolDefinition } from "@opencode-ai/plugin";
import { cotalToolSpecs, type MeshAgent, type AgentConfig } from "@cotal-ai/connector-core";

/** Build the cotal_* tool map wired to one mesh agent, rendered from the shared specs. */
export function buildCotalTools(agent: MeshAgent, config: AgentConfig): Record<string, ToolDefinition> {
  const tools: Record<string, ToolDefinition> = {};
  for (const spec of cotalToolSpecs(config, "opencode")) {
    if (spec.name === "cotal_inbox") {
      tools.cotal_inbox = tool({
        description:
          "Pull and clear quiet-channel ambient waiting for you. Connector-managed automatic traffic stays queued; in focus mode, normal channel recall is also shown read-only.",
        args: {},
        async execute() {
          const r = await spec.run(agent, config, { scope: "pull-only" });
          return r.isError ? `⚠ ${r.text}` : r.text;
        },
      });
      continue;
    }
    tools[spec.name] = tool({
      description: spec.description,
      // The shared spec carries a Zod raw shape; OpenCode's tool() takes the same (zod via tool.schema).
      args: (spec.schema ?? {}) as Record<string, never>,
      async execute(args: unknown) {
        const r = await spec.run(agent, config, (args ?? {}) as any);
        return r.isError ? `⚠ ${r.text}` : r.text;
      },
    });
  }
  return tools;
}
