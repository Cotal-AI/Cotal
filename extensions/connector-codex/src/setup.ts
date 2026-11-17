/**
 * `cotal setup` for Codex: materialize the Cotal plugin into a local marketplace under the Cotal
 * home and install it with Codex's own plugin commands. The plugin carries one stdio server, the
 * personal conversation server in `dist/personal.js`, which Codex starts once per conversation.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { acquireLock, registry, type ConnectorSetupInput, type ConnectorSetupProvider, type ConnectorStatusInput, type ConnectorStatusRow } from "@cotal-ai/core";
import { CLI_RECORD } from "./cli-record.js";

const PACKAGE_ROOT = fileURLToPath(new URL("..", import.meta.url));
export const MARKETPLACE = "cotal-mesh";
export const PLUGIN = "cotal";
/** What the plugin carries from this package's build. */
const ASSETS = ["dist/personal.js", "dist/docs-bundle.bin", "dist/docs-index.bin"] as const;
const DOCS_URL = "https://github.com/Cotal-AI/Cotal/blob/main/docs/connect-codex.mdx";

function cotalHome(): string {
  if (process.env.COTAL_HOME) return process.env.COTAL_HOME;
  if (process.platform === "win32" && process.env.LOCALAPPDATA) return join(process.env.LOCALAPPDATA, "Cotal");
  return join(homedir(), ".cotal");
}

/** The local marketplace root Codex records. */
export function codexMarketplaceDir(): string {
  return join(cotalHome(), "codex-plugin");
}

/** The files the plugin holds beyond the built assets, bound to the Node runtime running setup:
 *  Codex starts a plugin server with a minimal PATH. */
function pluginFiles(cotal: readonly string[], version: string): Record<string, string> {
  const node = cotal[0];
  if (!node) throw new Error("the Cotal CLI record has no Node executable");
  return {
    ".codex-plugin/plugin.json": `${JSON.stringify({
      name: PLUGIN, version, description: "Connect this Codex conversation to a Cotal mesh after you approve its permissions.",
      homepage: DOCS_URL, mcpServers: "./.mcp.json",
    }, null, 2)}\n`,
    // `cwd` is the installed plugin root, so the relative entry resolves there. CODEX_HOME is
    // forwarded so the server reads the same Codex home as the conversation it serves.
    ".mcp.json": `${JSON.stringify({ mcpServers: { cotal: { command: node, args: ["./dist/personal.js"], cwd: ".", env_vars: ["CODEX_HOME"] } } }, null, 2)}\n`,
    [`dist/${CLI_RECORD}`]: `${JSON.stringify({ argv: cotal })}\n`,
  };
}

/** This release, then a digest of every file the plugin holds, so a stale install is visible. */
function pluginVersion(files: Readonly<Record<string, string>>): string {
  const hash = createHash("sha256");
  for (const asset of ASSETS) {
    const bytes = readFileSync(join(PACKAGE_ROOT, asset));
    hash.update(`${asset}\0${bytes.length}\0`).update(bytes);
  }
  for (const [path, text] of Object.entries(files).sort(([a], [b]) => a.localeCompare(b))) hash.update(`${path}\0${text.length}\0`).update(text);
  const release = (JSON.parse(readFileSync(join(PACKAGE_ROOT, "package.json"), "utf8")) as { version: string }).version;
  return `${release}+${hash.digest("hex").slice(0, 12)}`;
}

/** Write the marketplace and the plugin, replacing an earlier copy whole. Returns its version. */
export function materializeCodexPlugin(cotal: readonly string[]): string {
  for (const asset of ASSETS) if (!existsSync(join(PACKAGE_ROOT, asset))) throw new Error(`plugin asset missing: ${join(PACKAGE_ROOT, asset)}; build the Codex connector`);
  const market = codexMarketplaceDir();
  const plugins = join(market, "plugins");
  mkdirSync(plugins, { recursive: true });
  const version = pluginVersion(pluginFiles(cotal, ""));
  const files = pluginFiles(cotal, version);
  const dest = join(plugins, PLUGIN);
  const staging = `${dest}.staging.${process.pid}`;
  const old = `${dest}.old.${process.pid}`;
  rmSync(staging, { recursive: true, force: true });
  for (const asset of ASSETS) {
    mkdirSync(join(staging, asset, ".."), { recursive: true });
    cpSync(join(PACKAGE_ROOT, asset), join(staging, asset));
  }
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(join(staging, path, ".."), { recursive: true });
    writeFileSync(join(staging, path), text);
  }
  if (existsSync(dest)) renameSync(dest, old);
  renameSync(staging, dest);
  rmSync(old, { recursive: true, force: true });
  mkdirSync(join(market, ".agents", "plugins"), { recursive: true });
  writeFileSync(join(market, ".agents", "plugins", "marketplace.json"), `${JSON.stringify({
    name: MARKETPLACE,
    plugins: [{ name: PLUGIN, source: { source: "local", path: `./plugins/${PLUGIN}` }, policy: { installation: "AVAILABLE", authentication: "ON_INSTALL" }, category: "Productivity" }],
  }, null, 2)}\n`);
  return version;
}

/** `codex plugin list` prints one row per installed plugin. A listing of 2.4 MB is past spawnSync's
 *  1 MiB default, which reports ENOBUFS and the status row says the command could not run. */
const CODEX_OUTPUT_LIMIT = 64 * 1024 * 1024;

function codex(...args: string[]): { status: number | null; output: string } {
  const r = spawnSync("codex", args, { encoding: "utf8", maxBuffer: CODEX_OUTPUT_LIMIT, timeout: 60_000, killSignal: "SIGKILL" });
  if (r.error) {
    const code = (r.error as NodeJS.ErrnoException).code;
    if (code === "ENOBUFS") throw new Error(`codex ${args.join(" ")} printed more than ${CODEX_OUTPUT_LIMIT} bytes`);
    throw new Error(`codex ${args.join(" ")} could not run: ${r.error.message}`);
  }
  return { status: r.status, output: `${r.stdout ?? ""}${r.stderr ?? ""}`.split("\n").filter((l) => l && !/^WARNING: proceeding/.test(l)).join("\n") };
}

/** Record the marketplace and install the plugin through Codex, then read the install back. */
function install(version: string): void {
  const markets = codex("plugin", "marketplace", "list");
  if (markets.status !== 0) throw new Error(`codex plugin marketplace list failed:\n${markets.output}`);
  if (!markets.output.includes(MARKETPLACE)) {
    const added = codex("plugin", "marketplace", "add", codexMarketplaceDir());
    if (added.status !== 0) throw new Error(`codex plugin marketplace add failed:\n${added.output}`);
  }
  const added = codex("plugin", "add", `${PLUGIN}@${MARKETPLACE}`);
  if (added.status !== 0) throw new Error(`codex plugin add failed:\n${added.output}`);
  if (installedVersion() !== version) throw new Error(`Codex did not install ${PLUGIN}@${MARKETPLACE} ${version}`);
}

/** Codex installs plugin versions in its native cache. An absent cache needs no executable; an
 * existing or unreadable one must not hide an integration the upgrade cannot verify. */
function hasCachedPlugin(): boolean {
  const home = process.env.CODEX_HOME?.trim() || join(homedir(), ".codex");
  try {
    return readdirSync(join(home, "plugins", "cache", MARKETPLACE, PLUGIN)).length > 0;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw new Error("Codex plugin cache could not be read", { cause: error });
  }
}

/** The version Codex lists for the installed plugin, or undefined when it is not installed. */
function installedVersion(): string | undefined {
  const listed = codex("plugin", "list");
  if (listed.status !== 0) throw new Error(`codex plugin list failed:\n${listed.output}`);
  const row = listed.output.split("\n").find((line) => line.startsWith(`${PLUGIN}@${MARKETPLACE} `));
  if (!row || !/installed/.test(row)) return undefined;
  return row.split(/\s{2,}/)[2];
}

function withLock<T>(run: () => T): T {
  mkdirSync(codexMarketplaceDir(), { recursive: true });
  const lock = acquireLock(join(codexMarketplaceDir(), ".setup.lock"), { label: "Codex plugin setup" });
  try { return run(); } finally { lock.release(); }
}

function statusRow({ version }: ConnectorStatusInput): ConnectorStatusRow {
  const row = (state: ConnectorStatusRow["state"], text: string): ConnectorStatusRow => ({ label: "Codex plugin", state, text });
  let installed: string | undefined;
  try { installed = installedVersion(); }
  catch (e) { return row("error", (e as Error).message); }
  if (!installed) return row("off", "not installed · run `cotal setup`");
  return installed.startsWith(`${version}+`) ? row("ok", "current") : row("warn", "stale · run `cotal setup`");
}

export const codexSetupProvider: ConnectorSetupProvider = {
  kind: "connector-setup",
  name: "codex",
  requires: ["codex"],
  connector: {
    name: "codex-plugin",
    title: "Install the Codex plugin",
    explain: "Installs Cotal for your own Codex conversations: one asks to connect with cotal_connect, and you approve its permissions in Cotal. Start a new Codex conversation after setup.",
    context: [DOCS_URL],
    run({ cotal }: ConnectorSetupInput) {
      return withLock(() => {
        const version = materializeCodexPlugin(cotal);
        install(version);
        return `${PLUGIN}@${MARKETPLACE} ${version}`;
      });
    },
  },
  refresh: {
    name: "codex-plugin-refresh",
    title: "Refresh the Codex plugin",
    explain: "Rewrites the Cotal plugin that Codex conversations load for this release.",
    context: [DOCS_URL],
    run({ cotal }: ConnectorSetupInput) {
      return withLock(() => {
        if (!hasCachedPlugin() || installedVersion() === undefined) return "not installed";
        const version = materializeCodexPlugin(cotal);
        install(version);
        return `${PLUGIN}@${MARKETPLACE} ${version}; new Codex conversations load it`;
      });
    },
  },
  status: (input) => [statusRow(input)],
};

registry.register(codexSetupProvider);

