import { fileURLToPath } from "node:url";
import { loadAgentFile, registry, type Connector, type LaunchOpts, type LaunchSpec } from "@cotal-ai/core";
import { aclEnv, launchEnv, MODEL_PROVIDER_KEYS, materialEnv } from "@cotal-ai/connector-core";

/** The launcher owns the mesh endpoint and supervises the Hermes gateway as a child — see launch.ts.
 *  From the BUILD, `launch.js` is a self-contained ESM bundle (core + connector-core inlined): run it with
 *  this same node, so an installed plugin needs no `tsx` on disk. From SOURCE (dev, the package's
 *  `import` resolves to src/), run the `.ts` entry through tsx. */
const FROM_BUILD = import.meta.url.includes("/dist/");
const LAUNCH_ENTRY = fileURLToPath(new URL(`./launch.${FROM_BUILD ? "js" : "ts"}`, import.meta.url));
const LAUNCH_COMMAND = FROM_BUILD
  ? process.execPath
  : fileURLToPath(new URL("../node_modules/.bin/tsx", import.meta.url));

/**
 * Every model-provider API key Hermes itself can read, beyond the shared
 * {@link MODEL_PROVIDER_KEYS}. Hermes is model-agnostic across its own provider registry
 * (hermes_cli, pinned 0.16 line), and each of these names is that registry's dedicated
 * `api_key_env_vars` entry for one model provider — without them the P3 filter strips the
 * key before it reaches the gateway, so e.g. the opencode-go provider could never
 * authenticate in a managed or containerized spawn. Still forwarded BY NAME, never
 * `...process.env`.
 *
 * Deliberately excluded: generic cross-tool credentials Hermes also accepts
 * (`GH_TOKEN`/`GITHUB_TOKEN`/`COPILOT_GITHUB_TOKEN`, `HF_TOKEN`, `ANTHROPIC_TOKEN`,
 * `CLAUDE_CODE_OAUTH_TOKEN`, and `GOOGLE_API_KEY` — a generic Google Cloud API key, not a
 * Gemini-only credential) — auto-forwarding an operator's VCS, Claude-session, or
 * cloud-wide credential into every gateway would silently widen its blast radius —
 * `LM_API_KEY` (LM Studio is a localhost server a managed gateway cannot reach anyway),
 * and `QWEN_API_KEY` (Hermes 0.16 Qwen auth is OAuth-only; that profile metadata is never
 * read as a key). Exported for the launch-env smoke, which pins both sets.
 */
export const HERMES_PROVIDER_KEYS: readonly string[] = [
  ...MODEL_PROVIDER_KEYS,
  "OPENCODE_GO_API_KEY",
  "OPENCODE_ZEN_API_KEY",
  "XAI_API_KEY",
  "GEMINI_API_KEY",
  "NOVITA_API_KEY",
  "DEEPSEEK_API_KEY",
  "GLM_API_KEY",
  "ZAI_API_KEY",
  "Z_AI_API_KEY",
  "KIMI_API_KEY",
  "KIMI_CODING_API_KEY",
  "KIMI_CN_API_KEY",
  "MINIMAX_API_KEY",
  "MINIMAX_CN_API_KEY",
  "DASHSCOPE_API_KEY",
  "ALIBABA_CODING_PLAN_API_KEY",
  "STEPFUN_API_KEY",
  "ARCEEAI_API_KEY",
  "GMI_API_KEY",
  "NVIDIA_API_KEY",
  "KILOCODE_API_KEY",
  "XIAOMI_API_KEY",
  "TOKENHUB_API_KEY",
  "OLLAMA_API_KEY",
  "AZURE_FOUNDRY_API_KEY",
];

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
    if (opts.variant) throw new Error("the Hermes connector does not support model variants (variant)");
    // Same rule for the initial prompt: the gateway has no first-turn carrier wired, and a prompt
    // that is accepted and never submitted leaves the operator waiting on a turn that never starts.
    if (opts.prompt !== undefined)
      throw new Error("the Hermes connector does not support an initial prompt (prompt): its first turn is not wired yet");
    // The Hermes launcher reads a FIXED set of env vars, so it has no generic launch-option surface —
    // rendering arbitrary options to env would silently drop them. Fail loud rather than pretend.
    if (opts.launchOptions && Object.keys(opts.launchOptions).length)
      throw new Error("the Hermes connector does not support launch options (--opt / launchOptions)");
    // OS allow-list + the named model-provider keys (Hermes is model-agnostic; any one unlocks a
    // provider), forwarded BY NAME — never `...process.env` — so the operator's unrelated secrets
    // don't reach the gateway child (P3).
    const env: Record<string, string> = {
      ...launchEnv({ providerKeys: HERMES_PROVIDER_KEYS }),
      ...aclEnv(opts),
      // Creds and broker URL ride a 0600 file; only its path is exported. This connector's launcher
      // mints the control endpoint itself and merges the token into the same file (see launch.ts).
      ...materialEnv({ creds: opts.creds, servers: opts.servers, userAuth: opts.userAuth }),
      COTAL_SPACE: opts.space,
      COTAL_NAME: opts.name,
    };
    if (opts.role) env.COTAL_ROLE = opts.role;
    if (opts.id) env.COTAL_ID = opts.id;
    if (opts.lifecycleUid) env.COTAL_LIFECYCLE_UID = opts.lifecycleUid;
    // An agent file carries identity + persona + model; the launcher applies the persona as
    // Hermes' SOUL.md (system prompt) at gateway startup, the one place it can be set.
    if (opts.configPath) env.COTAL_AGENT_FILE = opts.configPath;
    // Model precedence, at parity with the Claude/OpenCode connectors: the `--model` flag, else the
    // agent file's `model:`, else an ambient HERMES_MODEL. The launcher reads HERMES_MODEL as the
    // gateway model — resolving here is the one place that honors the file's model for Hermes.
    const fileModel = opts.configPath ? loadAgentFile(opts.configPath).model : undefined;
    const model = opts.model ?? fileModel ?? process.env.HERMES_MODEL;
    if (model) {
      env.HERMES_MODEL = model;
      env.COTAL_MODEL = model;
    }
    return { command: LAUNCH_COMMAND, args: [LAUNCH_ENTRY], env };
  },
};

registry.register(hermesConnector);
