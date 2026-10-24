import { accessSync, constants, realpathSync, statSync } from "node:fs";
import { delimiter, dirname, isAbsolute, resolve } from "node:path";
import { CommandFailure, oneLine, parseServiceDefinitionInput, protectedLocalDirectory, protectedLocalEntry, resolveOnPath, type ServiceDefinitionInput } from "@cotal-ai/workspace";
import { decodeLocalJson, ProtectedRecordStore, protectedCredentialReference, readLocalRecordSource, type LocalRecordSnapshot } from "./protected-records.js";

import { resolveServiceAdapter } from "./service-adapters.js";

export type ServiceDefinitionSnapshot = LocalRecordSnapshot<ServiceDefinitionInput>;

const bareName = (executable: string) => !isAbsolute(executable) && !/[\\/]/.test(executable);

/** Installed adapter metadata is required before saving adapter options; executable imports are not validation.
 *  A process launch's executable must be protected against other local writers, as
 *  {@link protectedServiceExecutable} checks, unless `adapterPlan` marks the launch an adapter built
 *  from Cotal's own programs. */
export function validateServiceDefinition(input: unknown, space: string, checkReferences = true, adapterPlan = false): ServiceDefinitionInput {
  let value: ServiceDefinitionInput;
  try { value = parseServiceDefinitionInput(JSON.stringify(input), space); }
  catch (error) {
    const message = error instanceof Error && error.message.startsWith("service definition:") ? error.message : "the definition does not match the approved local service schema; input values were not echoed";
    throw new CommandFailure("refused", "SCHEMA_INVALID", message, message.startsWith("service definition: readiness") ? { remedy: "correct readiness in the definition as the message says, then add it again" } : undefined);
  }
  if (!checkReferences) return value;
  if (value.launch.type === "adapter") resolveServiceAdapter(value.launch.adapter, value.launch.options);
  else {
    // `add` saves a bare name as the absolute path it finds, so only an earlier release saved one.
    if (bareName(value.launch.executable)) throw new CommandFailure("refused", "SCHEMA_INVALID", "the definition names its executable by a bare name, which each start would look up on its own PATH; no launch or write was attempted", { remedy: "remove it with cotal service remove and add it again; add saves the absolute path it finds on PATH" });
    try {
      if (!statSync(value.launch.cwd).isDirectory()) throw new Error();
      accessSync(value.launch.cwd, constants.R_OK | constants.X_OK);
    } catch { throw new CommandFailure("refused", "DEPENDENCY_UNAVAILABLE", "the declared working directory is not a readable directory on this machine; no launch or write was attempted"); }
    let executable: string | undefined;
    try {
      executable = isAbsolute(value.launch.executable) ? value.launch.executable : resolve(value.launch.cwd, value.launch.executable);
      if (!executable || !statSync(executable).isFile()) throw new Error();
      accessSync(executable, constants.X_OK);
    } catch { throw new CommandFailure("refused", "DEPENDENCY_UNAVAILABLE", "the declared executable is not an executable file on this machine; no launch or write was attempted"); }
    if (!adapterPlan) protectedServiceExecutable(executable!);
  }
  if (value.credentialRef) protectedCredentialReference(value.credentialRef.path);
  return value;
}

/** A process service runs its executable as you, so the file and the folders above it must be ones
 *  only you or root can write. The physical file is checked, so a link such as /bin/sh is read where
 *  it points, and so is the folder the link is in, since a writer there could repoint it. */
function protectedServiceExecutable(path: string): void {
  const physical = realpathSync(path);
  protectedLocalEntry(physical, "the service executable");
  const folder = realpathSync(dirname(path));
  if (folder !== dirname(physical)) protectedLocalDirectory(folder, "the service executable's folder");
}

export const serviceDefinitionStore = (space: string) => new ProtectedRecordStore("services", space, (value, checkReferences) => validateServiceDefinition(value, space, checkReferences), "definitions");

export function importServiceDefinition(path: string, space: string): ServiceDefinitionInput {
  const bytes = readLocalRecordSource(path);
  if (!bytes) throw new CommandFailure("refused", "TARGET_NOT_FOUND", `the service input file ${oneLine(path)} was not found`, { target: { path } });
  return validateServiceDefinition(pinnedExecutable(validateServiceDefinition(decodeLocalJson(bytes), space, false)), space);
}

/** A bare executable name is looked up on this PATH once, as the definition is saved, and saved as
 *  the absolute path found, so a later start runs the same file whatever its own PATH is. A PATH
 *  with a relative or empty entry refuses, as a unit install does, since that entry would resolve
 *  against whichever folder the command runs in. */
function pinnedExecutable(value: ServiceDefinitionInput): ServiceDefinitionInput {
  if (value.launch.type !== "process" || !bareName(value.launch.executable)) return value;
  if ((process.env.PATH ?? "").split(delimiter).some((entry) => !isAbsolute(entry)))
    throw new CommandFailure("refused", "UNSUPPORTED", "a bare executable name is looked up on PATH as the definition is saved, and this PATH has a relative or empty entry; nothing was saved", { remedy: "give the executable as an absolute path, or run cotal service add with a PATH of absolute entries only" });
  const found = resolveOnPath(value.launch.executable);
  if (!found) throw new CommandFailure("refused", "DEPENDENCY_UNAVAILABLE", "the declared executable is not on this PATH; nothing was saved");
  return { ...value, launch: { ...value.launch, executable: found } };
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
