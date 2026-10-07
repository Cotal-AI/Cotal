import { DEFAULT_SERVER, DEFAULT_SPACE, isReachable, registry, type Connector, type ConnectorSetupProvider, type ConnectorStatusRow, type ExtensionRef } from "@cotal-ai/core";
import { authDir, extensionConnectors, findCotalRoot, loadExtensionsManifest, loadSoleSpaceAuth, loadSpaceAuth, localProcessPath, parsePid, probeLiveness, readPidfile, readWebSession, resolveMeshTarget, resolveOnPath, WEB_SESSION_FILE, type LocalProcessContext, type MeshEntry } from "@cotal-ai/workspace";
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
  root: string;
  auth: boolean;
  origin?: MeshEntry["origin"];
}

/** The address the dashboard recorded in `web.session` once `listen()` succeeded, with the readiness
 * nonce recorded beside it, or `undefined` while no whole record is readable. */
export function webBoundAddress(path: string): { host: string; port: number; url: string; readiness: string } | undefined {
  const session = readWebSession(path);
  if (!session) return undefined;
  const { host, port, readiness } = session;
  return { host, port, url: `http://${host.includes(":") ? `[${host}]` : host}:${port}/`, readiness };
}

/** The address a mesh's dashboard recorded once it was listening, while the pid it recorded is alive.
 * Only its own records place it: `--port` moves it off its default port, and any other program can
 * own that port. */
export function recordedWebUrl(context: LocalProcessContext): string | undefined {
  const raw = readPidfile(localProcessPath("web.pid", context));
  const pid = raw === undefined ? undefined : parsePid(raw);
  if (pid === undefined || probeLiveness(pid) !== "alive") return undefined;
  return webBoundAddress(localProcessPath(WEB_SESSION_FILE, context))?.url;
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
      root: target.root,
      auth: target.mode !== "open",
      ...(target.origin ? { origin: target.origin } : {}),
    };
  } catch {
    // With no resolvable mesh, retain the configure-only card's local default state.
  }
  const server = DEFAULT_SERVER;
  const root = findCotalRoot(cwd);
  const auth = loadSoleSpaceAuth(authDir(root));
  return {
    reachable: await isReachable(server),
    server,
    space: auth?.space ?? DEFAULT_SPACE,
    root,
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
    .map(([name, { requires, setup }]) => ({ name, requires, missing: requires.filter((bin) => !resolveOnPath(bin)), setup }));
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
