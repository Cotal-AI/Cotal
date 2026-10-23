import { registry, type Connector, type ConnectorSetupProvider, type ConnectorStatusRow, type ExtensionRef, type SignedInSpace } from "@cotal-ai/core";
import { assertRecordIdentity, extensionConnectors, installedExtensionVersion, loadExtensionsManifest, loadSpaceAuth, localProcessPath, parsePid, probeLiveness, readPidfile, readWebSession, resolveOnPath, serviceWebSessionPath, WEB_PIDFILE, WEB_SERVICE_ADAPTER, WEB_SESSION_FILE, type LocalProcessContext } from "@cotal-ai/workspace";
import { materializeExtension } from "../ext-loader.js";
import { resolveNatsServer } from "./nats-bin.js";
import { displayCmd } from "./self-exec.js";
import { serviceInstanceStore, serviceInstances } from "./service-instances.js";
import { cliVersion } from "./version.js";

// Moved into `@cotal-ai/workspace` (stage 4); re-exported for the CLI's many importers.
export { resolveRuntimeSpace, resolveSpace } from "@cotal-ai/workspace";

/** Where the dashboard that holds the live `pid` in `web.pid` recorded its session. A dashboard started
 * as an owned service writes its own record beside its startup receipt and never writes `web.session`,
 * so the web service instance whose recorded process is that live pid names the file. Any other holder
 * is a dashboard that wrote `web.session`. The holder picks the record, and neither is read in place of
 * the other. Instance records that cannot be read throw. */
export function webSessionSource(context: LocalProcessContext, pid: number): { path: string; label: string; instance?: string } {
  const held = serviceInstances(context.space).map((row) => row.record.value).filter((value) =>
    value.adapter?.name === WEB_SERVICE_ADAPTER && value.process !== undefined && value.process.pid === pid && assertRecordIdentity(value.process).kind === "match");
  if (held.length > 1) throw new Error(`${held.length} web service instances record the live pid ${pid}`);
  const instance = held[0];
  if (!instance) return { path: localProcessPath(WEB_SESSION_FILE, context), label: WEB_SESSION_FILE };
  const stateDirectory = serviceInstanceStore(context.space).directory();
  if (!stateDirectory) throw new Error("the service state directory is missing");
  return {
    path: serviceWebSessionPath({ space: context.space, instanceId: instance.instanceId, launchRequestId: instance.launchRequestId, stateDirectory }),
    label: "service session record",
    instance: instance.instanceId,
  };
}

/** The address the dashboard recorded in its session record once `listen()` succeeded, with the
 * readiness nonce recorded beside it, or `undefined` while there is no whole record. A record that
 * exists and cannot be read throws. */
export function webBoundAddress(path: string): { host: string; port: number; url: string; readiness: string } | undefined {
  const session = readWebSession(path);
  if (!session) return undefined;
  const { host, port, readiness } = session;
  return { host, port, url: `http://${host.includes(":") ? `[${host}]` : host}:${port}/`, readiness };
}

/** The address a mesh's dashboard recorded once it was listening, while the pid it recorded is alive.
 * Only its own records place it: `--port` moves it off its default port, and any other program can
 * own that port. {@link webSessionSource} picks the record. A record that exists and cannot be read
 * throws an error that names it, because a read error such as EISDIR carries no path. */
export function recordedWebUrl(context: LocalProcessContext): string | undefined {
  let raw: string | undefined;
  try {
    raw = readPidfile(localProcessPath(WEB_PIDFILE, context));
  } catch (e) {
    throw new Error(`pidfile unreadable · ${(e as Error).message}`);
  }
  const pid = raw === undefined ? undefined : parsePid(raw);
  if (pid === undefined || probeLiveness(pid) !== "alive") return undefined;
  let source: ReturnType<typeof webSessionSource>;
  try {
    source = webSessionSource(context, pid);
  } catch (e) {
    throw new Error(`service instance records unreadable · ${(e as Error).message}`);
  }
  try {
    return webBoundAddress(source.path)?.url;
  } catch (e) {
    throw new Error(`${source.label} unreadable · ${(e as Error).message}`);
  }
}

/** True when an installed extension contributes the `web` service preset and its package is on disk,
 * so `cotal service add --preset web` can configure the dashboard. A manifest or package record that
 * cannot be read throws, like every other reader. */
export function webInstalled(): boolean {
  return loadExtensionsManifest().extensions.some((e) => e.servicePresets?.some((preset) => preset.name === "web") === true && installedExtensionVersion(e.pkg) !== undefined);
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

/** The rows each connector's setup provider reports about what it installed, for the selected space
 *  when `signedIn` names it. Only a connector that declares a provider is imported; one whose cached
 *  metadata predates the setup ref is read from the connector itself. A declared provider that cannot
 *  be resolved renders as one red row naming the error, so the rest of status still prints. */
export async function connectorStatusRows(harnesses: readonly HarnessStatus[], signedIn?: SignedInSpace): Promise<ConnectorStatusRow[]> {
  const input = { version: cliVersion(), skillsRemedy: `${displayCmd()} setup --skills`, ...(signedIn ? { signedIn } : {}) };
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
