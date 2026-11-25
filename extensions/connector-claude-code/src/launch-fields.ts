/**
 * The `claude` flags behind a launch's permission mode and its opt-in launch fields
 * (`askPermissions`, `reasoningEvents`). Each refusal here runs before the launch writes a file.
 */
import type { LaunchOpts } from "@cotal-ai/core";

type Passthrough = readonly (readonly [string, string])[];

const PERMISSION_KEYS = ["permission-mode", "dangerously-skip-permissions"];

/** Without this setting Claude Code 2.1.330 asks the API for thinking display `updates` and records
 *  each thinking block with empty text; with it, the display is `summarized` and the text is kept. */
const THINKING_SUMMARIES = JSON.stringify({ showThinkingSummaries: true });

/**
 * The permission flags. `askPermissions` launches in Claude's `default` mode, which asks before a tool
 * runs, so its prompts reach the agent endpoint. Otherwise a managed seat (marked by `cwd`) bypasses
 * prompts: nobody sits at its terminal, and a seat whose first mesh tool call stalled on a prompt
 * looked dead to its peers. The operator's own permission option replaces that default, and a
 * foreground launch keeps Claude's own mode, answered in the operator's terminal.
 */
function permissionArgs(opts: LaunchOpts, passthrough: Passthrough): string[] {
  const own = passthrough.find(([k]) => PERMISSION_KEYS.includes(k));
  if (opts.askPermissions) {
    if (own) throw new Error(`claude connector: askPermissions sets --permission-mode default, and the launch options set ${own[0]} too; pass one of them`);
    return ["--permission-mode", "default"];
  }
  return opts.cwd && !own ? ["--permission-mode", "bypassPermissions"] : [];
}

/** `reasoningEvents` turns on Claude's thinking summaries, the only reasoning text it records. */
function reasoningArgs(opts: LaunchOpts, passthrough: Passthrough): string[] {
  if (!opts.reasoningEvents) return [];
  if (passthrough.some(([k]) => k === "settings"))
    throw new Error("claude connector: reasoningEvents sets --settings, and the launch options set settings too; pass one of them");
  return ["--settings", THINKING_SUMMARIES];
}

/** The flags for the launch's permission mode and opt-in fields. Throws on a launch option that
 *  would set the same thing. */
export function launchFieldArgs(opts: LaunchOpts, passthrough: Passthrough): string[] {
  return [...permissionArgs(opts, passthrough), ...reasoningArgs(opts, passthrough)];
}
