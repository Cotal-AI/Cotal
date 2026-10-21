import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { CommandFailure, homeCotalDir, isCommandFailure } from "@cotal-ai/workspace";
import { seedGeneration } from "../seed/paths.js";
import { selfArgv } from "./self-exec.js";
import { serviceDefinitionStore, type ServiceDefinitionSnapshot } from "./service-definitions.js";
import { serviceInstallIntentFor } from "./service-install-intent.js";
import { instanceProjection, processServiceHost, serviceInstanceStore, type ServiceInstanceSnapshot } from "./service-instances.js";
import { assertPrivateSystemdGeneration, seedPrivateSystemdStore } from "./service-private-seed.js";
import { fingerprintPrivateSystemdTree } from "./service-private-tree.js";
import { assertSystemdSource } from "./service-systemd-files.js";
import { observeRecordedSupervisor } from "./service-systemd.js";
import { renderSystemdServiceEnvironment } from "./service-systemd-unit.js";
import { serviceSupervisorStore } from "./service-supervision.js";
import { advanceServiceUnitAction, beginServiceUnitAction, serviceUnitActionFor, serviceUnitActionStore, type ServiceUnitAction } from "./service-unit-action.js";
import { serviceUninstallIntentFor } from "./service-uninstall-intent.js";

/** Upgrade one installed private extension store while its exact user unit is inactive. The
 *  submitted action survives a partial seed and blocks unit entry until explicitly reconciled. */
export function reseedSystemdService(definition: ServiceDefinitionSnapshot, selected: ServiceInstanceSnapshot) {
  const space = definition.record.value.space, id = selected.name;
  const definitions = serviceDefinitionStore(space), instances = serviceInstanceStore(space);
  const definitionHold = definitions.pin(definition);
  let instanceHold: ReturnType<typeof instances.pin> | undefined;
  try {
    instanceHold = instances.pin(selected);
    if (serviceInstallIntentFor(space, id) || serviceUninstallIntentFor(space, id) || serviceUnitActionFor(space, id)) throw new CommandFailure("refused", "LIFECYCLE_BLOCKED", "a native unit attempt is retained; private seeding was not retried");
    const store = serviceSupervisorStore(space), saved = store.read(id), receipt = saved?.record.value;
    const host = processServiceHost(), currentGeneration = seedGeneration();
    if (!saved || !receipt || receipt.mechanism !== "systemd-user" || receipt.instanceId !== id || receipt.definition !== definition.name || receipt.definitionRevision !== definition.record.revision || receipt.machine !== host.machine || receipt.uid !== host.uid || selected.record.value.host.machine !== host.machine || selected.record.value.host.uid !== host.uid || !receipt.environmentSha256 || !receipt.searchPath || !receipt.privateTreeSha256) throw new CommandFailure("refused", "CONFLICT", "this stopped unit has no complete same-host private seed provenance for an exact reseed");
    let cli: string[];
    try { cli = selfArgv(); }
    catch { throw new CommandFailure("refused", "UNSUPPORTED", "the current command is not a durable Cotal unit executable"); }
    if (cli.length !== 2) throw new CommandFailure("refused", "UNSUPPORTED", "the owned unit requires a durable two-token Cotal executable");
    const environmentFile = join(receipt.privateHome, "environment");
    const environment = renderSystemdServiceEnvironment({ controlHome: homeCotalDir(), configHome: join(receipt.privateHome, "config"), searchPath: receipt.searchPath });
    if (environment.sha256 !== receipt.environmentSha256) throw new CommandFailure("refused", "CONFLICT", "the current controller home cannot reproduce the unit's retained private environment");
    try { assertSystemdSource(receipt.unitPath, receipt.unitSha256); assertSystemdSource(environmentFile, receipt.environmentSha256, true); }
    catch { throw new CommandFailure("refused", "CONFLICT", "the exact unit or private environment differs from its recorded source; no seed was submitted"); }
    const row = instanceProjection(selected), native = observeRecordedSupervisor(selected.record.value, row.supervisorRecord);
    if (!["stopped", "failed"].includes(row.recordedState) || !["gone", "previous-boot"].includes(row.observedProcess) || native.state !== "observed" || native.loadState !== "loaded" || native.activeState !== "inactive" || native.mainPid !== null || native.unitFileState !== "enabled" || native.daemonReloadRequired || native.dropInsReported) throw new CommandFailure("refused", "LIFECYCLE_BLOCKED", "the exact owned unit is not stopped, loaded and unchanged; private seeding did not begin");
    let priorTree: string;
    try { priorTree = fingerprintPrivateSystemdTree(receipt.privateHome); }
    catch { throw new CommandFailure("refused", "CONFLICT", "the private store cannot be read as unchanged owned content; no reseed was submitted"); }
    if (priorTree !== receipt.privateTreeSha256) throw new CommandFailure("refused", "CONFLICT", "the private store changed since its last receipt; it was not overwritten by an automatic reseed");
    if (receipt.seededGeneration === currentGeneration) {
      assertPrivateSystemdGeneration(receipt.privateHome, currentGeneration, cli[1]!);
      return { instanceId: id, generation: currentGeneration, noOp: true as const };
    }
    const now = new Date().toISOString();
    const initial: ServiceUnitAction = { schemaVersion: 1, attemptId: randomUUID(), space, definition: definition.name, definitionRevision: definition.record.revision,
      instanceId: id, machine: host.machine, uid: host.uid, unit: receipt.unit, unitPath: receipt.unitPath, unitSha256: receipt.unitSha256,
      operation: "reseed", targetGeneration: currentGeneration, position: "planned", createdAt: now, updatedAt: now };
    definitionHold.check(); instanceHold.check();
    let action = beginServiceUnitAction(initial);
    try {
      action = advanceServiceUnitAction(action, "submitted");
      if (seedPrivateSystemdStore(receipt.privateHome, homeCotalDir(), receipt.searchPath) !== currentGeneration) throw new CommandFailure("unknown", "OPERATION_UNKNOWN", "the private seed's executable generation changed during the attempt");
      const privateTreeSha256 = fingerprintPrivateSystemdTree(receipt.privateHome);
      const next = { ...receipt, privateTreeSha256, seededGeneration: currentGeneration, installedAt: receipt.installedAt };
      const committed = store.commit(id, saved, next);
      const verified = store.read(id);
      if (!committed || !verified || verified.record.revision !== committed.revision) throw new CommandFailure("unknown", "OPERATION_UNKNOWN", "the reseeded private store's supervisor revision did not confirm publication");
      action = advanceServiceUnitAction(action, "acknowledged");
      serviceUnitActionStore(space).commit(id, action, undefined);
      if (serviceUnitActionFor(space, id)) throw new CommandFailure("unknown", "OPERATION_UNKNOWN", "the retained private seed action did not confirm settlement");
      return { instanceId: id, generation: currentGeneration, noOp: false as const, attemptId: initial.attemptId };
    } catch (error) {
      if (action.record.value.position === "submitted") {
        try { action = advanceServiceUnitAction(action, "unknown"); }
        catch { /* An unconfirmed seed or receipt is not automatically retried. */ }
      }
      throw new CommandFailure("unknown", "OPERATION_UNKNOWN", "the private service reseed did not settle; its exact attempt and store were retained without retry", { target: { space, instanceId: id, unit: receipt.unit, attemptId: initial.attemptId, position: action.record.value.position }, ...(isCommandFailure(error) && error.native ? { native: error.native } : {}), remedy: "inspect the private seed markers and retained native action before starting this unit" });
    }
  } finally { instanceHold?.release(); definitionHold.release(); }
}
