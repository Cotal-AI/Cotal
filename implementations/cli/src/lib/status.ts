import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_SERVER, DEFAULT_SPACE, isReachable } from "@cotal-ai/core";
import { authDir, findCotalRoot, loadSpaceAuth } from "@cotal-ai/workspace";
import { resolveNatsServer } from "./nats-bin.js";

export interface MeshStatus {
  reachable: boolean;
  server: string;
  space: string; // from .cotal/auth if present, else the default
  auth: boolean; // auth mode (trust material on disk) vs open
}

/** The space this folder operates on: its `.cotal/auth` space if set up, else the default.
 *  A folder has exactly one space (its auth) — commands resolve it through here so they always
 *  match the folder's mesh instead of assuming the global default. */
export function resolveSpace(cwd: string): string {
  return loadSpaceAuth(authDir(findCotalRoot(cwd)))?.space ?? DEFAULT_SPACE;
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
    agents: {
      claude: onPath("claude"),
      opencode: onPath("opencode"),
    },
  };
}

export function onPath(bin: string): boolean {
  const r = spawnSync(bin, ["--version"], { stdio: "ignore" });
  return !r.error && r.status === 0;
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
