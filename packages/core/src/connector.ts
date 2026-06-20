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
  /** Path to an agent definition file (`.cotal/agents/<name>.md`). The connector
   *  passes it through (`COTAL_AGENT_FILE`) so the joined session reads its own
   *  card from it, and applies the file's persona/model at launch. */
  configPath?: string;
  /** An initial message for the session to act on the moment it starts. Connectors
   *  that support an auto-submitted first prompt (Claude Code) deliver it; others
   *  ignore it. Used to make a driving session greet the operator on launch. */
  prompt?: string;
  /** Mirror this session's transcript to `tr-<name>` so peers/observers can read what
   *  the agent actually did (sets `COTAL_TRANSCRIPT`). Defaults to OFF; set `true` to
   *  opt in — surfaced as the `--transcript` flag on `cotal spawn` / `cotal start`. */
  transcript?: boolean;
  /** Operator MCP servers to SHARE with this agent, resolved from the cotal config by the caller
   *  (see {@link connectorServers}). Keyed by server name, `.mcp.json`-shaped, with `${VAR}`
   *  secret refs intact. A connector renders them into its own host format; the default is none
   *  (Claude launches isolated with `--strict-mcp-config`). Connectors that don't support sharing
   *  throw on a non-empty map rather than silently dropping it. */
  mcpServers?: Record<string, McpServerSpec>;
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
  /** Directory of installable editor-plugin assets shipped with the connector
   *  (e.g. a Claude Code plugin dir), when the agent type needs a one-time
   *  plugin install. Consumers (like `cotal setup`) resolve it via the registry
   *  so they never import the extension package directly. */
  readonly pluginRoot?: string;
}
