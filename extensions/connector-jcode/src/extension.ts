import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { loadAgentFile, registry, type Connector, type LaunchOpts, type LaunchSpec } from "@cotal-ai/core";
import { aclEnv, connectorLaunchOptions, controlEndpoint, launchEnv, materialEnv } from "@cotal-ai/connector-core";

const FROM_BUILD = import.meta.url.includes("/dist/");
const HOST_ENTRY = fileURLToPath(new URL(`./${FROM_BUILD ? "host.js" : "host-main.ts"}`, import.meta.url));
const HOST_COMMAND = FROM_BUILD
  ? process.execPath
  : fileURLToPath(new URL("../node_modules/.bin/tsx", import.meta.url));

/**
 * Jcode's stable Harness API is the supported integration seam: the host creates one private
 * `JcodeClient.launch()` instance and drives its one session. The managed JCODE_HOME also contains
 * a per-seat `.jcode/mcp.json`, so the harness spawns this package's stdio MCP bridge and calls the
 * shared cotal_* tool surface without inheriting Cotal's launch material.
 */
export const jcodeConnector: Connector = {
  kind: "connector",
  name: "jcode",
  requires: ["jcode"],
  // variant = Jcode's per-session reasoning effort (`set_reasoning_effort`). The accepted tiers are
  // per provider AND per model, and the Harness API publishes no ladder to check against — so the
  // tier is carried verbatim and validated at launch by Jcode itself, which owns that catalog and
  // names the accepted set when it refuses. Copying the ladder here would be a second table that
  // can disagree with the one that decides.
  supportsModelVariant: true,
  launchHint: "starting Jcode and joining the mesh",

  buildLaunch(opts: LaunchOpts): LaunchSpec {
    if (process.platform === "win32")
      throw new Error("jcode connector is not supported on Windows — Jcode's released Harness API bridge is a Unix-socket surface");
    if (opts.continueSession)
      throw new Error("jcode connector does not support exact-session continuation — its private Harness API instance is retired with the seat");
    if (opts.resume)
      throw new Error("jcode connector: resuming an existing session is not supported — the private Harness API instance never shares a session with another seat");
    if (opts.mcpServers && Object.keys(opts.mcpServers).length > 0)
      throw new Error("jcode connector: tool-sharing (connectors.jcode.mcpServers) is not implemented — the connector owns the private MCP configuration that carries cotal_*");

    const control = controlEndpoint(opts.space, opts.name);
    const env: Record<string, string> = {
      ...launchEnv({ envAllow: opts.envAllow }),
      ...aclEnv(opts),
      ...materialEnv({ creds: opts.creds, servers: opts.servers, controlToken: control.token, userAuth: opts.userAuth }),
      COTAL_SPACE: opts.space,
      COTAL_NAME: opts.name,
      COTAL_CONTROL_SOCKET: control.path,
      COTAL_JCODE_HOME: opts.workspaceRoot ?? process.cwd(),
    };
    if (opts.role) env.COTAL_ROLE = opts.role;
    if (opts.id) env.COTAL_ID = opts.id;
    if (opts.lifecycleUid) env.COTAL_LIFECYCLE_UID = opts.lifecycleUid;
    // Like Codex, the TUI decision belongs to the process that builds this launch. A foreground
    // spawn reads the operator shell; a detached spawn is built in the manager and reads its env.
    // It must cross explicitly because launchEnv resets the per-session COTAL_* namespace.
    const tui = process.env.COTAL_JCODE_TUI?.trim();
    if (tui) env.COTAL_JCODE_TUI = tui;

    if (opts.prompt !== undefined) {
      const prompt = opts.prompt.trim();
      if (!prompt)
        throw new Error("jcode connector: an initial prompt was given but it is empty — there is no first turn to submit");
      env.COTAL_JCODE_PROMPT = prompt;
    }

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
    // The reasoning effort the host applies to the session before its first turn. A whitespace-only
    // tier is refused rather than dropped: it would otherwise read as an honored request while the
    // seat silently ran at Jcode's own default.
    if (variant !== undefined) {
      variant = variant.trim();
      if (!variant)
        throw new Error("jcode connector: a model variant was given but it is empty — there is no reasoning effort to select");
      env.COTAL_VARIANT = variant;
    }

    // The Harness API exposes model selection, but no stable generic equivalent to arbitrary
    // CLI/config overrides. Do not accept `--opt` merely because Jcode's TUI has flags: an option
    // this host cannot render would otherwise look honored while being dropped.
    const launchOptions = connectorLaunchOptions("jcode", opts.launchOptions);
    if (launchOptions.length)
      throw new Error(
        `jcode connector: launch options are not supported by the Harness API host (first option: ${launchOptions[0][0]})`,
      );

    return { command: HOST_COMMAND, args: [HOST_ENTRY], env, control };
  },
};

registry.register(jcodeConnector);
