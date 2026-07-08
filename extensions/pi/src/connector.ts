import { fileURLToPath } from "node:url";
import { registry, type Connector, type LaunchOpts, type LaunchSpec } from "@cotal-ai/core";
import { MODEL_PROVIDER_KEYS, aclEnv, launchEnv } from "@cotal-ai/connector-core";

/** The extension is loaded with the same file extension as this module — `extension.ts`
 *  when running from source (pi's loader transpiles TS), `extension.js` from built `dist/`
 *  — so the path resolves to a file that actually exists in either mode. Imports inside it
 *  resolve from THIS package's node_modules, so the spawned pi needs nothing installed. */
const ext = import.meta.url.endsWith(".ts") ? ".ts" : ".js";
const EXTENSION = fileURLToPath(new URL(`./extension${ext}`, import.meta.url));

/**
 * The pi connector: spawns the OPERATOR'S installed `pi` (PATH resolution, exactly like the
 * Claude Code connector spawns `claude` — a missing binary fails loud at spawn) with the
 * Cotal mesh extension loaded, so the launched session joins the space as a lateral peer.
 * We ship no pi runtime: the user's pi version, settings, and other extensions all apply.
 * Under the manager's pty runtime the spawned session is the REAL pi TUI — `cotal attach`
 * shows it. Self-registers on import; the manager resolves it by agent type "pi".
 */
export const piConnector: Connector = {
  kind: "connector",
  name: "pi",
  requires: ["pi"],
  buildLaunch(opts: LaunchOpts): LaunchSpec {
    if (opts.resume) throw new Error("the pi connector does not support resuming an existing session (resume)");
    if (opts.variant) throw new Error("the pi connector does not support model variants (variant)");
    // OS allow-list + provider keys BY NAME (never ...process.env), plus the resolved access
    // policy (COTAL_SUBSCRIBE / COTAL_ALLOW_* / COTAL_CAPABILITIES) — the same launchEnv/aclEnv
    // contract every sibling connector follows, so a manifest-spawned peer's runtime read/post
    // set matches the creds the manager minted.
    const env: Record<string, string> = {
      // pi resolves provider credentials via its AuthStorage, falling back to env keys —
      // forwarded from the SHARED chokepoint list, by name, only when present.
      ...launchEnv({ providerKeys: MODEL_PROVIDER_KEYS }),
      ...aclEnv(opts),
      COTAL_SPACE: opts.space,
      COTAL_NAME: opts.name,
    };
    if (opts.role) env.COTAL_ROLE = opts.role;
    if (opts.id) env.COTAL_ID = opts.id;
    if (opts.creds) env.COTAL_CREDS = opts.creds;
    if (opts.servers) env.COTAL_SERVERS = opts.servers;
    if (opts.configPath) env.COTAL_AGENT_FILE = opts.configPath;
    const args = ["--extension", EXTENSION];
    if (opts.model) {
      env.COTAL_MODEL = opts.model; // presence metadata (AgentCard.meta.model), display-only
      args.push("--model", opts.model); // applies even with no agent file (sibling contract)
    }
    return { command: "pi", args, env };
  },
};

registry.register(piConnector);
