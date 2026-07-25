import { fileURLToPath } from "node:url";
import { loadAgentFile, registry, type Connector, type LaunchOpts, type LaunchSpec } from "@cotal-ai/core";
import { aclEnv, launchEnv } from "@cotal-ai/connector-core";
import { autoReplyEnabled } from "./reply-policy.js";

/** The peer loop runs via tsx when launched from source (.ts, dev) or via node directly
 *  when launched from built dist (.js). Using node for the built artifact matters: the
 *  manager's pty runtime sends SIGTERM to the spawned command on `cotal stop`, and a
 *  tsx wrapper does not forward that signal to its node child (the child is SIGKILLed
 *  after the grace window instead of running its shutdown handler). Running the built
 *  .js with node lets the peer's SIGTERM/SIGINT handlers fire for a clean mesh
 *  disconnect + raw-mode restore. `main` is loaded with the same extension as this
 *  module — `main.ts` in dev, `main.js` from built `dist/` — so the entrypoint
 *  resolves to a file that actually exists in either mode. */
const ext = import.meta.url.endsWith(".ts") ? ".ts" : ".js";
const MAIN = fileURLToPath(new URL(`./main${ext}`, import.meta.url));
const CMD = ext === ".ts"
  ? fileURLToPath(new URL("../node_modules/.bin/tsx", import.meta.url)) // dev: tsx transpiles .ts
  : process.execPath;                                                   // built: node runs .js + forwards signals

/** Provider API keys pi resolves from the environment (AuthStorage falls back to env).
 *  Forwarded when present so a spawned peer has credentials for its model. */
export const PROVIDER_KEYS = [
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
 * minted creds so the peer authenticates as `id` under auth. Parses the agent file at
 * launch (so a malformed persona fails loud at `cotal start`, matching the sibling
 * connectors) and forwards the resolved model (`COTAL_MODEL`); the runtime path reads
 * the persona body from the agent file and injects it as the system prompt, so a
 * spawned peer runs as its declared persona. `PI_PEER_MODE=interactive` (or the agent file's
 * `peerMode: interactive` frontmatter hint) runs Pi's real InteractiveMode in the pane;
 * `PI_PEER_MODE=tui` selects the legacy RPC renderer host; unset/`headless` runs the headless
 * embedded loop. Self-registers on import; the manager resolves it by agent type "pi".
 */
export const piConnector: Connector = {
  kind: "connector",
  name: "pi",
  buildLaunch(opts: LaunchOpts): LaunchSpec {
    // The TUI host launches the operator's PATH-resolved Pi child. Carry the same
    // audited OS allow-list into the host so PATH/HOME/config roots are available;
    // the child then applies launchEnv again when it starts Pi itself.
    const env: Record<string, string> = {
      ...launchEnv({ providerKeys: PROVIDER_KEYS }),
      ...aclEnv(opts),
      COTAL_SPACE: opts.space,
      COTAL_NAME: opts.name,
    };
    if (opts.role) env.COTAL_ROLE = opts.role;
    if (opts.id) env.COTAL_ID = opts.id;
    if (opts.creds) env.COTAL_CREDS = opts.creds;
    if (opts.servers) env.COTAL_SERVERS = opts.servers;
    if (opts.configPath) {
      env.COTAL_AGENT_FILE = opts.configPath;
      // Parse the persona file here (not in the child) so a malformed persona
      // fails loud at `cotal start` (matching the sibling connectors) and so the
      // `cotal start --model` flag precedence over the file's `model:` resolves
      // once, here. Forward only the short resolved model string; the persona
      // body is read from disk by whichever runtime path runs (TUI/headless), so
      // a large persona never rides in env (ARG_MAX ceiling on spawn).
      const def = loadAgentFile(opts.configPath);
      const model = opts.model ?? def.model;
      if (model) env.COTAL_MODEL = model;
      // Launch mode is a connector-owned persona hint. `tui` is the legacy RPC
      // host renderer; `interactive` runs Pi's real InteractiveMode in this pane.
      // `headless`/unset leave the variable absent so the peer defaults to headless.
      const peerMode = def.meta?.peerMode;
      if (peerMode !== undefined && peerMode !== "tui" && peerMode !== "interactive" && peerMode !== "headless")
        throw new Error(`agent file ${opts.configPath}: peerMode must be "tui", "interactive", or "headless" (got ${JSON.stringify(peerMode)})`);
      if (!process.env.PI_PEER_MODE && (peerMode === "tui" || peerMode === "interactive"))
        env.PI_PEER_MODE = peerMode;

      // Generic Pi peers automatically route final assistant text back to the
      // turn origin. Explicit-DM workflows can opt out per persona without
      // affecting inbound delivery, acknowledgements, or presence.
      const autoReply = def.meta?.autoReply;
      if (autoReply !== undefined) {
        autoReplyEnabled(autoReply, `agent file ${opts.configPath}: autoReply`);
        env.PI_PEER_AUTO_REPLY = autoReply;
      }
    }
    // Optional operator override for the host Pi executable. The TUI defaults to the
    // operator's PATH-resolved `pi`; forward an explicit pin through the isolated child env.
    if (process.env.COTAL_PI_CLI?.trim()) env.COTAL_PI_CLI = process.env.COTAL_PI_CLI.trim();
    for (const key of PROVIDER_KEYS) {
      const value = process.env[key];
      if (value) env[key] = value;
    }
    // Operator one-off override, forwarded by NAME (never via ...process.env).
    if (process.env.PI_PEER_MODE) env.PI_PEER_MODE = process.env.PI_PEER_MODE;
    return { command: CMD, args: [MAIN], env };
  },
};

registry.register(piConnector);
