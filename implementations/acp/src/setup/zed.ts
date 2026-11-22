/**
 * `cotal setup` for Zed: one custom agent per space under `agent_servers` in Zed's `settings.json`,
 * running `cotal acp --space <space>`. Zed's settings file allows comments and trailing commas; the
 * edit keeps them. Zed reloads the file without a restart.
 */
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ClientSetupProvider, ConnectorSetupInput, ConnectorStatusRow } from "@cotal-ai/core";
import { resolveOnPath } from "@cotal-ai/workspace";
import { acpCommand, acpSpace, passedEnv, refreshedArgs, staleCommand } from "./command.js";
import { objectAt, readSettings, writeReported, type SettingsChange, type SettingsFile } from "./settings-file.js";

const APP = "Zed";
const DOCS = "https://docs.cotal.ai/docs/acp-clients/#add-to-a-client";

/** Zed's config directory (Zed's `paths::config_dir`). */
export function zedConfigDir(platform: NodeJS.Platform = process.platform, env: NodeJS.ProcessEnv = process.env, home = homedir()): string {
  if (platform === "win32") return join(env.APPDATA?.trim() || join(home, "AppData", "Roaming"), "Zed");
  if (platform === "linux" && env.XDG_CONFIG_HOME?.trim()) return join(env.XDG_CONFIG_HOME.trim(), "zed");
  return join(home, ".config", "zed");
}

export const zedSettingsPath = (): string => join(zedConfigDir(), "settings.json");

/** The name of the agent setup adds for `space`, which Zed shows in its new-thread menu. */
export const zedAgentName = (space: string): string => `Cotal (${space})`;

interface Agent {
  readonly name: string;
  readonly space: string;
  readonly value: Record<string, unknown>;
}

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/** The custom agents that run `cotal acp`, whoever added them. */
function cotalAgents(file: SettingsFile): Agent[] {
  return Object.entries(objectAt(file, "agent_servers")).flatMap(([name, value]): Agent[] => {
    if (!isObject(value) || (value.type !== undefined && value.type !== "custom")) return [];
    const space = acpSpace(value.args);
    return space === undefined ? [] : [{ name, space, value }];
  });
}

/** The changes that make `agent` run this Cotal, keeping its name and every key Zed or the person set. */
function refreshChanges(file: SettingsFile, agent: Agent, cotal: readonly string[]): SettingsChange[] {
  const at = ["agent_servers", agent.name];
  const env = agent.value.env;
  if (env !== undefined && !isObject(env)) throw new Error(`${file.path} has an env for agent "${agent.name}" that is not an object, so Cotal left it alone.`);
  const passed = passedEnv();
  return [
    { path: [...at, "type"], value: "custom" },
    { path: [...at, "command"], value: acpCommand(cotal, agent.space).command },
    { path: [...at, "args"], value: refreshedArgs(agent.value.args as string[], cotal) },
    ...Object.entries(passed).map(([name, value]): SettingsChange => ({ path: [...at, "env", name], value })),
  ];
}

function setUp({ cotal, wrote, space }: ConnectorSetupInput): string {
  if (!space) throw new Error(`${APP} setup needs the space it sets up`);
  const file = readSettings(zedSettingsPath(), APP);
  const ours = cotalAgents(file).filter((agent) => agent.space === space);
  if (ours.length > 0) {
    const changed = writeReported(APP, file, ours.flatMap((agent) => refreshChanges(file, agent, cotal)), wrote);
    const names = ours.map((agent) => `"${agent.name}"`).join(", ");
    return changed ? `agent ${names} for ${space} updated; ${APP} loads it without a restart` : `agent ${names} for ${space} is current`;
  }
  const name = zedAgentName(space);
  if (objectAt(file, "agent_servers")[name] !== undefined)
    throw new Error(`${file.path} already has an agent "${name}" that does not run Cotal for ${space}. Rename it, then run \`cotal setup\` again.`);
  const { command, args } = acpCommand(cotal, space);
  const env = passedEnv();
  writeReported(APP, file, [{ path: ["agent_servers", name], value: { type: "custom", command, args, ...(Object.keys(env).length > 0 ? { env } : {}) } }], wrote);
  return `agent "${name}" added; ${APP} loads it without a restart`;
}

function refresh({ cotal }: ConnectorSetupInput): string {
  const path = zedSettingsPath();
  if (!existsSync(path)) return "not installed";
  const file = readSettings(path, APP);
  const ours = cotalAgents(file);
  if (ours.length === 0) return "not installed";
  const changed = writeReported(APP, file, ours.flatMap((agent) => refreshChanges(file, agent, cotal)), undefined);
  const spaces = ours.map((agent) => agent.space).join(", ");
  return changed ? `agents for ${spaces} now run this Cotal` : `agents for ${spaces} are current`;
}

/** One row: the spaces Zed reaches Cotal for, and any agent whose command no longer runs this Cotal. */
function status(): ConnectorStatusRow[] {
  const row = (state: ConnectorStatusRow["state"], text: string): ConnectorStatusRow[] => [{ label: APP, state, text }];
  const path = zedSettingsPath();
  let ours: Agent[];
  try {
    ours = existsSync(path) ? cotalAgents(readSettings(path, APP)) : [];
  } catch (e) {
    return row("error", (e as Error).message);
  }
  if (ours.length === 0) return zedProvider.available!() ? row("off", "no Cotal agent · run `cotal setup`") : [];
  const stale = ours.flatMap((agent) => {
    const why = staleCommand(agent.value.command, agent.value.args);
    return why ? [`"${agent.name}": ${why}`] : [];
  });
  const spaces = ours.map((agent) => agent.space).join(", ");
  return stale.length ? row("warn", `Cotal for ${spaces}; ${stale.join("; ")} · run \`cotal update\``) : row("ok", `Cotal for ${spaces}`);
}

export const zedProvider: ClientSetupProvider = {
  kind: "client-setup",
  name: "zed",
  available: () => existsSync(zedConfigDir()) || resolveOnPath("zed") !== undefined || resolveOnPath("zeditor") !== undefined,
  connector: {
    name: "zed-agent",
    title: `Add Cotal to ${APP}`,
    explain: `Adds an agent for this space to ${APP}'s settings, so a ${APP} thread starts and drives Cotal agents. ${APP} loads it without a restart.`,
    context: [DOCS],
    run: setUp,
  },
  refresh: {
    name: "zed-agent-refresh",
    title: `Refresh the Cotal agents in ${APP}`,
    explain: `Points every Cotal agent in ${APP}'s settings at this Cotal.`,
    context: [DOCS],
    run: refresh,
  },
  status,
};
