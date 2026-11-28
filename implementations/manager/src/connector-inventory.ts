import { oneLine, registry, rejectionText } from "@cotal-ai/core";
import type { Connector, ConnectorSetupProvider } from "@cotal-ai/core";
import { extensionConnectors, loadExtensionsManifest, logicalExecutionEntry, materializeFromManifest, OFFICIAL_CONNECTORS } from "@cotal-ai/workspace";
import { resolveHarness } from "./harness-resolution.js";
import type { ManagerConnectorStatus } from "./manager-service-contract.js";
import type { ManagerParts } from "./manager-parts.js";
import { bearerEntryArgv } from "./preserved-resume.js";

/** The construction facts the inventory reads. Every one is fixed once the Manager is built. */
export interface ConnectorInventorySettings {
  execution: "runtime" | "none";
  installedExtensions: boolean;
  machineSetupCommand?: string;
  expectedConnectorGeneration: string;
}

/** The connector inventory taken at boot: which harnesses resolve on this host and the notes for those that do not.
 *  It owns the rows; other parts hold this object and read them at use. */
export class ConnectorInventory {
  /** Connector harness inventory. Available paths stay pinned while they still exist and resolve on
   *  PATH. Missing or removed rows are rechecked when launch, model lookup or status asks, without
   *  stopping unrelated Manager work, and a once-available connector never silently switches to a
   *  different executable path across flaps. */
  connectorStatuses: ManagerConnectorStatus[] = [];
  private connectorRequirements = new Map<string, { requires: readonly string[]; needsClaudeWake: boolean }>();
  private pinnedBinaries = new Map<string, Readonly<Record<string, string>>>();
  private claudeWakeRecheck?: Promise<void>;
  /** The boot inventory's warnings, printed once start completes, so a refused start prints none. */
  bootNotes: string[] = [];

  constructor(
    private readonly settings: ConnectorInventorySettings,
    private readonly parts: Pick<ManagerParts, "harnessResolution" | "seatLaunch" | "servePlane">,
    /** The Manager's lifecycle admission, which a Claude wake recheck holds while it runs. */
    private readonly beginLifecycle: (resumeOperation: boolean) => (() => void) | undefined,
  ) {}

  /** Resolve every installed/registered connector's declared harness binaries before the manager
   * reports ready. A missing harness degrades only that connector, never unrelated lifecycle work:
   * boot continues, names it once start completes and records it on both manager status surfaces. */
  async inspectConnectorsAtBoot(): Promise<void> {
    this.bootNotes = [];
    this.pinnedBinaries.clear();
    if (this.settings.execution === "none") { this.connectorStatuses = []; return; }
    const rows: ManagerConnectorStatus[] = [];
    let declared: Array<{ name: string; requires: readonly string[]; eventPlane: boolean; prompts?: boolean; askPermissions?: boolean; reasoningEvents?: boolean; pkg?: string }>;
    if (this.settings.installedExtensions) {
      try {
        declared = loadExtensionsManifest().extensions.flatMap((ext) => extensionConnectors(ext).map((connector) => ({ ...connector, pkg: ext.pkg })));
      } catch (error) {
        const reason = rejectionText(error);
        this.bootNotes.push(`! manager boot: connector inventory unavailable - ${reason}`);
        this.connectorStatuses = [{ agent: "(inventory)", state: "unavailable", binaries: {}, eventPlane: false, prompts: false, askPermissions: false, reasoningEvents: false, reason }];
        this.bootNotes.push("! manager: no agent application is available here, so a spawn without --on goes to another manager in this space");
        return;
      }
    } else {
      declared = registry.all<Connector>("connector").map((connector) => ({
        name: connector.name,
        requires: connector.requires ?? [],
        eventPlane: connector.eventChannel !== undefined,
        prompts: connector.prompts === true,
        askPermissions: connector.supportsAskPermissions === true,
        reasoningEvents: connector.supportsReasoningEvents === true,
      }));
    }
    this.connectorRequirements = new Map(declared.map(({ name, requires, pkg }) => [name, {
      requires, needsClaudeWake: !!this.settings.machineSetupCommand && name === "claude" && pkg === OFFICIAL_CONNECTORS.claude,
    }]));
    for (const { name, requires, eventPlane, prompts = false, askPermissions = false, reasoningEvents = false } of declared) {
      const { binaries, reason: missing } = resolveHarness(name, requires);
      const reason = missing ?? (this.connectorRequirements.get(name)?.needsClaudeWake ? await this.prepareClaudeWake() : undefined);
      const facts = { binaries, eventPlane, prompts, askPermissions, reasoningEvents };
      if (reason) {
        rows.push({ agent: name, state: "unavailable", ...facts, reason });
        this.bootNotes.push(`! manager boot: connector ${name} unavailable - ${reason}`);
      } else {
        this.pinnedBinaries.set(name, { ...binaries });
        rows.push({ agent: name, state: "available", ...facts });
      }
    }
    this.connectorStatuses = rows.sort((a, b) => a.agent.localeCompare(b.agent));
    if (!this.parts.seatLaunch.classSpawnEnabled())
      this.bootNotes.push("! manager: no agent application is available here, so a spawn without --on goes to another manager in this space");
  }

  /** Install and verify the hosted Claude wake channel, or report the cause and remedy. */
  private async prepareClaudeWake(): Promise<string | undefined> {
    try {
      const connector = await this.parts.harnessResolution.resolveConnector("claude");
      if (!connector.setup) throw new Error("Claude connector has no setup provider");
      const provider = await materializeFromManifest<ConnectorSetupProvider>(connector.setup, { expectedGeneration: this.settings.expectedConnectorGeneration });
      if (!provider.connector) throw new Error("Claude connector has no install action");
      const cotal = bearerEntryArgv();
      cotal[cotal.length - 1] = logicalExecutionEntry() ?? cotal.at(-1)!;
      await provider.connector.run({ cotal, machineHost: true });
    } catch (error) {
      const detail = oneLine(rejectionText(error).replace(/eyJ[A-Za-z0-9_.-]*/g, "<redacted>").slice(0, 800));
      return `Claude wake channel setup failed: ${detail}. Correct the cause and run \`${this.settings.machineSetupCommand}\` on this computer.`;
    }
  }

  /** Recheck available applications and retry unavailable ones. Claude launches join the status or
   *  launch that started wake setup, before any name or capacity is reserved. */
  refreshConnectors(name?: string, setupClaude = false): Promise<void> | undefined {
    const wasEnabled = this.parts.seatLaunch.classSpawnEnabled();
    let pending: Promise<void> | undefined;
    for (const row of this.connectorStatuses) {
      if (name !== undefined && row.agent !== name) continue;
      const requirements = this.connectorRequirements.get(row.agent);
      if (row.state === "available") {
        const pinned = this.pinnedBinaries.get(row.agent) ?? { ...row.binaries };
        this.pinnedBinaries.set(row.agent, pinned);
        const requires = requirements?.requires ?? Object.keys(pinned);
        const { binaries, reason } = resolveHarness(row.agent, requires, pinned);
        row.binaries = binaries;
        if (reason) {
          row.state = "unavailable";
          row.reason = reason;
          this.parts.harnessResolution.forgetCatalog(row.agent);
        }
        continue;
      }
      if (!requirements) continue;
      if (requirements.needsClaudeWake && this.claudeWakeRecheck) {
        pending = this.claudeWakeRecheck;
        continue;
      }
      const pinned = this.pinnedBinaries.get(row.agent);
      const { binaries, reason } = resolveHarness(row.agent, requirements.requires, pinned);
      if (reason) {
        row.binaries = binaries;
        row.reason = reason;
      } else if (requirements.needsClaudeWake) {
        const release = setupClaude ? this.beginLifecycle(true) : undefined;
        if (!release) continue;
        pending = this.claudeWakeRecheck = this.prepareClaudeWake().then((failure) => {
          const rechecked = resolveHarness(row.agent, requirements.requires, pinned ?? binaries);
          row.binaries = rechecked.binaries;
          if (failure || rechecked.reason) { row.reason = failure ?? rechecked.reason; return; }
          const alreadyEnabled = this.parts.seatLaunch.classSpawnEnabled();
          this.pinnedBinaries.set(row.agent, { ...rechecked.binaries });
          row.state = "available";
          delete row.reason;
          if (!alreadyEnabled) this.parts.servePlane.syncClassSpawn();
        }).finally(() => { this.claudeWakeRecheck = undefined; release(); });
        void pending.catch((error) => console.error(`! manager: Claude recheck failed: ${rejectionText(error)}`));
      } else {
        this.pinnedBinaries.set(row.agent, { ...binaries });
        row.binaries = binaries;
        row.state = "available";
        delete row.reason;
      }
    }
    if (wasEnabled !== this.parts.seatLaunch.classSpawnEnabled()) this.parts.servePlane.syncClassSpawn();
    return pending;
  }
}

/** The connector rows a status read serves, copied so a reader cannot change the inventory. A row's
 *  `prompts` is the connector's declaration on every mesh mode, since a session serves its `agent`
 *  endpoint on each (SPEC 13.21). */
export function servedConnectorStatuses(rows: readonly ManagerConnectorStatus[]): ManagerConnectorStatus[] {
  return rows.map((row) => ({ ...row, binaries: { ...row.binaries } }));
}
