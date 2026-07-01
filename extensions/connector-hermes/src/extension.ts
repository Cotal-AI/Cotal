import { fileURLToPath } from "node:url";
import { loadAgentFile, registry, type Connector, type LaunchOpts, type LaunchSpec } from "@cotal-ai/core";
import { aclEnv, launchEnv, MODEL_PROVIDER_KEYS } from "@cotal-ai/connector-core";

/** The launcher (run via tsx, which loads both) owns the mesh endpoint and supervises the Hermes
 *  gateway as a child — see launch.ts. Resolve `.ts` when this module loads from source (dev) and
 *  `.js` when it loads from the build: the package's `import` resolves to dist/, so a hardcoded
 *  `./launch.ts` would point at a file tsc never emits. */
const ENTRY_EXT = import.meta.url.includes("/dist/") ? "js" : "ts";
const TSX = fileURLToPath(new URL("../node_modules/.bin/tsx", import.meta.url));
const LAUNCH_ENTRY = fileURLToPath(new URL(`./launch.${ENTRY_EXT}`, import.meta.url));

/**
 * The Hermes (Nous Research) connector. Unlike Claude Code / Codex — where the harness *is* the
 * process and an MCP server rides inside it — Hermes runs as a long-lived **gateway daemon** that
 * spins up a fresh `AIAgent` per inbound message. So the mesh endpoint can't live inside a
 * per-turn MCP server; it must outlive every turn. The connector's command is therefore a small
 * **launcher/supervisor** (`launch.ts`) that owns the {@link MeshAgent} for the gateway's whole
 * life, bridges to an in-gateway Python plugin (platform adapter + hooks + tools) over two local
 * sockets, and spawns `hermes gateway run` as its child. Self-registers on import; the manager
 * resolves it by agent type "hermes".
 */
export const hermesConnector: Connector = {
  kind: "connector",
  name: "hermes",
  requires: ["hermes"],
  buildLaunch(opts: LaunchOpts): LaunchSpec {
    // Hermes is Unix-only: its sidecar bridge + hook relay use AF_UNIX `.sock` paths and a Python
    // sidecar, none of which are ported to Windows. Fail loud rather than launch a half-wired agent
    // the manager can't drive (no Windows named-pipe bridge, no cooperative shutdown). No fallback.
    if (process.platform === "win32")
      throw new Error("the Hermes connector is Unix-only (AF_UNIX bridge + Python sidecar) — not supported on Windows");
    // Resuming an existing session isn't supported by Hermes (no fork-from-transcript primitive in
    // the gateway launcher). Throw rather than spawn fresh silently — this connector otherwise
    // ignores opts it doesn't render, so without this guard `resume` would be dropped without a word.
    if (opts.resume)
      throw new Error("the Hermes connector does not support resuming an existing session (resume)");
    // OS allow-list + the named model-provider key (Hermes is model-agnostic; any one unlocks a
    // provider), forwarded BY NAME — never `...process.env` — so the operator's unrelated secrets
    // don't reach the gateway child (P3).
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
    // An agent file carries identity + persona + model; the launcher applies the persona as
    // Hermes' SOUL.md (system prompt) at gateway startup, the one place it can be set.
    if (opts.configPath) env.COTAL_AGENT_FILE = opts.configPath;
    // Model precedence, at parity with the Claude/OpenCode connectors: the `--model` flag, else the
    // agent file's `model:`, else an ambient HERMES_MODEL. The launcher reads HERMES_MODEL as the
    // gateway model — resolving here is the one place that honors the file's model for Hermes.
    const fileModel = opts.configPath ? loadAgentFile(opts.configPath).model : undefined;
    const model = opts.model ?? fileModel ?? process.env.HERMES_MODEL;
    if (model) env.HERMES_MODEL = model;
    return { command: TSX, args: [LAUNCH_ENTRY], env };
  },
};

registry.register(hermesConnector);
