import { basename, dirname, isAbsolute } from "node:path";
import { CommandFailure, isCommandFailure, localRecordName, serviceOperationId } from "@cotal-ai/workspace";
import { localRecordObject, localRecordText, ProtectedRecordStore, type LocalRecordSnapshot } from "./protected-records.js";

const steps = ["disable", "unit", "reload", "private-store", "receipt"] as const;
export interface ServiceUninstallIntent {
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
  privateHome: string;
  privateTreeSha256: string;
  step: typeof steps[number];
  position: "planned" | "submitted" | "acknowledged" | "unknown";
  createdAt: string;
  updatedAt: string;
}

function validate(input: unknown, space: string): ServiceUninstallIntent {
  const value = localRecordObject(input, ["schemaVersion", "attemptId", "space", "definition", "definitionRevision", "instanceId", "machine", "uid", "unit", "unitPath", "unitSha256", "privateHome", "privateTreeSha256", "step", "position", "createdAt", "updatedAt"]);
  if (value.schemaVersion !== 1 || value.space !== space || !steps.includes(value.step as ServiceUninstallIntent["step"]) || !["planned", "submitted", "acknowledged", "unknown"].includes(String(value.position))) throw new CommandFailure("refused", "SCHEMA_INVALID", "the retained native uninstall has an unsupported step or target");
  const attemptId = serviceOperationId(value.attemptId), instanceId = serviceOperationId(value.instanceId);
  const definition = localRecordName(localRecordText(value.definition, 64)), definitionRevision = localRecordText(value.definitionRevision, 200);
  const machine = localRecordText(value.machine, 64), uid = value.uid, unit = localRecordText(value.unit, 240);
  const unitPath = localRecordText(value.unitPath, 4096), privateHome = localRecordText(value.privateHome, 4096);
  const unitSha256 = localRecordText(value.unitSha256, 64), privateTreeSha256 = localRecordText(value.privateTreeSha256, 64);
  if (!/^[0-9a-f]{64}$/.test(machine) || !Number.isSafeInteger(uid) || Number(uid) < 0 || !/^cotal-[0-9a-f]{64}\.service$/.test(unit) || [unitPath, privateHome].some((path) => !isAbsolute(path) || /[\u0000-\u001f\u007f]/u.test(path)) || basename(unitPath) !== unit || dirname(dirname(privateHome)) !== dirname(unitPath) || basename(privateHome) !== unit.slice(0, -".service".length) || basename(dirname(privateHome)) !== "cotal-service" || !/^[0-9a-f]{64}$/.test(unitSha256) || !/^[0-9a-f]{64}$/.test(privateTreeSha256)) throw new CommandFailure("refused", "SCHEMA_INVALID", "the retained native uninstall has invalid host or owned file coordinates");
  const createdAt = localRecordText(value.createdAt, 100), updatedAt = localRecordText(value.updatedAt, 100);
  if (!Number.isFinite(Date.parse(createdAt)) || !Number.isFinite(Date.parse(updatedAt))) throw new CommandFailure("refused", "SCHEMA_INVALID", "the retained native uninstall timestamps are invalid");
  return { schemaVersion: 1, attemptId, space, definition, definitionRevision, instanceId, machine, uid: Number(uid), unit, unitPath, unitSha256, privateHome, privateTreeSha256, step: value.step as ServiceUninstallIntent["step"], position: value.position as ServiceUninstallIntent["position"], createdAt, updatedAt };
}

export function serviceUninstallIntentProjection(value: ServiceUninstallIntent) {
  const index = steps.indexOf(value.step);
  const lastAcknowledgedStep = value.position === "acknowledged" ? value.step : index > 0 ? steps[index - 1]! : null;
  return { attemptId: value.attemptId, unit: value.unit, unitPath: value.unitPath, privateHome: value.privateHome,
    step: value.step, position: value.position, lastAcknowledgedStep, updatedAt: value.updatedAt };
}

export const serviceUninstallIntentStore = (space: string) => new ProtectedRecordStore("services", space, (value) => validate(value, space), "uninstall-intents");

export function serviceUninstallIntentFor(space: string, id: string) {
  const row = serviceUninstallIntentStore(space).read(id);
  if (row && row.record.value.instanceId !== id) throw new CommandFailure("refused", "SCHEMA_INVALID", "the native uninstall filename differs from its full instance ID");
  return row;
}

export function serviceUninstallIntents(space: string) {
  const rows = serviceUninstallIntentStore(space).list();
  if (rows.some((row) => row.name !== row.record.value.instanceId)) throw new CommandFailure("refused", "SCHEMA_INVALID", "a native uninstall filename differs from its full instance ID");
  return rows;
}

export function beginServiceUninstallIntent(value: ServiceUninstallIntent) {
  if (value.step !== "disable" || value.position !== "planned") throw new CommandFailure("refused", "USAGE_INVALID", "native removal must retain its intent before disable");
  try {
    const saved = serviceUninstallIntentStore(value.space).commit(value.instanceId, undefined, value);
    const current = serviceUninstallIntentFor(value.space, value.instanceId);
    if (!saved || !current || current.record.revision !== saved.revision) throw new Error("publication did not confirm");
    return current;
  } catch (error) {
    if (isCommandFailure(error) && error.outcome === "refused" && error.code === "CONFLICT") throw error;
    throw new CommandFailure("unknown", "OPERATION_UNKNOWN", "the first native uninstall intent did not confirm publication; no disable was submitted", { target: { instanceId: value.instanceId, attemptId: value.attemptId } });
  }
}

export function advanceServiceUninstallIntent(expected: LocalRecordSnapshot<ServiceUninstallIntent>, step: ServiceUninstallIntent["step"], position: ServiceUninstallIntent["position"]) {
  const before = expected.record.value, old = steps.indexOf(before.step), next = steps.indexOf(step);
  const valid = before.position === "planned" && step === before.step && position === "submitted" ||
    before.position === "submitted" && step === before.step && (position === "acknowledged" || position === "unknown") ||
    before.position === "acknowledged" && next === old + 1 && position === "planned";
  if (!valid) throw new CommandFailure("refused", "LIFECYCLE_BLOCKED", "the native uninstall step does not follow its retained attempt; no effect was retried");
  try {
    const saved = serviceUninstallIntentStore(before.space).commit(expected.name, expected, { ...before, step, position, updatedAt: new Date().toISOString() });
    const current = serviceUninstallIntentFor(before.space, expected.name);
    if (!saved || !current || current.record.revision !== saved.revision) throw new Error("transition did not confirm");
    return current;
  } catch {
    throw new CommandFailure("unknown", "OPERATION_UNKNOWN", "the native uninstall step did not confirm its retained transition; no effect was retried", { target: { instanceId: expected.name, attemptId: before.attemptId, step, position } });
  }
}
