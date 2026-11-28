import { delimiter, resolve } from "node:path";
import { catalogChoiceRefusal, connectorServers, readModelCatalog, registry, spawnEnvAllow } from "@cotal-ai/core";
import type { CommandInput, Connector, CotalConfig, LaunchChoice, LaunchModes, LaunchOpts, ModelCatalog } from "@cotal-ai/core";
import { connectorInstallHint, manifestExtensionNames, materializeFromManifest, resolveOnPath } from "@cotal-ai/workspace";
import type { Manager } from "./manager.js";
import type { ManagerParts } from "./manager-parts.js";
import type { ManagerConfig } from "./manager-config.js";

/** The opt-in launch fields a seat keeps, each present only when asked, so a launch without them is
 *  built and recorded as before and every relaunch of the seat asks as its spawn did. */
export function optInLaunchFields(launch: { askPermissions?: boolean; reasoningEvents?: boolean }): { askPermissions?: true; reasoningEvents?: true } {
  return { ...(launch.askPermissions ? { askPermissions: true } : {}), ...(launch.reasoningEvents ? { reasoningEvents: true } : {}) };
}

/** The harness files and spawn.env names a catalog was read with, so a kept catalog serves only a
 *  launch that would read the same one. */
const catalogKey = (binaries: Readonly<Record<string, string>> | undefined, envAllow: readonly string[] | undefined): string =>
  JSON.stringify([binaries ?? {}, envAllow ?? []]);

function recordedOnPath(bin: string, recorded: string | undefined, env: NodeJS.ProcessEnv = process.env): boolean {
  if (!recorded || (!recorded.includes("/") && !recorded.includes("\\")) || resolveOnPath(recorded, env) !== recorded)
    return false;
  if (bin.includes("/") || bin.includes("\\")) return resolveOnPath(bin, env) === recorded;
  const pathValue = env.PATH ?? Object.entries(env).find(([key]) => key.toLowerCase() === "path")?.[1] ?? "";
  return pathValue.split(delimiter).some((dir) => Boolean(dir) && resolveOnPath(resolve(dir, bin), env) === recorded);
}

/** One connector's declared harness binaries resolved on PATH now, keeping any recorded paths that
 *  still exist and still resolve on PATH. The refusal sentence is built only here, so boot, status
 *  and launch checks never word it apart. */
export function resolveHarness(
  name: string,
  requires: readonly string[],
  recorded?: Readonly<Record<string, string>>,
): { binaries: Record<string, string>; reason?: string } {
  const binaries: Record<string, string> = {};
  const missing: string[] = [];
  for (const bin of requires) {
    const pinned = recorded?.[bin];
    const path = recordedOnPath(bin, pinned) ? pinned : resolveOnPath(bin);
    if (path) binaries[bin] = path;
    else missing.push(bin);
  }
  return missing.length ? { binaries, reason: `${name} harness needs ${missing.join(", ")} on PATH - not found` } : { binaries };
}

/** What {@link HarnessResolution} reads from the Manager. Every entry is read at use, so a field the Manager
 *  assigns after construction is always current, and a Manager method a test replaces is the one that runs. */
export interface HarnessResolutionDeps {
  installedExtensions: () => Manager["installedExtensions"];
}

/** Builds the {@link HarnessResolutionDeps} for a Manager. It reads Manager members by name at each use, so a
 *  field the Manager assigns later is current and a member a test replaces on the instance is the one that runs. */
export function harnessResolutionDeps(m: Manager): HarnessResolutionDeps {
  return {
    installedExtensions: () => m["installedExtensions"],
  };
}

/** Resolving a connector by name and the host fields, harness binaries and capability and events refusals a launch carries. */
export class HarnessResolution {
  /** Each connector's last catalog read, or the read in flight, with the harness files and spawn.env
   *  names it ran with. A spawn
   *  that chooses a variant or modes checks against it rather than running the harness again. */
  private readonly catalogs = new Map<string, { harness: string; read: Promise<ModelCatalog> }>();

  constructor(private readonly config: Readonly<ManagerConfig>, private readonly deps: HarnessResolutionDeps, private readonly parts: Pick<ManagerParts, "connectorInventory">) {}

  // The Manager members these bodies read, under their Manager names. Each reads through its dep at
  // use, so a field the Manager assigns later is current and a method a test replaces on the Manager
  // is the one that runs.
  private get installedExtensions() { return this.deps.installedExtensions(); }

  /** Resolve a connector by agent type. Library composition (installedExtensions off) → a registry
   *  hit, exactly as before (the composition root imported what it wants). The published binary gates
   *  on MANIFEST membership FIRST — so a live `cotal ext remove` is honored even though the registry
   *  still holds a connector imported earlier this session — then returns the registry hit or lazily
   *  imports the providing package (transactional + single-flight, via the workspace primitive).
   *  The captured Manager generation is checked for first-party providers under that lock,
   *  including providers already present in the registry.
   *  Fail-loud with an install hint; no fallback. */
  async resolveConnector(name: string): Promise<Connector> {
    if (!this.installedExtensions) return registry.resolve<Connector>("connector", name);
    if (!manifestExtensionNames("connector").includes(name)) throw new Error(connectorInstallHint(name));
    return materializeFromManifest<Connector>({ kind: "connector", name }, { hint: (ref) => connectorInstallHint(ref.name), expectedGeneration: this.config.expectedConnectorGeneration });
  }

  /** The harness binaries a managed launch runs, or the refusal naming what is missing. Spawn, resume,
   *  command listing and the model catalog all take it, and an available row is verified here too so
   *  no caller can launch a missing file. A connector registered after boot has no inventory row and
   *  is checked on PATH now. */
  launchHarness(connector: Connector): { binaries?: Readonly<Record<string, string>> } | { refusal: string } {
    this.parts.connectorInventory.recheckAvailableConnectors(connector.name);
    const row = this.parts.connectorInventory.connectorStatuses.find((status) => status.agent === connector.name);
    if (row?.state === "unavailable") return { refusal: row.reason ?? `${connector.name} harness is unavailable` };
    if (row) return { binaries: row.binaries };
    const { reason } = resolveHarness(connector.name, connector.requires ?? []);
    return reason ? { refusal: reason } : {};
  }

  /** Drop any kept model catalog for a connector whose harness became unavailable. */
  forgetCatalog(name: string): void {
    this.catalogs.delete(name);
  }

  /** The launch fields the host supplies rather than the seat. Spawn and resume both take them from
   *  here, so a resumed seat launches under the same host policy, `eventsRequired` included, as the
   *  same seat spawned fresh. The caller passes the cotal config it judged the launch by, so the
   *  servers and env allowlist come from the contents its checks read. */
  hostLaunchFields(
    cotalConfig: CotalConfig,
    agent: string,
    shareTools: readonly string[] | undefined,
    harness: { binaries?: Readonly<Record<string, string>> },
  ): Pick<LaunchOpts, "space" | "servers" | "mcpServers" | "mcpServersExclusive" | "envAllow" | "resolvedBinaries" | "eventsRequired" | "eventPayloads" | "workspaceRoot"> {
    return {
      space: this.config.space,
      servers: this.config.servers,
      // Declared overrides plus the connector's native default, unless this spawn explicitly
      // restricts sharing. An empty selection is deliberate isolation, not the default.
      mcpServers: connectorServers(cotalConfig, agent, shareTools),
      mcpServersExclusive: shareTools !== undefined,
      // The operator's spawn-env policy travels the same route: absent means no extras (the OS
      // allow-list + operator knobs + connector-declared inputs), present means those names too.
      // A connector never reads the config itself.
      envAllow: spawnEnvAllow(cotalConfig),
      resolvedBinaries: harness.binaries,
      eventsRequired: this.config.eventsRequired,
      ...(this.config.eventPayloadsWithheld ? { eventPayloads: false } : {}),
      // So a connector that keeps per-agent local state can root it at the workspace, not the
      // (possibly per-agent) launch cwd.
      workspaceRoot: this.config.workspaceRoot,
    };
  }

  /** The refusal for a launch choice the connector cannot honour. Spawn and resume both ask before
   *  a seat's launch is built, so a rule changed here holds on both paths. */
  capabilityRefusal(
    connector: Connector,
    launch: { variant?: string; modes?: LaunchModes; prompt?: string; firstCommand?: CommandInput; exact: boolean; askPermissions?: boolean; reasoningEvents?: boolean; events: boolean },
  ): string | undefined {
    if (launch.variant && !connector.supportsModelVariant)
      return `${connector.name} connector does not support model variants (variant)`;
    if (launch.modes !== undefined && !connector.supportsModes)
      return `${connector.name} connector does not support modes (modes)`;
    if (launch.prompt !== undefined && !connector.supportsPrompt)
      return `${connector.name} connector does not support an initial prompt (prompt)`;
    if (launch.askPermissions && !connector.supportsAskPermissions)
      return `${connector.name} connector does not support asking before tool use (askPermissions)`;
    if (launch.reasoningEvents && !connector.supportsReasoningEvents)
      return `${connector.name} connector does not support reasoning events (reasoningEvents)`;
    if (launch.reasoningEvents && !launch.events)
      return "reasoningEvents needs the event plane, and this launch has none (events: false)";
    if (launch.firstCommand && !connector.commands?.targets.includes(launch.firstCommand.target))
      return `${connector.name} seats run no ${launch.firstCommand.target}s, so a spawn cannot name one as their first command (firstCommand)`;
    if (launch.exact && (!connector.supportsSessionReopen || !connector.supportsSessionContinuation))
      return `${connector.name} connector does not support exact session continuity (continuity: exact)`;
    return undefined;
  }

  /** Read the connector's catalog from its harness now and keep it for spawn checks. A read that fails,
   *  is malformed or reports no catalog is not kept, so the next spawn reads again. `envAllow` is the
   *  spawn.env names a launch would receive, so the catalog lists the models a seat reaches. */
  readCatalog(connector: Connector, binaries: Readonly<Record<string, string>> | undefined, envAllow: readonly string[] | undefined, refresh = false): Promise<ModelCatalog> {
    const read = readModelCatalog(connector, { refresh, resolvedBinaries: binaries, ...(envAllow ? { envAllow } : {}) });
    this.catalogs.set(connector.name, { harness: catalogKey(binaries, envAllow), read });
    const forget = () => { if (this.catalogs.get(connector.name)?.read === read) this.catalogs.delete(connector.name); };
    read.then((catalog) => { if (catalog.unavailable !== undefined) forget(); }, forget);
    return read;
  }

  /** The refusal for a variant or modes the connector's catalog does not list for the launched model.
   *  It reads the kept catalog, and the harness only when none is kept for these files and names. */
  catalogRefusal(connector: Connector, binaries: Readonly<Record<string, string>> | undefined, envAllow: readonly string[] | undefined, choice: LaunchChoice): Promise<string | undefined> {
    return catalogChoiceRefusal(connector, choice, () => {
      const kept = this.catalogs.get(connector.name);
      return kept?.harness === catalogKey(binaries, envAllow) ? kept.read : this.readCatalog(connector, binaries, envAllow);
    });
  }

  /** The refusal for an event-plane choice the registration policy or the connector cannot meet.
   *  Spawn and resume both ask before a seat's launch is built, so a seat retained without the
   *  plane cannot come back on a space that now requires it. An absent choice arms supported planes. */
  eventsRefusal(connector: Connector, events: boolean | undefined): string | undefined {
    if (this.config.eventsRequired && events === false)
      return `space "${this.config.space}" requires the event plane by registration policy; --no-events (events: false on the start op) is not allowed`;
    if ((this.config.eventsRequired || events === true) && !connector.eventChannel)
      return this.config.eventsRequired
        ? `space "${this.config.space}" requires the event plane by registration policy, but connector "${connector.name}" does not publish one`
        : `connector "${connector.name}" does not publish an AG-UI event plane; omit --events to launch it without one`;
    return undefined;
  }
}
