import { spawnSync } from "node:child_process";
import { accessSync, constants, existsSync } from "node:fs";
import { connect } from "node:net";
import { delimiter, join } from "node:path";
import { DEFAULT_SERVER, DEFAULT_SPACE, isReachable } from "@cotal-ai/core";
import { authDir, findCotalRoot, loadSpaceAuth } from "@cotal-ai/workspace";
import { resolveNatsServer } from "./nats-bin.js";
import { cliVersion } from "./version.js";

// Moved into `@cotal-ai/workspace` (stage 4); re-exported for the CLI's many importers.
export { resolveSpace } from "@cotal-ai/workspace";

export interface MeshStatus {
  reachable: boolean;
  server: string;
  space: string; // from .cotal/auth if present, else the default
  auth: boolean; // auth mode (trust material on disk) vs open
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

/** Cheap, connectionless-ish snapshot of the mesh for this folder: is a server up,
 *  and what space/auth does the local `.cotal/` describe (found by walking up from `cwd`). */
export async function meshStatus(cwd: string): Promise<MeshStatus> {
  const server = DEFAULT_SERVER;
  const auth = loadSpaceAuth(authDir(findCotalRoot(cwd)));
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
  claudeSkills: "current" | "stale" | "missing" | "broken" | "unknown";
  agents: { claude: boolean; opencode: boolean };
}

/** Machine-level readiness: the once-per-machine setup pieces. */
export async function machineStatus(): Promise<MachineStatus> {
  let nats: MachineStatus["nats"] = "missing";
  try {
    nats = (await resolveNatsServer()).source;
  } catch {
    nats = "missing";
  }
  return {
    nats,
    claudePlugin: claudePluginInstalled(),
    claudeSkills: claudeSkillsState(),
    agents: {
      claude: onPath("claude"),
      opencode: onPath("opencode"),
    },
  };
}

/** The Claude Code skills plugin's state vs THIS CLI release: `cotal-skills@cotal-mesh` at user scope
 *  should be present, error-free, and at `cliVersion()`. Surfaces a stale (un-updated), missing, or
 *  `broken` (loaded WITH errors) user-scope skill that the connector-only checks can't see. This must use
 *  the SAME health predicate the post-install verify enforces (id/scope/enabled/errors/version), so
 *  status can never bless a plugin the installer would have rejected. `unknown` when Claude isn't on PATH
 *  or can't be queried. */
function claudeSkillsState(): MachineStatus["claudeSkills"] {
  if (!onPath("claude")) return "unknown";
  const r = spawnSync("claude", ["plugin", "list", "--json"], { encoding: "utf8" });
  if (r.status !== 0) return "unknown";
  let entries: unknown;
  try {
    entries = JSON.parse(r.stdout ?? "[]");
  } catch {
    return "unknown";
  }
  if (!Array.isArray(entries)) return "unknown";
  const match = (entries as Array<Record<string, unknown>>).find((e) => e.id === "cotal-skills@cotal-mesh" && e.scope === "user");
  if (!match || match.enabled === false) return "missing";
  const errs = (match.errors ?? match.error) as unknown;
  if (Array.isArray(errs) ? errs.length > 0 : Boolean(errs)) return "broken"; // present but failed to load: never "current"
  return match.version === cliVersion() ? "current" : "stale";
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

function claudePluginInstalled(): boolean {
  if (!onPath("claude")) return false;
  const r = spawnSync("claude", ["plugin", "list"], { encoding: "utf8" });
  return r.status === 0 && /cotal@cotal-mesh/.test(`${r.stdout ?? ""}${r.stderr ?? ""}`);
}

/** True once the machine-level setup has completed at least once. */
export function hasLocalMesh(cwd: string): boolean {
  const root = findCotalRoot(cwd);
  return existsSync(join(root, ".cotal", "auth", "auth.json")) || existsSync(join(root, ".cotal", "nats"));
}
