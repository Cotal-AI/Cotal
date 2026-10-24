import { randomUUID } from "node:crypto";
import { lstatSync } from "node:fs";
import { CommandFailure, isCommandFailure } from "@cotal-ai/workspace";
import { seedGeneration } from "../seed/paths.js";
import { serviceDefinitionStore, type ServiceDefinitionSnapshot } from "./service-definitions.js";
import { beginServiceInstallIntent, advanceServiceInstallIntent, serviceInstallIntentStore, serviceInstallIntentProjection, type ServiceInstallIntent } from "./service-install-intent.js";
import { processServiceHost, serviceInstanceStore, type ServiceInstanceSnapshot } from "./service-instances.js";
import { seedPrivateSystemdStore } from "./service-private-seed.js";
import { fingerprintPrivateSystemdTree } from "./service-private-tree.js";
import { assertSystemdSource, createSystemdPrivateHome, createSystemdSource } from "./service-systemd-files.js";
import { inspectSystemdInstall } from "./service-systemd-plan.js";
import { assertSystemdInstallState, submitSystemdUnitRegistration, systemdUserUnitDirectory } from "./service-systemd.js";
import { serviceSupervisorStore, type ServiceSupervisorRecord } from "./service-supervision.js";

function absent(path: string): void {
  try { lstatSync(path); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw new CommandFailure("refused", "TARGET_UNAVAILABLE", "an installation target could not be inspected; no empty private state was inferred");
  }
  throw new CommandFailure("refused", "CONFLICT", "a proposed native installation path already exists without this attempt's ownership receipt; nothing was overwritten");
}

/** Install an inactive direct-process user unit. Every file/native effect has a retained
 *  submitted intent before it runs. An uncertain step is never replayed by this route. */
export function installSystemdService(definition: ServiceDefinitionSnapshot, selected: ServiceInstanceSnapshot) {
  const space = definition.record.value.space;
  const definitions = serviceDefinitionStore(space), instances = serviceInstanceStore(space);
  const definitionHold = definitions.pin(definition);
  let instanceHold: ReturnType<typeof instances.pin> | undefined;
  try {
    instanceHold = instances.pin(selected);
    const planned = inspectSystemdInstall(definition, selected);
    if (planned.existing !== "not-found-at-read") throw new CommandFailure("refused", "CONFLICT", "the proposed user-unit file is already present without an installation receipt; it was not adopted");
    absent(planned.privateHome);
    absent(planned.environmentFile);
    const host = processServiceHost(), value = selected.record.value;
    if (host.machine !== value.host.machine || host.uid !== value.host.uid) throw new CommandFailure("refused", "CONFLICT", "the stopped service instance belongs to another execution host; it was not installed");
    const generation = seedGeneration();
    const now = new Date().toISOString();
    const target = { space, definition: definition.name, instanceId: selected.name, unit: planned.unit.unit };
    const initial: ServiceInstallIntent = {
      schemaVersion: 1, attemptId: randomUUID(), space, definition: definition.name, definitionRevision: definition.record.revision,
      instanceId: selected.name, machine: host.machine, uid: host.uid, unit: planned.unit.unit, unitPath: planned.unitPath,
      unitSha256: planned.unit.sha256, environmentSha256: planned.environment.sha256, privateHome: planned.privateHome,
      environmentFile: planned.environmentFile, generation, step: "private-home", position: "planned", createdAt: now, updatedAt: now,
    };
    definitionHold.check(); instanceHold.check();
    let intent = beginServiceInstallIntent(initial);
    const effect = (step: ServiceInstallIntent["step"], preflight: () => void, run: () => void) => {
      if (intent.record.value.step !== step || intent.record.value.position !== "planned") intent = advanceServiceInstallIntent(intent, step, "planned");
      definitionHold.check(); instanceHold!.check();
      try { preflight(); }
      catch { throw new CommandFailure("partial", "OPERATION_PARTIAL", "the next installation target changed before its effect; the planned attempt was retained without a native request for that step", { target: { instanceId: selected.name, step } }); }
      intent = advanceServiceInstallIntent(intent, step, "submitted");
      try {
        run();
        intent = advanceServiceInstallIntent(intent, step, "acknowledged");
      } catch (error) {
        if (intent.record.value.position === "submitted") {
          try { intent = advanceServiceInstallIntent(intent, step, "unknown"); }
          catch { /* A failed record transition cannot authorize another native request. */ }
        }
        throw error;
      }
    };
    try {
      effect("private-home", () => {
        absent(planned.privateHome);
        if (systemdUserUnitDirectory() !== planned.directory) throw new Error("user unit directory changed");
      }, () => createSystemdPrivateHome(planned.directory, planned.privateHome));
      effect("environment", () => absent(planned.environmentFile), () => createSystemdSource(planned.environmentFile, planned.environment.bytes, planned.environment.sha256, true));
      effect("seed", () => assertSystemdSource(planned.environmentFile, planned.environment.sha256, true), () => {
        const seeded = seedPrivateSystemdStore(planned.privateHome, planned.controlHome, planned.searchPath);
        if (seeded !== generation) throw new CommandFailure("unknown", "OPERATION_UNKNOWN", "the private seed's generation changed during installation; it was not retried");
      });
      effect("unit", () => {
        assertSystemdSource(planned.environmentFile, planned.environment.sha256, true);
        absent(planned.unitPath);
      }, () => createSystemdSource(planned.unitPath, planned.unit.bytes, planned.unit.sha256));
      effect("reload", () => {
        assertSystemdSource(planned.unitPath, planned.unit.sha256);
        assertSystemdSource(planned.environmentFile, planned.environment.sha256, true);
        if (systemdUserUnitDirectory() !== planned.directory) throw new Error("user unit directory changed");
      }, () => {
        submitSystemdUnitRegistration("reload", planned.unit.unit);
        assertSystemdInstallState(value, planned.unit.unit, planned.unitPath, "disabled");
      });
      effect("enable", () => {
        assertSystemdSource(planned.unitPath, planned.unit.sha256);
        assertSystemdSource(planned.environmentFile, planned.environment.sha256, true);
        assertSystemdInstallState(value, planned.unit.unit, planned.unitPath, "disabled");
      }, () => {
        submitSystemdUnitRegistration("enable", planned.unit.unit);
        assertSystemdInstallState(value, planned.unit.unit, planned.unitPath, "enabled");
      });
      effect("receipt", () => {
        assertSystemdSource(planned.unitPath, planned.unit.sha256);
        assertSystemdSource(planned.environmentFile, planned.environment.sha256, true);
        assertSystemdInstallState(value, planned.unit.unit, planned.unitPath, "enabled");
      }, () => {
        const privateTreeSha256 = fingerprintPrivateSystemdTree(planned.privateHome);
        const receipt: ServiceSupervisorRecord = { schemaVersion: 1, space, definition: definition.name, definitionRevision: definition.record.revision,
          instanceId: selected.name, machine: host.machine, uid: host.uid, mechanism: "systemd-user", unit: planned.unit.unit,
          unitPath: planned.unitPath, unitSha256: planned.unit.sha256, privateHome: planned.privateHome, environmentSha256: planned.environment.sha256, searchPath: planned.searchPath, privateTreeSha256, seededGeneration: generation, installedAt: new Date().toISOString() };
        const store = serviceSupervisorStore(space);
        const saved = store.commit(selected.name, undefined, receipt);
        const current = store.read(selected.name);
        if (!saved || !current || current.record.revision !== saved.revision) throw new CommandFailure("unknown", "OPERATION_UNKNOWN", "the final supervisor receipt did not confirm publication; the enabled unit was not retried or adopted");
      });
      const saved = serviceSupervisorStore(space).read(selected.name);
      if (!saved) throw new CommandFailure("unknown", "OPERATION_UNKNOWN", "the enabled unit's supervisor receipt disappeared before the installation intent settled");
      serviceInstallIntentStore(space).commit(selected.name, intent, undefined);
      if (serviceInstallIntentStore(space).read(selected.name)) throw new CommandFailure("unknown", "OPERATION_UNKNOWN", "the installation intent did not confirm settlement; the native unit was not retried");
      return { ...target, unitPath: planned.unitPath, privateHome: planned.privateHome, generation, attemptId: initial.attemptId, unitFileState: "enabled" as const, started: false };
    } catch (error) {
      const unknown = !isCommandFailure(error) || error.outcome === "unknown" || intent.record.value.position === "unknown" || intent.record.value.position === "submitted";
      throw new CommandFailure(unknown ? "unknown" : "partial", unknown ? "OPERATION_UNKNOWN" : "OPERATION_PARTIAL", "the native service installation did not finish; its original attempt and confirmed steps were retained without cleanup or retry", { target: { ...target, attemptId: initial.attemptId, step: intent.record.value.step, position: intent.record.value.position }, changed: [{ unit: planned.unit.unit, privateHome: planned.privateHome, lastConfirmedStep: serviceInstallIntentProjection(intent.record.value).lastAcknowledgedStep }], remedy: "inspect the retained installation attempt, private store and exact native unit before reconciliation" });
    }
  } finally { instanceHold?.release(); definitionHold.release(); }
}
