import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadAgentFile, registry, type Connector, type LaunchOpts, type LaunchSpec } from "@cotal-ai/core";

/** Name the cotal MCP server is registered under via --mcp-config (see buildLaunch). */
const MCP_SERVER_NAME = "cotal";
/** Channel ref for `--dangerously-load-development-channels`, which turns on the cotal MCP server's
 *  `claude/channel` capability so an idle session wakes the instant a peer message arrives. Because
 *  we isolate the session with --strict-mcp-config the plugin's own MCP server is suppressed and
 *  cotal is re-supplied via --mcp-config, so the ref is the manually-configured server tagged
 *  `server:<name>` (the CLI rejects a plugin ref or a bare name here). The plugin stays installed
 *  for its hooks, which do message delivery independent of this wake nudge. */
const CHANNEL_REF = `server:${MCP_SERVER_NAME}`;

/** Package root (parent of dist/), which doubles as the installable plugin dir: it carries
 *  .claude-plugin/, .mcp.json, hooks/ and the dist/*.cjs bundles. */
const PLUGIN_ROOT = fileURLToPath(new URL("..", import.meta.url));
/** The cotal MCP server bundle, supplied explicitly so a spawned session can run with ONLY this
 *  MCP server (see buildLaunch's --strict-mcp-config). */
const MCP_CJS = resolve(PLUGIN_ROOT, "dist", "mcp.cjs");

/**
 * The Claude Code connector: launches the real `claude` with the Cotal identity in
 * the environment and the mesh channel enabled, so the session joins the mesh and
 * wakes on incoming peer messages. Self-registers on import; the manager resolves it
 * by agent type "claude".
 */
export const claudeConnector: Connector = {
  kind: "connector",
  name: "claude",
  pluginRoot: PLUGIN_ROOT,
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

    // A leading positional is claude's first message, auto-submitted on start — so a driving
    // session can greet the operator the moment it joins. A resumed session already carries its
    // own context, so skip the greeting and reattach the prior conversation instead.
    const args = opts.prompt && !opts.resume
      ? [opts.prompt, "--dangerously-load-development-channels", CHANNEL_REF]
      : ["--dangerously-load-development-channels", CHANNEL_REF];

    // Resume a prior conversation into the mesh. --fork-session makes claude mint a fresh session
    // id from the resumed history, so the original session this id points at keeps running
    // untouched (we adopt its context, not its identity). Composes with the strict-MCP isolation
    // below — the forked process still loads only the cotal server.
    if (opts.resume) args.push("--resume", opts.resume, "--fork-session");

    // Pre-allow fetching the public Cotal docs so a doc-grounded persona (e.g. david)
    // can look something up under `npx` (no repo on disk) without prompting the operator
    // mid-demo. Additive under the default permission mode — leaves other tools as-is.
    args.push("--allowedTools", "WebFetch(domain:github.com),WebFetch(domain:raw.githubusercontent.com)");

    // Isolate the spawned session's MCP to ONLY the cotal server. --strict-mcp-config drops every
    // other MCP source — including the operator's personal ~/.claude.json servers (e.g. a headless
    // Chromium, a DB server) that a meshed teammate never needs and that, multiplied across several
    // spawns on a busy machine, starve memory and kill the session before it registers presence —
    // and --mcp-config re-supplies cotal so its tools + presence still load. The plugin itself stays
    // enabled (its hooks + the dev-channels wake path are unaffected; only MCP config is scoped).
    args.push(
      "--strict-mcp-config",
      "--mcp-config",
      JSON.stringify({ mcpServers: { [MCP_SERVER_NAME]: { command: "node", args: [MCP_CJS] } } }),
    );

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
