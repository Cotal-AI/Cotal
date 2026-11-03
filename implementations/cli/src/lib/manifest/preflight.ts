/**
 * Preflight — the I/O half of resolution: read each agent's persona file and merge it with the
 * manifest (via the pure {@link prepareAgent}). Returns the launch-ready {@link PreparedManifest}
 * (agents + diagnostics) or throws {@link ManifestError} with every persona problem located.
 *
 * Live checks that need the network (broker reachability for `up -f` vs `spawn -f`) or the connector
 * registry stay in the command wiring; this is the fail-fast, file-level half.
 */
import { existsSync } from "node:fs";
import { basename, dirname, extname, join, relative } from "node:path";
import { loadAgentFile, type AgentDef } from "@cotal-ai/core";
import { findCotalRoot } from "@cotal-ai/workspace";
import type { ResolvedManifest } from "./model.js";
import { prepareAgent, type AgentWarning, type PreparedAgent } from "./prepare.js";
import { ManifestError, type ManifestIssue } from "./errors.js";

export interface PreparedManifest {
  manifest: ResolvedManifest;
  agents: PreparedAgent[];
  /** Non-fatal diagnostics to render in dry-run / topology view. */
  warnings: AgentWarning[];
}

/** The problem with a persona file that does not exist. `persona` takes a path relative to the
 *  manifest, so a bare name that names no file there gets that rule, and the path of the catalog
 *  persona of that name when the project has one. */
export function missingPersona(path: string, sourcePath: string): string {
  const dir = dirname(sourcePath), name = basename(path);
  if (dirname(path) !== dir || extname(path) !== "") return `persona file not found: ${path}`;
  const rule = `persona file not found: ${path}; \`persona\` takes a path to a persona file, relative to the manifest`;
  const catalog = join(findCotalRoot(dir), ".cotal", "agents", `${name}.md`);
  if (!existsSync(catalog)) return rule;
  const at = relative(dir, catalog);
  return `${rule}, so the catalog persona ${name} is ${at.startsWith("..") ? at : `./${at}`}`;
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
          message: code === "ENOENT" ? missingPersona(a.persona, manifest.sourcePath) : (e as Error).message,
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
