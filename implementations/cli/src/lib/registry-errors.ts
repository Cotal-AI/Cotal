import { basename } from "node:path";
import { CommandFailure, oneLine, spaceFromSegment, type MeshRegistryError } from "@cotal-ai/workspace";
import { shellWord } from "./endpoint-errors.js";

/** The step that clears a damaged record: `space forget` removes a record its file name ties to a
 *  space, whether a registration or a prepared space. Also the warning a forget that leaves a
 *  damaged record behind names, so the record stays visible instead of silently skipped. */
export function removeStep(file: string): string {
  const space = file.endsWith(".json") ? spaceFromSegment(basename(file, ".json")) : undefined;
  return space === undefined ? "restore the record from backup or remove it" : `restore the record from backup, or remove it with \`cotal space forget ${oneLine(shellWord(space))}\``;
}

/** Describe the unusable file without repeating untrusted stored field values. An error with its own
 *  summary and remedy, such as a file where a folder belongs, is given in those words, and one this
 *  account may not read refuses as a denial rather than as invalid content. */
export function registryFailure(error: MeshRegistryError): CommandFailure {
  return new CommandFailure("refused", error.refusal ?? "SCHEMA_INVALID", error.summary ? oneLine(error.summary) : `mesh registry file ${oneLine(error.file)} cannot be read as a valid record`, {
    target: { file: error.file },
    remedy: error.remedy ?? removeStep(error.file),
  });
}
