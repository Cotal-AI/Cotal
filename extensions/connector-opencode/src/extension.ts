import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { loadAgentFile, registry, type Connector, type LaunchOpts, type LaunchSpec } from "@cotal-ai/core";

/** The bundled in-process plugin (esbuild → `dist/plugin.bundle.js`). `opencode serve` loads it by
 *  absolute path from the inline config, so it runs *inside* the server and shares its SDK client.
 *  Resolved relative to this module — beside the built `dist/extension.js`, so the connector must be
 *  built+bundled (`pnpm build`). */
const PLUGIN_ENTRY = fileURLToPath(new URL("./plugin.bundle.js", import.meta.url));

/** The launcher shim (`dist/serve.js`): starts `opencode serve` with the plugin, then attaches a
 *  foreground `opencode` TUI to the exact session the plugin drives (see serve.ts). */
const SERVE_SHIM = fileURLToPath(new URL("./serve.js", import.meta.url));

/**
 * The OpenCode connector: launches a watchable `opencode` TUI bound to the agent's session, using
 * OpenCode's client/server split (see serve.ts). The Cotal mesh bridge runs as an in-process plugin
 * inside a headless `opencode serve`: it holds the {@link MeshAgent}, registers the cotal_* tools
 * natively (from the shared specs, at parity with Claude/Codex), reports presence off the event bus,
 * and owns ONE session it drives — injecting each incoming peer batch as a turn via the prompt API
 * (`session.promptAsync`, server-side, so it can't race the TUI input box). The shim then attaches a
 * foreground TUI to that session, so a human watching sees the agent work and can type into it.
 *
 * Config rides in `OPENCODE_CONFIG_CONTENT` (inline JSON, the highest merge layer), so the
 * operator's `~/.config/opencode` is never written — the Codex `-c` trick in JSON.
 * `permission:"allow"` keeps a supervised agent from stalling on a tool approval the human may not
 * be at the keyboard to grant. Self-registers on import; the manager resolves it by type "opencode".
 */
export const opencodeConnector: Connector = {
  kind: "connector",
  name: "opencode",
  buildLaunch(opts: LaunchOpts): LaunchSpec {
    // Resume is claude-only (it forks a prior claude transcript). Fail closed rather than
    // silently dropping the flag, so `--resume` against the wrong agent is an explicit error.
    if (opts.resume) throw new Error("--resume is only supported by the claude connector");
    // Identity rides the process env: the plugin runs in the opencode process and inherits it
    // (unlike the Codex/Claude MCP servers, which get none of the parent env).
    const env: Record<string, string> = { COTAL_SPACE: opts.space, COTAL_NAME: opts.name };
    if (opts.role) env.COTAL_ROLE = opts.role;
    if (opts.id) env.COTAL_ID = opts.id;
    if (opts.creds) env.COTAL_CREDS = opts.creds;
    if (opts.servers) env.COTAL_SERVERS = opts.servers;

    const config: Record<string, unknown> = {
      $schema: "https://opencode.ai/config.json",
      permission: "allow",
      plugin: [PLUGIN_ENTRY],
    };

    // An agent file carries identity (read in-session via COTAL_AGENT_FILE) plus persona + model.
    // The model is a config default (the session — and the attached TUI — use it); the persona is
    // applied in-session by the plugin (opencode has no `--append-system-prompt`).
    if (opts.configPath) {
      const path = resolve(opts.configPath);
      env.COTAL_AGENT_FILE = path; // plugin reads persona from it
      const def = loadAgentFile(path);
      if (def.model) config.model = def.model;
      const face = def.meta?.face;
      if (face) env.COTAL_FACE_PERSONA = face; // shim swaps the TUI for the face viewer
    }

    env.OPENCODE_CONFIG_CONTENT = JSON.stringify(config);

    // Run the shim (node dist/serve.js): `opencode serve` + an attached foreground TUI.
    return {
      command: process.execPath,
      args: [SERVE_SHIM],
      env,
    };
  },
};

registry.register(opencodeConnector);
