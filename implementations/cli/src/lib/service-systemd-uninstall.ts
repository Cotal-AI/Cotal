import { randomUUID } from "node:crypto";
import { dirname } from "node:path";
import { unlinkFileNoFollow } from "@cotal-ai/core";
import { CommandFailure, isCommandFailure } from "@cotal-ai/workspace";
import { serviceDefinitionStore, type ServiceDefinitionSnapshot } from "./service-definitions.js";
import { serviceInstanceStore, type ServiceInstanceSnapshot } from "./service-instances.js";
import { fingerprintPrivateSystemdTree, removePrivateSystemdTree } from "./service-private-tree.js";
import { assertSystemdSource } from "./service-systemd-files.js";
import { inspectSystemdUninstall } from "./service-systemd-uninstall-plan.js";
import { assertSystemdInstallState, assertSystemdUnitAbsent, submitSystemdUnitRegistration, systemdUserUnitDirectory } from "./service-systemd.js";
import { serviceSupervisorStore } from "./service-supervision.js";
import { advanceServiceUninstallIntent, beginServiceUninstallIntent, serviceUninstallIntentStore, serviceUninstallIntentProjection, type ServiceUninstallIntent } from "./service-uninstall-intent.js";

/** A stopped exact unit is disabled, unlinked and unloaded before its pinned private tree or
 *  supervisor receipt is removed. The retained intent blocks native boot after every crash cut. */
export function uninstallSystemdService(definition: ServiceDefinitionSnapshot, selected: ServiceInstanceSnapshot) {
  const space = definition.record.value.space, id = selected.name;
  const definitions = serviceDefinitionStore(space), instances = serviceInstanceStore(space);
  const definitionHold = definitions.pin(definition);
  let instanceHold: ReturnType<typeof instances.pin> | undefined;
  try {
    instanceHold = instances.pin(selected);
    const candidate = inspectSystemdUninstall(definition, selected);
    const receipt = candidate.receipt.record.value;
    if (systemdUserUnitDirectory() !== dirname(receipt.unitPath)) throw new CommandFailure("refused", "CONFLICT", "the user manager changed its physical unit directory; no removal was attempted");
    const now = new Date().toISOString();
    const initial: ServiceUninstallIntent = { schemaVersion: 1, attemptId: randomUUID(), space, definition: definition.name,
      definitionRevision: definition.record.revision, instanceId: id, machine: receipt.machine, uid: receipt.uid, unit: receipt.unit,
      unitPath: receipt.unitPath, unitSha256: receipt.unitSha256, privateHome: receipt.privateHome,
      privateTreeSha256: receipt.privateTreeSha256!, step: "disable", position: "planned", createdAt: now, updatedAt: now };
    definitionHold.check(); instanceHold.check();
    let intent = beginServiceUninstallIntent(initial);
    const effect = (step: ServiceUninstallIntent["step"], preflight: () => void, run: () => void) => {
      if (intent.record.value.step !== step || intent.record.value.position !== "planned") intent = advanceServiceUninstallIntent(intent, step, "planned");
      definitionHold.check(); instanceHold!.check();
      try { preflight(); }
      catch { throw new CommandFailure("partial", "OPERATION_PARTIAL", "the next native removal preflight did not establish its unchanged target; no effect for that step was submitted", { target: { instanceId: id, step } }); }
      intent = advanceServiceUninstallIntent(intent, step, "submitted");
      try {
        run();
        intent = advanceServiceUninstallIntent(intent, step, "acknowledged");
      } catch (error) {
        if (intent.record.value.position === "submitted") {
          try { intent = advanceServiceUninstallIntent(intent, step, "unknown"); }
          catch { /* Do not replay an uncertain native or filesystem effect. */ }
        }
        throw error;
      }
    };
    try {
      effect("disable", () => {
        assertSystemdSource(receipt.unitPath, receipt.unitSha256);
        assertSystemdInstallState(selected.record.value, receipt.unit, receipt.unitPath, "enabled");
      }, () => {
        submitSystemdUnitRegistration("disable", receipt.unit);
        assertSystemdInstallState(selected.record.value, receipt.unit, receipt.unitPath, "disabled");
      });
      effect("unit", () => {
        assertSystemdSource(receipt.unitPath, receipt.unitSha256);
        assertSystemdInstallState(selected.record.value, receipt.unit, receipt.unitPath, "disabled");
      }, () => {
        if (!unlinkFileNoFollow(receipt.unitPath)) throw new CommandFailure("unknown", "OPERATION_UNKNOWN", "the disabled exact unit disappeared before its owned file removal confirmed");
      });
      effect("reload", () => {}, () => {
        submitSystemdUnitRegistration("reload", receipt.unit);
        assertSystemdUnitAbsent(receipt.unit, receipt.unitPath);
      });
      effect("private-store", () => {
        assertSystemdUnitAbsent(receipt.unit, receipt.unitPath);
        if (fingerprintPrivateSystemdTree(receipt.privateHome) !== receipt.privateTreeSha256) throw new CommandFailure("refused", "CONFLICT", "the private unit tree changed after disable; its contents were not deleted");
      }, () => removePrivateSystemdTree(receipt.privateHome, receipt.privateTreeSha256!));
      effect("receipt", () => assertSystemdUnitAbsent(receipt.unit, receipt.unitPath), () => {
        const store = serviceSupervisorStore(space);
        store.commit(id, candidate.receipt, undefined);
        if (store.read(id)) throw new CommandFailure("unknown", "OPERATION_UNKNOWN", "the removed unit's supervisor receipt did not confirm deletion");
      });
      serviceUninstallIntentStore(space).commit(id, intent, undefined);
      if (serviceUninstallIntentStore(space).read(id)) throw new CommandFailure("unknown", "OPERATION_UNKNOWN", "the removed unit's retained uninstall intent did not confirm settlement");
      return { ...candidate.target, unit: receipt.unit, attemptId: initial.attemptId, nativeLoadState: "not-found" as const,
        unitRemoved: true, privateStoreRemoved: true, receiptRemoved: true, definitionRetained: true };
    } catch (error) {
      const unknown = !isCommandFailure(error) || error.outcome === "unknown" || intent.record.value.position === "submitted" || intent.record.value.position === "unknown";
      throw new CommandFailure(unknown ? "unknown" : "partial", unknown ? "OPERATION_UNKNOWN" : "OPERATION_PARTIAL", "the exact native unit removal did not finish; its original attempt and confirmed steps were retained without retry", { target: { ...candidate.target, unit: receipt.unit, attemptId: initial.attemptId, step: intent.record.value.step, position: intent.record.value.position }, changed: [{ unit: receipt.unit, lastConfirmedStep: serviceUninstallIntentProjection(intent.record.value).lastAcknowledgedStep }], remedy: "inspect the exact unit, private store and retained native removal attempt before reconciliation" });
    }
  } finally { instanceHold?.release(); definitionHold.release(); }
}
