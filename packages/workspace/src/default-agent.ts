export const DEFAULT_AGENT_ENV = "COTAL_DEFAULT_AGENT";

/** The operator-level default connector/agent harness, when set. */
export function defaultAgentOverride(env: NodeJS.ProcessEnv = process.env): string | undefined {
  return env[DEFAULT_AGENT_ENV]?.trim() || undefined;
}

/** Resolve the default connector/agent harness with the product fallback for this launch path. */
export function defaultAgentType(fallback: string, env: NodeJS.ProcessEnv = process.env): string {
  return defaultAgentOverride(env) ?? fallback;
}
