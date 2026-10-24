import { CommandFailure, oneLine, type MeshRegistryError } from "@cotal-ai/workspace";

/** Describe the unusable file without repeating untrusted stored field values. An error that names its
 *  own step, such as a file where a folder belongs, is given in its own words. */
export function registryFailure(error: MeshRegistryError): CommandFailure {
  if (error.remedy) return new CommandFailure("refused", "SCHEMA_INVALID", oneLine(error.message), { target: { file: error.file }, remedy: error.remedy });
  return new CommandFailure("refused", "SCHEMA_INVALID", `mesh registry file ${oneLine(error.file)} cannot be read as a valid record`, { target: { file: error.file }, remedy: "restore the record from backup or remove it" });
}
