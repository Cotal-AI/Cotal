import { accessSync, constants, realpathSync, statSync, type Stats } from "node:fs";
import { delimiter, dirname, isAbsolute, resolve } from "node:path";
import { CommandFailure, oneLine, parseServiceDefinitionInput, protectedLocalDirectory, protectedLocalEntry, resolveOnPath, type ServiceDefinitionInput } from "@cotal-ai/workspace";
import { decodeLocalJson, ProtectedRecordStore, protectedCredentialReference, readLocalRecordSource, type LocalRecordSnapshot } from "./protected-records.js";

import { resolveServiceAdapter } from "./service-adapters.js";

export type ServiceDefinitionSnapshot = LocalRecordSnapshot<ServiceDefinitionInput>;

const bareName = (executable: string) => !isAbsolute(executable) && !/[\\/]/.test(executable);

/** Installed adapter metadata is required before saving adapter options; executable imports are not validation.
 *  A process launch's executable must be protected against other local writers, as
 *  {@link protectedServiceExecutable} checks, unless `adapterPlan` marks the launch an adapter built
 *  from Cotal's own programs. `saved` names the saved definition a start checks, so a refusal for a
 *  launch path can name the remove that replaces it. */
export function validateServiceDefinition(input: unknown, space: string, checkReferences = true, adapterPlan = false, saved?: string): ServiceDefinitionInput {
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
    assertLaunchPath(value.launch.cwd, "working directory", space, saved);
    const executable = isAbsolute(value.launch.executable) ? value.launch.executable : resolve(value.launch.cwd, value.launch.executable);
    assertLaunchPath(executable, "executable", space, saved);
    if (!adapterPlan) protectedServiceExecutable(executable);
  }
  if (value.credentialRef) protectedCredentialReference(value.credentialRef.path);
  return value;
}

/** A launch path `add` checked can be moved, removed or change mode before a start, so the refusal
 *  names the path, what is wrong with it and its fix. A saved definition's paths change only when it
 *  is removed and added again, which the refusal names when `saved` gives the definition. */
function assertLaunchPath(path: string, kind: "executable" | "working directory", space: string, saved: string | undefined): void {
  const shown = oneLine(path), folder = kind === "working directory";
  const restore = saved === undefined ? `correct launch.${folder ? "cwd" : "executable"} in the definition` : folder ? `create ${shown} or put it back` : `put it back at ${shown}`;
  const refusal = (problem: string, fix: string, replaceable: boolean) => {
    const replace = replaceable && saved !== undefined ? `; to use another ${folder ? "folder" : "file"}, forget the service with cotal service remove ${saved} --space ${oneLine(space)} --yes and add it again` : "";
    return new CommandFailure("refused", "DEPENDENCY_UNAVAILABLE", `the declared ${kind} ${shown} ${problem}; no launch or write was attempted`, { remedy: `${fix}, then run the command again${replace}` });
  };
  let stat: Stats;
  try { stat = statSync(path); }
  catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    throw refusal(code === "ENOENT" || code === "ENOTDIR" ? "does not exist" : `could not be checked (${code ?? "unknown error"})`, restore, true);
  }
  if (folder ? !stat.isDirectory() : !stat.isFile()) throw refusal(`is not a ${folder ? "directory" : "regular file"}`, restore, true);
  const mode = (stat.mode & 0o7777).toString(8).padStart(4, "0");
  try { accessSync(path, folder ? constants.R_OK | constants.X_OK : constants.X_OK); }
  catch {
    throw folder
      ? refusal(`cannot be read and entered by you (mode ${mode})`, `let yourself read and enter it with chmod u+rx ${shown}`, false)
      : refusal(`is not executable by you (mode ${mode})`, `make it executable with chmod u+x ${shown}`, false);
  }
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
  const value = validateServiceDefinition(decodeLocalJson(bytes), space, false);
  // `add` records the root itself, so a file cannot claim another project's.
  if (value.root !== undefined) throw new CommandFailure("refused", "SCHEMA_INVALID", "the definition sets root, which service add records itself as the space's root; nothing was saved", { remedy: "remove root from the file, then add it again" });
  return validateServiceDefinition(pinnedExecutable(value), space);
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

/** Where a saved definition stands against `root`, the root of the space it is read in: added there,
 *  inherited from a space of the same name that another root forgot, or saved by an earlier release
 *  that recorded no root. */
export function definitionRootMatch(value: ServiceDefinitionInput, root: string): "this-root" | "inherited" | "not-recorded" {
  return value.root === undefined ? "not-recorded" : value.root === root ? "this-root" : "inherited";
}

/** A definition launches only in the root it was added in. One a forgotten space of the same name
 *  left in another root refuses, naming that root and the command that forgets it. */
export function assertDefinitionRoot(row: ServiceDefinitionSnapshot, space: string, root: string, action: "start" | "restart" | "install"): void {
  const added = row.record.value.root;
  if (added === undefined || added === root) return;
  throw new CommandFailure("refused", "CONFLICT", `${row.name} was added in ${added}, not in this space's root ${root}; an earlier space named ${space} left it, and it was not ${action === "install" ? "installed" : `${action}ed`}`, {
    target: { space, name: row.name, addedIn: added, root },
    remedy: `forget it with cotal service remove ${row.name} --space ${space} --yes, then add it again here if this project needs it`,
  });
}

/** Public reports omit argument bodies, adapter option values and all credential contents. */
export function serviceDefinitionProjection(row: ServiceDefinitionSnapshot) {
  const value = row.record.value;
  return {
    name: row.name, revision: row.record.revision, space: value.space, executionHost: "this-machine" as const, root: value.root ?? null,
    launch: value.launch.type === "process" ? { type: "process" as const, executable: value.launch.executable, argumentCount: value.launch.args.length, cwd: value.launch.cwd }
      : { type: "adapter" as const, adapter: value.launch.adapter, optionCount: Object.keys(value.launch.options).length },
    readiness: value.readiness.type === "http" ? { type: value.readiness.type, timeoutMs: value.readiness.timeoutMs, expectedStatus: value.readiness.expectedStatus, url: "omitted from public reports" } : value.readiness, environmentReferences: value.envRefs ?? {}, credentialRef: value.credentialRef,
    referenceValidation: "not-checked" as const, liveState: "not-checked" as const,
  };
}
