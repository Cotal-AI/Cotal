import { spawn, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import {
  globalConfigPath,
  mcpServerProblem,
  registry,
  type ConnectorSetupProvider,
  type ConnectorStatusInput,
  type ConnectorStatusRow,
  type McpServerSpec,
} from "@cotal-ai/core";
import { ENV_REFERENCE } from "@cotal-ai/connector-core";
import { CLI_RECORD } from "./cli-record.js";
import { desktopConfigPath, readDesktopEntry, writeDesktopEntry, type DesktopEntry } from "./desktop-config.js";
import { claudeUserMcpServers } from "./user-mcp.js";

const PACKAGE_ROOT = fileURLToPath(new URL("..", import.meta.url));

/** One installed-plugin entry, as `claude plugin list --json` reports it. */
type PluginEntry = Record<string, unknown>;

/** What the `cotal` plugin carries from this package. */
const COTAL_ASSETS = [".claude-plugin", ".mcp.json", "hooks", "monitors", "dist/mcp.cjs", "dist/hook.cjs", "dist/monitor.cjs"] as const;

/**
 * The version the materialized `cotal` plugin carries: this release, then a digest of every file it
 * holds. Claude Code keeps an installed plugin in a cache keyed by its version, and `plugin update`
 * replaces it only when the version changes, so a plugin whose version stayed put kept serving its
 * first install after every upgrade.
 */
function pluginVersion(root: string, assets: readonly string[], files: Readonly<Record<string, string>>): string {
  const hash = createHash("sha256");
  const add = (path: string, bytes: Buffer | string) => hash.update(`${path}\0${bytes.length}\0`).update(bytes);
  const walk = (path: string): void => {
    if (statSync(path).isDirectory()) for (const entry of readdirSync(path).sort()) walk(join(path, entry));
    else add(relative(root, path), readFileSync(path));
  };
  for (const asset of [...assets].sort()) walk(join(root, asset));
  for (const [path, text] of Object.entries(files).sort(([a], [b]) => a.localeCompare(b))) add(path, text);
  const release = (JSON.parse(readFileSync(join(PACKAGE_ROOT, "package.json"), "utf8")) as { version: string }).version;
  return `${release}+${hash.digest("hex").slice(0, 12)}`;
}

/** Materialize the `cotal` plugin for the CLI `cotal` and return the version it carries. */
function materializeCotal(cotal: readonly string[]): string {
  for (const asset of COTAL_ASSETS) if (!existsSync(join(PACKAGE_ROOT, asset))) throw new Error(`plugin asset missing: ${join(PACKAGE_ROOT, asset)}`);
  // How the plugin's server runs the CLI for a plain session's `cotal_connect`, by absolute path:
  // Claude Desktop starts a server with a minimal PATH.
  const files = { [`dist/${CLI_RECORD}`]: `${JSON.stringify({ argv: cotal })}\n` };
  const version = pluginVersion(PACKAGE_ROOT, COTAL_ASSETS, files);
  materialize("cotal", PACKAGE_ROOT, COTAL_ASSETS, version, files);
  return version;
}

/**
 * Bring every install of the `cotal` plugin to `version`, which the marketplace now holds. A
 * local-scope install belongs to one project and `plugin update` reaches only the one it runs in, so
 * each is updated from its own directory. An install whose project directory is gone is left alone.
 */
function updateInstalls(version: string, skip?: string): { current: number; missing: string[] } {
  let current = 0;
  const missing: string[] = [];
  for (const entry of listPlugins()) {
    if (entry.id !== `cotal@${MARKETPLACE}` || (entry.scope !== "local" && entry.scope !== "user")) continue;
    const project = entry.scope === "local" ? entry.projectPath : undefined;
    if (entry.scope === "local" && (typeof project !== "string" || !existsSync(project))) {
      missing.push(String(project));
      continue;
    }
    if (skip !== undefined && project !== undefined && samePath(project, skip)) continue;
    if (entry.version !== version) {
      const result = commandIn(project as string | undefined, "plugin", "update", `cotal@${MARKETPLACE}`, "--scope", entry.scope);
      if (result.status !== 0) throw new Error(`plugin update failed (cotal, ${project ?? "user scope"}):\n${result.output}`);
    }
    verify("cotal", entry.scope, version, project as string | undefined);
    current += 1;
  }
  return { current, missing };
}

/** The `cotal` entry Claude Desktop runs: the materialized server, started by the node that runs the
 *  CLI. Desktop starts it with its own environment, so a non-default Cotal home goes with it. */
function desktopEntry(cotal: readonly string[]): DesktopEntry {
  return {
    command: cotal[0]!,
    args: [join(marketplaceDir(), "cotal", "dist", "mcp.cjs"), "--desktop"],
    ...(process.env.COTAL_HOME ? { env: { COTAL_HOME: process.env.COTAL_HOME } } : {}),
  };
}

/** Write the `cotal` entry into Claude Desktop's config where Desktop is installed. With `add` false
 *  only an entry already there is brought current. `undefined` when there was nothing to do. */
function desktop(cotal: readonly string[], add: boolean): string | undefined {
  const path = desktopConfigPath();
  if (!path || !existsSync(dirname(path))) return undefined;
  if (!add && readDesktopEntry(path) === undefined) return undefined;
  const state = writeDesktopEntry(path, desktopEntry(cotal));
  return `Claude Desktop ${state}${state === "current" ? "" : "; quit and reopen Claude Desktop to load it"}`;
}

const installsText = (version: string, { current, missing }: { current: number; missing: string[] }): string =>
  `cotal@${MARKETPLACE} ${version} in ${current} install${current === 1 ? "" : "s"}${missing.length ? `; left alone, project gone: ${missing.join(", ")}` : ""}`;
const DOCS_URL = "https://github.com/Cotal-AI/Cotal/blob/main/docs/connect-claude.md";
const MARKETPLACE = "cotal-mesh";

function cotalHome(): string {
  if (process.env.COTAL_HOME) return process.env.COTAL_HOME;
  if (process.platform === "win32" && process.env.LOCALAPPDATA) return join(process.env.LOCALAPPDATA, "Cotal");
  return join(homedir(), ".cotal");
}

function marketplaceDir(): string {
  return join(cotalHome(), "claude-plugin");
}

function materialize(name: string, root: string, assets: readonly string[], version?: string, files: Readonly<Record<string, string>> = {}): void {
  const market = marketplaceDir();
  mkdirSync(market, { recursive: true });
  const dest = join(market, name);
  const staging = `${dest}.staging.${process.pid}`;
  const old = `${dest}.old.${process.pid}`;
  const orphans = readdirSync(market, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && (entry.name.startsWith(`${name}.old.`) || entry.name.startsWith(`${name}.staging.`)))
    .map((entry) => entry.name);
  if (!existsSync(dest)) {
    const recoverable = orphans.find((entry) => entry.startsWith(`${name}.old.`));
    if (recoverable) renameSync(join(market, recoverable), dest);
  }
  for (const entry of orphans) rmSync(join(market, entry), { recursive: true, force: true });
  let movedAside = false;
  let swapped = false;
  try {
    mkdirSync(staging, { recursive: true });
    for (const asset of assets) {
      const destination = join(staging, asset);
      mkdirSync(join(destination, ".."), { recursive: true });
      cpSync(join(root, asset), destination, { recursive: true, dereference: true });
    }
    for (const [path, text] of Object.entries(files)) writeFileSync(join(staging, path), text);
    if (version) {
      const manifestPath = join(staging, ".claude-plugin", "plugin.json");
      const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as Record<string, unknown>;
      manifest.version = version;
      writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
    }
    if (existsSync(dest)) {
      renameSync(dest, old);
      movedAside = true;
    }
    renameSync(staging, dest);
    swapped = true;
    if (movedAside) rmSync(old, { recursive: true, force: true });
  } catch (error) {
    if (movedAside && !swapped && !existsSync(dest) && existsSync(old)) renameSync(old, dest);
    throw error;
  } finally {
    rmSync(staging, { recursive: true, force: true });
    if (swapped) rmSync(old, { recursive: true, force: true });
  }
}

function commandIn(cwd: string | undefined, ...args: string[]): { status: number | null; output: string } {
  const result = spawnSync("claude", args, { encoding: "utf8", ...(cwd ? { cwd } : {}) });
  return { status: result.status, output: `${result.stdout ?? ""}${result.stderr ?? ""}`.trim() };
}

function command(...args: string[]): { status: number | null; output: string } {
  return commandIn(undefined, ...args);
}

/**
 * A marketplace entry is an OBJECT carrying `source`, never a bare name. Claude Code validates the
 * manifest either way, so the string form passes `plugin marketplace add`/`update` and then fails
 * at resolution with `Plugin "cotal" not found in marketplace "cotal-mesh"` — a message that points
 * at a stale local copy rather than at the manifest, so `marketplace update` looks like the remedy
 * and changes nothing.
 *
 * `description` is read from each plugin's own `plugin.json` rather than written here, so the two
 * files cannot drift into disagreeing about the same plugin.
 */
function marketplaceEntry(market: string, name: string): { name: string; source: string; description?: string } {
  const manifest = JSON.parse(readFileSync(join(market, name, ".claude-plugin", "plugin.json"), "utf8")) as {
    description?: unknown;
  };
  const description = typeof manifest.description === "string" ? manifest.description : undefined;
  return { name, source: `./${name}`, ...(description ? { description } : {}) };
}

/** Exported so a suite can grade the manifest that is actually written, not a second copy of it. */
export function marketplaceManifest(market: string): {
  name: string;
  description: string;
  owner: { name: string };
  plugins: { name: string; source: string; description?: string }[];
} {
  const plugins = ["cotal", "cotal-skills"]
    .filter((name) => existsSync(join(market, name, ".claude-plugin", "plugin.json")))
    .map((name) => marketplaceEntry(market, name));
  return { name: MARKETPLACE, description: "Cotal for Claude Code", owner: { name: "Cotal" }, plugins };
}

/**
 * The write half of `writeMarketplace`, split out from the `plugin marketplace add` that follows it
 * so a suite can grade the bytes that reach disk without spawning `claude`. Returns the path so a
 * caller reads back the file this wrote rather than one it rebuilt from the same inputs.
 */
export function writeMarketplaceManifest(market: string): string {
  const path = join(market, ".claude-plugin", "marketplace.json");
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(marketplaceManifest(market), null, 2) + "\n");
  return path;
}

function writeMarketplace(): void {
  const market = marketplaceDir();
  writeMarketplaceManifest(market);
  const add = command("plugin", "marketplace", "add", market);
  if (add.status !== 0 && !/already (?:exists|added)/i.test(add.output)) throw new Error(`plugin marketplace add failed:\n${add.output}`);
  if (/already (?:exists|added)/i.test(add.output)) {
    const update = command("plugin", "marketplace", "update", MARKETPLACE);
    if (update.status !== 0) throw new Error(`plugin marketplace update failed:\n${update.output}`);
  }
}

/** Every installed plugin, as `claude plugin list --json` reports it from `cwd`. It lists local-scope
 *  installs of every project, each with its `projectPath`, but `enabled` says whether the plugin is
 *  enabled in `cwd`, not in the install's own project. */
function listPlugins(cwd?: string): PluginEntry[] {
  const result = commandIn(cwd, "plugin", "list", "--json");
  if (result.status !== 0) throw new Error(`plugin list failed:\n${result.output}`);
  let entries: unknown;
  try {
    entries = JSON.parse(result.output);
  } catch {
    throw new Error(`could not parse plugin list:\n${result.output}`);
  }
  if (!Array.isArray(entries)) throw new Error(`could not parse plugin list:\n${result.output}`);
  return entries as PluginEntry[];
}

const samePath = (a: unknown, b: string): boolean => {
  if (typeof a !== "string") return false;
  try {
    return realpathSync(a) === realpathSync(b);
  } catch {
    return false;
  }
};

/** `project` names the local-scope install to check, whose `projectPath` is that directory. It is
 *  listed from there, where `enabled` describes it. */
function verify(name: string, scope: string, expectedVersion?: string, project?: string): void {
  const match = listPlugins(scope === "local" ? project : undefined).find(
    (entry) => entry.id === `${name}@${MARKETPLACE}` && entry.scope === scope && (scope !== "local" || samePath(entry.projectPath, project ?? process.cwd())),
  );
  const where = `${scope} scope${scope === "local" ? `, ${project ?? process.cwd()}` : ""}`;
  if (!match) throw new Error(`plugin ${name}@${MARKETPLACE} (${where}) is not installed`);
  if (match.enabled !== true || (match as { errors?: unknown[] }).errors?.length)
    throw new Error(`plugin ${name}@${MARKETPLACE} (${where}) did not load: ${JSON.stringify({ enabled: match.enabled, errors: match.errors })}`);
  if (expectedVersion && (match as { version?: unknown }).version !== expectedVersion)
    throw new Error(`plugin ${name}@${MARKETPLACE} loaded version ${String((match as { version?: unknown }).version)}; expected ${expectedVersion}`);
}

function install(name: string, scope: string, expectedVersion?: string): void {
  writeMarketplace();
  const result = command("plugin", "install", `${name}@${MARKETPLACE}`, "--scope", scope);
  if (result.status !== 0 && !/already installed/i.test(result.output)) throw new Error(`plugin install failed (${name}):\n${result.output}`);
  if (/already installed/i.test(result.output)) {
    const update = command("plugin", "update", `${name}@${MARKETPLACE}`, "--scope", scope);
    if (update.status !== 0) throw new Error(`plugin update failed (${name}):\n${update.output}`);
  }
  verify(name, scope, expectedVersion);
}


/** The installed Claude Code plugins, or undefined when Claude cannot be launched or queried (both of
 *  which status renders as "unknown" rather than "absent"). ONE spawn serves both rows. */
function pluginList(): PluginEntry[] | undefined {
  const result = spawnSync("claude", ["plugin", "list", "--json"], { encoding: "utf8" });
  if (result.status !== 0) return undefined;
  try {
    const parsed: unknown = JSON.parse(result.stdout || "[]");
    return Array.isArray(parsed) ? (parsed as PluginEntry[]) : undefined;
  } catch {
    return undefined;
  }
}

/** The skills plugin vs the running CLI release, by the SAME predicate `verify` enforces after an
 *  install (id, scope, enabled, errors, version), so status never blesses a plugin the installer would
 *  reject. Stale, missing and broken all name the scoped remedy. */
function skillsRow(entries: PluginEntry[] | undefined, { version, skillsRemedy }: ConnectorStatusInput): ConnectorStatusRow {
  const row = (state: ConnectorStatusRow["state"], text: string): ConnectorStatusRow => ({ label: "Claude skills", state, text });
  if (entries === undefined) return row("off", "unknown");
  const match = entries.find((entry) => entry.id === `cotal-skills@${MARKETPLACE}` && entry.scope === "user");
  if (!match || match.enabled === false) return row("off", `not installed · ${skillsRemedy}`);
  const errors = (match.errors ?? match.error) as unknown;
  if (Array.isArray(errors) ? errors.length > 0 : Boolean(errors)) return row("error", `load error · ${skillsRemedy}`);
  if (match.version === version) return row("ok", "current");
  return row("warn", `${typeof match.version === "string" ? `v${match.version} ≠ v${version} · ` : ""}stale · ${skillsRemedy}`);
}

/** The `cotal` plugin's installs against the copy setup last materialized, whose version must be this
 *  release's. Any install on another version still runs what an earlier setup copied. */
function pluginRow(entries: PluginEntry[] | undefined, { version }: ConnectorStatusInput): ConnectorStatusRow {
  const row = (state: ConnectorStatusRow["state"], text: string): ConnectorStatusRow => ({ label: "Claude plugin", state, text });
  if (entries === undefined) return row("off", "unknown");
  const installs = entries.filter((entry) => entry.id === `cotal@${MARKETPLACE}`);
  if (!installs.length) return row("off", "not installed");
  if (installs.some((entry) => (Array.isArray(entry.errors) ? entry.errors.length > 0 : Boolean(entry.errors ?? entry.error))))
    return row("error", "load error · run `cotal setup`");
  let materialized: unknown;
  try {
    materialized = (JSON.parse(readFileSync(join(marketplaceDir(), "cotal", ".claude-plugin", "plugin.json"), "utf8")) as { version?: unknown }).version;
  } catch {
    materialized = undefined;
  }
  const stale = installs.filter((entry) => entry.version !== materialized).length;
  if (typeof materialized !== "string" || !materialized.startsWith(`${version}+`) || stale)
    return row("warn", `${stale ? `${stale} of ${installs.length} installs ` : ""}stale · run \`cotal setup\``);
  return row("ok", `current (${installs.length} install${installs.length === 1 ? "" : "s"})`);
}

/** Cotal's entry in Claude Desktop's config, where Desktop is installed. It must run the server setup
 *  materialized. */
function desktopRow(): ConnectorStatusRow | undefined {
  const path = desktopConfigPath();
  if (!path || !existsSync(dirname(path))) return undefined;
  const row = (state: ConnectorStatusRow["state"], text: string): ConnectorStatusRow => ({ label: "Claude Desktop", state, text });
  let entry: unknown;
  try {
    entry = readDesktopEntry(path);
  } catch (e) {
    return row("error", (e as Error).message);
  }
  if (entry === undefined) return row("off", "not added · run `cotal setup`");
  const server = (entry as { args?: unknown }).args;
  const expected = join(marketplaceDir(), "cotal", "dist", "mcp.cjs");
  if (!Array.isArray(server) || server[0] !== expected || !existsSync(expected)) return row("warn", "stale · run `cotal setup`");
  return row("ok", "added");
}

/** Whether setup may copy a server entry into the cotal config: the config reader must accept it
 *  ({@link mcpServerProblem}), or every spawn would be refused. That config holds secrets only as
 *  `${VAR}` references, and literal text cannot be told apart from a secret, so every `env` and
 *  `headers` value must be references and nothing else. */
function copyable(name: string, spec: unknown): spec is McpServerSpec {
  if (mcpServerProblem(name, spec) !== undefined) return false;
  const { env, headers } = spec as McpServerSpec;
  return [env, headers].every((values) => values === undefined || Object.values(values).every((v) => v.replace(ENV_REFERENCE, "") === ""));
}

// All handoffs in one setup run share a single Claude session: the first spawn pins a generated UUID
// (--session-id), later spawns --resume it, so Claude keeps the context of earlier failures. stdio is
// inherited, so pinning our own id is the only way to find the session again.
let assistSession: string | undefined;

export const claudeSetupProvider: ConnectorSetupProvider = {
  kind: "connector-setup",
  name: "claude",
  requires: ["claude"],
  connector: {
    name: "claude-plugin",
    title: "Install the Claude Code plugin",
    explain: "Lets a Claude Code session join the web and wake on peer messages.",
    context: [DOCS_URL],
    run({ cotal }) {
      const version = materializeCotal(cotal);
      install("cotal", "local", version);
      // The marketplace now holds this version, so every other install moves to it too.
      updateInstalls(version, process.cwd());
      const app = desktop(cotal, true);
      return `cotal@${MARKETPLACE} (local scope)${app ? `; ${app}` : ""}`;
    },
  },
  refresh: {
    name: "claude-plugin-refresh",
    title: "Refresh the Claude Code plugin",
    explain: "Brings every installed copy of the Cotal plugin for Claude Code, and Cotal's entry in Claude Desktop, to this release.",
    context: [DOCS_URL],
    run({ cotal }) {
      const code = listPlugins().some((entry) => entry.id === `cotal@${MARKETPLACE}`);
      const path = desktopConfigPath();
      const app = path !== undefined && readDesktopEntry(path) !== undefined;
      if (!code && !app) return "not installed";
      const version = materializeCotal(cotal);
      const parts: string[] = [];
      if (code) {
        writeMarketplace();
        parts.push(installsText(version, updateInstalls(version)));
      }
      const desktopText = app ? desktop(cotal, false) : undefined;
      if (desktopText) parts.push(desktopText);
      return parts.join("; ");
    },
  },
  skills: {
    name: "claude-skills-plugin",
    title: "Add Cotal's skills to Claude Code",
    explain: "Installs Cotal's authored skills as a Claude Code plugin.",
    context: [DOCS_URL],
    run({ skillsDir, version, stateDir }) {
      const manifestRoot = join(PACKAGE_ROOT, "skills-plugin");
      if (!existsSync(join(manifestRoot, ".claude-plugin", "plugin.json"))) throw new Error("Claude skills plugin manifest is missing");
      const payload = join(stateDir, `.claude-skills-payload.${process.pid}`);
      rmSync(payload, { recursive: true, force: true });
      try {
        mkdirSync(payload, { recursive: true });
        cpSync(join(manifestRoot, ".claude-plugin"), join(payload, ".claude-plugin"), { recursive: true, dereference: true });
        cpSync(skillsDir, join(payload, "skills"), { recursive: true, dereference: true });
        materialize("cotal-skills", payload, [".claude-plugin", "skills"], version);
        install("cotal-skills", "user", version);
        return `cotal-skills@${MARKETPLACE} (user scope)`;
      } finally {
        rmSync(payload, { recursive: true, force: true });
      }
    },
  },
  mcpServers: {
    name: "claude-mcp-servers",
    title: "Share your MCP servers with spawned sessions",
    explain:
      "A spawned Claude Code session gets the cotal tools plus the MCP servers your own sessions load. Each spawn starts its own copy of every shared server, so on a small machine remove the heavy ones from the cotal config or spawn with --share-tools none.",
    context: [DOCS_URL],
    run({ seed }) {
      const installed = Object.entries(claudeUserMcpServers());
      const shared = Object.fromEntries(installed.filter((entry): entry is [string, McpServerSpec] => copyable(...entry)));
      const left = installed.filter((entry) => !copyable(...entry)).map(([name]) => name);
      const path = globalConfigPath();
      // An empty list is recorded too: a later setup keeps whatever list the first run wrote.
      if (!seed(shared)) return `kept the list ${path} already declares`;
      const parts = [`${Object.keys(shared).join(", ") || "none"} via ${path}`];
      if (left.length)
        parts.push(`not shared: ${left.join(", ")} (setup copies a server only when it is well formed and its env and headers values are all \${VAR} references; add it to ${path} by hand to share it)`);
      return parts.join("; ");
    },
  },
  assist: {
    title: "Claude",
    run(prompt) {
      const sessionArgs = assistSession ? ["--resume", assistSession] : ["--session-id", (assistSession = randomUUID())];
      const child = spawn("claude", [prompt, "--permission-mode", "auto", ...sessionArgs], { stdio: "inherit" });
      return new Promise<void>((resolve, reject) => {
        child.on("exit", () => resolve());
        child.on("error", reject);
      });
    },
  },
  status(input) {
    const plugins = pluginList();
    const app = desktopRow();
    return [pluginRow(plugins, input), ...(app ? [app] : []), skillsRow(plugins, input)];
  },
};

registry.register(claudeSetupProvider);
