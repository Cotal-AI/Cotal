/**
 * `cotal setup` for T3 Code: one provider instance per space in T3's `settings.json`, a local ACP
 * command that runs `cotal acp --space <space>`. T3's settings page shows the executable but not its
 * arguments, so a person could not add one there. T3 watches the file and loads a change without a
 * restart; a change to an instance restarts that instance's sessions, so nothing is written when the
 * instance is already current.
 */
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import type { ClientSetupProvider, ConnectorSetupInput, ConnectorStatusRow } from "@cotal-ai/core";
import { resolveOnPath } from "@cotal-ai/workspace";
import { acpCommand, acpSpace, passedEnv, refreshedArgs, staleCommand } from "./command.js";
import { objectAt, readSettings, writeReported, type SettingsChange, type SettingsFile } from "./settings-file.js";

const APP = "T3 Code";
const DOCS = "https://docs.cotal.ai/docs/acp-clients/#add-to-a-client";

/** T3's base directory: `T3CODE_HOME`, else `~/.t3` (T3's `resolveBaseDir`). */
export function t3Home(env: NodeJS.ProcessEnv = process.env, home = homedir()): string {
  const raw = env.T3CODE_HOME?.trim();
  return raw ? resolve(raw.replace(/^~(?=$|[/\\])/, home)) : join(home, ".t3");
}

export const t3SettingsPath = (): string => join(t3Home(), "userdata", "settings.json");

/** The id of the instance setup adds for `space`. T3 takes a letter, then letters, digits, `_` and
 *  `-`, at most 64 characters; a long space name is cut and keeps a digest of the whole. */
export function t3InstanceId(space: string): string {
  const id = `cotal-${space}`;
  return id.length <= 64 ? id : `cotal-${space.slice(0, 51)}-${createHash("sha256").update(space).digest("hex").slice(0, 6)}`;
}

interface Instance {
  readonly id: string;
  readonly space: string;
  readonly value: Record<string, unknown>;
  readonly config: Record<string, unknown>;
}

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/** Recognize direct Cotal launchers and Node invocations of the Cotal entry, even after they move. */
function runsCotal(command: unknown, args: unknown): boolean {
  if (typeof command !== "string" || !Array.isArray(args)) return false;
  const at = args.indexOf("acp");
  const launcher = basename(command);
  if (at === 0) return /^(?:cotal(?:\.(?:cmd|exe|bat|js|ts))?|cotal-npm)$/i.test(launcher);
  const entry = args[at - 1];
  return at > 0 && /^(?:node|nodejs|cotal-node)(?:\.exe)?$/i.test(launcher) && typeof entry === "string" &&
    /^cotal(?:\.(?:js|ts))?$/i.test(basename(entry));
}

/** The instances that run `cotal acp` as a local ACP command, whoever added them. */
function cotalInstances(file: SettingsFile): Instance[] {
  return Object.entries(objectAt(file, "providerInstances")).flatMap(([id, value]): Instance[] => {
    if (!isObject(value) || value.driver !== "acpRegistry" || !isObject(value.config) || value.config.source !== "local") return [];
    if (!runsCotal(value.config.commandPath, value.config.commandArgs)) return [];
    const space = acpSpace(value.config.commandArgs);
    return space === undefined ? [] : [{ id, space, value, config: value.config }];
  });
}

/** T3's environment list with each passed variable set, keeping every other entry as it was. */
function environment(current: unknown, file: SettingsFile, id: string): unknown[] {
  if (current !== undefined && !Array.isArray(current)) throw new Error(`${file.path} has an environment for provider ${id} that is not a list, so Cotal left it alone.`);
  const list = [...((current as unknown[] | undefined) ?? [])];
  for (const [name, value] of Object.entries(passedEnv())) {
    const at = list.findIndex((item) => isObject(item) && item.name === name);
    const next = { ...(at >= 0 ? list[at] as Record<string, unknown> : {}), name, value, sensitive: false };
    if (at >= 0) list[at] = next;
    else list.push(next);
  }
  return list;
}

/** The changes that make `instance` run this Cotal, keeping its id, name, enablement and other keys. */
function refreshChanges(file: SettingsFile, instance: Instance, cotal: readonly string[]): SettingsChange[] {
  const at = ["providerInstances", instance.id];
  const env = environment(instance.value.environment, file, instance.id);
  return [
    { path: [...at, "config", "commandPath"], value: acpCommand(cotal, instance.space).command },
    { path: [...at, "config", "commandArgs"], value: refreshedArgs(instance.config.commandArgs as string[], cotal) },
    ...(env.length > 0 ? [{ path: [...at, "environment"], value: env }] : []),
  ];
}

function setUp({ cotal, wrote, space }: ConnectorSetupInput): string {
  if (!space) throw new Error(`${APP} setup needs the space it sets up`);
  const file = readSettings(t3SettingsPath(), APP);
  const ours = cotalInstances(file).filter((instance) => instance.space === space);
  if (ours.length > 0) {
    const changed = writeReported(APP, file, ours.flatMap((instance) => refreshChanges(file, instance, cotal)), wrote);
    const ids = ours.map((instance) => instance.id).join(", ");
    return changed ? `provider ${ids} for ${space} updated; ${APP} loads it without a restart` : `provider ${ids} for ${space} is current`;
  }
  const baseId = t3InstanceId(space);
  const instances = objectAt(file, "providerInstances");
  let id = baseId;
  for (let n = 2; Object.hasOwn(instances, id); n++) {
    const suffix = `-${n}`;
    id = `${baseId.slice(0, 64 - suffix.length)}${suffix}`;
  }
  const { command, args } = acpCommand(cotal, space);
  const env = environment(undefined, file, id);
  writeReported(APP, file, [{
    path: ["providerInstances", id],
    value: { driver: "acpRegistry", displayName: `Cotal (${space})`, enabled: true, config: { source: "local", commandPath: command, commandArgs: args }, ...(env.length > 0 ? { environment: env } : {}) },
  }], wrote);
  return `provider ${id} for ${space} added; ${APP} loads it without a restart`;
}

function refresh({ cotal }: ConnectorSetupInput): string {
  const path = t3SettingsPath();
  if (!existsSync(path)) return "not installed";
  const file = readSettings(path, APP);
  const ours = cotalInstances(file);
  if (ours.length === 0) return "not installed";
  const changed = writeReported(APP, file, ours.flatMap((instance) => refreshChanges(file, instance, cotal)), undefined);
  const spaces = ours.map((instance) => instance.space).join(", ");
  return changed ? `providers for ${spaces} now run this Cotal` : `providers for ${spaces} are current`;
}

/** One row: the spaces T3 reaches Cotal for, and any entry whose command does not run this Cotal. */
function status(): ConnectorStatusRow[] {
  const row = (state: ConnectorStatusRow["state"], text: string): ConnectorStatusRow[] => [{ label: APP, state, text }];
  const path = t3SettingsPath();
  let ours: Instance[];
  try {
    ours = existsSync(path) ? cotalInstances(readSettings(path, APP)) : [];
  } catch (e) {
    return row("error", (e as Error).message);
  }
  if (ours.length === 0) return t3Provider.available!() ? row("off", "no Cotal provider · run `cotal setup`") : [];
  const stale = ours.flatMap((instance) => {
    const why = staleCommand(instance.config.commandPath, instance.config.commandArgs);
    return why ? [`${instance.id}: ${why}`] : [];
  });
  const spaces = ours.map((instance) => instance.space).join(", ");
  return stale.length ? row("warn", `Cotal for ${spaces}; ${stale.join("; ")} · run \`cotal update\``) : row("ok", `Cotal for ${spaces}`);
}

export const t3Provider: ClientSetupProvider = {
  kind: "client-setup",
  name: "t3",
  available: () => existsSync(t3Home()) || resolveOnPath("t3") !== undefined,
  connector: {
    name: "t3-provider",
    title: `Add Cotal to ${APP}`,
    explain: `Adds a provider for this space to ${APP}'s settings, so a ${APP} thread starts and drives Cotal agents. ${APP} loads it without a restart.`,
    context: [DOCS],
    run: setUp,
  },
  refresh: {
    name: "t3-provider-refresh",
    title: `Refresh the Cotal providers in ${APP}`,
    explain: `Points every Cotal provider in ${APP}'s settings at this Cotal.`,
    context: [DOCS],
    run: refresh,
  },
  status,
};
