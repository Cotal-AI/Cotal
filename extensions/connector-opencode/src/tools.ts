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
import { cotalToolSpecs, parseToolArgs, refuseAnyArgs, type MeshAgent, type AgentConfig } from "@cotal-ai/connector-core";
import type { OpenCode2ToolEditor } from "./opencode2-types.js";

/** Build the cotal_* tool map wired to one mesh agent, rendered from the shared specs. */
export function buildCotalTools(agent: MeshAgent, config: AgentConfig): Record<string, ToolDefinition> {
  const tools: Record<string, ToolDefinition> = {};
  for (const spec of cotalToolSpecs(config, "opencode")) {
    if (spec.name === "cotal_inbox") {
      tools.cotal_inbox = {
        description:
          "Pull and clear quiet-channel ambient waiting for you. Connector-managed automatic traffic stays queued; in focus mode, normal channel recall is also shown read-only.",
        args: {},
        // Published with no arguments and `scope` supplied by us — but this host validates nothing,
        // so ignoring the caller's object would silently swallow whatever it sent. Check it against
        // the empty contract we published first, then substitute our own scope.
        async execute(args: unknown) {
          const refusal = refuseAnyArgs(spec.name, args);
          if (refusal) return `⚠ ${refusal}`;
          const r = await spec.run(agent, config, { scope: "pull-only" });
          return r.isError ? `⚠ ${r.text}` : r.text;
        },
      };
      continue;
    }
    tools[spec.name] = {
      description: spec.description,
      // OpenCode's `args` is a raw SHAPE at runtime, not a schema: handed the shared spec's closed
      // object it walks that object's own properties as if they were fields, and the whole
      // `tool.list` response then fails to serialize — every cotal_* tool disappears, not just one.
      // So this host is advertised open, and closed below instead.
      args: spec.schema.shape as Record<string, never>,
      async execute(args: unknown) {
        // OpenCode passes the model's object through UNVALIDATED (its `execute` type claims
        // otherwise), so this is the only place the closed object bites on this host. A stray
        // `owner`/`actor` is refused by name rather than silently reaching `run`.
        let parsed: Record<string, unknown>;
        try {
          parsed = parseToolArgs(spec, args);
        } catch (e) {
          return `⚠ ${(e as Error).message}`;
        }
        const r = await spec.run(agent, config, parsed);
        return r.isError ? `⚠ ${r.text}` : r.text;
      },
    };
  }
  return tools;
}

/** Build the cotal_* tool list for OpenCode 2.x's `ctx.tool.transform(ed => ed.add(...))`, from
 *  the SAME shared specs {@link buildCotalTools} renders for 1.x. 2.x's `Tool.Info.input` accepts
 *  a zod 4 object directly (a StandardSchema — measured, `fx105/measurements.md`), so the closed
 *  schema goes across unmodified; there is no 1.x-style raw-shape flattening needed here. The
 *  closed-object refusal at dispatch is the same guard as {@link buildCotalTools} keeps: this host
 *  also hands `execute` the caller's object UNVALIDATED, so a stray `owner`/`actor` is refused by
 *  name here too, never silently reaching `run`. */
export function buildCotalTools2(agent: MeshAgent, config: AgentConfig): Parameters<OpenCode2ToolEditor["add"]>[0][] {
  const defs: Parameters<OpenCode2ToolEditor["add"]>[0][] = [];
  for (const spec of cotalToolSpecs(config, "opencode")) {
    if (spec.name === "cotal_inbox") {
      defs.push({
        name: "cotal_inbox",
        description:
          "Pull and clear quiet-channel ambient waiting for you. Connector-managed automatic traffic stays queued; in focus mode, normal channel recall is also shown read-only.",
        input: spec.schema,
        async execute(args: unknown) {
          const refusal = refuseAnyArgs(spec.name, args);
          if (refusal) return { content: `⚠ ${refusal}` };
          const r = await spec.run(agent, config, { scope: "pull-only" });
          return { content: r.isError ? `⚠ ${r.text}` : r.text };
        },
      });
      continue;
    }
    defs.push({
      name: spec.name,
      description: spec.description,
      input: spec.schema,
      async execute(args: unknown) {
        let parsed: Record<string, unknown>;
        try {
          parsed = parseToolArgs(spec, args);
        } catch (e) {
          return { content: `⚠ ${(e as Error).message}` };
        }
        const r = await spec.run(agent, config, parsed);
        return { content: r.isError ? `⚠ ${r.text}` : r.text };
      },
    });
  }
  return defs;
}
