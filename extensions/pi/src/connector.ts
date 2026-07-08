import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadAgentFile, registry, type Connector, type LaunchOpts, type LaunchSpec } from "@cotal-ai/core";
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
    const args = ["--extension", EXTENSION];
    let model = opts.model; // the spawn flag applies even with no agent file (sibling contract)
    if (opts.configPath) {
      env.COTAL_AGENT_FILE = opts.configPath;
      // Parse the persona file here (not in the child) so a malformed persona fails loud
      // at `cotal spawn`, matching the sibling connectors. The frontmatter-stripped body
      // goes to pi via --append-system-prompt with a FILE path (pi reads paths natively),
      // so a large persona never rides in argv (ARG_MAX ceiling); the raw agent file can't
      // be passed directly or its `---` metadata would enter the system prompt. The model
      // pin rides --model (`cotal spawn --model` wins over the file's `model:`), resolved
      // by pi's own CLI semantics.
      const def = loadAgentFile(opts.configPath);
      if (def.persona) {
        const dir = mkdtempSync(join(tmpdir(), "cotal-persona-"));
        const persona = join(dir, "persona.md");
        writeFileSync(persona, def.persona, { mode: 0o600 });
        args.push("--append-system-prompt", persona);
      }
      model ??= def.model; // `cotal spawn --model` wins over the file's `model:` pin
    }
    if (model) {
      env.COTAL_MODEL = model; // presence metadata (AgentCard.meta.model), display-only
      args.push("--model", model);
    }
    return { command: "pi", args, env };
  },
};

registry.register(piConnector);
