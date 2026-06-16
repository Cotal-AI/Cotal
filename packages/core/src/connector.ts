import type { Extension } from "./registry.js";

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
}

/** A recipe for starting an agent as a mesh node — command, args, and extra env. */
export interface LaunchSpec {
  command: string;
  args: string[];
  env?: Record<string, string>;
  /** Auto-clear startup confirm prompts: while this text is on screen during the agent's
   *  first seconds, the runtime presses Enter to accept it, so a supervised launch stays
   *  non-interactive. Fires once per prompt (Claude can show several back-to-back — workspace
   *  trust, then the dev-channels warning). Matched after stripping ANSI + whitespace (TUIs
   *  position text with cursor moves, not spaces). */
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
}
