import { closeSync, constants, fstatSync, openSync, readFileSync, statSync } from "node:fs";
import { parseDocument } from "yaml";
import { parseAgentFileSource, utf16Problem, type AgentDef } from "@cotal-ai/core";
import { MeshManifestSchema } from "./mesh-manifest-schema.js";

/** The shipped default persona. Keep its bytes stable so existing untouched copies are recognized. */
export const DEFAULT_AGENT = `---
name: default_agent
role: default
description: An agent on the mesh
tags: []
subscribe: []
allowSubscribe: [">"]
allowPublish: [">"]
capabilities: [spawn, run]
---

You are an agent on the Cotal mesh - a shared space where agents join, see who's around, and
coordinate as peers rather than working in silos. Use the Cotal tools available to you to find
your peers and work with them. Edit this file to give yourself a name, role, and purpose.
`;

/** The pre-wildcard-post template that setup already migrates when still untouched. */
export const LEGACY_DEFAULT_AGENT = `---
name: default_agent
role: default
description: An agent on the mesh
tags: []
subscribe: []
allowSubscribe: [">"]
allowPublish: []
capabilities: [spawn]
---

You are an agent on the Cotal mesh - a shared space where agents join, see who's around, and
coordinate as peers rather than working in silos. Use the Cotal tools available to you to find
your peers and work with them. Edit this file to give yourself a name, role, and purpose.
`;

/** A workstation-file refusal, mapped onto existing native bad-request/CLI schema-invalid codes. */
export class PersonaSourceError extends Error {
  readonly code = "SCHEMA_INVALID";
  readonly remedy?: string;

  constructor(message: string, opts?: { remedy?: string }) {
    super(message);
    this.remedy = opts?.remedy;
  }
}

/** Why the agent-file parser refused a definition. A YAML error keeps only its rule and position:
 *  the parser's own text can quote the document's sensitive values. */
export function personaDefinitionProblem(error: unknown, path: string): string {
  const message = error instanceof Error ? error.message : String(error);
  const prefix = `agent file ${path}: `;
  const reason = message.startsWith(prefix) ? message.slice(prefix.length) : message;
  if (!reason.startsWith("invalid YAML frontmatter")) return reason;
  // The parser counts lines from the first line after the opening `---`.
  const at = /at line (\d+), column (\d+)/.exec(reason);
  const where = at ? ` at line ${Number(at[1]) + 1}, column ${at[2]}` : "";
  if (reason.includes("Map keys must be unique")) return `the frontmatter has a duplicate YAML key${where}`;
  return `the frontmatter is not valid YAML${where}`;
}

/** Public --file denotes a file even when its basename has no extension. Paths stay host-relative. */
export function personaFileReference(value: string): string {
  if (!value.trim() || /[\u0000-\u001f\u007f]/u.test(value)) throw new PersonaSourceError("--file needs one nonempty persona-file path without control characters");
  return /[\\/]/.test(value) || value.endsWith(".md") ? value : `./${value}`;
}

/** Read a regular persona file on the execution host; never deploy a manifest from this door. */
export function loadLaunchPersonaFile(path: string): AgentDef {
  return readLaunchPersonaFile(path).def;
}

/** Read the parsed persona and its shipped-template match from the same file descriptor. */
export function readLaunchPersonaFile(path: string): { def: AgentDef; seededDefault: boolean } {
  const notRegular = () => new PersonaSourceError(`persona is not a regular file: ${path}`, { remedy: "pass a regular persona file" });
  if (!statSync(path).isFile()) throw notRegular();
  // Follow persona links as before. NONBLOCK keeps a replacement FIFO from hanging the open;
  // validate and read the same descriptor so a path replacement cannot bypass the type check.
  const fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK);
  let source: string;
  try {
    if (!fstatSync(fd).isFile()) throw notRegular();
    source = readFileSync(fd, "utf8");
  } finally {
    closeSync(fd);
  }
  let manifest = false;
  try {
    const document = parseDocument(source);
    if (!document.errors.length) manifest = MeshManifestSchema.safeParse(document.toJS({ maxAliasCount: 100 })).success;
  } catch { /* A non-manifest still has to pass the native persona parser below. */ }
  if (manifest) throw new PersonaSourceError("--file names a Mesh manifest, not a persona file; use `cotal team deploy <file>`. No agent was allocated", { remedy: "use `cotal team deploy <file>` for a Mesh manifest; use a native persona file for spawn" });
  const encoding = utf16Problem(source);
  if (encoding) throw new PersonaSourceError(`invalid persona definition: ${path}: ${encoding}`, { remedy: `save ${path} as UTF-8` });
  try { return { def: parseAgentFileSource(source, path), seededDefault: source === DEFAULT_AGENT || source === LEGACY_DEFAULT_AGENT }; }
  catch (error) { throw new PersonaSourceError(`invalid persona definition ${path}: ${personaDefinitionProblem(error, path)}`, { remedy: "check the agent-file frontmatter and channel declarations" }); }
}
