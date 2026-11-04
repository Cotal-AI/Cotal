import { CommandFailure, oneLine, type MeshRegistryError } from "@cotal-ai/workspace";

/** Describe the unusable file without repeating untrusted stored field values. An error with its own
 *  summary and remedy, such as a file where a folder belongs, is given in those words. */
export function registryFailure(error: MeshRegistryError): CommandFailure {
  return new CommandFailure("refused", "SCHEMA_INVALID", error.summary ? oneLine(error.summary) : `mesh registry file ${oneLine(error.file)} cannot be read as a valid record`, {
    target: { file: error.file },
    remedy: error.remedy ?? "restore the record from backup or remove it",
  });
}
