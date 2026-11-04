import { basename, isAbsolute } from "node:path";
import { CommandFailure, isCommandFailure, localRecordName, serviceOperationId } from "@cotal-ai/workspace";
import { localRecordObject, localRecordText, ProtectedRecordStore, type LocalRecordSnapshot } from "./protected-records.js";

export interface ServiceUnitAction {
  schemaVersion: 1;
  attemptId: string;
  space: string;
  definition: string;
  definitionRevision: string;
  instanceId: string;
  machine: string;
  uid: number;
  unit: string;
  unitPath: string;
  unitSha256: string;
  operation: "start" | "stop" | "reseed";
  targetGeneration?: string;
  position: "planned" | "submitted" | "acknowledged" | "unknown";
  createdAt: string;
  updatedAt: string;
}

function validate(input: unknown, space: string): ServiceUnitAction {
  const value = localRecordObject(input, ["schemaVersion", "attemptId", "space", "definition", "definitionRevision", "instanceId", "machine", "uid", "unit", "unitPath", "unitSha256", "operation", "targetGeneration", "position", "createdAt", "updatedAt"]);
  if (value.schemaVersion !== 1 || value.space !== space || !["start", "stop", "reseed"].includes(String(value.operation)) || !["planned", "submitted", "acknowledged", "unknown"].includes(String(value.position))) throw new CommandFailure("refused", "SCHEMA_INVALID", "the retained native service action has an unsupported shape; no settled unit was inferred");
  const attemptId = serviceOperationId(value.attemptId), instanceId = serviceOperationId(value.instanceId);
  const definition = localRecordName(localRecordText(value.definition, 64)), definitionRevision = localRecordText(value.definitionRevision, 200);
  const machine = localRecordText(value.machine, 64), uid = value.uid;
  const unit = localRecordText(value.unit, 240), unitPath = localRecordText(value.unitPath, 4096), unitSha256 = localRecordText(value.unitSha256, 64);
  if (!/^[0-9a-f]{64}$/.test(machine) || !Number.isSafeInteger(uid) || Number(uid) < 0 || !/^cotal-[0-9a-f]{64}\.service$/.test(unit) || !isAbsolute(unitPath) || basename(unitPath) !== unit || /[\u0000-\u001f\u007f]/u.test(unitPath) || !/^[0-9a-f]{64}$/.test(unitSha256)) throw new CommandFailure("refused", "SCHEMA_INVALID", "the retained native service action has invalid host or exact unit coordinates");
  const targetGeneration = value.targetGeneration === undefined ? undefined : localRecordText(value.targetGeneration, 200);
  if ((value.operation === "reseed") !== (targetGeneration !== undefined) || targetGeneration !== undefined && !/^[0-9]+\.[0-9]+\.[0-9]+(?:-[A-Za-z0-9.-]+)?(?:\+[A-Za-z0-9.-]+)?$/.test(targetGeneration)) throw new CommandFailure("refused", "SCHEMA_INVALID", "the retained private seed action has no bounded target generation");
  const createdAt = localRecordText(value.createdAt, 100), updatedAt = localRecordText(value.updatedAt, 100);
  if (!Number.isFinite(Date.parse(createdAt)) || !Number.isFinite(Date.parse(updatedAt))) throw new CommandFailure("refused", "SCHEMA_INVALID", "the retained native service action has invalid timestamps");
  return { schemaVersion: 1, attemptId, space, definition, definitionRevision, instanceId, machine, uid: Number(uid), unit, unitPath, unitSha256, operation: value.operation as ServiceUnitAction["operation"], ...(targetGeneration ? { targetGeneration } : {}), position: value.position as ServiceUnitAction["position"], createdAt, updatedAt };
}

export const serviceUnitActionStore = (space: string) => new ProtectedRecordStore("services", space, (value) => validate(value, space), "unit-actions");

export function serviceUnitActionFor(space: string, id: string) {
  const row = serviceUnitActionStore(space).read(id);
  if (row && row.record.value.instanceId !== id) throw new CommandFailure("refused", "SCHEMA_INVALID", "the native service action filename differs from the full instance ID");
  return row;
}

export function beginServiceUnitAction(value: ServiceUnitAction) {
  if (value.position !== "planned") throw new CommandFailure("refused", "USAGE_INVALID", "the native action intent must precede its user-manager request");
  try {
    const saved = serviceUnitActionStore(value.space).commit(value.instanceId, undefined, value);
    const current = serviceUnitActionFor(value.space, value.instanceId);
    if (!saved || !current || current.record.revision !== saved.revision) throw new Error("publication did not confirm");
    return current;
  } catch (error) {
    if (isCommandFailure(error) && error.outcome === "refused" && error.code === "CONFLICT") throw error;
    throw new CommandFailure("unknown", "OPERATION_UNKNOWN", "the native service action intent did not confirm publication; no user-manager request was submitted or retried", { target: { space: value.space, instanceId: value.instanceId, attemptId: value.attemptId } });
  }
}

export function advanceServiceUnitAction(expected: LocalRecordSnapshot<ServiceUnitAction>, position: ServiceUnitAction["position"]) {
  const previous = expected.record.value.position;
  const valid = previous === "planned" && position === "submitted" || previous === "submitted" && (position === "acknowledged" || position === "unknown");
  if (!valid) throw new CommandFailure("refused", "LIFECYCLE_BLOCKED", "the native service action does not follow its retained intent; no request was retried");
  try {
    const saved = serviceUnitActionStore(expected.record.value.space).commit(expected.name, expected, { ...expected.record.value, position, updatedAt: new Date().toISOString() });
    const current = serviceUnitActionFor(expected.record.value.space, expected.name);
    if (!saved || !current || current.record.revision !== saved.revision) throw new Error("transition did not confirm");
    return current;
  } catch {
    throw new CommandFailure("unknown", "OPERATION_UNKNOWN", "the native service action transition did not confirm publication; no request was retried", { target: { instanceId: expected.name, attemptId: expected.record.value.attemptId, position } });
  }
}
