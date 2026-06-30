/**
 * The cotal config file — per-connector launch settings, the first general config notion in
 * the repo (alongside `.cotal/{auth,agents,creds}`, which are about identity, not settings).
 *
 *   ~/.config/cotal/config.json   (operator-level, every space)   ← base layer
 *   <root>/.cotal/config.json     (space-local override)          ← higher precedence
 *
 * Today it carries one thing: which of the operator's personal MCP servers a connector should
 * SHARE with the agents it spawns. By default a spawned agent gets none — the Claude connector
 * launches with `--strict-mcp-config`, dropping every operator server, because they're heavy
 * (a headless Chromium server alone can climb past a gigabyte) and useless to a meshed teammate.
 * This file is the explicit opt-in to pass named ones through.
 *
 * Each server is written in the de-facto `.mcp.json` shape, so an operator can copy an entry
 * straight out of their own Claude / VS Code / Cursor config. Secrets ride as `${VAR}` references
 * resolved from the operator's environment at launch — never literals — so the file stays safe to
 * keep in `~/.config` or a gitignored `.cotal/`.
 *
 * This is deliberately NOT in the agent file ({@link AgentDef}): that's the connector-agnostic
 * identity, portable across Claude Code / OpenCode / Hermes, and MCP-passthrough isn't a shared
 * concept (Claude uses `--mcp-config`, OpenCode inherits via a merge layer, Hermes has no MCP).
 * The caller (both spawn paths) resolves this once and hands the chosen servers to the connector,
 * which renders them into its own host format.
 */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** One MCP server, in the de-facto `.mcp.json` shape. Secrets belong in `env` (or `headers`) as
 *  `${VAR}` references, resolved from the operator's environment at launch. Remote-transport fields
 *  (`type`/`url`/`headers`) are carried verbatim for connectors that support them. Any other
 *  `.mcp.json` key an operator copies in (e.g. `timeout`) passes through to the rendered config
 *  unchanged but gets NO `${VAR}` expansion — Claude only expands command/args/env/url/headers,
 *  which is exactly the set {@link mcpServerEnvKeys} scans for secret names to forward. */
export interface McpServerSpec {
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  type?: string;
  url?: string;
  headers?: Record<string, string>;
  /** Pass-through for any other `.mcp.json` key (carried verbatim, no env expansion). */
  [key: string]: unknown;
}

/** Per-connector settings. `mcpServers` are the operator servers SHARED with agents this connector
 *  spawns, keyed by server name (`.mcp.json`-style). */
export interface ConnectorConfig {
  mcpServers?: Record<string, McpServerSpec>;
}

/** The parsed cotal config file: a section per connector, keyed by connector name ("claude", …). */
export interface CotalConfig {
  connectors?: Record<string, ConnectorConfig>;
}

/** Operator-level config path: `$XDG_CONFIG_HOME/cotal/config.json`; else `%APPDATA%\Cotal\config.json`
 *  on Windows (the platform's per-user roaming config dir) or `~/.config/cotal/config.json` on POSIX. */
export function globalConfigPath(): string {
  const xdg = process.env.XDG_CONFIG_HOME?.trim();
  if (xdg) return join(xdg, "cotal", "config.json");
  if (process.platform === "win32" && process.env.APPDATA?.trim())
    return join(process.env.APPDATA.trim(), "Cotal", "config.json");
  return join(homedir(), ".config", "cotal", "config.json");
}

/** Space-local config path: `<root>/.cotal/config.json`. */
export function spaceConfigPath(root: string): string {
  return join(root, ".cotal", "config.json");
}

/** Parse one config file. A missing file is empty (no config is a valid state); malformed JSON or a
 *  non-object top level throws — a typo in your settings should be loud, not silently ignored. */
function readConfigFile(path: string): CotalConfig {
  if (!existsSync(path)) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    throw new Error(`cotal config ${path}: invalid JSON — ${(e as Error).message}`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
    throw new Error(`cotal config ${path}: top level must be a JSON object`);
  return parsed as CotalConfig;
}

/** Layer `over` onto `base`: per connector, a server in `over` replaces the same-named server in
 *  `base` (whole-spec replace, by name — the same merge the MCP clients do); servers/connectors
 *  present in only one side are kept. */
function mergeConfig(base: CotalConfig, over: CotalConfig): CotalConfig {
  const connectors: Record<string, ConnectorConfig> = {};
  const names = new Set([...Object.keys(base.connectors ?? {}), ...Object.keys(over.connectors ?? {})]);
  for (const name of names) {
    const b = base.connectors?.[name];
    const o = over.connectors?.[name];
    connectors[name] = { ...b, ...o, mcpServers: { ...(b?.mcpServers ?? {}), ...(o?.mcpServers ?? {}) } };
  }
  return { connectors };
}

/** Load the merged cotal config: the operator-level file as the base, the space-local file layered
 *  on top (more specific wins, per connector + server name). */
export function loadCotalConfig(root: string): CotalConfig {
  return mergeConfig(readConfigFile(globalConfigPath()), readConfigFile(spaceConfigPath(root)));
}

/** The MCP servers a connector should share with an agent it spawns, after applying an optional
 *  per-spawn `selection` (the parsed `--share-tools` value):
 *    `undefined` → every server declared for the connector (the config default)
 *    `[]`        → none (e.g. `--share-tools none`)
 *    `[a, b]`    → only those named, which MUST be declared (throws otherwise — no silent drop). */
export function connectorServers(
  config: CotalConfig,
  connector: string,
  selection?: readonly string[],
): Record<string, McpServerSpec> {
  const declared = config.connectors?.[connector]?.mcpServers ?? {};
  if (selection === undefined) return { ...declared };
  const chosen: Record<string, McpServerSpec> = {};
  for (const name of selection) {
    const spec = declared[name];
    if (!spec)
      throw new Error(
        `--share-tools: "${name}" is not a shared server for connector "${connector}" ` +
          `(declared: ${Object.keys(declared).join(", ") || "none"})`,
      );
    chosen[name] = spec;
  }
  return chosen;
}

/** Parse a `--share-tools` flag value into a selection for {@link connectorServers}: flag absent
 *  → `undefined` (share all declared); `none` or empty → `[]` (share nothing); else the comma list. */
export function parseShareSelection(value: string | undefined): readonly string[] | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  if (trimmed === "" || trimmed.toLowerCase() === "none") return [];
  return trimmed
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}
