/**
 * Preflight — the I/O half of resolution: read each agent's persona file and merge it with the
 * manifest (via the pure {@link prepareAgent}). Returns the launch-ready {@link PreparedManifest}
 * (agents + diagnostics) or throws {@link ManifestError} with every persona problem located.
 *
 * Live checks that need the network (broker reachability for `up -f` vs `spawn -f`) or the connector
 * registry stay in the command wiring; this is the fail-fast, file-level half.
 */
import { loadAgentFile, type AgentDef } from "@cotal-ai/core";
import type { ResolvedManifest } from "./model.js";
import { prepareAgent, type AgentWarning, type PreparedAgent } from "./prepare.js";
import { ManifestError, type ManifestIssue } from "./errors.js";

export interface PreparedManifest {
  manifest: ResolvedManifest;
  agents: PreparedAgent[];
  /** Non-fatal diagnostics to render in dry-run / topology view. */
  warnings: AgentWarning[];
}

/** Read personas + merge. Behavior defaults always come from the file (under both policies); only
 *  the persona's *permissions* are gated by `personaPermissions`. */
export function preparePersonas(manifest: ResolvedManifest): PreparedManifest {
  const declared = new Set(manifest.channels.map((c) => c.name));
  const issues: ManifestIssue[] = [];
  const warnings: AgentWarning[] = [];
  const agents: PreparedAgent[] = [];

  for (const a of manifest.agents) {
    let persona: AgentDef | undefined;
    if (a.persona) {
      try {
        persona = loadAgentFile(a.persona);
      } catch (e) {
        const code = (e as NodeJS.ErrnoException).code;
        issues.push({
          message: code === "ENOENT" ? `persona file not found: ${a.persona}` : (e as Error).message,
          path: ["agents", a.name],
        });
        continue;
      }
    }
    const r = prepareAgent(a, persona, declared);
    issues.push(...r.issues);
    warnings.push(...r.warnings);
    agents.push(r.prepared);
  }

  if (issues.length) throw new ManifestError(manifest.sourcePath, issues);
  return { manifest, agents, warnings };
}
