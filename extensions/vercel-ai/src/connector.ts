import { fileURLToPath } from "node:url";
import { registry, type Connector, type LaunchOpts, type LaunchSpec } from "@cotal-ai/core";

/** The peer loop runs via tsx (resolved from this extension's own node_modules, so it works
 *  regardless of the spawned process's PATH/cwd). `main` is loaded with the same extension as
 *  this module — `main.ts` when running from source (dev), `main.js` when running from built
 *  `dist/` — so the entrypoint resolves to a file that actually exists in either mode. */
const ext = import.meta.url.endsWith(".ts") ? ".ts" : ".js";
const TSX = fileURLToPath(new URL("../node_modules/.bin/tsx", import.meta.url));
const MAIN = fileURLToPath(new URL(`./main${ext}`, import.meta.url));

/**
 * The Vercel AI SDK connector: launches an embedded Cotal peer that drives a
 * `generateText` loop and answers mesh traffic as a lateral peer. Forwards the
 * launcher's identity + minted creds so the peer authenticates as `id` under auth.
 * Self-registers on import; the manager resolves it by agent type "vercel-ai".
 */
export const vercelAiConnector: Connector = {
  kind: "connector",
  name: "vercel-ai",
  buildLaunch(opts: LaunchOpts): LaunchSpec {
    const env: Record<string, string> = { COTAL_SPACE: opts.space, COTAL_NAME: opts.name };
    if (opts.role) env.COTAL_ROLE = opts.role;
    if (opts.id) env.COTAL_ID = opts.id;
    if (opts.creds) env.COTAL_CREDS = opts.creds;
    if (opts.servers) env.COTAL_SERVERS = opts.servers;
    if (opts.configPath) env.COTAL_AGENT_FILE = opts.configPath;
    if (process.env.OPENAI_API_KEY) env.OPENAI_API_KEY = process.env.OPENAI_API_KEY;
    if (process.env.OPENAI_MODEL) env.OPENAI_MODEL = process.env.OPENAI_MODEL;
    return { command: TSX, args: [MAIN], env };
  },
};

registry.register(vercelAiConnector);
