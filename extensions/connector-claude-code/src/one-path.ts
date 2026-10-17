/**
 * One Cotal path per Claude Code session.
 *
 * A session Cotal launched is on its mesh through this plugin's local server. Claude Code also loads
 * connected-account connectors by default, so the same session can see a hosted Cotal connector and
 * join a second time under another name. This hook answer refuses every Cotal tool of any server
 * other than the local one, so the session keeps one identity. The relay only calls it in a session
 * that carries a mesh identity; a plain session has no local path and keeps the hosted one.
 */
import type { LocalHookAnswer } from "@cotal-ai/connector-core/relay";

/** The local mesh server's names: the launch's `--mcp-config` entry and the plugin's own `.mcp.json`. */
const LOCAL_SERVERS: ReadonlySet<string> = new Set(["cotal", "plugin_cotal_cotal"]);

/** A Cotal tool of any MCP server, as Claude Code names it: `mcp__<server>__cotal_<tool>`. */
const COTAL_TOOL = /^mcp__(.+)__cotal_[a-z_]+$/;

export const ONE_PATH_REASON =
  "This session is already on a Cotal mesh through its local Cotal plugin, and a session uses one " +
  "Cotal path. Use the local cotal_* tools (mcp__cotal__...). To use the hosted Cotal connector, " +
  "start a Claude Code session that Cotal did not launch.";

/** Deny a call to another Cotal path's tool, or `undefined` for every other event. */
export const otherCotalPath: LocalHookAnswer = (event) => {
  const ev = event as { hook_event_name?: unknown; tool_name?: unknown } | null;
  if (ev?.hook_event_name !== "PreToolUse" || typeof ev.tool_name !== "string") return undefined;
  const server = COTAL_TOOL.exec(ev.tool_name)?.[1];
  if (server === undefined || LOCAL_SERVERS.has(server)) return undefined;
  return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: ONE_PATH_REASON,
    },
  };
};
