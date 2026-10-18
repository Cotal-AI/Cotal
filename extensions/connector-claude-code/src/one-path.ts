/**
 * One Cotal path per Claude Code session.
 *
 * A session Cotal launched is on its mesh through this plugin's local server. Claude Code also loads
 * connected-account connectors by default, so the same session can see a hosted Cotal connector and
 * join a second time under another name. This hook answer refuses every Cotal tool of any server
 * other than the local one, so the session keeps one identity. A plain session has no local path
 * and keeps the hosted one.
 */
import type { LocalHookAnswer } from "@cotal-ai/connector-core/relay";

/** The local mesh server's names: the launch's `--mcp-config` entry and the plugin's own `.mcp.json`. */
const LOCAL_SERVERS: ReadonlySet<string> = new Set(["cotal", "plugin_cotal_cotal"]);

/** A Cotal tool of any MCP server, as Claude Code names it: `mcp__<server>__cotal_<tool>`. The tool
 *  part never holds `__`, so a server whose own name contains `__cotal_` is not split inside it. */
const COTAL_TOOL = /^mcp__(.+)__(cotal_[a-z0-9]+(?:_[a-z0-9]+)*)$/;

/** The tool's name on its server when `toolName` is a Cotal tool of a server other than the local
 *  one, else `undefined`. */
export function hostedCotalTool(toolName: unknown): string | undefined {
  const m = typeof toolName === "string" ? COTAL_TOOL.exec(toolName) : null;
  return m && !LOCAL_SERVERS.has(m[1]!) ? m[2] : undefined;
}

export const ONE_PATH_REASON =
  "This session is already on a Cotal mesh through its local Cotal plugin, and a session uses one " +
  "Cotal path. Use the local cotal_* tools (mcp__cotal__...). To use the hosted Cotal connector, " +
  "start a Claude Code session that Cotal did not launch.";

/** Deny a call to another Cotal path's tool in a managed session, or `undefined` otherwise. */
export const otherCotalPath: LocalHookAnswer = (event, session) => {
  if (!session.managed) return undefined;
  const ev = event as { hook_event_name?: unknown; tool_name?: unknown } | null;
  if (ev?.hook_event_name !== "PreToolUse" || hostedCotalTool(ev.tool_name) === undefined) return undefined;
  return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: ONE_PATH_REASON,
    },
  };
};
