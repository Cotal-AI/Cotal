import { cachedPreferences, describeLayer, resolvePreference, type PreferenceContext } from "@cotal-ai/workspace";

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
