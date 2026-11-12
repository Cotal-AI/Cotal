/**
 * Claude Code's permission prompt at the hook boundary: its `PermissionRequest` payload in, the
 * desk's verdict out. Type imports only, because the lifecycle hook process loads this module.
 */
import type { HookEvent, PermissionAsk, PermissionVerdict } from "@cotal-ai/connector-core";
import type { JsonValue } from "@cotal-ai/core";

/** The hook event the relay holds open until the prompt is answered. */
export const isPermissionRequest = (event: unknown): boolean =>
  (event as { hook_event_name?: unknown } | null)?.hook_event_name === "PermissionRequest";

/** The prompt a `PermissionRequest` payload asks, or `undefined` for one without a tool name and input. */
export function claudeAsk(ev: HookEvent): PermissionAsk | undefined {
  if (typeof ev.tool_name !== "string" || !ev.tool_name || ev.tool_input === undefined) return undefined;
  return { tool: ev.tool_name, input: ev.tool_input as JsonValue, ...(typeof ev.cwd === "string" && ev.cwd ? { cwd: ev.cwd } : {}) };
}

/** The hook output that applies a verdict. A release prints no decision, so Claude keeps its own. */
export function claudeVerdict(verdict: PermissionVerdict): Record<string, unknown> {
  if (verdict.kind === "release") return {};
  const decision = verdict.kind === "allow" ? { behavior: "allow" } : { behavior: "deny", message: verdict.message };
  return { hookSpecificOutput: { hookEventName: "PermissionRequest", decision } };
}

/** The tool calls a `PostToolBatch` payload says ran. */
export function claudeToolCalls(ev: HookEvent): { tool: string; input: unknown }[] {
  if (!Array.isArray(ev.tool_calls)) return [];
  return ev.tool_calls.flatMap((c: { tool_name?: unknown; tool_input?: unknown } | null) =>
    typeof c?.tool_name === "string" ? [{ tool: c.tool_name, input: c.tool_input }] : []);
}
