/**
 * The `claude` flags behind a launch's permission mode, its opt-in launch fields (`askPermissions`,
 * `reasoningEvents`) and its modes. Each refusal here runs before the launch writes a file.
 */
import type { LaunchModes, LaunchOpts } from "@cotal-ai/core";

type Passthrough = readonly (readonly [string, string])[];

const PERMISSION_KEYS = ["permission-mode", "dangerously-skip-permissions"];

/** Without this setting Claude Code 2.1.330 asks the API for thinking display `updates` and records
 *  each thinking block with empty text; with it, the display is `summarized` and the text is kept. */
const THINKING_SUMMARIES = { showThinkingSummaries: true };

/** The setting each of the catalog's modes turns on or off. Ultracode is a setting, never an effort:
 *  claude reads `--effort ultracode` as xhigh plus ultracode, and a later `--effort` cancels it. */
const CLAUDE_MODE_SETTINGS: Readonly<Record<string, string>> = { fast: "fastMode", ultracode: "ultracode" };

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

/** The settings that set the launch's modes. A mode turned off is written as false, so a setting the
 *  operator saved, such as fast mode, does not turn it back on. */
function modeSettings(modes: LaunchModes | undefined): Record<string, boolean> {
  const settings: Record<string, boolean> = {};
  for (const [id, on] of Object.entries(modes ?? {})) {
    const key = Object.hasOwn(CLAUDE_MODE_SETTINGS, id) ? CLAUDE_MODE_SETTINGS[id]! : undefined;
    if (key === undefined) throw new Error(`claude connector: claude has no mode ${JSON.stringify(id)}; its modes are ${Object.keys(CLAUDE_MODE_SETTINGS).join(" and ")}`);
    if (typeof on !== "boolean") throw new Error(`claude connector: mode ${JSON.stringify(id)} is a toggle, so it takes true or false, not ${JSON.stringify(on)}`);
    settings[key] = on;
  }
  return settings;
}

/**
 * The one `--settings` flag for the launch's modes and, with `reasoningEvents`, Claude's thinking
 * summaries, the only reasoning text it records. Claude keeps only the last `--settings` it is given,
 * so these share one flag, and an operator's `--opt settings=` beside them is refused rather than
 * dropping one of the two unseen.
 */
function settingsArgs(opts: LaunchOpts, passthrough: Passthrough): string[] {
  const modes = modeSettings(opts.modes);
  const settings = { ...(opts.reasoningEvents ? THINKING_SUMMARIES : {}), ...modes };
  if (Object.keys(settings).length === 0) return [];
  if (passthrough.some(([k]) => k === "settings")) {
    const setBy = [opts.reasoningEvents ? "reasoningEvents" : "", Object.keys(modes).length ? "the modes" : ""].filter(Boolean).join(" and ");
    throw new Error(`claude connector: ${setBy} go in claude's --settings, which --opt settings= also sets, and claude keeps only the last one; pass one of them`);
  }
  return ["--settings", JSON.stringify(settings)];
}

/** The flags for the launch's permission mode, opt-in fields and modes. Throws on a launch option
 *  that would set the same thing. */
export function launchFieldArgs(opts: LaunchOpts, passthrough: Passthrough): string[] {
  return [...permissionArgs(opts, passthrough), ...settingsArgs(opts, passthrough)];
}
