import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { hardenPrivate, loadAgentFile, registry, writeSecretFile, type Connector, type LaunchOpts, type LaunchSpec } from "@cotal-ai/core";
import { aclEnv, connectorLaunchOptions, controlEndpoint, eventChannel, launchEnv, mcpServerEnvKeys, userAuthEnv } from "@cotal-ai/connector-core";

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
/**
 * Refuse a model this connector cannot serve, at LAUNCH, the way an unsupported `variant` is
 * refused below.
 *
 * THE INCIDENT, because the cost was not the crash it did not cause. `model:` on an agent file is
 * honoured by the opencode connector and was a dead letter here: this connector pushed whatever it
 * was given straight through to `claude`. Two review seats were spawned as
 * `claude --model xai/grok-4.6`, which `claude` cannot serve. They did not fail closed - they came
 * up on a Claude model, reported for hours under a grok label, and their operator's written claim
 * of two-vendor corroboration was false in a way nothing observable to them could reveal. The
 * seats were in fact the same family as the agent grading their output.
 *
 * SO THE FAILURE MODE THIS CLOSES IS NOT "wrong model", IT IS "wrong model, silently, with a
 * confident label attached". A launch that refuses costs one spawn. A launch that mislabels costs
 * every conclusion drawn from that seat, retroactively, and there is no artifact in the session to
 * catch it with - the environment variable says grok, and only the process's own argv disagrees.
 *
 * The discriminator is the provider-prefixed `provider/model` form that other runtimes use, since
 * an allow-list of Claude model names would need editing every time one ships and would fail
 * closed on a model that works. `arn:` is exempt: a Bedrock inference-profile ARN legitimately
 * carries a slash and `claude` does serve it.
 */
function assertServableModel(model: string): void {
  if (!model.includes("/") || model.startsWith("arn:")) return;
  throw new Error(
    `claude connector: cannot serve model ${JSON.stringify(model)} - a "provider/model" specifier ` +
      `belongs to another runtime (use the opencode connector for it). Refusing at launch: passing ` +
      `it through starts a session on a DIFFERENT model than the one named, and everything that ` +
      `session produces would carry the wrong attribution.`,
  );
}

export const claudeConnector: Connector = {
  kind: "connector",
  name: "claude",
  // The event channel is core's own derivation, exposed through the contract so the grant the
  // manager mints and the subject this session publishes to come from ONE function. Re-deriving it
  // here would be a second place the subject is decided, and the two would drift the first time
  // either changed.
  eventChannel,
  pluginRoot: PLUGIN_ROOT,
  requires: ["claude"],
  supportsResume: true, // renders `--resume <id> --fork-session` (fork-from, never hijack) — see buildLaunch
  launchHint: "press Enter at the dev-channels prompt", // Claude Code opens on that one-time gate

  buildLaunch(opts: LaunchOpts): LaunchSpec {
    if (opts.variant) throw new Error("claude connector: model variants are not supported");
    // Operator MCP servers shared with this agent (default none — see the --mcp-config block).
    const shared = opts.mcpServers ?? {};
    // claude auths via macOS Keychain / an OAuth token, not an env key → forward NO provider key.
    // The OS allow-list (PATH/HOME/TERM/…) is the only thing inherited from the manager env, plus
    // — only when a shared server declares them via `${VAR}` — the named secrets it needs (mcpKeys,
    // by name). The operator's unrelated secrets don't reach the child (P3).
    // The session's local control endpoint: the in-process MCP server LISTENS on it (auth), and the
    // lifecycle hooks (child processes of `claude`, which inherit this env) CONNECT to it. Both read
    // path+token from the env — never recomputed from public identity — and the manager keeps the
    // pair (returned as `control` below) to drive a cooperative shutdown on Windows.
    const control = controlEndpoint(opts.space, opts.name);
    const env: Record<string, string> = {
      ...launchEnv({ mcpKeys: mcpServerEnvKeys(shared) }),
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
    // The AG-UI event plane. `COTAL_EVENTS` ARMS the emitter and is what makes a grant meaningful:
    // holding publish rights on a channel is not a request to publish to it. `COTAL_WORKSPACE_ROOT`
    // rides with it because the emitter's write-ahead log has to live somewhere a LATER start will
    // look, and there is no safe default: a WAL written under the launch cwd is invisible to the
    // next start, which then reads an already-published thread as virgin and republishes sequences
    // the stream has seen. Sent only when events are on, so a session that never emits carries no
    // path it has no use for.
    if (opts.events === true) {
      env.COTAL_EVENTS = "1";
      if (!opts.workspaceRoot)
        throw new Error(
          "claude connector: events were requested but the launch carries no workspaceRoot, so the " +
            "event write-ahead log has nowhere to live that a later start would look. Refusing rather " +
            "than defaulting to the working directory.",
        );
      env.COTAL_WORKSPACE_ROOT = opts.workspaceRoot;
    }
    if (opts.role) env.COTAL_ROLE = opts.role;
    if (opts.id) env.COTAL_ID = opts.id;
    if (opts.lifecycleUid) env.COTAL_LIFECYCLE_UID = opts.lifecycleUid;
    if (opts.creds) env.COTAL_CREDS = opts.creds;
    if (opts.servers) env.COTAL_SERVERS = opts.servers;

    // A leading positional is claude's first message, auto-submitted on start —
    // so a driving session can greet the operator the moment it joins.
    // A prompt with no text in it cannot be submitted as a turn: refuse the launch rather than start
    // a seat that quietly ignores what the operator passed (same rule as the other connectors).
    const prompt = opts.prompt === undefined ? undefined : opts.prompt.trim();
    if (prompt === "")
      throw new Error("claude connector: an initial prompt was given but it is empty, there is no first turn to submit");
    const args = prompt
      ? [prompt, "--dangerously-load-development-channels", CHANNEL_REF]
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
      assertServableModel(model);
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
