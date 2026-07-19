// connector-codex — Connector extension (loaded by the cotal CLI / manager).
//
// buildLaunch returns a Node shim (dist/serve.js) that owns ONE MeshAgent and drives the
// OpenAI Codex CLI as a chain of `codex exec` / `codex exec resume <threadId>` turns, with
// the cotal_* tool surface served to codex over a local streamable-HTTP MCP server.
//
// Template: @cotal-ai/connector-opencode (shim pattern). @cotal-ai/core stays external
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

export const codexConnector: Connector = {
  kind: "connector",
  name: "codex",
  requires: ["codex"],
  supportsModelVariant: true, // variant → `-c model_reasoning_effort="<variant>"`
  // v1 fail-loud surface: no resume, no transcript mirror (no transcriptChannel), no tool-sharing.
  buildLaunch(opts: LaunchOpts): LaunchSpec {
    if (opts.resume)
      throw new Error(
        "codex connector: resuming/forking an existing session (resume) is not implemented (v1) — spawn fresh instead.",
      );
    if (opts.mcpServers && Object.keys(opts.mcpServers).length > 0)
      throw new Error(
        "codex connector: sharing operator MCP servers with the agent is not implemented (v1).",
      );
    if (opts.transcript === true)
      throw new Error("codex connector: transcript mirroring is not implemented (v1).");

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
    if (opts.prompt) env.COTAL_CODEX_PROMPT = opts.prompt;
    // Working root for codex turns (and any per-agent state). The manager's workspace by default.
    env.COTAL_CODEX_HOME = opts.workspaceRoot ?? process.cwd();

    let model = opts.model;
    let variant = opts.variant;
    if (opts.configPath) {
      const path = resolve(opts.configPath);
      env.COTAL_AGENT_FILE = path;
      const def = loadAgentFile(path);
      model ??= def.model;
      variant ??= def.variant;
    }
    if (model) env.COTAL_MODEL = model;
    if (variant) env.COTAL_VARIANT = variant;

    // launchOptions → raw `-c key=value` codex config overrides (the connector's option surface).
    const overrides: string[] = [];
    for (const [k, v] of connectorLaunchOptions("codex", opts.launchOptions))
      overrides.push(`${k}=${typeof v === "string" ? v : JSON.stringify(v)}`);
    if (overrides.length) env.COTAL_CODEX_OVERRIDES = JSON.stringify(overrides);

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

registry.register(codexConnector);
