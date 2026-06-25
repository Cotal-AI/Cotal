/**
 * The mesh-manifest library: load a `cotal.yaml` (kind: Mesh) into a launch-ready, validated model.
 * Pipeline: read → {@link resolveManifest} (parse/schema/normalize/invert/semantic) →
 * {@link preparePersonas} (persona reads + merge). Consumed by `topology view`, `up -f`, `spawn -f`.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { resolveManifest } from "./resolve.js";
import { preparePersonas, type PreparedManifest } from "./preflight.js";

export type { ResolvedManifest, ResolvedAgent, ResolvedChannel, AgentPolicy, PersonaPermissions } from "./model.js";
export type { PreparedManifest } from "./preflight.js";
export type { PreparedAgent, AgentWarning, InheritedScopes } from "./prepare.js";
export { resolveManifest } from "./resolve.js";
export { preparePersonas } from "./preflight.js";
export { prepareAgent } from "./prepare.js";
export { renderTopology, renderWarnings, renderInherited } from "./render.js";
export { ManifestError, formatIssue, type ManifestIssue } from "./errors.js";

/** Read + fully resolve a manifest file (absolute path recommended). Throws {@link ManifestError}
 *  with located problems, or a filesystem error if the file is missing. */
export function loadManifest(path: string): PreparedManifest {
  const abs = resolve(path);
  return preparePersonas(resolveManifest(readFileSync(abs, "utf8"), abs));
}
