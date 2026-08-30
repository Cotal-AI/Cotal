import type { Extension } from "./registry.js";

/** One connector-owned setup action. The CLI supplies only generic Cotal inputs; every
 * harness-specific executable, asset layout, scope, and verification rule stays in the provider. */
export interface ConnectorSetupAction<Input = void> {
  readonly name: string;
  readonly title: string;
  readonly explain: string;
  readonly context?: readonly string[];
  run(input: Input): Promise<string> | string;
}

/** Inputs shared by connector-specific skills installers. The authored skills themselves use the
 * cross-vendor Agent Skills format; a provider decides how its harness consumes them. */
export interface ConnectorSkillsSetupInput {
  readonly skillsDir: string;
  readonly version: string;
  readonly stateDir: string;
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
}
