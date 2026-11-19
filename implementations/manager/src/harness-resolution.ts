import { connectorServers, registry, spawnEnvAllow } from "@cotal-ai/core";
import type { Connector, CotalConfig, LaunchOpts } from "@cotal-ai/core";
import { connectorInstallHint, manifestExtensionNames, materializeFromManifest, resolveOnPath } from "@cotal-ai/workspace";
import type { Manager } from "./manager.js";

/** One connector's declared harness binaries resolved on PATH now. The refusal sentence is built only
 *  here, so the boot row and the check for a connector registered after boot can never word it apart. */
export function resolveHarness(name: string, requires: readonly string[]): { binaries: Record<string, string>; reason?: string } {
  const binaries: Record<string, string> = {};
  const missing: string[] = [];
  for (const bin of requires) {
    const path = resolveOnPath(bin);
    if (path) binaries[bin] = path;
    else missing.push(bin);
  }
  return missing.length ? { binaries, reason: `${name} harness needs ${missing.join(", ")} on PATH - not found` } : { binaries };
}

/** What {@link HarnessResolution} reads from the Manager. Every entry is read at use, so a field the Manager
 *  assigns after construction is always current, and a Manager method a test replaces is the one that runs. */
export interface HarnessResolutionDeps {
  connectorStatuses: () => Manager["connectorStatuses"];
  eventPayloadsWithheld: () => Manager["eventPayloadsWithheld"];
  eventsRequired: () => Manager["eventsRequired"];
  expectedConnectorGeneration: () => Manager["expectedConnectorGeneration"];
  installedExtensions: () => Manager["installedExtensions"];
  servers: () => Manager["servers"];
  space: () => Manager["space"];
  workspaceRoot: () => Manager["workspaceRoot"];
}

/** Resolving a connector by name and the host fields, harness binaries and capability and events refusals a launch carries. */
export class HarnessResolution {
  constructor(private readonly deps: HarnessResolutionDeps) {}

  // The Manager members these bodies read, under their Manager names. Each reads through its dep at
  // use, so a field the Manager assigns later is current and a method a test replaces on the Manager
  // is the one that runs.
  private get connectorStatuses() { return this.deps.connectorStatuses(); }
  private get eventPayloadsWithheld() { return this.deps.eventPayloadsWithheld(); }
  private get eventsRequired() { return this.deps.eventsRequired(); }
  private get expectedConnectorGeneration() { return this.deps.expectedConnectorGeneration(); }
  private get installedExtensions() { return this.deps.installedExtensions(); }
  private get servers() { return this.deps.servers(); }
  private get space() { return this.deps.space(); }
  private get workspaceRoot() { return this.deps.workspaceRoot(); }

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
    return materializeFromManifest<Connector>({ kind: "connector", name }, { hint: (ref) => connectorInstallHint(ref.name), expectedGeneration: this.expectedConnectorGeneration });
  }

  /** The harness binaries a managed launch runs, as boot resolved them, or the refusal naming what is
   *  missing. Spawn, resume and the model catalog all take it, so a seat launches from the same files
   *  whichever path starts it and the catalog never disagrees with a launch about whether the harness
   *  is there. Callers recheck unavailable rows first; available rows retain their resolved files.
   *  A connector registered after boot has no inventory row and is checked on PATH now. */
  launchHarness(connector: Connector): { binaries?: Readonly<Record<string, string>> } | { refusal: string } {
    const row = this.connectorStatuses.find((status) => status.agent === connector.name);
    if (row?.state === "unavailable") return { refusal: row.reason ?? `${connector.name} harness is unavailable` };
    if (row) return { binaries: row.binaries };
    const { reason } = resolveHarness(connector.name, connector.requires ?? []);
    return reason ? { refusal: reason } : {};
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
      space: this.space,
      servers: this.servers,
      // Declared overrides plus the connector's native default, unless this spawn explicitly
      // restricts sharing. An empty selection is deliberate isolation, not the default.
      mcpServers: connectorServers(cotalConfig, agent, shareTools),
      mcpServersExclusive: shareTools !== undefined,
      // The operator's spawn-env policy travels the same route: absent means no extras (the OS
      // allow-list + operator knobs + connector-declared inputs), present means those names too.
      // A connector never reads the config itself.
      envAllow: spawnEnvAllow(cotalConfig),
      resolvedBinaries: harness.binaries,
      eventsRequired: this.eventsRequired,
      ...(this.eventPayloadsWithheld ? { eventPayloads: false } : {}),
      // So a connector that keeps per-agent local state can root it at the workspace, not the
      // (possibly per-agent) launch cwd.
      workspaceRoot: this.workspaceRoot,
    };
  }

  /** The refusal for a launch choice the connector cannot honour. Spawn and resume both ask before
   *  a seat's launch is built, so a rule changed here holds on both paths. */
  capabilityRefusal(connector: Connector, launch: { variant?: string; prompt?: string; exact: boolean }): string | undefined {
    if (launch.variant && !connector.supportsModelVariant)
      return `${connector.name} connector does not support model variants (variant)`;
    if (launch.prompt !== undefined && !connector.supportsPrompt)
      return `${connector.name} connector does not support an initial prompt (prompt)`;
    if (launch.exact && (!connector.supportsSessionReopen || !connector.supportsSessionContinuation))
      return `${connector.name} connector does not support exact session continuity (continuity: exact)`;
    return undefined;
  }

  /** The refusal for an event-plane choice the registration policy or the connector cannot meet.
   *  Spawn and resume both ask before a seat's launch is built, so a seat retained without the
   *  plane cannot come back on a space that now requires it. An absent choice arms supported planes. */
  eventsRefusal(connector: Connector, events: boolean | undefined): string | undefined {
    if (this.eventsRequired && events === false)
      return `space "${this.space}" requires the event plane by registration policy; --no-events (events: false on the start op) is not allowed`;
    if ((this.eventsRequired || events === true) && !connector.eventChannel)
      return this.eventsRequired
        ? `space "${this.space}" requires the event plane by registration policy, but connector "${connector.name}" does not publish one`
        : `connector "${connector.name}" does not publish an AG-UI event plane; omit --events to launch it without one`;
    return undefined;
  }
}
