/**
 * Claude Desktop runs a local MCP server in chat from its own config file, `claude_desktop_config.json`
 * (Settings > Developer > Edit Config, read when Desktop starts). A plugin's local server does not run
 * in chat. Setup writes one `cotal-desktop` entry there, which runs the materialized plugin's server
 * with `--desktop`, and keeps every other key of the file as it was. An older entry of ours named
 * `cotal` is renamed, because that name is the Claude Code plugin's server and Desktop Code would
 * run the chat server in its place.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** The server's name in Desktop's config. Not `cotal`: that name is the Claude Code plugin's server. */
export const DESKTOP_SERVER = "cotal-desktop";

/** The name setup used before the Desktop server had one of its own. */
const LEGACY_DESKTOP_SERVER = "cotal";

/** Where Claude Desktop keeps its config, as the MCP docs give it, or `undefined` on a platform whose
 *  location they do not give. */
export function desktopConfigPath(platform: NodeJS.Platform = process.platform, env: NodeJS.ProcessEnv = process.env, home: string = homedir()): string | undefined {
  if (platform === "darwin") return join(home, "Library", "Application Support", "Claude", "claude_desktop_config.json");
  if (platform === "win32" && env.APPDATA) return join(env.APPDATA, "Claude", "claude_desktop_config.json");
  return undefined;
}

export interface DesktopEntry {
  command: string;
  args: string[];
  env?: Record<string, string>;
}

type Config = Record<string, unknown> & { mcpServers?: Record<string, unknown> };

/** The config at `path` as an object, `{}` when there is none. A file Desktop could not read either
 *  is refused, so Cotal never rewrites what it cannot keep. */
function readConfig(path: string): Config {
  if (!existsSync(path)) return {};
  const text = readFileSync(path, "utf8");
  let parsed: unknown;
  try {
    parsed = text.trim() ? JSON.parse(text) : {};
  } catch {
    throw new Error(`${path} is not valid JSON, so Cotal left it alone. Fix it, then run \`cotal setup\` again.`);
  }
  const servers = (parsed as Config | null)?.mcpServers;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || (servers !== undefined && (!servers || typeof servers !== "object" || Array.isArray(servers))))
    throw new Error(`${path} is not a Claude Desktop config (an object whose mcpServers is an object), so Cotal left it alone.`);
  return parsed as Config;
}

/** Whether an entry is the Desktop chat server setup wrote, which is the one a rename may move. */
function ours(entry: unknown): boolean {
  const args = (entry as { args?: unknown } | undefined)?.args;
  return Array.isArray(args) && args.includes("--desktop");
}

/** The Desktop chat server in the config at `path`: the current name, or an older entry of ours still
 *  stored under `cotal`. */
export function readDesktopEntry(path: string): unknown {
  const servers = readConfig(path).mcpServers;
  return servers?.[DESKTOP_SERVER] ?? (ours(servers?.[LEGACY_DESKTOP_SERVER]) ? servers?.[LEGACY_DESKTOP_SERVER] : undefined);
}

/** Whether Desktop's config has a server named `cotal`. That is also the Claude Code plugin's server
 *  name, so a Code session in Desktop runs this one instead of the plugin. */
export function desktopNameClash(path: string): boolean {
  return readConfig(path).mcpServers?.[LEGACY_DESKTOP_SERVER] !== undefined;
}

/** Whether Claude Desktop is running, on macOS. Desktop reads its config once, when it starts, and
 *  writes the copy it holds back on ordinary use, so an entry added while it runs is lost. `ps -A -o
 *  comm=` prints each executable's path there; Desktop's main one ends in `/Claude.app/Contents/MacOS/
 *  Claude`, unlike its updater, its bundled Code (`claude.app/Contents/MacOS/claude`) and the `claude`
 *  CLI. Elsewhere this is `false`: that loss was not seen on Windows. */
export function desktopRunning(platform: NodeJS.Platform = process.platform): boolean {
  if (platform !== "darwin") return false;
  const ps = spawnSync("ps", ["-A", "-o", "comm="], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, timeout: 10_000, killSignal: "SIGKILL" });
  if (ps.status !== 0) throw new Error(`Cotal could not list processes to tell whether Claude Desktop is running: ${ps.error?.message ?? ps.stderr.trim()}`);
  return ps.stdout.split("\n").some((line) => line.endsWith("/Claude.app/Contents/MacOS/Claude"));
}

/** Write `entry` as the `cotal-desktop` server in the config at `path`. An older entry of ours named
 *  `cotal` moves with it. Returns what changed, or that nothing was written because Claude Desktop
 *  is running. */
export function writeDesktopEntry(path: string, entry: DesktopEntry, running: () => boolean = desktopRunning): "added" | "updated" | "current" | "not added" | "not updated" {
  const config = readConfig(path);
  const servers = { ...config.mcpServers };
  const before = servers[DESKTOP_SERVER];
  const legacyOurs = ours(servers[LEGACY_DESKTOP_SERVER]);
  if (legacyOurs) delete servers[LEGACY_DESKTOP_SERVER];
  servers[DESKTOP_SERVER] = entry;
  if (JSON.stringify(config.mcpServers ?? {}) === JSON.stringify(servers)) return "current";
  if (running()) return before === undefined && !legacyOurs ? "not added" : "not updated";
  config.mcpServers = servers;
  const tmp = `${path}.cotal-${process.pid}`;
  writeFileSync(tmp, `${JSON.stringify(config, null, 2)}\n`, { mode: existsSync(path) ? statSync(path).mode & 0o777 : 0o600 });
  renameSync(tmp, path);
  return before === undefined && !legacyOurs ? "added" : "updated";
}
