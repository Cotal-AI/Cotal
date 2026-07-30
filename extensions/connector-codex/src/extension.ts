import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import {
  loadAgentFile,
  registry,
  type Connector,
  type LaunchOpts,
  type LaunchSpec,
} from "@cotal-ai/core";
import {
  aclEnv,
  connectorLaunchOptions,
  controlEndpoint,
  launchEnv,
  userAuthEnv,
} from "@cotal-ai/connector-core";

const HOST_ENTRY = fileURLToPath(new URL("./host.js", import.meta.url));

/**
 * Codex stays a pluggable edge: this launch shim owns one live app-server and attached TUI while
 * connector-core owns mesh identity, delivery, and cotal_* tools.
 */
export const codexConnector: Connector = {
  kind: "connector",
  name: "codex",
  requires: ["codex"],
  supportsModelVariant: true,

  buildLaunch(opts: LaunchOpts): LaunchSpec {
    if (process.platform === "win32")
      throw new Error(
        "codex connector: Windows is not supported yet — the live TUI bridge currently requires Codex app-server's Unix-socket transport",
      );
    if (opts.resume)
      throw new Error(
        "codex connector: resume is not implemented — a Cotal resume must fork the source thread, never hijack it",
      );
    if (opts.transcript === true)
      throw new Error("codex connector: transcript mirroring is not implemented");
    if (opts.mcpServers && Object.keys(opts.mcpServers).length > 0)
      throw new Error(
        "codex connector: connectors.codex.mcpServers sharing is not implemented; Codex reads its existing user config without Cotal mutating it",
      );

    const control = controlEndpoint(opts.space, opts.name);
    const env: Record<string, string> = {
      // HOME/XDG roots preserve the user's existing Codex/ChatGPT login. No model-provider key is
      // copied: Codex authenticates through its own login store, and OPENAI_API_KEY is not required.
      ...launchEnv(),
      ...aclEnv(opts),
      ...userAuthEnv(opts),
      COTAL_SPACE: opts.space,
      COTAL_NAME: opts.name,
      COTAL_CONTROL_SOCKET: control.path,
      COTAL_CONTROL_TOKEN: control.token,
    };
    if (opts.role) env.COTAL_ROLE = opts.role;
    if (opts.id) env.COTAL_ID = opts.id;
    if (opts.lifecycleUid) env.COTAL_LIFECYCLE_UID = opts.lifecycleUid;
    if (opts.creds) env.COTAL_CREDS = opts.creds;
    if (opts.servers) env.COTAL_SERVERS = opts.servers;
    if (opts.prompt) env.COTAL_CODEX_PROMPT = opts.prompt;

    let model = opts.model;
    let variant = opts.variant;
    if (opts.configPath) {
      const path = resolve(opts.configPath);
      env.COTAL_AGENT_FILE = path;
      const definition = loadAgentFile(path);
      model ??= definition.model;
      variant ??= definition.variant;
    }
    if (model) {
      env.COTAL_MODEL = model;
      env.COTAL_CODEX_MODEL = model;
    }
    if (variant) {
      env.COTAL_VARIANT = variant;
      env.COTAL_CODEX_EFFORT = variant;
    }

    const threadConfig = Object.fromEntries(
      connectorLaunchOptions("codex", opts.launchOptions),
    );
    if (Object.keys(threadConfig).length > 0)
      env.COTAL_CODEX_THREAD_CONFIG = JSON.stringify(threadConfig);

    return {
      command: process.execPath,
      args: [HOST_ENTRY],
      env,
      control,
    };
  },
};

registry.register(codexConnector);
