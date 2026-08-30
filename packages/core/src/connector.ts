import type { Extension, ExtensionRef } from "./registry.js";
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
  /** USER-MODE launch (a user-auth mesh): the agent's owner+actor principal, the PATH to its
   *  sentinel-creds copy, and the argv it execs for a fresh bearer. The connector forwards these
   *  verbatim (`COTAL_OWNER` / `COTAL_ACTOR` / `COTAL_SENTINEL_CREDS` / `COTAL_BEARER_CMD` as JSON
   *  argv) — like {@link creds}, host-local pointers, opaque to core. Mutually exclusive with
   *  `creds`/`id` (the principal IS the identity; connectors throw on a conflicting combination). */
  userAuth?: { owner: string; actor: string; sentinelCredsPath: string; bearerCmd: string[] };
  /** The incarnation's lifecycle UID (SPEC §13.1), minted by the launcher at spawn. The connector
   *  forwards it (`COTAL_LIFECYCLE_UID`) so the session's endpoint binds its lifecycle-keyed
   *  dm/dlv/chathist durables — the same exact names its credential pins. */
  lifecycleUid?: string;
  servers?: string;
  /** The agent's resolved access policy — the SAME read/post set the manager mints the agent's
   *  creds from. The connector forwards it (`COTAL_SUBSCRIBE` / `COTAL_ALLOW_SUBSCRIBE` /
   *  `COTAL_ALLOW_PUBLISH`) so the session's runtime read set matches its credentials. Essential
   *  for manifest spawns, whose materialized persona carries NO access frontmatter: without it the
   *  connector has nothing to read its channel set from, so the agent joins nothing even though its
   *  creds authorize channels. Empty/absent lists are omitted (the connector then defers to the
   *  persona file or the join link, and joins nothing if neither names a channel). */
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
  /** Optional model variant selector — a connector-defined variant of the selected/default model
   *  (for example provider-specific reasoning effort). Takes precedence over the agent file's
   *  `variant:`. A connector that supports variants renders it in its host form; unsupported
   *  connectors fail loud rather than silently ignoring it. */
  variant?: string;
  /** Opaque, connector-specific launch options — an arbitrary key→value map core forwards VERBATIM
   *  and never inspects. Connectors forward well-shaped keys raw into their own host form (CLI flags,
   *  config, env); a connector with no option surface fails loud. Fed by `--opt k=v`, a persona's
   *  `launchOptions:` mapping, or a manifest `launchOptions:` — merged per key. */
  launchOptions?: Record<string, unknown>;
  /** An initial message for the session to act on the moment it starts (`cotal spawn --prompt`).
   *  A connector delivers it as the harness's first turn or throws at launch; it never ignores it,
   *  because an operator who passed a prompt is waiting on the turn it starts. */
  prompt?: string;
  /** An OPAQUE prior-session handle to FORK FROM when launching — never reused, never resolved by
   *  core. Like `creds` / `configPath`, this is a HOST-LOCAL pointer (into e.g. `~/.claude`), NOT a
   *  portable value like `model`: it only means something on the machine that produced it. A
   *  connector that honors it MUST fork a new session id from that transcript (Claude
   *  `--resume <id> --fork-session`), so the meshed agent gets a fresh session and the original is
   *  left untouched — resuming MUST NOT hijack the source session. A connector that can't fork
   *  THROWS at {@link Connector.buildLaunch} rather than silently spawning fresh. */
  resume?: string;
  /** Exact session of THIS connector process to continue after a supervised process restart.
   *  Distinct from {@link resume}: `resume` forks FROM an existing transcript into a new session;
   *  `continueSession` reopens the already-meshed session itself. Manager-internal only, never a
   *  CLI/manifest/model-provided field. A connector that cannot preserve its mesh surface across
   *  same-session continuation throws rather than silently launching fresh. */
  continueSession?: string;
  /** Publish this session's AG-UI event plane to the agent's own event channel (see
   *  {@link Connector.eventChannel}), so an external observer or UI can read what the agent actually
   *  did as structured events rather than as prose (sets `COTAL_EVENTS`). Defaults to OFF; set `true`
   *  to opt in, surfaced as the `--events` flag on `cotal spawn` / `cotal start`.
   *
   *  The flag ARMS the emitter. It is deliberately separate from the grant the manager mints from
   *  {@link Connector.eventChannel}: holding publish rights on a channel is not a request to publish
   *  to it, so a hand-written `allowPublish` entry cannot turn events on for a session the launch
   *  path never armed. */
  events?: boolean;
  /** Operator MCP servers to SHARE with this agent, resolved from the cotal config by the caller
   *  (see {@link connectorServers}). Keyed by server name, `.mcp.json`-shaped, with `${VAR}`
   *  secret refs intact. A connector renders them into its own host format; the default is none
   *  (Claude launches isolated with `--strict-mcp-config`). Connectors that don't support sharing
   *  throw on a non-empty map rather than silently dropping it. */
  mcpServers?: Record<string, McpServerSpec>;
  /** Extra environment names an operator deliberately declared in `spawn.env`, resolved by the
   *  caller exactly as {@link mcpServers} is. The default supplies no extras: the child receives the
   *  fixed OS allow-list, the machine-wide `COTAL_*` operator knobs, and connector-declared inputs
   *  only. Connectors never read config themselves. Host-session markers are not forwarded unless
   *  named here. */
  envAllow?: readonly string[];
  /** Absolute harness executable paths resolved by the manager during boot, keyed by the connector's
   * declared `requires` names. Managed launches use these exact files rather than resolving PATH
   * again later. Absent for standalone/foreground launches that have no manager boot inventory. */
  resolvedBinaries?: Readonly<Record<string, string>>;
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
  /** Connector-owned host-session state file. A supervised restart reads this exact manager-provided
   *  path after process exit, then verifies the successor reports the same session over `control`.
   *  Contains no transcript or credential; currently used by Pi for its current session id. */
  sessionStatePath?: string;
}

/** One provider-specific model variant. `options` is opaque connector metadata for UIs; core never
 *  interprets it or feeds it back into launch. */
export interface ModelVariantInfo {
  name: string;
  options?: Record<string, unknown>;
}

/** One model a connector can launch. `id` is the value to pass as {@link LaunchOpts.model}; variants
 *  are selected separately via {@link LaunchOpts.variant}. */
export interface ModelInfo {
  id: string;
  name?: string;
  provider?: string;
  variants?: ModelVariantInfo[];
}

/** Connector-provided model catalog. Optional by design: some hosts have no local model-list API. */
export interface ModelCatalog {
  source?: string;
  models: ModelInfo[];
}

export interface ModelCatalogOpts {
  refresh?: boolean;
}

/** Manager-facing wrapper for one connector's catalog lookup. */
export interface ConnectorModelCatalog extends ModelCatalog {
  agent: string;
  supported: boolean;
  error?: string;
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
  /** Connector-owned setup surface. The base CLI resolves this through the extension registry and
   * never carries a harness's asset names or native install commands itself. */
  readonly setup?: ExtensionRef;
  buildLaunch(opts: LaunchOpts): LaunchSpec;
  /** Optional model catalog hook. The manager calls this for selector UIs; launch remains authority-free
   *  and still accepts any string the operator supplies. */
  listModels?(opts?: ModelCatalogOpts): ModelCatalog | Promise<ModelCatalog>;
  /** The channel this connector publishes an agent's AG-UI event plane to (see
   *  {@link LaunchOpts.events}). OPTIONAL: only connectors that actually emit implement it, and
   *  asking for `events` from one that does not FAILS LOUD in the manager rather than minting a
   *  grant nothing will ever use.
   *
   *  It takes the agent's PRINCIPAL, never its display name. A display name is UI convenience and is
   *  not an identity: this mesh permits two live agents to carry one name, so a name-keyed channel
   *  fuses two principals' streams onto one subject and authorizes both onto it from the same
   *  name-only value. The principal is the address. Connectors derive the channel with core's own
   *  `eventChannel`, so the grant the manager mints here and the subject the session publishes to
   *  are the same derivation and cannot drift. */
  eventChannel?(principal: { owner: string; actor: string }): string;
  /** External executables this connector invokes beyond `LaunchSpec.command` (e.g. the
   *  `claude` / `opencode` CLI). A preflight PATH hint, not a full environment validator: the
   *  manager resolves each at boot, passes the absolute path through {@link LaunchOpts.resolvedBinaries},
   *  and fails with a clear error naming a missing one. Optional — omit for connectors
   *  whose harness runs in-process. */
  readonly requires?: readonly string[];
  /** Directory of installable editor-plugin assets shipped with the connector
   *  (e.g. a Claude Code plugin dir), when the agent type needs a one-time
   *  plugin install. Consumers (like `cotal setup`) resolve it via the registry
   *  so they never import the extension package directly. */
  readonly pluginRoot?: string;
  /** Whether this connector can honor {@link LaunchOpts.resume} (fork an existing session into the
   *  mesh). The manager reads this as a PRE-MINT preflight: when `resume` is requested for a connector
   *  that doesn't declare support, it fails loud BEFORE any provisioning side effect (mirrors the
   *  {@link requires} PATH preflight) — so an unsupported resume can never mint-then-orphan creds +
   *  durables. Default-deny: absent/false → not supported, and `buildLaunch` throwing on `resume`
   *  stays as the backstop. Only a connector that forks-from a prior session (never hijacks it) sets
   *  this `true`. */
  readonly supportsResume?: boolean;
  /** Whether this connector can reopen the exact host session named by
   *  {@link LaunchOpts.continueSession} after a supervised process crash. Default-deny. */
  readonly supportsSessionContinuation?: boolean;
  /**
   * Whether this connector can tell its host that the advertised `cotal_*` list changed.
   *
   * Default-deny. The advertised `cotal_*` list is a function of the session's mesh
   * config (spawn tools appear or vanish with the connection). A session that changes
   * connection therefore changes the advertised surface. Some hosts can tell the
   * session the list changed; some take a tool map once and cannot. Consumers above
   * this boundary branch on THIS FLAG, never on the connector's name and never on
   * the transport. A connection-changing op against a connector that does not declare
   * this MUST fail loud ({@link refuseUnannouncedToolListChange}) rather than leave a
   * stale list that still accepts the call and is denied at the wire.
   */
  readonly supportsToolListAnnounce?: boolean;
  /** Whether this connector can honor {@link LaunchOpts.variant}. Default-deny so a variant request
   *  fails before provisioning side effects in the manager. */
  readonly supportsModelVariant?: boolean;
  /**
   * Connector-specific upper bound for reaching mesh presence after its process is launched.
   *
   * The manager's generic readiness window applies when absent. A connector whose documented
   * bootstrap legitimately exceeds that generic window must declare a positive safe integer here,
   * so a live slow boot is not terminalized `uncertain` before it can join. This is a bounded wait,
   * not an application-health promise: presence still means only that the seat joined the mesh.
   */
  readonly readinessTimeoutMs?: number;
  /** One short clause telling the operator what to expect on a FOREGROUND spawn, appended to the
   *  "spawning <name> on the mesh" line. What happens next differs per harness — one opens on an
   *  interactive gate, another paints a full-screen UI after a pause — and a hint naming the wrong
   *  one is worse than none: someone waits for a prompt that will never appear and reads the
   *  startup as hung. Omit when there is nothing specific to say. */
  readonly launchHint?: string;
}

/**
 * Refuse a connection-changing op when the connector cannot announce the resulting
 * tool-list change. Name-blind: callers pass the connector they resolved, never a
 * string of known harnesses, and the refusal itself names none. Default-deny:
 * absent/false throws. Returns void when the connector declared
 * {@link Connector.supportsToolListAnnounce}.
 */
export function refuseUnannouncedToolListChange(connector: Pick<Connector, "supportsToolListAnnounce">): void {
  if (connector.supportsToolListAnnounce === true) return;
  throw new Error(
    "this connector cannot announce a tool-list change, so a connection change is refused rather than leaving a stale advertised surface",
  );
}
