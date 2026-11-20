import { registry, rejectionText } from "@cotal-ai/core";
import type { Connector } from "@cotal-ai/core";
import { extensionConnectors, loadExtensionsManifest, OFFICIAL_CONNECTORS } from "@cotal-ai/workspace";
import { resolveHarness } from "./harness-resolution.js";
import type { ManagerConnectorStatus } from "./manager-service-contract.js";
import type { Manager } from "./manager.js";

/** What {@link ConnectorInventory} reads from the Manager. Every entry is read at use, so a field the Manager
 *  assigns after construction is always current, and a Manager method a test replaces is the one that runs. */
export interface ConnectorInventoryDeps {
  bootNotes: () => Manager["bootNotes"];
  setBootNotes: (value: Manager["bootNotes"]) => void;
  connectorRequirements: () => Manager["connectorRequirements"];
  setConnectorRequirements: (value: Manager["connectorRequirements"]) => void;
  connectorStatuses: () => Manager["connectorStatuses"];
  setConnectorStatuses: (value: Manager["connectorStatuses"]) => void;
  execution: () => Manager["execution"];
  installedExtensions: () => Manager["installedExtensions"];
  machineSetupCommand: () => Manager["machineSetupCommand"];
  classSpawnEnabled: (...args: Parameters<Manager["classSpawnEnabled"]>) => ReturnType<Manager["classSpawnEnabled"]>;
  prepareClaudeWake: (...args: Parameters<Manager["prepareClaudeWake"]>) => ReturnType<Manager["prepareClaudeWake"]>;
}

/** Builds the {@link ConnectorInventoryDeps} for a Manager. It reads Manager members by name at each use, so a
 *  field the Manager assigns later is current and a member a test replaces on the instance is the one that runs. */
export function connectorInventoryDeps(m: Manager): ConnectorInventoryDeps {
  return {
    bootNotes: () => m["bootNotes"],
    setBootNotes: (value) => { m["bootNotes"] = value; },
    connectorRequirements: () => m["connectorRequirements"],
    setConnectorRequirements: (value) => { m["connectorRequirements"] = value; },
    connectorStatuses: () => m["connectorStatuses"],
    setConnectorStatuses: (value) => { m["connectorStatuses"] = value; },
    execution: () => m["execution"],
    installedExtensions: () => m["installedExtensions"],
    machineSetupCommand: () => m["machineSetupCommand"],
    classSpawnEnabled: (...args) => m["classSpawnEnabled"](...args),
    prepareClaudeWake: (...args) => m["prepareClaudeWake"](...args),
  };
}

/** The connector inventory taken at boot: which harnesses resolve on this host and the notes for those that do not. */
export class ConnectorInventory {
  constructor(private readonly deps: ConnectorInventoryDeps) {}

  // The Manager members these bodies read, under their Manager names. Each reads through its dep at
  // use, so a field the Manager assigns later is current and a method a test replaces on the Manager
  // is the one that runs.
  private get bootNotes() { return this.deps.bootNotes(); }
  private set bootNotes(value: Manager["bootNotes"]) { this.deps.setBootNotes(value); }
  private get connectorRequirements() { return this.deps.connectorRequirements(); }
  private set connectorRequirements(value: Manager["connectorRequirements"]) { this.deps.setConnectorRequirements(value); }
  private get connectorStatuses() { return this.deps.connectorStatuses(); }
  private set connectorStatuses(value: Manager["connectorStatuses"]) { this.deps.setConnectorStatuses(value); }
  private get execution() { return this.deps.execution(); }
  private get installedExtensions() { return this.deps.installedExtensions(); }
  private get machineSetupCommand() { return this.deps.machineSetupCommand(); }
  private classSpawnEnabled(...args: Parameters<Manager["classSpawnEnabled"]>): ReturnType<Manager["classSpawnEnabled"]> { return this.deps.classSpawnEnabled(...args); }
  private prepareClaudeWake(...args: Parameters<Manager["prepareClaudeWake"]>): ReturnType<Manager["prepareClaudeWake"]> { return this.deps.prepareClaudeWake(...args); }

  /** Resolve every installed/registered connector's declared harness binaries before the manager
   * reports ready. A missing harness degrades only that connector, never unrelated lifecycle work:
   * boot continues, names it once start completes and records it on both manager status surfaces. */
  async inspectConnectorsAtBoot(): Promise<void> {
    this.bootNotes = [];
    if (this.execution === "none") { this.connectorStatuses = []; return; }
    const rows: ManagerConnectorStatus[] = [];
    let declared: Array<{ name: string; requires: readonly string[]; eventPlane: boolean; pkg?: string }>;
    if (this.installedExtensions) {
      try {
        declared = loadExtensionsManifest().extensions.flatMap((ext) => extensionConnectors(ext).map((connector) => ({ ...connector, pkg: ext.pkg })));
      } catch (error) {
        const reason = rejectionText(error);
        this.bootNotes.push(`! manager boot: connector inventory unavailable - ${reason}`);
        this.connectorStatuses = [{ agent: "(inventory)", state: "unavailable", binaries: {}, eventPlane: false, reason }];
        this.bootNotes.push("! manager: no agent application is available here, so a spawn without --on goes to another manager in this space");
        return;
      }
    } else {
      declared = registry.all<Connector>("connector").map((connector) => ({
        name: connector.name,
        requires: connector.requires ?? [],
        eventPlane: connector.eventChannel !== undefined,
      }));
    }
    this.connectorRequirements = new Map(declared.map(({ name, requires, pkg }) => [name, {
      requires, needsClaudeWake: !!this.machineSetupCommand && name === "claude" && pkg === OFFICIAL_CONNECTORS.claude,
    }]));
    for (const { name, requires, eventPlane } of declared) {
      const { binaries, reason: missing } = resolveHarness(name, requires);
      const reason = missing ?? (this.connectorRequirements.get(name)?.needsClaudeWake ? await this.prepareClaudeWake() : undefined);
      if (reason) {
        rows.push({ agent: name, state: "unavailable", binaries, eventPlane, reason });
        this.bootNotes.push(`! manager boot: connector ${name} unavailable - ${reason}`);
      } else {
        rows.push({ agent: name, state: "available", binaries, eventPlane });
      }
    }
    this.connectorStatuses = rows.sort((a, b) => a.agent.localeCompare(b.agent));
    if (!this.classSpawnEnabled())
      this.bootNotes.push("! manager: no agent application is available here, so a spawn without --on goes to another manager in this space");
  }
}
