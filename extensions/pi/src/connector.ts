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
  materialEnv,
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

    // Minted before the env is built: the token goes into the launch material, the path into the env.
    const control = controlEndpoint(opts.space, opts.name);
    const env: Record<string, string> = {
      ...launchEnv({ providerKeys: PI_PROVIDER_KEYS }),
      ...aclEnv(opts),
      // Creds, broker URL and the control token ride a 0600 file; only its path is exported, and the
      // extension drops even that once it has read it, so a shell this seat runs inherits neither.
      ...materialEnv({ creds: opts.creds, servers: opts.servers, controlToken: control.token, userAuth: opts.userAuth }),
      COTAL_SPACE: opts.space,
      COTAL_NAME: opts.name,
    };
    if (opts.role) env.COTAL_ROLE = opts.role;
    if (opts.id) env.COTAL_ID = opts.id;
    if (opts.lifecycleUid) env.COTAL_LIFECYCLE_UID = opts.lifecycleUid;
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
    // The auto-submitted first turn (`cotal spawn --prompt`). Pi takes it as its positional initial
    // message, which its parser reads as any bare argument, so it goes LAST, after every flag that
    // consumes a value. A message Pi's parser would misread cannot be delivered as a turn, so refuse
    // the launch rather than start a seat whose first turn silently became a flag or a file ref.
    if (opts.prompt !== undefined) {
      const prompt = opts.prompt.trim();
      if (!prompt) throw new Error("pi connector: an initial prompt was given but it is empty, there is no first turn to submit");
      if (prompt.startsWith("-") || prompt.startsWith("@"))
        throw new Error("pi connector: an initial prompt cannot start with '-' or '@' (pi reads those as an option or a file reference); reword it");
      args.push(prompt);
    }

    env.COTAL_CONTROL_SOCKET = control.path;
    return { command: "pi", args, env, control };
  },
};

registry.register(piConnector);
