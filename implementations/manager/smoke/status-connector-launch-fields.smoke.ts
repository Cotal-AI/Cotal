/**
 * The Manager tells a launcher, before any agent exists, whether a connector takes the opt-in launch
 * fields: `status.connectors[].askPermissions` and `.reasoningEvents`. Each is the connector's own
 * declaration, read from a registered connector and from the cached inventory of an installed
 * extension, where a manifest written before the fields existed reads as false.
 *
 * Run: pnpm smoke:status-connector-launch-fields
 */
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registry, type Connector } from "@cotal-ai/core";
import { cacheConnector, extensionsDir, saveExtensionsManifest } from "@cotal-ai/workspace";
import { createSuite } from "@cotal-ai/smoke-kit";
import { ConnectorInventory, servedConnectorStatuses } from "../src/connector-inventory.js";
import { MANAGER_STATUS_CONTRACT, managerShippedSurface, type ManagerConnectorStatus } from "../src/manager-service-contract.js";

const { check, finish } = createSuite();

check("the Manager cluster is at revision 59, past the launch fields of revision 56", managerShippedSurface().revision === 59);

const base = {
  instanceId: "a".repeat(26), execution: "runtime", runtime: "pty", custody: "legacy", runHosting: false,
  terminalSessions: true, agentCount: 0, uptimeMs: 1, classSpawn: true, staticReconciliation: { state: "idle", failures: [] },
};
const row = (extra: Record<string, unknown>) => ({ ...base, connectors: [{ agent: "probe", state: "available", binaries: {}, eventPlane: true, prompts: false, ...extra }] });
const valid = (status: unknown) => MANAGER_STATUS_CONTRACT.output.validate(status) === true;
check("status accepts both facts as booleans", valid(row({ askPermissions: true, reasoningEvents: false })) && valid(row({ askPermissions: false, reasoningEvents: true })));
check("status requires both facts, so a revision-55 row is refused", !valid(row({})) && !valid(row({ askPermissions: false })) && !valid(row({ reasoningEvents: false })));
check("status keeps both facts typed as booleans", !valid(row({ askPermissions: "yes", reasoningEvents: false })) && !valid(row({ askPermissions: false, reasoningEvents: 1 })));

async function inspect(installed: boolean): Promise<ManagerConnectorStatus[]> {
  const inventory = new ConnectorInventory(
    { execution: "runtime", installedExtensions: installed, machineSetupCommand: undefined, expectedConnectorGeneration: "" },
    { seatLaunch: { classSpawnEnabled: () => true } } as unknown as ConstructorParameters<typeof ConnectorInventory>[1],
    () => undefined,
  );
  await inventory.inspectConnectorsAtBoot();
  return servedConnectorStatuses(inventory.connectorStatuses);
}
const facts = (rows: ManagerConnectorStatus[], agent: string) => {
  const r = rows.find((candidate) => candidate.agent === agent);
  return r && [r.askPermissions, r.reasoningEvents];
};
const connector = (name: string, extra: Partial<Connector> = {}): Connector =>
  ({ kind: "connector", name, requires: [], buildLaunch: () => ({ command: "true", args: [] }), ...extra }) as Connector;

registry.register(
  connector("fields-probe-both", { supportsAskPermissions: true, supportsReasoningEvents: true }),
  connector("fields-probe-reasoning", { supportsReasoningEvents: true }),
  connector("fields-probe-none"),
);
{
  const rows = await inspect(false);
  check("a registered connector's declarations reach its row on any mesh",
    JSON.stringify([facts(rows, "fields-probe-both"), facts(rows, "fields-probe-reasoning"), facts(rows, "fields-probe-none")]) ===
      JSON.stringify([[true, true], [false, true], [false, false]]), rows);
  check("the rows validate against the status contract", valid({ ...base, connectors: rows }), MANAGER_STATUS_CONTRACT.output.validate.errors);
}

const root = mkdtempSync(join(tmpdir(), "status-connector-launch-fields-"));
const oldConfig = process.env.XDG_CONFIG_HOME;
process.env.XDG_CONFIG_HOME = join(root, "config");
try {
  mkdirSync(extensionsDir(), { recursive: true });
  const cachedBoth = cacheConnector(connector("cached-both", { supportsAskPermissions: true, supportsReasoningEvents: true }));
  const cachedNone = cacheConnector(connector("cached-none"));
  check("the extension cache records each declaration either way",
    cachedBoth.askPermissions === true && cachedBoth.reasoningEvents === true && cachedNone.askPermissions === false && cachedNone.reasoningEvents === false,
    [cachedBoth, cachedNone]);
  saveExtensionsManifest({
    extensions: [{
      pkg: "@fixture/field-connectors", version: "1.0.0", spec: ".", commands: [],
      provides: [{ kind: "connector", name: "cached-both" }, { kind: "connector", name: "cached-none" }, { kind: "connector", name: "cached-before" }],
      connectors: [cachedBoth, cachedNone, { name: "cached-before", requires: [], eventPlane: true, setup: null }],
    }],
  });
  const rows = await inspect(true);
  check("an installed connector's cached declarations reach its row", JSON.stringify(facts(rows, "cached-both")) === "[true,true]", rows);
  check("one cached without them, or before they existed, reads false",
    JSON.stringify([facts(rows, "cached-none"), facts(rows, "cached-before")]) === "[[false,false],[false,false]]", rows);
} finally {
  if (oldConfig === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = oldConfig;
  rmSync(root, { recursive: true, force: true });
}
finish();
