import { CommandFailure, oneLine, type MeshRegistryError } from "@cotal-ai/workspace";

/** Describe the unusable file without repeating untrusted stored field values. */
export function registryFailure(error: MeshRegistryError): CommandFailure {
  return new CommandFailure("refused", "SCHEMA_INVALID", `mesh registry file ${oneLine(error.file)} cannot be read as a valid record`, { target: { file: error.file }, remedy: "restore the record from backup or remove it" });
}
