import { join } from "node:path";
import { cachedPreferences, describeLayer, isWorkspaceTargetError, resolveMeshTarget, resolvePreference, type MeshTarget, type PreferenceContext } from "@cotal-ai/workspace";
import { defaultPersonaFix } from "./default-persona.js";

/** Persona selection shared by foreground and detached spawn: `--config`, then the positional, then
 *  the `persona` preference (`COTAL_DEFAULT_PERSONA`, the space's saved value, the user's, then
 *  `default`). `from` names where an implicit choice came from; it is absent for an explicit one and
 *  for the product default. */
export function spawnPersona(configFlag: string | undefined, positionals: readonly string[], ctx: PreferenceContext = {}): { ref: string; from?: string } {
  const explicit = configFlag ?? positionals[0];
  if (explicit !== undefined) return { ref: explicit };
  const winner = resolvePreference("persona", ctx).winner!;
  return winner.source === "default" ? { ref: winner.value } : { ref: winner.value, from: describeLayer(winner) };
}

/** The harness a launch falls back to when neither `--agent` nor the persona names one, as this
 *  caller sets it: `COTAL_DEFAULT_AGENT`, then the space's saved value, then the user's. Undefined
 *  when none is set, so a manager applies its own default before the product's. */
export function callerHarness(space: string): string | undefined {
  const winner = resolvePreference("harness", { space, preferences: cachedPreferences() }).winner;
  return winner && winner.source !== "default" ? winner.value : undefined;
}

/** Whether a spawn runs through a manager: only when the caller asks for one with `--detach` or
 *  `--on`. Any other spawn runs the application in this terminal, on every kind of mesh. */
export const spawnUsesManager = (values: { detach?: boolean; on?: string }): boolean => values.detach === true || values.on !== undefined;

/** The space a launch from `cwd` targets when no `--space` or `--server` names one: the space the mesh
 *  target resolves to, or the space prepared here that no `up` has started, which `spawn --dry-run`
 *  previews. Undefined when nothing here resolves to one space. */
export function launchSpace(cwd: string): { space: string; source: MeshTarget["source"] | "prepared" } | undefined {
  try {
    const target = resolveMeshTarget(cwd, { readOnly: true });
    return { space: target.space, source: target.source };
  } catch (error) {
    if (!isWorkspaceTargetError(error)) throw error;
    return error.code === "not-started" && error.details.space ? { space: error.details.space, source: "prepared" } : undefined;
  }
}

/** The mesh a persona was looked for in. A preview of a space that is not started has no broker. */
export type PersonaSite = Pick<MeshTarget, "space" | "root" | "personaRoot"> & Partial<Pick<MeshTarget, "server" | "source" | "origin">>;

/** The refusal for a launch persona that is not there, which the launch and its preview both give. A
 *  path reference opened that one file and never read the catalog, so it names the file. A catalog
 *  name names the directory checked and the mesh that root came from, so a launch that read a
 *  different root than the one set up shows it in one read. A missing default also names the command
 *  that writes one. */
export function missingPersona(site: PersonaSite, ref: string, from: string | undefined, path: string): { message: string; remedy: string } {
  const fromText = from === undefined ? "" : ` from ${from}`;
  if (path !== join(site.personaRoot, `${ref}.md`)) return { message: `no persona "${ref}"${fromText}: ${path} was not found`, remedy: "check the path, or name a persona from the catalog" };
  const where = `${site.personaRoot} (mesh "${site.space}"${site.server ? ` at ${site.server}` : ""}${site.source === "current" ? ", your current mesh" : site.source === "registry" ? ", the only mesh running" : ""})`;
  if (ref === "default" && from === undefined) {
    const fix = defaultPersonaFix(site);
    const write = fix.cwd ? `run \`${fix.command}\` in ${fix.cwd} to write one` : `create one with \`${fix.command}\``;
    return { message: `no default persona in ${where}`, remedy: `${write}, name a persona with \`cotal spawn <name>\`, or pass a persona file with \`cotal spawn --file <persona.md>\`` };
  }
  return { message: `no persona "${ref}"${fromText} in ${where}`, remedy: "pass a catalog name, or a persona file elsewhere with `--file <persona.md>`" };
}
