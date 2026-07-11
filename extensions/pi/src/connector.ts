import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  hardenPrivate,
  loadAgentFile,
  registry,
  writeSecretFile,
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

const STANDALONE = fileURLToPath(
  import.meta.url.includes("/dist/") ? new URL("./standalone.js", import.meta.url) : new URL("../dist/standalone.js", import.meta.url),
);

/** Provider environment names recognized by the pinned Pi 0.79.10 host. Kept Pi-local so adding a
 * provider here never expands the secret surface of sibling connectors. */
const PI_PROVIDER_KEYS = [
  "ANTHROPIC_OAUTH_TOKEN",
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
  "OPENROUTER_API_KEY",
  "OPENCODE_API_KEY",
  "GEMINI_API_KEY",
  "GOOGLE_CLOUD_API_KEY",
  "GROQ_API_KEY",
  "CEREBRAS_API_KEY",
  "DEEPSEEK_API_KEY",
  "MISTRAL_API_KEY",
  "XAI_API_KEY",
  "ZAI_API_KEY",
  "ZAI_CODING_CN_API_KEY",
  "MINIMAX_API_KEY",
  "MINIMAX_CN_API_KEY",
  "MOONSHOT_API_KEY",
  "FIREWORKS_API_KEY",
  "TOGETHER_API_KEY",
  "NVIDIA_API_KEY",
  "KIMI_API_KEY",
  "HF_TOKEN",
  "COPILOT_GITHUB_TOKEN",
  "AI_GATEWAY_API_KEY",
  "CLOUDFLARE_API_KEY",
  "XIAOMI_API_KEY",
  "XIAOMI_TOKEN_PLAN_CN_API_KEY",
  "XIAOMI_TOKEN_PLAN_AMS_API_KEY",
  "XIAOMI_TOKEN_PLAN_SGP_API_KEY",
] as const;

export const piConnector: Connector = {
  kind: "connector",
  name: "pi",
  requires: ["pi"],
  buildLaunch(opts: LaunchOpts): LaunchSpec {
    if (opts.resume)
      throw new Error("pi connector: resuming an existing session (resume) is not implemented");
    if (opts.variant) throw new Error("pi connector: model variants (variant) are not implemented");
    if (opts.mcpServers && Object.keys(opts.mcpServers).length > 0)
      throw new Error("pi connector: MCP tool-sharing is not implemented");
    if (connectorLaunchOptions("pi", opts.launchOptions).length > 0)
      throw new Error("pi connector: launch options (--opt / launchOptions) are not implemented");

    let model = opts.model;
    let persona: string | undefined;
    if (opts.configPath) {
      const definition = loadAgentFile(opts.configPath);
      model ??= definition.model;
      persona = definition.persona;
    }

    const env: Record<string, string> = {
      ...launchEnv({ providerKeys: PI_PROVIDER_KEYS }),
      ...aclEnv(opts),
      ...userAuthEnv(opts),
      COTAL_SPACE: opts.space,
      COTAL_NAME: opts.name,
    };
    if (opts.role) env.COTAL_ROLE = opts.role;
    if (opts.id) env.COTAL_ID = opts.id;
    if (opts.creds) env.COTAL_CREDS = opts.creds;
    if (opts.servers) env.COTAL_SERVERS = opts.servers;
    if (opts.configPath) env.COTAL_AGENT_FILE = opts.configPath;

    const args = ["--extension", STANDALONE];
    if (persona) {
      const dir = mkdtempSync(join(tmpdir(), "cotal-persona-"));
      hardenPrivate(dir, "dir");
      const file = join(dir, "persona.md");
      writeSecretFile(file, persona);
      env.COTAL_PI_PERSONA_FILE = file;
      args.push("--append-system-prompt", file);
    }
    if (model) {
      env.COTAL_MODEL = model;
      args.push("--model", model);
    }

    const control = controlEndpoint(opts.space, opts.name);
    env.COTAL_CONTROL_SOCKET = control.path;
    env.COTAL_CONTROL_TOKEN = control.token;
    return { command: "pi", args, env, control };
  },
};

registry.register(piConnector);
