import { createHash } from "node:crypto";
import { lstatSync } from "node:fs";
import { basename, delimiter, dirname, isAbsolute, join } from "node:path";
import { CommandFailure, protectedLocalDirectory, readLocalRecordSource, serviceOperationId } from "@cotal-ai/workspace";
import { localRecordObject, localRecordText, ProtectedRecordStore } from "./protected-records.js";
import type { ServiceInstance } from "./service-instances.js";

export interface ServiceSupervisorRecord {
  schemaVersion: 1;
  space: string;
  instanceId: string;
  definition: string;
  definitionRevision: string;
  machine: string;
  uid: number;
  mechanism: "systemd-user" | "launchd";
  unit: string;
  unitPath: string;
  unitSha256: string;
  privateHome: string;
  environmentSha256?: string;
  searchPath?: string;
  privateTreeSha256?: string;
  seededGeneration: string;
  installedAt: string;
}

/** A receipt is local ownership metadata, not proof of loaded unit state or a process identity. */
function validate(input: unknown, space: string): ServiceSupervisorRecord {
  const value = localRecordObject(input, ["schemaVersion", "space", "instanceId", "definition", "definitionRevision", "machine", "uid", "mechanism", "unit", "unitPath", "unitSha256", "privateHome", "environmentSha256", "searchPath", "privateTreeSha256", "seededGeneration", "installedAt"]);
  if (value.schemaVersion !== 1 || value.space !== space || !["systemd-user", "launchd"].includes(String(value.mechanism)) || typeof value.machine !== "string" || !/^[0-9a-f]{64}$/.test(value.machine) || !Number.isSafeInteger(value.uid) || Number(value.uid) < 0 || typeof value.unitSha256 !== "string" || !/^[0-9a-f]{64}$/.test(value.unitSha256)) throw new CommandFailure("refused", "SCHEMA_INVALID", "the recorded service supervisor has an unsupported identity or mechanism; OS ownership was not inferred");
  const instanceId = serviceOperationId(value.instanceId), mechanism = value.mechanism as ServiceSupervisorRecord["mechanism"];
  const unit = localRecordText(value.unit, 240);
  const named = mechanism === "systemd-user" ? /^cotal-[A-Za-z0-9_.@:-]+\.service$/.test(unit) : /^ai\.cotal\.[A-Za-z0-9_.-]+$/.test(unit);
  if (!named) throw new CommandFailure("refused", "SCHEMA_INVALID", "the recorded supervisor has no bounded native unit name; its name alone grants no ownership");
  const unitPath = localRecordText(value.unitPath, 4096), privateHome = localRecordText(value.privateHome, 4096);
  if ([unitPath, privateHome].some((path) => !isAbsolute(path) || /[\u0000-\u001f\u007f]/u.test(path)) || basename(unitPath) !== (mechanism === "systemd-user" ? unit : `${unit}.plist`)) throw new CommandFailure("refused", "SCHEMA_INVALID", "the recorded service supervisor paths do not bind its full instance and mechanism");
  const installedAt = localRecordText(value.installedAt, 100), seededGeneration = localRecordText(value.seededGeneration, 200);
  if (!Number.isFinite(Date.parse(installedAt)) || !/^[0-9]+\.[0-9]+\.[0-9]+(?:-[A-Za-z0-9.-]+)?(?:\+[A-Za-z0-9.-]+)?$/.test(seededGeneration)) throw new CommandFailure("refused", "SCHEMA_INVALID", "the recorded service supervisor generation or installation time is invalid");
  const privateTreeSha256 = value.privateTreeSha256 === undefined ? undefined : localRecordText(value.privateTreeSha256, 64);
  const environmentSha256 = value.environmentSha256 === undefined ? undefined : localRecordText(value.environmentSha256, 64);
  const searchPath = value.searchPath === undefined ? undefined : localRecordText(value.searchPath, 4096);
  if (privateTreeSha256 !== undefined && !/^[0-9a-f]{64}$/.test(privateTreeSha256) || environmentSha256 !== undefined && !/^[0-9a-f]{64}$/.test(environmentSha256) || (environmentSha256 === undefined) !== (searchPath === undefined) || searchPath !== undefined && (/[\u0000-\u001f\u007f]/u.test(searchPath) || searchPath.split(delimiter).some((entry) => !isAbsolute(entry))) || mechanism === "systemd-user" && (dirname(dirname(privateHome)) !== dirname(unitPath) || basename(privateHome) !== unit.slice(0, -".service".length) || basename(dirname(privateHome)) !== "cotal-service" || join(privateHome, "environment").length > 4096)) throw new CommandFailure("refused", "SCHEMA_INVALID", "the recorded private-store provenance is invalid; no native reseed or cleanup was authorized");
  return { schemaVersion: 1, space, instanceId, definition: localRecordText(value.definition, 64), definitionRevision: localRecordText(value.definitionRevision, 200), machine: value.machine, uid: Number(value.uid), mechanism, unit, unitPath, unitSha256: value.unitSha256, privateHome, ...(environmentSha256 ? { environmentSha256, searchPath: searchPath! } : {}), ...(privateTreeSha256 ? { privateTreeSha256 } : {}), seededGeneration, installedAt };
}

export const serviceSupervisorStore = (space: string) => new ProtectedRecordStore("services", space, (value) => validate(value, space), "supervisors");

function receiptFor(instance: ServiceInstance): ServiceSupervisorRecord | undefined {
  const saved = serviceSupervisorStore(instance.space).read(instance.instanceId);
  if (!saved) return undefined;
  const value = saved.record.value;
  if (saved.name !== value.instanceId || value.space !== instance.space || value.definition !== instance.definition || value.definitionRevision !== instance.definitionRevision || value.machine !== instance.host.machine || value.uid !== instance.host.uid) throw new CommandFailure("refused", "CONFLICT", "the service supervisor receipt does not belong to this definition, full instance and execution host; no unit was adopted");
  return value;
}

/** Hash only the recorded physical unit file. No unit body, environment or native process
 *  diagnostics leave this view, and matching bytes do not establish loaded/active OS state. */
export function serviceSupervisorProjection(instance: ServiceInstance, current: Pick<ServiceInstance["host"], "machine" | "uid">) {
  const receipt = receiptFor(instance);
  if (!receipt) return { mechanism: "none-recorded" as const, fileObservation: "not-checked" as const, osState: "not-checked" as const, autostart: "not-checked" as const, unit: null, unitPath: null, privateHome: null, seededGeneration: null, installedAt: null };
  if (receipt.machine !== current.machine || receipt.uid !== current.uid) return { mechanism: receipt.mechanism, fileObservation: "foreign-host" as const, osState: "not-checked" as const, autostart: "not-checked" as const, unit: receipt.unit, unitPath: receipt.unitPath, privateHome: receipt.privateHome, seededGeneration: receipt.seededGeneration, installedAt: receipt.installedAt };
  let fileObservation: "missing" | "matches-recorded-bytes" | "modified" | "unreadable" = "unreadable";
  try {
    protectedLocalDirectory(dirname(receipt.unitPath));
    const bytes = readLocalRecordSource(receipt.unitPath, 256 * 1024);
    if (bytes === undefined) fileObservation = "missing";
    else {
      const stat = lstatSync(receipt.unitPath);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== receipt.uid || (stat.mode & 0o022) !== 0) throw new Error();
      fileObservation = createHash("sha256").update(bytes).digest("hex") === receipt.unitSha256 ? "matches-recorded-bytes" : "modified";
    }
  } catch { /* Unreadable ownership never becomes an absent or uninstalled supervisor. */ }
  return { mechanism: receipt.mechanism, fileObservation, osState: "not-checked" as const, autostart: "not-checked" as const, unit: receipt.unit, unitPath: receipt.unitPath, privateHome: receipt.privateHome, seededGeneration: receipt.seededGeneration, installedAt: receipt.installedAt };
}

/** OS controls are a separate path. A stopped PID or missing/modified unit never authorizes the
 *  direct-process driver to bypass a recorded supervisor, reinstall it or remove its receipt. */
export function refuseRecordedSupervisor(instance: ServiceInstance, operation: "start" | "stop" | "remove"): void {
  const receipt = receiptFor(instance);
  if (!receipt) return;
  throw new CommandFailure("refused", "UNSUPPORTED", `service ${operation} requires the recorded ${receipt.mechanism} controller, which is not integrated in this source; no direct launcher, process signal or implicit uninstall was substituted`, { target: { space: instance.space, instanceId: instance.instanceId, unit: receipt.unit }, remedy: "retain the supervisor receipt and unit; a missing or modified file is not proof of uninstallation" });
}
