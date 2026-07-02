import type { Extension } from "./registry.js";
import type { McpServerSpec } from "./connector-config.js";

/** Identity + mesh coordinates the manager hands a connector to launch an agent. */
export interface LaunchOpts {
  space: string;
  name: string;
  role?: string;
  /** Stable agent id (the nkey public key). When set, the launched session adopts it
   *  as its `card.id` instead of generating a random one — so the id the launcher
   *  provisioned is the id the agent presents, and later ACLs key on it. */
  id?: string;
  /** Path to a minted creds file (auth mode). Passed to the session so it authenticates
   *  as `id`; absent when the mesh runs open. */
  creds?: string;
  servers?: string;
  /** The agent's resolved access policy — the SAME read/post set the manager mints the agent's
   *  creds from. The connector forwards it (`COTAL_SUBSCRIBE` / `COTAL_ALLOW_SUBSCRIBE` /
   *  `COTAL_ALLOW_PUBLISH`) so the session's runtime read set matches its credentials. Essential
   *  for manifest spawns, whose materialized persona carries NO access frontmatter: without it the
   *  connector falls back to `["general"]`, which the scoped creds deny — so the agent joins
   *  nothing. Empty/absent lists are omitted (the connector then defers to the persona file or the
   *  `general` baseline — the no-channel case). */
  subscribe?: string[];
  allowSubscribe?: string[];
  allowPublish?: string[];
  /** Control-plane capabilities the manager granted this agent (e.g. `["spawn"]`) — the SAME set
   *  the creds were provisioned from. Forwarded as `COTAL_CAPABILITIES` so the connector exposes the
   *  matching control-plane tools (cotal_spawn / cotal_persona). Without it a manifest-spawned agent —
   *  whose materialized persona carries no `capabilities:` frontmatter — gets none, so those tools stay
   *  hidden even though its creds authorize them. */
  capabilities?: string[];
  /** Path to an agent definition file (`.cotal/agents/<name>.md`). The connector
   *  passes it through (`COTAL_AGENT_FILE`) so the joined session reads its own
   *  card from it, and applies the file's persona/model at launch. */
  configPath?: string;
  /** Explicit model override — the `cotal start --model <m>` flag. Takes precedence over the
   *  agent file's `model:` and is applied even when no agent file is present. Each connector
   *  renders it in its host form (Claude `--model`, OpenCode `config.model`, Hermes `HERMES_MODEL`). */
  model?: string;
  /** An initial message for the session to act on the moment it starts. Connectors
   *  that support an auto-submitted first prompt (Claude Code) deliver it; others
   *  ignore it. Used to make a driving session greet the operator on launch. */
  prompt?: string;
  /** An OPAQUE prior-session handle to FORK FROM when launching — never reused, never resolved by
   *  core. Like `creds` / `configPath`, this is a HOST-LOCAL pointer (into e.g. `~/.claude`), NOT a
   *  portable value like `model`: it only means something on the machine that produced it. A
   *  connector that honors it MUST fork a new session id from that transcript (Claude
   *  `--resume <id> --fork-session`), so the meshed agent gets a fresh session and the original is
   *  left untouched — resuming MUST NOT hijack the source session. A connector that can't fork
   *  THROWS at {@link Connector.buildLaunch} rather than silently spawning fresh. */
  resume?: string;
  /** Mirror this session's transcript to the connector's per-agent transcript channel (see
   *  {@link Connector.transcriptChannel}) so peers/observers can read what the agent actually did
   *  (sets `COTAL_TRANSCRIPT`). Defaults to OFF; set `true` to opt in — surfaced as the `--transcript`
   *  flag on `cotal spawn` / `cotal start`. */
  transcript?: boolean;
  /** Operator MCP servers to SHARE with this agent, resolved from the cotal config by the caller
   *  (see {@link connectorServers}). Keyed by server name, `.mcp.json`-shaped, with `${VAR}`
   *  secret refs intact. A connector renders them into its own host format; the default is none
   *  (Claude launches isolated with `--strict-mcp-config`). Connectors that don't support sharing
   *  throw on a non-empty map rather than silently dropping it. */
  mcpServers?: Record<string, McpServerSpec>;
  /** The manager's workspace root. Connectors that keep per-agent local state (e.g. the OpenCode
   *  connector's SQLite DB + serve pidfile) pin it here so a per-agent working directory — which can
   *  point at any repo — doesn't scatter that state into the target tree. The per-agent working
   *  directory itself is the manager's concern and is passed to the runtime, not here. */
  workspaceRoot?: string;
}

/** A recipe for starting an agent as a mesh node — command, args, and extra env. */
export interface LaunchSpec {
  command: string;
  args: string[];
  env?: Record<string, string>;
  /** Auto-clear a one-time spawn prompt: when this text appears in the agent's
   *  early output, the runtime presses Enter once so a supervised launch stays
   *  non-interactive. Matched after stripping ANSI + whitespace (TUIs position
   *  text with cursor moves, not spaces). */
  confirm?: string;
  /** This agent's local control endpoint — the OS path its lifecycle hooks connect to (passed in
   *  the child env as `COTAL_CONTROL_SOCKET`/`COTAL_CONTROL_TOKEN`), plus the first-frame `token`
   *  that authenticates it. The connector mints it in `buildLaunch`; the manager keeps it IN MEMORY
   *  (never persisted — token hygiene) to send a cooperative `{op:"shutdown"}` on a runtime that
   *  can't deliver a clean exit signal (ConPTY/Windows). Both the Claude Code (MCP server) and
   *  OpenCode (in-process plugin) connectors mint one; absent only for a connector with no control
   *  plane at all. */
  control?: { path: string; token: string };
}

/**
 * A bridge that knows how to launch one agent type (Claude Code, OpenCode, the CLI
 * peer …) as a Cotal mesh node — an {@link Extension} of kind `"connector"`.
 * `name` is the agent type it handles — the key the manager resolves by.
 * Connectors self-register on import; the manager resolves them from the registry,
 * and core stays ignorant of which ones exist.
 */
export interface Connector extends Extension {
  readonly kind: "connector";
  readonly name: string;
  buildLaunch(opts: LaunchOpts): LaunchSpec;
  /** The channel this connector publishes an agent's transcript mirror to (see
   *  {@link LaunchOpts.transcript}). OPTIONAL — like {@link LaunchOpts.prompt}, only connectors that
   *  actually mirror (Claude Code, OpenCode) implement it; one that doesn't (e.g. Hermes) omits it. The
   *  naming convention is the CONNECTOR's, not the wire standard, so it's defined in the extension, not
   *  core. The manager calls it to grant the agent publish rights on its transcript channel at provision
   *  time (auth-mode publish is default-deny), so the grant and what the connector publishes to come from
   *  one source and can't drift. If `transcript` is requested for a connector that lacks this, the
   *  manager fails loud rather than silently skipping the grant. */
  transcriptChannel?(name: string): string;
  /** External executables this connector invokes beyond `LaunchSpec.command` (e.g. the
   *  `claude` / `opencode` CLI). A preflight PATH hint, not a full environment validator: the
   *  manager checks each is on PATH before spawning and fails with a clear error naming the
   *  missing one, instead of an obscure process-spawn failure. Optional — omit for connectors
   *  whose harness runs in-process. */
  readonly requires?: readonly string[];
  /** Directory of installable editor-plugin assets shipped with the connector
   *  (e.g. a Claude Code plugin dir), when the agent type needs a one-time
   *  plugin install. Consumers (like `cotal setup`) resolve it via the registry
   *  so they never import the extension package directly. */
  readonly pluginRoot?: string;
}
