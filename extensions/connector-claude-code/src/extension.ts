import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { hardenPrivate, loadAgentFile, registry, writeSecretFile, type Connector, type LaunchOpts, type LaunchSpec } from "@cotal-ai/core";
import { aclEnv, connectorLaunchOptions, controlEndpoint, launchEnv, mcpServerEnvKeys, transcriptChannel, userAuthEnv } from "@cotal-ai/connector-core";

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

/** claude's model credential, forwarded to a spawn BY NAME only when the operator has it set (the
 *  `providerKeys` rail — see launchEnv). `CLAUDE_CODE_OAUTH_TOKEN` is the long-lived (~1yr),
 *  NON-rotating token minted by `claude setup-token`. Forwarding it is the fix for the concurrent-
 *  spawn logout cascade (issue #260): claude's subscription login is a single-use ROTATING refresh
 *  token in one shared credential store (macOS Keychain / `~/.claude/.credentials.json`), so N
 *  concurrent sessions race on refresh — the first to rotate invalidates the rest (`invalid_grant`).
 *  Setting `CLAUDE_CONFIG_DIR` per agent does NOT fix this on macOS (the token lives in a FIXED
 *  shared Keychain item, not scoped by that dir). A static env bearer sidesteps rotation entirely —
 *  precedence rank 5 beats a `.credentials.json` (rank 6); sharing ONE across many sessions causes no
 *  cascade. This is exactly the credential `deploy/` already uses for multi-agent containers. Only
 *  forwarded when present, so a single-agent subscription login is unaffected. */
const CLAUDE_CRED_KEYS = ["CLAUDE_CODE_OAUTH_TOKEN"] as const;

/**
 * The Claude Code connector: launches the real `claude` with the Cotal identity in
 * the environment and the mesh channel enabled, so the session joins the mesh and
 * wakes on incoming peer messages. Self-registers on import; the manager resolves it
 * by agent type "claude".
 */
export const claudeConnector: Connector = {
  kind: "connector",
  name: "claude",
  transcriptChannel, // the shared `tr-<name>` convention (connector-core), exposed via the contract
  pluginRoot: PLUGIN_ROOT,
  requires: ["claude"],
  supportsResume: true, // renders `--resume <id> --fork-session` (fork-from, never hijack) — see buildLaunch

  buildLaunch(opts: LaunchOpts): LaunchSpec {
    if (opts.variant) throw new Error("claude connector: model variants are not supported");
    // Operator MCP servers shared with this agent (default none — see the --mcp-config block).
    const shared = opts.mcpServers ?? {};
    // claude normally auths via its OWN shared credential store (macOS Keychain /
    // ~/.claude/.credentials.json), not an env key. The one credential we DO forward is
    // CLAUDE_CODE_OAUTH_TOKEN (CLAUDE_CRED_KEYS, `providerKeys`, by name, only when set): a non-
    // rotating token that lets many concurrent spawns share one credential without the refresh-token
    // logout cascade (issue #260). Beyond that the OS allow-list (PATH/HOME/TERM/…) is the only thing
    // inherited from the manager env, plus — only when a shared server declares them via `${VAR}` —
    // the named secrets it needs (mcpKeys, by name). The operator's unrelated secrets don't reach the
    // child (P3).
    // The session's local control endpoint: the in-process MCP server LISTENS on it (auth), and the
    // lifecycle hooks (child processes of `claude`, which inherit this env) CONNECT to it. Both read
    // path+token from the env — never recomputed from public identity — and the manager keeps the
    // pair (returned as `control` below) to drive a cooperative shutdown on Windows.
    const control = controlEndpoint(opts.space, opts.name);
    const env: Record<string, string> = {
      ...launchEnv({ providerKeys: CLAUDE_CRED_KEYS, mcpKeys: mcpServerEnvKeys(shared) }),
      ...aclEnv(opts),
      ...userAuthEnv(opts),
      COTAL_SPACE: opts.space,
      COTAL_NAME: opts.name,
      // Force the connector to emit channel wake-nudges: Claude doesn't advertise the
      // `claude/channel` capability back over MCP, so auto-detection would see it "off".
      COTAL_CHANNEL: "1",
      COTAL_CONTROL_SOCKET: control.path,
      COTAL_CONTROL_TOKEN: control.token, // env only — never argv/logs/persisted (token hygiene)
    };
    // A session can mirror its own transcript to `tr-<name>` so peers can read what the
    // agent actually did — OFF by default (transcripts are verbose and may carry sensitive
    // content); `--transcript` (opts.transcript === true) opts in. Personal sessions never mirror.
    if (opts.transcript === true) env.COTAL_TRANSCRIPT = "1";
    if (opts.role) env.COTAL_ROLE = opts.role;
    if (opts.id) env.COTAL_ID = opts.id;
    if (opts.lifecycleUid) env.COTAL_LIFECYCLE_UID = opts.lifecycleUid;
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
      hardenPrivate(dir, "dir"); // win32: mkdtemp's 0700 is a no-op — harden the ACL before the config lands
      mcpConfig = join(dir, "mcp.json");
      writeSecretFile(mcpConfig, JSON.stringify({ mcpServers }, null, 2));
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
    if (model) {
      args.push("--model", model);
      env.COTAL_MODEL = model;
    }

    // Fork an existing session INTO the mesh (opts.resume, an opaque host-local id). `--fork-session`
    // is pushed in the SAME branch — resume here is fork-only, never a hijack: claude mints a NEW
    // session id from that transcript and leaves the original untouched. The id is a single argv
    // token (no shell), so a hostile-looking id can't inject. The persona `--append-system-prompt`
    // above still applies, so the forked context runs under the current mesh persona.
    if (opts.resume) args.push("--resume", opts.resume, "--fork-session");

    // Opaque connector options → native `claude` flags, RAW passthrough: `key=value` renders
    // `--key value`, and an empty value (`--opt foo=`) renders a bare boolean `--foo`. No allow-list,
    // no deny-list — the spawn capability is the trust boundary (see connectorLaunchOptions), not the
    // flag set. An operator can already run `claude` with any flag directly, and a peer's cotal_spawn
    // is gated by the spawn capability itself; every `claude` flag is forwarded verbatim.
    for (const [k, v] of connectorLaunchOptions("claude", opts.launchOptions)) {
      const val = String(v);
      if (val === "") args.push(`--${k}`);
      else args.push(`--${k}`, val);
    }

    return {
      command: "claude",
      args,
      env,
      // The dev-channels flag shows a one-time "Enter to confirm" prompt; the
      // manager auto-clears it so a supervised launch needs no human keypress.
      confirm: "Enter to confirm",
      control,
    };
  },
};

registry.register(claudeConnector);
