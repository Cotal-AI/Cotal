import { accessSync, constants } from "node:fs";
import { connect } from "node:net";
import { delimiter, join } from "node:path";
import { DEFAULT_SERVER, DEFAULT_SPACE, isReachable, registry, type Connector, type ConnectorSetupProvider, type ConnectorStatusRow, type ExtensionRef } from "@cotal-ai/core";
import { authDir, extensionConnectors, findCotalRoot, loadExtensionsManifest, loadSoleSpaceAuth, loadSpaceAuth, resolveMeshTarget, type MeshEntry } from "@cotal-ai/workspace";
import { materializeExtension } from "../ext-loader.js";
import { resolveNatsServer } from "./nats-bin.js";
import { displayCmd } from "./self-exec.js";
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
}

/** One installed connector's harness readiness: the executables it declares (`requires`), the ones
 *  of those not on PATH, and its declared setup provider (`undefined` when a manifest cached before
 *  setup refs were cannot say). */
export interface HarnessStatus {
  name: string;
  requires: readonly string[];
  missing: string[];
  setup: ExtensionRef | null | undefined;
}

/** Machine-level readiness: the once-per-machine setup pieces. */
export async function machineStatus(): Promise<MachineStatus> {
  let nats: MachineStatus["nats"] = "missing";
  try {
    nats = (await resolveNatsServer()).source;
  } catch {
    nats = "missing";
  }
  return { nats };
}

/** Every connector this machine can launch, read off each connector's own `requires` rather than a list
 *  of harness names: the live registry plus the installed extension manifest's cached requirements, so
 *  status never imports connector code. A manifest that cannot answer throws, like every other reader. */
export function connectorHarnesses(): HarnessStatus[] {
  const declared = new Map<string, { requires: readonly string[]; setup: ExtensionRef | null | undefined }>();
  for (const ext of loadExtensionsManifest().extensions)
    for (const connector of extensionConnectors(ext)) declared.set(connector.name, { requires: connector.requires, setup: connector.setup });
  for (const connector of registry.all<Connector>("connector"))
    declared.set(connector.name, { requires: connector.requires ?? [], setup: connector.setup ?? null });
  return [...declared]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, { requires, setup }]) => ({ name, requires, missing: requires.filter((bin) => !onPath(bin)), setup }));
}

/** The rows each connector's setup provider reports about what it installed. Only a connector that
 *  declares a provider is imported; one whose cached metadata predates the setup ref is read from the
 *  connector itself. A declared provider that cannot be resolved renders as one red row naming the
 *  error, so the rest of status still prints. */
export async function connectorStatusRows(harnesses: readonly HarnessStatus[]): Promise<ConnectorStatusRow[]> {
  const input = { version: cliVersion(), skillsRemedy: `${displayCmd()} setup --skills` };
  const rows: ConnectorStatusRow[] = [];
  for (const harness of harnesses) {
    try {
      const setup = harness.setup === undefined
        ? (await materializeExtension<Connector>({ kind: "connector", name: harness.name })).setup
        : harness.setup;
      if (!setup) continue;
      const provider = await materializeExtension<ConnectorSetupProvider>(setup);
      rows.push(...(provider.status?.(input) ?? []));
    } catch (e) {
      rows.push({ label: `${harness.name} setup`, state: "error", text: (e as Error).message });
    }
  }
  return rows;
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
