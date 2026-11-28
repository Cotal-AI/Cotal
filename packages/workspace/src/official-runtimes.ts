/**
 * The first-party runtimes, name → npm package. This is NOT authority: registration is still
 * explicit (`cotal ext add` installs the package; importing it self-registers the provider). It is
 * the operator-UX source of truth so an uninstalled runtime refusal names a REAL package, a typo
 * says "unknown" instead of inventing `@cotal-ai/<typo>`, and `cotal runtimes` can list what is one
 * `cotal ext add` away. A third-party runtime installs under its own package name and, once added,
 * resolves like any other; it just is not listed here up front.
 *
 * It lives in workspace (not cli) because both the CLI and the manager phrase the refusal for an
 * absent runtime from it, and the manager must not import the CLI.
 */
export const OFFICIAL_RUNTIMES: Readonly<Record<string, string>> = {
  orca: "@cotal-ai/orca",
  tmux: "@cotal-ai/tmux",
  cmux: "@cotal-ai/cmux",
  herdr: "@cotal-ai/herdr",
  paseo: "@cotal-ai/paseo",
};

/** Every runtime name known without importing anything: `pty` (built in) plus the officials. */
export function knownRuntimeNames(): string[] {
  return ["pty", ...Object.keys(OFFICIAL_RUNTIMES)];
}

/** The refusal for a runtime that has no installed provider: name the exact package for an official
 *  runtime, else say it is unknown and list the ones known here. Never invent an `@cotal-ai/<name>`
 *  package for a typo (a custom provider installs under its own package name). Shared by the CLI's
 *  lookup and the manager's per-seat lookup so the message never drifts between the two. */
export function runtimeInstallHint(name: string): string {
  const pkg = OFFICIAL_RUNTIMES[name];
  if (pkg) return `no installed extension provides runtime "${name}" - install it with \`cotal ext add ${pkg}\``;
  return `unknown runtime "${name}" (known: ${knownRuntimeNames().join(", ")}) - install a provider with \`cotal ext add <npm-package>\`, or check the name`;
}
