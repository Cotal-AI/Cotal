/**
 * The four first-party agent connectors, name → npm package. This is NOT authority — a connector is
 * usable only once installed (seeded on first run, or `cotal ext add`ed) and imported, exactly like
 * a third-party one. It is the operator-UX source of truth so an absent official connector names its
 * REAL package in the install hint, and the seeder knows which built-ins to seed. A third-party
 * connector installs under its own package name and resolves the same way without appearing here.
 *
 * It lives in workspace (not cli) because both the CLI and the manager consume it and the manager
 * must not import the CLI — it is pure data supplied to the generic materialize/hint path.
 */
export const OFFICIAL_CONNECTORS: Readonly<Record<string, string>> = {
  claude: "@cotal-ai/connector-claude-code",
  opencode: "@cotal-ai/connector-opencode",
  hermes: "@cotal-ai/connector-hermes",
  pi: "@cotal-ai/pi",
};

/** The default connector/agent type when `COTAL_DEFAULT_AGENT` is unset (David's locked decision). */
export const DEFAULT_CONNECTOR = "claude";

/** `cotal` is reserved: it is the binary's own name, so a connector must never claim it (there is no
 *  runtime alias anymore). Rejected at `cotal ext add` and at materialization. */
export const RESERVED_CONNECTOR_NAMES: readonly string[] = ["cotal"];

/** The install-hint for an absent connector: name the exact package for an official one, else the
 *  generic `cotal ext add` form. Shared by the manager and the CLI so the message never drifts. */
export function connectorInstallHint(name: string): string {
  const pkg = OFFICIAL_CONNECTORS[name];
  return pkg
    ? `no connector "${name}" installed - add it with \`cotal ext add ${pkg}\``
    : `no connector "${name}" - install its integration with \`cotal ext add <npm-package>\`, or check the name`;
}
