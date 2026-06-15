import { resolve } from "node:path";
import { loadAgentFile, registry, type Connector, type LaunchOpts, type LaunchSpec } from "@cotal-ai/core";

/** Channel ref for the locally-installed `cotal` plugin (marketplace `cotal-mesh`).
 *  `--dangerously-load-development-channels <ref>` turns on the plugin's
 *  `claude/channel` capability so an idle session wakes the instant a peer message
 *  arrives. The plugin must be *installed* (not `--plugin-dir`) for the channel to
 *  bind; the connector's identity guard keeps it inert in non-managed sessions. */
const CHANNEL_REF = "plugin:cotal@cotal-mesh";

/**
 * The Claude Code connector: launches the real `claude` with the Cotal identity in
 * the environment and the mesh channel enabled, so the session joins the mesh and
 * wakes on incoming peer messages. Self-registers on import; the manager resolves it
 * by agent type "claude".
 */
export const claudeConnector: Connector = {
  kind: "connector",
  name: "claude",
  buildLaunch(opts: LaunchOpts): LaunchSpec {
    const env: Record<string, string> = {
      COTAL_SPACE: opts.space,
      COTAL_NAME: opts.name,
      // Force the connector to emit channel wake-nudges: Claude doesn't advertise the
      // `claude/channel` capability back over MCP, so auto-detection would see it "off".
      COTAL_CHANNEL: "1",
      // Managed sessions mirror their own transcript to `tr-<name>` so peers can read
      // what the agent actually did. Personal sessions (no buildLaunch) never mirror.
      COTAL_TRANSCRIPT: "1",
    };
    if (opts.role) env.COTAL_ROLE = opts.role;
    if (opts.id) env.COTAL_ID = opts.id;
    if (opts.creds) env.COTAL_CREDS = opts.creds;
    if (opts.servers) env.COTAL_SERVERS = opts.servers;

    const args = ["--dangerously-load-development-channels", CHANNEL_REF];

    // Resume a prior conversation into the mesh. `--fork-session` makes claude mint a
    // fresh session id from the resumed history, so the original session this id points
    // at keeps running untouched (we adopt its context, not its identity).
    if (opts.resume) args.push("--resume", opts.resume, "--fork-session");

    // An agent file carries identity (read in-session via COTAL_AGENT_FILE) plus
    // persona + model, which can only be applied to a `claude` session at launch.
    if (opts.configPath) {
      const path = resolve(opts.configPath);
      env.COTAL_AGENT_FILE = path;
      const def = loadAgentFile(path);
      if (def.persona) args.push("--append-system-prompt", def.persona);
      if (def.model) args.push("--model", def.model);
    }

    return {
      command: "claude",
      args,
      env,
      // The dev-channels flag shows a one-time "Enter to confirm" prompt; the
      // manager auto-clears it so a supervised launch needs no human keypress.
      confirm: "Enter to confirm",
    };
  },
};

registry.register(claudeConnector);
