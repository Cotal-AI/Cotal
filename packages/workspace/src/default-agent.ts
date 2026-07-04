export const DEFAULT_AGENT_ENV = "COTAL_DEFAULT_AGENT";
export const DEFAULT_PERSONA_ENV = "COTAL_DEFAULT_PERSONA";

/** The operator-level default connector/agent harness, when set. */
export function defaultAgentOverride(env: NodeJS.ProcessEnv = process.env): string | undefined {
  return env[DEFAULT_AGENT_ENV]?.trim() || undefined;
}

/** Resolve the default connector/agent harness with the product fallback for this launch path. */
export function defaultAgentType(fallback: string, env: NodeJS.ProcessEnv = process.env): string {
  return defaultAgentOverride(env) ?? fallback;
}

/** The operator-level default persona ref (catalog name or path), when set. */
export function defaultPersonaOverride(env: NodeJS.ProcessEnv = process.env): string | undefined {
  return env[DEFAULT_PERSONA_ENV]?.trim() || undefined;
}

/** Resolve the default persona ref with the product fallback. */
export function defaultPersonaRef(fallback = "default", env: NodeJS.ProcessEnv = process.env): string {
  return defaultPersonaOverride(env) ?? fallback;
}
