import { fileURLToPath } from "node:url";
import { registry, type Connector, type LaunchOpts, type LaunchSpec } from "@cotal-ai/core";
import { launchEnv } from "@cotal-ai/connector-core";

/** The host loop runs via tsx (Codex host-mode has no plugin copy-install). Resolved to the sibling
 *  that actually exists next to THIS module: the compiled `.js` from dist/, the `.ts` source in dev.
 *  `../node_modules/.bin/tsx` sits at the package root, correct from dist or src alike. */
const TSX = fileURLToPath(new URL("../node_modules/.bin/tsx", import.meta.url));
const inDist = import.meta.url.includes("/dist/");
const HOST_ENTRY = fileURLToPath(new URL(`./host-main.${inDist ? "js" : "ts"}`, import.meta.url));

/**
 * The Codex host-mode connector: launches an embedded Cotal peer that drives a headless
 * `codex app-server` over JSON-RPC. A mesh message becomes a real user turn — wake an idle
 * session (turn/start), steer one already mid-turn (turn/steer), or interrupt it
 * (turn/interrupt); presence is read off the app-server event stream rather than self-reported.
 * No native TUI — the human view comes via the manager's attach. Self-registers; the manager
 * resolves it by agent type "codex-app-server".
 */
export const codexAppServerConnector: Connector = {
  kind: "connector",
  name: "codex-app-server",
  buildLaunch(opts: LaunchOpts): LaunchSpec {
    // The host (tsx) spawns `codex app-server`, which needs codex auth: a ChatGPT login in
    // ~/.codex/auth.json (reachable via HOME on the OS allow-list) or OPENAI_API_KEY. Forward only
    // the named provider key (P3) — never the operator's unrelated env. Identity rides COTAL_* in
    // the child env; the embedded MeshAgent reads it via configFromEnv.
    const env: Record<string, string> = {
      ...launchEnv({ providerKeys: ["OPENAI_API_KEY"] }),
      COTAL_SPACE: opts.space,
      COTAL_NAME: opts.name,
    };
    if (opts.role) env.COTAL_ROLE = opts.role;
    if (opts.id) env.COTAL_ID = opts.id;
    if (opts.creds) env.COTAL_CREDS = opts.creds;
    if (opts.servers) env.COTAL_SERVERS = opts.servers;
    if (opts.configPath) env.COTAL_AGENT_FILE = opts.configPath;
    return { command: TSX, args: [HOST_ENTRY], env };
  },
};

registry.register(codexAppServerConnector);
