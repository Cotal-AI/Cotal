// connector-agy — Connector extension (loaded by the cotal CLI / manager).
//
// buildLaunch returns a Node shim (dist/serve.js) that owns ONE MeshAgent and drives the
// Google Antigravity CLI (`agy`) as a chain of non-interactive `agy -p` turns (each wrapped
// in a pseudo-TTY via `script -qec`), with the cotal_* tool surface served to agy over a
// local streamable-HTTP MCP server wired in through the GLOBAL
// ~/.gemini/config/mcp_config.json (agy has no per-invocation MCP flag).
//
// Template: @cotal-ai/connector-codex (shim pattern). @cotal-ai/core stays external
// (peer dependency — `cotal ext add` links it to the CLI's copy); connector-core helpers
// are bundled in.
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { loadAgentFile, registry, type Connector, type LaunchOpts, type LaunchSpec } from "@cotal-ai/core";
import {
  MODEL_PROVIDER_KEYS,
  launchEnv,
  aclEnv,
  userAuthEnv,
  connectorLaunchOptions,
  controlEndpoint,
} from "@cotal-ai/connector-core";

const SERVE_SHIM = fileURLToPath(new URL("./serve.js", import.meta.url));

export const agyConnector: Connector = {
  kind: "connector",
  name: "agy",
  requires: ["agy", "script"], // script(1) provides the load-bearing pseudo-TTY wrapper
  // agy bakes the reasoning level into the model display name ("Gemini 3.1 Pro (High)") —
  // there is no separate variant/effort flag.
  supportsModelVariant: false,
  // v1 fail-loud surface: no resume, no transcript mirror (no transcriptChannel), no tool-sharing.
  buildLaunch(opts: LaunchOpts): LaunchSpec {
    if (opts.resume)
      throw new Error(
        "agy connector: resuming/forking an existing session (resume) is not implemented (v1) — spawn fresh instead.",
      );
    if (opts.mcpServers && Object.keys(opts.mcpServers).length > 0)
      throw new Error(
        "agy connector: sharing operator MCP servers with the agent is not implemented (v1).",
      );
    if (opts.transcript === true)
      throw new Error("agy connector: transcript mirroring is not implemented (v1).");

    const env: Record<string, string> = {
      ...launchEnv({ providerKeys: MODEL_PROVIDER_KEYS }),
      ...aclEnv(opts),
      ...userAuthEnv(opts),
      COTAL_SPACE: opts.space,
      COTAL_NAME: opts.name,
    };
    if (opts.role) env.COTAL_ROLE = opts.role;
    if (opts.id) env.COTAL_ID = opts.id;
    if (opts.creds) env.COTAL_CREDS = opts.creds;
    if (opts.servers) env.COTAL_SERVERS = opts.servers;
    if (opts.prompt) env.COTAL_AGY_PROMPT = opts.prompt;
    // Working root for agy turns (stable cwd for every spawned turn). The manager's
    // workspace by default.
    env.COTAL_AGY_HOME = opts.workspaceRoot ?? process.cwd();

    let model = opts.model;
    let variant = opts.variant;
    if (opts.configPath) {
      const path = resolve(opts.configPath);
      env.COTAL_AGENT_FILE = path;
      const def = loadAgentFile(path);
      model ??= def.model;
      variant ??= def.variant;
    }
    if (variant)
      throw new Error(
        `agy connector: model variants are not supported — the reasoning level is baked into the agy model display name (e.g. "Gemini 3.1 Pro (High)"). Remove "variant: ${variant}" and pick the level via the model name.`,
      );
    if (model) env.COTAL_MODEL = model;

    // agy has no config-override surface — fail loud instead of silently dropping options.
    const unsupported = [...connectorLaunchOptions("agy", opts.launchOptions)];
    if (unsupported.length)
      throw new Error(
        `agy connector: launchOptions are not supported (v1) — got: ${unsupported.map(([k]) => k).join(", ")}`,
      );

    const control = controlEndpoint(opts.space, opts.name);
    env.COTAL_CONTROL_SOCKET = control.path;
    env.COTAL_CONTROL_TOKEN = control.token;

    return {
      command: process.execPath,
      args: [SERVE_SHIM],
      env,
      control,
    };
  },
};

registry.register(agyConnector);
