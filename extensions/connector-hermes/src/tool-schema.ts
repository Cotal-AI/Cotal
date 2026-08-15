/**
 * Render the shared Cotal tool surface as Hermes plugin-tool descriptors.
 *
 * One source of truth: {@link cotalToolSpecs} (connector-core). We do NOT hand-write the Hermes
 * tool list — we generate `{name, description, parameters}` from each spec (the spec's closed Zod
 * object → JSON Schema via Zod 4's `toJSONSchema`) so a Hermes peer gets exactly the same `cotal_*`
 * surface as Claude Code / OpenCode, and `parity.smoke.ts` fails if the two ever drift.
 *
 * The descriptors are written to a file the launcher hands the gateway (`COTAL_TOOLS_FILE`); the
 * Python plugin reads it at `register(ctx)` time so tool registration stays synchronous and never
 * has to block on the bridge. Tool *calls* still ride the bridge at runtime.
 */
import { z } from "zod";
import { cotalToolSpecs, NO_TOOL_ARGS, type AgentConfig } from "@cotal-ai/connector-core";

/** A Hermes plugin tool: name + description + a JSON-Schema object for its parameters. */
export interface HermesToolDescriptor {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

/** The descriptor for a tool this connector calls with no caller-supplied arguments — rendered
 *  from the same closed empty object the bridge enforces against, so the published contract and
 *  the enforced one cannot drift and "no parameters" never reads as "parameters ignored". */
const EMPTY_PARAMS: Record<string, unknown> = z.toJSONSchema(NO_TOOL_ARGS) as Record<string, unknown>;

const PULL_INBOX_DESCRIPTION =
  "Pull and clear quiet-channel ambient waiting for you. Connector-managed automatic traffic " +
  "stays queued; in focus mode, normal channel recall is also shown read-only.";

/** Build the Hermes tool descriptors for a given agent config (rendered from the shared specs). */
export function hermesToolDescriptors(config: AgentConfig): HermesToolDescriptor[] {
  return cotalToolSpecs(config, "hermes").map((spec) => {
    if (spec.name === "cotal_inbox") {
      return { name: spec.name, description: PULL_INBOX_DESCRIPTION, parameters: EMPTY_PARAMS };
    }
    const parameters = z.toJSONSchema(spec.schema) as Record<string, unknown>;
    return { name: spec.name, description: spec.description, parameters };
  });
}
