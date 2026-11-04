import { CommandFailure } from "@cotal-ai/workspace";
import { serviceDefinitionStore } from "./service-definitions.js";
import { serviceInstances } from "./service-instances.js";
import { serviceSupervisorStore } from "./service-supervision.js";
import { serviceInstallIntents } from "./service-install-intent.js";
import { serviceUninstallIntents } from "./service-uninstall-intent.js";
import { serviceUnitActionStore } from "./service-unit-action.js";

/** Retained attempts are local records, not proof that a native effect did or did not run. */
export function readLocalServiceAttempts(space: string) {
  const installs = serviceInstallIntents(space), uninstalls = serviceUninstallIntents(space);
  const actions = serviceUnitActionStore(space).list();
  if (actions.some((row) => row.name !== row.record.value.instanceId))
    throw new CommandFailure("refused", "SCHEMA_INVALID", "a saved native action filename differs from its full instance ID; no complete inspection was inferred");
  return [
    ...installs.map(({ record }) => ({ kind: "install", attemptId: record.value.attemptId, instanceId: record.value.instanceId, definition: record.value.definition, step: record.value.step, position: record.value.position, unit: record.value.unit })),
    ...uninstalls.map(({ record }) => ({ kind: "uninstall", attemptId: record.value.attemptId, instanceId: record.value.instanceId, definition: record.value.definition, step: record.value.step, position: record.value.position, unit: record.value.unit })),
    ...actions.map(({ record }) => ({ kind: "unit-action", attemptId: record.value.attemptId, instanceId: record.value.instanceId, definition: record.value.definition, step: record.value.operation, position: record.value.position, unit: record.value.unit })),
  ];
}

/** Selected-space workstation records only. No project-root ownership or live state is inferred. */
export function readLocalServiceCensus(space: string) {
  const serviceRecords = serviceInstances(space).map(({ record }) => ({
    instanceId: record.value.instanceId, definition: record.value.definition,
    recordedState: record.value.state, host: record.value.host.name,
  }));
  const counts = new Map<string, number>();
  for (const row of serviceRecords) counts.set(row.definition, (counts.get(row.definition) ?? 0) + 1);
  const serviceDefinitions = serviceDefinitionStore(space).list().map(({ name, record }) => ({
    name, revision: record.revision, launch: record.value.launch.type,
    instanceRecords: counts.get(name) ?? 0,
  }));
  const receipts = serviceSupervisorStore(space).list();
  if (receipts.some((row) => row.name !== row.record.value.instanceId))
    throw new CommandFailure("refused", "SCHEMA_INVALID", "a saved supervisor filename differs from its full instance ID; no complete inspection was inferred");
  const supervisors = receipts.map(({ record }) => ({
    instanceId: record.value.instanceId, definition: record.value.definition,
    mechanism: record.value.mechanism, unit: record.value.unit,
  }));
  return { serviceDefinitions, serviceRecords, supervisors, nativeAttempts: readLocalServiceAttempts(space) };
}
