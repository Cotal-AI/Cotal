import { fileURLToPath } from "node:url";
import { registry, type Connector, type LaunchOpts, type LaunchSpec } from "@cotal-ai/core";

/** The peer loop runs via tsx (resolved from this extension's own node_modules, so it works
 *  regardless of the spawned process's PATH/cwd). `main` is loaded with the same extension as
 *  this module — `main.ts` when running from source (dev), `main.js` when running from built
 *  `dist/` — so the entrypoint resolves to a file that actually exists in either mode. */
const ext = import.meta.url.endsWith(".ts") ? ".ts" : ".js";
const TSX = fileURLToPath(new URL("../node_modules/.bin/tsx", import.meta.url));
const MAIN = fileURLToPath(new URL(`./main${ext}`, import.meta.url));

/** Provider API keys pi resolves from the environment (AuthStorage falls back to env).
 *  Forwarded when present so a spawned peer has credentials for its model. */
const PROVIDER_KEYS = [
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
  "GEMINI_API_KEY",
  "GOOGLE_API_KEY",
  "GROQ_API_KEY",
  "XAI_API_KEY",
  "DEEPSEEK_API_KEY",
  "MISTRAL_API_KEY",
  "OPENROUTER_API_KEY",
];

/**
 * The pi connector: launches an embedded Cotal peer that runs the pi coding-agent SDK
 * loop and answers mesh traffic as a lateral peer. Inbound drives the loop directly
 * (prompt to wake, steer to interject mid-turn). Forwards the launcher's identity +
 * minted creds so the peer authenticates as `id` under auth. Self-registers on import;
 * the manager resolves it by agent type "pi".
 */
export const piConnector: Connector = {
  kind: "connector",
  name: "pi",
  buildLaunch(opts: LaunchOpts): LaunchSpec {
    const env: Record<string, string> = { COTAL_SPACE: opts.space, COTAL_NAME: opts.name };
    if (opts.role) env.COTAL_ROLE = opts.role;
    if (opts.id) env.COTAL_ID = opts.id;
    if (opts.creds) env.COTAL_CREDS = opts.creds;
    if (opts.servers) env.COTAL_SERVERS = opts.servers;
    if (opts.configPath) env.COTAL_AGENT_FILE = opts.configPath;
    for (const key of PROVIDER_KEYS) {
      const value = process.env[key];
      if (value) env[key] = value;
    }
    return { command: TSX, args: [MAIN], env };
  },
};

registry.register(piConnector);
