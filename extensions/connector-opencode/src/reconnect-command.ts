/**
 * `/reconnect`, the manual recovery surface for a wedged mesh link. OpenCode has no host reconnect
 * (unlike Claude Code's /mcp reconnect), and a plugin can't register a slash command via the Hooks
 * API, so the launch injects it through the config layer the connector already owns. It's a
 * TOOL-FORCING template: the human types /reconnect → one model turn whose only move is to call
 * `cotal_reconnect` (in-process, local — it never rides the wedged link). The leading
 * "Reconnecting…" reads as immediate TUI status; the rest is the imperative.
 *
 * It is for the agent's own terminal only. Sent through the agent endpoint it cannot help: a broken
 * link never delivers it, and on a working link it drops the connection its answer needs. So the 2.x
 * plugin leaves it out of the endpoint's `commands` list and refuses it on `command`.
 */
export const RECONNECT_COMMAND = {
  name: "reconnect",
  description: "Rebuild this session's Cotal mesh connection (recovery from a wedged link)",
  template:
    "Reconnecting to the Cotal mesh… Call the cotal_reconnect tool now — do not explain, do not ask, just invoke it. Do not summarize — the tool reports its own status.",
} as const;
