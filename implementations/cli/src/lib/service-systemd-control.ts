import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { CommandFailure, isCommandFailure } from "@cotal-ai/workspace";
import { seedGeneration } from "../seed/paths.js";
import { selfArgv } from "./self-exec.js";
import { assertPrivateSystemdGeneration } from "./service-private-seed.js";
import { reseedSystemdService } from "./service-systemd-reseed.js";
import { serviceDefinitionStore, type ServiceDefinitionSnapshot } from "./service-definitions.js";
import { serviceInstallIntentFor } from "./service-install-intent.js";
import { serviceUninstallIntentFor } from "./service-uninstall-intent.js";
import { instanceProjection, observeServiceProcess, processServiceHost, serviceInstanceStore, type ServiceInstanceSnapshot } from "./service-instances.js";
import { serviceReadiness } from "./service-process.js";
import { assertSystemdSource } from "./service-systemd-files.js";
import { observeRecordedSupervisor, submitSystemdUnitControl } from "./service-systemd.js";
import { serviceSupervisorStore } from "./service-supervision.js";
import { advanceServiceUnitAction, beginServiceUnitAction, serviceUnitActionFor, serviceUnitActionStore, type ServiceUnitAction } from "./service-unit-action.js";

/** The OS controls an already recorded unit, never an executable inferred from the definition
 *  name. Startup may update the instance from inside the unit, so no instance writer lock is held
 *  across a systemctl start request. A retained action blocks every new control request. */
export async function controlSystemdService(definition: ServiceDefinitionSnapshot, selected: ServiceInstanceSnapshot, operation: "start" | "stop") {
  const space = definition.record.value.space, id = selected.name;
  const definitions = serviceDefinitionStore(space), instances = serviceInstanceStore(space);
  const recorded = operation === "start" ? serviceSupervisorStore(space).read(id)?.record.value : undefined;
  const reseed = recorded && recorded.seededGeneration !== seedGeneration() && observeServiceProcess(selected.record.value) !== "running" ? reseedSystemdService(definition, selected) : null;
  const definitionHold = definitions.pin(definition);
  let instanceHold: ReturnType<typeof instances.pin> | undefined;
  let action: ReturnType<typeof beginServiceUnitAction> | undefined;
  let unit: string | undefined, unitPath: string | undefined, unitSha256: string | undefined;
  try {
    instanceHold = instances.pin(selected);
    if (serviceInstallIntentFor(space, id) || serviceUninstallIntentFor(space, id) || serviceUnitActionFor(space, id)) throw new CommandFailure("refused", "LIFECYCLE_BLOCKED", "an incomplete installation, removal or native action is retained; the unit was not controlled");
    const receipt = serviceSupervisorStore(space).read(id)?.record.value;
    const host = processServiceHost(), value = selected.record.value;
    if (!receipt || receipt.mechanism !== "systemd-user" || receipt.instanceId !== id || receipt.space !== space || receipt.definition !== definition.name || receipt.definitionRevision !== definition.record.revision || receipt.machine !== host.machine || receipt.uid !== host.uid || value.host.machine !== host.machine || value.host.uid !== host.uid || value.definitionRevision !== definition.record.revision) throw new CommandFailure("refused", "CONFLICT", "the selected instance has no exact same-host systemd supervisor receipt at this definition revision");
    unit = receipt.unit; unitPath = receipt.unitPath; unitSha256 = receipt.unitSha256;
    try { assertSystemdSource(unitPath, unitSha256); }
    catch { throw new CommandFailure("refused", "CONFLICT", "the recorded unit file could not be read as unchanged private physical bytes; no native action was submitted"); }
    const projected = instanceProjection(selected);
    const native = observeRecordedSupervisor(value, projected.supervisorRecord);
    if (native.state !== "observed" || native.loadState !== "loaded" || native.unitFileState !== "enabled" || native.daemonReloadRequired || native.dropInsReported) throw new CommandFailure("refused", "LIFECYCLE_BLOCKED", "the native unit does not have its unchanged loaded and enabled configuration; no action was submitted");
    const observed = observeServiceProcess(value);
    if (operation === "start") {
      if (native.activeState === "active" && native.mainProcessAttribution === "service-process" && observed === "running" && value.state === "running" && native.invocationId === value.supervisorInvocationId) return { instance: selected, unit, operation, attemptId: null, reseed: null, noOp: true as const };
      if (native.activeState !== "inactive" || native.mainPid !== null || !["stopped", "failed"].includes(value.state) || !["gone", "previous-boot"].includes(observed)) throw new CommandFailure("refused", "LIFECYCLE_BLOCKED", "the original instance is not settled and stopped under an inactive unit; no duplicate process was requested");
      if (receipt.seededGeneration !== seedGeneration()) throw new CommandFailure("refused", "LIFECYCLE_BLOCKED", "the installed private extension store belongs to another CLI generation; update and reseed it while this unit is stopped before native start");
      let cli: string[];
      try { cli = selfArgv(); }
      catch { throw new CommandFailure("refused", "UNSUPPORTED", "the current executable is not a durable Cotal entry for this owned unit"); }
      if (cli.length !== 2) throw new CommandFailure("refused", "UNSUPPORTED", "the installed unit requires its durable two-token CLI entry; no transient loader was substituted");
      assertPrivateSystemdGeneration(receipt.privateHome, receipt.seededGeneration, cli[1]!);
    } else {
      if (native.activeState === "inactive" && native.mainPid === null && ["gone", "previous-boot"].includes(observed) && value.state === "stopped") return { instance: selected, unit, operation, attemptId: null, reseed: null, noOp: true as const };
      if (native.activeState !== "active" || native.mainProcessAttribution !== "service-process" && native.mainProcessAttribution !== "launcher" || observed !== "running" || value.state !== "running" || native.invocationId !== value.supervisorInvocationId) throw new CommandFailure("refused", "LIFECYCLE_BLOCKED", "the original process and active native unit could not be attributed together; no unit stop was submitted");
    }
    const now = new Date().toISOString();
    const initial: ServiceUnitAction = { schemaVersion: 1, attemptId: randomUUID(), space, definition: definition.name, definitionRevision: definition.record.revision,
      instanceId: id, machine: host.machine, uid: host.uid, unit, unitPath, unitSha256, operation, position: "planned", createdAt: now, updatedAt: now };
    definitionHold.check(); instanceHold.check();
    action = beginServiceUnitAction(initial);
  } finally { instanceHold?.release(); definitionHold.release(); }
  if (!action) throw new CommandFailure("unknown", "OPERATION_UNKNOWN", "the native service action has no confirmed retained attempt");
  try {
    try { assertSystemdSource(unitPath!, unitSha256!); }
    catch { throw new CommandFailure("partial", "OPERATION_PARTIAL", "the owned unit source changed before native action submission; its planned attempt was retained without a user-manager request"); }
    action = advanceServiceUnitAction(action, "submitted");
    submitSystemdUnitControl(operation, unit!);
    let settled: ServiceInstanceSnapshot | undefined;
    if (operation === "start") {
      const deadline = Date.now() + definition.record.value.readiness.timeoutMs;
      do {
        const current = instances.read(id), projected = current && instanceProjection(current);
        const native = current && observeRecordedSupervisor(current.record.value, projected!.supervisorRecord);
        if (current && current.record.value.launchRequestId !== selected.record.value.launchRequestId && current.record.value.state === "starting" && projected!.observedProcess === "running" && native?.state === "observed" && native.activeState === "active" && native.mainProcessAttribution === "service-process" && native.invocationId === current.record.value.supervisorInvocationId) {
          settled = await serviceReadiness(current, definition.record.value);
          break;
        }
        await delay(100);
      } while (Date.now() < deadline);
      if (!settled) throw new CommandFailure("unknown", "OPERATION_UNKNOWN", "the native start returned but the unit's original process and declared readiness were not attributed before the deadline");
    } else {
      const current = instances.read(id);
      if (!current || current.record.revision !== selected.record.revision || current.hash !== selected.hash || !["gone", "previous-boot", "foreign-pid"].includes(observeServiceProcess(current.record.value))) throw new CommandFailure("unknown", "OPERATION_UNKNOWN", "the native stop returned without a confirmed exit of the original instance");
      const native = observeRecordedSupervisor(current.record.value, instanceProjection(current).supervisorRecord);
      if (native.state !== "observed" || native.activeState !== "inactive" || native.mainPid !== null || native.unitFileState !== "enabled" || native.daemonReloadRequired || native.dropInsReported) throw new CommandFailure("unknown", "OPERATION_UNKNOWN", "the native stop returned without a confirmed inactive unchanged unit");
      const saved = instances.commit(id, current, { ...current.record.value, state: "stopped", readiness: "not-checked", updatedAt: new Date().toISOString() });
      settled = instances.read(id);
      if (!saved || !settled || settled.record.revision !== saved.revision) throw new CommandFailure("unknown", "OPERATION_UNKNOWN", "the stopped instance did not confirm its terminal local revision");
    }
    action = advanceServiceUnitAction(action, "acknowledged");
    serviceUnitActionStore(space).commit(id, action, undefined);
    if (serviceUnitActionFor(space, id)) throw new CommandFailure("unknown", "OPERATION_UNKNOWN", "the native action's retained intent did not confirm settlement");
    return { instance: settled!, unit: unit!, operation, attemptId: action.record.value.attemptId, reseed, noOp: false as const };
  } catch (error) {
    if (action.record.value.position === "submitted") {
      try { action = advanceServiceUnitAction(action, "unknown"); }
      catch { /* An uncertain transition cannot authorize a replacement request. */ }
    }
    const unknown = !isCommandFailure(error) || error.outcome === "unknown" || action.record.value.position !== "planned";
    throw new CommandFailure(unknown ? "unknown" : "partial", unknown ? "OPERATION_UNKNOWN" : "OPERATION_PARTIAL", `the native service ${operation} did not settle; its original attempt was retained and the unit action was not retried`, { target: { space, definition: definition.name, instanceId: id, unit: unit!, attemptId: action.record.value.attemptId, position: action.record.value.position }, ...(reseed && !reseed.noOp ? { changed: [{ kind: "private-store-reseed", instanceId: id, generation: reseed.generation, attemptId: reseed.attemptId }] } : {}), remedy: "inspect the exact saved unit, instance and retained native action before reconciliation" });
  }
}
