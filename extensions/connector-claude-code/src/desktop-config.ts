/**
 * Claude Desktop runs a local MCP server in chat from its own config file, `claude_desktop_config.json`
 * (Settings > Developer > Edit Config, read when Desktop starts). A plugin's local server does not run
 * in chat. Setup writes one `cotal` entry there, which runs the materialized plugin's server with
 * `--desktop`, and keeps every other key of the file as it was.
 */
import { existsSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** The server's name in Desktop's config. */
export const DESKTOP_SERVER = "cotal";

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

/** The `cotal` entry in the config at `path`, if it has one. */
export function readDesktopEntry(path: string): unknown {
  return readConfig(path).mcpServers?.[DESKTOP_SERVER];
}

/** Write `entry` as the `cotal` server in the config at `path`. Returns what changed. */
export function writeDesktopEntry(path: string, entry: DesktopEntry): "added" | "updated" | "current" {
  const config = readConfig(path);
  const before = config.mcpServers?.[DESKTOP_SERVER];
  if (JSON.stringify(before) === JSON.stringify(entry)) return "current";
  config.mcpServers = { ...config.mcpServers, [DESKTOP_SERVER]: entry };
  const tmp = `${path}.cotal-${process.pid}`;
  writeFileSync(tmp, `${JSON.stringify(config, null, 2)}\n`, { mode: existsSync(path) ? statSync(path).mode & 0o777 : 0o600 });
  renameSync(tmp, path);
  return before === undefined ? "added" : "updated";
}
