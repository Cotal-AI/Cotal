import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { loadAgentFile, registry, type Connector, type LaunchOpts, type LaunchSpec } from "@cotal-ai/core";
import { aclEnv, launchEnv, controlEndpoint, MODEL_PROVIDER_KEYS } from "@cotal-ai/connector-core";

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
 * natively (from the shared specs, at parity with Claude Code), reports presence off the event bus,
 * and owns ONE session it drives — injecting each incoming peer batch through the authenticated
 * OpenCode server API on the same serve process the TUI attaches to. The shim then attaches a
 * foreground TUI to that session, so a human watching sees the agent work and can type into it.
 *
 * Config rides in `OPENCODE_CONFIG_CONTENT` (inline JSON, the highest merge layer), so the
 * operator's `~/.config/opencode` is never written.
 * `permission:"allow"` keeps a supervised agent from stalling on a tool approval the human may not
 * be at the keyboard to grant. Self-registers on import; the manager resolves it by type "opencode".
 */
export const opencodeConnector: Connector = {
  kind: "connector",
  name: "opencode",
  requires: ["opencode"],
  buildLaunch(opts: LaunchOpts): LaunchSpec {
    // Tool-sharing isn't wired for opencode: its OPENCODE_CONFIG_CONTENT is a merge layer, so an
    // opencode agent already INHERITS the operator's MCP servers (the opposite default to Claude's
    // strict isolation). A `connectors.opencode.mcpServers` entry would need inverse (opt-OUT)
    // semantics that don't exist yet — throw rather than silently ignore it (no fallbacks).
    if (opts.mcpServers && Object.keys(opts.mcpServers).length > 0)
      throw new Error(
        "opencode connector: tool-sharing (connectors.opencode.mcpServers) is not implemented. " +
          "opencode agents currently inherit the operator's MCP servers through its config merge " +
          "layer; restricting that down to a chosen subset needs an inverse opt-out filter, which " +
          "is a separate feature.",
      );
    // Identity rides the process env: the plugin runs in the opencode process and inherits it
    // (unlike the Claude Code MCP server, which gets none of the parent env). The OS allow-list +
    // the named model-provider key (opencode's hosted models read OPENCODE_API_KEY; other
    // providers read their own) are forwarded BY NAME — never `...process.env` — so the operator's
    // unrelated secrets don't reach the child (P3).
    const env: Record<string, string> = {
      ...launchEnv({ providerKeys: MODEL_PROVIDER_KEYS }),
      ...aclEnv(opts),
      COTAL_SPACE: opts.space,
      COTAL_NAME: opts.name,
    };
    if (opts.role) env.COTAL_ROLE = opts.role;
    if (opts.id) env.COTAL_ID = opts.id;
    if (opts.creds) env.COTAL_CREDS = opts.creds;
    if (opts.servers) env.COTAL_SERVERS = opts.servers;
    if (opts.transcript === true) env.COTAL_TRANSCRIPT = "1"; // gate the plugin's transcript mirror (parity with Claude)
    // Where serve.ts roots this agent's SQLite DB + serve pidfile. Pin it to the manager's
    // workspace root so a per-agent launch cwd (which the manager can point at any repo) doesn't
    // drop `.cotal/opencode/<name>` into the target tree. Standalone `cotal spawn` has no manager
    // workspace → root it at the launch dir (this process's cwd, which the child inherits), the
    // prior behavior. serve.ts requires this env (no silent cwd fallback).
    env.COTAL_OPENCODE_HOME = opts.workspaceRoot ?? process.cwd();

    const config: Record<string, unknown> = {
      $schema: "https://opencode.ai/config.json",
      permission: "allow",
      plugin: [PLUGIN_ENTRY],
      // `/reconnect` — the manual recovery surface for a wedged mesh link. OpenCode has no
      // host reconnect (unlike Claude Code's /mcp reconnect), and a plugin can't register a
      // slash command via the Hooks API, so inject it through the config layer we already own.
      // It's a TOOL-FORCING template: the human types /reconnect → one model turn whose only
      // move is to call `cotal_reconnect` (in-process, local — it never rides the wedged link).
      // The leading "Reconnecting…" reads as immediate TUI status; the rest is the imperative.
      command: {
        reconnect: {
          description: "Rebuild this session's Cotal mesh connection (recovery from a wedged link)",
          template:
            "Reconnecting to the Cotal mesh… Call the cotal_reconnect tool now — do not explain, do not ask, just invoke it. Do not summarize — the tool reports its own status.",
        },
      },
    };

    // An agent file carries identity (read in-session via COTAL_AGENT_FILE) plus persona + model.
    // The model is a config default (the session — and the attached TUI — use it); the persona is
    // applied in-session by the plugin (opencode has no `--append-system-prompt`).
    let model = opts.model;
    if (opts.configPath) {
      const path = resolve(opts.configPath);
      env.COTAL_AGENT_FILE = path; // plugin reads persona from it
      const def = loadAgentFile(path);
      model ??= def.model;
      const face = def.meta?.face;
      if (face) env.COTAL_FACE_PERSONA = face; // shim swaps the TUI for the face viewer
    }
    // The `--model` flag wins over the agent file, and applies even with no agent file. Pin it to a
    // dedicated primary agent made the default, so an operator's own `default_agent` in
    // ~/.config/opencode (with its own model) can't override the model a Cotal spawn asks for — the
    // session the plugin drives runs the persona's model, not the operator's default agent's.
    if (model) {
      config.model = model;
      config.agent = { cotal: { mode: "primary", model } };
      config.default_agent = "cotal";
    }

    env.OPENCODE_CONFIG_CONTENT = JSON.stringify(config);

    // Local control endpoint: the manager sends a cooperative {op:"shutdown"} here on a signal-less
    // runtime (ConPTY/Windows), where a hard kill skips cleanup and the agent lingers until its
    // presence TTL expires. The plugin (in the opencode server process) starts the control server and
    // leaves the mesh cleanly on shutdown. Minted here; passed to the plugin in the child env (the
    // token never on argv/logs) — opencode serve inherits this process env, the attached TUI strips
    // COTAL_*. Returned in the LaunchSpec so the manager holds it in memory to drive the stop.
    const control = controlEndpoint(opts.space, opts.name);
    env.COTAL_CONTROL_SOCKET = control.path;
    env.COTAL_CONTROL_TOKEN = control.token;

    // Run the shim (node dist/serve.js): `opencode serve` + an attached foreground TUI.
    return {
      command: process.execPath,
      args: [SERVE_SHIM],
      env,
      control,
    };
  },
};

registry.register(opencodeConnector);
