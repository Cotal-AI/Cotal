import { existsSync, unwatchFile, watchFile } from "node:fs";
import { dirname, join } from "node:path";
import { oneLine, registry, rejectionText } from "@cotal-ai/core";
import type { Connector, ConnectorSetupProvider } from "@cotal-ai/core";
import { BUILT_IN_PACKAGES, extensionConnectors, extensionRestartReason, extensionsManifestPath, loadExtensionsManifest, logicalExecutionEntry, materializeFromManifest, OFFICIAL_CONNECTORS, reconcileExtensionScopes, type InstalledExtension } from "@cotal-ai/workspace";
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

type DeclaredConnector = ReturnType<typeof extensionConnectors>[number];
type ConnectorRequirements = { requires: readonly string[]; needsClaudeWake: boolean; entry?: InstalledExtension; restart?: string };
type ManifestWatch = { path: string; listener: () => void; timer?: ReturnType<typeof setTimeout> };

function sameInstall(a: InstalledExtension | undefined, b: InstalledExtension): boolean {
  return a?.pkg === b.pkg && a.version === b.version && a.installId === b.installId;
}

function declaredConnectors(entries: readonly InstalledExtension[]) {
  return entries.filter((entry) => !Object.hasOwn(BUILT_IN_PACKAGES, entry.pkg))
    .flatMap((entry) => extensionConnectors(entry).map((connector) => ({ connector, entry })));
}

function inspectedRow(connector: Pick<DeclaredConnector, "name" | "eventPlane" | "prompts" | "askPermissions" | "reasoningEvents">, binaries: Record<string, string>, reason?: string): ManagerConnectorStatus {
  return {
    agent: connector.name, binaries, eventPlane: connector.eventPlane, prompts: connector.prompts === true,
    askPermissions: connector.askPermissions === true, reasoningEvents: connector.reasoningEvents === true,
    ...(reason ? { state: "unavailable", reason } : { state: "available" }),
  };
}

/** The connector inventory taken at boot: which harnesses resolve on this host and the notes for those that do not.
 *  It owns the rows; other parts hold this object and read them at use. */
export class ConnectorInventory {
  /** Connector harness inventory. Available paths stay pinned; unavailable rows are retried when
   * launch, model lookup or status asks, without stopping unrelated Manager work. */
  connectorStatuses: ManagerConnectorStatus[] = [];
  private connectorRequirements = new Map<string, ConnectorRequirements>();
  private claudeWakeRecheck?: Promise<void>;
  private manifestWatch?: ManifestWatch;
  private inspecting = false;
  /** The boot inventory's warnings, printed once start completes, so a refused start prints none. */
  bootNotes: string[] = [];

  constructor(
    private readonly settings: ConnectorInventorySettings,
    private readonly parts: Pick<ManagerParts, "harnessResolution" | "seatLaunch" | "servePlane">,
    /** The Manager's lifecycle admission, which a Claude wake recheck holds while it runs. */
    private readonly beginLifecycle: (resumeOperation: boolean) => (() => void) | undefined,
    private readonly pruneRuntimeCache: (entries: readonly InstalledExtension[]) => void = () => {},
  ) {}

  private get followsManifest(): boolean {
    return this.settings.installedExtensions && this.settings.execution === "runtime";
  }

  startManifestWatch(): void {
    if (!this.followsManifest || this.manifestWatch) return;
    const path = extensionsManifestPath();
    const watch: ManifestWatch = { path, listener: () => {
      if (this.manifestWatch !== watch) return;
      clearTimeout(watch.timer);
      watch.timer = setTimeout(() => {
        try { this.refreshUnavailableConnectors(); }
        catch (error) { console.error(`! manager: extension inventory watch failed: ${oneLine(rejectionText(error))}`); }
      }, 50).unref();
    } };
    watchFile(path, { interval: 2000, persistent: false }, watch.listener);
    this.manifestWatch = watch;
    // Boot and the poller's initial stat need not see the same manifest.
    watch.listener();
  }

  stopManifestWatch(): void {
    const watch = this.manifestWatch;
    if (!watch) return;
    this.manifestWatch = undefined;
    clearTimeout(watch.timer);
    unwatchFile(watch.path, watch.listener);
  }

  /** Reconcile before either inventory reads or provider resolution, without the writer lock. */
  reconcileManifest(): void {
    if (!this.followsManifest || this.inspecting) return;
    try {
      const path = extensionsManifestPath();
      const journal = join(dirname(dirname(path)), ".extensions-promotion.json");
      const promoting = existsSync(journal);
      const entries = loadExtensionsManifest().extensions;
      if (!entries.length && (promoting || existsSync(journal))) return;
      reconcileExtensionScopes(entries);
      this.pruneRuntimeCache(entries);
      this.updateManifestRows(entries);
    } catch (error) {
      console.error(`! manager: extension inventory reconcile failed: ${oneLine(rejectionText(error))}`);
    }
  }

  private requirements(connector: Pick<DeclaredConnector, "name" | "requires">, entry?: InstalledExtension): ConnectorRequirements {
    return {
      entry, requires: connector.requires,
      needsClaudeWake: !!this.settings.machineSetupCommand && connector.name === "claude" && entry?.pkg === OFFICIAL_CONNECTORS.claude,
      restart: entry && extensionRestartReason(entry, true),
    };
  }

  private updateManifestRows(entries: readonly InstalledExtension[]): void {
    const wasEnabled = this.parts.seatLaunch.classSpawnEnabled();
    const previousRows = new Map(this.connectorStatuses.map((row) => [row.agent, row]));
    const requirements = new Map<string, ConnectorRequirements>();
    const rows = declaredConnectors(entries).map(({ connector, entry }) => {
      const { name, requires } = connector;
      const req = this.requirements(connector, entry);
      const previous = this.connectorRequirements.get(name);
      const row = previousRows.get(name);
      requirements.set(name, req);
      if (row && sameInstall(previous?.entry, entry) && previous?.restart === req.restart) return row;
      const { binaries, reason } = resolveHarness(name, requires);
      return inspectedRow(connector, binaries, req.restart ?? reason ?? (req.needsClaudeWake ? "Claude wake channel setup is pending" : undefined));
    });
    this.connectorRequirements = requirements;
    this.connectorStatuses = rows.sort((a, b) => a.agent.localeCompare(b.agent));
    if (wasEnabled !== this.parts.seatLaunch.classSpawnEnabled()) this.parts.servePlane.syncClassSpawn();
  }

  /** Resolve every installed/registered connector's declared harness binaries before the manager
   * reports ready. A missing harness degrades only that connector, never unrelated lifecycle work:
   * boot continues, names it once start completes and records it on both manager status surfaces. */
  async inspectConnectorsAtBoot(): Promise<void> {
    this.inspecting = true;
    try { await this.inspectConnectors(); }
    finally { this.inspecting = false; }
  }

  private async inspectConnectors(): Promise<void> {
    this.bootNotes = [];
    if (this.settings.execution === "none") { this.connectorStatuses = []; return; }
    const rows: ManagerConnectorStatus[] = [];
    let declared: Array<Pick<DeclaredConnector, "name" | "requires" | "eventPlane" | "prompts" | "askPermissions" | "reasoningEvents"> & { entry?: InstalledExtension }>;
    if (this.settings.installedExtensions) {
      try {
        const entries = loadExtensionsManifest().extensions;
        reconcileExtensionScopes(entries);
        declared = declaredConnectors(entries).map(({ connector, entry }) => ({ ...connector, entry }));
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
    this.connectorRequirements = new Map(declared.map((connector) => [connector.name, this.requirements(connector, connector.entry)]));
    for (const connector of declared) {
      const { name, requires } = connector;
      const { binaries, reason: missing } = resolveHarness(name, requires);
      const requirements = this.connectorRequirements.get(name);
      const reason = requirements?.restart ?? missing ?? (requirements?.needsClaudeWake ? await this.prepareClaudeWake() : undefined);
      rows.push(inspectedRow(connector, binaries, reason));
      if (reason) this.bootNotes.push(`! manager boot: connector ${name} unavailable - ${reason}`);
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

  /** Retry unavailable applications without changing resolved available rows. Claude launches
   *  join the status or launch that started wake setup, before any name or capacity is reserved. */
  refreshUnavailableConnectors(name?: string, setupClaude = false): Promise<void> | undefined {
    this.reconcileManifest();
    const wasEnabled = this.parts.seatLaunch.classSpawnEnabled();
    let pending: Promise<void> | undefined;
    for (const row of this.connectorStatuses) {
      if (row.state !== "unavailable" || (name !== undefined && row.agent !== name)) continue;
      const requirements = this.connectorRequirements.get(row.agent);
      if (!requirements || requirements.restart) continue;
      if (requirements.needsClaudeWake && this.claudeWakeRecheck) {
        pending = this.claudeWakeRecheck;
        continue;
      }
      const { binaries, reason } = resolveHarness(row.agent, requirements.requires);
      if (reason) {
        row.binaries = binaries;
        row.reason = reason;
      } else if (requirements.needsClaudeWake) {
        const release = setupClaude ? this.beginLifecycle(true) : undefined;
        if (!release) continue;
        pending = this.claudeWakeRecheck = this.prepareClaudeWake().then((failure) => {
          this.reconcileManifest();
          if (!this.connectorStatuses.includes(row)) return;
          row.binaries = binaries;
          if (failure) { row.reason = failure; return; }
          const wasEnabled = this.parts.seatLaunch.classSpawnEnabled();
          row.state = "available";
          delete row.reason;
          if (!wasEnabled) this.parts.servePlane.syncClassSpawn();
        }).finally(() => { this.claudeWakeRecheck = undefined; release(); });
        void pending.catch((error) => console.error(`! manager: Claude recheck failed: ${rejectionText(error)}`));
      } else {
        row.binaries = binaries;
        row.state = "available";
        delete row.reason;
      }
    }
    if (!wasEnabled && this.parts.seatLaunch.classSpawnEnabled()) this.parts.servePlane.syncClassSpawn();
    return pending;
  }
}

/** The connector rows a status read serves, copied so a reader cannot change the inventory. A row's
 *  `prompts` is the connector's declaration on every mesh mode, since a session serves its `agent`
 *  endpoint on each (SPEC 13.21). */
export function servedConnectorStatuses(rows: readonly ManagerConnectorStatus[]): ManagerConnectorStatus[] {
  return rows.map((row) => ({ ...row, binaries: { ...row.binaries } }));
}
