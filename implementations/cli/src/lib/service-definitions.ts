import { accessSync, constants, statSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { CommandFailure, oneLine, parseServiceDefinitionInput, resolveOnPath, type ServiceDefinitionInput } from "@cotal-ai/workspace";
import { decodeLocalJson, ProtectedRecordStore, protectedCredentialReference, readLocalRecordSource, type LocalRecordSnapshot } from "./protected-records.js";

import { resolveServiceAdapter } from "./service-adapters.js";

export type ServiceDefinitionSnapshot = LocalRecordSnapshot<ServiceDefinitionInput>;

/** Installed adapter metadata is required before saving adapter options; executable imports are not validation. */
export function validateServiceDefinition(input: unknown, space: string, checkReferences = true): ServiceDefinitionInput {
  let value: ServiceDefinitionInput;
  try { value = parseServiceDefinitionInput(JSON.stringify(input), space); }
  catch (error) { throw new CommandFailure("refused", "SCHEMA_INVALID", error instanceof Error && error.message.startsWith("service definition:") ? error.message : "the definition does not match the approved local service schema; input values were not echoed"); }
  if (!checkReferences) return value;
  if (value.launch.type === "adapter") resolveServiceAdapter(value.launch.adapter, value.launch.options);
  else {
    try {
      if (!statSync(value.launch.cwd).isDirectory()) throw new Error();
      accessSync(value.launch.cwd, constants.R_OK | constants.X_OK);
    } catch { throw new CommandFailure("refused", "DEPENDENCY_UNAVAILABLE", "the declared working directory is not a readable directory on this machine; no launch or write was attempted"); }
    try {
      const executable = isAbsolute(value.launch.executable) ? value.launch.executable
        : /[\\/]/.test(value.launch.executable) ? resolve(value.launch.cwd, value.launch.executable) : resolveOnPath(value.launch.executable);
      if (!executable || !statSync(executable).isFile()) throw new Error();
      accessSync(executable, constants.X_OK);
    } catch { throw new CommandFailure("refused", "DEPENDENCY_UNAVAILABLE", "the declared executable is not an executable file on this machine; no launch or write was attempted"); }
  }
  if (value.credentialRef) protectedCredentialReference(value.credentialRef.path);
  return value;
}

export const serviceDefinitionStore = (space: string) => new ProtectedRecordStore("services", space, (value, checkReferences) => validateServiceDefinition(value, space, checkReferences), "definitions");

export function importServiceDefinition(path: string, space: string): ServiceDefinitionInput {
  const bytes = readLocalRecordSource(path);
  if (!bytes) throw new CommandFailure("refused", "TARGET_NOT_FOUND", `the service input file ${oneLine(path)} was not found`, { target: { path } });
  return validateServiceDefinition(decodeLocalJson(bytes), space);
}

/** Public reports omit argument bodies, adapter option values and all credential contents. */
export function serviceDefinitionProjection(row: ServiceDefinitionSnapshot) {
  const value = row.record.value;
  return {
    name: row.name, revision: row.record.revision, space: value.space, executionHost: "this-machine" as const,
    launch: value.launch.type === "process" ? { type: "process" as const, executable: value.launch.executable, argumentCount: value.launch.args.length, cwd: value.launch.cwd }
      : { type: "adapter" as const, adapter: value.launch.adapter, optionCount: Object.keys(value.launch.options).length },
    readiness: value.readiness.type === "http" ? { type: value.readiness.type, timeoutMs: value.readiness.timeoutMs, expectedStatus: value.readiness.expectedStatus, url: "omitted from public reports" } : value.readiness, environmentReferences: value.envRefs ?? {}, credentialRef: value.credentialRef,
    referenceValidation: "not-checked" as const, liveState: "not-checked" as const,
  };
}
