/**
 * The Manager tells a launcher, before any agent exists, whether a connector's sessions serve their
 * harness's tool permissions on the agent endpoint: `status.connectors[].prompts`. It is true only when
 * the connector declares `prompts` and the mesh is user-auth, because only there does the endpoint name
 * a caller. The declaration is read from a registered connector and from the cached inventory of an
 * installed extension, where a manifest written before the fact existed reads as false.
 *
 * Run: pnpm smoke:status-connector-prompts
 */
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registry, type Connector } from "@cotal-ai/core";
import { cacheConnector, extensionsDir, saveExtensionsManifest } from "@cotal-ai/workspace";
import { createSuite } from "@cotal-ai/smoke-kit";
import { ConnectorInventory, servedConnectorStatuses, type ConnectorInventoryDeps } from "../src/connector-inventory.js";
import { MANAGER_STATUS_CONTRACT, managerShippedSurface, type ManagerConnectorStatus } from "../src/manager-service-contract.js";

const { check, finish } = createSuite();

const shipped = managerShippedSurface();
check("the Manager cluster advances to revision 52 for the prompts fact", shipped.revision === 52, shipped);

const base = {
  instanceId: "a".repeat(26), execution: "runtime", runtime: "pty", custody: "legacy", runHosting: false,
  terminalSessions: true, agentCount: 0, uptimeMs: 1, classSpawn: true, staticReconciliation: { state: "idle", failures: [] },
};
const row = (extra: Record<string, unknown>) => ({ ...base, connectors: [{ agent: "probe", state: "available", binaries: {}, eventPlane: false, ...extra }] });
const valid = (status: unknown) => MANAGER_STATUS_CONTRACT.output.validate(status) === true;
check("status accepts prompts true and false on a connector row", valid(row({ prompts: true })) && valid(row({ prompts: false })));
check("status requires an explicit prompts fact, so a revision-51 row is refused", !valid(row({})));
check("status keeps prompts typed as a boolean", !valid(row({ prompts: "yes" })));

/** Take the inventory as boot does, with `installed` choosing the declared-inventory path. */
async function inspect(installed: boolean): Promise<ManagerConnectorStatus[]> {
  let rows: ManagerConnectorStatus[] = [];
  const deps = {
    bootNotes: () => [], setBootNotes: () => {}, connectorRequirements: () => new Map(), setConnectorRequirements: () => {},
    connectorStatuses: () => rows, setConnectorStatuses: (value: ManagerConnectorStatus[]) => { rows = value; },
    execution: () => "runtime", installedExtensions: () => installed, machineSetupCommand: () => undefined,
    classSpawnEnabled: () => true, prepareClaudeWake: async () => undefined,
  } as unknown as ConnectorInventoryDeps;
  await new ConnectorInventory(deps).inspectConnectorsAtBoot();
  return rows;
}
const fact = (rows: ManagerConnectorStatus[], agent: string, userMode: boolean) =>
  servedConnectorStatuses(rows, userMode).find((r) => r.agent === agent)?.prompts;

const connector = (name: string, extra: Partial<Connector> = {}): Connector =>
  ({ kind: "connector", name, requires: [], buildLaunch: () => ({ command: "true", args: [] }), ...extra }) as Connector;
const asks = connector("prompt-probe-asks", { prompts: true });
const silent = connector("prompt-probe-silent");
registry.register(asks, silent);
{
  const rows = await inspect(false);
  check("a registered connector that declares prompts reads true on a user-auth mesh", fact(rows, asks.name, true) === true, rows);
  check("... and false on an open or static mesh", fact(rows, asks.name, false) === false, rows);
  check("a registered connector that declares nothing reads false on every mesh", fact(rows, silent.name, true) === false && fact(rows, silent.name, false) === false, rows);
  check("the served rows validate against the status contract", valid({ ...base, connectors: servedConnectorStatuses(rows, true) }), MANAGER_STATUS_CONTRACT.output.validate.errors);
}

const root = mkdtempSync(join(tmpdir(), "status-connector-prompts-"));
const oldConfig = process.env.XDG_CONFIG_HOME;
process.env.XDG_CONFIG_HOME = join(root, "config");
try {
  mkdirSync(extensionsDir(), { recursive: true });
  const cachedAsks = cacheConnector(connector("cached-asks", { prompts: true }));
  const cachedSilent = cacheConnector(connector("cached-silent"));
  check("the extension cache records the declaration either way", cachedAsks.prompts === true && cachedSilent.prompts === false, [cachedAsks, cachedSilent]);
  saveExtensionsManifest({
    extensions: [{
      pkg: "@fixture/prompt-connectors", version: "1.0.0", spec: ".", commands: [],
      provides: [{ kind: "connector", name: "cached-asks" }, { kind: "connector", name: "cached-silent" }, { kind: "connector", name: "cached-before" }],
      connectors: [cachedAsks, cachedSilent, { name: "cached-before", requires: [], eventPlane: false, setup: null }],
    }],
  });
  const rows = await inspect(true);
  check("an installed connector cached with prompts reads true on a user-auth mesh and false elsewhere",
    fact(rows, "cached-asks", true) === true && fact(rows, "cached-asks", false) === false, rows);
  check("one cached before the fact existed reads false", fact(rows, "cached-before", true) === false && fact(rows, "cached-silent", true) === false, rows);
} finally {
  if (oldConfig === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = oldConfig;
  rmSync(root, { recursive: true, force: true });
}
finish();
