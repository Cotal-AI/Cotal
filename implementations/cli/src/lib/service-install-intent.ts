import { basename, dirname, isAbsolute } from "node:path";
import { CommandFailure, isCommandFailure, localRecordName, serviceOperationId } from "@cotal-ai/workspace";
import { localRecordObject, localRecordText, ProtectedRecordStore, type LocalRecordSnapshot } from "./protected-records.js";

const steps = ["private-home", "environment", "seed", "unit", "reload", "enable", "receipt"] as const;
type Step = typeof steps[number];
type Position = "planned" | "submitted" | "acknowledged" | "unknown";

export interface ServiceInstallIntent {
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
  environmentSha256: string;
  privateHome: string;
  environmentFile: string;
  generation: string;
  step: Step;
  position: Position;
  createdAt: string;
  updatedAt: string;
}

/** A retained submitted step means an effect may have happened. Never treat an absent final
 *  supervisor receipt as proof that the private seed, unit or enable link is absent. */
function validate(input: unknown, space: string): ServiceInstallIntent {
  const value = localRecordObject(input, ["schemaVersion", "attemptId", "space", "definition", "definitionRevision", "instanceId", "machine", "uid", "unit", "unitPath", "unitSha256", "environmentSha256", "privateHome", "environmentFile", "generation", "step", "position", "createdAt", "updatedAt"]);
  if (value.schemaVersion !== 1 || value.space !== space || !steps.includes(value.step as Step) || !["planned", "submitted", "acknowledged", "unknown"].includes(String(value.position))) throw new CommandFailure("refused", "SCHEMA_INVALID", "the retained service installation intent has an unsupported step or target; no fresh install was inferred");
  const attemptId = serviceOperationId(value.attemptId), instanceId = serviceOperationId(value.instanceId);
  const definition = localRecordName(localRecordText(value.definition, 64));
  const definitionRevision = localRecordText(value.definitionRevision, 200);
  const machine = localRecordText(value.machine, 64), uid = value.uid;
  if (!/^[0-9a-f]{64}$/.test(machine) || !Number.isSafeInteger(uid) || Number(uid) < 0) throw new CommandFailure("refused", "SCHEMA_INVALID", "the service installation intent has no valid execution-host identity");
  const unit = localRecordText(value.unit, 240), unitPath = localRecordText(value.unitPath, 4096);
  const privateHome = localRecordText(value.privateHome, 4096), environmentFile = localRecordText(value.environmentFile, 4096);
  if (!/^cotal-[0-9a-f]{64}\.service$/.test(unit) || [unitPath, privateHome, environmentFile].some((path) => !isAbsolute(path) || /[\u0000-\u001f\u007f]/u.test(path)) || basename(unitPath) !== unit || dirname(dirname(privateHome)) !== dirname(unitPath) || basename(privateHome) !== unit.slice(0, -".service".length) || basename(dirname(privateHome)) !== "cotal-service" || dirname(environmentFile) !== privateHome || basename(environmentFile) !== "environment") throw new CommandFailure("refused", "SCHEMA_INVALID", "the service installation intent has invalid owned unit or private-store paths");
  const unitSha256 = localRecordText(value.unitSha256, 64), environmentSha256 = localRecordText(value.environmentSha256, 64), generation = localRecordText(value.generation, 200);
  if (!/^[0-9a-f]{64}$/.test(unitSha256) || !/^[0-9a-f]{64}$/.test(environmentSha256) || !/^[0-9]+\.[0-9]+\.[0-9]+(?:-[A-Za-z0-9.-]+)?(?:\+[A-Za-z0-9.-]+)?$/.test(generation)) throw new CommandFailure("refused", "SCHEMA_INVALID", "the service installation intent has invalid source or generation pins");
  const createdAt = localRecordText(value.createdAt, 100), updatedAt = localRecordText(value.updatedAt, 100);
  if (!Number.isFinite(Date.parse(createdAt)) || !Number.isFinite(Date.parse(updatedAt))) throw new CommandFailure("refused", "SCHEMA_INVALID", "the service installation intent timestamps are invalid");
  return { schemaVersion: 1, attemptId, space, definition, definitionRevision, instanceId, machine, uid: Number(uid), unit, unitPath, unitSha256, environmentSha256, privateHome, environmentFile, generation, step: value.step as Step, position: value.position as Position, createdAt, updatedAt };
}

export function serviceInstallIntentProjection(value: ServiceInstallIntent) {
  const index = steps.indexOf(value.step);
  const lastAcknowledgedStep = value.position === "acknowledged" ? value.step : index > 0 ? steps[index - 1]! : null;
  return { attemptId: value.attemptId, unit: value.unit, unitPath: value.unitPath, privateHome: value.privateHome,
    environmentFile: value.environmentFile, generation: value.generation, step: value.step, position: value.position,
    lastAcknowledgedStep, updatedAt: value.updatedAt };
}

export const serviceInstallIntentStore = (space: string) => new ProtectedRecordStore("services", space, (value) => validate(value, space), "install-intents");

export function serviceInstallIntentFor(space: string, id: string) {
  const row = serviceInstallIntentStore(space).read(id);
  if (row && row.record.value.instanceId !== id) throw new CommandFailure("refused", "SCHEMA_INVALID", "the service install intent's filename differs from its full instance ID; no owned unit was inferred");
  return row;
}

export function serviceInstallIntents(space: string) {
  const rows = serviceInstallIntentStore(space).list();
  if (rows.some((row) => row.name !== row.record.value.instanceId)) throw new CommandFailure("refused", "SCHEMA_INVALID", "a service install intent's filename differs from its full instance ID; no empty or owned inventory was inferred");
  return rows;
}

/** Create once before any unit/private-store effect. An uncertain local publication is retained
 *  as unknown, so the caller inspects the named intent rather than creating another attempt. */
export function beginServiceInstallIntent(value: ServiceInstallIntent) {
  if (value.step !== "private-home" || value.position !== "planned") throw new CommandFailure("refused", "USAGE_INVALID", "installation intent must begin before private state is created");
  const store = serviceInstallIntentStore(value.space);
  try {
    const saved = store.commit(value.instanceId, undefined, value);
    if (!saved) throw new Error("missing saved revision");
    const current = serviceInstallIntentFor(value.space, value.instanceId);
    if (!current || current.record.revision !== saved.revision) throw new Error("saved revision changed");
    return current;
  } catch (error) {
    if (isCommandFailure(error) && error.outcome === "refused" && error.code === "CONFLICT") throw error;
    throw new CommandFailure("unknown", "OPERATION_UNKNOWN", "the first installation intent did not confirm publication; no native effect was submitted or install retried", { target: { space: value.space, instanceId: value.instanceId, attemptId: value.attemptId } });
  }
}

/** Persist intent before each non-idempotent native step and its result after it returns.
 *  Unknown is terminal until explicit reconciliation; no caller automatically replays it. */
export function advanceServiceInstallIntent(expected: LocalRecordSnapshot<ServiceInstallIntent>, step: Step, position: Position) {
  const old = expected.record.value, before = steps.indexOf(old.step), next = steps.indexOf(step);
  const valid = old.position === "planned" && position === "submitted" && step === old.step ||
    old.position === "submitted" && (position === "acknowledged" || position === "unknown") && step === old.step ||
    old.position === "acknowledged" && position === "planned" && next === before + 1;
  if (!valid) throw new CommandFailure("refused", "LIFECYCLE_BLOCKED", "the proposed installation step does not follow the retained intent; no effect was submitted", { target: { instanceId: old.instanceId, attemptId: old.attemptId, step: old.step, position: old.position } });
  const store = serviceInstallIntentStore(old.space);
  try {
    const saved = store.commit(old.instanceId, expected, { ...old, step, position, updatedAt: new Date().toISOString() });
    if (!saved) throw new Error("missing saved revision");
    const current = serviceInstallIntentFor(old.space, old.instanceId);
    if (!current || current.record.revision !== saved.revision) throw new Error("saved revision changed");
    return current;
  } catch (error) {
    if (isCommandFailure(error) && error.outcome === "refused" && error.code === "CONFLICT") throw error;
    throw new CommandFailure("unknown", "OPERATION_UNKNOWN", "the installation intent transition did not confirm its saved revision; no native effect was retried", { target: { instanceId: old.instanceId, attemptId: old.attemptId, step, position } });
  }
}
