import { spawnSync } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { connect } from "node:net";
import { delimiter, join } from "node:path";
import { DEFAULT_SERVER, DEFAULT_SPACE, isReachable, registry, type Connector } from "@cotal-ai/core";
import { authDir, extensionConnectors, findCotalRoot, loadExtensionsManifest, loadSoleSpaceAuth, loadSpaceAuth, resolveMeshTarget, type MeshEntry } from "@cotal-ai/workspace";
import { resolveNatsServer } from "./nats-bin.js";
import { cliVersion } from "./version.js";

// Moved into `@cotal-ai/workspace` (stage 4); re-exported for the CLI's many importers.
export { resolveRuntimeSpace, resolveSpace } from "@cotal-ai/workspace";

export interface MeshStatus {
  reachable?: boolean;
  server: string;
  space: string;
  auth: boolean;
  origin?: MeshEntry["origin"];
}

/** The dashboard's default port + branded URL. The `web` command moved out to the `@cotal-ai/web`
 *  extension (stage 4); the CLI keeps these constants and the port probe so the setup ready-card
 *  can report the dashboard without importing it. */
export const WEB_PORT = 7799;
export const WEB_URL = `http://cotal.localhost:${WEB_PORT}/`;

/** True if something is already listening on the dashboard port (loopback). */
export function webUp(port: number = WEB_PORT): Promise<boolean> {
  return new Promise((res) => {
    const sock = connect(port, "127.0.0.1");
    sock.setTimeout(400);
    const done = (up: boolean) => {
      sock.destroy();
      res(up);
    };
    sock.once("connect", () => done(true));
    sock.once("timeout", () => done(false));
    sock.once("error", () => done(false));
  });
}

/** Cheap snapshot of the mesh setup and spawn resolve for this folder. Discovered catalog brokers
 * are never probed: their registry record is the selected state this card reports. */
export async function meshStatus(cwd: string): Promise<MeshStatus> {
  try {
    const target = resolveMeshTarget(cwd, {});
    return {
      reachable: target.origin === "catalog" ? undefined : await isReachable(target.server, target.tlsRequired ? { tls: true } : {}),
      server: target.server,
      space: target.space,
      auth: target.mode !== "open",
      ...(target.origin ? { origin: target.origin } : {}),
    };
  } catch {
    // With no resolvable mesh, retain the configure-only card's local default state.
  }
  const server = DEFAULT_SERVER;
  const auth = loadSoleSpaceAuth(authDir(findCotalRoot(cwd)));
  return {
    reachable: await isReachable(server),
    server,
    space: auth?.space ?? DEFAULT_SPACE,
    auth: Boolean(auth),
  };
}

export interface MachineStatus {
  nats: "path" | "bundled" | "missing";
  claudePlugin: boolean;
  claudeSkills: { state: "current" | "stale" | "missing" | "broken" | "unknown"; version?: string };
}

/** One installed connector's harness readiness: the executables it declares (`requires`) and the ones
 *  of those not on PATH. */
export interface HarnessStatus {
  name: string;
  requires: readonly string[];
  missing: string[];
}

/** Machine-level readiness: the once-per-machine setup pieces. */
export async function machineStatus(): Promise<MachineStatus> {
  let nats: MachineStatus["nats"] = "missing";
  try {
    nats = (await resolveNatsServer()).source;
  } catch {
    nats = "missing";
  }
  // ONE `claude plugin list` for both plugin answers. This used to spawn the Claude CLI TWICE —
  // once for the JSON listing and once for a plain-text grep — two full process startups for data a
  // single listing already contains.
  const plugins = claudePluginList();
  return {
    nats,
    claudePlugin: claudePluginInstalled(plugins),
    claudeSkills: claudeSkillsState(plugins),
  };
}

/** Every connector this machine can launch, read off each connector's own `requires` rather than a list
 *  of harness names: the live registry plus the installed extension manifest's cached requirements, so
 *  status never imports connector code. A manifest that cannot answer throws, like every other reader. */
export function connectorHarnesses(): HarnessStatus[] {
  const declared = new Map<string, readonly string[]>();
  for (const ext of loadExtensionsManifest().extensions)
    for (const connector of extensionConnectors(ext)) declared.set(connector.name, connector.requires);
  for (const connector of registry.all<Connector>("connector")) declared.set(connector.name, connector.requires ?? []);
  return [...declared]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, requires]) => ({ name, requires, missing: requires.filter((bin) => !onPath(bin)) }));
}

/** The Claude Code skills plugin's state vs THIS CLI release: `cotal-skills@cotal-mesh` at user scope
 *  should be present, error-free, and at `cliVersion()`. Surfaces a stale (un-updated), missing, or
 *  `broken` (loaded WITH errors) user-scope skill that the connector-only checks can't see. This must use
 *  the SAME health predicate the post-install verify enforces (id/scope/enabled/errors/version), so
 *  status can never bless a plugin the installer would have rejected. `unknown` when Claude isn't on PATH
 *  or can't be queried. */
function claudeSkillsState(entries: PluginEntry[] | undefined): MachineStatus["claudeSkills"] {
  if (entries === undefined) return { state: "unknown" };
  const match = entries.find((e) => e.id === "cotal-skills@cotal-mesh" && e.scope === "user");
  if (!match || match.enabled === false) return { state: "missing" };
  const errs = (match.errors ?? match.error) as unknown;
  if (Array.isArray(errs) ? errs.length > 0 : Boolean(errs)) return { state: "broken" }; // present but failed to load: never "current"
  return {
    state: match.version === cliVersion() ? "current" : "stale",
    version: typeof match.version === "string" ? match.version : undefined,
  };
}

export function onPath(bin: string): boolean {
  const exts = process.platform === "win32"
    ? (process.env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM").split(";")
    : [""];
  for (const dir of (process.env.PATH ?? "").split(delimiter).filter(Boolean)) {
    for (const ext of exts) {
      const name = process.platform === "win32" && ext && !bin.toUpperCase().endsWith(ext.toUpperCase())
        ? `${bin}${ext}`
        : bin;
      const candidate = join(dir, name);
      try {
        accessSync(candidate, constants.X_OK);
        return true;
      } catch {
        /* try the next PATH entry */
      }
    }
  }
  return false;
}

function claudePluginInstalled(entries: PluginEntry[] | undefined): boolean {
  return entries?.some((e) => e.id === "cotal@cotal-mesh") ?? false;
}

/** One installed-plugin entry, as `claude plugin list --json` reports it. */
type PluginEntry = Record<string, unknown>;

/** The installed Claude Code plugins, or undefined when Claude is not on PATH or cannot be queried
 *  (both of which every caller renders as "unknown" rather than "absent"). ONE spawn, shared. */
function claudePluginList(): PluginEntry[] | undefined {
  if (!onPath("claude")) return undefined;
  const r = spawnSync("claude", ["plugin", "list", "--json"], { encoding: "utf8" });
  if (r.status !== 0) return undefined;
  try {
    const parsed: unknown = JSON.parse(r.stdout ?? "[]");
    return Array.isArray(parsed) ? (parsed as PluginEntry[]) : undefined;
  } catch {
    return undefined;
  }
}
