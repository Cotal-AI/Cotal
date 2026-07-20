/**
 * The Cotal tool surface for OpenCode, rendered from the **shared** {@link cotalToolSpecs}
 * (the same source the Claude Code MCP connector renders) as OpenCode-native plugin
 * tools ({@link ToolDefinition} literals). One source of truth → the cotal_* surface can't drift
 * across adapters: an OpenCode peer gets the same tools (incl. channels / join / leave / channel_info).
 *
 * The one OpenCode-specific tool is `cotal_inbox`: automatic traffic remains owned by the driver,
 * while the tool destructively pulls only quiet ambient (plus read-only focus recall).
 *
 * The definitions are plain literals, NOT OpenCode's `tool()` helper: `tool()` is an identity
 * function for type inference only, so importing it would make `@opencode-ai/plugin` a RUNTIME
 * dependency of this bundle. It resolves from the host's opencode process, not ours, and an
 * installed extension has no copy of it, so the import fails and OpenCode skips the plugin
 * silently. A type-only import keeps the bundle self-contained.
 */
import type { ToolDefinition } from "@opencode-ai/plugin";
import { cotalToolSpecs, type MeshAgent, type AgentConfig } from "@cotal-ai/connector-core";

/** Build the cotal_* tool map wired to one mesh agent, rendered from the shared specs. */
export function buildCotalTools(agent: MeshAgent, config: AgentConfig): Record<string, ToolDefinition> {
  const tools: Record<string, ToolDefinition> = {};
  for (const spec of cotalToolSpecs(config, "opencode")) {
    if (spec.name === "cotal_inbox") {
      tools.cotal_inbox = {
        description:
          "Pull and clear quiet-channel ambient waiting for you. Connector-managed automatic traffic stays queued; in focus mode, normal channel recall is also shown read-only.",
        args: {},
        async execute() {
          const r = await spec.run(agent, config, { scope: "pull-only" });
          return r.isError ? `⚠ ${r.text}` : r.text;
        },
      };
      continue;
    }
    tools[spec.name] = {
      description: spec.description,
      // The shared spec carries a Zod raw shape, which is what OpenCode's tool `args` takes.
      args: (spec.schema ?? {}) as Record<string, never>,
      async execute(args: unknown) {
        const r = await spec.run(agent, config, (args ?? {}) as any);
        return r.isError ? `⚠ ${r.text}` : r.text;
      },
    };
  }
  return tools;
}
