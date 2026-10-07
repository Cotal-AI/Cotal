import type { McpServerSpec } from "./connector-config.js";
import type { Extension } from "./registry.js";

/** One connector-owned setup action. The CLI supplies only generic Cotal inputs; every
 * harness-specific executable, asset layout, scope, and verification rule stays in the provider. */
export interface ConnectorSetupAction<Input = void> {
  readonly name: string;
  readonly title: string;
  readonly explain: string;
  readonly context?: readonly string[];
  /** Declared as a property because TypeScript checks method parameters bivariantly: as a method, a
   * provider whose action narrows `Input` past what the CLI sends would still compile. */
  readonly run: (input: Input) => Promise<string> | string;
}

/** Inputs shared by connector-specific skills installers. The authored skills themselves use the
 * cross-vendor Agent Skills format; a provider decides how its harness consumes them. */
export interface ConnectorSkillsSetupInput {
  readonly skillsDir: string;
  readonly version: string;
  readonly stateDir: string;
}

/** What a connector's share action receives: the one cotal config write it makes. The CLI binds it to
 * the connector's section and serializes it across processes, so two setups cannot both seed. */
export interface ConnectorShareSetupInput {
  /** Record `servers` as what this connector shares, unless the cotal config already declares a list
   * for it. Returns whether it wrote. */
  seed(servers: Record<string, McpServerSpec>): boolean;
}

/** An interactive debug session a connector's harness can host when a setup step fails. The CLI
 * builds the prompt and owns the menu; the provider owns the executable, its flags, and any session
 * it keeps across handoffs in one setup run. */
export interface ConnectorAssist {
  /** Harness name the recovery menu shows ("Debug it with <title>"). */
  readonly title: string;
  /** Hand the terminal to the harness primed with `prompt`. Resolves when the operator exits it;
   * rejects when the harness cannot be launched. A property so a narrowed `prompt` fails to compile,
   * as {@link ConnectorSetupAction.run} explains. */
  readonly run: (prompt: string) => Promise<void>;
}

/** Generic Cotal inputs a provider's status check compares against. */
export interface ConnectorStatusInput {
  /** The running CLI's release, the version connector-installed assets are expected at. */
  readonly version: string;
  /** The command that repairs connector skills on this machine. */
  readonly skillsRemedy: string;
}

/** One machine-status row a provider reports for its harness. `ok` renders green, `warn` yellow,
 * `error` red and `off` dim. */
export interface ConnectorStatusRow {
  readonly label: string;
  readonly state: "ok" | "warn" | "error" | "off";
  readonly text: string;
}

/** Optional setup surface declared by a connector through {@link Connector.setup}. A missing or
 * broken declared provider is always a loud registry error; the CLI never substitutes a built-in
 * harness implementation. */
export interface ConnectorSetupProvider extends Extension {
  readonly kind: "connector-setup";
  readonly name: string;
  /** Native executables required to run this provider. If none are present on PATH, setup skips this
   * provider while still reconciling the cross-vendor skills drop. */
  readonly requires?: readonly string[];
  readonly connector?: ConnectorSetupAction;
  readonly skills?: ConnectorSetupAction<ConnectorSkillsSetupInput>;
  /** Shares the MCP servers the user's own harness sessions load with the agents this connector
   * spawns. First-run setup runs it; a share list the cotal config already declares is kept. */
  readonly mcpServers?: ConnectorSetupAction<ConnectorShareSetupInput>;
  readonly assist?: ConnectorAssist;
  /** Read-only health of what this provider installs, for `cotal status` and the setup card. A
   * property so a narrowed `input` fails to compile, as {@link ConnectorSetupAction.run} explains. */
  readonly status?: (input: ConnectorStatusInput) => readonly ConnectorStatusRow[];
}
