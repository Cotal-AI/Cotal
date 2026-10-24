/**
 * The mesh-manifest library: load a `cotal.yaml` (kind: Mesh) into a launch-ready, validated model.
 * Pipeline: read → {@link resolveManifest} (parse/schema/normalize/invert/semantic) →
 * {@link preparePersonas} (persona reads + merge). Consumed by `topology view`, `up -f`, `spawn -f`.
 */
import { readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { personaReferences, resolveManifest } from "./resolve.js";
import { preparePersonas, type PreparedManifest } from "./preflight.js";
import { ManifestError, type ManifestIssue } from "./errors.js";
import { UnusableFile } from "../unusable-file.js";

export type { ResolvedManifest, ResolvedAgent, ResolvedChannel, AgentPolicy, PersonaPermissions } from "./model.js";
export type { PreparedManifest } from "./preflight.js";
export type { PreparedAgent, AgentWarning, InheritedScopes } from "./prepare.js";
export { resolveManifest } from "./resolve.js";
export { preparePersonas } from "./preflight.js";
export { prepareAgent } from "./prepare.js";
export { renderTopology, renderWarnings, renderInherited } from "./render.js";
export { ManifestError, formatIssue, type ManifestIssue } from "./errors.js";

/** The text of the manifest file at `abs`. A directory is refused as an {@link UnusableFile} naming
 *  it; any other read error is thrown as it is. */
export function readManifestSource(abs: string): string {
  try { return readFileSync(abs, "utf8"); }
  catch (e) {
    if ((e as NodeJS.ErrnoException).code === "EISDIR")
      throw new UnusableFile(`the manifest file ${JSON.stringify(abs)} is a directory; a manifest is one file`, { file: abs }, "name the manifest file in it, such as its cotal.yaml");
    throw e;
  }
}

/** Read + fully resolve a manifest file (absolute path recommended). Throws {@link ManifestError}
 *  with located problems, an {@link UnusableFile} for a directory, or a filesystem error if the
 *  manifest itself cannot be read. */
export function loadManifest(path: string): PreparedManifest {
  const abs = resolve(path);
  const src = readManifestSource(abs);
  try { return preparePersonas(resolveManifest(src, abs)); }
  catch (e) {
    if (e instanceof ManifestError) throw new ManifestError(e.file, withMissingPersonas(e.issues, src, abs));
    throw e;
  }
}

/** Every persona file that does not exist, named at its entry's line, so that an earlier problem
 *  in the manifest does not hide it. One the persona read already named gains that line. */
function withMissingPersonas(issues: readonly ManifestIssue[], src: string, sourcePath: string): ManifestIssue[] {
  const out = [...issues];
  for (const ref of personaReferences(src, sourcePath)) {
    try { statSync(ref.persona); continue; } catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") continue; }
    const issue: ManifestIssue = { message: `persona file not found: ${ref.persona}`, path: ["agents", ref.name], line: ref.line, col: ref.col };
    const named = out.findIndex((other) => other.message === issue.message && other.path?.join(".") === issue.path!.join("."));
    if (named < 0) out.push(issue); else out[named] = issue;
  }
  return out;
}
