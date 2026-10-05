/**
 * The cotal config file — per-connector launch settings, the first general config notion in
 * the repo (alongside `.cotal/{auth,agents,creds}`, which are about identity, not settings).
 *
 *   ~/.config/cotal/config.json   (operator-level, every space)   ← base layer
 *   <root>/.cotal/config.json     (space-local override)          ← higher precedence
 *
 * Today it carries one thing: which of the operator's personal MCP servers a connector should
 * SHARE with the agents it spawns. With no list a spawned agent gets none — the Claude connector
 * launches with `--strict-mcp-config`, dropping every operator server. First-run setup seeds the
 * list from the servers the user's own harness sessions load, so a spawned session keeps their
 * tools; removing entries makes a lighter seat, since each spawn boots its own copy of every shared
 * server (a headless Chromium server alone can climb past a gigabyte).
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

/** Deliberate extra environment names for a spawned agent. The default boundary is a fixed OS
 *  allow-list, the machine-wide `COTAL_*` operator knobs, and connector-declared inputs. `env` adds
 *  named capability (including a host-session marker a persona has opted into); an empty array adds
 *  none. There is no inherit mode. */
export interface SpawnConfig {
  env?: string[];
}

/** The models one role may launch on, declared under `modelPolicy.<role>`. Ids compare whole, so
 *  `vendor/model-B-fast` is not `vendor/model-B`. When `variants` is set the variant must be one of
 *  those too. */
export interface RoleModelPolicy {
  models: string[];
  variants?: string[];
}

/** The parsed cotal config file: a section per connector, keyed by connector name ("claude", …),
 *  plus machine-local spawn policy and the per-role model allowlist. */
export interface CotalConfig {
  connectors?: Record<string, ConnectorConfig>;
  spawn?: SpawnConfig;
  modelPolicy?: Record<string, RoleModelPolicy>;
}

/** Operator-level config dir: `$XDG_CONFIG_HOME/cotal`; else `%APPDATA%\Cotal` on Windows (the
 *  platform's per-user roaming config dir) or `~/.config/cotal` on POSIX. Holds `config.json`
 *  and the installed-extensions prefix. */
export function globalConfigDir(): string {
  const xdg = process.env.XDG_CONFIG_HOME?.trim();
  if (xdg) return join(xdg, "cotal");
  if (process.platform === "win32" && process.env.APPDATA?.trim())
    return join(process.env.APPDATA.trim(), "Cotal");
  return join(homedir(), ".config", "cotal");
}

/** Operator-level config path: `<globalConfigDir()>/config.json`. */
export function globalConfigPath(): string {
  return join(globalConfigDir(), "config.json");
}

/** Space-local config path: `<root>/.cotal/config.json`. */
export function spaceConfigPath(root: string): string {
  return join(root, ".cotal", "config.json");
}

/** Parse one config file. A missing file is empty (no config is a valid state); malformed JSON or a
 *  non-object top level throws — a typo in your settings should be loud, not silently ignored. */
export function readCotalConfigFile(path: string): CotalConfig {
  if (!existsSync(path)) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    throw new Error(`cotal config ${path}: invalid JSON - ${(e as Error).message}`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
    throw new Error(`cotal config ${path}: top level must be a JSON object`);
  const policy = (parsed as { modelPolicy?: unknown }).modelPolicy;
  if (policy !== undefined) checkModelPolicy(path, policy);
  return parsed as CotalConfig;
}

/** A model policy that cannot be read as written is refused, never skipped: skipping it would launch
 *  every seat it was written to constrain. */
function checkModelPolicy(path: string, policy: unknown): void {
  const bad = (what: string) => new Error(`cotal config ${path}: ${what}`);
  if (typeof policy !== "object" || policy === null || Array.isArray(policy))
    throw bad("modelPolicy must be an object keyed by role");
  for (const [role, entry] of Object.entries(policy)) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry))
      throw bad(`modelPolicy.${role} must be an object with a models list`);
    const extra = Object.keys(entry).find((key) => key !== "models" && key !== "variants");
    if (extra !== undefined) throw bad(`modelPolicy.${role} has unsupported field "${extra}" (expected models, variants)`);
    for (const field of ["models", "variants"] as const) {
      const list = (entry as Record<string, unknown>)[field];
      if (list === undefined && field === "variants") continue;
      if (!Array.isArray(list) || list.length === 0 || list.some((id) => typeof id !== "string" || id.trim() === ""))
        throw bad(`modelPolicy.${role}.${field} must be a non-empty list of ${field === "models" ? "model" : "variant"} ids`);
    }
  }
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
  // `spawn` replaces WHOLESALE rather than merging per key the way servers do. An allow-list is one
  // policy statement, and a space-local file that names three variables means those three, not those
  // three plus whatever the operator-level file happened to list. Silently unioning two allow-lists
  // would widen the narrower one, which is the wrong direction for a containment setting.
  const spawn = over.spawn ?? base.spawn;
  // `modelPolicy` merges per role: a space-local entry replaces the operator-level entry for that
  // role, and a role named in only one file keeps its entry. Replacing the whole map instead would
  // let a space-local file that constrains one role silently unconstrain every other.
  const modelPolicy = base.modelPolicy || over.modelPolicy ? { ...base.modelPolicy, ...over.modelPolicy } : undefined;
  return { connectors, ...(spawn === undefined ? {} : { spawn }), ...(modelPolicy === undefined ? {} : { modelPolicy }) };
}

/** Load the merged cotal config: the operator-level file as the base, the space-local file layered
 *  on top (more specific wins, per connector + server name). */
export function loadCotalConfig(root: string): CotalConfig {
  return mergeConfig(readCotalConfigFile(globalConfigPath()), readCotalConfigFile(spaceConfigPath(root)));
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

/** Extra spawned-agent environment names the operator declared. Undefined means no extras. */
export function spawnEnvAllow(config: CotalConfig): readonly string[] | undefined {
  return config.spawn?.env;
}

/** One spawn's effective launch, as the model policy judges it. `persona` names the definition for
 *  the refusal; `modelFlag` / `variantFlag` say the value came from `--model` / `--variant` rather
 *  than the definition's own field. `launchOptions` is the merged `launchOptions:` and `--opt` bag. */
export interface ModelPolicyLaunch {
  persona: string;
  role?: string;
  model?: string;
  variant?: string;
  modelFlag: boolean;
  variantFlag: boolean;
  launchOptions?: Record<string, unknown>;
}

/** The operator-facing refusal for a launch whose role `modelPolicy` constrains and whose model or
 *  variant is absent or not on the role's list, or that carries launch options, or undefined when it
 *  may launch. A role with no entry, and a launch with no role, are unconstrained. An absent model is
 *  refused rather than defaulted: the harness would pick one, and nothing would record which. Launch
 *  options are refused because the connector applies them after the model and variant, unread, and
 *  one can select another model (an OpenCode `model`, a Claude `--model`, a Codex `-c model`). */
export function modelPolicyRefusal(config: CotalConfig, launch: ModelPolicyLaunch): string | undefined {
  const role = launch.role;
  if (role === undefined || !config.modelPolicy || !Object.hasOwn(config.modelPolicy, role)) return undefined;
  const policy = config.modelPolicy[role];
  const rule = `modelPolicy.${role} in the cotal config`;
  const check = (field: "model" | "variant", value: string | undefined, allowed: readonly string[], flag: boolean) => {
    const v = value?.trim() ? value : undefined;
    if (v === undefined)
      return `${launch.persona} has role "${role}" but resolves no ${field}, so the harness would choose one. ${rule} allows only: ${allowed.join(", ")}; declare one with \`${field}:\` or pass --${field}. The seat was not launched.`;
    if (!allowed.includes(v))
      return `${launch.persona} has role "${role}" and ${flag ? `the --${field} flag` : `its \`${field}:\` field`} names ${field} "${v}", which ${rule} does not allow (allowed: ${allowed.join(", ")}; ids must match whole). The seat was not launched.`;
    return undefined;
  };
  const options = Object.keys(launch.launchOptions ?? {});
  return check("model", launch.model, policy.models, launch.modelFlag)
    ?? (policy.variants ? check("variant", launch.variant, policy.variants, launch.variantFlag) : undefined)
    ?? (options.length
      ? `${launch.persona} has role "${role}" and carries launch options (${options.join(", ")}). The harness applies them unread, after the model, so one can select a model ${rule} does not allow. A role under modelPolicy launches without launch options: drop them from \`launchOptions:\` and --opt. The seat was not launched.`
      : undefined);
}
