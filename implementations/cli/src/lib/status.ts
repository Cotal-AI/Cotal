import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { connect } from "node:net";
import { join } from "node:path";
import { DEFAULT_SERVER, DEFAULT_SPACE, isReachable } from "@cotal-ai/core";
import { authDir, findCotalRoot, loadSpaceAuth } from "@cotal-ai/workspace";
import { resolveNatsServer } from "./nats-bin.js";

// Moved into `@cotal-ai/workspace` (stage 4); re-exported for the CLI's many importers.
export { resolveSpace } from "@cotal-ai/workspace";

export interface MeshStatus {
  reachable: boolean;
  server: string;
  space: string; // from .cotal/auth if present, else the default
  auth: boolean; // auth mode (trust material on disk) vs open
}

/** The dashboard's default port + branded URL. The `web` command moved out to the `cotal-web`
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
