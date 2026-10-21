import { readFileSync } from "node:fs";
import { parseDocument } from "yaml";
import { parseAgentFileSource, type AgentDef } from "@cotal-ai/core";
import { MeshManifestSchema } from "./mesh-manifest-schema.js";

/** A workstation-file refusal, mapped onto existing native bad-request/CLI schema-invalid codes. */
export class PersonaSourceError extends Error {
  readonly code = "SCHEMA_INVALID";
}

/** Public --file denotes a file even when its basename has no extension. Paths stay host-relative. */
export function personaFileReference(value: string): string {
  if (!value.trim() || /[\u0000-\u001f\u007f]/u.test(value)) throw new PersonaSourceError("--file needs one nonempty persona-file path without control characters");
  return /[\\/]/.test(value) || value.endsWith(".md") ? value : `./${value}`;
}

/** Read and validate the same bytes on the execution host; never deploy a manifest from this door. */
export function loadLaunchPersonaFile(path: string): AgentDef {
  const source = readFileSync(path, "utf8");
  let manifest = false;
  try {
    const document = parseDocument(source);
    if (!document.errors.length) manifest = MeshManifestSchema.safeParse(document.toJS({ maxAliasCount: 100 })).success;
  } catch { /* A non-manifest still has to pass the native persona parser below. */ }
  if (manifest) throw new PersonaSourceError("--file names a Mesh manifest, not a persona file; use cotal team deploy <file>. No agent was allocated");
  try { return parseAgentFileSource(source, path); }
  catch { throw new PersonaSourceError(`persona file ${path} has invalid native frontmatter; check its name, selectors and access declarations. File contents were not echoed`); }
}
