import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadAgentFile, registry, type Connector, type LaunchOpts, type LaunchSpec } from "@cotal-ai/core";
import { aclEnv, launchEnv, mcpServerEnvKeys } from "@cotal-ai/connector-core";

/** Name the cotal MCP server is registered under via --mcp-config (see buildLaunch). */
const MCP_SERVER_NAME = "cotal";
/** Channel ref for `--dangerously-load-development-channels`, which turns on the cotal MCP server's
 *  `claude/channel` capability so an idle session wakes the instant a peer message arrives. Because
 *  we isolate the session with --strict-mcp-config the plugin's own MCP server is suppressed and
 *  cotal is re-supplied via --mcp-config, so the ref is the manually-configured server tagged
 *  `server:<name>` (the CLI rejects a plugin ref or a bare name here). The plugin stays installed
 *  for its hooks, which do message delivery independent of this wake nudge. */
const CHANNEL_REF = `server:${MCP_SERVER_NAME}`;

/** Package root (parent of dist/), which doubles as the installable plugin dir: it carries
 *  .claude-plugin/, .mcp.json, hooks/ and the dist/*.cjs bundles. */
const PLUGIN_ROOT = fileURLToPath(new URL("..", import.meta.url));
/** The cotal MCP server bundle, supplied explicitly so a spawned session can run with ONLY this
 *  MCP server (see buildLaunch's --strict-mcp-config). */
const MCP_CJS = resolve(PLUGIN_ROOT, "dist", "mcp.cjs");

/**
 * The Claude Code connector: launches the real `claude` with the Cotal identity in
 * the environment and the mesh channel enabled, so the session joins the mesh and
 * wakes on incoming peer messages. Self-registers on import; the manager resolves it
 * by agent type "claude".
 */
export const claudeConnector: Connector = {
  kind: "connector",
  name: "claude",
  pluginRoot: PLUGIN_ROOT,
  requires: ["claude"],
  buildLaunch(opts: LaunchOpts): LaunchSpec {
    // Operator MCP servers shared with this agent (default none — see the --mcp-config block).
    const shared = opts.mcpServers ?? {};
    // claude auths via macOS Keychain / an OAuth token, not an env key → forward NO provider key.
    // The OS allow-list (PATH/HOME/TERM/…) is the only thing inherited from the manager env, plus
    // — only when a shared server declares them via `${VAR}` — the named secrets it needs (mcpKeys,
    // by name). The operator's unrelated secrets don't reach the child (P3).
    const env: Record<string, string> = {
      ...launchEnv({ mcpKeys: mcpServerEnvKeys(shared) }),
      ...aclEnv(opts),
      COTAL_SPACE: opts.space,
      COTAL_NAME: opts.name,
      // Force the connector to emit channel wake-nudges: Claude doesn't advertise the
      // `claude/channel` capability back over MCP, so auto-detection would see it "off".
      COTAL_CHANNEL: "1",
    };
    // A session can mirror its own transcript to `tr-<name>` so peers can read what the
    // agent actually did — OFF by default (transcripts are verbose and may carry sensitive
    // content); `--transcript` (opts.transcript === true) opts in. Personal sessions never mirror.
    if (opts.transcript === true) env.COTAL_TRANSCRIPT = "1";
    if (opts.role) env.COTAL_ROLE = opts.role;
    if (opts.id) env.COTAL_ID = opts.id;
    if (opts.creds) env.COTAL_CREDS = opts.creds;
    if (opts.servers) env.COTAL_SERVERS = opts.servers;

    // A leading positional is claude's first message, auto-submitted on start —
    // so a driving session can greet the operator the moment it joins.
    const args = opts.prompt
      ? [opts.prompt, "--dangerously-load-development-channels", CHANNEL_REF]
      : ["--dangerously-load-development-channels", CHANNEL_REF];

    // Pre-allow fetching the public Cotal docs so a doc-grounded persona (e.g. david)
    // can look something up under `npx` (no repo on disk) without prompting the operator
    // mid-demo. Additive under the default permission mode — leaves other tools as-is.
    args.push("--allowedTools", "WebFetch(domain:github.com),WebFetch(domain:raw.githubusercontent.com)");

    // Isolate the spawned session's MCP. --strict-mcp-config drops every ambient MCP source —
    // including the operator's personal ~/.claude.json servers (e.g. a headless Chromium, a DB
    // server) that a meshed teammate never needs and that, multiplied across several spawns on a
    // busy machine, starve memory and kill the session before it registers presence — so the ONLY
    // servers that load are the ones we name in --mcp-config: cotal (always, for its tools +
    // presence) plus any the operator explicitly opted to share (`shared`, from the cotal config).
    // The plugin itself stays enabled (its hooks + the dev-channels wake path are unaffected).
    // cotal is spread LAST so a shared server can never shadow the mesh server by reusing its name.
    const mcpServers = { ...shared, [MCP_SERVER_NAME]: { command: "node", args: [MCP_CJS] } };
    // Default (no shared servers): pass the config inline, unchanged. With shared servers, write it
    // to a file instead and pass the path. Either way the secret stays a `${VAR}` reference (Claude
    // expands it from the child env at launch — see the mcpKeys forwarding above), never the resolved
    // value, so nothing secret reaches disk or argv. We prefer the file when sharing because env
    // expansion is only *documented* for --mcp-config files (inline expansion does work today, but
    // isn't contracted), and a file keeps a potentially multi-server config off the process argv.
    // Verified end-to-end on claude 2.1.183: ${VAR} expands in the --mcp-config file and the value
    // is handed to the shared server. This is host-version behavior — if a future claude stops
    // expanding here, a shared server would receive a literal `${VAR}`; re-check on host upgrades.
    let mcpConfig: string;
    if (Object.keys(shared).length === 0) {
      mcpConfig = JSON.stringify({ mcpServers });
    } else {
      // A private 0700 temp dir (unique per spawn) holds the 0600 config. mkdtemp can't be raced
      // by a pre-created or symlinked path the way a predictable name in the world-writable tmpdir
      // could, and a fresh file guarantees the 0600 mode applies on creation (mode is ignored on an
      // overwrite). Left for the OS to reap: the file must outlive this call (Claude reads it at
      // startup and on /mcp reconnect), and buildLaunch doesn't own the child's lifecycle.
      const dir = mkdtempSync(join(tmpdir(), "cotal-mcp-"));
      mcpConfig = join(dir, "mcp.json");
      writeFileSync(mcpConfig, JSON.stringify({ mcpServers }, null, 2), { mode: 0o600 });
    }
    args.push("--strict-mcp-config", "--mcp-config", mcpConfig);

    // An agent file carries identity (read in-session via COTAL_AGENT_FILE) plus
    // persona + model, which can only be applied to a `claude` session at launch.
    let model = opts.model;
    if (opts.configPath) {
      const path = resolve(opts.configPath);
      env.COTAL_AGENT_FILE = path;
      const def = loadAgentFile(path);
      if (def.persona) args.push("--append-system-prompt", def.persona);
      model ??= def.model;
    }
    // The `--model` flag wins over the agent file, and applies even with no agent file.
    if (model) args.push("--model", model);

    return {
      command: "claude",
      args,
      env,
      // The dev-channels flag shows a one-time "Enter to confirm" prompt; the
      // manager auto-clears it so a supervised launch needs no human keypress.
      confirm: "Enter to confirm",
    };
  },
};

registry.register(claudeConnector);
