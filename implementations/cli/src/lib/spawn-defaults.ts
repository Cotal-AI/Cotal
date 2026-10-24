import { cachedPreferences, describeLayer, isWorkspaceTargetError, resolveMeshTarget, resolvePreference, type MeshTarget, type PreferenceContext } from "@cotal-ai/workspace";

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
