import { spawn, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import {
  acquireLock,
  globalConfigPath,
  mcpServerProblem,
  registry,
  writePrivateRecord,
  type ConnectorSetupProvider,
  type ConnectorSkillsSetupInput,
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

/** The version the materialized `cotal` plugin carries: this release, then a digest of every file it
 *  holds, so `cotal status` can tell a copy an earlier release wrote. */
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
  const files = pluginFiles(cotal);
  const version = pluginVersion(PACKAGE_ROOT, COTAL_ASSETS, files);
  materialize("cotal", PACKAGE_ROOT, COTAL_ASSETS, version, files);
  return version;
}

/** Bind every installed entrypoint to the Node runtime running setup, including minimal app PATHs. */
function pluginFiles(cotal: readonly string[]): Record<string, string> {
  const node = cotal[0];
  if (!node) throw new Error("the Cotal CLI record has no Node executable");
  if (process.platform === "win32" && /[\"%!\r\n]/.test(node))
    throw new Error("the Node executable path contains characters Claude's Windows command hooks cannot safely run");
  const quoted = process.platform === "win32" ? `"${node}"` : `'${node.replace(/'/g, "'\\''")}'`;
  const mcp = JSON.parse(readFileSync(join(PACKAGE_ROOT, ".mcp.json"), "utf8")) as { mcpServers: { cotal: { command: string } } };
  mcp.mcpServers.cotal.command = node;
  const hooks = JSON.parse(readFileSync(join(PACKAGE_ROOT, "hooks", "hooks.json"), "utf8")) as {
    hooks: Record<string, Array<{ hooks: Array<{ command?: string }> }>>;
  };
  for (const groups of Object.values(hooks.hooks)) for (const group of groups) for (const hook of group.hooks) {
    if (hook.command === 'node "${CLAUDE_PLUGIN_ROOT}/dist/hook.cjs"')
      hook.command = quoted + ' "${CLAUDE_PLUGIN_ROOT}/dist/hook.cjs"';
  }
  return {
    [`dist/${CLI_RECORD}`]: `${JSON.stringify({ argv: cotal })}\n`,
    ".mcp.json": `${JSON.stringify(mcp, null, 2)}\n`,
    "hooks/hooks.json": `${JSON.stringify(hooks, null, 2)}\n`,
  };
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

const DOCS_URL = "https://github.com/Cotal-AI/Cotal/blob/main/docs/connect-claude.md";
const MARKETPLACE = "cotal-mesh";

/** Desktop includes a Code executable even when the person has not installed the terminal CLI. */
function claudeCommand(): string {
  const terminal = spawnSync("claude", ["--version"], { stdio: "ignore", timeout: 5_000, killSignal: "SIGKILL" });
  if (terminal.status === 0) return "claude";
  if ((terminal.error as NodeJS.ErrnoException | undefined)?.code !== "ENOENT")
    throw new Error("The installed Claude Code command could not run. Repair it before running cotal setup.");
  const config = desktopConfigPath();
  const app = config ? dirname(config) : process.platform === "linux"
    ? join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "Claude")
    : undefined;
  if (!app || !existsSync(join(app, "claude-code"))) throw new Error("Claude Code is unavailable. Install it or open Desktop's Code tab, then retry setup.");
  const cache = join(app, "claude-code");
  const versions = readdirSync(cache, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && /^\d+\.\d+\.\d+$/.test(entry.name))
    .sort((a, b) => b.name.localeCompare(a.name, undefined, { numeric: true }));
  const executable = process.platform === "win32" ? "claude.exe" : "claude";
  for (const version of versions) {
    const root = join(cache, version.name);
    for (const entry of readdirSync(root, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (!entry.isDirectory()) continue;
      const candidates = process.platform === "darwin"
        ? [join(root, entry.name, "claude.app", "Contents", "MacOS", "claude"), join(root, entry.name, executable)]
        : [join(root, entry.name, executable)];
      for (const candidate of candidates) {
        if (!existsSync(candidate)) continue;
        if (spawnSync(candidate, ["--version"], { stdio: "ignore", timeout: 5_000, killSignal: "SIGKILL" }).status !== 0)
          throw new Error("Claude Desktop's bundled Code executable could not run. Update or reinstall Claude Desktop.");
        return candidate;
      }
    }
  }
  throw new Error("Claude Code is unavailable. Install it or open Desktop's Code tab, then retry setup.");
}

function claudeAvailable(): boolean {
  try {
    claudeCommand();
    return true;
  } catch {
    return false;
  }
}

function cotalHome(): string {
  if (process.env.COTAL_HOME) return process.env.COTAL_HOME;
  if (process.platform === "win32" && process.env.LOCALAPPDATA) return join(process.env.LOCALAPPDATA, "Cotal");
  return join(homedir(), ".cotal");
}

function marketplaceDir(): string {
  return join(cotalHome(), "claude-plugin");
}

/** Keep materialization, native registration and verification in one cross-process transaction. */
function withPluginLock<T>(run: () => T): T {
  const lock = acquireLock(join(marketplaceDir(), ".setup.lock"), { label: "Claude plugin setup" });
  try {
    return run();
  } finally {
    lock.release();
  }
}

export function materialize(name: string, root: string, assets: readonly string[], version?: string, files: Readonly<Record<string, string>> = {}): void {
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
    // Created here, never adopted: a name already at `staging` (a link included) fails the mkdir,
    // so every write below lands in a directory this call made.
    mkdirSync(staging);
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

/** `claude plugin list --json` keeps a record for every project an install was ever made in: 1.2 MB for
 *  1,782 records on one machine, past spawnSync's 1 MiB default, which cuts the output short and still
 *  reports exit 0. */
const CLAUDE_OUTPUT_LIMIT = 64 * 1024 * 1024;

function command(...args: string[]): { status: number | null; output: string } {
  return commandIn(process.cwd(), ...args);
}

/** A spawn error (output past the limit, a directory that cannot be entered) is a failure whatever the
 *  exit status says, and its message is the output. */
function commandIn(cwd: string, ...args: string[]): { status: number | null; output: string } {
  const result = spawnSync(claudeCommand(), args, { cwd, encoding: "utf8", maxBuffer: CLAUDE_OUTPUT_LIMIT, timeout: 120_000, killSignal: "SIGKILL" });
  if (result.error) return { status: null, output: result.error.message };
  return { status: result.status, output: `${result.stdout ?? ""}${result.stderr ?? ""}`.trim() };
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
  writePrivateRecord(path, JSON.stringify(marketplaceManifest(market), null, 2) + "\n");
  return path;
}

function writeMarketplace(): void {
  const market = marketplaceDir();
  writeMarketplaceManifest(market);
  const add = command("plugin", "marketplace", "add", market);
  if (add.status !== 0 && !/already (?:exists|added|on disk)/i.test(add.output)) throw new Error(`plugin marketplace add failed:\n${add.output}`);
  // Claude Code re-reads the manifest on an update. Its answer to adding a marketplace it already has
  // changes wording between releases (2.1.295 says "already on disk"), so the update always runs.
  const update = command("plugin", "marketplace", "update", MARKETPLACE);
  if (update.status !== 0) throw new Error(`plugin marketplace update failed:\n${update.output}`);
}

/** A missing executable must not make an already installed integration disappear from an upgrade.
 * Only inspect native records to detect that obligation; never rewrite them ourselves. */
function installedForRefresh(): PluginEntry[] {
  const config = process.env.CLAUDE_CONFIG_DIR?.trim() || join(homedir(), ".claude");
  const cache = process.env.CLAUDE_CODE_PLUGIN_CACHE_DIR?.trim() || join(config, "plugins");
  const path = join(cache, "installed_plugins.json");
  if (!existsSync(path)) return [];
  let records: unknown;
  try {
    records = (JSON.parse(readFileSync(path, "utf8")) as { plugins?: unknown }).plugins;
  } catch {
    throw new Error("Claude's plugin records could not be read, so Cotal cannot verify their upgrade");
  }
  if (!records || typeof records !== "object" || Array.isArray(records))
    throw new Error("Claude's plugin records have an unsupported shape, so Cotal cannot verify their upgrade");
  for (const name of ["cotal", "cotal-skills"]) {
    const entries = (records as Record<string, unknown>)[`${name}@${MARKETPLACE}`];
    if (entries !== undefined && (!Array.isArray(entries) || entries.length > 0)) {
      if (!claudeAvailable()) throw new Error(`${name}@${MARKETPLACE} is installed, but Claude Code is unavailable. Restore Claude Code or open Desktop's Code tab, then retry the Cotal update.`);
      return listPlugins();
    }
  }
  return [];
}

/** Every installed plugin, as `claude plugin list --json` reports it from `cwd`. It lists local-scope
 *  installs of every project, each with its `projectPath`, but `enabled` says whether the plugin is
 *  enabled in `cwd`, not in the install's own project. */
function listPlugins(cwd = process.cwd()): PluginEntry[] {
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

/** Reads the install from Cotal's home, which no project's settings cover, so a project that turns the
 *  plugin off for itself does not fail a user-scope install that succeeded. */
function verify(name: string, scope: string, expectedVersion?: string): void {
  const match = listPlugins(cotalHome()).find((entry) => entry.id === `${name}@${MARKETPLACE}` && entry.scope === scope);
  const where = `${scope} scope`;
  if (!match) throw new Error(`plugin ${name}@${MARKETPLACE} (${where}) is not installed`);
  if (match.enabled !== true || (match as { errors?: unknown[] }).errors?.length)
    throw new Error(`plugin ${name}@${MARKETPLACE} (${where}) did not load: ${JSON.stringify({ enabled: match.enabled, errors: match.errors })}`);
  if (expectedVersion && !resolvedPluginCurrent(match, expectedVersion, name))
    throw new Error(`plugin ${name}@${MARKETPLACE} resolved payload does not match version ${expectedVersion}`);
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

/** Update existing registrations through Claude, including caches from an earlier Git marketplace.
 * Disabled installs stay disabled. Records for deleted projects cannot load and are left alone. */
function refreshInstalls(name: string, entries: PluginEntry[], version: string): void {
  for (const entry of entries) {
    const scope = entry.scope;
    if (scope !== "user" && scope !== "local" && scope !== "project")
      throw new Error(`cannot refresh ${name}@${MARKETPLACE} at ${String(scope)} scope; its administrator must update it`);
    const cwd = scope === "user" ? cotalHome() : entry.projectPath;
    if (typeof cwd !== "string") throw new Error(`${name}@${MARKETPLACE} (${scope} scope) has no project path`);
    if (!statSync(cwd, { throwIfNoEntry: false })?.isDirectory()) continue;
    if (resolvedPluginCurrent(entry, version, name)) continue;
    const update = commandIn(cwd, "plugin", "update", `${name}@${MARKETPLACE}`, "--scope", scope);
    if (update.status !== 0) throw new Error(`plugin update failed (${name}, ${scope} scope):\n${update.output}`);
    const current = listPlugins(cwd).find((candidate) => candidate.id === entry.id && candidate.scope === scope &&
      (scope === "user" || candidate.projectPath === entry.projectPath));
    if (!current || !resolvedPluginCurrent(current, version, name))
      throw new Error(`${name}@${MARKETPLACE} (${scope} scope) did not load the updated plugin ${version}`);
  }
}

/** Check the resolved manifest and bytes. Folder-backed installs can retain an older record version. */
function resolvedPluginCurrent(entry: PluginEntry, version: string, name = "cotal"): boolean {
  const sourceRoot = name === "cotal" ? PACKAGE_ROOT : join(marketplaceDir(), name);
  const assets = name === "cotal" ? COTAL_ASSETS : [".claude-plugin", "skills"];
  const root = entry.readFromFolder ?? entry.installPath;
  if (typeof root !== "string") return false;
  try {
    const manifest = JSON.parse(readFileSync(join(root, ".claude-plugin", "plugin.json"), "utf8")) as { version?: unknown };
    if (manifest.version !== version) return false;
    const record = name === "cotal"
      ? JSON.parse(readFileSync(join(marketplaceDir(), "cotal", "dist", CLI_RECORD), "utf8")) as { argv: string[] }
      : undefined;
    const generated = record ? pluginFiles(record.argv) : {};
    const same = (asset: string): boolean => {
      const source = join(sourceRoot, asset);
      const target = join(root, asset);
      const generatedText = generated[asset.replaceAll("\\", "/")];
      if (generatedText !== undefined) return readFileSync(target).equals(Buffer.from(generatedText));
      if (statSync(source).isDirectory()) return readdirSync(source).every((name) => same(join(asset, name)));
      if (asset === join(".claude-plugin", "plugin.json")) {
        const expected = JSON.parse(readFileSync(source, "utf8")) as Record<string, unknown>;
        return JSON.stringify({ ...expected, version }) === JSON.stringify(manifest);
      }
      return readFileSync(source).equals(readFileSync(target));
    };
    return assets.every(same) && (name !== "cotal" || readFileSync(join(root, "dist", CLI_RECORD))
      .equals(readFileSync(join(marketplaceDir(), "cotal", "dist", CLI_RECORD))));
  } catch {
    return false;
  }
}

/** Removes the per-project installs of the `cotal` plugin that earlier releases made, once the user-scope
 *  install covers every project. Each is removed from its own project, where Claude Code keeps its
 *  record. A project path that is no longer a directory has no settings left to enable the plugin, so
 *  its record is left as it is. A project Claude Code cannot change does not stop the others; setup
 *  then fails naming each one. Returns how many it removed. */
function retireProjectInstalls(): number {
  let removed = 0;
  const failed: string[] = [];
  for (const entry of listPlugins()) {
    if (entry.id !== `cotal@${MARKETPLACE}` || entry.scope !== "local" || typeof entry.projectPath !== "string") continue;
    if (!statSync(entry.projectPath, { throwIfNoEntry: false })?.isDirectory()) continue;
    const result = commandIn(entry.projectPath, "plugin", "uninstall", `cotal@${MARKETPLACE}`, "--scope", "local");
    if (result.status === 0) removed += 1;
    else failed.push(`${entry.projectPath}: ${result.output}`);
  }
  if (failed.length)
    throw new Error(
      `cotal@${MARKETPLACE} is installed at user scope, but ${failed.length} earlier per-project install${failed.length === 1 ? "" : "s"} could not be removed. In each directory, run \`claude plugin uninstall cotal@${MARKETPLACE} --scope local\`:\n${failed.join("\n")}`,
    );
  return removed;
}


/** The installed Claude Code plugins, or undefined when Claude cannot be launched or queried (both of
 *  which status renders as "unknown" rather than "absent"). ONE spawn serves both rows. */
function pluginList(): PluginEntry[] | undefined {
  try {
    const result = command("plugin", "list", "--json");
    if (result.status !== 0) return undefined;
    const parsed: unknown = JSON.parse(result.output || "[]");
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
  if (resolvedPluginCurrent(match, version, "cotal-skills")) return row("ok", "current");
  return row("warn", `${typeof match.version === "string" ? `v${match.version} ≠ v${version} · ` : ""}stale · ${skillsRemedy}`);
}

/** The `cotal` plugin against the installed payload Claude resolves, including older cached installs. */
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
  if (typeof materialized !== "string" || !materialized.startsWith(`${version}+`)) return row("warn", "stale · run `cotal setup`");
  const active = installs.filter((entry) => entry.scope === "user" || typeof entry.projectPath !== "string" ||
    statSync(entry.projectPath, { throwIfNoEntry: false })?.isDirectory());
  if (active.some((entry) => !resolvedPluginCurrent(entry, materialized)))
    return row("warn", "stale · run `cotal setup`");
  if (installs.some((entry) => entry.scope === "user")) return row("ok", "current (user scope)");
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

function materializeSkills({ skillsDir, version, stateDir }: ConnectorSkillsSetupInput): void {
  const manifestRoot = join(PACKAGE_ROOT, "skills-plugin");
  if (!existsSync(join(manifestRoot, ".claude-plugin", "plugin.json"))) throw new Error("Claude skills plugin manifest is missing");
  const payload = join(stateDir, `.claude-skills-payload.${process.pid}`);
  rmSync(payload, { recursive: true, force: true });
  try {
    // Created here, never adopted, like the marketplace staging directory.
    mkdirSync(stateDir, { recursive: true });
    mkdirSync(payload);
    cpSync(join(manifestRoot, ".claude-plugin"), join(payload, ".claude-plugin"), { recursive: true, dereference: true });
    cpSync(skillsDir, join(payload, "skills"), { recursive: true, dereference: true });
    materialize("cotal-skills", payload, [".claude-plugin", "skills"], version);
  } finally {
    rmSync(payload, { recursive: true, force: true });
  }
}

export const claudeSetupProvider: ConnectorSetupProvider = {
  kind: "connector-setup",
  name: "claude",
  requires: ["claude"],
  available: claudeAvailable,
  connector: {
    name: "claude-plugin",
    title: "Install the Claude Code plugin",
    explain: "Installs Cotal messaging for Claude Code, including supported local sessions in Desktop's Code tab. Reopen Claude after setup.",
    context: [DOCS_URL],
    run({ cotal }) {
      return withPluginLock(() => {
        const version = materializeCotal(cotal);
        install("cotal", "user", version);
        // Desktop first: a per-project install that cannot be removed fails the step after it.
        const app = desktop(cotal, true);
        const removed = retireProjectInstalls();
        const replaced = removed ? `, replacing ${removed} project install${removed === 1 ? "" : "s"}` : "";
        return `cotal@${MARKETPLACE} (user scope${replaced})${app ? `; ${app}` : ""}`;
      });
    },
  },
  refresh: {
    name: "claude-plugin-refresh",
    title: "Refresh the Claude Code plugin",
    explain: "Rewrites the copy of the Cotal plugin that Claude Code sessions load, and Cotal's entry in Claude Desktop, for this release.",
    context: [DOCS_URL],
    run({ cotal, skills }) {
      return withPluginLock(() => {
        const entries = installedForRefresh();
        const installs = entries.filter((entry) => entry.id === `cotal@${MARKETPLACE}`);
        const skillInstalls = entries.filter((entry) => entry.id === `cotal-skills@${MARKETPLACE}`);
        const path = desktopConfigPath();
        const app = path !== undefined && readDesktopEntry(path) !== undefined;
        if (!installs.length && !skillInstalls.length && !app) return "not installed";
        if (skillInstalls.length && !skills) throw new Error("current skills are required to refresh the installed Claude skills plugin");
        const version = installs.length || app ? materializeCotal(cotal) : undefined;
        if (skillInstalls.length) materializeSkills(skills!);
        if (installs.length || skillInstalls.length) writeMarketplace();
        const parts: string[] = [];
        if (installs.length) {
          refreshInstalls("cotal", installs, version!);
          parts.push(`cotal@${MARKETPLACE} ${version}; reload plugins or reopen Claude to load it in running sessions`);
        }
        if (skillInstalls.length) {
          refreshInstalls("cotal-skills", skillInstalls, skills!.version);
          parts.push(`cotal-skills@${MARKETPLACE} ${skills!.version}`);
        }
        const desktopText = app ? desktop(cotal, false) : undefined;
        if (desktopText) parts.push(desktopText);
        return parts.join("; ");
      });
    },
  },
  skills: {
    name: "claude-skills-plugin",
    title: "Add Cotal's skills to Claude Code",
    explain: "Installs Cotal's authored skills as a Claude Code plugin.",
    context: [DOCS_URL],
    run(input) {
      return withPluginLock(() => {
        materializeSkills(input);
        install("cotal-skills", "user", input.version);
        return `cotal-skills@${MARKETPLACE} (user scope)`;
      });
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
      const child = spawn(claudeCommand(), [prompt, "--permission-mode", "auto", ...sessionArgs], { stdio: "inherit" });
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
